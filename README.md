# okx-jev-desk

A multi-bot crypto trading desk. **Jev (TypeSafe System One)** is the brain, code
is the body, the dashboard is the glass.

The engine reads OKX market + account state every tick, computes features in
TypeScript, asks Jev typed questions, then either holds or places/cancels orders
on OKX — and streams the whole loop to a live dashboard.

> Not financial advice. Demo trading is mandatory before live. Past model calls
> are not an edge; this is a system for running and observing a policy.

---

## Quick start (offline, no keys, no money)

```bash
npm install && npm --prefix web install
cp .env.example .env          # leave MODE=mock, MODEL=mock
npm test                      # 264 tests
npm run engine                # :3000
npm run desk                  # :3001  (separate terminal)
```

The desk then shows three sleeves with live OKX public data, computed features,
brain answers and gate decisions. Fills are simulated. No orders are sent.

To use a real brain: `MODEL=jev` plus a key for whichever transport
`JEV_PROVIDER` selects (see `.env.example` and "Where the brain lives" below).

> **The brain is live.** Deployed 2026-10-04 as a systemd user service
> (`okx-jev-desk.service`), `MODE=paper` with a real pinned Jev via OpenRouter.
> Verified: a real call returns `provider=openrouter`, non-zero `input_tokens`,
> and a `usage.cost` of ~$0.000056 at ~300 ms.
>
> `MODE=paper` places **no orders** — it is real market data and real decisions
> with a simulated fill. That is the mode the 28-day era is measured in.
>
> ```bash
> systemctl --user status okx-jev-desk
> journalctl --user -u okx-jev-desk -f
> touch ~/projects/okx-jev-desk/data/close-live   # stop brain + flatten
> ```
>
> The unit file lives at `~/.config/systemd/user/okx-jev-desk.service` (not in
> this repo — it references `$HOME` paths and holds no secrets; `.env` does,
> mode 600, gitignored).

To place real (demo-venue) orders: OKX demo keys + `MODE=demo`.

---

## Architecture

```
OKX public WS  ─┐
OKX business WS─┤──► Feature store ──► Tick scheduler ──► Jev client
OKX REST       ─┘         │                  │                 │
                          │                  ▼                 ▼
                     SQLite/JSON        Risk gate ──► Order router ──► OKX
                          │                  │
                          └────────► Event bus ──► SSE /events ──► Next.js desk
```

| Piece | Role | Must not |
|---|---|---|
| **OKX** | Venue: books, trades, balances, positions, orders, fills | Decide direction. Host the UI. |
| **Jev** | Fast typed decisions with calibrated probabilities | Do arithmetic, sizing, risk math, order placement, text |
| **Engine** | Tick loop, features, risk gates, order translation, persistence, SSE | Call Jev from the browser. Expose secrets to the desk. |
| **Desk** | Watch it: sleeve cards, bucket chips, positions, PnL, fills table, kill switch. No price chart or tape view yet (the engine serves `/tape`; the desk does not render it) | Sign OKX or Jev requests. |

**Jev cannot count or do arithmetic.** Every number it sees is computed in
`src/features/compute.ts` and written into `state` — and where the model reads a
magnitude, it reads a *named bucket* (`spread: "tight"`, not `spread_bps: 0.82`).
All numeric thresholds live in `src/risk/gates.ts`, in code. See
[docs/JEV_INTEGRATION.md](docs/JEV_INTEGRATION.md).

---

## The multi-bot model

Each **sleeve** is a fully isolated desk: its own instrument, position, working
order, tick clock and brain answer. Sleeves never share a decision. The shared
resources are desk-level and enforced globally — `MAX_GROSS_USD` and
`MAX_DAILY_LOSS_USD` — because three bots each at `MAX_POS_USD` is three times
the risk you think you have.

```bash
# 4 bots, each on its own instrument (true isolation)
OKX_INST_IDS=BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP,DOGE-USDT-SWAP

# 4 bots on the SAME instruments (see the caveat below)
OKX_INST_IDS=BTC-USDT-SWAP,ETH-USDT-SWAP  BOTS=1,2,3,4
```

**Read this before running several bots on one instrument.** OKX reports **one
net position per instrument per account**. Two bots on `BTC-USDT-SWAP` are
logical sleeves, not exchange-separated ones: their orders net against each
other and the account reports a single combined position. The engine attributes
a fill to the sleeve whose `clOrdId` matches, but the *exchange* position is
shared, so per-sleeve exposure can drift from reality. For genuine isolation run
one instrument per bot (the default), or use separate API keys/accounts.

