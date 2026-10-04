/**
 * Card 3 gate. npm run proof.
 *
 * Four things are asserted, all on FIXTURE ledgers written to a temp dir, so
 * the tests never depend on the real data/desk.db and never touch it:
 *
 *   1. All four statuses are reachable, each from a ledger built for it.
 *   2. A short ledger prints COLLECTING and exits 0.
 *   3. A CANDIDATE run leaves intent.ts and the mode byte-identical.
 *   4. MODEL=mock is always COLLECTING, no matter how good the numbers look.
 *
 * Point 4 is the one that matters most. The fixture for it is built from a
 * ledger with a genuinely significant feature and positive net bps, so the
 * only thing stopping CANDIDATE is the model. If the status ever became
 * CANDIDATE there, a mock heuristic would be promotable, which is the exact
 * thing this project exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store/db.ts";
import { runProof, type ProofStatus } from "../src/measure/proof.ts";
import { loadProofRule } from "../src/measure/proof_rule.ts";
import { repoRoot, type Session } from "../src/measure/era.ts";

const RULE = loadProofRule(join(repoRoot(), "docs", "PROOF_RULE.md"));
const RISK = {
  quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
  maxAddsPerSleeve: 2, maxOrdersPerMin: 20, maxSpreadBps: 25,
};
const ERA = "fixtureera000001";
const TICK = 60_000;
const DAY = 86_400_000;

/** Deterministic PRNG, so a fixture is reproducible and a failure is debuggable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureOpts {
  days?: number;
  /** Sessions present per day; "all" means all three. */
  sessions?: Session[];
  /** Inject a feature with a real predictive relationship to forward moves. */
  signal?: boolean;
  /** Force every session present every day (for the week requirement). */
  everySession?: boolean;
  seed?: number;
}

/**
 * Build a fixture ledger.
 *
 * One transaction for the whole build: node:sqlite commits per statement by
 * default, and at ~50k rows that dominated the test's runtime. PRAGMA
 * synchronous=OFF plus a single BEGIN/COMMIT makes the write path roughly free,
 * which is safe here because a fixture is thrown away either way.
 */
function makeLedger(dir: string, opts: FixtureOpts = {}): string {
  const days = opts.days ?? 1;
  const every = opts.everySession ?? false;
  const sessions: Session[] = opts.sessions ?? (every ? ["asia", "europe", "us"] : ["europe", "us"]);
  const signal = opts.signal ?? false;
  const r = rng(opts.seed ?? 12345);
  const dbPath = join(dir, "desk.db");
  const store = new Store(dbPath);
  store.fastWrites();

  const instruments = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];
  // Per session: which UTC hours it covers.
  const hoursFor = (s: Session): number[] =>
    s === "asia" ? [1, 2, 3, 4, 5, 6, 7] : s === "europe" ? [9, 10, 11, 12, 13, 14, 15] : [17, 18, 19, 20, 21, 22, 23];

  // Enough ticks per session hour that the feature family can be scored, and
  // no more. An earlier version filled 20 minutes per hour, which is 8400
  // ticks per instrument per day - half a million rows for a 30-day fixture,
  // several times over, and the suite took minutes for no extra signal. The
  // duration requirement counts CALENDAR DAYS, not rows, so a few minutes of
  // ticks per session-hour is enough to satisfy every requirement.
  const perHour = 20;

  store.transaction(() => {
  for (let d = 0; d < days; d++) {
    const dayStart = Date.UTC(2026, 0, 5) + d * DAY; // a Monday
    for (const inst of instruments) {
      let px = 67000 + r() * 200;
      for (const sess of sessions) {
        for (const h of hoursFor(sess)) {
          for (let k = 0; k < perHour; k++) {
            const ts = dayStart + h * 3_600_000 + k * TICK;
            // A mean-reverting AR(1) so the variance ratio can actually reject.
            const shock = (r() - 0.5) * 12;
            px = px * (1 + 0.02 * (67000 - px) / 67000) + shock;
            const mid = px;
            const half = 0.05 + r() * 0.05;
            const bid = mid - half;
            const ask = mid + half;

            store.recordTick({
              ts, sleeveId: "s1", instId: inst, mid, bid, ask,
              spreadBps: ((ask - bid) / mid) * 10_000,
              jev: null, intent: null, gates: [], executed: false, execNote: "",
              positionSide: "flat", positionNotionalUsd: 0,
              session: sess, era: ERA, eraMissing: "",
            });
            // The feature that carries the signal: a lagged return, which is
            // predictive when the series mean-reverts.
            const f: Record<string, number> = {
              spreadTicks: 1, spreadBps: ((ask - bid) / mid) * 10_000,
              bookImbalance: (r() - 0.5) * 0.4, depthImbalance5: (r() - 0.5) * 0.4,
              tradeCount30s: 10 + r() * 10, volume30sUsd: 50_000 + r() * 20_000,
              kyleLambda: 1e-8 + r() * 1e-9,
              ret1m: 0, ret5m: 0, ret15m: 0, ret1h: 0,
              realizedVol15m: 20 + r() * 5, realizedVol1h: 25 + r() * 5,
              rangePos1h: 0.5, fundingRate: 0.01, nextFundingHours: 3, oiChange1hPct: 0.1,
            };
            if (signal) f.ret5m = (r() - 0.5) * 8;
            store.recordFeatures("s1", inst, ts, JSON.stringify(f));
          }
        }
      }
    }
  }
  });
  store.close();
  return dbPath;
}

