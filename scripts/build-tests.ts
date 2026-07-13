/**
 * Bundles test/integration/*.test.ts to test-dist/ for @vscode/test-cli
 * (which runs plain JS under Mocha inside the extension host).
 */
import { readdirSync } from "node:fs";
import * as esbuild from "esbuild";

const entries = readdirSync("test/integration")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/integration/${f}`);

if (entries.length === 0) {
  console.error("no integration tests found");
  process.exit(1);
}

esbuild
  .build({
    entryPoints: entries,
    outdir: "test-dist/integration",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
    external: ["vscode", "mocha"],
    logLevel: "info",
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
