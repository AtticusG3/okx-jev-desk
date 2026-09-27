# The frozen bar

This file is the bar. Not a description of it — the bar itself.

`npm run proof` reads this file. It does not have its own copy of these
numbers, because a harness that keeps its own copy is a harness that will
quietly disagree with the document it claims to implement.

**Editing this file changes the era hash, and therefore starts a new era.**
A row collected under the old bar stops counting toward the new one. That is
deliberate: the bar is the thing being claimed, so changing the bar invalidates
the claim without anyone having to remember to reset anything.

## The bar

A signal is a **CANDIDATE** only when all of the following are true. This is
the whole list; there is no discretionary part.

| # | Requirement | Value |
|---|---|---|
| 1 | Calendar days collected, in one era | **28** |
| 2 | Asia session present each of those weeks | **every one of the 4** |
| 3 | US session present each of those weeks | **every one of the 4** |
| 4 | Model | **`jev`**, with a model id that is **pinned** |
| 5 | Variance ratio verdict, 5m | **rejects the random walk** |
| 6 | Variance ratio verdict, 15m | **rejects the random walk** |
| 7 | Bonferroni `p_adj` | **< 0.05** across the feature family |
| 8 | Net bps after costs | **> 0** |

## Why each one is here

**28 days.** Long enough that a single regime — a quiet week, one funding
cycle, one news event — cannot carry the result. Short enough to actually
finish.

**Asia and US each week, and not Europe.** The three sessions are kept
separate because they are not the same market. Asia and US are the two the
bar requires; Europe is collected but is not on the critical path, so a
ledger that has plenty of European coverage and no Asian coverage cannot
quietly pass a "4 weeks of data" test by counting the same hours twice.

**`MODEL=jev` with a pinned id.** `jev-latest` is an alias that moves when
the vendor ships. Evidence collected against a moving target is not evidence
about any particular model, so a pinned id is required and an unpinned one
disqualifies the era rather than degrading it.

**Variance ratio at 5m and 15m.** The questions claim a 5–15 minute horizon.
If the price does not reject a random walk at those scales, there is nothing
for a directional feature to explain, and no amount of AUC on a stationary
series is a finding. The harness reports this first, before any feature score,
precisely so that a good-looking AUC cannot be read past a refusal.

**Bonferroni `p_adj < 0.05`.** Corrected across the whole feature family. A
single 5% test over a family of ~34 is a ~1-in-6 chance of naming a winner out
of pure noise. This is the correction whose absence would make every other
number on this page decorative.

**Net bps > 0 after costs.** After round-trip fees (2 bps maker + 5 bps taker)
and after the **measured** adverse-selection estimate: what a passive fill
would have been worth had it been filled at the mark 1s, 10s and 60s later.
A positive AUC with negative bps after cost is a description of something real
that is not worth doing.

## What this file is not

It is not a target to be tuned toward, and it is not a thing the engine
adjusts. The bot does not read its own score to decide what to ask, how to
size, or which way to lean — that is the line between a measuring instrument
and a machine that flatters itself. This file is read by the proof, printed,
and otherwise left alone.

`CANDIDATE` is not a promotion either. It is a statement that the evidence
cleared this bar. Acting on it remains a separate, human decision.
