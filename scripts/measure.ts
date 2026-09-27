/**
 * Measurement harness. Offline: reads the `features` and `ticks` tables only.
 * No network, no orders, no LLM, no writes.
 *
 *   npm run measure                    # default horizons 5m and 15m
 *   npm run measure -- 15              # a single 15m horizon
 *   npm run measure -- 5 BTC-USDT-SWAP
 *
 * The order of reporting is the point of the tool:
 *
 *   1. Lo-MacKinlay variance ratio on our own mids, FIRST, before any feature is
 *      scored. If the 5-15m horizon does not reject a random walk then no
 *      feature built from this series has an edge there and every AUC below is
 *      noise being ranked. An underpowered test prints "INSUFFICIENT DATA",
 *      which is NOT evidence of a random walk and is never reported as one.
 *   2. Per-feature walk-forward AUC against the forward mid change, with the
 *      direction fitted on train folds only. Fitting the sign in-sample and
 *      reporting the in-sample AUC is how a feature gets a number it cannot
 *      reproduce.
 *   3. Bonferroni across the family: ~17 features x 2 horizons at alpha=0.05.
 *      Applied as a corrected p-value, NOT as a percentile CI. A percentile CI
 *      at the corrected level needs ~70k resamples for 50 points in a 0.00075
 *      tail, so the gate is p_adj = p_bootstrap x family instead, with the
 *      resample floor checked against the threshold before anything is scored.
 *      The uncorrected 95% CI is printed but never decides anything.
 *      manufactures significance by itself.
 *   4. An economic column: mean forward move in bps, minus round-trip fees,
 *      minus measured adverse selection (passive-fill markout at 1s/10s/60s).
 *      A positive AUC that loses money after costs is not a promotion.
 *
 * Nothing here can promote a signal. It reports; a human decides.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly, MissingLedgerError } from "../src/store/db.ts";
import { loadEdgeFile } from "../src/features/edges.ts";
import {
  auc, bootstrapAucCi, mean, mulberry32, quantile, varianceRatio,
} from "../src/measure/stats.ts";
import { bootstrapAucPValue, minResolvableP } from "../src/measure/nullp.ts";

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "desk.db");

// ---------------------------------------------------------------- policy knobs
const MIN_SETTLED = 500;      // rows with a known forward return - the spec's bar
/**
 * Walk-forward evaluates only on held-out folds (fold 0 trains), so the
 * out-of-sample count is structurally smaller than the settled count - roughly
 * half. Requiring OOS >= 500 too would silently raise the real bar to ~900
 * settled rows, which is not what the gate says. The settled count is what gates
 * reporting; this is a smaller floor for "can this AUC be read at all", and the
 * OOS count is printed on every line so the distinction is never hidden.
 */
const MIN_OOS = 200;
const MIN_VR_BASE = 2000;
const MIN_VR_WINDOWS = 100;
const FOLDS = 4;
const BOOTSTRAP = 400;        // percentile CI only, for information
/**
 * Resamples for the Bonferroni-corrected test.
 *
 * The corrected alpha is ALPHA/family. A percentile CI at that level would need
 * ~50 resamples in a 0.00075 tail - about 70k - which is why the decision is
 * made on a p-value instead: it resolves the same threshold with a floor of
 * 1/(1+iters). The floor must sit below alphaAdj or the test cannot decide the
 * question it is being asked; main() refuses to run if it does not.
 */
const BOOTSTRAP_P = 4000;
const ALPHA = 0.05;
const MAKER_FEE_BPS = Number(process.env.FEE_MAKER_BPS ?? 2);
const TAKER_FEE_BPS = Number(process.env.FEE_TAKER_BPS ?? 5);

const args = process.argv.slice(2);
const HORIZONS_MIN = args[0] ? [Number(args[0])] : [5, 15];
const ONLY_INST = args[1];

/**
 * Open the ledger, or explain that there isn't one yet.
 *
 * A fresh clone has no data/desk.db, and both tools are advertised in the
 * README as the first thing to run. A stack trace there reads as "the repo is
 * broken" when the truth is "no engine has run yet".
 */
