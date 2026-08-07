import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWrite } from "./files.js";
import { createIpcServer, endpointFor } from "./ipc.js";
import { DeliveryEngine, loadCompatibility } from "./engine.js";
import { diagnostic, errorCategory } from "./diagnostics.js";
import { consumeDebugNext } from "./config.js";
import { TranscriptWatcher } from "./detector.js";
import type { DetectedRateLimit, TurnRegistration } from "./types.js";
import { VERSION } from "./constants.js";

type SupervisorMessage =
  | { action: "health" }
  | { action: "shutdown" }
  | { action: "debug-probe"; sessionId: string; turnId: string; model: string }
  | { action: "register"; registration: TurnRegistration }
  | { action: "stop"; sessionId: string; turnId: string };

function watcherKey(sessionId: string, turnId: string): string { return `${sessionId}\0${turnId}`; }

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function acquireLock(lock: string): boolean {
  try { mkdirSync(lock, { mode: 0o700 }); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    const metadata = JSON.parse(readFileSync(join(lock, "metadata.json"), "utf8")) as { pid?: unknown };
    const heartbeat = Number(readFileSync(join(lock, "heartbeat"), "utf8"));
    if (typeof metadata.pid !== "number" || !Number.isFinite(heartbeat) || Date.now() - heartbeat <= 120_000 || pidIsAlive(metadata.pid)) return false;
    const stale = `${lock}.stale-${randomBytes(6).toString("hex")}`;
    renameSync(lock, stale);
    try { mkdirSync(lock, { mode: 0o700 }); } catch { return false; }
    try { rmSync(stale, { recursive: true }); } catch { /* stale evidence is harmless */ }
    return true;
  } catch { return false; }
}

function debugEvent(registration: Pick<TurnRegistration, "sessionId" | "turnId" | "model"> & Partial<Pick<TurnRegistration, "surface" | "codexVersion">>): DetectedRateLimit {
  return {
    schemaVersion: 1,
    sessionId: registration.sessionId,
    turnId: registration.turnId,
    occurredAt: new Date().toISOString(),
    surface: registration.surface ?? "unknown",
    model: registration.model,
    codexVersion: registration.codexVersion ?? "unknown",
    errorCode: "usage_limit_exceeded",
    limitKind: "debug synthetic usage limit",
    resetAt: null,
    detector: "debug-synthetic"
  };
}

export async function runSupervisor(root: string, pluginRoot: string): Promise<void> {
  const lock = join(root, "state", "supervisor.lock");
  if (!acquireLock(lock)) return;
  let server: Awaited<ReturnType<typeof createIpcServer>> | undefined;
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolve => { requestShutdown = resolve; });
  const watchers = new Map<string, { watcher: TranscriptWatcher; expiresAt: number }>();
  try {
    const key = readFileSync(join(root, "state", "ipc.key"));
    if (key.length !== 32) throw new Error("ipc_key_invalid");
    const engine = new DeliveryEngine(root, pluginRoot);
    const metadata = { pid: process.pid, instanceNonce: randomBytes(16).toString("hex"), version: VERSION, buildId: VERSION, startedAt: new Date().toISOString(), endpoint: endpointFor(root) };
    atomicWrite(join(lock, "metadata.json"), `${JSON.stringify(metadata)}\n`);
    atomicWrite(join(lock, "heartbeat"), `${Date.now()}\n`);
    const heartbeat = setInterval(() => atomicWrite(join(lock, "heartbeat"), `${Date.now()}\n`), 30_000);
    heartbeat.unref();
    server = await createIpcServer(root, key, async unknownBody => {
      const body = unknownBody as SupervisorMessage;
      if (!body || typeof body !== "object" || typeof body.action !== "string") throw new Error("ipc_message_invalid");
      if (body.action === "health") return { pid: process.pid, version: VERSION };
      if (body.action === "shutdown") {
        requestShutdown();
        return { shuttingDown: true };
      }
      if (body.action === "debug-probe") {
        if (!body.sessionId || !body.turnId || !body.model) throw new Error("debug_probe_invalid");
        if (!consumeDebugNext(root)) return { debug: false };
        void engine.handle(debugEvent(body), { forcePreview: true, selfRecipient: true }).catch(error => diagnostic(root, errorCategory("debug_preview_failed", error)));
        return { debug: true };
      }
      if (body.action === "stop") { watchers.delete(watcherKey(body.sessionId, body.turnId)); return { stopped: true }; }
      if (body.action !== "register") throw new Error("ipc_action_invalid");
      const registration = body.registration;
      const compatible = loadCompatibility(pluginRoot).transcriptDetector[registration.codexVersion];
      if (!compatible || !compatible.surfaces.includes(registration.surface)) {
        diagnostic(root, "unsupported_version_or_surface");
        return { registered: false };
      }
      for (const key of watchers.keys()) if (key.startsWith(`${registration.sessionId}\0`)) watchers.delete(key);
      watchers.set(watcherKey(registration.sessionId, registration.turnId), { watcher: new TranscriptWatcher(registration), expiresAt: Date.now() + 6 * 3600_000 });
      return { registered: true };
    });
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, active] of watchers) {
        if (active.expiresAt <= now) { watchers.delete(key); diagnostic(root, "watcher_expired"); continue; }
        try {
          const outcome = active.watcher.poll(now);
          if (outcome.kind === "continue") continue;
          watchers.delete(key);
          if (outcome.kind === "detected") void engine.handle(outcome.event).catch(error => diagnostic(root, errorCategory("delivery_failed", error)));
          else diagnostic(root, outcome.category);
        } catch (error) { watchers.delete(key); diagnostic(root, errorCategory("watcher_failed", error)); }
      }
    }, 500);
    timer.unref();
    const shutdown = () => requestShutdown();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    await shutdownRequested;
    clearInterval(timer);
    clearInterval(heartbeat);
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  } catch (error) { diagnostic(root, errorCategory("supervisor_failed", error)); }
  finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    try { rmSync(lock, { recursive: true }); } catch { /* another process may have recovered it */ }
  }
}
