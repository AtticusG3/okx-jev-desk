"use client";

import { useEffect, useState } from "react";
import { useDesk, API, type DeskEvent, type Sleeve } from "../lib/desk";
import { ProofPanel } from "./proof-panel";

export const dynamic = "force-dynamic";

const fmt = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d);

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

const modeColor: Record<string, string> = {
  mock: "#64748b",
  paper: "#0ea5e9",
  demo: "#f59e0b",
  live: "#ef4444",
};

function Light({ on, label, warn }: { on: boolean; label: string; warn?: string | null }): React.ReactElement {
  return (
    <span className="light" title={warn ?? undefined}>
      <i className={on ? "on" : "off"} />
      {label}
    </span>
  );
}

function Chips({ s }: { s: Sleeve }): React.ReactElement {
  const j = s.jev;
  if (!j) return <div className="chips muted">awaiting first call…</div>;
  const p = j.directionProbs?.[j.direction] ?? 0;
  return (
    <div className="chips">
      <span className="chip" title={`P=${p.toFixed(2)} conf=${j.directionConfidence.toFixed(2)}`}>
        direction <b>{fmt(p, 2)}</b> {j.direction}
      </span>
      <span className="chip">action <b>{j.action}</b></span>
      <span className="chip" title="Score 0-4">entry <b>{fmt(j.entryQuality, 1)}</b></span>
      <span className="chip" title="Score 0-3, higher is worse">dump <b>{fmt(j.dumpRisk, 1)}</b></span>
      {j.error && <span className="chip err" title={j.error}>brain error</span>}
    </div>
  );
}

function SleeveCard({ s, tick }: { s: Sleeve; tick: DeskEvent<{ buckets?: Record<string, string> }> | undefined }): React.ReactElement {
  const b = tick?.data?.buckets;
  const pos = s.position;
  const pnlCls = pos.unrealizedPnlUsd > 0 ? "up" : pos.unrealizedPnlUsd < 0 ? "down" : "";
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <span className="inst">{s.instId}</span>
          <span className="bot">{s.bot}</span>
        </div>
        <span className="mid">{s.lastMid ? s.lastMid.toFixed(2) : "—"}</span>
      </div>

      <div className="buckets">
        {b && (
          <>
            <span className="bk">spread <b>{b.spread}</b></span>
            <span className="bk">book <b>{b.imbalance}</b></span>
            <span className="bk">flow <b>{b.flow}</b></span>
            <span className="bk">mom5m <b>{b.momentum_5m}</b></span>
            <span className="bk">vol <b>{b.vol_15m}</b></span>
            <span className="bk">range <b>{b.range_pos}</b></span>
            <span className="bk">fund <b>{b.funding}</b></span>
            <span className={`bk ${b.toxic.includes("toxic") ? "warn" : ""}`}>flowq <b>{b.toxic}</b></span>
          </>
        )}
      </div>

      <Chips s={s} />

      <div className="row">
        <span className={`pos ${pos.side}`}>
          {pos.side === "flat" ? "FLAT" : `${pos.side.toUpperCase()} ${pos.szContracts}`}
        </span>
        <span className="dim">entry {fmt(pos.entryPx)}</span>
        <span className={`dim ${pnlCls}`}>uPnL {usd(pos.unrealizedPnlUsd)}</span>
        <span className="dim">notional {usd(pos.notionalUsd)}</span>
        {pos.liqPx ? <span className="dim danger">liq {fmt(pos.liqPx)}</span> : null}
      </div>

      {s.workingOrder && (
        <div className="row quote">
          working {s.workingOrder.side} {s.workingOrder.sz} @ {s.workingOrder.px}
        </div>
      )}

      {s.intent && (
        <div className={`intent ${s.intent.blocked ? "blocked" : ""}`}>
          <span className="side">{s.intent.side}</span>
          <span className="urg">{s.intent.urgency}</span>
          <span className="why">{s.intent.reason}</span>
        </div>
      )}
      {s.intent && s.intent.gateNotes.length > 0 && (
        <div className="gates">
          {s.intent.gateNotes.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      )}

      <div className="stats">
        ticks {s.stats.ticks} · orders {s.stats.ordersPlaced} · fills {s.stats.fills} · blocked {s.stats.blockedByGate}
        {s.stats.lastJevLatencyMs !== null && <> · {s.stats.lastJevLatencyMs}ms</>}
        {s.stats.jevErrors > 0 && <span className="danger"> · jevErr {s.stats.jevErrors}</span>}
      </div>
    </div>
  );
}

