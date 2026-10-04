# Signal Catalogue

**Author:** okx-jev-desk maintainers
**Date:** 2026-09-26
**Audience:** the next agent run, and any human adding a factor
**Status:** candidates **implemented as features, none promoted to policy weight** — deliberately

Papers retrieved and stored in [`papers/`](papers/). Nine of them, all open-access.

---

## 1. The rule this document exists to enforce

**Measure a signal on this desk's own data before you let it size an order.**

This project has a second, sharper rule that shapes everything below:

> **Jev cannot count or do arithmetic.** Every number it sees is computed in
> `src/features/compute.ts` and written into `state`. Every threshold is applied in
> `src/risk/gates.ts`. The model is only ever asked a *semantic* question about
> a *named bucket*.

So every signal below carries one of two labels, and the distinction is the
single most important thing in this document:

| Label | Meaning | Where it lives |
|---|---|---|
| **CODE** | A number or a comparison. Never asked of the model. | `features/compute.ts` → `risk/gates.ts` |
| **MODEL** | A semantic judgment about already-classified state. | `jev/questions.ts` |

A signal that mixes the two is a bug. `entry_quality` is the clearest example:
the model reads `spread: "wide"` and `flow: "clean"` and returns a Score, but the
cut-off `MIN_ENTRY_QUALITY=2.0` is applied in `risk/gates.ts`, not in the prompt.

The failure mode this prevents is specific and common: asking a model to
compare `spread_bps: 0.82` against a threshold in the instruction text. It will
answer inconsistently, it will answer literally, and when you later tune the
threshold you will not know which of the two you changed.

---

## 2. What the literature says is worth trying

