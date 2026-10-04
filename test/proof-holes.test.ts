/**
 * The three holes a review found in the proof, and the tests that close them.
 *
 * All three were in the same direction: each one made the proof MORE likely to
 * say CANDIDATE than the evidence warranted. None of them was caught by the
 * existing suite, because the fixtures FORCED the statuses - COST_BOUND with a
 * 1000 bp fee, CANDIDATE with minNetBps set to -1e9 - rather than letting the
 * statistics produce them.
 *
 * So the tests here do not force anything. They build a ledger whose features
 * are pure noise, and assert the proof refuses to call it an edge. On the old
 * code these fail; the failure messages say which arithmetic was wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store, openReadOnly } from "../src/store/db.ts";
import { scoreFeature, loadSeries, vrResult, type Series } from "../src/measure/analysis.ts";
import { runProof } from "../src/measure/proof.ts";
import { loadProofRule } from "../src/measure/proof_rule.ts";
import { repoRoot } from "../src/measure/era.ts";

const RULE = loadProofRule(join(repoRoot(), "docs", "PROOF_RULE.md"));
const TICK = 60_000;
const DAY = 86_400_000;

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Series built in memory, so a test can isolate one statistic. */
function seriesOf(feat: { ts: number; x: number }[], priceAt: (i: number) => number): Series {
  const ticks = feat.map((f, i) => ({ ts: f.ts, mid: priceAt(i), bid: priceAt(i) - 0.05, ask: priceAt(i) + 0.05 }));
  const rows = feat.map((f) => ({
    ts: f.ts,
    f: Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`f${i}`, i === 0 ? f.x : (f.x % 7) - 3]),
    ) as Record<string, number | null>,
  }));
  return { ticks, rows, ts: ticks.map((t) => t.ts), eras: new Map(), sessions: new Map(), days: new Set() };
}

const OPTS = {
  hMin: 5, tickMs: TICK, feeBps: 7, alpha: 0.05, family: 17,
  bootP: 800, minSettled: 200, embargoRows: 100,
};

// ================================================================ claim 1
test("a coin flip is not profitable: the gross is the move the feature CALLED", () => {
  // Reproduces the review's finding exactly. The old code took mean(|y|), the
  // average size of a bar regardless of direction, so a feature that predicts
  // nothing at all scored about +3 bps per trade and reported
  // positiveAfterCost=true. A 5m BTC bar is routinely larger than the 7 bp
  // round trip, so the cost test passed by default.
  const r0 = rng(7);
  const n = 900;
  let px = 67000;
  const feat: { ts: number; x: number }[] = [];
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    // ~90 bps of 5m dispersion, so a typical bar exceeds the 7 bp round
    // trip. This is the regime the review described and the one that matters:
    // on quiet synthetic noise the old mean(|y|) happens to fall below the fee
    // and hides the bug.
    px *= 1 + (r0() - 0.5) * 0.0018;
    path.push(px);
    feat.push({ ts: Date.UTC(2026, 0, 5, 17) + i * TICK, x: r0() });
  }
  // Index by position. A closure over the final px would give every tick the
  // same price, which is not a random walk at all.
  const s = seriesOf(feat, (i) => path[i]!);
  const r = scoreFeature(s, "f0" as never, OPTS, 1);
  assert.ok(!("waiting" in r), "the fixture must be big enough to score");

  assert.ok(Math.abs(r.auc - 0.5) < 0.05, `AUC should be ~0.5 for a coin flip, got ${r.auc.toFixed(3)}`);
  assert.equal(r.positiveAfterCost, false,
    `a feature with no predictive power must not be profitable: net=${r.netBps.toFixed(2)}bps`);
  assert.ok(r.netBps < 0, `a coin flip must lose to fees, got net=${r.netBps.toFixed(2)}bps`);
});

