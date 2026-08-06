import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./files.js";

export function diagnostic(root: string, category: string, eventIdHash?: string): void {
  try {
    const directory = join(root, "logs");
    ensureDir(directory);
    const path = join(directory, "diagnostic.log");
    if (existsSync(path) && statSync(path).size >= 1024 * 1024) {
      for (let index = 2; index >= 0; index--) {
        const source = index === 0 ? path : `${path}.${index}`;
        const destination = `${path}.${index + 1}`;
        if (existsSync(source)) renameSync(source, destination);
      }
    }
    const safe = category.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), category: safe, ...(eventIdHash ? { eventIdHash: eventIdHash.slice(0, 16) } : {}) })}\n`, { mode: 0o600 });
  } catch { /* diagnostics never affect Codex */ }
}

export function errorCategory(prefix: string, error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  const safeCode = /^[A-Z0-9_]{1,40}$/.test(code) ? code : "";
  return safeCode ? `${prefix}:${safeCode}` : prefix;
}
