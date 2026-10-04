/**
 * Ledger identity: what era is a row in, and which UTC session produced it.
 *
 * The point of an era is to make a claim checkable. A signal measured on one
 * set of questions and bucket edges is evidence about THAT configuration. If
 * the questions or the edges change, the old rows stop being evidence for the
 * new configuration and must not be silently pooled with it. So every tick
 * carries a hash of the exact files that decide what the model was asked and
 * how its inputs were described, and the frozen bar (docs/PROOF_RULE.md) is
 * only ever evaluated within a single era.
 *
 * The era hash is deliberately a hash of file CONTENTS, not of git SHAs. A
 * commit can touch a comment; a question can change without a commit. The
 * thing that matters is what the brain saw.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Files whose contents define an era. Adding one here is a schema change.
 *
 * `src/jev/state.ts` is here because the era is a claim about what the BRAIN
 * saw, and state.ts decides what that is. It was missing until 2026-09-28: the
 * position view changed from dollar amounts and bps to two buckets, which
 * changes what a row in the ledger means without changing any question, and
 * rows collected on either side of that edit must not be pooled.
 */
export const ERA_FILES = [
  "src/jev/questions.ts",
  "src/jev/state.ts",
  "src/features/bucket_edges.json",
  "docs/PROOF_RULE.md",
] as const;

/** UTC sessions. Fixed windows, so a row's session never depends on config. */
export type Session = "asia" | "europe" | "us";

export const SESSIONS: readonly Session[] = ["asia", "europe", "us"];

/**
 * Which session a tick belongs to, from UTC hour.
 *
 * Asia 00-08, Europe 08-16, US 16-24. The hours are UTC, not local: a session
 * label that depended on the host's timezone would make the ledger
 * unreproducible on a different machine, and the whole point of the session
 * tag is that two people can agree on what a given row belongs to.
 */
export function sessionForHour(hourUtc: number): Session {
  const h = ((Math.floor(hourUtc) % 24) + 24) % 24;
  if (h < 8) return "asia";
  if (h < 16) return "europe";
  return "us";
}

export function sessionForTs(tsMs: number): Session {
  return sessionForHour(new Date(tsMs).getUTCHours());
}

export interface EraDescriptor {
  /** Short hash of every era file's contents. Stable across restarts. */
  hash: string;
  /** Per-file hashes, so a mismatch can be attributed to one file. */
  files: Record<string, string>;
  /** Files that could not be read, and therefore could not be hashed. */
  missing: string[];
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Repo root, resolved from this file rather than process.cwd(). */
export function repoRootFrom(here: string): string {
  // src/measure/era.ts -> src/measure -> src -> <root>
  return dirname(dirname(dirname(here)));
}

export function repoRoot(): string {
  return repoRootFrom(fileURLToPath(import.meta.url));
}

/**
 * Hash the era-defining files.
 *
 * A missing file is reported rather than silently treated as empty: an era
 * hash computed over "the file is absent" would still be a stable hash, and a
 * stable-but-wrong hash is the dangerous kind. docs/PROOF_RULE.md arrives in
 * card 2, so before that it is legitimately absent and is reported as such.
 */
export function computeEra(root: string = repoRoot()): EraDescriptor {
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const rel of ERA_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) {
      missing.push(rel);
      continue;
    }
    files[rel] = sha256(readFileSync(p));
  }
  // Hash the concatenation of the PER-FILE hashes, plus the file names, so
  // that moving content between two era files cannot collide with a
  // configuration that has the same total content in the same order.
  const material = Object.keys(files)
    .sort()
    .map((k) => `${k}\0${files[k]}`)
    .join("\n");
  return { hash: sha256(material || "empty-era").slice(0, 16), files, missing };
}

/**
 * The sizing constants, folded into the era.
 *
 * Sizing decides position size, and position size decides the notional the
 * markout and the PnL are computed on. A retune of QUOTE_USD therefore
 * changes what the ledger means, so it is part of the identity. The values
 * come from the already-parsed config rather than the environment, so a test
 * can construct a config directly and get a matching era.
 */
export function sizingFingerprint(risk: {
  quoteUsd: number;
  maxPosUsd: number;
  maxGrossUsd: number;
  maxDailyLossUsd: number;
  maxAddsPerSleeve: number;
  maxOrdersPerMin: number;
  maxSpreadBps: number;
}): string {
  const material = [
    `quoteUsd=${risk.quoteUsd}`,
    `maxPosUsd=${risk.maxPosUsd}`,
    `maxGrossUsd=${risk.maxGrossUsd}`,
    `maxDailyLossUsd=${risk.maxDailyLossUsd}`,
    `maxAddsPerSleeve=${risk.maxAddsPerSleeve}`,
    `maxOrdersPerMin=${risk.maxOrdersPerMin}`,
    `maxSpreadBps=${risk.maxSpreadBps}`,
  ].join("\n");
  return sha256(material);
}

/**
 * The full era hash: era files plus the sizing constants.
 *
 * Short by design — it appears in every tick row and in the desk UI, and it
 * only needs to be comparable, not reversible.
 */
export function eraHash(descriptor: EraDescriptor, sizing: string): string {
  return sha256(`${descriptor.hash}\0${sizing}`).slice(0, 16);
}
