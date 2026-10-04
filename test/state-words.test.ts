/**
 * Card 7 gate. What the model is shown, and what it is asked.
 *
 * Four claims from arXiv:2609.29429 ("Just Ask Jev"), applied to the Jev
 * request only. None of them retunes a threshold, changes intent or sizing, or
 * touches the live switch — they constrain the SHAPE of what leaves the desk.
 *
 *   1. The state sent to the model carries no magnitude. Not one dollar, bps,
 *      raw rate or count. The paper varies what Jev is asked against what it
 *      sees and finds the input fields carry the label; a number in the state is
 *      a field that encodes the answer, and the model can key on it instead of
 *      judging the market. The full numbers still go to the ledger - that claim
 *      is asserted here too, because "the model can't see it" is only safe if
 *      the record still can.
 *   2. A criterion must not quote the state that should produce it, and a
 *      not-for line that is only a sibling's negation is gone.
 *   3. Only Choice probabilities are thresholdable: no noul question, and no
 *      reasoning parameter in the request body (a knob that varies the answer
 *      between identical calls makes a ledger row an unrepeatable sample).
 *   4. One criterion, one fact: entry_quality reads the spread and whether price
 *      is extended, dump_risk reads volatility and flow toxicity, and `action`
 *      is decidable from the two inventory words alone.
 *
 * These assert on the REAL serializers, not on fixtures. A test that hard-codes
 * the expected JSON would pass against a state.ts that had drifted; this one
 * fails the moment a number comes back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildState, stateBytes, positionVsEntry, holdBucket } from "../src/jev/state.ts";
import { QUESTIONS } from "../src/jev/questions.ts";
import { JevClient, parseAnswers, holdAnswer } from "../src/jev/client.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { computeFeatures, type Features } from "../src/features/compute.ts";
import { makeSleeve } from "../src/loop/tick.ts";
import { ERA_FILES, computeEra, repoRoot } from "../src/measure/era.ts";
import type { BookState, PnlSnapshot, Sleeve } from "../src/store/types.ts";

const book = (): BookState => ({
  instId: "BTC-USDT-SWAP",
  bids: [{ px: 79999.9, sz: 3 }, { px: 79999.8, sz: 2 }],
  asks: [{ px: 80000.1, sz: 2 }, { px: 80000.2, sz: 3 }],
  ts: Date.now(),
  synced: true,
});

const PNL = (o: Partial<PnlSnapshot> = {}): PnlSnapshot => ({
  realizedUsd: 1234.5, unrealizedUsd: -987.65, dailyPnlUsd: 246.8,
  dailyLossUsedFrac: 0.42, grossUsd: 500_000, ...o,
});

const ENV = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MODE: "mock", MODEL: "jev", TYPESAFE_API_KEY: "k", ...o,
});

/** A sleeve with a real open position, so the position buckets are exercised. */
function openSleeve(side: "long" | "short", entryPx: number, openedMinutesAgo: number): Sleeve {
  const s = makeSleeve("btc1", "BTC-USDT-SWAP", "bot1");
  s.position = {
    ...s.position,
    side,
    szContracts: 3,
    entryPx,
    markPx: entryPx,
    notionalUsd: 240,
    unrealizedPnlUsd: -12.5,
    openedAt: Date.now() - openedMinutesAgo * 60_000,
  };
  return s;
}

/** Walk the parsed state and collect every leaf that is a number, by path. */
function numberPaths(v: unknown, path = "$"): string[] {
  if (typeof v === "number") return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => numberPaths(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .flatMap(([k, x]) => numberPaths(x, `${path}.${k}`));
  }
  return [];
}

