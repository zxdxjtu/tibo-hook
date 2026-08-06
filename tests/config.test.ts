import assert from "node:assert/strict";
import { chmodSync, existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { consumeDebugNext, initializeDataRoot, loadAndRender, loadConfig, parseConfig, renderTemplate, setDebugNext } from "../src/config.js";
import { templateValues } from "../src/event.js";
import { event, tempData } from "./helpers.js";
import { dataRootFromPluginList } from "../src/files.js";

test("configuration is strict and autoSend=false accepts blank SMTP skeleton", () => {
  const { root } = tempData();
  assert.equal(loadConfig(root).autoSend, false);
  const value = JSON.parse(JSON.stringify(loadConfig(root))) as Record<string, unknown>;
  value.typo = true;
  assert.throws(() => parseConfig(value), /unknown_field/);
  value.typo = undefined;
});

test("template is literal, immediate, and rejects unknown variables", () => {
  assert.equal(renderTemplate("Hello {{requesterName}}", { requesterName: "{{feedback}}" }), "Hello {{feedback}}");
  assert.throws(() => renderTemplate("{{unknown}}", {}), /unknown_variable/);
  const { root, config } = tempData();
  const first = loadAndRender(root, config, templateValues(event("a"), config));
  writeFileSync(join(root, "templates", "request.txt"), "Changed {{requesterName}}\n", { mode: 0o600 });
  chmodSync(join(root, "templates", "request.txt"), 0o600);
  const second = loadAndRender(root, config, templateValues(event("a"), config));
  assert.notEqual(first.body, second.body);
  assert.equal(second.body, "Changed Test Developer\n");
});

test("template path cannot escape PLUGIN_DATA", () => {
  const { root, config } = tempData({ templatePath: "../outside.txt" });
  assert.throws(() => loadAndRender(root, config, templateValues(event("a"), config)), /path_outside/);
});

test("template path cannot traverse symlinks", { skip: process.platform === "win32" }, () => {
  const { root, config } = tempData();
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "unsafe");
  symlinkSync(outside, join(root, "templates", "link.txt"));
  assert.throws(() => loadAndRender(root, { ...config, templatePath: "templates/link.txt" }, templateValues(event("a"), config)), /unsafe_file_type/);
});

test("header injection and invalid policy are rejected", () => {
  const { config } = tempData();
  assert.throws(() => parseConfig({ ...config, subjectTemplate: "hello\r\nBcc: x@example.com" }), /control_character|header_injection/);
  assert.throws(() => parseConfig({ ...config, policy: { maxPerRolling30Days: 4 } }), /policy_max_invalid/);
});

test("debug flag is consumed exactly once", () => {
  const { root } = tempData();
  setDebugNext(root, true);
  assert.equal(consumeDebugNext(root), true);
  assert.equal(consumeDebugNext(root), false);
  assert.equal(loadConfig(root).debug.triggerNextPrompt, false);
});

test("init never silently regenerates a missing installation key", () => {
  const { root } = tempData();
  const key = join(root, "state", "install.key");
  unlinkSync(key);
  initializeDataRoot(root);
  assert.equal(existsSync(key), false);
});

test("companion locator requires one enabled exact-version plugin", () => {
  const installed = { installed: [{ pluginId: "tibo-hook@tibo-hook", version: "0.1.0", installed: true, enabled: true }], available: [] };
  const fakeHome = resolve("tmp", "codex-home");
  assert.equal(dataRootFromPluginList(fakeHome, JSON.stringify(installed)), join(fakeHome, "plugins", "data", "tibo-hook-tibo-hook"));
  assert.throws(() => dataRootFromPluginList(fakeHome, JSON.stringify({ installed: [{ ...installed.installed[0], version: "0.2.0" }] })), /one_enabled_matching/);
  assert.throws(() => dataRootFromPluginList(fakeHome, JSON.stringify({ installed: [] })), /one_enabled_matching/);
});
