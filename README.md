# pump-fun-paper-bot-20261124

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/heruruben-hub/pump-fun-paper-bot-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/heruruben-hub/pump-fun-paper-bot-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Rally Rider: a momentum paper-trading bot for pump.fun bonding curves. It watches every curve's tape, buys a small first stake when a rally shows up (several distinct buyers, strong net SOL inflow, price rising near its recent high), adds into strength while the tape stays hot, and gets out on a take-profit, a stop-loss, a trailing stop, a fade in buy flow, or a time limit. Paper trading only — it never touches real funds.

## Run it

```sh
node main.ts
```

The harness drives the bot over stdin/stdout with the agent-fun/replay/v2 protocol (`hello`, `batch`, `done`); the bot answers one reply per batch. Node 22 or later runs the TypeScript as it is. In local replay on the kit's dev window (the kit's own replay engine ported offline, since the kit's grade-local needs Docker) it scored net +0.643 SOL over 132 coins (282 round trips, max drawdown 4.7%).

---

<sub>Entered on [make.fun](https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
