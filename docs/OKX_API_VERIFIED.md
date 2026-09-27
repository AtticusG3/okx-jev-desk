# OKX v5 API — verified contract

Compiled **2026-09-26** from the build spec and from behaviour observed live
against OKX. Items marked **[VERIFIED LIVE]** were confirmed by running the
engine against the real exchange; the rest are from the build spec and should be
re-checked against <https://www.okx.com/docs-v5/en/> before you rely on them
with real money.

---

## 1. Discrepancies vs the build spec

Found by running it, not by reading it. Each of these cost real debugging time.

| # | Spec said | Reality | Impact |
|---|---|---|---|
| 1 | Candles (`candle1m`, `candle5m`) subscribe on the **public** WS | The public endpoint rejects them: `60018 Subscribe failed, wrong URL or channel:candle1m,instId:... doesn't exist` **[VERIFIED LIVE]** | Every tick threw; features had no candles. Fixed by a separate `OkxBusinessWs` on `/ws/v5/business` |
| 2 | (implicit) `ws.send(JSON.stringify("ping"))` | OKX wants a **bare text frame**. JSON-encoding it yields `60012 Illegal request: "ping"` **[VERIFIED LIVE]** | Ping/pong never worked; the zombie-detection watchdog was measuring the wrong thing |
| 3 | `MIN_SPREAD_BPS = 0.2` as an entry filter | BTC-USDT-SWAP quotes **0.01 bps** and ETH **0.04 bps** routinely **[VERIFIED LIVE]** | The gate blocked essentially every BTC/ETH entry. Replaced with crossed/locked-book detection, which is what a spread floor was actually standing in for |
| 4 | Maker price = `min(bid + tickSz, ask - tickSz)` for a buy | With bid 79999.9 / ask 80000.1 / tick 0.1 this returns **80000**, which is *inside* the spread | A `post_only` order priced inside the spread fills immediately as taker. Changed to "improve one tick only while still passive" |
| 5 | (spec silent on sleeves/WS ordering) | Sleeves must be constructed **after** the public WS object exists **[VERIFIED LIVE]** | `Cannot read properties of undefined (reading 'book')` on every tick |
| 6 | (spec silent) | `ctValCcy` on a USDT-margined perp is the **base coin** — `BTC-USDT-SWAP` has `ctValCcy: "BTC"`, `ctVal: "0.01"` **[VERIFIED LIVE via /public/instruments]** | A guard that only accepted `USDT`/`USD` made the most liquid instrument on the exchange unsizable |

---

## 2. Auth

### REST

```
OK-ACCESS-KEY
OK-ACCESS-SIGN         = base64( HMAC-SHA256( secret, timestamp + method + requestPath + body ) )
OK-ACCESS-TIMESTAMP    ISO-8601 with millis, e.g. 2020-12-08T09:08:57.715Z
OK-ACCESS-PASSPHRASE
Content-Type: application/json
```

`method` is upper-case. `requestPath` includes the query string and must match
the request byte for byte. Implemented in `src/okx/sign.ts`, pinned by
`test/sign.test.ts`.

### Private WS login

```
sign = base64( HMAC-SHA256( secret, timestamp + "GET" + "/users/self/verify" ) )
```

Note there is **no separator** between `GET` and the path. It looks wrong next
to the REST prehash and that is correct. Frame:

```json
{ "op": "login", "args": [{ "apiKey": "...", "passphrase": "...", "timestamp": "...", "sign": "..." }] }
```

Login success arrives as an `event: "login"` frame with `code: "0"`. The client
subscribes only after that, so a failed login never produces a subscribe storm.

### Demo trading

The **same REST host** plus header `x-simulated-trading: 1`. The engine only
sends it when `MODE=demo`, so a mock/paper run never claims to be on a venue it
is not.

Demo WS uses the `wspap` / `wsuspap` host family; live uses `ws.okx.com` or
`wsus.okx.com` for the `us` region. Derived in `config.ts:deriveWsUrls`.

---

## 3. WebSocket endpoints

| Purpose | Live | Demo |
|---|---|---|
| Public (book, trades) | `wss://ws.okx.com:8443/ws/v5/public` | `wss://wspap.okx.com:8443/ws/v5/public` |
| **Business (candles)** | `wss://ws.okx.com:8443/ws/v5/business` **[VERIFIED LIVE]** | same family |
| Private | `wss://ws.okx.com:8443/ws/v5/private` | `wss://wspap.okx.com:8443/ws/v5/private` |

Subscribe:

```json
{ "op": "subscribe", "args": [{ "channel": "books5", "instId": "BTC-USDT-SWAP" }] }
```

Ping is the **literal string** `ping`, and OKX answers `pong`. See discrepancy
#2.

### Books are snapshot-then-increment

```json
{ "arg": { "channel": "books5", "instId": "BTC-USDT-SWAP" },
  "action": "snapshot",
  "data": [{ "asks": [["80000.1","2","0","1"]], "bids": [["79999.9","3","0","1"]], "ts": "1758..." }] }
```

