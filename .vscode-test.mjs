import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";

// Integration tests run against disposable copies of fixtures so tests may
// freely create/modify files without dirtying committed fixtures.
const workspace = ".vscode-test/workspace";
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
cpSync("test/fixtures/monorepo", workspace, { recursive: true });

// Multi-root: two independent fixture folders referenced by a .code-workspace.
const multiRootBase = ".vscode-test/multi-root";
rmSync(multiRootBase, { recursive: true, force: true });
mkdirSync(multiRootBase, { recursive: true });
cpSync("test/fixtures/monorepo", `${multiRootBase}/alpha`, { recursive: true });
cpSync("test/fixtures/scope-monorepo", `${multiRootBase}/beta`, { recursive: true });
writeFileSync(
  `${multiRootBase}/multi.code-workspace`,
  JSON.stringify({ folders: [{ path: "alpha" }, { path: "beta" }] }, null, 2),
);

export default defineConfig([
  {
    label: "single-root",
    files: "test-dist/integration/extension.test.js",
    workspaceFolder: workspace,
    mocha: {
      ui: "bdd",
      timeout: 60_000,
    },
  },
  {
    label: "multi-root",
    files: "test-dist/integration/multi-root.test.js",
    workspaceFolder: `${multiRootBase}/multi.code-workspace`,
    mocha: {
      ui: "bdd",
      timeout: 60_000,
    },
  },
]);
