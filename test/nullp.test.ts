/**
 * The Bonferroni correction must actually be applied.
 *
 * Regression, and the reason this file exists: the harness computed alphaAdj =
 * 0.05/family, printed it in the header, and then called bootstrapAucCi with
 * the UNCORRECTED alpha. The "CI excludes 0.5" line was therefore an
 * uncorrected test wearing the label of a corrected one, and the footer
 * claiming Bonferroni was false. On a 34-test family the corrected alpha is
 * ~0.0015, so the uncorrected test accepted roughly 1-in-20 false positives
 * where it should have accepted 1-in-650.
 *
 * Every test below builds a series with a KNOWN answer and asserts the
 * correction is what produces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auc, bootstrapAucCi, mulberry32, normal } from "../src/measure/stats.ts";
import { bootstrapAucPValue, minResolvableP } from "../src/measure/nullp.ts";

const FAMILY = 34;          // 17 features x 2 horizons
const ALPHA = 0.05;
const ALPHA_ADJ = ALPHA / FAMILY;
const BLOCK = 20;
const ITERS = 4000;

const pf = (x: number): string => (Number.isFinite(x) ? x.toExponential(2) : "n/a");

/** Scores independent of the label: a known null. */
function nullSeries(n: number, seed: number): { s: number[]; l: number[] } {
  const rng = mulberry32(seed);
  const s: number[] = [];
  const l: number[] = [];
  for (let i = 0; i < n; i++) {
    s.push(normal(rng));
    l.push(rng() < 0.5 ? -1 : 1);
  }
  return { s, l };
}

/**
 * Search for a null series that the UNCORRECTED 95% interval calls significant.
 *
 * Deliberately adversarial: a single fixed seed might not produce one, and a
 * test that quietly degrades into "p_adj is also large" would pass without ever
 * exercising the bug being fixed. The corrected test must reject it anyway.
 */
function findUncorrectedFalsePositive(n: number, tries: number): { s: number[]; l: number[]; seed: number } {
  for (let seed = 1; seed <= tries; seed++) {
    const { s, l } = nullSeries(n, seed);
    const [lo, hi] = bootstrapAucCi(s, l, BLOCK, 400, ALPHA, mulberry32(seed * 7919));
    if (lo > 0.5 || hi < 0.5) return { s, l, seed };
  }
  throw new Error(`no uncorrected false positive in ${tries} tries - the test below would be vacuous`);
}

test("a known null the uncorrected 95% CI calls significant does NOT pass the corrected test", () => {
  const n = 300;
  const { s, l, seed } = findUncorrectedFalsePositive(n, 4000);

  // Precondition: the bug's own condition must actually hold here.
  const [lo, hi] = bootstrapAucCi(s, l, BLOCK, 400, ALPHA, mulberry32(seed * 104729));
  assert.ok(lo > 0.5 || hi < 0.5, `precondition failed: uncorrected CI [${pf(lo)},${pf(hi)}] includes 0.5`);

  const pv = bootstrapAucPValue(s, l, BLOCK, ITERS, mulberry32(seed * 15485863));
  const pAdj = Math.min(1, pv.p * FAMILY);

  assert.ok(pAdj > ALPHA,
    `corrected test wrongly called a known null significant: p_adj=${pf(pAdj)} <= ${ALPHA}`);

  // And the p-value itself must be an honest one, not merely a large number.
  assert.ok(pv.p > 0.02, `bootstrap p-value on a known null is implausibly small: ${pf(pv.p)}`);
});

