import assert from "node:assert/strict";
import { copyFileSync, appendFileSync, statSync, truncateSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseFixture, preflightTranscript, TranscriptWatcher } from "../src/detector.js";
import type { TurnRegistration } from "../src/types.js";
import { tempData } from "./helpers.js";

const fixtures = resolve("tests/fixtures/transcripts");

function registration(path: string, startOffset = 0): TurnRegistration {
  const preflight = preflightTranscript(path);
  return { protocolVersion: 1, sessionId: "s", turnId: "t", transcriptPath: path, fileIdentity: preflight.fileIdentity, startOffset, model: "gpt-test", codexVersion: preflight.codexVersion, surface: preflight.surface, registeredAt: "2026-08-06T09:59:00.000Z" };
}

test("only structured usage_limit_exceeded creates an event", () => {
  const path = join(fixtures, "usage-limit.jsonl");
  const outcome = parseFixture(path, registration(path), Date.parse("2026-08-06T09:00:00Z"));
  assert.equal(outcome.kind, "detected");
  if (outcome.kind === "detected") {
    assert.equal(outcome.event.errorCode, "usage_limit_exceeded");
    assert.equal(outcome.event.resetAt, "2026-08-07T02:00:00.000Z");
    assert.equal(outcome.event.surface, "codex-cli");
    assert.ok(!("message" in outcome.event));
  }
});

test("verified Codex App source and originator map to codex-app", () => {
  const path = join(fixtures, "usage-limit-app.jsonl");
  const outcome = parseFixture(path, registration(path));
  assert.equal(outcome.kind, "detected");
  if (outcome.kind === "detected") assert.equal(outcome.event.surface, "codex-app");
});

for (const [fixture, expected] of [["plain-429.jsonl", "non_target_error"], ["overloaded.jsonl", "non_target_error"], ["tool-and-stop.jsonl", "terminal_event"]] as const) {
  test(`${fixture} fails closed`, () => {
    const path = join(fixtures, fixture);
    const outcome = parseFixture(path, registration(path));
    assert.deepEqual(outcome, { kind: "close", category: expected });
  });
}

test("watcher ignores partial JSON until newline and closes on truncation", () => {
  const { root } = tempData();
  const transcript = join(root, "rollout.jsonl");
  copyFileSync(join(fixtures, "tool-and-stop.jsonl"), transcript);
  const preflight = preflightTranscript(transcript);
  const watcher = new TranscriptWatcher({ ...registration(transcript, preflight.startOffset), startOffset: preflight.startOffset });
  appendFileSync(transcript, "{\"timestamp\":");
  assert.equal(watcher.poll().kind, "continue");
  truncateSync(transcript, statSync(transcript).size - 2);
  assert.deepEqual(watcher.poll(), { kind: "close", category: "transcript_replaced_or_truncated" });
});
