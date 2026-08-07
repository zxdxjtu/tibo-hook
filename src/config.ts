import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_SUBJECT, DEFAULT_TEMPLATE } from "./constants.js";
import { assertPrivatePermissions, atomicWrite, createExclusive, ensureDir, readSafeFile } from "./files.js";
import type { Config, SmtpConfig } from "./types.js";

const ROOT_KEYS = new Set(["schemaVersion", "tiboEmail", "userEmail", "requesterName", "useCase", "impact", "feedback", "templatePath", "subjectTemplate", "autoSend", "smtp", "debug", "policy"]);
const SMTP_KEYS = new Set(["host", "port", "security", "username", "fromEmail", "passwordEnv", "timeoutMs"]);
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function configSkeleton(): Config {
  return {
    schemaVersion: 1,
    tiboEmail: "",
    userEmail: "",
    requesterName: "",
    useCase: "",
    impact: "",
    feedback: "",
    templatePath: "templates/request.txt",
    subjectTemplate: DEFAULT_SUBJECT,
    autoSend: false,
    smtp: {
      host: "",
      port: 587,
      security: "starttls-required",
      username: "",
      fromEmail: "",
      passwordEnv: "TIBO_HOOK_SMTP_PASSWORD",
      timeoutMs: 15000
    },
    debug: { triggerNextPrompt: false },
    policy: { maxPerRolling30Days: 3 }
  };
}