function openLedgerOrExit(): ReturnType<typeof openReadOnly> {
  try {
    return openReadOnly(DB_PATH);
  } catch (e) {
    if (e instanceof MissingLedgerError) {
      console.log(`No ledger at ${DB_PATH} yet.`);
      console.log("Run the engine first (MODE=mock or paper), then re-run:");
      console.log("  npm run engine        # or: MODE=paper npm run engine");
      console.log("It writes one row per sleeve per tick, so a few minutes is enough");
      console.log("to see bucket occupancy; 500 settled rows per feature is the");
      console.log("threshold before any feature score is reported.");
      process.exit(0);
    }
    throw e;
  }
}


const FEATURES = [
  "spreadTicks", "spreadBps", "bookImbalance", "depthImbalance5", "tradeCount30s",
  "volume30sUsd", "kyleLambda", "ret1m", "ret5m", "ret15m", "ret1h",
  "realizedVol15m", "realizedVol1h", "rangePos1h", "fundingRate", "nextFundingHours",
  "oiChange1hPct",
] as const;

interface Tick { ts: number; mid: number; bid: number; ask: number }
interface FRow { ts: number; f: Record<string, number | null> }

// ---------------------------------------------------------------- data
function loadSeries(instId: string): { ticks: Tick[]; rows: FRow[]; ts: number[] } {
  const db = openReadOnly(DB_PATH);
  const raw = db.prepare(
    `SELECT ts, mid, bid, ask FROM ticks WHERE inst_id = ? AND mid > 0 ORDER BY ts`,
  ).all(instId) as unknown as Tick[];
  const fr = db.prepare(
    `SELECT ts, json FROM features WHERE inst_id = ? ORDER BY ts`,
  ).all(instId) as unknown as Array<{ ts: number; json: string }>;

  const ticks: Tick[] = [];
  const seenT = new Set<number>();
  for (const t of raw) {
    if (seenT.has(t.ts)) continue;
    seenT.add(t.ts);
    ticks.push(t);
  }
  const rows: FRow[] = [];
  const seenF = new Set<number>();
  for (const r of fr) {
    if (seenF.has(r.ts)) continue;
    seenF.add(r.ts);
    try {
      const j = JSON.parse(r.json) as Record<string, unknown>;
      const f: Record<string, number | null> = {};
      for (const k of FEATURES) {
        const v = j[k];
        f[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
      }
      rows.push({ ts: r.ts, f });
    } catch { /* skip malformed row */ }
  }
  return { ticks, rows, ts: ticks.map((t) => t.ts) };
}

/** Index of the first tick at or after `t`. */
function lowerBound(ts: number[], t: number): number {
  let lo = 0; let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! >= t) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Forward mid change in bps at +hMs from the tick at/after `fromTs`. */
function forwardBps(ticks: Tick[], ts: number[], fromTs: number, hMs: number, tolMs: number): number | null {
  const i0 = lowerBound(ts, fromTs);
  if (i0 >= ticks.length) return null;
  const base = ticks[i0]!;
  if (!(base.mid > 0)) return null;
  const target = base.ts + hMs;
  const i1 = lowerBound(ts, target);
  if (i1 >= ticks.length) return null;
  if (ts[i1]! - target > tolMs) return null; // gap too large; not that horizon
  return ((ticks[i1]!.mid - base.mid) / base.mid) * 10_000;
}

/**
 * Adverse selection, measured rather than assumed.
 *
 * A resting buy at the bid is filled once the best ask trades down to it; a
 * resting sell at the ask is filled once the best bid trades up to it. For each
 * such event we take the signed mid move from the fill onward. A mid that moves
 * against the passive side is the cost of having rested there - precisely what
 * you pay for queue priority, and the number that decides whether the one-tick
 * improvement in makerPrice is worth it.
 *
 * Uses the ticks table only.
 */
function markout(ticks: Tick[], ts: number[], horizonMs: number, side: "buy" | "sell"): { n: number; bps: number } {
  const moves: number[] = [];
  for (let i = 0; i < ticks.length - 1; i++) {
    const t = ticks[i]!;
    if (!(t.bid > 0) || !(t.ask > 0)) continue;
    let fill = -1;
    for (let j = i + 1; j < ticks.length; j++) {
      const u = ticks[j]!;
      if (u.ts - t.ts > horizonMs) break;
      if (side === "buy" ? u.ask <= t.bid : u.bid >= t.ask) { fill = j; break; }
    }
    if (fill < 0) continue;
    const f = ticks[fill]!;
    const target = f.ts + horizonMs;
    const k = lowerBound(ts, target);
    if (k >= ticks.length || ts[k]! - target > horizonMs) continue;
    const move = ((ticks[k]!.mid - f.mid) / f.mid) * 10_000;
    moves.push(side === "buy" ? -move : move);
  }
  return { n: moves.length, bps: mean(moves) };
}

// ---------------------------------------------------------------- report
/**
 * A fixed seed per (instrument, horizon, feature) so the report is reproducible.
 * The old code used Math.random, which meant re-running gave different
 * intervals - a gate whose verdict changes on a re-run with no new data is not
 * a gate.
 */
function seedFor(parts: (string | number)[]): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

function main(): void {
  const db = openLedgerOrExit();
  let insts = (db.prepare(`SELECT DISTINCT inst_id FROM ticks ORDER BY inst_id`)
    .all() as unknown as Array<{ inst_id: string }>).map((r) => r.inst_id);
  if (ONLY_INST) insts = insts.filter((i) => i === ONLY_INST);

  console.log("okx-jev-desk measurement harness");
  console.log("offline: features + ticks tables only. No network, no orders, no LLM.\n");

  if (insts.length === 0) {
    console.log("no ticks in the ledger. Run the engine (MODE=mock or paper), then re-run.");
    return;
  }
  const edgeFile = loadEdgeFile();
  console.log(`edges: ${edgeFile ? `calibrated ${edgeFile.provenance.generatedAt}` : "NOT CALIBRATED - run npm run calibrate"}\n`);

  let vrVerdictPossible = false;
  let rwRejected = false;

  // ---------------- 1. variance ratio, before any feature score ----------------
  console.log("=".repeat(78));
  console.log("1. LO-MACKINLAY VARIANCE RATIO on our own mids");
  console.log("   VR=1 under a random walk; |z*| > 1.96 rejects at 5%.");
  console.log("   Runs FIRST: if the claimed horizon is a random walk, no feature");
  console.log("   built on this series has an edge there and the AUCs are ranking noise.");
  console.log("=".repeat(78));

  for (const instId of insts) {
    const { ticks, ts } = loadSeries(instId);
    if (ticks.length < 10) { console.log(`\n${instId}: too few ticks (${ticks.length})`); continue; }
    const mids = ticks.map((t) => t.mid);
    const gaps: number[] = [];
    for (let i = 1; i < ticks.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    gaps.sort((a, b) => a - b);
    const cadence = Math.max(1, Math.round(quantile(gaps, 0.5)));
    console.log(`\n--- ${instId}  ticks=${ticks.length}  cadence=${cadence}ms  base period = the observed cadence, not 1s`);
    for (const hMin of HORIZONS_MIN) {
      const q = Math.max(2, Math.round((hMin * 60_000) / cadence));
      const r = varianceRatio(mids, q);
      if (!Number.isFinite(r.vr)) {
        const need = q * 3;
        console.log(`    ${String(hMin).padStart(3)}m  VR=n/a  needs >=${need} ticks for q=${q} ` +
          `(have ${r.n}) - INSUFFICIENT, not a verdict`);
        continue;
      }
      const enough = r.n >= MIN_VR_BASE && r.windows >= MIN_VR_WINDOWS;
      const rejects = Number.isFinite(r.z) && Math.abs(r.z) > 1.96;
      if (enough) { vrVerdictPossible = true; if (rejects) rwRejected = true; }
      const verdict = !enough ? "INSUFFICIENT DATA"
        : rejects ? (r.vr < 1 ? "MEAN-REVERTING" : "TRENDING")
        : "does not reject random walk";
      console.log(`    ${String(hMin).padStart(3)}m  VR=${r.vr.toFixed(4)}  ` +
        `z*=${Number.isFinite(r.z) ? r.z.toFixed(2) : "n/a"}  windows=${r.windows}  -> ${verdict}`);
    }
    if (cadence > 1200) {
      console.log(`    1s   UNRESOLVABLE: cadence is ${cadence}ms, so a 1-second horizon does not exist here`);
    }
  }

  console.log();
  if (!vrVerdictPossible) {
    console.log("!! No horizon had enough data for a variance-ratio verdict.");
    console.log("   INSUFFICIENT IS NOT EVIDENCE OF A RANDOM WALK. Keep collecting.");
  } else if (!rwRejected) {
    console.log("!! The 5-15m horizon does NOT reject a random walk on this ledger.");
    console.log("   Per docs/SIGNAL_CATALOGUE.md section 5, do not propose a new question");
    console.log("   set for this horizon until it does.");
  } else {
    console.log("Variance ratio rejects the random walk at a claimed horizon - the horizon");
    console.log("is worth scoring. Feature results follow.");
  }

  // ---------------- 2-4. features ----------------
  const family = FEATURES.length * HORIZONS_MIN.length;
  const alphaAdj = ALPHA / family;
  // If the resample count cannot resolve the corrected threshold, every
  // p_adj would floor above it and every feature would read "no edge" for a
  // reason that has nothing to do with the data. That is a silent false
  // negative, so refuse to run instead.
  const pFloor = minResolvableP(BOOTSTRAP_P);
  if (pFloor >= alphaAdj) {
    console.error(`refusing to score: p-value floor ${pFloor.toExponential(2)} (from ${BOOTSTRAP_P} resamples)`);
    console.error(`  is not below the Bonferroni threshold ${alphaAdj.toExponential(2)} (alpha/${family}).`);
    console.error(`  Raise BOOTSTRAP_P above ${Math.ceil(1 / alphaAdj) - 1} resamples, or reduce the family.`);
    process.exit(2);
  }
  console.log(`\n${"=".repeat(78)}`);
  console.log("2-4. FEATURE SCORES (walk-forward AUC, Bonferroni, economics)");
  console.log(`   horizons ${HORIZONS_MIN.map((h) => h + "m").join(", ")}; family = ${FEATURES.length} features x ${HORIZONS_MIN.length} = ${family} tests`);
  console.log(`   Bonferroni alpha = ${ALPHA}/${family} = ${alphaAdj.toExponential(2)}`);
  console.log(`   DECISION: p_adj = p_bootstrap x ${family}, p_bootstrap from ${BOOTSTRAP_P} block-bootstrap`);
  console.log(`   sign-flip resamples (exact H0: AUC=0.5). Smallest resolvable p = ${minResolvableP(BOOTSTRAP_P).toExponential(2)}.`);
  console.log(`   The CI95_uncorr column is the UNCORRECTED 95% interval, shown for information only.`);
  console.log(`   It is not the gate and never promotes anything. (An earlier version of this`);
  console.log(`   harness printed the uncorrected CI as the verdict and called it Bonferroni.)`);
  console.log(`   cost floor: maker ${MAKER_FEE_BPS}bps + taker ${TAKER_FEE_BPS}bps round trip`);
  console.log(`   "waiting" = fewer than ${MIN_SETTLED} settled rows (a row whose forward return is known),`);
  console.log(`   or fewer than ${MIN_OOS} held-out rows from the walk-forward split. No number below that.`);
  console.log("=".repeat(78));

  for (const instId of insts) {
    const { ticks, rows, ts } = loadSeries(instId);
    if (rows.length === 0) { console.log(`\n${instId}: no feature rows`); continue; }
    const gaps: number[] = [];
    for (let i = 1; i < ticks.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    gaps.sort((a, b) => a - b);
    const cadence = Math.max(1, Math.round(quantile(gaps, 0.5)));
    const tol = Math.max(cadence * 3, 5000);
    console.log(`\n--- ${instId}  feature rows=${rows.length}  cadence=${cadence}ms`);

    const mk1 = markout(ticks, ts, 1_000, "buy");
    const mk10 = markout(ticks, ts, 10_000, "buy");
    const mk60 = markout(ticks, ts, 60_000, "buy");
    const adverseKnown = mk60.n >= 50;
    const adverse = adverseKnown ? Math.max(0, mk60.bps) : 0;
    const fmt = (m: { n: number; bps: number }): string =>
      m.n === 0 ? "n/a (no passive fills observed)" : `${m.bps.toFixed(3)}bps (n=${m.n})`;
    console.log(`    adverse selection, passive buy markout:  1s ${fmt(mk1)} | 10s ${fmt(mk10)} | 60s ${fmt(mk60)}`);
    if (!adverseKnown) {
      console.log(`    60s markout n<50 -> net column shown WITHOUT adverse selection; treat as optimistic`);
    }

    for (const hMin of HORIZONS_MIN) {
      const hMs = hMin * 60_000;
      const blockRows = Math.max(1, Math.round(hMs / cadence));
      console.log(`\n    horizon ${hMin}m   (embargo + block size ${blockRows} rows)`);

      const scored: Array<{ feat: string; n: number; oos: number; lo: number; hi: number; pAdj: number; gross: number; net: number; edge: boolean; why: string }> = [];

      for (const feat of FEATURES) {
        // settled rows: feature present AND a forward mid exists at +h
        const xs: number[] = []; const fwd: number[] = []; const rts: number[] = [];
        for (const r of rows) {
          const v = r.f[feat];
          if (v === null) continue;
          const fb = forwardBps(ticks, ts, r.ts, hMs, tol);
          if (fb === null) continue;
          xs.push(v); fwd.push(fb); rts.push(r.ts);
        }
        if (xs.length < MIN_SETTLED) {
          console.log(`      ${feat.padEnd(17)} waiting  (settled ${xs.length}/${MIN_SETTLED})`);
          continue;
        }

        // walk-forward: fit the direction on purged train folds, apply to test
        const oosScore: number[] = []; const oosFwd: number[] = []; const oosRail: number[] = [];
        for (let k = 1; k < FOLDS; k++) {
          const lo = quantile(rts, k / FOLDS);
          const hi = quantile(rts, (k + 1) / FOLDS);
          const tr: number[] = []; const te: number[] = [];
          for (let i = 0; i < xs.length; i++) {
            const t = rts[i]!;
            if (t >= lo && t < hi) te.push(i);
            // embargo: drop train rows whose forward window reaches into test
            else if (t + hMs + tol < lo) tr.push(i);
          }
          if (tr.length < 50 || te.length < 20) continue;
          const trLab = tr.map((i) => Math.sign(fwd[i]!));
          if (trLab.every((l) => l === trLab[0])) continue;
          const trAuc = auc(tr.map((i) => xs[i]!), trLab);
          if (Number.isNaN(trAuc)) continue;
          const dir = trAuc >= 0.5 ? 1 : -1;
          for (const i of te) {
            oosScore.push(dir * xs[i]!); oosFwd.push(fwd[i]!); oosRail.push(rts[i]!);
          }
        }
        if (oosScore.length < MIN_OOS) {
          console.log(`      ${feat.padEnd(17)} waiting  (OOS held-out ${oosScore.length}/${MIN_OOS}; ` +
            `settled ${xs.length} clears the ${MIN_SETTLED} bar but the folds do not)`);
          continue;
        }

        // drop zero forward moves from the AUC (unclassifiable), keep for economics
        const aS: number[] = []; const aL: number[] = [];
        for (let i = 0; i < oosScore.length; i++) {
          const l = Math.sign(oosFwd[i]!);
          if (l === 0) continue;
          aS.push(oosScore[i]!); aL.push(l);
        }
        const oos = auc(aS, aL);
        // The DECISION uses the Bonferroni-adjusted p-value. The percentile CI
        // is printed for information only and is deliberately NOT the test: at
        // 95% it is the uncorrected interval, and calling it the gate is what
        // this harness used to do.
        const pv = bootstrapAucPValue(aS, aL, blockRows, BOOTSTRAP_P, mulberry32(seedFor([instId, hMin, feat])));
        const pAdj = Math.min(1, pv.p * family);
        const [lo, hi] = bootstrapAucCi(aS, aL, blockRows, BOOTSTRAP, ALPHA, mulberry32(seedFor([instId, hMin, feat, "ci"])));

        // economics: trade the direction the score implies, skip exactly-zero scores
        const moves: number[] = [];
        for (let i = 0; i < oosScore.length; i++) {
          const s = oosScore[i]!;
          if (s === 0) continue;
          moves.push((s > 0 ? 1 : -1) * oosFwd[i]!);
        }
        const gross = mean(moves);
        const net = gross - (MAKER_FEE_BPS + TAKER_FEE_BPS) - adverse;

        // The gate, in one place. Both conditions must hold.
        const sigAdj = Number.isFinite(pAdj) && pAdj < ALPHA;
        const uncorrectedExcludes = Number.isFinite(lo) && Number.isFinite(hi) && (lo > 0.5 || hi < 0.5);
        const why = !sigAdj
          ? (uncorrectedExcludes
              ? "no edge (uncorrected 95% CI excludes 0.5, but p_adj does not clear Bonferroni)"
              : "no edge (p_adj above Bonferroni threshold)")
          : net > 0 ? "PASSES" : "no edge (negative after cost)";
        scored.push({ feat, n: oosScore.length, oos, lo, hi, pAdj, gross, net, edge: sigAdj && net > 0, why });

        console.log(`      ${feat.padEnd(17)} n=${String(oosScore.length).padStart(5)}  AUC=${oos.toFixed(3)}` +
          `  p_adj=${(Number.isFinite(pAdj) ? pAdj.toExponential(1) : "n/a")}` +
          `  CI95_uncorr=[${Number.isFinite(lo) ? lo.toFixed(3) : "n/a"},${Number.isFinite(hi) ? hi.toFixed(3) : "n/a"}]` +
          `  gross=${gross.toFixed(2)}bps  net=${net.toFixed(2)}bps  ${why}`);
      }

      // A high AUC on a short ledger is usually one regime wearing a statistic.
      // Say so, because `ret1h` reading 0.91 is exactly the kind of number a
      // reader would otherwise treat as a discovery. Note this is printed on AUC
      // and not on p_adj: a large effect can be there and still fail the
      // corrected test, and both facts are worth seeing.
      const anyHigh = scored.filter((x) => Number.isFinite(x.oos) && Math.abs(x.oos - 0.5) > 0.2);
      if (anyHigh.length > 0) {
        console.log(`\n      CAVEAT: ${anyHigh.length} feature(s) show |AUC-0.5| > 0.2 on ${anyHigh[0]!.n} held-out rows.`);
        console.log(`      The ledger spans one regime, so a strongly autocorrelated feature (ret1h and`);
        console.log(`      friends are near-constant within a fold) can separate almost trivially.`);
        console.log(`      The economic column is the arbiter, and nothing below is promoted.`);
      }

      if (scored.length === 0) {
        console.log(`      (nothing scored - every feature is waiting for ${MIN_SETTLED} settled rows)`);
      } else {
        const pass = scored.filter((s) => s.edge);
        console.log(`\n      ${scored.length} scored, ${pass.length} meeting both the Bonferroni p and the cost test`);
        if (pass.length === 0) {
          console.log("      Nothing is promotable. Per SIGNAL_CATALOGUE section 5 the gate is not");
          console.log("      met, so no signal may influence order size.");
        } else {
          console.log("      Candidates meeting the harness criteria (a human still decides):");
          for (const p of pass) console.log(`        - ${p.feat}  AUC=${p.oos.toFixed(3)}  net=${p.net.toFixed(2)}bps`);
        }
      }
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("Nothing here promotes a signal. It reports; a human decides.");
  console.log("Gate, per docs/SIGNAL_CATALOGUE.md section 5: >=500 settled rows, walk-forward");
  console.log("with embargo, Bonferroni-adjusted p < 0.05 across the family, and positive");
  console.log("bps after round-trip fees and measured adverse selection.");
  console.log("=".repeat(78));
}

main();