---

## Operating modes

Startup **refuses to run** if the mode and the credentials disagree. A desk that
silently downgrades `live` to `paper` is worse than one that will not start.

| Mode | Market data | Jev | Orders | Venue |
|---|---|---|---|---|
| `mock` | synthetic/replay | local heuristic | simulated fills | none |
| `paper` | **live** OKX public | real or mock | **no orders** | live public only |
| `demo` | OKX **demo** | real or mock | real demo orders | `x-simulated-trading: 1` |
| `live` | live OKX | real Jev | **real orders** | requires `LIVE_CONFIRM=I_UNDERSTAND` |

`live` cannot be set at runtime over HTTP. It needs the env var *and* the
confirmation string, and it prints a live checklist at boot.

**Live opens small.** For the first `LIVE_RAMP_HOURS` (default 24) of a boot in
`live`, every position target is multiplied by `LIVE_SIZE_MULTIPLIER` (default
0.25). The ramp scales the *target*, never the gates — a quarter-size position
still has to pass every cap, stop and spread check. A multiplier above 1 is
refused at boot: a ramp may only make positions smaller.

**Ending a live run** is `touch $CLOSE_LIVE_FILE` (default `data/close-live`).
The engine stops asking Jev, cancels every working order, flattens with
reduce-only orders, and **latches** — deleting the sentinel cannot resume
trading, only restarting the engine can. It is a file rather than an HTTP route
because the dashboard is the thing most likely to be broken when you need to
stop, and because there is no auth path that could be misconfigured open.

`POST /kill` still exists and still flattens, but it needs the HTTP server up.

**Kill switch** — `POST /kill` cancels every working order, flattens every
sleeve, and refuses new entries until `POST /unkill`. The desk's KILL button
calls the engine; it never talks to OKX.

---

## Risk gates (hard-coded, always on, after Jev and before any order)

| Gate | Default | Behaviour |
|---|---|---|
| Kill switch | off | Blocks all non-reduce orders |
| `MAX_POS_USD` per sleeve | 200 | Blocks same-side adds |
| `MAX_GROSS_USD` desk | 800 | Blocks new risk |
| `MAX_DAILY_LOSS_USD` | 80 | Flattens all, halts entries for the UTC day |
| `MAX_ORDERS_PER_MIN` | 20/sleeve | Skips the tick |
| `MAX_SPREAD_BPS` | 25 | No maker on an insane spread |
| crossed / locked book | — | No entry |
| stale book | > 2 s | Hold entries, still allow exits |
| stale private state | > 5 s | Reduce-only |
| `P(direction)` | ≥ 0.55 | Entry refused below |
| `confidence(direction)` | ≥ 0.45 | Entry refused below |
| `entry_quality` | ≥ 2.0 | Entry refused below |
| very toxic flow / extreme vol | — | Veto, regardless of the model |

Sizing is deterministic and the model never picks it:

```
notional_usd = QUOTE_USD * clamp((p_dir - MIN_DIR_PROB) / (1 - MIN_DIR_PROB), 0.25, 1.0)
```

A brain error, timeout, HTTP failure or malformed answer becomes
`hold + cancel_only`. It never guesses a direction.

---

## Engine HTTP (`:3000`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Snapshot: mode, model, sleeves, positions, PnL, connections, `jev` (spend/cap), `live` (ramp/close), kill |
| GET | `/health` | Liveness |
| GET | `/history?instId=&n=` | Recent tick records (full audit) |
| GET | `/tape?instId=` | Mid series + fill marks |
| GET | `/signals?sleeveId=&n=` | What the brain saw, per tick |
| GET | `/fills` | Recent fills |
| GET | `/events` | SSE: `snapshot`, `tick`, `quote`, `fill`, `kill`, `error`, `status`, `mode` |
| POST | `/kill` · `/unkill` | Flatten + halt / resume |
| POST | `/mode` | `mock\|demo\|paper` only; `live` refused |

Binds `127.0.0.1`. Set `DASHBOARD_TOKEN` to require `Authorization: Bearer` on
mutating routes.

---

## Repositories

| Repo | Contents |
|---|---|
| *private origin* | canonical. Includes `docs/papers/` (downloaded PDFs for offline reading) |
| `github.com/AtticusG3/okx-jev-desk` | this repo. Public mirror, **no bundled papers** |

