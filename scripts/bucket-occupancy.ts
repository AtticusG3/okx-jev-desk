/**
 * Bucket occupancy: does each bucket label actually occur?
 *
 *   npm run buckets                 # whole ledger
 *   npm run buckets -- 24           # last 24 hours only
 *   npm run buckets -- 0 BTC-USDT-SWAP
 *
 * Reads the `features` table only - no network, no orders.
 *
 * Why: a bucket that is >95% one label carries no information, and the model is
 * being handed a constant while the instruction text implies it varies. That is
 * a bug, not a calibration choice. This report is how we catch it instead of
 * assuming the edges are sane (the first hard-coded set put every instrument in
 * one bucket for every spread/vol/funding reading, every tick, forever).
 *
 * Exits non-zero if any bucket is degenerate, so it can gate a change.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly, MissingLedgerError } from "../src/store/db.ts";
import { edgesFor, isCalibrated, loadEdgeFile } from "../src/features/edges.ts";

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "desk.db");

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


const DEGENERATE = 0.95;
/**
 * Below this many rows the occupancy read is not yet meaningful: `range_pos`
 * and `vol_15m` depend on the last hour, so a few minutes of one quiet regime
 * makes every bucket look degenerate. Reporting that as a bug would be crying
 * wolf, and the fix is more data, not different edges.
 */
const MIN_OCCUPANCY_N = 500;
const args = process.argv.slice(2);
const HOURS = args[0] !== undefined ? Number(args[0]) : 0;
const ONLY = args[1];

interface Row { inst_id: string; json: string }

function main(): void {
  const db = openLedgerOrExit();
  const since = HOURS > 0 ? Date.now() - HOURS * 3_600_000 : 0;
  const rows = db
    .prepare(`SELECT inst_id, json FROM features WHERE ts >= ? ORDER BY ts`)
    .all(since) as unknown as Row[];

  const file = loadEdgeFile();
  console.log(`bucket occupancy${HOURS > 0 ? ` (last ${HOURS}h)` : " (whole ledger)"}`);
  console.log(`edges: ${isCalibrated(file) ? `calibrated ${file!.provenance.generatedAt} (${file!.provenance.barsPerInstrument} bars/instrument, ${file!.provenance.windowDays}d)` : "NOT CALIBRATED - using fallbacks; run npm run calibrate"}`);
  console.log(`rows: ${rows.length}`);
  console.log(`per-instrument rows needed for a meaningful read: ${MIN_OCCUPANCY_N}`);
  if (rows.length === 0) {
    console.log("\nno feature rows yet. Run the engine in mock or paper mode to fill the ledger.");
    return;
  }

  const byInst = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    if (ONLY && r.inst_id !== ONLY) continue;
    let b: Record<string, string>;
    try {
      b = (JSON.parse(r.json) as { buckets: Record<string, string> }).buckets;
    } catch { continue; }
    if (!b) continue;
    if (!byInst.has(r.inst_id)) byInst.set(r.inst_id, []);
    byInst.get(r.inst_id)!.push(b);
  }

  const degenerate: string[] = [];
  const preliminary: string[] = [];
  const fields = ["spread", "vol_15m", "momentum_5m", "momentum_15m", "range_pos",
                  "funding", "imbalance", "flow", "toxic"];

  for (const [instId, buckets] of [...byInst].sort()) {
    const e = edgesFor(instId, file);
    console.log(`\n=== ${instId}  n=${buckets.length}`);
    const adequate = buckets.length >= MIN_OCCUPANCY_N;
    console.log(`    ${adequate ? "sample adequate" : `PRELIMINARY - only ${buckets.length}/${MIN_OCCUPANCY_N} rows, occupancy not yet a finding`}`);
    console.log(`    edges: spreadTicks<=[${e.spreadTicks.join(",")}] vol15m<[${e.vol15m.join(",")}] ` +
                `flat5m=${e.momentumFlatAbs["5m"]} flat15m=${e.momentumFlatAbs["15m"]} funding<[${e.fundingAbsBps.join(",")}]`);
    for (const f of fields) {
      const counts = new Map<string, number>();
      let total = 0;
      for (const b of buckets) {
        const v = b[f];
        if (v === undefined) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
        total++;
      }
      if (total === 0) {
        console.log(`    ${f.padEnd(13)} MISSING from every row`);
        degenerate.push(`${instId}.${f} (absent)`);
        continue;
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1]);
      const topShare = sorted[0]![1] / total;
      const bar = sorted
        .map(([k, v]) => `${k}:${((v / total) * 100).toFixed(0)}%`)
        .join(" ");
      const adequate = buckets.length >= MIN_OCCUPANCY_N;
      const flag = topShare > DEGENERATE
        ? `  <-- ${adequate ? "DEGENERATE" : "PRELIMINARY"} ${(topShare * 100).toFixed(0)}% "${sorted[0]![0]}"`
        : (counts.size === 1 ? "  <-- only 1 label ever" : "");
      if (topShare > DEGENERATE) {
        const msg = `${instId}.${f} ${(topShare * 100).toFixed(0)}% "${sorted[0]![0]}"`;
        if (adequate) degenerate.push(msg); else preliminary.push(msg);
      }
      console.log(`    ${f.padEnd(13)} ${bar}${flag}`);
    }
  }

  console.log();
  if (preliminary.length) {
    console.log(`${preliminary.length} bucket(s) look constant but the sample is too small to call it (see above):`);
    for (const d of preliminary.slice(0, 6)) console.log(`  - ${d}`);
    if (preliminary.length > 6) console.log(`  ... and ${preliminary.length - 6} more`);
    console.log("\nMore data is the fix. Note `spread` will stay 1 tick wide in calm");
    console.log("conditions on this venue - that is a market fact, not an edge bug.");
  }
  if (degenerate.length) {
    console.log(`${degenerate.length} degenerate bucket(s) - >${DEGENERATE * 100}% one label or wholly absent:`);
    for (const d of degenerate) console.log(`  - ${d}`);
    console.log("\nA bucket that never varies is not a signal. Either recalibrate (npm run calibrate),");
    console.log("feed the missing input, or stop putting it in Jev's state.");
    process.exitCode = 1;
  } else {
    console.log("all buckets vary - no degenerate labels.");
  }
}

main();
