import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...collectTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) tests.push(path);
  }
  return tests.sort();
}

const tests = collectTests("tests");
if (tests.length === 0) throw new Error("No test files found");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
