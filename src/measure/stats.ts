/**
 * Pure statistics for the measurement harness. No I/O, so it can be tested
 * against synthetic series with known answers.
 *
 * That matters here: an estimator that is silently wrong does not fail loudly,
 * it just reports "no edge" forever and everyone concludes the market is
 * efficient. These functions are the instrument the whole promotion gate rests
 * on, so they are unit-tested on data whose answer is known in advance.
 */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Mann-Whitney AUC, ties scored 0.5. Labels must be +1 / -1. */
export function auc(scores: number[], labels: number[]): number {
  const n = scores.length;
  if (n === 0) return NaN;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]!] = avg;
    i = j + 1;
  }
  let sumPos = 0; let nPos = 0; let nNeg = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k]! > 0) { sumPos += ranks[k]!; nPos++; } else nNeg++;
  }
  if (nPos === 0 || nNeg === 0) return NaN;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Lo-MacKinlay variance ratio, heteroskedasticity-robust.
 *
 *   VR(q) = var(q-period return) / (q * var(1-period return))   -> 1 under RW
 *   theta*(q) = sum_{j=1}^{q-1} [2(q-j)/q]^2 * delta(j)
 *   delta(j) = nq * sum_k eps_k^2 eps_{k-j}^2 / [ sum_k eps_k^2 ]^2
 *   z*(q) = sqrt(nq) * (VR(q) - 1) / sqrt(theta*(q))            -> N(0,1)
 *
 * The sqrt(nq) factor is essential and easy to omit: without it z* is scaled
 * down by sqrt(nq) (~100x for a 10k-sample series) and the test never rejects
 * anything, which reads as "the market is efficient" instead of "my estimator
 * is broken". `test/measure.test.ts` pins this against a strongly
 * mean-reverting series.
 *
 * The heteroskedasticity-robust theta is used rather than the homoskedastic
 * form because our return series clusters volatility, and the homoskedastic
 * version understates the variance of VR, manufacturing rejections.
 *
 * The base period is the observed sampling cadence, not one second.
 */
export function varianceRatio(x: number[], q: number): { vr: number; z: number; n: number; windows: number } {
  const n = x.length;
  const windows = Math.floor((n - 1) / q);
  if (q < 2 || n < q * 3) return { vr: NaN, z: NaN, n, windows: 0 };

  const d: number[] = [];
  for (let i = 1; i < n; i++) d.push(x[i]! - x[i - 1]!);
  const nd = d.length;
  const mu = mean(d);

  let s1 = 0;
  for (const v of d) s1 += (v - mu) ** 2;
  const var1 = s1 / (nd - 1);
  if (!(var1 > 0)) return { vr: NaN, z: NaN, n, windows };

  const m = q * (n - q + 1) * (1 - q / n);
  if (!(m > 0)) return { vr: NaN, z: NaN, n, windows };
  let s2 = 0;
  for (let k = q; k < n; k++) {
    const r = x[k]! - x[k - q]! - q * mu;
    s2 += r * r;
  }
  const vr = s2 / m / var1;

  let theta = 0;
  for (let j = 1; j < q; j++) {
    let num = 0;
    for (let k = j; k < nd; k++) num += (d[k]! - mu) ** 2 * (d[k - j]! - mu) ** 2;
    // The nq numerator factor is part of Lo-MacKinlay's definition of delta(j):
    // without it delta is O(1/n), theta* collapses by n, and z* inflates by
    // sqrt(n) so that a true random walk "rejects" at z~33. With it, delta -> 1
    // for iid increments and theta* reduces exactly to the homoskedastic
    // 2(2q-1)(q-1)/(3q), which is the check that it is right.
    const delta = (nd * num) / (s1 * s1);
    theta += ((2 * (q - j)) / q) ** 2 * delta;
  }
  if (!(theta > 0)) return { vr, z: NaN, n, windows };
  return { vr, z: Math.sqrt(nd) * (vr - 1) / Math.sqrt(theta), n, windows };
}

/**
 * Block bootstrap CI for a paired (score, label) sample.
 *
 * Blocks, not iid rows: forward mid changes over a 15m horizon sampled every 3s
 * overlap heavily, so an iid bootstrap reports an interval far too narrow and
 * would call noise significant.
 */
export function bootstrapAucCi(
  scores: number[],
  labels: number[],
  blockRows: number,
  iters: number,
  alpha: number,
  rng: () => number = Math.random,
): [number, number] {
  const n = scores.length;
  if (n < 40) return [NaN, NaN];
  const blk = Math.max(1, Math.min(blockRows, Math.floor(n / 4)));
  const out: number[] = [];
  for (let it = 0; it < iters; it++) {
    const ss: number[] = []; const ll: number[] = [];
    while (ss.length < n) {
      const start = Math.floor(rng() * Math.max(1, n - blk));
      for (let k = 0; k < blk && ss.length < n; k++) {
        ss.push(scores[start + k]!); ll.push(labels[start + k]!);
      }
    }
    const a = auc(ss, ll);
    if (!Number.isNaN(a)) out.push(a);
  }
  if (out.length < 40) return [NaN, NaN];
  out.sort((a, b) => a - b);
  return [quantile(out, alpha / 2), quantile(out, 1 - alpha / 2)];
}

/** Deterministic PRNG for tests and reproducible synthetic series. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal from a uniform generator. */
export function normal(rng: () => number): number {
  let u = 0; let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
