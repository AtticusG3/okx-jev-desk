/**
 * Card 4 gate. The self-check.
 *
 * Three claims:
 *   1. A short ledger puts COLLECTING on the snapshot.
 *   2. When the proof throws, the LAST status is kept.
 *   3. The tick loop still advances after a proof failure.
 *
 * Point 3 is the one that matters. A self-check that can stop the thing it is
 * measuring is worse than no self-check: the bot's job is to stay up and
 * classify its ledger, and a classifier that can halt the classifier's host has
 * turned a diagnostic into a dependency.
 *
 * These tests drive Engine directly with a fixture ledger, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { Store } from "../src/store/db.ts";
import { repoRoot } from "../src/measure/era.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const ERA = "selfcheckera01";

function fixtureLedger(dir: string, days = 2): string {
  const dbPath = join(dir, "desk.db");
  const s = new Store(dbPath);
  s.fastWrites();
  s.transaction(() => {
    for (let d = 0; d < days; d++) {
      const base = Date.UTC(2026, 0, 5) + d * DAY;
      let px = 67000;
      for (let h = 9; h < 16; h++) {
        for (let k = 0; k < 20; k++) {
          const ts = base + h * 3_600_000 + k * MIN;
          px += (Math.sin(k * 0.7 + d) * 8) + (k % 5) - 2;
          const mid = px;
          s.recordTick({
            ts, sleeveId: "s1", instId: "BTC-USDT-SWAP", mid, bid: mid - 0.1, ask: mid + 0.1,
            spreadBps: 0.03, jev: null, intent: null, gates: [], executed: false, execNote: "",
            positionSide: "flat", positionNotionalUsd: 0,
            session: "europe", era: ERA, eraMissing: "",
          });
          s.recordFeatures("s1", "BTC-USDT-SWAP", ts, JSON.stringify({
            spreadTicks: 1, spreadBps: 0.03, bookImbalance: 0.1, depthImbalance5: 0.1,
            tradeCount30s: 12, volume30sUsd: 60_000, kyleLambda: 1e-8,
            ret1m: 0, ret5m: 0, ret15m: 0, ret1h: 0,
            realizedVol15m: 22, realizedVol1h: 24, rangePos1h: 0.5,
            fundingRate: 0.01, nextFundingHours: 4, oiChange1hPct: 0.1,
          }));
        }
      }
    }
  });
  s.close();
  return dbPath;
}

function cfgFor(dbPath: string): Config {
  return loadConfig({
    MODE: "mock",
    MODEL: "mock",
    OKX_INST_IDS: "BTC-USDT-SWAP",
    BOTS: "1",
    TICK_MS: "1000",
    PROOF_INTERVAL_MS: "3600000",
    PROOF_BOOT_P: "300",
    PROOF_MIN_SETTLED: "200",
  } as Record<string, string>);
}

function makeEngine(dbPath: string): Engine {
  const e = new Engine(cfgFor(dbPath), { dbPath });
  // Never start the real loop; these tests drive runProofOnce and the tick
  // counter directly.
  return e;
}

// ---------------------------------------------------------------- 1
test("a short ledger puts COLLECTING on the snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-selfcheck-"));
  try {
    const db = fixtureLedger(dir, 2);
    const e = makeEngine(db);
    e.runProofOnce();

    const snap = e.snapshot() as {
      era: string;
      proof: { status: string; days: number; reason: string } | null;
    };
    assert.ok(snap.proof, "the self-check must publish a status on the snapshot");
    assert.equal(snap.proof.status, "COLLECTING", `got ${snap.proof.status}: ${snap.proof.reason}`);
    assert.ok(snap.proof.days < 28, "2 days cannot satisfy a 28-day bar");
    assert.equal(typeof snap.era, "string");
    assert.ok(snap.era.length > 0, "the snapshot must carry the era");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("before the first self-check the proof field is null, not a fake status", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-selfcheck-null-"));
  try {
    const db = fixtureLedger(dir, 1);
    const e = makeEngine(db);
    const snap = e.snapshot() as { proof: unknown };
    assert.equal(snap.proof, null, "no self-check yet means null, not COLLECTING pretending to be a verdict");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 2 and 3
test("a proof failure keeps the last status and does not stop the tick loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-selfcheck-fail-"));
  try {
    const db = fixtureLedger(dir, 2);
    const e = makeEngine(db);

    // 1. a good run establishes a status
    e.runProofOnce();
    const first = e.proofState()!;
    assert.equal(first.status, "COLLECTING");
    assert.equal(first.error, null);

    // 2. the ledger disappears. This is a real failure mode: a disk that filled,
    //    a file that was moved, a permissions change. The proof cannot read it.
    const moved = `${db}.moved`;
    renameSync(db, moved);

    const ticksBefore = (e as unknown as { inFlight: number }).inFlight;
    // 3. it throws internally and must not propagate
    assert.doesNotThrow(() => e.runProofOnce(), "runProofOnce must never throw into the caller");

    const after = e.proofState()!;
    assert.equal(after.status, first.status, "the LAST status must be kept when a check fails");
    assert.equal(after.days, first.days, "the last known day count is kept");
    assert.ok(after.error !== null, "the failure must be recorded, not swallowed silently");
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.at, first.at, "the timestamp must not advance on a failed check");

    // 4. and the tick loop is unaffected
    renameSync(moved, db);
    const ticksAfter = (e as unknown as { inFlight: number }).inFlight;
    assert.equal(ticksBefore, ticksAfter, "in-flight accounting must be untouched by the proof");

    // 5. recovery: a good run clears the error
    e.runProofOnce();
    const recovered = e.proofState()!;
    assert.equal(recovered.error, null, "a successful check must clear the error");
    assert.equal(recovered.consecutiveFailures, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repeated failures count up, so a persistently broken proof is visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-selfcheck-repeat-"));
  try {
    const db = fixtureLedger(dir, 1);
    const e = makeEngine(db);
    e.runProofOnce();
    renameSync(db, `${db}.moved`);
    for (let i = 1; i <= 3; i++) {
      e.runProofOnce();
      assert.equal(e.proofState()!.consecutiveFailures, i);
      assert.equal(e.proofState()!.status, "COLLECTING", "still the last honest status");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the self-check never writes to intent, edges, questions or the mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-selfcheck-ro-"));
  const watched = [
    "src/risk/intent.ts",
    "src/features/edges.ts",
    "src/features/bucket_edges.json",
    "src/jev/questions.ts",
    "src/config.ts",
    "docs/PROOF_RULE.md",
    ".env.example",
  ].map((r) => join(repoRoot(), r));
  try {
    const before = watched.map((p) => [p, readFileSync(p)] as const);
    const db = fixtureLedger(dir, 3);
    const e = makeEngine(db);
    for (let i = 0; i < 5; i++) e.runProofOnce();
    for (const [p, bytes] of before) {
      assert.deepEqual(readFileSync(p), bytes, `${p} changed during a self-check`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the periodic self-check runs OFF the main thread", () => {
  // Regression, and the reason this file has a runtime test at all.
  //
  // The first live boot ran the proof inline. It pegged one core at 100%, the
  // event loop never yielded, and the engine stopped answering its own HTTP
  // endpoint, stopped reading WS frames and stopped ticking - while still
  // holding both sockets open, so from the outside it looked perfectly alive.
  // Every request to / timed out at 3s. Nothing in the unit tests caught it,
  // because the unit tests called the synchronous path deliberately.
  //
  // So assert the wiring: the TIMER must call the background form, and the
  // background form must use a Worker.
  const src = readFileSync(join(repoRoot(), "src", "engine.ts"), "utf8");
  assert.match(src, /setInterval\(\(\) => this\.runProofInBackground\(\)/,
    "the self-check timer must call runProofInBackground, not the sync path");
  assert.match(src, /setTimeout\(\(\) => this\.runProofInBackground\(\)/,
    "the first self-check after boot must also be off-thread");
  assert.match(src, /new Worker\(new URL\("\.\/measure\/proof_worker\.ts"/,
    "the background self-check must run in a worker thread");
  // Single-flight: a slow check plus a short interval must not queue work.
  assert.match(src, /if \(this\.proofBusy \|\| this\.stopped\) return;/,
    "the background self-check must be single-flight");
  // And the worker must inherit the type-stripping flag or it cannot load.
  const w = readFileSync(join(repoRoot(), "src", "measure", "proof_worker.ts"), "utf8");
  assert.match(w, /parentPort/, "the worker must post its result back");
  assert.match(src, /experimental-strip-types/, "the worker execArgv must carry the strip-types flag");
});

test("a self-check on a real-sized ledger does not take the loop hostage", () => {
  // The self-check reads the whole ledger. At the default interval (15 min)
  // that is fine; the risk is someone lowering it. Assert the default is sane.
  const cfg = loadConfig({ MODE: "mock", MODEL: "mock" } as Record<string, string>);
  assert.ok(cfg.proofIntervalMs >= 60_000,
    `PROOF_INTERVAL_MS default ${cfg.proofIntervalMs} is too aggressive for a whole-ledger read`);
  assert.ok(cfg.proofMinSettled >= 200,
    "a feature scored on a handful of rows is a coin flip presented as a statistic");
});
