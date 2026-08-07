import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { VERSION } from "./constants.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodExact(path, 0o700);
}

export function chmodExact(path: string, mode: number): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    chmodSync(path, mode);
  } finally {
    closeSync(fd);
  }
}

export function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  if (process.platform !== "win32") chmodExact(path, mode);
}

export function createExclusive(path: string, data: string | Buffer, mode = 0o600): boolean {
  ensureDir(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function readSafeFile(dataRoot: string, relativePath: string, maxBytes: number): { path: string; text: string } {
  if (isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("path_outside_plugin_data");
  const root = realpathSync(dataRoot);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("path_outside_plugin_data");
  const lst = lstatSync(candidate);
  if (!lst.isFile() || lst.isSymbolicLink()) throw new Error("unsafe_file_type");
  const canonical = realpathSync(candidate);
  const canonicalRel = relative(root, canonical);
  if (canonicalRel.startsWith(`..${sep}`) || canonicalRel === "..") throw new Error("path_outside_plugin_data");
  const st = statSync(canonical);
  if (st.size > maxBytes) throw new Error("file_too_large");
  return { path: canonical, text: readFileSync(canonical, "utf8") };
}

export function resolveDataRoot(): string {
  const explicit = process.env.PLUGIN_DATA ?? process.env.TIBO_HOOK_PLUGIN_DATA;
  if (explicit) return resolve(explicit);
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  const result = spawnSync("codex", ["plugin", "list", "--marketplace", "tibo-hook", "--json"], { encoding: "utf8", timeout: 5000, env: { ...process.env, CODEX_HOME: codexHome } });
  if (result.status !== 0) throw new Error("plugin_locator_failed; set TIBO_HOOK_PLUGIN_DATA to the exact installed PLUGIN_DATA directory");
  return dataRootFromPluginList(codexHome, result.stdout);
}

export function dataRootFromPluginList(codexHome: string, json: string): string {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("plugin_locator_invalid_json"); }
  if (!value || typeof value !== "object" || !Array.isArray((value as { installed?: unknown }).installed)) throw new Error("plugin_locator_invalid_shape");
  const matches = ((value as { installed: unknown[] }).installed).filter(item => {
    if (!item || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    return entry.pluginId === "tibo-hook@tibo-hook" && entry.installed === true && entry.enabled === true && entry.version === VERSION;
  });
  if (matches.length !== 1) throw new Error("plugin_locator_requires_one_enabled_matching_install; set TIBO_HOOK_PLUGIN_DATA explicitly");
  return join(resolve(codexHome), "plugins", "data", "tibo-hook-tibo-hook");
}

export function assertPrivatePermissions(path: string, expected: number): void {
  if (process.platform === "win32") return;
  const actual = statSync(path).mode & 0o777;
  if ((actual & ~expected) !== 0) throw new Error(`unsafe_permissions:${actual.toString(8)}`);
}

export function removeIfExists(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
