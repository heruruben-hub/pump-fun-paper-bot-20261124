// Rally Rider: a momentum paper-trading bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Paper trading only: it answers the harness's hello, batch and
// done messages on stdin/stdout and never touches real funds.
//
// Idea: pump.fun coins that are already rallying with broad, accelerating buy flow
// tend to keep running for a few minutes before they roll over. The bot watches every
// curve's tape, buys a small first stake when a rally shows up (several distinct buyers,
// net SOL flowing in, price rising and sitting near its recent high), adds into
// strength while the tape stays hot, and gets out on a take-profit, a stop-loss, a
// trailing stop, a fade in buy flow, or a time limit. A pacing probe keeps the run
// above the 20-coin guardrail when the rally signal goes quiet: it buys a tiny stake
// of a liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no environment reads. All
// decisions come from the batch stream, and maps are only ever walked in insertion
// order, so two runs on the same data produce the same action log.

import { pathToFileURL } from 'node:url';
import { runBot, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1 (lower bound). */
  minRise: number;
  /** Same rise, upper bound: skip curves that already ran too far in one window. */
  maxRise: number;
  /** Net inflow in the newer half of the window must be at least this multiple of the older half. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single buyer's share of the window's buy SOL (upper bound). */
  maxBuyerShare: number;
  /** Curve real SOL at entry: lower and upper bounds. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which a curve is too stale to enter. */
  maxAge: number;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** First buy of a position, in SOL. */
  firstSol: number;
  /** Each add-on buy, in SOL. */
  addSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Slippage allowance on buys, in bps. Sells always go out at 10000. */
  buySlipBps: number;
  /** Exit: sell when the position value falls to this share of its cost. */
  stopLoss: number;
  /** Exit: sell when the position value reaches this multiple of its cost. */
  takeProfit: number;
  /** Trailing stop: once the peak value reaches cost * trailArm, sell below peak * (1 - trail). */
  trail: number;
  trailArm: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless the position is up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Guardrail pacing: one new coin per paceSlots of elapsed slots once past warmupSlots. */
  warmupSlots: number;
  paceSlots: number;
  /** Probe round-trip size, in SOL. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
  /** SOL of free cash kept in reserve (exits can always pay their tx fees). */
  reserveSol: number;
}

// Settings traded with. Picked by sweeping the dev window with the kit's local
// replay engine, preferring flat regions of the grid over a single best cell:
// one entry per coin (re-entries were fee bleed), early-stage curves only
// (real SOL at most 20), and a strong net-inflow filter (at least 1.8 SOL).
export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 1.8,
  minBuys: 4,
  minBuyers: 4,
  minRise: 0.05,
  maxRise: 1.2,
  accel: 1,
  nearHigh: 0.92,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 20,
  minAge: 240,
  maxAge: 24000,
  stakeSol: 0.6,
  firstSol: 0.06,
  addSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.8,
  takeProfit: 1.25,
  trail: 0.2,
  trailArm: 1.05,
  fadeWindow: 20,
  fadeNetSol: 1.5,
  maxHold: 2400,
  holdIfUp: 0.2,
  cooldown: 600,
  maxEntries: 1,
  warmupSlots: 6000,
  paceSlots: 3000,
  probeSol: 0.02,
  maxProbes: 1,
  reserveSol: 1,
};

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  createPrice: number;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  lastAddPrice: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstSlot: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (startPrice < 0) startPrice = t.createPrice;
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot === null) firstSlot = now;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Close value of a position now: what a sell of all its tokens would net,
      // curve fees and the tx fee deducted. -1 when it cannot be valued.
      const closeValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) return -1;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        if (value < 0) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * p.stopLoss) exit = true;
        if (!exit && value >= cost * p.takeProfit) exit = true;
        if (!exit && h.peakValue >= cost * p.trailArm && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of [...probes]) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS - p.reserveSol;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = p.firstSol;
        } else {
          // Add into strength only: the tape is still hot, the price stepped up from
          // the last add, and the position is not underwater.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (closeValue(mint) < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, lastAddPrice: price, exiting: false, filled: false });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: when the coins the bot has traded lag one new coin per
      // paceSlots of elapsed slots, open a tiny probe round trip on a liquid curve.
      if (probes.size < p.maxProbes && firstSlot !== null) {
        const elapsed = now - firstSlot;
        const expected = Math.floor(Math.max(0, elapsed - p.warmupSlots) / p.paceSlots);
        if (myCoins.size < expected) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runBot(createStrategy(DEFAULT_PARAMS));
}
