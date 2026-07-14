/// <reference types="mocha" />
/**
 * Multi-root workspace integration tests (@vscode/test-cli, "multi-root"
 * config in .vscode-test.mjs). Workspace: multi.code-workspace with two
 * independent fixture folders — alpha (monorepo) and beta (scope-monorepo).
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ContextLoomTestApi } from "../../src/extension/extension";

const EXTENSION_ID = "chrisdruta.contextloom";

async function getApi(): Promise<ContextLoomTestApi> {
  const ext = vscode.extensions.getExtension<ContextLoomTestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} present`);
  return ext.activate();
}

describe("ContextLoom multi-root", () => {
  it("workspace has two folders", () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.strictEqual(folders.length, 2, "two workspace folders");
    assert.deepStrictEqual(folders.map((f) => f.name).sort(), ["alpha", "beta"]);
  });

  it("indexes each folder independently with no cross-folder paths", async function () {
    this.timeout(60_000);
    const api = await getApi();

    await api.openRoot("", "alpha");
    const alphaPaths = api.getStore()!.allFilePaths();
    assert.ok(
      alphaPaths.some((p) => p === "docs/architecture.md"),
      "alpha indexed its own docs",
    );
    assert.ok(
      !alphaPaths.some((p) => p.includes("scope-monorepo") || p.startsWith("..")),
      "alpha contains no beta or escaping paths",
    );

    await api.openRoot("", "beta");
    const betaPaths = api.getStore()!.allFilePaths();
    assert.ok(
      betaPaths.some((p) => p === "packages/api/CLAUDE.md"),
      "beta indexed its own instruction files",
    );
    assert.ok(
      !betaPaths.some((p) => p === "docs/architecture.md"),
      "beta does not contain alpha files",
    );
  });

  it("scope resolution is folder-local", async function () {
    this.timeout(60_000);
    const api = await getApi();
    await api.openRoot("", "beta");
    const groups = api.resolveContext("packages/api/src/server.ts");
    const agents = groups.find((g) => g.format === "agents-md");
    assert.ok(agents, "beta agents-md group");
    assert.strictEqual(agents.matches[0]!.sourcePath, "packages/api/AGENTS.md");

    await api.openRoot("", "alpha");
    const alphaAgents = api
      .resolveContext("packages/api/README.md")
      .find((g) => g.format === "agents-md");
    assert.ok(alphaAgents, "alpha agents-md group");
    // alpha's own AGENTS.md files, not beta's
    assert.ok(alphaAgents.matches.every((m) => !m.sourcePath.includes("scope-monorepo")));
  });

  it("switching the active folder swaps stores without crashing", async function () {
    this.timeout(60_000);
    const api = await getApi();
    await api.openRoot("", "alpha");
    const alphaCount = api.getStore()!.nodeCount();
    await api.openRoot("", "beta");
    const betaCount = api.getStore()!.nodeCount();
    await api.openRoot("", "alpha");
    assert.strictEqual(api.getStore()!.nodeCount(), alphaCount, "alpha store intact after switch");
    assert.notStrictEqual(alphaCount, betaCount, "different graphs per folder");
  });

  it("openGraph command works in a multi-root workspace with explicit folder", async function () {
    this.timeout(60_000);
    const api = await getApi();
    const beta = vscode.workspace.workspaceFolders!.find((f) => f.name === "beta")!;
    await vscode.commands.executeCommand("contextloom.openGraph", "", beta.uri.toString());
    assert.ok(api.getStore(), "store built via command with folder arg");
  });
});
