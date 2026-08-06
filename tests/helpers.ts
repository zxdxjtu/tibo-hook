import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSkeleton, initializeDataRoot } from "../src/config.js";
import type { Config, DetectedRateLimit } from "../src/types.js";

export const pluginRoot = resolve("plugins/tibo-hook");

export function tempData(overrides: Partial<Config> = {}): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "tibo-hook-test-"));
  initializeDataRoot(root);
  const config: Config = {
    ...configSkeleton(),
    tiboEmail: "reviewer@example.com",
    userEmail: "developer@example.net",
    requesterName: "Test Developer",
    useCase: "I use Codex to maintain a real open source developer tool.",
    impact: "Additional capacity would unblock scheduled maintenance and testing work.",
    feedback: "The structured workflow is useful, and the limit interrupted a verified task.",
    ...overrides
  };
  writeFileSync(join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(join(root, "config.json"), 0o600);
  return { root, config };
}

export function event(turnId: string, resetAt: string | null = "2026-08-07T12:00:00.000Z", version = "0.144.3"): DetectedRateLimit {
  return {
    schemaVersion: 1,
    sessionId: "test-session",
    turnId,
    occurredAt: "2026-08-06T10:00:01.000Z",
    surface: "codex-cli",
    model: "gpt-test",
    codexVersion: version,
    errorCode: "usage_limit_exceeded",
    limitKind: "rate_limit_reached",
    resetAt,
    detector: "transcript-experimental"
  };
}
