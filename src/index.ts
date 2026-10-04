#!/usr/bin/env node
/**
 * Engine entrypoint. Loads .env, validates the mode/credential agreement, then
 * starts the desk and the HTTP/SSE server.
 *
 * Refusing to boot on a misconfiguration is deliberate. A trading desk that
 * quietly downgrades "live" to "paper" is more dangerous than one that will not
 * start, because you find out from the balance.
 */
import { join } from "node:path";
import { defaultEnvPath, loadConfig, loadDotEnv, validate, repoRoot, ConfigError } from "./config.ts";
import { Engine } from "./engine.ts";
import { createEngineServer } from "./http/server.ts";

async function main(): Promise<void> {
  loadDotEnv(defaultEnvPath());

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    console.error(`config error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  let report;
  try {
    report = validate(cfg, process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\nREFUSING TO START\n\n  ${e.message}\n`);
      console.error("  Fix .env and retry. See README.md -> Running.\n");
      process.exit(2);
    }
    throw e;
  }

  const banner = (s: string): void => console.log(s);
  banner("  okx-jev-desk — engine");
  banner(`  mode=${report.mode}  model=${report.model}  sleeves=${cfg.okx.instIds.length}  bots=${cfg.bots.join(",")}`);
  if (cfg.mode === "demo") banner("  venue: OKX DEMO (x-simulated-trading: 1) — no real funds");
  if (cfg.mode === "paper") banner("  venue: live OKX public data, NO orders placed");
  if (cfg.mode === "mock") banner("  venue: synthetic/real public data, simulated fills, no orders");
  if (cfg.mode === "live") {
    banner("  venue: LIVE OKX — REAL ORDERS, REAL FUNDS");
    banner("  live checklist:");
    for (const c of report.checklist) banner(`    [ ] ${c}`);
  }
  for (const w of report.warnings) banner(`  WARN  ${w}`);
  banner("");

  const dbPath = join(repoRoot(), "data", "desk.db");
  const engine = new Engine(cfg, { dbPath });
  await engine.start();

  const server = createEngineServer({ cfg, bus: engine.eventBus, store: engine.db, engine });
  server.listen(cfg.enginePort, "127.0.0.1", () => {
    console.log(`  engine http   http://127.0.0.1:${cfg.enginePort}`);
    console.log(`  events (SSE)  http://127.0.0.1:${cfg.enginePort}/events`);
    console.log(`  db            ${dbPath}`);
  });

  const shutdown = (sig: string): void => {
    console.log(`\n${sig} — shutting down`);
    // Stop the loop before closing sockets so no tick writes to a dead store.
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  console.error("fatal:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
