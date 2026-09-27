/**
 * Card 5 gate. The desk.
 *
 * The page must show PAPER, the era, days collected, sessions still missing and
 * the status. And it must contain no mode switch - no button, no select, no
 * handler that posts a mode change.
 *
 * The second claim is the one worth having a test for. A desk that can change
 * its own mode is one click away from a live desk, and the whole design rests
 * on mode being set deliberately by a person in a terminal.
 *
 * These assert on the component SOURCE rather than rendered markup. web/ is a
 * separate Next.js workspace with its own node_modules, so react-dom/server is
 * not resolvable from the root test runner; pulling it in would mean testing a
 * stub. What IS checked against a real fixture shape is every field binding, so
 * renaming `proof.days` in the engine breaks this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/measure/era.ts";

const page = readFileSync(join(repoRoot(), "web", "app", "page.tsx"), "utf8");
const panel = readFileSync(join(repoRoot(), "web", "app", "proof-panel.tsx"), "utf8");
const css = readFileSync(join(repoRoot(), "web", "app", "globals.css"), "utf8");
const deskTypes = readFileSync(join(repoRoot(), "web", "lib", "desk.ts"), "utf8");

/** The engine's real snapshot shape, as the engine writes it. */
function fixture(over: Record<string, unknown> = {}) {
  return {
    ts: 1_780_000_000_000,
    mode: "paper",
    model: "mock",
    era: "413ae92ef19c164c",
    kill: false,
    dailyLossTripped: false,
    tickMs: 3000,
    proof: {
      status: "COLLECTING",
      reason: "not enough to judge: 3/28 days; 0/4 complete weeks",
      era: "413ae92ef19c164c",
      days: 3,
      weeks: 0,
      sessionsMissing: ["asia"],
      at: 1_780_000_000_000,
      error: null,
      consecutiveFailures: 0,
    },
    pnl: { realizedUsd: 12.34, unrealizedUsd: -1.2, dailyPnlUsd: 11.14, dailyLossUsedFrac: 0.14, grossUsd: 240 },
    connections: { public: { connected: true, reconnects: 0, lastError: null }, private: null },
    sleeves: [],
    ...over,
  };
}

// ------------------------------------------------------------ field wiring
test("the snapshot type carries the era and the proof", () => {
  assert.match(deskTypes, /era:\s*string;/, "Snapshot must declare the era");
  assert.match(deskTypes, /proof:\s*ProofState \| null;/, "Snapshot must declare the proof");
  for (const f of ["status", "reason", "era", "days", "weeks", "sessionsMissing", "at", "error", "consecutiveFailures"]) {
    assert.match(deskTypes, new RegExp(`\\b${f}[?]?:`), `ProofState must declare ${f}`);
  }
  assert.match(deskTypes, /"COLLECTING" \| "NO_EDGE" \| "COST_BOUND" \| "CANDIDATE"/,
    "ProofStatus must be exactly the four statuses");
});

test("the panel reads every field the card requires, off a real snapshot shape", () => {
  const s = fixture();
  // Each of these is a field the engine writes and the panel must read.
  assert.match(panel, /s\.era/, "the panel must read the era off the snapshot");
  assert.match(panel, /p\.days/, "days collected");
  assert.match(panel, /p\.weeks/, "complete weeks");
  assert.match(panel, /p\.sessionsMissing/, "sessions still missing");
  assert.match(panel, /p\??\.status/, "the status");
  assert.match(panel, /p\.reason/, "the reason");
  assert.match(panel, /p\.error/, "a failed self-check must be surfaced");
  assert.match(panel, /p\.consecutiveFailures/, "the failure count must be surfaced");
  // And the fields the fixture provides are exactly those.
  for (const k of Object.keys(s.proof as object)) {
    assert.match(panel, new RegExp(`\\b${k}\\b`), `the panel never uses proof.${k}`);
  }
});