/** Every string leaf of the state, with the path it was found at. */
function stringPaths(v: unknown, path = "$"): Array<{ path: string; text: string }> {
  if (typeof v === "string") return [{ path, text: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringPaths(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .flatMap(([k, x]) => stringPaths(x, `${path}.${k}`));
  }
  return [];
}

function stateFor(sleeve: Sleeve, features: Features, now = Date.now()): string {
  return buildState({ sleeve, features, pnl: PNL(), mode: "mock", now });
}

// ------------------------------------------------------- claim 1: no numbers

test("the state sent to the model contains no digit-valued field", () => {
  // A populated position, a working order, a full PnL snapshot - the shape most
  // likely to leak a magnitude - and the old `numbers` block that used to carry
  // sixteen of them is not there to be checked by name.
  const s = openSleeve("long", 80100, 90);
  s.workingOrder = { clOrdId: "c1", ordId: "o1", side: "sell", px: 80110, sz: 2, ts: Date.now(), reduceOnly: true };
  const f = computeFeatures(s, { book: book(), fundingRate: 0.0001, nextFundingHours: 3, oiChange1hPct: 4.2, tickSz: 0.1 })!;
  const state = stateFor(s, f);

  const parsed = JSON.parse(state) as Record<string, unknown>;
  const nums = numberPaths(parsed);
  assert.deepEqual(nums, [], `numeric fields reached the model: ${nums.join(", ")}`);

  // A magnitude smuggled in as a STRING ("spread 0.8bps") would satisfy the
  // check above, so every string value is checked too. The timestamp is the one
  // field that legitimately carries digits, so it is excluded by value rather
  // than by excusing the whole assertion. Field NAMES are not checked:
  // `momentum_5m` and `price_in_1h_range` name a horizon, not a quantity, and
  // the criteria text refers to those names.
  const smuggled = stringPaths(parsed)
    .filter((s) => s.path !== "$.as_of_utc")
    .filter((s) => /\d/.test(s.text))
    .map((s) => `${s.path}="${s.text}"`);
  assert.deepEqual(smuggled, [], `digit-valued strings reached the model: ${smuggled.join(", ")}`);
});

test("the deleted desk_context fields are gone, and the new buckets are present", () => {
  const s = openSleeve("short", 79900, 3);
  const f = computeFeatures(s, { book: book(), fundingRate: null, nextFundingHours: null, oiChange1hPct: null, tickSz: 0.1 })!;
  const parsed = JSON.parse(stateFor(s, f)) as {
    desk_context: Record<string, unknown>;
    numbers?: unknown;
  };

  assert.equal(parsed.numbers, undefined, "the numbers block must be deleted, not emptied");
  for (const gone of [
    "position_size_usd", "unrealized_pnl_usd", "entry_vs_mid_bps", "position_hold_minutes",
    "daily_pnl_usd", "gross_exposure_usd", "open_interest",
  ]) {
    assert.equal(gone in parsed.desk_context, false, `${gone} must not be in the request`);
  }
  assert.deepEqual(
    Object.keys(parsed.desk_context).sort(),
    ["daily_loss_budget_used", "hold", "mode", "open_order", "position_side", "position_vs_entry"],
    "desk_context carries exactly the words it is allowed to carry",
  );
  assert.equal(parsed.desk_context.position_side, "short");
});

test("position_vs_entry is a bucket, and it is right for a long and a short", () => {
  const now = Date.now();
  const mid = 80_000;
  const pos = (side: "flat" | "long" | "short", entryPx: number) => ({
    instId: "BTC-USDT-SWAP", side, szContracts: 1, entryPx, markPx: mid, notionalUsd: 1,
    unrealizedPnlUsd: 0, openedAt: now - 60_000, leverage: 1, liqPx: null,
  });

  assert.equal(positionVsEntry(pos("flat", 0), mid), "flat", "no position is flat");
  assert.equal(positionVsEntry(pos("long", 79_000), mid), "in_profit", "a long above entry");
  assert.equal(positionVsEntry(pos("long", 81_000), mid), "losing", "a long below entry");
  assert.equal(positionVsEntry(pos("short", 79_000), mid), "losing", "a short below entry profits, so it is losing");
  assert.equal(positionVsEntry(pos("short", 81_000), mid), "in_profit", "a short above entry profits");
  // A 1bp move is inside the band: at this size it is tick noise, not a profit.
  assert.equal(positionVsEntry(pos("long", 80_000 * 0.9999), mid), "flat", "a sub-band move is flat, not a profit");
});

test("hold is a bucket, and it says flat when there is no position", () => {
  const now = Date.now();
  const p = (openedAt: number | null) => ({
    instId: "BTC-USDT-SWAP", side: openedAt ? "long" as const : "flat" as const,
    szContracts: openedAt ? 1 : 0, entryPx: 80_000, markPx: 80_000, notionalUsd: 1,
    unrealizedPnlUsd: 0, openedAt, leverage: 1, liqPx: null,
  });
  assert.equal(holdBucket(p(null), now), "flat");
  assert.equal(holdBucket(p(now - 60_000), now), "just_opened", "a minute old");
  assert.equal(holdBucket(p(now - 45 * 60_000), now), "session", "45 minutes is a session position");
});

test("the ledger still keeps every number: the request is narrowed, the record is not", () => {
  // The reason the state can drop magnitudes without losing anything. This is
  // the claim the safety of claim 1 rests on, so it is asserted rather than
  // assumed: if a future refactor ever stopped writing raw features, the model
  // would be flying blind with no way to re-derive what it saw.
  const tick = readFileSync(join(repoRoot(), "src", "loop", "tick.ts"), "utf8");
  assert.match(tick, /recordFeatures\(/, "every tick must still write the full feature row");
  const f = computeFeatures(openSleeve("long", 80_000, 5), {
    book: book(), fundingRate: 1e-5, nextFundingHours: 2, oiChange1hPct: 0.5, tickSz: 0.1,
  })!;
  assert.equal(typeof f.mid, "number", "the Features object keeps the numbers");
  assert.equal(typeof f.spreadBps, "number", "including the bps the request no longer shows");
  assert.equal(typeof f.bookImbalance, "number", "and the signed ratio behind the imbalance bucket");
  // A field that is genuinely null here is still raw data, not a number: the
  // ledger stores null and the measurement code can re-bucket it later. Assert
  // that the null is preserved rather than quietly zero-filled.
  assert.equal(f.realizedVol15m, null, "no candles means null, not a fabricated zero");
  const withCandles = openSleeve("long", 80_000, 5);
  const base = Date.now() - 20 * 60_000;
  for (let k = 0; k < 20; k++) {
    withCandles.candles1m.push({ ts: base + k * 60_000, o: 80_000, h: 80_050, l: 79_950, c: 80_000 + k * 3, v: 1 });
  }
  const fc = computeFeatures(withCandles, { book: book(), fundingRate: 1e-5, nextFundingHours: 2, oiChange1hPct: 0.5, tickSz: 0.1 })!;
  assert.equal(typeof fc.realizedVol15m, "number", "and the raw volatility once it exists");
  const s = openSleeve("long", 80_000, 5);
  assert.equal(typeof s.position.unrealizedPnlUsd, "number", "the PnL is still on the sleeve");
  assert.equal(typeof s.position.notionalUsd, "number", "and so is the size");
  assert.equal(typeof PNL().dailyPnlUsd, "number", "and the daily PnL in the snapshot");
});

test("state is still under the 4KB cap with the numbers gone", () => {
  const s = openSleeve("long", 80_100, 60);
  s.workingOrder = { clOrdId: "c1", ordId: "o1", side: "buy", px: 80_000, sz: 1, ts: Date.now(), reduceOnly: false };
  const f = computeFeatures(s, { book: book(), fundingRate: 1e-5, nextFundingHours: 2, oiChange1hPct: 1, tickSz: 0.1 })!;
  assert.ok(stateBytes(stateFor(s, f)) < 4096);
});

// ---------------------------------------- claim 2: criteria must not answer

/** Every string anywhere in the question set, with the path it was found at. */
function criteriaStrings(node: unknown, path = "$"): Array<{ path: string; text: string }> {
  if (typeof node === "string") return [{ path, text: node }];
  if (Array.isArray(node)) return node.flatMap((x, i) => criteriaStrings(x, `${path}[${i}]`));
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>)
      .flatMap(([k, v]) => criteriaStrings(v, `${path}.${k}`));
  }
  return [];
}

const FORBIDDEN_IN_CRITERIA = ["buy_heavy", "sell_heavy", "buy_lean", "sell_lean",
  "momentum says", "strong_buying", "strong_selling", "very_toxic", "flow_quality"];

test("no criterion quotes the state that should produce it", () => {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const crit = (q as { criteria: unknown }).criteria;
    for (const { path, text } of criteriaStrings(crit)) {
      for (const bad of FORBIDDEN_IN_CRITERIA) {
        assert.equal(
          text.includes(bad),
          false,
          `${id} ${path} names the state it should be judging ("${bad}"): ${text}`,
        );
      }
    }
  }
});