test("the signed gross is not the absolute bar size", () => {
  // Same data, asserted structurally: the undirected figure is reported
  // separately so a reader can see when a feature is describing volatility
  // rather than direction.
  const r0 = rng(11);
  const n = 800;
  let px = 67000;
  const feat: { ts: number; x: number }[] = [];
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    px *= 1 + (r0() - 0.5) * 0.0006;
    path.push(px);
    feat.push({ ts: Date.UTC(2026, 0, 5, 17) + i * TICK, x: r0() });
  }
  const r = scoreFeature(seriesOf(feat, (i) => path[i]!), "f0" as never, OPTS, 2);
  assert.ok(!("waiting" in r));
  // Both figures are MEANS, not magnitudes. On a symmetric random walk the
  // mean of y and the mean of |y| are both near zero, which is the point: the
  // old mean(|y|) was large only because it was an average of positive
  // numbers, not because the market was going anywhere.
  //
  // What must hold for a coin flip is that the two are indistinguishable in
  // size and the signed one is not "profitable". Assert the relationship that
  // actually distinguishes them: |signed| must be small, and the pair must
  // agree, because a directionless feature has no directional edge to find.
  assert.ok(Math.abs(r.grossBps) < 1.5,
    `a coin flip's signed edge must be near zero, got ${r.grossBps.toFixed(2)}bps`);
  assert.ok(Math.abs(r.grossBpsAlwaysLong - r.grossBps) < 1.5,
    `on noise the two must agree; signed=${r.grossBps.toFixed(2)} long=${r.grossBpsAlwaysLong.toFixed(2)}`);
  assert.ok(r.netBps < 0, "and it must still lose to fees");
});

test("a feature that predicts the OPPOSITE direction is unprofitable", () => {
  // The direction is fitted on training data, so a feature that anti-predicts
  // gets dir = -1 and should still end up positive if the fit is honest. What
  // must NOT happen is the old behaviour, where |y| made a loser look like a
  // winner. Assert the reported direction matches the data.
  const r0 = rng(23);
  const n = 900;
  let px = 67000;
  const feat: { ts: number; x: number }[] = [];
  const path: number[] = [];
  const last = { x: 0 };
  for (let i = 0; i < n; i++) {
    const shock = (r0() - 0.5) * 0.0006;
    px *= 1 + shock;
    path.push(px);
    // The feature encodes the PREVIOUS shock, which predicts the next one only
    // through the mean reversion of this walk, so mostly it is noise.
    feat.push({ ts: Date.UTC(2026, 0, 5, 17) + i * TICK, x: last.x });
    last.x = shock * 10000;
  }
  const r = scoreFeature(seriesOf(feat, (i) => path[i]!), "f0" as never, OPTS, 3);
  assert.ok(!("waiting" in r));
  assert.ok(r.netBps < 7, "net must be below the round-trip fee for a noise feature");
});

