import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadAndRender, loadConfig } from "./config.js";
import { createRateLimitEvent, templateValues } from "./event.js";
import { DurableJournal, deliveryRecord } from "./journal.js";
import { composeEml, pruneOutbox, sendRaw, smtpFromConfig, spoolToDraft, writeDraft, writeSpool, type SmtpOutcome } from "./mail.js";
import type { Config, DetectedRateLimit, RateLimitEvent } from "./types.js";
import { removeIfExists } from "./files.js";

interface Compatibility { schemaVersion: 1; transcriptDetector: Record<string, { surfaces: string[]; autoSend: boolean }> }

export function loadCompatibility(pluginRoot: string): Compatibility {
  const value = JSON.parse(readFileSync(join(pluginRoot, "compatibility.json"), "utf8")) as Compatibility;
  if (value.schemaVersion !== 1 || !value.transcriptDetector) throw new Error("compatibility_manifest_invalid");
  return value;
}

export function isCompatible(pluginRoot: string, event: DetectedRateLimit, requireAutoSend = false): boolean {
  if (event.detector === "debug-synthetic") return true;
  const entry = loadCompatibility(pluginRoot).transcriptDetector[event.codexVersion];
  return Boolean(entry && entry.surfaces.includes(event.surface) && (!requireAutoSend || entry.autoSend));
}

export interface DeliveryResult { status: string; path?: string; category?: string }

export class DeliveryEngine {
  private readonly journal: DurableJournal;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly pluginRoot: string, private readonly sender = sendRaw) {
    pruneOutbox(root);
    this.journal = new DurableJournal(root);
    this.journal.recoverInterrupted();
  }

  records() { return this.journal.recent(); }

  handle(detected: DetectedRateLimit, options: { forcePreview?: boolean; selfRecipient?: boolean } = {}): Promise<DeliveryResult> {
    const operation = this.queue.then(() => this.handleNow(detected, options));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async handleNow(detected: DetectedRateLimit, options: { forcePreview?: boolean; selfRecipient?: boolean }): Promise<DeliveryResult> {
    const config = loadConfig(this.root);
    const debug = detected.detector === "debug-synthetic" || options.forcePreview;
    if (!debug && !isCompatible(this.pluginRoot, detected, config.autoSend)) return this.suppress(detected, config, "unsupported_version_or_surface");
    const installKey = readFileSync(join(this.root, "state", "install.key"));
    const event = createRateLimitEvent(detected, config, installKey);
    const rendered = loadAndRender(this.root, config, templateValues(event, config));
    const recipient = debug || options.selfRecipient ? config.userEmail : config.tiboEmail;
    const from = config.smtp?.fromEmail || config.userEmail;
    const eml = composeEml({ fromEmail: from, toEmail: recipient, replyTo: config.userEmail, subject: rendered.subject, body: rendered.body, id: event.eventId });
    if (debug) return { status: "preview", path: writeDraft(this.root, eml, `preview-${event.eventId.slice(0, 16)}`, true) };
    if (this.journal.hasWindow(event.windowKey)) return this.suppressEvent(event, "duplicate_window");
    if (!config.autoSend) {
      const now = new Date().toISOString();
      const path = writeDraft(this.root, eml, event.eventId.slice(0, 16));
      this.journal.append(deliveryRecord(event.eventId, event.windowKey, "drafted", now, { draftName: basename(path) }));
      return { status: "drafted", path };
    }
    if (this.journal.rollingCount() >= config.policy.maxPerRolling30Days) return this.suppressEvent(event, "rolling_30_day_limit");
    let credentials: ReturnType<typeof smtpFromConfig>;
    try { credentials = smtpFromConfig(config); } catch {
      const now = new Date().toISOString();
      const path = writeDraft(this.root, eml, event.eventId.slice(0, 16));
      this.journal.append(deliveryRecord(event.eventId, event.windowKey, "drafted", now, { category: "smtp_preflight", draftName: basename(path) }));
      return { status: "drafted", path, category: "smtp_preflight" };
    }
    const now = new Date().toISOString();
    const spool = writeSpool(this.root, eml, event.eventId.slice(0, 16));
    this.journal.append(deliveryRecord(event.eventId, event.windowKey, "reserved", now));
    let outcome: SmtpOutcome;
    try { outcome = await this.sender(credentials.smtp, credentials.password, { from: credentials.smtp.fromEmail, to: config.tiboEmail }, eml); }
    catch { outcome = { status: "unknown", category: "sender_threw" }; }
    if (outcome.status === "accepted") {
      removeIfExists(spool);
      this.journal.append({ ...deliveryRecord(event.eventId, event.windowKey, "accepted", now), reservedAt: now });
      return { status: "accepted" };
    }
    if (outcome.status === "unknown") {
      this.journal.append({ ...deliveryRecord(event.eventId, event.windowKey, "unknown", now, { category: outcome.category }), reservedAt: now });
      return { status: "unknown", category: outcome.category };
    }
    const path = spoolToDraft(this.root, spool);
    this.journal.append({ ...deliveryRecord(event.eventId, event.windowKey, "rejected", now, { category: outcome.category }), reservedAt: now });
    this.journal.append({ ...deliveryRecord(event.eventId, event.windowKey, "drafted", now, { category: "smtp_rejected", draftName: basename(path) }), reservedAt: now });
    return { status: "drafted", path, category: outcome.category };
  }

  private suppress(detected: DetectedRateLimit, config: Config, category: string): DeliveryResult {
    try {
      const event = createRateLimitEvent(detected, config, readFileSync(join(this.root, "state", "install.key")));
      return this.suppressEvent(event, category);
    } catch { return { status: "suppressed", category }; }
  }

  private suppressEvent(event: RateLimitEvent, category: string): DeliveryResult {
    const now = new Date().toISOString();
    this.journal.append(deliveryRecord(event.eventId, event.windowKey, "suppressed", now, { category }));
    return { status: "suppressed", category };
  }
}
