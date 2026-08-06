import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createIpcServer, ipcRequest, signEnvelope, verifyEnvelope } from "../src/ipc.js";
import { tempData } from "./helpers.js";

test("local IPC authenticates requests and binds responses to the challenge", async () => {
  const { root } = tempData();
  const key = readFileSync(join(root, "state", "ipc.key"));
  const server = await createIpcServer(root, key, async body => ({ echo: body }));
  try {
    const response = await ipcRequest(root, key, { action: "health" }) as { ok: boolean; result: { echo: unknown } };
    assert.equal(response.ok, true);
    assert.deepEqual(response.result.echo, { action: "health" });
    const envelope = signEnvelope(key, { value: 1 });
    assert.equal(verifyEnvelope(key, envelope), true);
    assert.equal(verifyEnvelope(Buffer.alloc(32, 1), envelope), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