| Signal family | Evidence | Compute in code or ask the model? | Our status |
|---|---|---|---|
| **Order flow imbalance (OFI)** | Very strong. Cont, Kukanov & Stoikov (2014, *JFEconometrics* 12(1):47-88, [arXiv:1011.6402](https://arxiv.org/abs/1011.6402)) find a *linear* relation between OFI and 10-second mid-price change across 50 US equities, R² 28-79% (grand mean 58%), with impact slope inversely proportional to depth. | **CODE** — it is a signed ratio of two book sizes. | Implemented: `bookImbalance`, `depthImbalance5` |
| **All book events, not just trades** | Eisler, Bouchaud & Kockelkoren (2009, *Quantitative Finance*, [arXiv:0904.0900](https://arxiv.org/abs/0904.0900)) extend OFI to market, limit *and cancel* orders — cancellations carry the same weight as trades. CKS show trades add nothing once OFI is controlled for. | **CODE** | **Partially implemented.** We get trades + a maintained book, but OKX's public `books5` feed is a *snapshot+delta* aggregate — we cannot separate a cancellation from a new limit order at the same price. See §6. |
| **Flow toxicity (VPIN)** | Easley, López de Prado & O'Hara (2012, *Journal of Portfolio Management*, [NYU Stern PDF](https://www.stern.nyu.edu/sites/default/files/assets/documents/con_035928.pdf)) — volume-synchronised probability of informed trading, significant forecasting power over toxicity-induced volatility. | **CODE** — it is a bulk-volume classification. | **Proxy only.** `toxicScore` is a 30-second signed-flow-dominance heuristic, *not* VPIN. Labelled honestly in §3 and §6. |
| **Perpetual funding as a signal** | Ackerer, Hugonnier & Jermann (2024, *Perpetual Futures Pricing*, [Wharton PDF](https://finance.wharton.upenn.edu/~jermann/AHJ-main-10.pdf)) derive the funding mechanism that anchors a perpetual to spot: longs pay `κ(f−x)` when the basis is positive. Funding is therefore a *directional crowding* measure, not noise. Also [arXiv:2506.08573](https://arxiv.org/abs/2506.08573) (2025) on designing funding rates. | **CODE** — magnitude is a rate in bps. | Implemented: `fundingRate`, `nextFundingHours`, bucketed to `funding: "against_long"` etc. |
| **Kyle's lambda / price impact** | Cont et al. give the depth-inverse impact coefficient; Kyle (1985) is the origin. | **CODE** — a ratio. | Implemented as a proxy: `kyleLambda` = return per unit of signed flow |
| **Hawkes self-excitation of order arrival** | Filimonov & Sornette (2018, [arXiv:1809.08060](https://arxiv.org/abs/1809.08060)) on state-dependent Hawkes processes for LOBs; a 2023 crypto application ([arXiv:2312.16190](https://arxiv.org/abs/2312.16190)) forecasts crypto from LOB data via Hawkes. Order arrival is self-exciting, so flow clusters. | **CODE** (counts of arrivals) | **Not implemented.** Requires tick-level order event reconstruction that OKX public data does not give us. Would need a fitted kernel — not a hand-tuned constant. |
| **Variance-ratio / random-walk tests** | Lo & MacKinlay (1988, *RFS* 1(1):41-59, [PDF](https://rodneywhitecenter.wharton.upenn.edu/wp-content/uploads/2014/04/8705.pdf)) — the standard test for whether returns are predictable at all. | **CODE** | **Used as the evaluation gate**, not a trading signal. If VR rejects the random walk, a 5-15 minute horizon is worth trading at all. See §5. |
| **Crypto LOB differs from equities** | Gomis-Perello (2017, [arXiv:1703.06963](https://arxiv.org/abs/1703.06963)) and a 2025 study of crypto LOB microstructural dynamics ([arXiv:2506.05764](https://arxiv.org/abs/2506.05764)). Crypto books are thinner, deeper relative to flow, and more clustered. | **CODE** | **Live-measured 2026-09-26:** BTC-USDT-SWAP spread 0.01 bps, ETH 0.04 bps. Far tighter than any equity in the CKS sample. This is why the spec's `MIN_SPREAD_BPS=0.2` was wrong — see §6. |
| **Intraday seasonality** | Standard finding; e.g. Amaya, Christoffersen, Jacobs & Vasquez on intraday return curves of Bitcoin. | **CODE** | **Not implemented.** No evidence yet for OKX specifically, and it is a suspiciously easy thing to overfit. |

**Not pursued, deliberately:** DEX/on-chain flow (different venue, out of scope),
social/sentiment signals (no reliable source at 5-15 minute horizon that survives
the "unverified" filter), and any signal whose only justification is a blog post.

---

## 3. What is implemented (features in `src/features/compute.ts`)

Every row is logged to the `features` table on every tick. That table is the
**shadow ledger** — it exists so these can be scored later without re-collecting.

| # | Feature | Formula | Label | Notes |
|---|---|---|---|---|
| 1 | `bookImbalance` | `(ΣbidSz − ΣaskSz) / (ΣbidSz + ΣaskSz)` over top 5 levels | CODE | Direct CKS-style imbalance |
| 2 | `depthImbalance5` | Same, but **notional-weighted** (`px·sz`) not size-weighted | CODE | Price-level sizes differ by orders of magnitude; unweighted is a poor proxy |
| 3 | `spreadBps` | `((ask − bid) / mid) · 1e4` | CODE | Gate input, and a `spread` bucket for the model |
| 4 | `kyleLambda` | `ret1m / netFlow` when `|netFlow| > 0.05` | CODE | Impact per unit of pressure. Null when flow is thin — a null is not a zero |
| 5 | `netFlow` / `volume30sUsd` | Signed notional over a 30 s window | CODE | Feeds the `flow` bucket |
| 6 | `toxicScore` | `dominance · (0.5 + 0.5·intensity)`, `dominance = |buy−sell|/(buy+sell)` | CODE | **NOT VPIN.** A cheap one-sidedness measure over 30 s. Not on a volume clock, no bulk classification. |
| 7 | `ret1m/5m/15m/1h` | Close-to-close from the 1m candle series | CODE | Feeds `momentum_5m`, `momentum_15m` |
| 8 | `realizedVol15m/1h` | `sqrt(var)` of log returns over 15 / 60 candles | CODE | Feeds `vol_15m` |
| 9 | `rangePos1h` | `(mid − low60) / (high60 − low60)` | CODE | Feeds `range_pos`. Being extended is a reason to wait, not a veto |
| 10 | `fundingRate` | OKX current funding rate | CODE | Feeds `funding` bucket |
| 11 | `nextFundingHours` | `(nextFundingTime − now)/3.6e6` | CODE | Feeds `hours_to_funding` |
| 12 | `oiChange1hPct` | Open-interest change | CODE | **Currently always `null`** — not yet wired to a history table. Honesty over a fake number. |

### Bucket edges are calibrated to this venue

The labels above are only meaningful if their edges come from this venue's own
distribution. The first set did not, and the failure was silent: spread
`<= 1bp -> tight` while BTC quotes 0.01bp meant every instrument read "tight"
forever, and SOL at 0.83bp (20× BTC's cost) read identically to BTC. `vol_15m`
had its "calm" ceiling at 8e-4 when BTC's realised 1m vol is ~7.7e-5, and
funding edges sat at [1, 5] bps against observed funding of 0.017 / 0.33 / 0.62
bps. Every one of those buckets was constant, so the model was being handed a
word that never varied while the instruction text implied it did.

`npm run calibrate` now derives the edges as quantiles of 7 days of 1m history
(30,300 bars) plus 300 funding periods, per instrument, and records the window in
`src/features/bucket_edges.json`. Two consequences worth stating:

- **`spread` is bucketed in ticks, not bps.** A per-instrument bps distribution
  here is a single point — the book is exactly one tick wide in calm conditions —
  so no bps edge set can split it. Ticks are scale-free and widen when the book
  actually thins. Expect it to read one tick most of the time; that is a market
  fact, and `npm run buckets` says so rather than pretending the bucket is broken.
- **`oiChange1hPct` is logged but is not a model input.** It is now wired from
  OKX rubik history (it was hardcoded `null` before), but no question references
  it, and inventing a bucket for a field Jev is never asked about is noise. It
  feeds measurement and the dashboard; it enters the question set only if a
  question is written for it.

A bucket that stays >95% one label is a bug, and `npm run buckets` exits non-zero
on one. Below 500 rows it reports `PRELIMINARY` instead, because a few minutes of
one quiet regime makes `vol_15m` and `range_pos` look degenerate when the real
problem is that not enough regime has been sampled.

### The model's four questions, and what each may rely on

Each question reads ONE fact. Where a question used to read three or four
buckets, its levels were a judgement about several unrelated things at once and
no single field could decide the level.

| Question | Type | Reads only these | Never asks it to |
|---|---|---|---|
| `direction` | choice (long/short/flat) | `imbalance`, `flow`, `momentum_5m`, `momentum_15m`, `range_pos`, `vol_15m` | compare two numbers; pick a size |
| `action` | choice (open/add/hold/reduce/close) | `position_side`, `position_vs_entry` — nothing else | size anything; re-judge the market |
| `entry_quality` | score (0-4) | `spread`, `range_pos` | reconstruct a number between levels |
| `dump_risk` | score (0-3) | `vol_15m`, `toxic` | predict a magnitude |

There is no fifth question. `buyers_in_control` (a noul) was removed 2026-09-28:
choice probabilities are the only probabilities the desk thresholds, and a
second absolute probability on screen invites the transfer the vendor documents
as invalid. `confidence` is gated separately and is never read as a probability.

---

## 4. What Jev must never be asked to do

This is not a stylistic preference. TypeSafe publishes a jaggedness page for
[jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13) enumerating the
model's known failure modes, and three of them would break this desk if we
ignored them.

| Vendor-documented failure mode | Consequence here | What we do instead |
|---|---|---|
| **"Not a calculator" / "struggles with numeric precision"** | A question containing `spread_bps: 0.82` invites an unreliable magnitude judgment, and the answer silently drifts | Every magnitude is bucketed in code. The model reads `spread: "tight"` |
| **"Does not count reliably"** | Asking "are there more than 3 sells in the last 30 s?" is a counting question | Counts are computed; the model reads `flow: "selling"` |
| **"Answers the question you wrote, not the one you meant"** | "Is the book leaning against us?" is ambiguous and will be read literally | Every instruction states the exact condition. The confusable options (`long`/`short`/`flat`) get structured `what` criteria, each describing what the option means |
| **"Math using score": score levels are weak in numerical calibration** | Do not interpolate a number between `entry_quality` levels | The score is used only against a threshold in code, never arithmetically |
| **"Context rot"** — accuracy falls as state grows | Sending raw depth plus trade history would degrade every answer | State is a compact JSON object carrying **words only**; no depth, no numbers, no history |
| **Adversarial content in state is not treated as hostile** | Order-flow text is data, but a future feed change could inject a string | Criteria are explicit; the engine never executes anything from the response |

Three more consequences worth stating because they are easy to get wrong:

- **A Noul and a Choice on the same question are not comparable.** The vendor
  gives a worked example where a Noul of 0.22 corresponds to Choice `no` at 0.99.
  We never carry a threshold from one to the other, and since 2026-09-28 we ask
  no noul at all — the only probability the gates threshold is a Choice's
  `probabilities`, and `confidence` is gated on its own field.
- **A criterion that quotes the state hands over the answer.**
  arXiv:2609.29429 varies what Jev is asked against what it *sees* and finds
  the input fields carry the label, not the wording. An example reading "order
  book imbalance says buy_heavy and 5 minute momentum says up" is a lookup table
  the model can pattern-match instead of a judgement, so no criterion here names
  a bucket value.
- **An alias moves.** `jev-latest` currently resolves to `jev-1.13.0` and will
  move on the next release. The engine warns at boot, and the response `model`
  field is stored per call so you can always tell which version answered.

---

## 5. How these get evaluated

Run against the `features` + `fills` tables, never against live intuition.

```sql
-- per-tick features
SELECT json FROM features WHERE sleeve_id = 'btc1' ORDER BY id DESC;
```

**The measurement rules, in order of importance:**

1. **AUC 0.5 means the signal carries nothing.** A 0.53 on any sample is noise
   until proven otherwise, and a plausible story does not change that. We will
   not rationalise a number we like.
2. **Minimum sample before any number is reported.** Below 500 settled outcomes
   a signal reports `null` and is listed as *waiting*. A figure computed on n=12
   is an invitation to hand-tune, which is how every previous mistake in this
   project happened.
3. **Walk-forward, never random k-fold.** Overlapping 5-15 minute forward
   returns mean a random split leaks. Train on `[0, T)`, test on `[T, T+h)`, roll
   forward. Purge and embargo the overlap window.
4. **Correct for the multiple tests.** We are testing ~12 features, and at
   conventional thresholds that produces roughly one spurious AUC > 0.55 by
   chance. Report the deflated statistic, or Bonferroni-adjusted p-values. An
   uncorrected best-of-12 is not a discovery.
5. **Out-of-sample only for promotion.** In-sample fit is a diagnostic, never a
   gate.
6. **Check the benchmark first.** Lo & MacKinlay VR on our own mid series. If
   the random walk is not rejected at the 5-15 minute horizon, no feature built
   from it will be a real edge, and that is the cheapest possible way to learn
   the horizon is wrong.

**The harness exists now.** `npm run measure` implements the rules below against
the `features` and `ticks` tables: Lo–MacKinlay variance ratio on our own mids
(first, before any feature is scored), per-feature walk-forward AUC with the
direction fitted on purged train folds and an embargo by horizon, a block
bootstrap p-value, Bonferroni across the family, and an economic column that subtracts
round-trip fees and *measured* adverse selection (passive-fill markout at
1s/10s/60s). Its maths is unit-tested against synthetic series with known
answers — `test/measure.test.ts` — because an estimator that is silently wrong
reports "no edge" forever, which is indistinguishable from an efficient market.

`npm run buckets` reports bucket occupancy and exits non-zero when any bucket is
>95% one label, which is how the dead-bucket class of bug is caught. `npm run
calibrate` regenerates the edges from this venue's recorded distribution and
records the sample size in `src/features/bucket_edges.json`.

**The promotion gate.** A signal may influence order size only when *all* hold:
≥500 settled shadow rows, a walk-forward AUC whose confidence interval excludes
0.5, a Bonferroni-adjusted p < 0.05 against the ~17-feature family, positive
out-of-sample performance, and an economic check that survives fees and the
maker/taker spread. Until then a signal is *displayed and logged* and nothing
else.

---

## 6. Caveats — read before trusting any of this

- **Our "toxicity" is not VPIN.** Easley et al. require bulk-volume
  classification on a volume clock. We use a 30-second signed-flow dominance
  heuristic. It correlates with the intuition; it is not the metric, and it must
  not be reported as VPIN.
- **We cannot see cancellations.** CKS' central claim is that cancellations
  carry the same information weight as trades. OKX's public feed gives us a
  maintained `books5` book, so a size change at an unchanged price is ambiguous
  between "cancel" and "new limit order". Our OFI is therefore a *degraded*
  version of theirs, and it is biased toward treating cancels as passive supply.
  A paid depth feed with per-event deltas would fix this.
- **Depth is top-5, not full book.** `books5` is what the public channel gives.
  Cont et al.'s impact coefficient is inversely proportional to *depth*, so a
  top-5 depth estimate is biased. `depthImbalance5` is a proxy for a quantity we
  are not really measuring.
- **Crypto microstructure is not equity microstructure.** Measured live on OKX
  2026-09-26: BTC-USDT-SWAP quotes 0.01 bps and ETH 0.04 bps. The CKS equity
  sample has spreads orders of magnitude wider. Equity-derived thresholds do not
  transfer, and this already cost us one wrong gate (see below).
- **The spec's `MIN_SPREAD_BPS=0.2` was wrong for this venue** and blocked every
  BTC and ETH entry until it was removed. Kept as a history lesson: the gate's
  real purpose is detecting a *crossed or locked* book, and that is what it now
  checks. Any numeric default inherited from a spec deserves a live measurement
  before it is trusted.
- **The 3-second tick is not a research design.** It is chosen to fit OKX rate
  limits and a ~1500 ms brain timeout. A signal with a half-life under 6 s
  cannot be evaluated at this cadence without aliasing, and any 5-15 minute
  claim is an interpolation from a sampling rate that does not resolve it.
- **Nothing here has been measured yet.** Every row in §3 is *implemented*, not
  *validated*. Nothing is promoted. `npm run measure` currently reports `waiting`
  for every feature because the ledger has far fewer than 500 settled rows, and
  the variance-ratio test reports `INSUFFICIENT DATA` — which is not evidence of
  a random walk and must never be quoted as one. The harness is built and its
  maths is tested; the sample is what is missing. The first honest output of a
  real run will very likely be "most of these are 0.5", and that is the expected
  result, not a failure.

---

## 7. What would unlock the most value next

1. **Wire `oiChange1hPct`** — the field exists and is always `null`. Open
   interest alongside funding is the standard perp crowding pair, and it is
   cheap.
2. **Implement real VPIN** — bulk-volume classification over `trades` is
   tractable with the data we already have. It replaces a heuristic that is
   currently doing a real job badly.
3. **Build the measurement harness** (`npm run measure`) that scores the shadow
   ledger with walk-forward, embargo, and Bonferroni correction. Until that
   exists, §5 is a description of intent rather than a procedure.
4. **Run the VR test** to establish whether the 5-15 minute horizon is even
   tradeable on this venue, before spending effort on which signal to trade it.
5. **Consider a paid depth feed** if cancellation data turns out to matter —
   the CKS result says it should, and it is the single cheapest structural
   improvement available.

---

## 8. Provenance

Every signal above traces to a stored paper in [`papers/`](papers/):

| Paper | Signals it justifies |
|---|---|
| Cont, Kukanov & Stoikov 2014 ([arXiv:1011.6402](https://arxiv.org/abs/1011.6402)) | OFI (1, 2), Kyle's lambda (4) |
| Eisler, Bouchaud & Kockelkoren 2009 ([arXiv:0904.0900](https://arxiv.org/abs/0904.0900)) | all-book-event OFI, the cancellation caveat |
| Easley, López de Prado & O'Hara 2012 ([Stern PDF](https://www.stern.nyu.edu/sites/default/files/assets/documents/con_035928.pdf)) | flow toxicity (6) — as a target, not an implementation |
| Ackerer, Hugonnier & Jermann 2024 ([Wharton PDF](https://finance.wharton.upenn.edu/~jermann/AHJ-main-10.pdf)) | funding as crowding (10, 11) |
| *Designing funding rates for perpetual futures* 2025 ([arXiv:2506.08573](https://arxiv.org/abs/2506.08573)) | funding mechanism background |
| Gomis-Perello 2017 ([arXiv:1703.06963](https://arxiv.org/abs/1703.06963)) | crypto-vs-equity microstructure caveat |
| *Exploring Microstructural Dynamics in Cryptocurrency LOB* 2025 ([arXiv:2506.05764](https://arxiv.org/abs/2506.05764)) | current crypto LOB findings |
| *Hawkes-based cryptocurrency forecasting via LOB data* 2023 ([arXiv:2312.16190](https://arxiv.org/abs/2312.16190)) | Hawkes clustering — not implemented |
| Lo & MacKinlay 1988 ([Wharton PDF](https://rodneywhitecenter.wharton.upenn.edu/wp-content/uploads/2014/04/8705.pdf)) | the variance-ratio evaluation gate |

Nothing in this table is cited from memory. If it is not in `papers/`, it is not
a source.
