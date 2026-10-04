/**
 * Card 1 gate. Ledger identity.
 *
 * Two claims, both asserted here as re-runnable tests rather than asserted in
 * prose:
 *
 *   1. data/desk.db is append-only across restarts. Booting twice must only
 *      ever grow the row count. Nothing may delete or rewrite a tick.
 *   2. Changing an era-defining file starts a new era, and the rows written
 *      under the old era are still there.
 *
 * The second matters more than it looks: if an era change ever reset the
 * ledger, then a tuning edit could quietly erase the evidence against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store, openReadOnly } from "../src/store/db.ts";
import {
  computeEra, eraHash, sizingFingerprint, sessionForHour, sessionForTs, ERA_FILES,
  type Session,
} from "../src/measure/era.ts";

const RISK = {
  quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
  maxAddsPerSleeve: 2, maxOrdersPerMin: 20, maxSpreadBps: 25,
};

function tickRow(ts: number, era: string | null, session: Session | null) {
  return {
    ts, sleeveId: "s1", instId: "BTC-USDT-SWAP", mid: 67000, bid: 66999.9, ask: 67000.1,
    spreadBps: 0.015, jev: null, intent: null, gates: [], executed: false, execNote: "",
    positionSide: "flat" as const, positionNotionalUsd: 0, session, era, eraMissing: "",
  };
}

function countTicks(path: string): number {
  const db = openReadOnly(path);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM ticks").get() as { n: number }).n;
  } finally { db.close(); }
}

// ------------------------------------------------------------------ claim 1
test("booting twice only grows the ledger: rows are never lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-appendonly-"));
  const dbPath = join(dir, "desk.db");
  try {
    // First boot: 3 ticks.
    {
      const s1 = new Store(dbPath);
      s1.recordTick(tickRow(1000, "eraA", "asia"));
      s1.recordTick(tickRow(2000, "eraA", "europe"));
      s1.recordTick(tickRow(3000, "eraA", "us"));
      s1.close();
    }
    const after1 = countTicks(dbPath);
    assert.equal(after1, 3, "first boot should hold 3 ticks");

    // Second boot: the SAME file, reopened. This is the restart case.
    {
      const s2 = new Store(dbPath);
      s2.recordTick(tickRow(4000, "eraA", "asia"));
      s2.close();
    }
    const after2 = countTicks(dbPath);
    assert.equal(after2, 4, "a restart must append, not replace");
    assert.ok(after2 > after1, "row count must only grow");

    // Third boot, several restarts deep.
    {
      const s3 = new Store(dbPath);
      for (let i = 0; i < 5; i++) s3.recordTick(tickRow(5000 + i, "eraA", "us"));
      s3.close();
    }
    assert.equal(countTicks(dbPath), 9, "9 ticks after three boots, none lost");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the migration is idempotent: reopening never loses rows or throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-migrate-"));
  const dbPath = join(dir, "desk.db");
  try {
    const a = new Store(dbPath);
    a.recordTick(tickRow(1, "e", "asia"));
    a.close();
    // Reopen repeatedly. migrate() runs ALTER TABLE ADD COLUMN every time; if
    // the column probe were broken, the second open would throw.
    for (let i = 0; i < 3; i++) {
      const s = new Store(dbPath);
      s.recordTick(tickRow(10 + i, "e", "us"));
      s.close();
    }
    assert.equal(countTicks(dbPath), 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ claim 2
/** A throwaway repo tree containing real copies of the era files. */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "okx-era-"));
  for (const rel of ERA_FILES) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    // PROOF_RULE.md does not exist until card 2; supply a stand-in so the
    // fixture is complete, and assert separately that a missing file is
    // reported rather than silently hashed as empty.
    writeFileSync(dst, rel.endsWith("PROOF_RULE.md") ? "# stand-in\n" : `// ${rel}\nexport const x = 1;\n`);
  }
  return root;
}

