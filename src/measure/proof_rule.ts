/**
 * Loader for docs/PROOF_RULE.md.
 *
 * The bar lives in that file because the file is the thing a person edits and
 * the thing worth reading. This module's job is to make it impossible for the
 * two to disagree: it PARSES the values out of the markdown rather than
 * restating them, so there is exactly one place a number can live. A test
 * asserts the parsed values against the file text.
 *
 * Parsed, not hand-copied, also means a malformed edit fails loudly. A missing
 * or unparseable bar is a hard error, never a silent default — the alternative
 * is a proof that quietly measures against a bar nobody wrote.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./era.ts";

export const PROOF_RULE_PATH = "docs/PROOF_RULE.md";

export class ProofRuleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProofRuleError";
  }
}

export interface ProofRule {
  /** Calendar days in one era. */
  minCalendarDays: number;
  /** Whole weeks that must contain each required session. */
  minWeeks: number;
  /** Sessions that must each appear in every one of those weeks. */
  requiredSessions: string[];
  /** The model that counts as evidence. */
  requiredModel: "jev";
  /** Horizons, in minutes, at which the variance ratio must reject. */
  vrHorizonsMin: number[];
  /** Bonferroni-adjusted p must be below this. */
  maxPAdj: number;
  /** Fees, in bps, per side. */
  makerFeeBps: number;
  takerFeeBps: number;
  /** Markout horizons, in seconds, for the adverse-selection estimate. */
  markoutSeconds: number[];
  /** Net bps after all of the above must exceed this. */
  minNetBps: number;
}

/**
 * Every number in the cell of row `rowN` that mentions `label`.
 *
 * Deliberately tolerant of prose around the number: row 2 reads "every one of
 * the 4", not "4". A parser that only accepts a bare leading integer would
 * reject the file as written, and the tempting fix — loosening it until it
 * accepts anything — is how a parser ends up inventing a value. Instead: take
 * the numbers that are there, and require exactly as many as the caller is
 * about to destructure.
 */
function numsFromRowN(md: string, rowN: number, label: string, expected: number, what: string): number[] {
  const line = md.split("\n").find((l) => new RegExp(`^\\|\\s*${rowN}\\s*\\|`).test(l));
  if (!line) throw new ProofRuleError(`PROOF_RULE.md: row ${rowN} (${what}) is missing`);
  if (!line.toLowerCase().includes(label.toLowerCase())) {
    throw new ProofRuleError(`PROOF_RULE.md: row ${rowN} should mention '${label}'`);
  }
  const cell = line.split("|")[3] ?? "";
  const nums = (cell.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []).map(Number);
  if (nums.length !== expected) {
    throw new ProofRuleError(
      `PROOF_RULE.md: row ${rowN} (${what}) should state ${expected} number(s), found ${nums.length} in "${cell.trim()}"`,
    );
  }
  return nums;
}

/** Exactly one number from row `rowN`, which must mention `label`. */
function numFromRowN(md: string, rowN: number, label: string, what: string): number {
  return numsFromRowN(md, rowN, label, 1, what)[0]!;
}

