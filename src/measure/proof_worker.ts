/**
 * The proof's compute worker.
 *
 * Why a worker: the proof is a whole-ledger read plus thousands of bootstrap
 * resamples per feature. Run on the main thread that is tens of seconds of
 * solid CPU, and it starves the event loop - the engine stops answering HTTP,
 * stops processing WS frames, and stops ticking, while still holding its
 * sockets open so it looks alive from the outside.
 *
 * The ledger is opened read-only INSIDE the worker. Copying rows across the
 * thread boundary would cost more than the computation and would defeat the
 * point: the whole reason this is off-thread is that reading is the expensive
 * part.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runProof } from "./proof.ts";
import { loadProofRule } from "./proof_rule.ts";
import type { ProofRule } from "./proof_rule.ts";
import type { ProofStatus } from "./proof.ts";

export interface ProofRequest {
  dbPath: string;
  instruments: string[];
  rule: ProofRule;
  model: string;
  modelId: string | null;
  tickMs: number;
  era: string;
  bootP: number;
  minSettled: number;
}

export interface ProofResponse {
  status: ProofStatus;
  reason: string;
  era: string;
  days: number;
  weeks: number;
  sessionsMissing: string[];
  /** Milliseconds spent, so a slow check is visible rather than mysterious. */
  ms: number;
}

if (parentPort) {
  const req = workerData as ProofRequest;
  const t0 = Date.now();
  try {
    const r = runProof({
      dbPath: req.dbPath,
      instruments: req.instruments,
      rule: req.rule,
      model: req.model,
      modelId: req.modelId,
      tickMs: req.tickMs,
      era: req.era,
      // The engine is collecting into a known era; do not silently fall back
      // to another one, or the desk would report on a different experiment
      // than the one it is running.
      strictEra: true,
      bootP: req.bootP,
      minSettled: req.minSettled,
    });
    const out: ProofResponse = {
      status: r.status,
      reason: r.reason,
      era: r.era,
      days: r.calendarDays,
      weeks: r.weeks,
      sessionsMissing: r.sessionsMissing,
      ms: Date.now() - t0,
    };
    parentPort.postMessage({ ok: true, out });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
