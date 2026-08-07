import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import type { DetectedRateLimit, Surface, TurnRegistration } from "./types.js";

const MAX_LINE = 16 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function recordObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function surfaceFrom(source: unknown, originator: unknown): Surface {
  if (source === "vscode" && originator === "Codex Desktop") return "codex-app";
  if (source === "cli" && originator === "codex-tui") return "codex-cli";
  return "unknown";
}

export function preflightTranscript(path: string): { codexVersion: string; surface: Surface; startOffset: number; fileIdentity: string } {
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error("transcript_not_regular_file");
  const fd = openSync(canonical, "r");
  let data = Buffer.alloc(0);
  try {
    const chunk = Buffer.alloc(64 * 1024);
    while (data.length <= MAX_LINE) {
      const count = readSync(fd, chunk, 0, chunk.length, data.length);
      if (count === 0) break;
      data = Buffer.concat([data, chunk.subarray(0, count)]);
      if (data.includes(0x0a)) break;
    }
  } finally { closeSync(fd); }
  const newline = data.indexOf(0x0a);
  if (newline < 0 || newline > MAX_LINE) throw new Error("session_meta_line_invalid");
  const record = recordObject(JSON.parse(data.subarray(0, newline).toString("utf8")));
  const payload = recordObject(record?.payload);
  if (record?.type !== "session_meta" || !payload || typeof payload.cli_version !== "string") throw new Error("session_meta_invalid");
  return {
    codexVersion: payload.cli_version,
    surface: surfaceFrom(payload.source, payload.originator),
    startOffset: stat.size,
    fileIdentity: process.platform === "win32" ? `${canonical}:${stat.birthtimeMs}` : `${stat.dev}:${stat.ino}`
  };
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function resetTimestamp(value: unknown, now: number): string | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) return null;
  const millis = seconds > 10_000_000_000 ? seconds : seconds * 1000;
  if (millis <= now || millis > now + 366 * 86400_000) return null;
  return new Date(millis).toISOString();
}

interface Enrichment { limitKind: string | null; resetAt: string | null }

function rateLimitEnrichment(payload: JsonObject, now: number): Enrichment | null {
  if (payload.type !== "token_count") return null;
  const limits = recordObject(payload.rate_limits);
  if (!limits) return null;
  const kind = typeof limits.rate_limit_reached_type === "string" ? limits.rate_limit_reached_type : null;
  if (!kind) return null;
  if (kind !== "rate_limit_reached") return { limitKind: kind, resetAt: null };
  const candidates: string[] = [];
  for (const field of ["primary", "secondary"]) {
    const window = recordObject(limits[field]);
    if (!window || typeof window.used_percent !== "number" || window.used_percent < 100) continue;
    const reset = resetTimestamp(window.resets_at, now);
    if (reset) candidates.push(reset);
  }
  const unique = [...new Set(candidates)];
  return { limitKind: kind, resetAt: unique.length === 1 ? unique[0]! : null };
}

export type ParseOutcome =
  | { kind: "continue" }
  | { kind: "close"; category: string }
  | { kind: "detected"; event: DetectedRateLimit };

export class TranscriptParser {
  private enrichment: Enrichment = { limitKind: null, resetAt: null };
  constructor(private readonly registration: TurnRegistration) {}

  process(line: string, now = Date.now()): ParseOutcome {
    let record: JsonObject | null;
    try { record = recordObject(JSON.parse(line)); } catch { return { kind: "close", category: "partial_or_invalid_jsonl" }; }
    if (!record || typeof record.type !== "string") return { kind: "close", category: "schema_drift" };
    if (record.type !== "event_msg") return { kind: "continue" };
    const payload = recordObject(record.payload);
    if (!payload || typeof payload.type !== "string") return { kind: "close", category: "schema_drift" };
    const next = rateLimitEnrichment(payload, now);
    if (next) { this.enrichment = next; return { kind: "continue" }; }
    if (payload.type === "turn_aborted" || payload.type === "turn_complete") return { kind: "close", category: "terminal_event" };
    if (payload.type !== "error") return { kind: "continue" };
    if (payload.codex_error_info !== "usage_limit_exceeded") return { kind: "close", category: "non_target_error" };
    const occurredAt = isoTimestamp(record.timestamp);
    if (!occurredAt) return { kind: "close", category: "invalid_error_timestamp" };
    return {
      kind: "detected",
      event: {
        schemaVersion: 1,
        sessionId: this.registration.sessionId,
        turnId: this.registration.turnId,
        occurredAt,
        surface: this.registration.surface,
        model: this.registration.model,
        codexVersion: this.registration.codexVersion,
        errorCode: "usage_limit_exceeded",
        limitKind: this.enrichment.limitKind,
        resetAt: this.enrichment.resetAt,
        detector: "transcript-experimental"
      }
    };
  }
}

export class TranscriptWatcher {
  private offset: number;
  private partial = "";
  private parser: TranscriptParser;
  private canonical: string;
  constructor(readonly registration: TurnRegistration) {
    this.offset = registration.startOffset;
    this.parser = new TranscriptParser(registration);
    this.canonical = realpathSync(registration.transcriptPath);
  }

  poll(now = Date.now()): ParseOutcome {
    const canonical = realpathSync(this.registration.transcriptPath);
    const stat = statSync(canonical);
    const identity = process.platform === "win32" ? `${canonical}:${stat.birthtimeMs}` : `${stat.dev}:${stat.ino}`;
    if (!stat.isFile() || canonical !== this.canonical || identity !== this.registration.fileIdentity || stat.size < this.offset) return { kind: "close", category: "transcript_replaced_or_truncated" };
    if (stat.size === this.offset) return { kind: "continue" };
    const length = stat.size - this.offset;
    if (length > MAX_LINE) return { kind: "close", category: "appended_data_too_large" };
    const fd = openSync(canonical, "r");
    const buffer = Buffer.alloc(length);
    try { readSync(fd, buffer, 0, length, this.offset); } finally { closeSync(fd); }
    this.offset = stat.size;
    const combined = this.partial + buffer.toString("utf8");
    const lines = combined.split("\n");
    this.partial = lines.pop() ?? "";
    if (Buffer.byteLength(this.partial) > MAX_LINE) return { kind: "close", category: "line_too_large" };
    for (const line of lines) {
      if (!line) continue;
      const outcome = this.parser.process(line, now);
      if (outcome.kind !== "continue") return outcome;
    }
    return { kind: "continue" };
  }
}

export function parseFixture(path: string, registration: TurnRegistration, now = Date.now()): ParseOutcome {
  const parser = new TranscriptParser(registration);
  let last: ParseOutcome = { kind: "continue" };
  for (const line of readFileSync(path, "utf8").split("\n").slice(1)) {
    if (!line) continue;
    last = parser.process(line, now);
    if (last.kind !== "continue") return last;
  }
  return last;
}
