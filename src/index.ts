import { dirname, resolve } from "node:path";
import { runCli, CliError } from "./cli.js";
import { resolveDataRoot } from "./files.js";
import { runHook } from "./hook.js";
import { runSupervisor } from "./supervisor.js";

const argv = process.argv.slice(2);
const pluginRoot = process.env.TIBO_HOOK_PLUGIN_ROOT ? resolve(process.env.TIBO_HOOK_PLUGIN_ROOT) : resolve(dirname(process.argv[1]!), "..");

async function main(): Promise<number> {
  if (argv[0] === "hook") {
    try { await runHook(argv[1] ?? "", resolveDataRoot(), pluginRoot); } catch { /* Hook commands are fail-open for Codex */ }
    return 0;
  }
  if (argv[0] === "supervisor") {
    try { await runSupervisor(resolveDataRoot(), pluginRoot); } catch { /* detached runtime has local diagnostics */ }
    return 0;
  }
  return runCli(argv, pluginRoot);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  const code = error instanceof CliError ? error.exitCode : /config|template|email|smtp|schema|permission|key/i.test((error as Error).message) ? 2 : 3;
  process.stderr.write(`tibo-hook: ${(error as Error).message}\n`);
  process.exitCode = code;
});
