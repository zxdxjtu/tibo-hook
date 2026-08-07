import { chmod, copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("plugins/tibo-hook/dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "plugins/tibo-hook/dist/tibo-hook.cjs",
  banner: { js: "#!/usr/bin/env node" },
  define: { __TIBO_HOOK_VERSION__: JSON.stringify("0.1.0") },
  sourcemap: false,
  legalComments: "external"
});
await chmod("plugins/tibo-hook/dist/tibo-hook.cjs", 0o755);
await copyFile("THIRD_PARTY_NOTICES.md", "plugins/tibo-hook/THIRD_PARTY_NOTICES.md");
