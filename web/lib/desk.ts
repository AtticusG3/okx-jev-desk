/**
 * SSE client with backoff reconnect.
 *
 * The engine sends a `snapshot` on connect, so a reconnect refetches nothing
 * extra: we just replace state with the fresh snapshot and keep streaming.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DeskEvent<T = unknown> {
  type: string;
  ts: number;
  data: T;
}

/** What the engine's self-check last concluded. */
export type ProofStatus = "COLLECTING" | "NO_EDGE" | "COST_BOUND" | "CANDIDATE";

export interface ProofState {
  status: ProofStatus;
  reason: string;
  era: string;
  days: number;
  weeks: number;
  sessionsMissing: string[];
  at: number;
  /** Non-null when the last self-check threw. The status is still the last good one. */
  error: string | null;
  consecutiveFailures: number;
}

export interface Snapshot {
  ts: number;
  mode: string;
  model: string;
  /** Hash of questions + bucket edges + PROOF_RULE.md + sizing. */
  era: string;
  /** null until the first self-check completes. Not a fake status. */
  proof: ProofState | null;
  kill: boolean;
  dailyLossTripped: boolean;
  tickMs: number;
  pnl: {
    realizedUsd: number;
    unrealizedUsd: number;
    dailyPnlUsd: number;
    dailyLossUsedFrac: number;
    grossUsd: number;
  };
  connections: {
    public: { connected: boolean; reconnects: number; lastError: string | null } | null;
    private: { connected: boolean; authenticated: boolean; lastError: string | null } | null;
  };
  sleeves: Sleeve[];
}

export interface Sleeve {
  id: string;
  bot: string;
  instId: string;
  position: {
    instId: string;
    side: "long" | "short" | "flat";
    szContracts: number;
    entryPx: number;
    markPx: number;
    notionalUsd: number;
    unrealizedPnlUsd: number;
    openedAt: number | null;
    liqPx: number | null;
  };
  workingOrder: { side: "buy" | "sell"; px: number; sz: number } | null;
  lastMid: number;
  stats: {
    ticks: number;
    ordersPlaced: number;
    fills: number;
    jevErrors: number;
    lastJevLatencyMs: number | null;
    blockedByGate: number;
  };
  jev: Jev | null;
  intent: Intent | null;
}

export interface Jev {
  direction: string;
  directionProbs: Record<string, number>;
  directionConfidence: number;
  action: string;
  entryQuality: number;
  dumpRisk: number;
  latencyMs: number;
  model: string;
  error?: string;
}

export interface Intent {
  side: string;
  urgency: string;
  reason: string;
  blocked: boolean;
  gateNotes: string[];
}

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export interface TickPayload {
  sleeveId: string;
  instId: string;
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  buckets: Record<string, string>;
  jev: Jev | null;
  intent: Intent | null;
  gates: string[];
  executed: boolean;
  execNote: string;
  position: Sleeve["position"];
}

export function useDesk(): {
  snapshot: Snapshot | null;
  ticks: Record<string, DeskEvent<TickPayload>>;
  fills: DeskEvent[];
  connected: boolean;
  lastError: string | null;
  send: (path: string, body?: unknown) => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ticks, setTicks] = useState<Record<string, DeskEvent<TickPayload>>>({});
  const [fills, setFills] = useState<DeskEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(async (path: string, body?: unknown) => {
    const token = typeof window !== "undefined" ? window.localStorage.getItem("deskToken") : null;
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) setLastError(`${path} -> ${res.status} ${await res.text()}`);
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      const es = new EventSource(`${API}/events`);
      esRef.current = es;

      es.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
        setLastError(null);
      };

      es.addEventListener("snapshot", (e) => {
        const msg = JSON.parse((e as MessageEvent).data) as DeskEvent<Snapshot>;
        setSnapshot(msg.data);
      });

      es.addEventListener("tick", (e) => {
        const msg = JSON.parse((e as MessageEvent).data) as DeskEvent<TickPayload>;
        // Keep the newest tick per sleeve: this is a live desk, not a log.
        setTicks((prev: Record<string, DeskEvent<TickPayload>>) => ({ ...prev, [msg.data.sleeveId]: msg }));
      });

      es.addEventListener("fill", (e) => {
        const msg = JSON.parse((e as MessageEvent).data) as DeskEvent;
        setFills((prev: DeskEvent[]) => [msg, ...prev].slice(0, 50));
      });

      es.addEventListener("kill", () => {
        void fetch(`${API}/`).then((r) => r.json()).then((s: Snapshot) => setSnapshot(s));
      });

      es.onerror = () => {
        setConnected(false);
        es.close();
        if (disposed) return;
        // Backoff: 1, 2, 4, 8s capped at 15s.
        const delay = Math.min(15_000, 1000 * 2 ** attemptRef.current);
        attemptRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      esRef.current?.close();
    };
  }, []);

  return { snapshot, ticks, fills, connected, lastError, send };
}