The private origin is a self-hosted Gitea and is deliberately not named here:
it is on the maintainer's own network, and publishing its hostname would
disclose infrastructure that serves nothing but the private copy. If you are
running your own fork, substitute your own private origin in
`tools/mirror-to-github.sh`.

The public mirror is produced with `tools/mirror-to-github.sh`, which exports the
tree through `git archive` (so `.gitattributes` `export-ignore` rules apply) and
gates the push on zero PDFs, no token-shaped strings, no `.env`, and no `data/`.
It is deliberately not `git push --mirror`, which would copy the papers and the
private history to a public remote.

```bash
tools/mirror-to-github.sh --dry-run   # show exactly what would be published
tools/mirror-to-github.sh             # publish
```

---

## Running it

Prereq: **Node 22+**. No Bun, no native build steps.

```bash
npm install                 # engine deps (ws) + types
npm --prefix web install    # desk deps (Next.js)
cp .env.example .env        # blank is fine: it boots offline in mock mode
npm test                    # 264 tests
npm run typecheck
npm run engine              # :3000
npm run desk                # :3001
```

### Measurement tooling

The desk is a measurement instrument until a signal clears the gate in
`docs/SIGNAL_CATALOGUE.md` §5. Three offline tools do that work — none of them
touch the network, place an order, or call a model:

```bash
npm run calibrate       # derive bucket edges from this venue's recorded history
npm run buckets         # bucket occupancy; exits non-zero on a dead bucket
npm run measure         # variance ratio, walk-forward AUC, Bonferroni p, economics
                        # 54s on 3111 ticks. The gate is p_adj < 0.05 across
                        # the 34-test family; the 95% CI is uncorrected and
                        # printed for information only.
```

`npm run measure` prints **`waiting`** instead of a number when there are fewer
than 500 settled rows, and reports `INSUFFICIENT DATA` rather than "random walk"
when the variance-ratio test is underpowered. Both are deliberate: a number
computed on 12 observations is an invitation to hand-tune, which is how every
mistake in this project's history started.

Everything above is offline and free. With `.env` untouched the engine runs
`MODE=demo MODEL=mock`, streams real OKX public market data, simulates fills
against its own mid, and never sends an order anywhere.

---

## Repository layout

## Research: where the signals come from

The signal work follows the discipline of the sibling `oddjob` project, and it
lives in `docs/`.

> **On the papers.** Every signal traces to a public source, and each catalogue
> entry links to an arXiv or author-hosted copy directly — so nothing here
> depends on a paywall or a bundled PDF. The `docs/papers/` directory in the
> private upstream repo holds downloaded copies for offline reading; those are
> `export-ignore`d, so this mirror does not redistribute third-party
> copyrighted work. Every link was verified reachable; the URLs are the
> citation.


- **[docs/SIGNAL_CATALOGUE.md](docs/SIGNAL_CATALOGUE.md)** — the literature-backed
  catalogue. What the research says is worth trying, what is implemented, and
  for each signal whether it is **code-gated** (a threshold in TypeScript) or
  **model-judged** (a semantic question to Jev).
- **[docs/RESEARCH_METHOD.md](docs/RESEARCH_METHOD.md)** — how literature becomes
  code: retrieve → verify → implement as a feature → shadow ledger → measure →
  gate. **Nothing is wired into the policy until it has been measured on this
  desk's own data.**
- **[docs/JEV_INTEGRATION.md](docs/JEV_INTEGRATION.md)** — the Jev contract, and
  the vendor-documented failure modes that shape the question design.
- **[docs/OKX_API_VERIFIED.md](docs/OKX_API_VERIFIED.md)** — the venue contract as
  verified against the live OKX docs, with discrepancies called out.

Every tick writes a full feature snapshot to the `features` table. That is the
**shadow ledger**: signals are logged with their outcomes and scored later, so a
signal can be measured honestly before it is ever allowed to size an order.

---

## Testing

```bash
npm test          # 264 tests
npm run typecheck # tsc --noEmit
```

Covers: OKX signature fixtures, USD→contract size rounding (`lotSz`/`minSz`/
`tickSz`, including a COIN-margined refusal), the 12-case intent matrix, every
risk gate, Jev response parsing and failure handling, `.env` precedence, and
fill idempotency on `tradeId` (so a WS reconnect cannot double-count a fill).

---

## Cost

Jev bills **input tokens only**. TypeSafe's published figure is $0.042 / MTok
with output egress free; at the 10 s tick across 5 sleeves that is thousands of
small calls per hour: cheap, not free.