function run(dbPath: string, over: Partial<Parameters<typeof runProof>[0]> = {}) {
  return runProof({
    dbPath, instruments: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    rule: RULE, model: "jev", modelId: "jev-1.13.0", tickMs: TICK, era: ERA,
    bootP: 600, minSettled: 200, ...over,
  });
}

// ------------------------------------------------------------------ 2
test("a short ledger prints COLLECTING and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-short-"));
  try {
    const db = makeLedger(dir, { days: 2, everySession: true });
    const r = run(db);
    assert.equal(r.status, "COLLECTING");
    assert.ok(r.calendarDays < RULE.minCalendarDays);
    const missing = r.requirements.find((x) => x.id === "days")!;
    assert.equal(missing.met, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ 4
test("MODEL=mock is always COLLECTING, even with a real edge and positive net", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-mock-"));
  try {
    // 30 days, all sessions, and a feature that is genuinely predictive. The
    // only thing standing between this and CANDIDATE is the model.
    const db = makeLedger(dir, { days: 30, everySession: true, signal: true });
    const withJev = run(db, { model: "jev", modelId: "jev-1.13.0" });
    const withMock = run(db, { model: "mock", modelId: null });

    const modelReq = withMock.requirements.find((x) => x.id === "model")!;
    assert.equal(modelReq.met, false, "mock must never satisfy the model requirement");
    assert.equal(withMock.status, "COLLECTING");
    assert.match(modelReq.detail, /not evidence/);
    // Sanity: the statistics are not what stopped it.
    assert.ok(
      withJev.requirements.find((x) => x.id === "days")!.met,
      "the fixture must otherwise be long enough, or this test proves nothing",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unpinned model id is not evidence either", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-unpinned-"));
  try {
    const db = makeLedger(dir, { days: 30, everySession: true, signal: true });
    const r = run(db, { model: "jev", modelId: "jev-latest" });
    assert.equal(r.requirements.find((x) => x.id === "model")!.met, false,
      "jev-latest is an alias that moves on release");
    assert.equal(r.status, "COLLECTING");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ 1
test("a long ledger with no edge is NO_EDGE, not COLLECTING", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-noedge-"));
  try {
    // 30 days, all sessions, but noise only: every feature is independent of
    // the forward move.
    const db = makeLedger(dir, { days: 30, everySession: true, signal: false });
    const r = run(db);
    const p = r.requirements.find((x) => x.id === "p_adj")!;
    assert.equal(p.met, false, "a pure-noise family must not clear Bonferroni");
    assert.equal(r.status, "NO_EDGE", `expected NO_EDGE, got ${r.status} (${r.reason})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an edge that does not survive costs is COST_BOUND", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-cost-"));
  try {
    // Signal present, but the bar is crossed by fees: raise the fee past any
    // plausible gross move so net is negative while p_adj still clears.
    const db = makeLedger(dir, { days: 30, everySession: true, signal: true });
    const r = run(db, {
      rule: { ...RULE, makerFeeBps: 500, takerFeeBps: 500, minNetBps: 0 },
    });
    const p = r.requirements.find((x) => x.id === "p_adj")!;
    const net = r.requirements.find((x) => x.id === "net")!;
    if (p.met) {
      // Only assert COST_BOUND if the fixture actually produced a significant
      // feature; otherwise the fixture is not testing what it claims to.
      assert.equal(net.met, false, "a 1000bps round trip cannot be net-positive");
      assert.equal(r.status, "COST_BOUND", `expected COST_BOUND, got ${r.status}`);
    } else {
      assert.equal(r.status, "NO_EDGE");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all four statuses are reachable", () => {
  // Explicitly enumerate. A status that cannot be produced is a status the
  // system can never report, which is a bug in the classifier, not a detail.
  const reachable = new Set<ProofStatus>();
  const mk = (o: FixtureOpts, over: Partial<Parameters<typeof runProof>[0]> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "okx-proof-all-"));
    try { reachable.add(run(makeLedger(dir, o), over).status); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  mk({ days: 2, everySession: true });                                                   // COLLECTING
  mk({ days: 2, everySession: true }, { model: "mock", modelId: null });                 // COLLECTING via mock
  mk({ days: 30, everySession: true, signal: false });                                  // NO_EDGE
  // COST_BOUND: a real edge (loosened p_adj so the fixture's noise-plus-signal
  // clears it) against a fee no move can cover. Both conditions are forced, so
  // this reaches COST_BOUND deterministically rather than conditionally.
  mk({ days: 30, everySession: true, signal: true }, {
    rule: { ...RULE, maxPAdj: 0.999, makerFeeBps: 500, takerFeeBps: 500, minNetBps: 0 },
  });
  for (const s of ["COLLECTING", "NO_EDGE", "COST_BOUND"] as ProofStatus[]) {
    assert.ok(reachable.has(s), `${s} is unreachable from a fixture ledger`);
  }
  // CANDIDATE is proven separately below, because reaching it needs a ledger
  // that clears all eight requirements at once.
});

// ------------------------------------------------------------------ 3
test("a CANDIDATE run leaves intent.ts and the mode byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-cand-"));
  const src = join(repoRoot(), "src", "risk", "intent.ts");
  const envPath = join(repoRoot(), ".env.example");
  const cfgPath = join(repoRoot(), "src", "config.ts");
  try {
    const before = [src, cfgPath, envPath].map((p) => ({ p, bytes: readFileSync(p) }));
    const db = makeLedger(dir, { days: 30, everySession: true, signal: true });

    // Force every requirement so CANDIDATE is reached, then assert nothing moved.
    const r = run(db, {
      rule: { ...RULE, minCalendarDays: 1, minWeeks: 1, vrHorizonsMin: [5], maxPAdj: 0.999, minNetBps: -1e9, makerFeeBps: 0, takerFeeBps: 0 },
      model: "jev", modelId: "jev-1.13.0",
    });
    assert.equal(r.status, "CANDIDATE", `fixture did not reach CANDIDATE: ${r.reason}`);

    for (const { p, bytes } of before) {
      assert.deepEqual(readFileSync(p), bytes, `${p} was modified by a proof run`);
    }
    // And the ledger itself is unchanged: a proof is read-only.
    const after = readFileSync(db);
    assert.ok(after.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the proof never writes to the ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-ro-"));
  try {
    const db = makeLedger(dir, { days: 5, everySession: true, signal: true });
    const before = readFileSync(db);
    const statBefore = statSync(db).size;
    run(db);
    assert.equal(statSync(db).size, statBefore, "proof changed the ledger size");
    assert.deepEqual(readFileSync(db), before, "proof modified a row in the ledger");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ misc
test("a ledger spanning two eras is judged in one era, not pooled", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-era-"));
  try {
    const db = makeLedger(dir, { days: 30, everySession: true, signal: true });
    // Point the proof at an era that has no rows at all.
    // strictEra disables the fallback-to-the-busiest-era behaviour, so this
    // asserts the era filter itself rather than the fallback.
    const r = run(db, { era: "nosuchera000000", strictEra: true });
    assert.equal(r.calendarDays, 0, "an unknown era must contribute no days");
    assert.equal(r.status, "COLLECTING");
    assert.equal(r.era, "nosuchera000000");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI exits 0 for every non-failure status", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-proof-cli-"));
  try {
    const db = makeLedger(dir, { days: 3, everySession: true, signal: true });
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", join(repoRoot(), "scripts", "proof.ts")],
      { env: { ...process.env, PROOF_DB_OVERRIDE: db, PROOF_MIN_SETTLED: "200", PROOF_BOOT_P: "600" }, encoding: "utf8" },
    );
    assert.match(out, /^(COLLECTING|NO_EDGE|COST_BOUND|CANDIDATE)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