test("changing the question file starts a new era and keeps the old rows", () => {
  const root = fakeRepo();
  const dbPath = join(root, "data", "desk.db");
  try {
    const before = computeEra(root);
    const hashA = eraHash(before, sizingFingerprint(RISK));
    assert.equal(before.missing.length, 0, "fixture should have every era file");

    // Collect under era A.
    const s1 = new Store(dbPath);
    s1.recordTick(tickRow(1000, hashA, "asia"));
    s1.recordTick(tickRow(2000, hashA, "us"));
    s1.close();
    assert.equal(countTicks(dbPath), 2);

    // Edit ONE era file - the question file, which is what a retune touches.
    writeFileSync(join(root, "src/jev/questions.ts"), "// changed\nexport const x = 2;\n");

    const after = computeEra(root);
    const hashB = eraHash(after, sizingFingerprint(RISK));

    assert.notEqual(hashA, hashB, "editing questions.ts must change the era hash");
    assert.equal(after.missing.length, 0);
    // Attribute the change to one file, so a mismatch is diagnosable.
    assert.equal(after.files["src/jev/questions.ts"] !== before.files["src/jev/questions.ts"], true);
    assert.equal(after.files["src/features/bucket_edges.json"], before.files["src/features/bucket_edges.json"]);

    // Collect under era B into the SAME ledger.
    const s2 = new Store(dbPath);
    s2.recordTick(tickRow(3000, hashB, "asia"));
    s2.close();

    assert.equal(countTicks(dbPath), 3, "the two era-A rows must survive the era change");

    // Both eras are present and queryable - this is the whole point.
    const db = openReadOnly(dbPath);
    try {
      const byEra = db.prepare("SELECT era, COUNT(*) AS n FROM ticks GROUP BY era ORDER BY era").all();
      assert.equal(byEra.length, 2, "exactly two eras in the ledger");
      const counts: Record<string, number> = {};
      for (const r of byEra as { era: string; n: number }[]) counts[r.era] = r.n;
      assert.equal(counts[hashA], 2, "era A keeps its 2 rows");
      assert.equal(counts[hashB], 1, "era B has its 1 new row");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every era file is load-bearing: editing any one changes the era", () => {
  const root = fakeRepo();
  try {
    const base = eraHash(computeEra(root), sizingFingerprint(RISK));
    for (const rel of ERA_FILES) {
      const p = join(root, rel);
      writeFileSync(p, `${readFileSync(p, "utf8")}\n// touched\n`);
      const next = eraHash(computeEra(root), sizingFingerprint(RISK));
      assert.notEqual(next, base, `${rel} is not part of the era hash`);
      writeFileSync(p, readFileSync(p, "utf8").replace(/\n\/\/ touched\n$/, ""));
      assert.equal(eraHash(computeEra(root), sizingFingerprint(RISK)), base, "revert must restore the era");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sizing constants are part of the era", () => {
  const root = fakeRepo();
  try {
    const d = computeEra(root);
    const base = eraHash(d, sizingFingerprint(RISK));
    assert.notEqual(eraHash(d, sizingFingerprint({ ...RISK, quoteUsd: 80 })), base,
      "retuning QUOTE_USD must start a new era");
    assert.notEqual(eraHash(d, sizingFingerprint({ ...RISK, maxPosUsd: 400 })), base,
      "retuning MAX_POS_USD must start a new era");
    assert.equal(eraHash(d, sizingFingerprint({ ...RISK })), base, "same config, same era");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing era file is reported, not silently hashed as empty", () => {
  // docs/PROOF_RULE.md arrives in card 2. Before it exists the era must be
  // honest about that: a stable-but-wrong hash would let a later run claim a
  // bar was met under a configuration that cannot be reconstructed.
  const root = fakeRepo();
  try {
    rmSync(join(root, "docs/PROOF_RULE.md"));
    const d = computeEra(root);
    assert.deepEqual(d.missing, ["docs/PROOF_RULE.md"]);
    assert.equal(Object.keys(d.files).length, ERA_FILES.length - 1);
    // The hash is still stable, so rows are comparable - but missing is visible.
    assert.equal(d.hash, computeEra(root).hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ sessions
test("UTC sessions partition the day at the stated boundaries", () => {
  assert.equal(sessionForHour(0), "asia", "00:00 UTC is Asia");
  assert.equal(sessionForHour(7), "asia", "07:59 UTC is still Asia");
  assert.equal(sessionForHour(8), "europe", "08:00 UTC is Europe");
  assert.equal(sessionForHour(15), "europe");
  assert.equal(sessionForHour(16), "us", "16:00 UTC is US");
  assert.equal(sessionForHour(23), "us");
  // Day boundaries and out-of-range input must not fall through.
  assert.equal(sessionForHour(24), "asia", "midnight rolls to Asia, not out of range");
  assert.equal(sessionForHour(-1), "us", "23:00 the previous day");
  assert.equal(sessionForHour(25), "asia", "25h wraps to 01:00, which is Asia");
});

test("sessionForTs uses UTC regardless of the host timezone", () => {
  // A row's session must be the same on any machine, so this is pinned with
  // explicit UTC instants rather than Date local access.
  assert.equal(sessionForTs(Date.UTC(2026, 0, 2, 3, 59)), "asia");
  assert.equal(sessionForTs(Date.UTC(2026, 0, 2, 8, 0)), "europe");
  assert.equal(sessionForTs(Date.UTC(2026, 0, 2, 16, 0)), "us");
});

test("the stored session matches the timestamp on the same row", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-session-"));
  const dbPath = join(dir, "desk.db");
  try {
    const s = new Store(dbPath);
    const cases: [number, Session][] = [
      [Date.UTC(2026, 2, 10, 1, 0), "asia"],
      [Date.UTC(2026, 2, 10, 12, 0), "europe"],
      [Date.UTC(2026, 2, 10, 20, 0), "us"],
    ];
    for (const [ts, want] of cases) s.recordTick(tickRow(ts, "eraX", want));
    s.close();

    const db = openReadOnly(dbPath);
    try {
      for (const row of db.prepare("SELECT ts, session FROM ticks ORDER BY ts").all() as
        { ts: number; session: string }[]) {
        assert.equal(row.session, sessionForTs(row.ts), `session mismatch at ${new Date(row.ts).toISOString()}`);
      }
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
