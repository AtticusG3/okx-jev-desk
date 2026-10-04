/**
 * The measurement harness is the instrument the whole promotion gate rests on,
 * so its maths is tested against series whose answer is known in advance.
 *
 * The variance-ratio tests here exist because of a specific bug: z* was computed
 * without Lo-MacKinlay's sqrt(nq) scaling factor. That scales the statistic down
 * by ~100x on a 10k series, so the test never rejects anything. It does not
 * crash and it does not look wrong - it just reports "does not reject a random
 * walk" forever, which is indistinguishable from a genuinely efficient market.
 * A strongly mean-reverting series must therefore produce a large |z|; that
 * assertion is what catches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auc, varianceRatio, quantile, mean, bootstrapAucCi, mulberry32, normal,
} from "../src/measure/stats.ts";

// ---------------------------------------------------------------- AUC
test("AUC: perfect separation is 1.0, inverted is 0.0", () => {
  // Higher score -> positive label ranks perfectly.
  assert.equal(auc([1, 2, 3, 4], [-1, -1, 1, 1]), 1);
  // Same scores with the labels flipped: perfectly wrong -> 0.
  assert.equal(auc([1, 2, 3, 4], [1, 1, -1, -1]), 0);
});

test("AUC: all-tied scores give exactly 0.5, not NaN or 1", () => {
  assert.equal(auc([5, 5, 5, 5], [1, -1, 1, -1]), 0.5);
});

test("AUC: one class present is NaN (undefined), not a number", () => {
  assert.ok(Number.isNaN(auc([1, 2, 3], [1, 1, 1])));
});

test("AUC: a genuinely predictive feature scores high, noise scores ~0.5", () => {
  const rng = mulberry32(7);
  const pred: number[] = []; const lab: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const v = normal(rng);
    // label driven by v plus noise
    lab.push(v + normal(rng) > 0 ? 1 : -1);
    pred.push(v);
  }
  const a = auc(pred, lab);
  assert.ok(a > 0.7, `predictive AUC ${a}`);

  const noise: number[] = [];
  for (let i = 0; i < 2000; i++) noise.push(normal(rng));
  const n = auc(noise, lab);
  assert.ok(Math.abs(n - 0.5) < 0.05, `noise AUC ${n}`);
});

// ---------------------------------------------------------------- variance ratio
const N = 10_000;

test("VR: theta*(q) reduces to the homoskedastic 2(2q-1)(q-1)/(3q) for iid data", () => {
  // This is the identity that proves the delta(j) scaling is right. It is the
  // strongest available check: an O(1/n) delta makes theta* ~1e-4 here.
  const rng = mulberry32(42);
  const x = [0];
  for (let i = 1; i < N; i++) x.push(x[i - 1]! + normal(rng));
  for (const q of [2, 5, 10]) {
    const r = varianceRatio(x, q);
    const homosk = (2 * (2 * q - 1) * (q - 1)) / (3 * q);
    // recover theta* from z and VR: z = sqrt(n)(VR-1)/sqrt(theta)
    const nd = x.length - 1;
    const theta = ((Math.sqrt(nd) * (r.vr - 1)) / r.z) ** 2;
    const rel = Math.abs(theta - homosk) / homosk;
    assert.ok(rel < 0.15, `q=${q} theta*=${theta} vs homoskedastic ${homosk} (rel ${rel})`);
  }
});

test("VR: iid random walk gives VR ~ 1 and |z*| within the null distribution", () => {
  const rng = mulberry32(42);
  const x = [0];
  for (let i = 1; i < N; i++) x.push(x[i - 1]! + normal(rng));
  for (const q of [2, 5, 10]) {
    const r = varianceRatio(x, q);
    assert.ok(Math.abs(r.vr - 1) < 0.06, `q=${q} VR=${r.vr}`);
    // z* ~ N(0,1). sd(VR-1) = sqrt(theta/nq) ~ 0.01 at n=10k, so a scaling bug
    // shows up here as |z| in the tens.
    assert.ok(Math.abs(r.z) < 3, `q=${q} z=${r.z} - should be N(0,1); a large value means theta* is mis-scaled`);
  }
});

test("VR: sqrt(n) scaling is present - a mean-reverting series gives a large |z|", () => {
  // Strongly mean-reverting: each step alternates sign. Negative autocorrelation
  // at lag 1 -> VR(2) far below 1.
  const x = [0];
  for (let i = 1; i < N; i++) x.push(x[i - 1]! + (i % 2 === 0 ? 1 : -1));
  const r = varianceRatio(x, 2);
  assert.ok(r.vr < 0.5, `VR should be well under 1, got ${r.vr}`);
  assert.ok(Number.isFinite(r.z), "z must be finite");
  // Without the sqrt(nq) factor this would be ~ -0.2 instead of ~ -100.
  assert.ok(r.z < -10, `z=${r.z} - if this is near zero the sqrt(nq) factor is missing`);
});

test("VR: a trending (positively autocorrelated) series gives z > 0", () => {
  // Cumulative sum of a persistent increment: increments run in long same-sign
  // blocks, so q-period returns are more than q times as variable.
  const rng = mulberry32(11);
  const x = [0];
  let dir = 1;
  for (let i = 1; i < N; i++) {
    if (i % 25 === 0 && rng() < 0.4) dir = -dir;
    x.push(x[i - 1]! + dir * (0.5 + rng()));
  }
  const r = varianceRatio(x, 10);
  assert.ok(r.vr > 1.5, `VR should exceed 1, got ${r.vr}`);
  assert.ok(r.z > 10, `z=${r.z}`);
});

test("VR: refuses to answer when there is not enough data for q", () => {
  const x = Array.from({ length: 20 }, (_, i) => i);
  for (const q of [10, 50]) {
    const r = varianceRatio(x, q);
    if (q === 10) assert.ok(Number.isNaN(r.vr) === false || r.n === 20);
    else assert.ok(Number.isNaN(r.vr), "q=50 on 20 points must be NaN, not a fabricated number");
  }
});

test("VR: windows counts non-overlapping q-period spans", () => {
  const x = Array.from({ length: 101 }, (_, i) => Math.sin(i / 3));
  assert.equal(varianceRatio(x, 10).windows, 10);
});

// ---------------------------------------------------------------- bootstrap
test("bootstrap CI brackets the point estimate and is not degenerate", () => {
  const rng = mulberry32(3);
  const s: number[] = []; const l: number[] = [];
  for (let i = 0; i < 1200; i++) { const v = normal(rng); s.push(v); l.push(v + normal(rng) > 0 ? 1 : -1); }
  const point = auc(s, l);
  const [lo, hi] = bootstrapAucCi(s, l, 50, 200, 0.05, mulberry32(9));
  assert.ok(lo < point && point < hi, `point ${point} outside [${lo},${hi}]`);
  assert.ok(hi - lo > 0.005, `CI too narrow to be a real interval: ${hi - lo}`);
});

test("bootstrap CI on pure noise straddles 0.5", () => {
  const rng = mulberry32(21);
  const s: number[] = []; const l: number[] = [];
  for (let i = 0; i < 1000; i++) { s.push(rng()); l.push(rng() > 0.5 ? 1 : -1); }
  const [lo, hi] = bootstrapAucCi(s, l, 10, 200, 0.05, mulberry32(5));
  assert.ok(lo < 0.5 && hi > 0.5, `noise CI [${lo},${hi}] should contain 0.5`);
});

// ---------------------------------------------------------------- helpers
test("quantile and mean behave at the edges", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(quantile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.equal(mean([2, 4]), 3);
  assert.ok(Number.isNaN(mean([])));
});
