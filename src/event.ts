import { createHmac } from "node:crypto";
import type { Config, DetectedRateLimit, RateLimitEvent } from "./types.js";

function tuple(...parts: string[]): Buffer {
  return Buffer.concat(parts.map(part => {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }));
}

export function keyedId(key: Buffer, domain: string, ...parts: string[]): string {
  return createHmac("sha256", key).update(tuple(domain, ...parts)).digest("hex");
}

export function utcBucket(occurredAt: string): string {
  return occurredAt.slice(0, 10);
}

export function createRateLimitEvent(detected: DetectedRateLimit, config: Config, installKey: Buffer): RateLimitEvent {
  if (installKey.length !== 32) throw new Error("install_key_invalid");
  const user = config.userEmail.trim().normalize("NFC").toLowerCase();
  const recipient = config.tiboEmail.trim().normalize("NFC").toLowerCase();
  const kind = detected.limitKind ?? "Codex usage";
  const window = detected.resetAt ?? `utc-day:${utcBucket(detected.occurredAt)}`;
  return {
    ...detected,
    eventId: keyedId(installKey, "event-v1", detected.sessionId, detected.turnId, detected.occurredAt, detected.errorCode),
    windowKey: keyedId(installKey, "window-v1", user, recipient, kind, window)
  };
}

export function templateValues(event: DetectedRateLimit, config: Config): Record<string, string> {
  return {
    requesterName: config.requesterName,
    userEmail: config.userEmail,
    useCase: config.useCase,
    impact: config.impact,
    feedback: config.feedback,
    occurredAt: event.occurredAt,
    surface: event.surface,
    model: event.model || "unknown",
    codexVersion: event.codexVersion,
    limitKind: event.limitKind ?? "Codex usage",
    resetAt: event.resetAt ?? "not reported by Codex"
  };
}
