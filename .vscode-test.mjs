import { cpSync, mkdirSync, rmSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";

// Integration tests run against a disposable copy of the monorepo fixture so
// tests may freely create/modify files without dirtying committed fixtures.
const workspace = ".vscode-test/workspace";
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
cpSync("test/fixtures/monorepo", workspace, { recursive: true });

export default defineConfig({
  files: "test-dist/integration/**/*.test.js",
  workspaceFolder: workspace,
  mocha: {
    ui: "bdd",
    timeout: 60_000,
  },
});