test("no criterion carries an examples array, and none is a bare negation of a sibling", () => {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const crit = (q as { criteria: unknown }).criteria;
    if (Array.isArray(crit)) continue; // score rubrics are ordered levels
    for (const [opt, body] of Object.entries(crit as Record<string, unknown>)) {
      assert.equal(
        typeof (body as { examples?: unknown })?.examples,
        "undefined",
        `${id}.${opt} has an examples array; examples that quote bucket values are a lookup table`,
      );
      assert.equal(
        typeof (body as { not_for?: unknown })?.not_for,
        "undefined",
        `${id}.${opt} has a not_for line; a bare "not the other option" degrades the answer`,
      );
    }
  }
});

test("every choice option still has a what, and says what it means", () => {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    if (q.type !== "choice") continue;
    for (const [opt, body] of Object.entries((q as { criteria: Record<string, unknown> }).criteria)) {
      const what = (body as { what?: unknown }).what;
      assert.equal(typeof what, "string", `${id}.${opt} must describe what it means`);
      assert.ok((what as string).length > 25, `${id}.${opt} needs a real description, not a label`);
    }
  }
});

// ------------------------------------- claim 3: only Choice probabilities

test("the question set contains no noul", () => {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    assert.notEqual(q.type, "noul", `${id} is a noul; only Choice probabilities may be thresholded`);
  }
  assert.equal("buyers_in_control" in QUESTIONS, false, "buyers_in_control must be deleted");
  // And the answer type has no noul field left to carry one.
  assert.equal("buyersInControl" in holdAnswer("x"), false, "no noul survives in the answer shape");
  const src = readFileSync(join(repoRoot(), "src", "store", "types.ts"), "utf8");
  assert.doesNotMatch(src, /buyersInControl/, "the persisted answer type must not keep a noul field");
});

