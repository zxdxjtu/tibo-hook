import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { atomicWrite, ensureDir } from "./files.js";
import type { Config, SmtpConfig } from "./types.js";

function header(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("header_injection");
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function composeEml(input: { fromEmail: string; toEmail: string; replyTo: string; subject: string; body: string; date?: Date; id?: string }): Buffer {
  const date = input.date ?? new Date();
  const id = input.id ?? randomBytes(16).toString("hex");
  for (const email of [input.fromEmail, input.toEmail, input.replyTo]) if (/[\r\n\0]/.test(email)) throw new Error("header_injection");
  return Buffer.from([
    `From: ${input.fromEmail}`,
    `To: ${input.toEmail}`,
    `Reply-To: ${input.replyTo}`,
    `Subject: ${header(input.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@tibo-hook.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.body),
    ""
  ].join("\r\n"), "utf8");
}

export function writeDraft(root: string, eml: Buffer, name: string, preview = false): string {
  const directory = join(root, "outbox", preview ? "previews" : "drafts");
  ensureDir(directory);
  const path = join(directory, `${name}.eml`);
  atomicWrite(path, eml);
  return path;
}

export function writeSpool(root: string, eml: Buffer, name: string): string {
  const directory = join(root, "outbox", "spool");
  ensureDir(directory);
  const path = join(directory, `${name}.eml`);
  atomicWrite(path, eml);
  return path;
}

export function spoolToDraft(root: string, spool: string): string {
  const destination = join(root, "outbox", "drafts", basename(spool));
  ensureDir(join(root, "outbox", "drafts"));
  if (existsSync(spool)) renameSync(spool, destination);
  return destination;
}

export function pruneOutbox(root: string, now = Date.now()): void {
  const cutoff = now - 30 * 86400_000;
  for (const kind of ["drafts", "previews", "spool"]) {
    const directory = join(root, "outbox", kind);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      try { if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* retention cleanup is best effort */ }
    }
  }
}

export type SmtpOutcome = { status: "accepted" } | { status: "rejected" | "unknown"; category: string };

export function smtpTransportOptions(smtp: SmtpConfig, password: string): SMTPTransport.Options {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "implicit-tls",
    requireTLS: smtp.security === "starttls-required",
    auth: { user: smtp.username, pass: password },
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
    tls: { rejectUnauthorized: true, servername: smtp.host }
  };
}

export function classifySmtpError(error: unknown): Extract<SmtpOutcome, { status: "rejected" | "unknown" }> {
  const command = typeof error === "object" && error && "command" in error ? String((error as { command: unknown }).command).toUpperCase() : "";
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "smtp_error";
  const preSubmit = new Set(["CONN", "AUTH", "EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"]);
  return { status: preSubmit.has(command) ? "rejected" : "unknown", category: code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) };
}

export async function sendRaw(smtp: SmtpConfig, password: string, envelope: { from: string; to: string }, raw: Buffer): Promise<SmtpOutcome> {
  const options = smtpTransportOptions(smtp, password);
  const transporter = nodemailer.createTransport(options);
  try {
    const info = await transporter.sendMail({ envelope, raw });
    return info.accepted?.length ? { status: "accepted" } : { status: "rejected", category: "recipient_not_accepted" };
  } catch (error) {
    return classifySmtpError(error);
  } finally { transporter.close(); }
}

export function smtpFromConfig(config: Config): { smtp: SmtpConfig; password: string } {
  if (!config.smtp) throw new Error("smtp_config_missing");
  const password = process.env[config.smtp.passwordEnv];
  if (!password) throw new Error("smtp_password_unavailable");
  return { smtp: config.smtp, password };
}
