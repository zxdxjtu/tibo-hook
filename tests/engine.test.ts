import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.js";
import { DurableJournal, deliveryRecord } from "../src/journal.js";
import type { Config } from "../src/types.js";
import { event, pluginRoot, tempData } from "./helpers.js";

function enableSmtp(root: string, config: Config): Config {
  const enabled: Config = { ...config, autoSend: true, smtp: { host: "smtp.example.com", port: 587, security: "starttls-required", username: "developer@example.net", fromEmail: "developer@example.net", passwordEnv: "TIBO_HOOK_TEST_PASSWORD", timeoutMs: 15000 } };
  writeFileSync(join(root, "config.json"), `${JSON.stringify(enabled, null, 2)}\n`, { mode: 0o600 });
  chmodSync(join(root, "config.json"), 0o600);
  process.env.TIBO_HOOK_TEST_PASSWORD = "test-only-secret";
  return enabled;
}

test("draft mode and debug make zero SMTP calls", async () => {
  const { root } = tempData();
  let calls = 0;
  const engine = new DeliveryEngine(root, pluginRoot, async () => { calls++; return { status: "accepted" }; });
  const drafted = await engine.handle(event("draft"));
  assert.equal(drafted.status, "drafted");
  assert.equal(calls, 0);
  const debug = await engine.handle({ ...event("debug", null, "unknown"), detector: "debug-synthetic" }, { forcePreview: true });
  assert.equal(debug.status, "preview");
  assert.equal(calls, 0);
  const eml = readFileSync(debug.path!, "utf8");
  assert.match(eml, /To: developer@example.net/);
  assert.doesNotMatch(eml, /prompt|transcript|test-only-secret/i);
});

test("same window is serialized once and rolling 30-day cap suppresses fourth send", async () => {
  const { root, config } = tempData();
  enableSmtp(root, config);
  let calls = 0;
  const engine = new DeliveryEngine(root, pluginRoot, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { status: "accepted" }; });
  const same = await Promise.all([engine.handle(event("a")), engine.handle(event("b"))]);
  assert.deepEqual(same.map(item => item.status), ["accepted", "suppressed"]);
  const more = await Promise.all([
    engine.handle(event("c", "2026-08-08T12:00:00.000Z")),
    engine.handle(event("d", "2026-08-09T12:00:00.000Z")),
    engine.handle(event("e", "2026-08-10T12:00:00.000Z"))
  ]);
  assert.deepEqual(more.map(item => item.status), ["accepted", "accepted", "suppressed"]);
  assert.equal(calls, 3);
});

test("unknown delivery consumes window and crash recovery converts reserved to unknown", async () => {
  const { root, config } = tempData();
  enableSmtp(root, config);
  const engine = new DeliveryEngine(root, pluginRoot, async () => ({ status: "unknown", category: "connection_lost" }));
  assert.equal((await engine.handle(event("unknown"))).status, "unknown");
  assert.equal((await engine.handle(event("again"))).status, "suppressed");
  const other = tempData().root;
  const journal = new DurableJournal(other);
  const now = new Date().toISOString();
  journal.append(deliveryRecord("a".repeat(64), "w", "reserved", now));
  const recovered = new DurableJournal(other);
  recovered.recoverInterrupted(now);
  assert.equal(recovered.recent(1)[0]?.status, "unknown");
});

test("unknown Codex version fails closed", async () => {
  const { root } = tempData();
  let calls = 0;
  const engine = new DeliveryEngine(root, pluginRoot, async () => { calls++; return { status: "accepted" }; });
  const result = await engine.handle(event("unknown-version", null, "9.9.9"));
  assert.equal(result.status, "suppressed");
  assert.equal(calls, 0);
});
