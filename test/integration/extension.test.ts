/// <reference types="mocha" />
/**
 * Extension-host integration tests (@vscode/test-cli, Mocha bdd).
 * Workspace: disposable copy of test/fixtures/monorepo (see .vscode-test.mjs).
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextLoomTestApi } from "../../src/extension/extension";

const EXTENSION_ID = "chrisdruta.contextloom";

const PUBLIC_COMMANDS = [
  "contextloom.openGraph",
  "contextloom.openGraphForFolder",
  "contextloom.focusCurrentFile",
  "contextloom.findLooseThreads",
  "contextloom.refreshGraph",
  "contextloom.exportGraph",
  "contextloom.showAgentContext",
];

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder open");
  return folder.uri.fsPath;
}

async function getApi(): Promise<ContextLoomTestApi> {
  const ext = vscode.extensions.getExtension<ContextLoomTestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} present`);
  return ext.activate();
}

function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe("ContextLoom integration", () => {
  it("activates and registers all public commands", async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    for (const command of PUBLIC_COMMANDS) {
      assert.ok(commands.includes(command), `command ${command} registered`);
    }
  });

  it("indexes the monorepo fixture with typed instruction nodes", async () => {
    const api = await getApi();
    await api.openRoot("");
    const store = api.getStore();
    assert.ok(store, "store built");

    const json = api.exportJson();
    assert.ok(json, "export available");
    const parsed = JSON.parse(json) as {
      nodes: { id: string; type: string; path?: string }[];
      edges: { type: string }[];
    };

    const docs = parsed.nodes.filter((n) => n.type === "document");
    const instructions = parsed.nodes.filter((n) => n.type === "instruction");
    assert.ok(docs.length >= 7, `expected >=7 documents, got ${docs.length}`);
    assert.strictEqual(
      instructions.length,
      2,
      "root AGENTS.md and packages/api/AGENTS.md are instruction nodes",
    );
    assert.ok(
      instructions.some((n) => n.path === "packages/api/AGENTS.md"),
      "nested AGENTS.md recognized",
    );
  });

  it("export is deterministic across calls", async () => {
    const api = await getApi();
    if (!api.getStore()) await api.openRoot("");
    assert.strictEqual(api.exportJson(), api.exportJson());
  });

  it("search finds documents by label and path", async () => {
    const api = await getApi();
    if (!api.getStore()) await api.openRoot("");
    const matches = api.search("architecture");
    assert.ok(matches.length > 0, "search returns matches");
    assert.ok(
      matches.some((id) => id.includes("architecture")),
      "match id references architecture doc",
    );
  });

  it("applies an incremental patch when a file changes on disk", async function () {
    this.timeout(30_000);
    const api = await getApi();
    await api.openRoot("");
    const target = path.join(workspaceRoot(), "docs", "deployment.md");
    const original = fs.readFileSync(target, "utf8");

    const gotPatch = new Promise<boolean>((resolve) => {
      const sub = api.onDidUpdate((ev) => {
        if (!ev.full && ev.patch) {
          sub.dispose();
          resolve(true);
        }
      });
      setTimeout(() => {
        sub.dispose();
        resolve(false);
      }, 20_000);
    });

    try {
      fs.writeFileSync(target, `${original}\n[arch](./architecture.md)\n`);
      assert.strictEqual(await gotPatch, true, "incremental (non-full) patch fired");
      const store = api.getStore();
      assert.ok(store, "store present after patch");
    } finally {
      fs.writeFileSync(target, original);
    }
  });

  it("publishes broken-link diagnostics at the exact range", async function () {
    this.timeout(30_000);
    const api = await getApi();
    await api.openRoot("");
    const file = path.join(workspaceRoot(), "broken-fixture.md");
    const uri = vscode.Uri.file(file);

    try {
      // Line 3 (0-based 2) holds the dead link.
      fs.writeFileSync(file, "# Broken\n\n[dead link](./does-not-exist.md)\n");
      // File creation triggers a full reindex (discovery rules apply).
      await waitFor(
        () => vscode.languages.getDiagnostics(uri).length > 0,
        20_000,
        "broken-link diagnostic",
      );
      const diags = vscode.languages.getDiagnostics(uri);
      assert.strictEqual(diags.length, 1, "exactly one diagnostic");
      const d = diags[0]!;
      assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Warning);
      assert.strictEqual(d.range.start.line, 2, "diagnostic on the link line");
      assert.ok(d.range.start.character >= 0);
    } finally {
      fs.unlinkSync(file);
      await waitFor(
        () => vscode.languages.getDiagnostics(uri).length === 0,
        20_000,
        "diagnostic cleared after delete",
      );
    }
  });

  it("openGraph command runs end to end", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("contextloom.openGraph");
    await waitFor(() => api.getStore() !== null, 20_000, "graph built via command");
  });

  it("resolves agent context with nearest-wins AGENTS.md semantics", async () => {
    const api = await getApi();
    if (!api.getStore()) await api.openRoot("");
    const groups = api.resolveContext("packages/api/README.md");
    const agents = groups.find((g) => g.format === "agents-md");
    assert.ok(agents, "agents-md group present");
    assert.strictEqual(agents.matches[0]!.sourcePath, "packages/api/AGENTS.md");
    assert.strictEqual(agents.matches[0]!.status, "active");
    assert.strictEqual(agents.matches[1]!.sourcePath, "AGENTS.md");
    assert.strictEqual(agents.matches[1]!.status, "shadowed");
  });

  it("showAgentContext command runs from an open editor", async function () {
    this.timeout(30_000);
    const api = await getApi();
    if (!api.getStore()) await api.openRoot("");
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(workspaceRoot(), "packages", "api", "README.md")),
    );
    await vscode.window.showTextDocument(doc);
    // Must not throw; opens/reveals the Loom panel with the Agent Context tab.
    await vscode.commands.executeCommand("contextloom.showAgentContext");
    assert.ok(api.getStore(), "store present after command");
  });
});
