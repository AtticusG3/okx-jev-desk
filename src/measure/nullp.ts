import { auc } from "./stats.ts";

/**
 * Two-sided p-value for H0: AUC = 0.5, from a block bootstrap with sign flips.
 *
 * Why sign flips generate the null exactly: AUC is the probability that a
 * randomly chosen positive scores above a randomly chosen negative. If each
 * score's sign is replaced with a fair coin, the score carries no information
 * about the label, so E[AUC] = 0.5 exactly - and the dependence between
 * neighbouring rows survives, because whole blocks are flipped together. That
 * is the null we want, and it is the reason this is a p-value rather than a
 * percentile of a bootstrap distribution centred on the *observed* AUC, which
 * is not a null distribution at all.
 *
 * A p-value is the right tool for a corrected threshold: a percentile CI at
 * alpha = 0.0015 needs ~70k resamples for the 0.00075 tail to hold 50 points,
 * while this p-value resolves 0.0015 with a couple of thousand and costs about
 * a second. Precision near the decision boundary comes from the resample count,
 * not from a quantile nobody can estimate.
 *
 * The add-one in the numerator keeps p in (0, 1]: a p of exactly 0 is not
 * something a finite resample count can support, and printing it would be a
 * lie about the evidence.
 */
export function bootstrapAucPValue(
  scores: number[],
  labels: number[],
  blockRows: number,
  iters: number,
  rng: () => number = Math.random,
): { p: number; resamples: number; observed: number; extreme: number } {
  const n = scores.length;
  if (n < 40) return { p: NaN, resamples: 0, observed: NaN, extreme: 0 };
  const blk = Math.max(1, Math.min(blockRows, Math.floor(n / 4)));
  const observed = auc(scores, labels);
  if (Number.isNaN(observed)) return { p: NaN, resamples: 0, observed: NaN, extreme: 0 };
  const delta = Math.abs(observed - 0.5);

  let extreme = 0;
  let used = 0;
  for (let it = 0; it < iters; it++) {
    const ss: number[] = [];
    const ll: number[] = [];
    while (ss.length < n) {
      const start = Math.floor(rng() * Math.max(1, n - blk));
      for (let k = 0; k < blk && ss.length < n; k++) {
        const i = start + k;
        // fair coin on the score's sign = the exact AUC=0.5 null
        ss.push(rng() < 0.5 ? -scores[i]! : scores[i]!);
        ll.push(labels[i]!);
      }
    }
    const a = auc(ss, ll);
    if (Number.isNaN(a)) continue;
    used++;
    // The epsilon keeps a replicate that ties the observed value counted as
    // extreme; without it a null sitting exactly on the observation would be
    // reported as evidence against itself.
    if (Math.abs(a - 0.5) >= delta - 1e-12) extreme++;
  }
  return { p: (1 + extreme) / (1 + used), resamples: used, observed, extreme };
}

/**
 * Smallest p-value a given resample count can distinguish from zero.
 *
 * With the add-one estimator the floor is 1 / (1 + resamples). If that floor is
 * not below the corrected alpha, the test cannot resolve the threshold it is
 * being asked to apply, and any "pass" at that alpha would be meaningless.
 */
export function minResolvableP(resamples: number): number {
  return 1 / (1 + Math.max(0, resamples));
}
