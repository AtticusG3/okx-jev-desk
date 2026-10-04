import type React from "react";
import type { Snapshot } from "../lib/desk";

/**
 * The proof panel: PAPER, era, days collected, sessions still missing, status.
 *
 * Read-only by design. There is deliberately no control here - not a retune
 * button, not a "promote" button, not a mode switch. A machine that can act on
 * its own score stops being a measuring instrument, and the cheapest way to
 * keep that true is for the surface that shows the score to have no buttons.
 */
export function ProofPanel({ s }: { s: Snapshot }): React.ReactElement {
  const p = s.proof;
  const paper = s.mode === "mock" || s.mode === "paper";

  return (
    <div className="card proof">
      <div className="card-head">
        <h2>proof</h2>
        {paper && <span className="tag paper">PAPER</span>}
        <span className="spacer" />
        <span className={`status ${p?.status.toLowerCase() ?? "pending"}`}>
          {p?.status ?? "…"}
        </span>
        {p && p.at > 0 && (
          // When the status was computed. Without this a stale COLLECTING and a
          // current one look identical, and the reader cannot tell whether the
          // self-check is still running.
          <span className="checked" title="when the self-check last completed">
            checked {new Date(p.at).toISOString().slice(11, 19)}Z
          </span>
        )}
      </div>

      <div className="proof-grid">
        <div>
          <label>era</label>
          <code>{s.era || "—"}</code>
        </div>
        <div>
          <label>days collected</label>
          <b>{p ? `${p.days}/28` : "—"}</b>
        </div>
        <div>
          <label>complete weeks</label>
          <b>{p ? `${p.weeks}/4` : "—"}</b>
        </div>
        <div>
          <label>sessions missing</label>
          <b>{p && p.sessionsMissing.length ? p.sessionsMissing.join(", ") : "none"}</b>
        </div>
      </div>

      {p?.reason && <p className="reason">{p.reason}</p>}
      {p?.error && (
        <p className="reason err">
          self-check failed {p.consecutiveFailures}× — showing the last status it reached: {p.error}
        </p>
      )}

      {paper && (
        <p className="disclaimer">
          Paper. Fills are simulated and this P&amp;L is hypothetical — it is not money and it is
          not evidence of an edge.
        </p>
      )}
    </div>
  );
}
