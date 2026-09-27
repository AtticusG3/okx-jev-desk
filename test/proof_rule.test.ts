/**
 * Card 2 gate. The frozen bar.
 *
 * Two claims:
 *   1. The loader's constants equal the file. Not "the loader returns
 *      something plausible" — the specific numbers, checked against the text
 *      of docs/PROOF_RULE.md.
 *   2. A one-line edit of the file changes the era hash.
 *
 * The failure this guards against is a harness that quietly enforces a bar
 * different from the one written down. That is the same class of bug as the
 * uncorrected Bonferroni interval: a check that looks like it is doing the work
 * and is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadProofRule, describeRule, ProofRuleError, PROOF_RULE_PATH } from "../src/measure/proof_rule.ts";
import { computeEra, eraHash, sizingFingerprint, ERA_FILES } from "../src/measure/era.ts";
import { repoRoot } from "../src/measure/era.ts";

const RISK = {
  quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
  maxAddsPerSleeve: 2, maxOrdersPerMin: 20, maxSpreadBps: 25,
};

const realPath = join(repoRoot(), PROOF_RULE_PATH);

// ------------------------------------------------------- 1. loader == file
test("the loader's constants are the numbers written in the file", () => {
  assert.ok(existsSync(realPath), "PROOF_RULE.md must exist");
  const md = readFileSync(realPath, "utf8");
  const r = loadProofRule(realPath);

  // Each of these is asserted against the literal text, so an edit to the file
  // that the loader fails to pick up fails HERE rather than at proof time.
  assert.match(md, /\|\s*1\s*\|[^|]*Calendar days[^|]*\|\s*\*\*28\*\*/, "row 1 must say 28 days");
  assert.equal(r.minCalendarDays, 28);

  assert.match(md, /^\|\s*2\s*\|.*\*\*every one of the 4\*\*/m, "row 2 must say 4 weeks");
  assert.equal(r.minWeeks, 4);
  // Row 3 is read, not assumed: if the file changed which session is required,
  // the loader must follow.
  const row3 = md.split("\n").find((l) => /^\|\s*3\s*\|/.test(l))!;
  assert.match(row3, /US session present/, "row 3 must require the US session");
  assert.deepEqual(r.requiredSessions, ["asia", "us"]);
  assert.ok(!r.requiredSessions.includes("europe"), "Europe is collected but is not on the critical path");

  assert.equal(r.requiredModel, "jev");
  assert.deepEqual(r.vrHorizonsMin, [5, 15], "variance ratio must be judged at 5m and 15m");
  assert.equal(r.maxPAdj, 0.05);
  assert.equal(r.makerFeeBps, 2);
  assert.equal(r.takerFeeBps, 5);
  assert.deepEqual(r.markoutSeconds, [1, 10, 60]);
  assert.equal(r.minNetBps, 0);
});

test("the loader refuses a missing or unparseable bar rather than defaulting", () => {
  // A default would be a bar nobody wrote, silently enforced. Hard error only.
  assert.throws(() => loadProofRule(join(tmpdir(), "definitely-not-here.md")), ProofRuleError);

  const dir = mkdtempSync(join(tmpdir(), "okx-rule-"));
  try {
    const p = join(dir, "PROOF_RULE.md");
    writeFileSync(p, "# nothing useful here\n");
    assert.throws(() => loadProofRule(p), ProofRuleError, "a bar with no table must not parse");

    // A table that is missing the pinned-model requirement is a LOOSENED bar.
    const real = readFileSync(realPath, "utf8");
    writeFileSync(p, real.replace(/pinned/g, "some"));
    assert.throws(() => loadProofRule(p), ProofRuleError, "dropping 'pinned' must fail, not silently pass");

    // Dropping the Bonferroni row must fail rather than default to 0.05.
    writeFileSync(
      p,
      real.split("\n").filter((l) => !/Bonferroni/.test(l)).join("\n"),
    );
    assert.throws(() => loadProofRule(p), ProofRuleError, "a missing p_adj row must not default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("describeRule states every requirement, so the CLI cannot under-report", () => {
  const d = describeRule(loadProofRule(realPath));
  for (const frag of ["28d", "asia+us", "4 weeks", "jev", "5m,15m", "p_adj<0.05", "2+5", "1s/10s/60s"]) {
    assert.ok(d.includes(frag), `summary is missing '${frag}': ${d}`);
  }
});

// ------------------------------------------------- 2. edit changes the era
/** A complete fake repo, with the real PROOF_RULE.md copied in. */
function repoWithRule(rule: string): string {
  const root = mkdtempSync(join(tmpdir(), "okx-rule-era-"));
  for (const rel of ERA_FILES) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, rel === PROOF_RULE_PATH ? rule : `// ${rel}\n`);
  }
  return root;
}

test("a one-line edit of PROOF_RULE.md changes the era hash", () => {
  const base = readFileSync(realPath, "utf8");
  const rootA = repoWithRule(base);
  const rootB = repoWithRule(base);
  try {
    const hashA = eraHash(computeEra(rootA), sizingFingerprint(RISK));

    // One line. Make the bar stricter, which is the direction that matters:
    // loosening it must be just as visible as tightening it.
    const edited = base.replace("| **28** |", "| **29** |");
    assert.notEqual(edited, base, "the fixture edit must actually change the file");
    writeFileSync(join(rootB, PROOF_RULE_PATH), edited);

    const hashB = eraHash(computeEra(rootB), sizingFingerprint(RISK));
    assert.notEqual(hashA, hashB, "editing PROOF_RULE.md must start a new era");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("the era hash is stable when nothing changes", () => {
  const base = readFileSync(realPath, "utf8");
  const a = repoWithRule(base);
  const b = repoWithRule(base);
  try {
    const ha = eraHash(computeEra(a), sizingFingerprint(RISK));
    const hb = eraHash(computeEra(b), sizingFingerprint(RISK));
    assert.equal(ha, hb, "identical trees must hash identically, or every restart looks like a new era");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("loosening the bar is as visible as tightening it", () => {
  // A one-sided check is a check that will eventually be made one-sided in the
  // convenient direction.
  const base = readFileSync(realPath, "utf8");
  const rootA = repoWithRule(base);
  try {
    const h = eraHash(computeEra(rootA), sizingFingerprint(RISK));
    const looser = repoWithRule(base.replace("| **28** |", "| **7** |"));
    try {
      assert.notEqual(eraHash(computeEra(looser), sizingFingerprint(RISK)), h,
        "shortening the bar to 7 days must also start a new era");
    } finally { rmSync(looser, { recursive: true, force: true }); }
  } finally { rmSync(rootA, { recursive: true, force: true }); }
});

test("the real repo now has every era file, so the era is complete", () => {
  // PROOF_RULE.md existing means the era is no longer reported missing. This
  // is the handoff from card 1 to card 2, and it should be visible.
  const d = computeEra(repoRoot());
  assert.deepEqual(d.missing, [], `era files still missing: ${d.missing.join(", ")}`);
});
