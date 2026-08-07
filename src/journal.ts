import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, ensureDir } from "./files.js";
import type { DeliveryRecord, DeliveryStatus } from "./types.js";

interface JournalLine { sequence: number; previousHash: string; record: Omit<DeliveryRecord, "sequence">; hash: string }

function stableLine(sequence: number, previousHash: string, record: Omit<DeliveryRecord, "sequence">): string {
  return JSON.stringify({ sequence, previousHash, record });
}

export class DurableJournal {
  readonly path: string;
  private records: DeliveryRecord[] = [];
  private lastHash = "0".repeat(64);
  private sequence = 0;

  constructor(private readonly root: string) {
    ensureDir(join(root, "state"));
    this.path = join(root, "state", "journal-1.ndjson");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as JournalLine;
      const expected = createHash("sha256").update(stableLine(parsed.sequence, parsed.previousHash, parsed.record)).digest("hex");
      if (parsed.previousHash !== this.lastHash || parsed.hash !== expected || parsed.sequence !== this.sequence + 1) throw new Error("journal_integrity_failure");
      this.sequence = parsed.sequence;
      this.lastHash = parsed.hash;
      this.records.push({ sequence: parsed.sequence, ...parsed.record });
    }
  }

  recoverInterrupted(now = new Date().toISOString()): void {
    const latest = this.latestByWindow();
    for (const record of latest.values()) if (record.status === "reserved") this.append({ ...record, status: "unknown", updatedAt: now, category: "crash_recovery" });
  }

  append(record: Omit<DeliveryRecord, "sequence">): DeliveryRecord {
    const sequence = this.sequence + 1;
    const payload = stableLine(sequence, this.lastHash, record);
    const hash = createHash("sha256").update(payload).digest("hex");
    const line: JournalLine = { sequence, previousHash: this.lastHash, record, hash };
    const fd = openSync(this.path, "a", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(line)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    this.sequence = sequence;
    this.lastHash = hash;
    const full = { sequence, ...record };
    this.records.push(full);
    if (sequence % 100 === 0) this.snapshot();
    return full;
  }

  all(): readonly DeliveryRecord[] { return this.records; }

  latestByWindow(): Map<string, DeliveryRecord> {
    const map = new Map<string, DeliveryRecord>();
    for (const record of this.records) map.set(record.windowKey, record);
    return map;
  }

  hasWindow(windowKey: string): boolean {
    return this.records.some(record => record.windowKey === windowKey && record.status !== "suppressed");
  }

  rollingCount(now = Date.now()): number {
    const cutoff = now - 30 * 86400_000;
    const counted = new Set<string>();
    for (const record of this.records) {
      if ((record.status === "accepted" || record.status === "unknown") && Date.parse(record.reservedAt) >= cutoff) counted.add(record.windowKey);
    }
    return counted.size;
  }

  recent(limit = 10): DeliveryRecord[] { return this.records.slice(-limit); }

  private snapshot(): void {
    atomicWrite(join(this.root, "state", `snapshot-${this.sequence}.json`), `${JSON.stringify({ sequence: this.sequence, hash: this.lastHash, latest: [...this.latestByWindow().values()] })}\n`);
  }
}

export function deliveryRecord(eventId: string, windowKey: string, status: DeliveryStatus, now: string, extra: Partial<Omit<DeliveryRecord, "sequence" | "eventIdHash" | "windowKey" | "status" | "reservedAt" | "updatedAt">> = {}): Omit<DeliveryRecord, "sequence"> {
  return { eventIdHash: eventId.slice(0, 16), windowKey, status, reservedAt: now, updatedAt: now, ...extra };
}
