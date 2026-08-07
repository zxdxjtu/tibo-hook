import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setDebugNext } from "../src/config.js";
import { ipcRequest } from "../src/ipc.js";
import { pluginRoot, tempData } from "./helpers.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for hook side effect");
}

test("bundled UserPromptSubmit consumes debug once without a transcript or SMTP", { timeout: 10_000 }, async () => {
  const { root } = tempData();
  setDebugNext(root, true);
  const bundle = resolve("plugins/tibo-hook/dist/tibo-hook.cjs");
  const env = { ...process.env, PLUGIN_DATA: root, TIBO_HOOK_PLUGIN_ROOT: pluginRoot };
  const input = JSON.stringify({ session_id: "hook-session", turn_id: "hook-turn", transcript_path: null, model: "gpt-test", prompt: "PRIVATE PROMPT MUST NOT BE STORED" });
  const first = spawnSync(process.execPath, [bundle, "hook", "UserPromptSubmit"], { input, encoding: "utf8", env, timeout: 5000 });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.equal(first.stderr, "");
  const previewDir = join(root, "outbox", "previews");
  await waitFor(() => existsSync(previewDir) && readdirSync(previewDir).length === 1);
  const preview = readFileSync(join(previewDir, readdirSync(previewDir)[0]!), "utf8");
  assert.doesNotMatch(preview, /PRIVATE PROMPT|transcript/i);
  const second = spawnSync(process.execPath, [bundle, "hook", "UserPromptSubmit"], { input, encoding: "utf8", env, timeout: 5000 });
  assert.equal(second.status, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(readdirSync(previewDir).length, 1);
  const log = readFileSync(join(root, "logs", "diagnostic.log"), "utf8");
  assert.doesNotMatch(log, /PRIVATE PROMPT|developer@example|reviewer@example|transcript/i);
  const metadata = JSON.parse(readFileSync(join(root, "state", "supervisor.lock", "metadata.json"), "utf8")) as { pid: number };
  assert.ok(Number.isInteger(metadata.pid) && metadata.pid > 1);
  const key = readFileSync(join(root, "state", "ipc.key"));
  const shutdown = await ipcRequest(root, key, { action: "shutdown" }) as { ok: boolean; result: { shuttingDown: boolean } };
  assert.equal(shutdown.ok, true);
  assert.equal(shutdown.result.shuttingDown, true);
  await waitFor(() => !existsSync(join(root, "state", "supervisor.lock")));
});