export function initializeDataRoot(root: string): string[] {
  const created: string[] = [];
  const statePath = join(root, "state");
  const hasDurableState = existsSync(join(root, "config.json")) || existsSync(join(statePath, "install.key")) || (existsSync(statePath) && readdirSync(statePath).length > 0);
  for (const dir of [root, join(root, "templates"), join(root, "state"), join(root, "outbox", "spool"), join(root, "outbox", "drafts"), join(root, "outbox", "previews"), join(root, "logs")]) {
    if (!existsSync(dir)) created.push(dir);
    ensureDir(dir);
  }
  const files: Array<[string, string | Buffer]> = [
    [join(root, "config.json"), `${JSON.stringify(configSkeleton(), null, 2)}\n`],
    [join(root, "templates", "request.txt"), DEFAULT_TEMPLATE]
  ];
  if (!hasDurableState) files.push([join(root, "state", "install.key"), randomBytes(32)], [join(root, "state", "ipc.key"), randomBytes(32)]);
  for (const [path, data] of files) if (createExclusive(path, data)) created.push(path);
  return created;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_must_be_object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, name: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}_unknown_field:${key}`);
}

function text(value: unknown, name: string, min: number, max: number, multiline = false): string {
  if (typeof value !== "string") throw new Error(`${name}_must_be_string`);
  const length = [...value].length;
  if (length < min || length > max) throw new Error(`${name}_length`);
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\r" || char === "\0" || (code < 32 && !(multiline && (char === "\n" || char === "\t"))) || code === 127) throw new Error(`${name}_control_character`);
  }
  return value;
}

export function validateEmail(value: unknown, name: string): string {
  const email = text(value, name, 3, 254).trim();
  if (!EMAIL.test(email) || email.includes(",") || email.includes(";")) throw new Error(`${name}_invalid`);
  return email;
}

function parseSmtp(raw: unknown, required: boolean): SmtpConfig | undefined {
  if (raw === undefined && !required) return undefined;
  const smtp = object(raw, "smtp");
  onlyKeys(smtp, SMTP_KEYS, "smtp");
  const port = smtp.port;
  const security = smtp.security;
  if (port !== 587 && port !== 465) throw new Error("smtp_port_invalid");
  if (security !== "starttls-required" && security !== "implicit-tls") throw new Error("smtp_security_invalid");
  if ((port === 587) !== (security === "starttls-required")) throw new Error("smtp_security_port_mismatch");
  const passwordEnv = smtp.passwordEnv ?? "TIBO_HOOK_SMTP_PASSWORD";
  if (typeof passwordEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) throw new Error("smtp_password_env_invalid");
  const timeoutMs = smtp.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 60000) throw new Error("smtp_timeout_invalid");
  return {
    host: text(smtp.host, "smtp.host", 1, 253),
    port,
    security,
    username: text(smtp.username, "smtp.username", 1, 320),
    fromEmail: validateEmail(smtp.fromEmail, "smtp.fromEmail"),
    passwordEnv,
    timeoutMs: timeoutMs as number
  };
}

export function parseConfig(raw: unknown, allowIncomplete = false): Config {
  const value = object(raw, "config");
  onlyKeys(value, ROOT_KEYS, "config");
  if (value.schemaVersion !== 1) throw new Error("schema_version_invalid");
  const autoSend = value.autoSend ?? false;
  if (typeof autoSend !== "boolean") throw new Error("auto_send_must_be_boolean");
  const debug = object(value.debug ?? { triggerNextPrompt: false }, "debug");
  onlyKeys(debug, new Set(["triggerNextPrompt"]), "debug");
  if (typeof (debug.triggerNextPrompt ?? false) !== "boolean") throw new Error("debug_trigger_must_be_boolean");
  const policy = object(value.policy ?? { maxPerRolling30Days: 3 }, "policy");
  onlyKeys(policy, new Set(["maxPerRolling30Days"]), "policy");
  const maximum = policy.maxPerRolling30Days ?? 3;
  if (!Number.isInteger(maximum) || (maximum as number) < 1 || (maximum as number) > 3) throw new Error("policy_max_invalid");
  const requiredText = (v: unknown, name: string, min: number, max: number, multi = false) => allowIncomplete && v === "" ? "" : text(v, name, min, max, multi);
  const tiboEmail = allowIncomplete && value.tiboEmail === "" ? "" : validateEmail(value.tiboEmail, "tiboEmail");
  const userEmail = allowIncomplete && value.userEmail === "" ? "" : validateEmail(value.userEmail, "userEmail");
  if (tiboEmail && userEmail && tiboEmail.normalize("NFC").toLowerCase() === userEmail.normalize("NFC").toLowerCase()) throw new Error("recipient_must_differ_from_user");
  const subjectTemplate = value.subjectTemplate ?? DEFAULT_SUBJECT;
  text(subjectTemplate, "subjectTemplate", 1, 1000);
  if ((subjectTemplate as string).includes("\n")) throw new Error("subject_header_injection");
  const smtpObject = value.smtp === undefined ? undefined : object(value.smtp, "smtp");
  const smtpIsBlankSkeleton = !autoSend && smtpObject && smtpObject.host === "" && smtpObject.username === "" && smtpObject.fromEmail === "";
  return {
    schemaVersion: 1,
    tiboEmail,
    userEmail,
    requesterName: requiredText(value.requesterName, "requesterName", 1, 120),
    useCase: requiredText(value.useCase, "useCase", 20, 2000, true),
    impact: requiredText(value.impact, "impact", 20, 2000, true),
    feedback: requiredText(value.feedback, "feedback", 20, 2000, true),
    templatePath: value.templatePath === undefined ? "templates/request.txt" : text(value.templatePath, "templatePath", 1, 500),
    subjectTemplate: subjectTemplate as string,
    autoSend,
    ...(!smtpIsBlankSkeleton && (value.smtp !== undefined || autoSend) ? { smtp: parseSmtp(value.smtp, autoSend)! } : {}),
    debug: { triggerNextPrompt: debug.triggerNextPrompt as boolean ?? false },
    policy: { maxPerRolling30Days: maximum as number }
  };
}

export function loadConfig(root: string, allowIncomplete = false): Config {
  const path = join(root, "config.json");
  const lst = lstatSync(path);
  if (!lst.isFile() || lst.isSymbolicLink() || statSync(path).size > 64 * 1024) throw new Error("unsafe_config_file");
  assertPrivatePermissions(path, 0o600);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")), allowIncomplete);
}

export const TEMPLATE_VARIABLES = new Set(["requesterName", "userEmail", "useCase", "impact", "feedback", "occurredAt", "surface", "model", "codexVersion", "limitKind", "resetAt"]);

export function renderTemplate(template: string, values: Record<string, string>, maxBytes = 10 * 1024): string {
  const tokens = [...template.matchAll(/{{\s*([^{}]+?)\s*}}/g)];
  const residue = template.replace(/{{\s*([^{}]+?)\s*}}/g, "");
  if (residue.includes("{{") || residue.includes("}}")) throw new Error("template_unclosed_placeholder");
  for (const token of tokens) if (!TEMPLATE_VARIABLES.has(token[1]!)) throw new Error(`template_unknown_variable:${token[1]}`);
  const rendered = template.replace(/{{\s*([^{}]+?)\s*}}/g, (_all, key: string) => {
    const value = values[key];
    if (value === undefined || value === "") throw new Error(`template_missing_value:${key}`);
    return value;
  });
  if (Buffer.byteLength(rendered, "utf8") > maxBytes) throw new Error("rendered_body_too_large");
  return rendered;
}

export function loadAndRender(root: string, config: Config, values: Record<string, string>): { subject: string; body: string } {
  const template = readSafeFile(root, config.templatePath, 64 * 1024).text;
  const subject = renderTemplate(config.subjectTemplate, values, 4096);
  if ([...subject].length > 200 || /[\r\n\0]/.test(subject)) throw new Error("rendered_subject_invalid");
  return { subject, body: renderTemplate(template, values) };
}

export function setDebugNext(root: string, next: boolean): void {
  const path = join(root, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const debug = object(raw.debug ?? {}, "debug");
  raw.debug = { ...debug, triggerNextPrompt: next };
  parseConfig(raw, true);
  atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export function consumeDebugNext(root: string): boolean {
  const path = join(root, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const config = object(raw, "config");
  const debug = object(config.debug ?? {}, "debug");
  if (debug.triggerNextPrompt !== true) return false;
  config.debug = { ...debug, triggerNextPrompt: false };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}
