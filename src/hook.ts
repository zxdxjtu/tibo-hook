import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { preflightTranscript } from "./detector.js";
import { diagnostic, errorCategory } from "./diagnostics.js";
import { ipcRequest } from "./ipc.js";
import type { HookProjection, TurnRegistration } from "./types.js";

const MAX_INPUT = 16 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_INPUT) throw new Error("hook_input_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function project(raw: unknown): HookProjection {
  if (!raw || typeof raw !== "object") throw new Error("hook_input_invalid");
  const value = raw as Record<string, unknown>;
  const sessionId = value.session_id ?? value.sessionId;
  const turnId = value.turn_id ?? value.turnId;
  const transcriptPath = value.transcript_path ?? value.transcriptPath;
  const model = value.model;
  if (![sessionId, turnId, model].every(item => typeof item === "string" && item.length > 0)) throw new Error("hook_metadata_missing");
  return { sessionId: sessionId as string, turnId: turnId as string, transcriptPath: typeof transcriptPath === "string" ? transcriptPath : "", model: model as string };
}

async function requestWithStart(root: string, pluginRoot: string, body: unknown): Promise<unknown> {
  const key = readFileSync(`${root}/state/ipc.key`);
  try {
    const response = await ipcRequest(root, key, body) as { ok?: boolean; result?: unknown };
    if (response.ok) return response.result;
  } catch { /* start below */ }
  const child = spawn(process.execPath, [process.argv[1]!, "supervisor"], { detached: true, stdio: "ignore", env: { ...process.env, PLUGIN_DATA: root, TIBO_HOOK_PLUGIN_ROOT: pluginRoot } });
  child.unref();
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      const response = await ipcRequest(root, key, body, 250) as { ok?: boolean; result?: unknown };
      if (response.ok) return response.result;
    } catch { /* retry */ }
  }
  throw new Error("supervisor_unavailable");
}

export async function runHook(eventName: string, root: string, pluginRoot: string): Promise<void> {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) as unknown : {};
    if (eventName === "SessionStart") { await requestWithStart(root, pluginRoot, { action: "health" }); return; }
    const projection = project(input);
    if (eventName === "Stop") { await requestWithStart(root, pluginRoot, { action: "stop", sessionId: projection.sessionId, turnId: projection.turnId }); return; }
    if (eventName !== "UserPromptSubmit") return;
    const probe = await requestWithStart(root, pluginRoot, { action: "debug-probe", sessionId: projection.sessionId, turnId: projection.turnId, model: projection.model }) as { debug?: boolean };
    if (probe?.debug) return;
    if (!projection.transcriptPath) throw new Error("transcript_path_missing");
    const preflight = preflightTranscript(projection.transcriptPath);
    const registration: TurnRegistration = {
      protocolVersion: 1,
      ...projection,
      codexVersion: preflight.codexVersion,
      surface: preflight.surface,
      fileIdentity: preflight.fileIdentity,
      startOffset: preflight.startOffset,
      registeredAt: new Date().toISOString()
    };
    await requestWithStart(root, pluginRoot, { action: "register", registration });
  } catch (error) { diagnostic(root, errorCategory(`hook_${eventName}`, error)); }
}