test("the uncorrected interval would have promoted what the corrected one rejects", () => {
  // Same statement as above, framed as the decision that actually used to be
  // made: `excludesHalf` drove the gate, and it is true for this series.
  const n = 300;
  const { s, l, seed } = findUncorrectedFalsePositive(n, 4000);
  const [lo, hi] = bootstrapAucCi(s, l, BLOCK, 400, ALPHA, mulberry32(seed * 104729));
  const excludesHalf = lo > 0.5 || hi < 0.5;
  const pv = bootstrapAucPValue(s, l, BLOCK, ITERS, mulberry32(seed * 15485863));
  const pAdj = Math.min(1, pv.p * FAMILY);
  const sigAdj = pAdj < ALPHA;

  assert.equal(excludesHalf, true, "precondition: uncorrected interval excludes 0.5");
  assert.equal(sigAdj, false, "corrected decision must reject it");
  assert.notEqual(excludesHalf, sigAdj, "the two tests must disagree on this series, else nothing is proven");
});

test("correction is strict enough that a real effect at 34 tests still needs a real effect", () => {
  // Guard against over-correcting into permanent rejection. A large, honest
  // effect on a decent sample must still clear the corrected threshold.
  const rng = mulberry32(4242);
  const n = 900;
  const s: number[] = [];
  const l: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = normal(rng);
    const dir = rng() < 0.5 ? -1 : 1;
    l.push(dir);
    s.push(x + dir * 0.9);      // strong, genuine signal
  }
  const pv = bootstrapAucPValue(s, l, BLOCK, ITERS, mulberry32(99));
  const pAdj = Math.min(1, pv.p * FAMILY);
  assert.ok(pv.p < 1e-3, `strong effect should be clearly detectable, p=${pf(pv.p)}`);
  assert.ok(pAdj < ALPHA, `a real effect must survive the correction, p_adj=${pf(pAdj)}`);
});

test("bootstrap p-value on a known null is not systematically tiny", () => {
  // A sign-flip null centred on 0.5 should give p around 0.5 on average. If the
  // generator is wrong (e.g. flipping the label instead of the score), every
  // p collapses toward the floor and the test loses its meaning.
  const ps: number[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const { s, l } = nullSeries(250, seed);
    ps.push(bootstrapAucPValue(s, l, BLOCK, 2000, mulberry32(seed * 31)).p);
  }
  const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  assert.ok(avg > 0.2, `mean p on known nulls should be well above alpha, got ${pf(avg)}`);
  assert.ok(avg < 0.8, `mean p on known nulls looks inflated, got ${pf(avg)}`);
});

test("minResolvableP is the floor of the add-one estimator", () => {
  assert.equal(minResolvableP(3999), 1 / 4000);
  assert.equal(minResolvableP(0), 1);
  // 4000 resamples resolves 0.0015 with room to spare; this is why 4000 and not
  // 400 is used for the decision.
  assert.ok(minResolvableP(ITERS) < ALPHA_ADJ, "the chosen resample count must resolve the corrected alpha");
  assert.ok(minResolvableP(400) > ALPHA_ADJ, "the old resample count could NOT resolve the corrected alpha");
});

test("bootstrapAucPValue returns NaN rather than a false verdict on a tiny sample", () => {
  const rng = mulberry32(11);
  const s: number[] = [];
  const l: number[] = [];
  for (let i = 0; i < 10; i++) { s.push(normal(rng)); l.push(rng() < 0.5 ? -1 : 1); }
  const r = bootstrapAucPValue(s, l, BLOCK, 500, mulberry32(3));
  assert.ok(Number.isNaN(r.p), "a 10-row sample must not produce a usable p-value");
  assert.equal(r.resamples, 0);
});

test("the p-value is deterministic under a fixed seed", () => {
  // A gate whose verdict changes between runs on identical data is not a gate.
  const { s, l } = nullSeries(300, 77);
  const a = bootstrapAucPValue(s, l, BLOCK, 2000, mulberry32(555));
  const b = bootstrapAucPValue(s, l, BLOCK, 2000, mulberry32(555));
  assert.equal(a.p, b.p);
  assert.equal(a.extreme, b.extreme);
});

test("observed AUC from the p-value matches a direct computation", () => {
  const { s, l } = nullSeries(300, 1234);
  assert.ok(Math.abs(bootstrapAucPValue(s, l, BLOCK, 500, mulberry32(9)).observed - auc(s, l)) < 1e-12);
});
