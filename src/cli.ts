import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { initializeDataRoot, loadAndRender, loadConfig, setDebugNext } from "./config.js";
import { VERSION } from "./constants.js";
import { loadCompatibility } from "./engine.js";
import { assertPrivatePermissions, resolveDataRoot } from "./files.js";
import { composeEml, sendRaw, smtpFromConfig, writeDraft } from "./mail.js";
import { templateValues } from "./event.js";
import type { DetectedRateLimit, DeliveryRecord } from "./types.js";
import { ipcRequest } from "./ipc.js";
import { DurableJournal } from "./journal.js";

export class CliError extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }

function dataRoot(): string {
  try { return resolveDataRoot(); } catch (error) { throw new CliError((error as Error).message, 3); }
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "invalid";
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
}

function synthetic(configuredVersion = "0.144.3"): DetectedRateLimit {
  return {
    schemaVersion: 1,
    sessionId: "preview-session",
    turnId: `preview-${Date.now()}`,
    occurredAt: new Date().toISOString(),
    surface: "codex-cli",
    model: "preview-model",
    codexVersion: configuredVersion,
    errorCode: "usage_limit_exceeded",
    limitKind: "Codex usage",
    resetAt: null,
    detector: "debug-synthetic"
  };
}

function cleanupPreviews(root: string): void {
  const cutoff = Date.now() - 30 * 86400_000;
  for (const folder of [join(root, "outbox", "previews"), join(root, "outbox", "drafts")]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      try { if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* best effort */ }
    }
  }
}

function formatRecord(record: DeliveryRecord): string {
  return `${record.updatedAt} ${record.eventIdHash} ${record.status}${record.category ? ` ${record.category}` : ""}`;
}

export async function runCli(args: string[], pluginRoot: string): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "help") {
    process.stdout.write("Usage: tibo-hook <init|config path|validate|preview|debug-next|smtp-test --to-self|status>\n");
    return 0;
  }
  if (command === "--version" || command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
  const root = dataRoot();
  if (command === "init") {
    const created = initializeDataRoot(root);
    process.stdout.write(created.length ? `Created:\n${created.map(path => `- ${path}`).join("\n")}\nEdit ${join(root, "config.json")} and run tibo-hook validate.\n` : `Already initialized: ${root}\n`);
    return 0;
  }
  if (command === "config" && args[1] === "path") {
    const config = loadConfig(root, true);
    process.stdout.write(`${join(root, "config.json")}\n${resolve(root, config.templatePath)}\n`);
    return 0;
  }
  if (command === "validate") {
    const checks: Array<[string, "PASS" | "WARN" | "FAIL", string]> = [];
    checks.push(["Node.js", Number(process.versions.node.split(".")[0]) >= 20 ? "PASS" : "FAIL", process.versions.node]);
    try { assertPrivatePermissions(root, 0o700); checks.push(["PLUGIN_DATA permissions", "PASS", process.platform === "win32" ? "platform ACL check is best effort" : "0700"]); }
    catch (error) { checks.push(["PLUGIN_DATA permissions", "FAIL", (error as Error).message]); }
    for (const name of ["install.key", "ipc.key"]) {
      const path = join(root, "state", name);
      try {
        assertPrivatePermissions(path, 0o600);
        if (readFileSync(path).length !== 32) throw new Error("invalid_length");
        checks.push([name, "PASS", "private 32-byte key"]);
      } catch (error) { checks.push([name, "FAIL", (error as Error).message]); }
    }
    let config;
    try { config = loadConfig(root); checks.push(["config", "PASS", "schema v1"]); }
    catch (error) { checks.push(["config", "FAIL", (error as Error).message]); config = undefined; }
    if (config) {
      try { loadAndRender(root, config, templateValues(synthetic(), config)); checks.push(["template", "PASS", config.templatePath]); }
      catch (error) { checks.push(["template", "FAIL", (error as Error).message]); }
      if (config.autoSend) checks.push(["SMTP password", process.env[config.smtp!.passwordEnv] ? "PASS" : "FAIL", process.env[config.smtp!.passwordEnv] ? "available" : "not visible to this process"]);
    }
    checks.push(["hook config", existsSync(join(pluginRoot, "hooks", "hooks.json")) ? "PASS" : "FAIL", join(pluginRoot, "hooks", "hooks.json")]);
    const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
    checks.push(["transcript storage", existsSync(join(codexHome, "sessions")) ? "PASS" : "WARN", existsSync(join(codexHome, "sessions")) ? "sessions directory available" : "sessions directory not found; real detector unavailable"]);
    const cli = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 3000 });
    const version = /codex-cli\s+([^\s]+)/.exec(cli.stdout ?? "")?.[1];
    const compatible = version ? Boolean(loadCompatibility(pluginRoot).transcriptDetector[version]) : false;
    checks.push(["Codex detector", compatible ? "PASS" : "WARN", version ? `version ${version}${compatible ? " compatible" : " is not allowlisted"}` : "Codex CLI version unavailable"]);
    for (const [name, state, detail] of checks) process.stdout.write(`${state} ${name}: ${detail}\n`);
    return checks.some(([, state]) => state === "FAIL") ? 2 : 0;
  }
  if (command === "preview") {
    const config = loadConfig(root);
    const event = synthetic();
    const rendered = loadAndRender(root, config, templateValues(event, config));
    const eml = composeEml({ fromEmail: config.smtp?.fromEmail || config.userEmail, toEmail: config.userEmail, replyTo: config.userEmail, subject: rendered.subject, body: rendered.body });
    const path = writeDraft(root, eml, `manual-preview-${Date.now()}`, true);
    cleanupPreviews(root);
    process.stdout.write(`Preview: ${path}\nSubject: ${rendered.subject}\nTo: ${maskEmail(config.userEmail)}\n`);
    return 0;
  }
  if (command === "debug-next") {
    loadConfig(root, true);
    setDebugNext(root, true);
    process.stdout.write("Armed once: the next prompt will create a self-addressed preview with no SMTP connection and no quota use.\n");
    return 0;
  }
  if (command === "smtp-test") {
    if (args.length !== 2 || args[1] !== "--to-self") throw new CliError("smtp-test requires exactly --to-self", 2);
    const config = loadConfig(root);
    const { smtp, password } = smtpFromConfig(config);
    const raw = composeEml({ fromEmail: smtp.fromEmail, toEmail: config.userEmail, replyTo: config.userEmail, subject: "tibo-hook SMTP self-test", body: "This is a local tibo-hook SMTP self-test sent only to the configured userEmail.\n" });
    const outcome = await sendRaw(smtp, password, { from: smtp.fromEmail, to: config.userEmail }, raw);
    process.stdout.write(`SMTP self-test: ${outcome.status}\n`);
    return outcome.status === "accepted" ? 0 : 4;
  }
  if (command === "status") {
    const records = new DurableJournal(root).recent();
    const lock = join(root, "state", "supervisor.lock", "metadata.json");
    let supervisor = "stopped";
    if (existsSync(lock)) {
      try {
        const key = readFileSync(join(root, "state", "ipc.key"));
        await ipcRequest(root, key, { action: "health" }, 500);
        supervisor = "healthy";
      } catch { supervisor = "unreachable-or-stale"; }
    }
    process.stdout.write(`Supervisor: ${supervisor}\n`);
    process.stdout.write(records.length ? `${records.map(formatRecord).join("\n")}\n` : "No delivery records.\n");
    return 0;
  }
  throw new CliError(`unknown command: ${args.join(" ")}`, 2);
}
