/**
 * npm run proof
 *
 * One command, one status, from the ledger and docs/PROOF_RULE.md only.
 *
 * Reads. Never writes. CANDIDATE is a statement about evidence, not a
 * configuration change, and this command has no code path that could make one.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { MissingLedgerError } from "../src/store/db.ts";
import { computeEra, eraHash, sizingFingerprint, repoRoot } from "../src/measure/era.ts";
import { loadProofRule, describeRule, ProofRuleError } from "../src/measure/proof_rule.ts";
import { runProof, type ProofStatus } from "../src/measure/proof.ts";

const root = repoRoot();
// PROOF_DB_OVERRIDE exists so the gate test can point at a fixture ledger
// without ever touching data/desk.db. Unset in normal use.
const dbPath = process.env.PROOF_DB_OVERRIDE ?? join(root, "data", "desk.db");
const tickMs = Number(process.env.PROOF_TICK_MS ?? 3000);

/** Status -> exit code. Only a hard failure is non-zero. */
const EXIT: Record<ProofStatus, number> = {
  COLLECTING: 0,
  NO_EDGE: 0,
  COST_BOUND: 0,
  CANDIDATE: 0,
};

function main(): void {
  // The bar first. If it cannot be read, nothing below means anything.
  let rule;
  try {
    rule = loadProofRule(join(root, "docs", "PROOF_RULE.md"));
  } catch (e) {
    if (e instanceof ProofRuleError) {
      console.error(`PROOF FAILED: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  if (!existsSync(dbPath)) {
    console.log("COLLECTING");
    console.log(`  no ledger at ${dbPath}. Nothing collected yet, so nothing to judge.`);
    console.log(`  bar: ${describeRule(rule)}`);
    process.exit(0);
  }

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch {
    // The proof must not depend on the environment being sane; the era needs
    // the same sizing constants the engine booted with, and if the env is
    // unusable that is a separate problem reported by the engine, not here.
    cfg = null;
  }

  const model = process.env.MODEL ?? "mock";
  const modelId = process.env.JEV_MODEL_ID ?? null;
  const instruments = (process.env.OKX_INST_IDS ?? "BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const desc = computeEra(root);
  const era = eraHash(desc, cfg ? sizingFingerprint(cfg.risk) : sizingFingerprint({
    quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
    maxAddsPerSleeve: 2, maxOrdersPerMin: 20, maxSpreadBps: 25,
  }));

  let report;
  try {
    report = runProof({
      dbPath, instruments, rule,
      // MODEL=mock is always COLLECTING, and the requirement row says so, so
      // the reason string explains it rather than the status hiding it.
      model, modelId, tickMs, era,
      bootP: Number(process.env.PROOF_BOOT_P ?? 4000),
      minSettled: Number(process.env.PROOF_MIN_SETTLED ?? 500),
    });
  } catch (e) {
    if (e instanceof MissingLedgerError) {
      console.log("COLLECTING");
      console.log("  no ledger yet.");
      process.exit(0);
    }
    throw e;
  }

  // ---- output
  console.log(report.status);
  console.log();
  console.log(`  era             ${report.era}`);
  console.log(`  model           ${model}${modelId ? ` (${modelId})` : ""}`);
  console.log(`  days collected  ${report.calendarDays}/${rule.minCalendarDays}`);
  console.log(`  complete weeks  ${report.weeks}/${rule.minWeeks}`);
  if (report.sessionsMissing.length) {
    console.log(`  still missing   ${report.sessionsMissing.join(", ")}`);
  }
  console.log(`  scored          ${report.scored} feature/horizon combos`);
  console.log();
  for (const r of report.requirements) {
    console.log(`  [${r.met ? "ok" : "  "}] ${r.id.padEnd(6)} ${r.label}`);
    console.log(`         ${r.detail}`);
  }
  console.log();
  console.log(`  ${report.reason}`);
  console.log();
  console.log(`  bar: ${describeRule(rule)}`);
  if (report.status === "CANDIDATE") {
    console.log();
    console.log("  This is a statement about evidence. It changes nothing on disk, and");
    console.log("  it is not a promotion: acting on it stays a human decision.");
  }
  process.exit(EXIT[report.status]);
}

main();
