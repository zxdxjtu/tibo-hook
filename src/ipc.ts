import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { ensureDir, removeIfExists } from "./files.js";
import { PROTOCOL_VERSION, VERSION } from "./constants.js";

export interface IpcEnvelope { protocolVersion: 1; version: string; requestId: string; nonce: string; body: unknown; hmac: string }

function unsigned(envelope: Omit<IpcEnvelope, "hmac">): string { return JSON.stringify(envelope); }

export function signEnvelope(key: Buffer, body: unknown): IpcEnvelope {
  const base = { protocolVersion: PROTOCOL_VERSION as 1, version: VERSION, requestId: randomBytes(8).toString("hex"), nonce: randomBytes(16).toString("hex"), body };
  return { ...base, hmac: createHmac("sha256", key).update(unsigned(base)).digest("hex") };
}

export function verifyEnvelope(key: Buffer, envelope: IpcEnvelope): boolean {
  if (envelope.protocolVersion !== 1 || envelope.version !== VERSION || typeof envelope.hmac !== "string") return false;
  const { hmac, ...base } = envelope;
  const expected = createHmac("sha256", key).update(unsigned(base)).digest();
  let actual: Buffer;
  try { actual = Buffer.from(hmac, "hex"); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function endpointFor(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\tibo-hook-${hash}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().username.replace(/[^A-Za-z0-9]/g, "_");
  const directory = join(tmpdir(), `tibo-hook-${uid}-${hash}`);
  ensureDir(directory);
  return join(directory, "supervisor.sock");
}

export function createIpcServer(root: string, key: Buffer, handler: (body: unknown) => Promise<unknown>): Promise<Server> {
  const endpoint = endpointFor(root);
  if (process.platform !== "win32") removeIfExists(endpoint);
  return new Promise((resolve, reject) => {
    const server = createServer(socket => {
      let data = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("data", chunk => {
        if (handled) { socket.destroy(); return; }
        data += chunk;
        if (Buffer.byteLength(data) > 64 * 1024) socket.destroy();
        const newline = data.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        const line = data.slice(0, newline);
        data = "";
        void (async () => {
          try {
            const envelope = JSON.parse(line) as IpcEnvelope;
            if (!verifyEnvelope(key, envelope)) throw new Error("ipc_auth_failed");
            const result = await handler(envelope.body);
            socket.end(`${JSON.stringify(signEnvelope(key, { ok: true, result, requestId: envelope.requestId }))}\n`);
          } catch { socket.end(`${JSON.stringify(signEnvelope(key, { ok: false }))}\n`); }
        })();
      });
    });
    server.once("error", reject);
    server.listen(endpoint, () => {
      if (process.platform !== "win32") chmodSync(endpoint, 0o600);
      resolve(server);
    });
  });
}

export function ipcRequest(root: string, key: Buffer, body: unknown, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpointFor(root));
    const request = signEnvelope(key, body);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("ipc_timeout")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const envelope = JSON.parse(data.slice(0, newline)) as IpcEnvelope;
        if (!verifyEnvelope(key, envelope)) throw new Error("ipc_response_auth_failed");
        const responseBody = envelope.body as { requestId?: unknown };
        if (!responseBody || responseBody.requestId !== request.requestId) throw new Error("ipc_challenge_failed");
        resolve(envelope.body);
      } catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}