The cap counts **what was actually billed**, not a rate multiplied by tokens.
`calls.cost_usd` holds the figure the provider reported (`usage.cost`), and the
cap is `SUM(cost_usd)` over the current UTC day. Where a transport reports no
cost, the row stores `NULL` — deliberately distinct from `0`, because "we do not
know what it cost" and "this was free" are different facts and conflating them
would let a budget look untouched while an invoice grew.

Three consequences:

- `typesafe` reports no cost, so its published rate is used as a **fallback**.
  A reported cost always wins over the rate card.
- `openrouter` has no rate this code will invent, so it depends entirely on
  `usage.cost`. If responses omit it, the engine logs a warning naming the
  partial total and `/snapshot` shows `jev.unpricedCalls`.
- `local` (self-hosted OpenJev) genuinely has no per-token meter, so all rows are
  `NULL` and the cap stays open. That is correct: there is nothing to cap.

**`JEV_DAILY_USD_CAP` (default $2) is a hard gate, not a warning.** Today's
`input_tokens` are summed from the ledger and, once the ceiling is reached, every
sleeve holds and opens nothing until 00:00 UTC. Two consequences worth knowing:

- Spend is read from the `calls` table, not from a counter in memory, so a
  restart inside the same UTC day does **not** hand the desk a fresh budget. A
  crash loop cannot spend 24× the intended amount.
- The unit is USD, not call count. A shorter state costs less, so a fixed number
  of calls would be the wrong thing to bound.

`0` disables the cap. `validate()` warns if you disable it while ticking faster
than 10 s, because a capped desk and an uncapped quiet desk are indistinguishable
from the outside — which is exactly how an unbounded bill arrives unnoticed.

`/snapshot` reports `jev: { spentUsdToday, capUsd, capped, resetsAtUtc,
unpricedCalls }`.

## Where the brain lives

`JEV_PROVIDER` selects the transport. All three speak the **same** System One
protocol — POST `{ model, state, questions }`, read `{ answers, usage }` — so
the question set, the parser and every gate are identical across all of them.
Only the URL, the credential and the price differ.

| `JEV_PROVIDER` | endpoint | credential | cost |
| --- | --- | --- | --- |
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | reported, else `$0.042`/MTok |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `OPENROUTER_API_KEY` | reported only (`usage.cost`) |
| `local` | `$JEV_BASE_URL/v1/systemone` | `JEV_API_KEY` (optional) | unmetered |

```bash
# OpenRouter
JEV_PROVIDER=openrouter
OPENROUTER_API_KEY=...
JEV_MODEL_ID=jev-1.13        # pin it; see the alias warning below

# self-hosted OpenJev (openjev/openjev, CC BY-NC 4.0 - non-commercial)
JEV_PROVIDER=local
JEV_BASE_URL=http://127.0.0.1:3000
```

Notes that matter more than they look:

- **OpenRouter's System One path is not `/chat/completions`.** It is
  OpenAI-compatible for chat, but System One models are exposed at their own
  `/v1/systemone` route taking the same typed-questions body. Sending the desk
  to `/chat/completions` produces a 404 that reads like a model outage.
- **`local` requires `JEV_BASE_URL` and will not boot without it.** There is no
  default address, on purpose: a silent default would leave the desk holding
  forever with nothing to explain it.
- **Keys are per-provider and never inherited.** An `OPENROUTER_API_KEY` sitting
  in the same `.env` is not sent when the provider is `typesafe`, because that
  mistake produces a 401 indistinguishable from a model failure. `JEV_API_KEY`
  overrides both when set deliberately.
- `JEV_BASE_URL` overrides the built-in endpoint for any provider, which is also
  the escape hatch for a proxy.
- **OpenJev licence: CC BY-NC 4.0.** Free for research and other non-commercial
  use; a commercial licence needs an email to the publisher. The `helper/` and
  `serve/` code is Apache 2.0. This matters only if the desk ever trades money
  you earn.

---

## Layout

```
src/
  index.ts          boot + mode validation
  config.ts         env, mode/credential agreement, live checklist
  engine.ts         venue wiring, sleeves, desk-level risk, kill switch
  okx/              sign, rest, wsPublic, wsBusiness (candles), wsPrivate, instruments
  jev/              client, questions, state
  features/         compute
  risk/             gates, intent
  loop/             tick
  store/            db, events, types
  http/             server (HTTP + SSE)
web/                Next.js desk
test/               node:test
docs/               research + verified API contracts
```
