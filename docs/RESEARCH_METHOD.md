# Research Method

How a paper becomes a line of code in this repository, and what stops it from
becoming a line of code too early.

**The rule:** a signal may be *implemented* at any time. It may *influence an
order* only after it has been measured on this desk's own data, out of sample,
with a correction for the fact that we tested a dozen candidates.

---

## 1. The pipeline

```
search  →  retrieve  →  verify  →  extract  →  implement  →  log  →  measure  →  gate
  ↓         ↓            ↓            ↓             ↓           ↓         ↓          ↓
 idea    paper.pdf   read the      formula +    feature in   shadow   walk-      policy
                    real thing    window        compute.ts    ledger   forward    weight
```

Each stage has a failure mode it exists to prevent.

### 1. Search

Look for the mechanism, not the strategy write-up. A paper titled "profitable
crypto strategy" is a claim; a paper titled "the price impact of order book
events" is a mechanism. Mechanisms transfer; strategies do not, and strategy
papers are usually the least reproducible writing in the field.

Query by *mechanism family*, not by asset: "order flow imbalance", "flow
toxicity VPIN", "funding rate crowding", "variance ratio", "Hawkes order
arrival", "short-horizon realized volatility".

### 2. Retrieve

Store the actual PDF in `docs/papers/`, named
`<year>-<author-slug>-<short-title-slug>.pdf`. Not a link, not a summary — the
PDF, so the claim can be re-read when the implementation is questioned.

```bash
curl -L -o docs/papers/<year>-<author>-<title>.pdf <url>
head -c4 <file> | grep -q '%PDF'    # verify it is actually a PDF
```

If a paper is paywalled, record the URL and the abstract in
`SIGNAL_CATALOGUE.md` §8 and do not cite a summary of a summary.

### 3. Verify

**The single most important rule in this document: never cite from memory.**

A fabricated citation is worse than no citation, because it is invisible. It
survives review, it looks authoritative, and it will be repeated by the next
person who reads the document. Everything in `SIGNAL_CATALOGUE.md` §8 is in
`papers/`; nothing else is a source.

Concretely, before a paper goes in the table:

- Does the PDF open? (a "200 OK" from a paywall page is not a paper)
- Do the authors, year, and venue match what the file itself says?
- Does the paper actually claim what you are citing it for? Read the abstract
  and the result table, not the title.
- If you could not verify it, **omit it**. A catalogue with 9 real papers is
  more useful than one with 40 entries where a third are plausible inventions.

### 4. Extract

For each signal, record four things and put them in `SIGNAL_CATALOGUE.md`:

| Field | Example |
|---|---|
| Exact formula | `(ΣbidSz − ΣaskSz) / (ΣbidSz + ΣaskSz)` |
| **CODE or MODEL** | CODE — it is arithmetic |
| Data requirement | top-5 book, both sides, same timestamp |
| Known failure modes | top-5 depth biases the impact coefficient; unweighted sizes are dominated by the nearest level |

The CODE/MODEL label is forced by what Jev can do — see
`SIGNAL_CATALOGUE.md` §4. If a signal cannot be expressed as a code-side
number *or* a semantic question about a named bucket, it does not belong in
this system yet.

### 5. Implement

Compute the number in `src/features/compute.ts`. Add the bucket to
`features.buckets` if the model should reason about it. Add the threshold to
`src/risk/gates.ts` if it should block a trade.

Do **not** touch `risk/intent.ts` or the sizing formula. Those are the
promotion step and they are gated (§6).

### 6. Log — the shadow ledger

Every tick writes the full feature snapshot to the `features` table:

```sql
SELECT ts, json FROM features WHERE sleeve_id = 'btc1' ORDER BY id DESC;
```

and the tick's outcome to `ticks`, and any fill to `fills`. The feature JSON is
deliberately **raw and complete**: it stores the numbers *and* the buckets, so
the measurement code can re-bucket differently later without re-collecting
anything.

This is what makes honest measurement possible at all. Without it you would have
to decide, in advance, which features to keep — and that decision is made with
the same prior that produced the candidate list.

### 7. Measure

See `SIGNAL_CATALOGUE.md` §5. The short version: walk-forward with an embargo,
Bonferroni across the family, minimum 500 settled rows, out-of-sample only, and
AUC 0.5 means nothing.

### 8. Gate

A signal is promoted to the policy — allowed to size an order — only when every
box in `SIGNAL_CATALOGUE.md` §5 is ticked. Until then it is displayed on the
desk and written to the ledger, and it does nothing else.

---

## 2. The measurement harness

