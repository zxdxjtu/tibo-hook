import assert from "node:assert/strict";
import test from "node:test";
import { classifySmtpError, composeEml, smtpTransportOptions } from "../src/mail.js";
import type { SmtpConfig } from "../src/types.js";

const base: SmtpConfig = { host: "smtp.example.com", port: 587, security: "starttls-required", username: "user", fromEmail: "user@example.com", passwordEnv: "PASSWORD", timeoutMs: 12345 };

test("SMTP options require TLS, certificate checks, auth, and configured timeouts", () => {
  const starttls = smtpTransportOptions(base, "secret");
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.connectionTimeout, 12345);
  assert.equal(starttls.tls?.rejectUnauthorized, true);
  assert.equal(starttls.tls?.servername, "smtp.example.com");
  const implicit = smtpTransportOptions({ ...base, port: 465, security: "implicit-tls" }, "secret");
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
});

test("only confirmed pre-DATA failures are classified rejected", () => {
  assert.deepEqual(classifySmtpError({ command: "AUTH", code: "EAUTH" }), { status: "rejected", category: "EAUTH" });
  assert.deepEqual(classifySmtpError({ command: "DATA", code: "ETIMEDOUT" }), { status: "unknown", category: "ETIMEDOUT" });
  assert.equal(classifySmtpError(new Error("connection vanished")).status, "unknown");
});

test("raw message rejects header injection and has no HTML, CC, or BCC", () => {
  const raw = composeEml({ fromEmail: "user@example.com", toEmail: "reviewer@example.net", replyTo: "user@example.com", subject: "Plain text", body: "Hello" }).toString("utf8");
  assert.match(raw, /Content-Type: text\/plain/);
  assert.doesNotMatch(raw, /\r\n(?:Cc|Bcc):|text\/html/i);
  assert.throws(() => composeEml({ fromEmail: "user@example.com", toEmail: "reviewer@example.net\r\nBcc: x@example.com", replyTo: "user@example.com", subject: "x", body: "x" }), /header_injection/);
});