Later frames carry `"action":"update"` with only the changed price levels. The
client maintains a real book by merging levels, replacing by price and dropping
levels sent with size 0. Applying a delta with no prior snapshot produces a book
that looks plausible and is wrong, so the engine drops all books on reconnect
until fresh snapshots arrive.

**Limitation we cannot engineer around:** a size change at an unchanged price is
ambiguous between a cancellation and a new limit order. Cont et al. (2014) show
cancellations carry information weight comparable to trades, so our OFI is a
degraded version of the literature's. See `SIGNAL_CATALOGUE.md` §6.

### Candle array order

```
[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
```

Index 8 is the `confirm` flag. **The array is newest-first.** `parseCandle`
reads positionally and the backfill sorts by `ts` — a feature series that looks
plausible and is silently reversed is an easy bug to ship.

---

## 4. REST endpoints used

| Call | Endpoint |
|---|---|
| Instruments | `GET /api/v5/public/instruments?instType=SWAP` |
| Funding rate | `GET /api/v5/public/funding-rate?instId=` |
| Open interest | `GET /api/v5/public/open-interest?instType=SWAP&instId=` |
| Mark price | `GET /api/v5/public/mark-price?instType=SWAP&instId=` |
| Candles (backfill) | `GET /api/v5/market/candles?instId=&bar=1m&limit=100` |
| Book snapshot | `GET /api/v5/market/books?instId=&sz=5` |
| Trades | `GET /api/v5/market/trades?instId=&limit=` |
| Balance | `GET /api/v5/account/balance` |
| Positions | `GET /api/v5/account/positions?instType=SWAP` |
| Set leverage | `POST /api/v5/account/set-leverage` |
| Place order | `POST /api/v5/trade/order` |
| Cancel order | `POST /api/v5/trade/cancel-order` |
| Cancel all | `POST /api/v5/trade/cancel-batch-orders` |
| Pending orders | `GET /api/v5/trade/orders-pending` |

Response envelope is `{ code, msg, data }`; `code === "0"` is success. A non-zero
`code` with HTTP 200 is a rejection, not a success — `rest.ts` throws on both.

Instrument fields that matter: `tickSz`, `lotSz`, `minSz`, `ctVal`, `ctValCcy`,
`ctMult`, `state`. Non-`live` instruments are dropped at load.

---

## 5. Orders

Maker entry: `ordType=post_only`, `tdMode=isolated`, `reduceOnly=false`, plus
`taker` exit `ordType=ioc` with `reduceOnly=true`.

`clOrdId` is `jev<sleeve><unixms><seq>`, alphanumeric, ≤ 32 chars, so the fill
can be attributed back to the sleeve that sent it.

### Sizing

```
contracts = floor_to_lotSz( notional_usd / (px * ctVal * ctMult) )
reject if < minSz
```

Flooring is deliberate: a size that floors below the target notional is the
correct conservative outcome, and rounding up would silently over-size. Price
floors to `tickSz` for the same reason — a floored buy price stays passive.

A contract quoted in something other than a USD stablecoin is **refused**, not
guessed: the USD formula is different and the error would be orders of magnitude.
`test/sizing.test.ts` covers all of this.

---

## 6. Positions and fills

In net mode a flat position arrives as `pos: "0"` (or `""`), not as an absent
row — `toSleevePosition` maps that to `side: "flat"` rather than inventing a
short from a negative-zero or a phantom from a missing field. `test/engine.test.ts`
asserts this.

**One net position per instrument per account.** This is the hard constraint on
multi-bot operation: two bots on `BTC-USDT-SWAP` share one exchange position even
though the engine tracks two isolated sleeves. Fills are attributed by `clOrdId`,
but exposure is genuinely shared. One instrument per bot (the default) is the
only configuration where the isolation is real.

Fills arrive on the private `fills` channel with a `tradeId`. The engine keys
`fills.trade_id` as a primary key and ignores a duplicate insert, so a WS
reconnect — or a REST/WS overlap — cannot double-count. PnL is derived from the
`fills` table, which is the source of truth; the `pnl_daily` table is a
convenience rollup.

---

## 7. Still to confirm before live money

Everything marked UNCONFIRMED is taken from the build spec and has not been
exercised against a real (non-demo) account:

- **[UNCONFIRMED]** exact per-instrument order rate limits (spec says 20 req / 2 s / instId); the engine applies its own `MAX_ORDERS_PER_MIN=20` per sleeve as a conservative independent cap.
- **[UNCONFIRMED]** whether `POST /api/v5/account/set-leverage` succeeds from an API key without a UI session; the engine calls it once at startup for each sleeve and logs a failure rather than aborting.
- **[UNCONFIRMED]** account-mode / position-mode error codes, so the "fail boot with a clear error" path in the spec is not yet exercised.
- **[UNCONFIRMED]** behaviour of `ordType=post_only` on a one-tick spread — OKX is expected to reject with a price-crossing `sCode`, but the exact code is not pinned. The engine's own `makerPrice` refuses to produce a crossing price in the first place, so this should not be reachable.
- **[UNCONFIRMED]** `upl` currency semantics for a USDT-margined isolated swap (assumed the account currency = USDT).

None of these block demo trading. All of them should be exercised in `MODE=demo`
before `MODE=live`, which is what the live checklist at boot asks for.