/** All the numbers in a row that mentions `label`, e.g. "2 + 5" -> [2,5]. */
function numsFromRow(md: string, label: string, what: string): number[] {
  const line = md.split("\n").find((l) => /^\|\s*\d+\s*\|/.test(l) && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new ProofRuleError(`PROOF_RULE.md: no row mentioning '${label}' (${what})`);
  const cells = line.split("|").map((c) => c.trim());
  const cell = cells.find((c) => c.toLowerCase().includes(label.toLowerCase())) ?? "";
  const nums = (cell.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []).map(Number);
  if (nums.length === 0) {
    throw new ProofRuleError(`PROOF_RULE.md: row '${label}' (${what}) has no numbers`);
  }
  return nums;
}

export function loadProofRule(path: string = join(repoRoot(), PROOF_RULE_PATH)): ProofRule {
  if (!existsSync(path)) {
    throw new ProofRuleError(
      `PROOF_RULE.md is missing at ${path}. The bar is not optional and has no default; ` +
        `restore the file rather than letting the proof measure against a bar nobody wrote.`,
    );
  }
  const md = readFileSync(path, "utf8");

  // Row 4 states the model and that the id must be pinned. Require the literal
  // words: "pinned" is the operative constraint and a future edit that drops
  // it should fail here rather than quietly loosen the bar.
  const modelRow = md.split("\n").find((l) => /^\|\s*4\s*\|/.test(l));
  if (!modelRow) throw new ProofRuleError("PROOF_RULE.md: the model row (row 4) is missing");
  if (!/\*\*`jev`\*\*/.test(modelRow)) {
    throw new ProofRuleError("PROOF_RULE.md: row 4 must require MODEL=`jev`");
  }
  if (!/pinned/i.test(modelRow)) {
    throw new ProofRuleError("PROOF_RULE.md: row 4 must require a PINNED model id (jev-latest is not evidence)");
  }

  const minDays = numFromRowN(md, 1, "Calendar days", "days collected");
  const weeks = numFromRowN(md, 2, "session present", "required session count");
  // Row 3 names the other required session. Read it rather than assuming
  // symmetry, so the file stays the single source of truth.
  const usRow = md.split("\n").find((l) => /^\|\s*3\s*\|/.test(l)) ?? "";
  // The session name is written in the LABEL, not the value cell:
  // "| 3 | US session present each of those weeks | **every one of the 4** |".
  const usMatch = usRow.match(/\|\s*3\s*\|\s*([A-Za-z]+)\s+session present/i);
  const secondSession = usMatch?.[1];
  if (!secondSession) {
    throw new ProofRuleError(`PROOF_RULE.md: row 3 must name the second required session, got "${usRow.trim()}"`);
  }

  // The horizons are written in the row LABEL ("Variance ratio verdict, 5m"),
  // not in the value cell. Reading the cell would find no numbers and either
  // fail or, worse, match the "5m"/"15m" in some other row. Parse the labels,
  // and require that each such row actually demands a verdict — a row that
  // stopped demanding one would otherwise vanish from the bar silently.
  const vrRows = md.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l) && /Variance ratio verdict/i.test(l));
  if (vrRows.length === 0) throw new ProofRuleError("PROOF_RULE.md: no variance-ratio rows");
  const horizons: number[] = [];
  for (const row of vrRows) {
    const m = row.match(/^\|\s*\d+\s*\|([^|]*)\|/);
    const label = m?.[1] ?? "";
    const nums = label.match(/([0-9]+)\s*m\b/i);
    if (!nums) throw new ProofRuleError(`PROOF_RULE.md: variance-ratio row has no horizon in its label: "${label.trim()}"`);
    const h = Number(nums[1]);
    if (!(h > 0)) throw new ProofRuleError("PROOF_RULE.md: horizons must be positive");
    if (!/rejects? the random walk/i.test(row)) {
      throw new ProofRuleError(
        `PROOF_RULE.md: the ${h}m variance-ratio row must require rejecting the random walk, got "${row.split("|")[3]?.trim()}"`,
      );
    }
    horizons.push(h);
  }

  const pAdj = numFromRowN(md, 7, "Bonferroni", "adjusted p threshold");

  // Row 8 states the bar, the fees and the markouts. Fees and markouts come
  // from the prose paragraph beneath the table, which is the only place both
  // round numbers appear together; the bar itself must be 0.
  // Fees and markout horizons are stated in the paragraph that explains row 8,
  // because the table cell only has room for the bar. Read them from the text
  // that says "after round-trip fees (2 bps maker + 5 bps taker)" and
  // "1s, 10s and 60s later" - i.e. from the sentence, not from a guess.
  const feeLine = md.split("\n").find((l) => /maker/i.test(l) && /taker/i.test(l) && /\bbps\b/.test(l));
  if (!feeLine) throw new ProofRuleError("PROOF_RULE.md: no line states the maker and taker fees in bps");
  const feeNums = feeLine.match(/([0-9]+(?:\.[0-9]+)?)\s*bps/gi) ?? [];
  if (feeNums.length < 2) {
    throw new ProofRuleError(`PROOF_RULE.md: expected 2 fee figures, found ${feeNums.length}: "${feeLine.trim()}"`);
  }
  const makerFeeBps = Number(feeNums[0]!.match(/[0-9.]+/)![0]);
  const takerFeeBps = Number(feeNums[1]!.match(/[0-9.]+/)![0]);

  const markLine = md.split("\n").find((l) => /mark/i.test(l) && /\b1s\b|\b10s\b|\b60s\b/.test(l));
  if (!markLine) throw new ProofRuleError("PROOF_RULE.md: no line states the markout horizons");
  const markout = (markLine.match(/([0-9]+)s\b/g) ?? []).map((x) => Number(x.replace(/s$/, "")));
  if (markout.length === 0) throw new ProofRuleError("PROOF_RULE.md: no markout horizons found");

  // Row 8 is a strict inequality on 0: "net bps > 0".
  const netRow = md.split("\n").find((l) => /^\|\s*8\s*\|/.test(l)) ?? "";
  if (!/\*\*>\s*0\*\*/.test(netRow)) {
    throw new ProofRuleError(`PROOF_RULE.md: row 8 must require net bps > 0, got "${netRow.split("|")[3]?.trim()}"`);
  }
  const minNetBps = 0;

  return {
    minCalendarDays: minDays,
    minWeeks: weeks,
    requiredSessions: ["asia", secondSession.toLowerCase()],
    requiredModel: "jev",
    vrHorizonsMin: horizons,
    maxPAdj: pAdj,
    makerFeeBps,
    takerFeeBps,
    markoutSeconds: markout,
    minNetBps,
  };
}

/** One-line summary for the CLI and the desk. */
export function describeRule(r: ProofRule): string {
  return [
    `${r.minCalendarDays}d in one era`,
    `${r.requiredSessions.join("+")} in each of ${r.minWeeks} weeks`,
    `MODEL=${r.requiredModel} (pinned)`,
    `VR rejects at ${r.vrHorizonsMin.map((h) => `${h}m`).join(",")}`,
    `p_adj<${r.maxPAdj}`,
    `net>${r.minNetBps}bps after ${r.makerFeeBps}+${r.takerFeeBps} + markout ${r.markoutSeconds.map((s) => `${s}s`).join("/")}`,
  ].join("; ");
}
