/**
 * Engine HTTP + SSE (port 3000).
 *
 * The dashboard is a read-only consumer: it never holds an OKX key and never
 * signs anything. Even the kill switch is a POST here, not a direct venue call.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import type { EventBus } from "../store/events.ts";
import type { Store } from "../store/db.ts";
import type { Sleeve } from "../store/types.ts";
import type { EngineApi } from "../engine.ts";

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

export interface ServerDeps {
  cfg: Config;
  bus: EventBus;
  store: Store;
  engine: EngineApi;
}

export function createEngineServer(d: ServerDeps) {
  const { cfg, bus, store, engine } = d;

  const authorise = (req: IncomingMessage, mutating: boolean): boolean => {
    if (!cfg.dashboardToken) return true;
    // Reads are open by default; writes always need the token. SSE is a read
    // but exposes live state, so it is gated whenever a token is configured.
    if (!mutating) return true;
    return bearer(req) === cfg.dashboardToken;
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, engine.snapshot());
    }

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, {
        ok: true,
        mode: engine.mode,
        model: engine.model,
        sleeves: engine.sleeves().length,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (req.method === "GET" && path === "/history") {
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      const instId = url.searchParams.get("instId") ?? undefined;
      const n = Number(url.searchParams.get("n") ?? 200);
      return json(res, 200, { ticks: store.history(instId, Math.min(1000, Math.max(1, n))) });
    }

    if (req.method === "GET" && path === "/tape") {
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      const instId = url.searchParams.get("instId") ?? engine.sleeves()[0]?.instId;
      if (!instId) return json(res, 200, { instId: null, mid: [], fills: [] });
      return json(res, 200, store.midSeries(instId, 300));
    }

    if (req.method === "GET" && path === "/fills") {
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { fills: store.recentFills(Number(url.searchParams.get("n") ?? 100)) });
    }

    if (req.method === "GET" && path === "/signals") {
      // What the brain actually saw, per tick. The desk renders this, and it is
      // how you check a question wording change without reading the DB.
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      const sleeveId = url.searchParams.get("sleeveId") ?? undefined;
      const n = Math.min(200, Number(url.searchParams.get("n") ?? 50));
      const ticks = store.history(undefined, 500)
        .filter((t) => (sleeveId ? t.sleeveId === sleeveId : true))
        .slice(0, n);
      return json(res, 200, {
        signals: ticks.map((t) => ({
          ts: t.ts,
          sleeveId: t.sleeveId,
          instId: t.instId,
          mid: t.mid,
          spreadBps: t.spreadBps,
          jev: t.jev,
          intent: t.intent,
          gates: t.gates,
          execNote: t.execNote,
        })),
      });
    }

    if (req.method === "GET" && path === "/events") {
      if (!authorise(req, false)) return json(res, 401, { error: "unauthorized" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // defeat proxy buffering
      });
      res.write(": connected\n\n");

      // Replay a little so a reconnecting client is not blank.
      for (const e of bus.recent(25)) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", ts: Date.now(), data: engine.snapshot() })}\n\n`);

      const off = bus.subscribe((e) => {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      // Comment frames keep proxies from closing an idle stream.
      const ka = setInterval(() => res.write(": ka\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ka);
        off();
        res.end();
      });
      return;
    }

    // ---- mutating ----
    if (req.method === "POST" && (path === "/kill" || path === "/unkill" || path === "/mode")) {
      if (!authorise(req, true)) return json(res, 401, { error: "unauthorized" });
      if (cfg.dashboardToken && bearer(req) !== cfg.dashboardToken) {
        return json(res, 401, { error: "bad token" });
      }
      const kill = path === "/kill";
      const unkill = path === "/unkill";
      if (kill) return void engine.kill().then(() => json(res, 200, engine.snapshot()));
      if (unkill) return void engine.unkill().then(() => json(res, 200, engine.snapshot()));
      return void readBody(req)
        .then((body) => {
          const mode = String((body as { mode?: string })?.mode ?? "");
          return engine.setMode(mode).then(
            (ok) => json(res, ok.ok ? 200 : 400, ok.ok ? engine.snapshot() : { error: ok.error, mode: engine.mode }),
          );
        })
        .catch((e: unknown) => json(res, 400, { error: e instanceof Error ? e.message : String(e) }));
    }

    return json(res, 404, { error: "not found", path });
  });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export type { Sleeve };
