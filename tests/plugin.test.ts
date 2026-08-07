import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("plugin and marketplace manifests are internally consistent", () => {
  const plugin = JSON.parse(readFileSync("plugins/tibo-hook/.codex-plugin/plugin.json", "utf8"));
  const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8"));
  const hooks = JSON.parse(readFileSync("plugins/tibo-hook/hooks/hooks.json", "utf8"));
  assert.equal(plugin.name, "tibo-hook");
  assert.equal(plugin.version, "0.1.0");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/tibo-hook");
  for (const name of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const command = hooks.hooks[name][0].hooks[0];
    assert.equal(command.timeout, 5);
    assert.match(command.command, /\$\{PLUGIN_ROOT\}/);
    assert.match(command.commandWindows, /%PLUGIN_ROOT%/);
  }
});

test("bundled default template matches the initialized contract", () => {
  const source = readFileSync("plugins/tibo-hook/templates/request.txt", "utf8");
  const bundleSource = readFileSync("src/constants.ts", "utf8");
  const match = /export const DEFAULT_TEMPLATE = `([\s\S]*?)`;/.exec(bundleSource);
  assert.equal(match?.[1], source);
});

test("marketplace bundle carries the complete third-party notice", () => {
  assert.equal(readFileSync("plugins/tibo-hook/THIRD_PARTY_NOTICES.md", "utf8"), readFileSync("THIRD_PARTY_NOTICES.md", "utf8"));
  assert.match(readFileSync("plugins/tibo-hook/THIRD_PARTY_NOTICES.md", "utf8"), /Nodemailer 9\.0\.4[\s\S]*MIT-0/);
});

test("bundle is a Node 20 CJS executable and contains no recipient default", () => {
  const bundle = resolve("plugins/tibo-hook/dist/tibo-hook.cjs");
  const result = spawnSync(process.execPath, [bundle, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0");
  const bytes = readFileSync(bundle, "utf8");
  assert.doesNotMatch(bytes, /tiboEmail\s*[:=]\s*["'][^"']+@/);
});

test("bundled public CLI initializes private data and rejects incomplete config", () => {
  const bundle = resolve("plugins/tibo-hook/dist/tibo-hook.cjs");
  const root = join(mkdtempSync(join(tmpdir(), "tibo-hook-cli-")), "data");
  const env = { ...process.env, TIBO_HOOK_PLUGIN_DATA: root };
  const init = spawnSync(process.execPath, [bundle, "init"], { encoding: "utf8", env });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /config\.json/);
  const paths = spawnSync(process.execPath, [bundle, "config", "path"], { encoding: "utf8", env });
  assert.equal(paths.status, 0, paths.stderr);
  assert.equal(paths.stdout.trim().split("\n").length, 2);
  const validate = spawnSync(process.execPath, [bundle, "validate"], { encoding: "utf8", env });
  assert.equal(validate.status, 2);
  assert.match(validate.stdout, /FAIL config/);
});
