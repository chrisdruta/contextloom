import { mkdirSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });

const common: esbuild.BuildOptions = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
};

const extension: esbuild.BuildOptions = {
  ...common,
  entryPoints: ["src/extension/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  target: "node18",
};

const webview: esbuild.BuildOptions = {
  ...common,
  entryPoints: ["webview-ui/src/main.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extension);
    const wvCtx = await esbuild.context(webview);
    await Promise.all([extCtx.watch(), wvCtx.watch()]);
    console.log("watching…");
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
    console.log("build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