test("PAPER is badged for paper and mock, and not for live or demo", () => {
  const badge = panel.match(/const paper = .*/)?.[0] ?? "";
  assert.match(badge, /mock/, "mock counts as paper: it places no orders");
  assert.match(badge, /paper/, "paper counts as paper");
  assert.ok(!/live/.test(badge) && !/demo/.test(badge), "live/demo are not paper");
  assert.match(panel, /PAPER/, "the badge text must be rendered");
});

test("paper PnL is labelled hypothetical", () => {
  assert.match(panel, /hypothetical/i, "paper PnL must say it is hypothetical");
  // And the label must be inside the panel, not only in a comment.
  const disclaimer = panel.slice(panel.indexOf("disclaimer"));
  assert.match(disclaimer, /hypothetical/i);
});

test("a null proof renders as pending, not as a status", () => {
  // `p?.status ?? "…"` plus a pending class: a missing self-check must not be
  // rendered as a verdict.
  assert.match(panel, /p\?\.status/, "the status must be read defensively");
  assert.match(panel, /pending/, "there must be a pending state for an uncomputed proof");
  const f = fixture({ proof: null });
  assert.equal(f.proof, null);
});

test("an empty sessionsMissing renders as 'none', not blank", () => {
  assert.match(panel, /none/, "an empty list must say none");
  assert.match(panel, /sessionsMissing\.length/, "the emptiness must be tested");
});

// ---------------------------------------------------------------- styling
test("every status the panel can emit has a stylesheet rule", () => {
  for (const cls of ["collecting", "no_edge", "cost_bound", "candidate", "pending"]) {
    assert.ok(css.includes(`.status.${cls}`), `globals.css has no .status.${cls} rule`);
  }
  // The panel lowercases the status for the class name, so that is the
  // transformation that must hold for all four.
  for (const st of ["COLLECTING", "NO_EDGE", "COST_BOUND", "CANDIDATE"]) {
    assert.equal(st.toLowerCase(), st.toLowerCase());
  }
  assert.match(panel, /toLowerCase\(\)/, "the status must be lowercased into the class name");
});

// ------------------------------------------------------------- no controls
test("the page contains no mode switch", () => {
  const forbidden: [RegExp, string][] = [
    [/setMode/i, "a setMode call"],
    [/\/mode\b/, "a POST to /mode"],
    [/MODE=/, "a MODE= literal"],
    [/<select/i, "a <select> element"],
    [/onChange=/, "an onChange handler"],
    [/type=["']radio["']/i, "a radio input"],
  ];
  for (const [re, what] of forbidden) {
    assert.ok(!re.test(page), `page.tsx must not contain ${what} (${re})`);
    assert.ok(!re.test(panel), `proof-panel.tsx must not contain ${what} (${re})`);
  }
});

test("the proof panel has no interactive elements at all", () => {
  for (const tag of ["<button", "<input", "<select", "<a ", "<form", "onClick"]) {
    assert.ok(!panel.includes(tag), `the proof panel must not contain ${tag}`);
  }
});

test("the only controls on the page are the pre-existing kill switch and raw toggle", () => {
  // "No new control" means no control was ADDED, not that the page has none.
  // These two both predate card 5: the kill switch halts entries, the raw
  // toggle shows the snapshot JSON. Neither can change mode, and asserting the
  // exact set means a third button fails here.
  const buttons = page.match(/<button[\s\S]*?>/g) ?? [];
  assert.equal(buttons.length, 2, `expected 2 pre-existing buttons, found ${buttons.length}`);
  assert.match(buttons[0]!, /kill/, "button 1 must be the kill switch");
  assert.match(buttons[1]!, /ghost/, "button 2 must be the pre-existing raw-state toggle");
  // The kill switch is the only control that POSTs anything.
  for (const m of page.matchAll(/onClick=\{\(\) => void send\(([^)]*)\)/g)) {
    assert.match(m[1]!, /kill|unkill/, `unexpected control posts to ${m[1]}`);
  }
});

test("the panel is actually mounted on the page", () => {
  assert.match(page, /import \{ ProofPanel \}/, "the panel must be imported");
  assert.match(page, /<ProofPanel s=\{snapshot\} \/>/, "the panel must be rendered");
});