`npm run measure` exists. It is offline, reads only the `features` and `ticks`
tables, and cannot place an order or call a model. Its maths lives in
`src/measure/stats.ts` and is unit-tested in `test/measure.test.ts` against
synthetic series with known answers, because an estimator that is silently wrong
does not fail — it reports "no edge" forever, which is indistinguishable from an
efficient market. That test suite immediately caught two real errors in the
variance ratio (a missing `sqrt(nq)` scaling factor and an unscaled `delta(j)`),
either of which alone would have suppressed every rejection permanently.

It reports in this order:

1. Join `features` to forward returns at 5/15/60 minutes, respecting the
   **embargo**: a feature at time *t* may only be evaluated against returns
   after *t + horizon*, and training folds must not straddle test folds.
2. Report AUC per signal with a bootstrap CI, and refuse to print a number
   below `MIN_SIGNAL_N = 500` settled rows.
3. Report the Bonferroni-adjusted p-value against the family size.
4. Report the deflated Sharpe of any composite, because a dozen features
   searched at will produce a flattering one by construction.
5. Print the count of features tested, prominently, next to the best AUC.
   Best-of-12 is not a discovery.

Two behaviours are deliberate and must survive future edits:

- **`INSUFFICIENT DATA` is not "random walk".** When the variance-ratio test is
  underpowered the harness says so and refuses a verdict. Conflating the two
  would let the desk conclude "efficient market, nothing to do" from an absence
  of data.
- **`waiting` is not zero.** Below 500 settled rows no AUC is printed at all.
  A number on 12 observations is an invitation to hand-tune.

Still to build, in priority order: an offline candle backfill that replays
`market/history-candles` through the same bucket functions, so bucket occupancy
can be judged over days instead of the few minutes a live ledger accumulates.
Book-derived buckets cannot be backfilled this way (candles carry no bid/ask) and
will always need live collection.

---

## 3. Recording provenance

One row per signal, kept current:

```
paper        Cont, Kukanov & Stoikov 2014 (arXiv:1011.6402) — docs/papers/2011-…pdf
formula      depthImbalance5 = (Σ px·sz_bid − Σ px·sz_ask) / (Σ px·sz_bid + Σ px·sz_ask)
label        CODE
code         src/features/compute.ts:computeFeatures
logged to    features.buckets.imbalance  (bucket) + features.depthImbalance5 (number)
measured     walk-forward AUC = <not yet run>, n = <not yet run>
status       NOT PROMOTED
```

`status` moves through: `IMPLEMENTED` → `MEASURED` → `GATE OPEN` → `PROMOTED`.
Only `PROMOTED` may appear in the sizing path.

---

## 4. Anti-patterns, learned the hard way elsewhere

| Anti-pattern | Why it fails | The guard here |
|---|---|---|
| Wire a plausible signal in, then look for evidence | You will find some. Confirmation bias is not a hypothesis test | Promotion requires a pre-registered gate |
| Tune a threshold on the same data you measure on | The threshold becomes part of the fit | Thresholds live in config; any change is a new measurement |
| Trust a number computed on a small sample | n=12 supports anything, especially a story you like | `MIN_SIGNEL_N` refuses to print |
| Best-of-N without correction | At 12 features you expect ~1 spurious AUC > 0.55 | Bonferroni across the family |
| Assume equity microstructure transfers to crypto | Measured spread on BTC-USDT-SWAP is 0.01 bps vs orders of magnitude wider in the equity literature | Live measurement before trusting any inherited default |
| Ask the model to compare numbers | Jev is documented as weak at numeric precision and counting | Every magnitude is bucketed; thresholds live in code |
| Let a model answer choose the size | Sizing from a model output is how a desk gets leveraged out | `sizeNotional()` is deterministic from `P(direction)` |
| Fall back to a "probably long" when the brain errors | An error becomes a position | Any brain failure is `hold + cancel_only` |

---

## 5. What "done" looks like for a signal

Not "it is in the code". A signal is done when:

- [ ] the paper is in `papers/` and the citation matches the file
- [ ] the formula is in `SIGNAL_CATALOGUE.md` §3 with a CODE/MODEL label
- [ ] the feature is computed in `computeFeatures` and lands in the `features` table
- [ ] a bucket exists if the model needs to reason about it
- [ ] `npm run measure` reports a walk-forward AUC with n ≥ 500
- [ ] the Bonferroni-adjusted p < 0.05 across the family (not an uncorrected CI)
- [ ] out-of-sample performance is positive after fees and spread
- [ ] the row says `PROMOTED`, and the commit message says why

Anything short of that last box is research, and it is labelled as research.