test("the POST body has no `reasoning` key, and exactly model/state/questions", async () => {
  let body: Record<string, unknown> | null = null;
  const cfg = loadConfig(ENV()) as Config;
  const client = new JevClient(cfg, (async (_u: string, init: { body?: string }) => {
    body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        direction: { type: "choice", choice: "long", confidence: 0.6, probabilities: { long: 0.6, short: 0.2, flat: 0.2 } },
        action: { type: "choice", choice: "hold", confidence: 0.5, probabilities: { open: 0.1, add: 0.1, hold: 0.6, reduce: 0.1, close: 0.1 } },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch);

  const s = makeSleeve("btc1", "BTC-USDT-SWAP", "bot1");
  const f = computeFeatures(s, { book: book(), fundingRate: null, nextFundingHours: null, oiChange1hPct: null, tickSz: 0.1 })!;
  const a = await client.ask("btc1", stateFor(s, f), f);

  assert.equal(a.error, undefined, "the stub response must parse cleanly");
  const sent = body as unknown as Record<string, unknown>;
  assert.equal("reasoning" in sent, false, "the request must not set a reasoning parameter");
  assert.deepEqual(
    Object.keys(sent).sort(),
    ["model", "questions", "state"],
    "the request body is model/state/questions and nothing else",
  );
  assert.doesNotMatch(
    JSON.stringify(sent).toLowerCase(),
    /"reasoning"|"temperature"|"top_p"|"effort"|"thinking"/,
    "no sampling or reasoning knob may appear anywhere in the request",
  );
  // The noul is gone from the wire, not just from the TypeScript type.
  assert.equal(JSON.stringify(sent).includes("buyers_in_control"), false);
});

test("the gate quantities are Choice probabilities and confidence, read as separate things", () => {
  // A response carrying a stale noul must not resurrect the field, and must not
  // fail either: an answer we did not ask for is ignored, not fatal.
  const a = parseAnswers({
    model: "jev-1.13.0",
    answers: {
      direction: { type: "choice", choice: "long", confidence: 0.62, probabilities: { long: 0.62, short: 0.2, flat: 0.18 } },
      action: { type: "choice", choice: "hold", confidence: 0.5, probabilities: { open: 0.1, add: 0.1, hold: 0.6, reduce: 0.1, close: 0.1 } },
      buyers_in_control: { type: "noul", noul: 0.99 },
    } as never,
    usage: { input_tokens: 1, output_tokens: 1 },
  }, 10);
  assert.equal(a.directionConfidence, 0.62, "confidence is its own field");
  assert.equal(a.directionProbs.long, 0.62, "P is the Choice's probabilities, a different quantity");
  assert.equal("buyersInControl" in a, false, "an unasked noul is ignored, not stored");
});

// ------------------------------------------------ claim 4: one fact per answer

/** The market fields each question's text is allowed to reason about. */
const ALLOWED_INPUTS: Record<string, string[]> = {
  entry_quality: ["spread", "range", "extended", "mid", "price", "passive", "order", "extreme"],
  dump_risk: ["volatil", "toxic", "flow", "adverse", "sharp", "calm", "clean", "15 minutes"],
  action: ["position", "profit", "entry", "keeping", "flat", "long", "short"],
};

test("entry_quality reads the spread and extension only - not flow or volatility", () => {
  const text = criteriaStrings(QUESTIONS.entry_quality!.criteria).map((s) => s.text).join(" ").toLowerCase();
  assert.doesNotMatch(text, /toxic|flow_quality|trade flow|book leans|imbalanc/,
    "entry_quality must not mention flow or the book lean");
  assert.doesNotMatch(text, /volatil/, "entry_quality must not mention volatility");
  assert.doesNotMatch(text, /intended direction|which way/, "entry_quality must not reference direction");
  assert.match(text, /spread/, "it is still about the spread");
  assert.match(text, /range/, "it is still about whether price is extended");
});

test("dump_risk reads volatility and flow toxicity only - not spread or range", () => {
  const text = criteriaStrings(QUESTIONS.dump_risk!.criteria).map((s) => s.text).join(" ").toLowerCase();
  assert.doesNotMatch(text, /spread/, "dump_risk must not mention the spread");
  assert.doesNotMatch(text, /range/, "dump_risk must not mention price in range");
  assert.match(text, /volatil/, "it is still about volatility");
  assert.match(text, /toxic|flow/, "it is still about whether the flow is toxic");
});

test("reduce and close do not refer to an answer that is not in the state", () => {
  const crit = (QUESTIONS.action as { criteria: Record<string, { what: string }> }).criteria;
  // The old wording said "the adverse-move risk question answers high", which
  // asks the model to consult an answer it has not been given.
  for (const opt of ["reduce", "close"]) {
    const what = crit[opt]!.what.toLowerCase();
    assert.doesNotMatch(what, /risk question|dump|adverse-move question|answers high/,
      `${opt} must not refer to another question's answer`);
    assert.match(what, /behind its entry/, `${opt} must be decidable from position_vs_entry alone`);
  }
  for (const opt of ["open", "add", "hold"]) {
    assert.doesNotMatch(
      crit[opt]!.what.toLowerCase(),
      /book has turned|turns against|adverse/,
      `${opt} must not require reading the market again`,
    );
  }
});

test("action is decidable from the two inventory words the state actually sends", () => {
  const s = makeSleeve("btc1", "BTC-USDT-SWAP", "bot1");
  const f = computeFeatures(s, { book: book(), fundingRate: null, nextFundingHours: null, oiChange1hPct: null, tickSz: 0.1 })!;
  const parsed = JSON.parse(stateFor(s, f)) as { desk_context: Record<string, string> };
  const instruction = JSON.stringify((QUESTIONS.action as { instructions: unknown }).instructions).toLowerCase();
  for (const field of ["position_side", "position_vs_entry"]) {
    assert.ok(field in parsed.desk_context, `the state must carry ${field}`);
    assert.ok(instruction.includes(field), `the action instruction must name ${field}`);
  }
  // And it must not depend on a field the state dropped.
  for (const gone of ["entry_vs_mid_bps", "unrealized_pnl_usd", "position_size_usd"]) {
    assert.equal(instruction.includes(gone), false, `action must not need ${gone}`);
  }
});

// ------------------------------------------------------------------- era

test("src/jev/state.ts is an era file, so editing the view starts a new era", () => {
  assert.ok(ERA_FILES.includes("src/jev/state.ts" as never),
    "state.ts must be in ERA_FILES: what the model sees is part of what a row means");
  // And it must be a file that exists, or the era would be computed over an
  // absent file and report missing forever.
  const d = computeEra(repoRoot());
  assert.equal(d.missing.length, 0, `era files missing on disk: ${d.missing.join(", ")}`);
  assert.ok(d.files["src/jev/state.ts"], "state.ts must contribute a hash");
});

test("the four questions are what the desk sends", () => {
  assert.deepEqual(Object.keys(QUESTIONS).sort(), ["action", "direction", "dump_risk", "entry_quality"]);
  // The types must still line up with what the parser and the gates read.
  assert.equal(QUESTIONS.entry_quality!.criteria.length, 5, "entry_quality keeps its 5 ordered levels");
  assert.equal(QUESTIONS.dump_risk!.criteria.length, 4, "dump_risk keeps its 4 ordered levels");
});