export default function Page(): React.ReactElement {
  const { snapshot, ticks, fills, connected, send } = useDesk();
  const [now, setNow] = useState<string>("");
  const [raw, setRaw] = useState<string>("");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString().slice(11, 19)), 1000);
    return () => clearInterval(t);
  }, []);

  const pnl = snapshot?.pnl;
  const lossPct = Math.min(100, (pnl?.dailyLossUsedFrac ?? 0) * 100);

  return (
    <main>
      <header>
        <h1>okx·jev desk</h1>
        {snapshot && (
          <span className="mode" style={{ background: modeColor[snapshot.mode] ?? "#64748b" }}>
            {snapshot.mode.toUpperCase()}
          </span>
        )}
        <span className="model">{snapshot?.model ?? "…"}</span>

        <span className="spacer" />

        <Light on={connected} label="engine" warn={connected ? undefined : "reconnecting…"} />
        <Light on={Boolean(snapshot?.connections?.public?.connected)} label="OKX pub" warn={snapshot?.connections?.public?.lastError} />
        {snapshot?.mode === "demo" || snapshot?.mode === "live" ? (
          <Light
            on={Boolean(snapshot?.connections?.private?.authenticated)}
            label="OKX priv"
            warn={snapshot?.connections?.private?.lastError}
          />
        ) : null}

        <span className="clock">{now}Z</span>

        <span className="pnl">
          <span>R {usd(pnl?.realizedUsd)}</span>
          <span>U {usd(pnl?.unrealizedUsd)}</span>
          <span className={pnl && pnl.dailyPnlUsd < 0 ? "down" : "up"}>D {usd(pnl?.dailyPnlUsd)}</span>
        </span>

        <div className="loss" title={`daily loss budget used: ${lossPct.toFixed(0)}%`}>
          <div className="loss-bar"><i style={{ width: `${lossPct}%` }} /></div>
        </div>

        <button
          className={`kill ${snapshot?.kill ? "on" : ""}`}
          onClick={() => void send(snapshot?.kill ? "/unkill" : "/kill")}
        >
          {snapshot?.kill ? "RESUME" : "KILL"}
        </button>
      </header>

      {snapshot?.dailyLossTripped && (
        <div className="banner">DAILY LOSS LIMIT HIT — desk flattened and halted for the UTC day.</div>
      )}
      {snapshot?.mode === "mock" && (
        <div className="banner info">
          MODEL=mock — signals are a local heuristic, not Jev. Nothing on this screen is an edge.
        </div>
      )}

      {snapshot && <ProofPanel s={snapshot} />}

      <section className="grid">
        {snapshot?.sleeves.map((s) => (
          <SleeveCard key={s.id} s={s} tick={ticks[s.id]} />
        ))}
        {!snapshot && <div className="card muted">connecting to engine at {API}…</div>}
      </section>

      <section className="bottom">
        <div className="panel">
          <h2>Fills</h2>
          <table>
            <thead><tr><th>time</th><th>sleeve</th><th>side</th><th>px</th><th>sz</th><th>sim</th></tr></thead>
            <tbody>
              {fills.map((f, i) => {
                const d = f.data as { sleeveId?: string; instId: string; side: string; px: number; sz: number; simulated?: boolean; duplicate?: boolean };
                return (
                  <tr key={i}>
                    <td>{new Date(f.ts).toISOString().slice(11, 19)}</td>
                    <td>{d.sleeveId ?? d.instId}</td>
                    <td className={d.side === "buy" ? "up" : "down"}>{d.side}</td>
                    <td>{d.px}</td>
                    <td>{d.sz}</td>
                    <td>{d.simulated ? "yes" : "no"}</td>
                  </tr>
                );
              })}
              {fills.length === 0 && <tr><td colSpan={6} className="muted">no fills yet</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>
            Last brain call
            <button className="ghost" onClick={() => setRaw(raw ? "" : "show")}>{raw ? "hide" : "show"}</button>
          </h2>
          {raw ? (
            <pre>{JSON.stringify(
              (Object.values(ticks)[0]?.data ?? {}) as unknown,
              null,
              2,
            )}</pre>
          ) : (
            <p className="muted">
              The desk shows the model&apos;s typed answers and the code-side gate decisions.
              Raw request/response is available here for debugging.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