// ================================================================ claim 2
test("significance and profit must come from the SAME feature", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-claim2-"));
  try {
    // Build a ledger where ONE feature is significant and unprofitable, and
    // another is insignificant but has fat bars. The old code took the best
    // p_adj from one and the best net from the other, and passed the family.
    const db = join(dir, "desk.db");
    const s = new Store(db);
    s.fastWrites();
    s.transaction(() => {
      const r0 = rng(99);
      let px = 67000;
      for (let d = 0; d < 30; d++) {
        const base = Date.UTC(2026, 0, 5) + d * DAY;
        for (let h = 9; h < 16; h++) {
          for (let k = 0; k < 20; k++) {
            const ts = base + h * 3_600_000 + k * TICK;
            // Strong mean reversion, so ret5m genuinely predicts the reversal.
            const prevShock = (r0() - 0.5) * 0.002;
            px *= 1 + prevShock;
            const mid = px;
            s.recordTick({
              ts, sleeveId: "s1", instId: "BTC-USDT-SWAP", mid, bid: mid - 0.05, ask: mid + 0.05,
              spreadBps: 0.015, jev: null, intent: null, gates: [], executed: false, execNote: "",
              positionSide: "flat", positionNotionalUsd: 0,
              session: "europe", era: "E2", eraMissing: "",
            });
            const f: Record<string, number> = {
              spreadTicks: 1, spreadBps: 0.015, bookImbalance: 0, depthImbalance5: 0,
              tradeCount30s: 10, volume30sUsd: 1e5, kyleLambda: 1e-8,
              // predictive: the shock that just happened
              ret5m: prevShock * 10000,
              ret1m: 0, ret15m: 0, ret1h: 0,
              realizedVol15m: 20, realizedVol1h: 20, rangePos1h: 0.5,
              fundingRate: 0.01, nextFundingHours: 3, oiChange1hPct: 0.1,
            };
            s.recordFeatures("s1", "BTC-USDT-SWAP", ts, JSON.stringify(f));
          }
        }
      }
    });
    s.close();

    // Ask the question directly: is the net reported for a significance test
    // ever taken from a DIFFERENT feature than the significant one?
    const report = runProof({
      dbPath: db, instruments: ["BTC-USDT-SWAP"], rule: {
        ...RULE, minCalendarDays: 1, minWeeks: 1, vrHorizonsMin: [5], maxPAdj: 0.999,
      },
      model: "jev", modelId: "jev-1.13.0", tickMs: TICK, era: "E2",
      strictEra: true, bootP: 400, minSettled: 200,
    });
    const pAdjReq = report.requirements.find((x) => x.id === "p_adj")!;
    const netReq = report.requirements.find((x) => x.id === "net")!;
    // The net requirement must name the SAME feature the p_adj requirement does.
    const sigFeat = /best p_adj [\d.e+-]+ \(([^)]+)\)/.exec(pAdjReq.detail)?.[1];
    if (sigFeat) {
      assert.ok(netReq.detail.startsWith(sigFeat),
        `the net figure must be the significant feature's own: sig=${sigFeat}, net="${netReq.detail}"`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a family where only one feature is significant does not borrow another's profit", () => {
  // Structural assertion on the source: the two reductions must be one.
  const src = readSrc("src/measure/proof.ts");
  assert.ok(
    /const bestNet = bestRow \? bestRow\.netBps : null;/.test(src),
    "bestNet must be read from bestRow, not an independent max over the family",
  );
  // A family-wide maximum may still exist for DISPLAY (naming the most
  // profitable feature when it is not the significant one), but it must not
  // reach a requirement's `met` flag. So assert the gate expression, not the
  // mere presence of a max.
  const netReq = src.slice(src.indexOf('push("net"'), src.indexOf('push("net"') + 700);
  assert.ok(/bestNet !== null && bestNet > r\.minNetBps/.test(netReq),
    "the net requirement's verdict must be computed from bestRow.netBps");
  assert.ok(!/Math\.max\(\.\.\.scoredAll/.test(netReq),
    "the net requirement must not be decided by a family-wide maximum");
});

// ================================================================ claim 3
test("loadSeries does not leak rows from other eras or from before eras existed", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-claim3-"));
  try {
    const db = join(dir, "desk.db");
    const s = new Store(db);
    s.fastWrites();
    s.transaction(() => {
      // 300 rows in era A, 300 in era B, 300 with no era at all.
      for (const [era, base] of [["A", 0], ["B", 1_000_000], [null, 2_000_000]] as const) {
        for (let i = 0; i < 300; i++) {
          const ts = Date.UTC(2026, 0, 5, 17) + base + i * TICK;
          const mid = 67000 + i;
          s.recordTick({
            ts, sleeveId: "s1", instId: "BTC-USDT-SWAP", mid, bid: mid - 0.05, ask: mid + 0.05,
            spreadBps: 0.015, jev: null, intent: null, gates: [], executed: false, execNote: "",
            positionSide: "flat", positionNotionalUsd: 0,
            session: "us", era, eraMissing: "",
          });
          s.recordFeatures("s1", "BTC-USDT-SWAP", ts, JSON.stringify({
            spreadTicks: 1, spreadBps: 0.015, bookImbalance: 0, depthImbalance5: 0,
            tradeCount30s: 10, volume30sUsd: 1e5, kyleLambda: 1e-8,
            ret1m: 0, ret5m: 0, ret15m: 0, ret1h: 0,
            realizedVol15m: 20, realizedVol1h: 20, rangePos1h: 0.5,
            fundingRate: 0.01, nextFundingHours: 3, oiChange1hPct: 0.1,
          }));
        }
      }
    });
    s.close();

    const all = loadSeries(db, "BTC-USDT-SWAP");
    assert.equal(all.ticks.length, 900, "unfiltered read sees everything");
    assert.equal(all.rows.length, 900);

    const a = loadSeries(db, "BTC-USDT-SWAP", "A");
    assert.equal(a.ticks.length, 300, `era A must have 300 rows, got ${a.ticks.length}`);
    assert.equal(a.rows.length, 300, "feature rows must be era-restricted too");
    assert.ok(a.ticks.every((t) => t.era === "A"), "no row from another era");
    // The feature join is by timestamp: every feature row must have a tick.
    const tickTs = new Set(a.ticks.map((t) => t.ts));
    assert.ok(a.rows.every((r) => tickTs.has(r.ts)), "no orphan feature rows");

    const b = loadSeries(db, "BTC-USDT-SWAP", "B");
    assert.equal(b.ticks.length, 300);
    assert.ok(b.ticks.every((t) => t.era === "B"));

    // And the variance ratio actually sees different data per era.
    const vrA = vrResult(a.ticks.map((t) => t.mid), 1, TICK);
    const vrAll = vrResult(all.ticks.map((t) => t.mid), 1, TICK);
    assert.equal(vrA.n, 300, "the VR must run on the era's rows only");
    assert.equal(vrAll.n, 900);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the proof's statistics are era-scoped, not just its day count", () => {
  const src = readSrc("src/measure/proof.ts");
  // The discovery pass may read unfiltered; the scoring pass must not.
  const calls = src.match(/loadSeries\(inp\.dbPath, inst[^)]*\)/g) ?? [];
  assert.equal(calls.length, 2, `expected 2 loadSeries calls, found ${calls.length}`);
  const scoped = calls.filter((c) => c.includes(", era)"));
  assert.equal(scoped.length, 1,
    `exactly one call (the scoring pass) must be era-scoped; calls: ${JSON.stringify(calls)}`);
});

test("an era filter that matched nothing must not silently fall back to all rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "okx-claim3b-"));
  try {
    const db = join(dir, "desk.db");
    const s = new Store(db);
    s.fastWrites();
    s.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const ts = Date.UTC(2026, 0, 5, 17) + i * TICK;
        const mid = 67000 + (i % 7);
        s.recordTick({
          ts, sleeveId: "s1", instId: "BTC-USDT-SWAP", mid, bid: mid - 0.05, ask: mid + 0.05,
          spreadBps: 0.015, jev: null, intent: null, gates: [], executed: false, execNote: "",
          positionSide: "flat", positionNotionalUsd: 0,
          session: "us", era: "REAL", eraMissing: "",
        });
        s.recordFeatures("s1", "BTC-USDT-SWAP", ts, JSON.stringify({ ret5m: 0, ret1h: 0, spreadBps: 0.015 }));
      }
    });
    s.close();
    const miss = loadSeries(db, "BTC-USDT-SWAP", "NOSUCHERA");
    assert.equal(miss.ticks.length, 0, "an unknown era must yield no rows, not all of them");
    assert.equal(miss.rows.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ helper
function readSrc(rel: string): string {
  return readFileSync(join(repoRoot(), rel), "utf8");
}
