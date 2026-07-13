import { describe, expect, it } from "vitest";
import { applyFileChanges, buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { resolveContext } from "../src/scope/resolve";
import type { FileSnapshot } from "../src/shared/types";
import { defaultSettings, fixturePath } from "./helpers";

function build(fixture: string) {
  return buildGraph({
    workspaceRoot: fixturePath(fixture),
    graphRoot: "",
    settings: defaultSettings(),
    registry: new ParserRegistry(),
  });
}

function incrementalOpts(b: ReturnType<typeof build>, fixture: string) {
  return {
    workspaceRoot: fixturePath(fixture),
    settings: defaultSettings(),
    registry: new ParserRegistry(),
    refIndex: b.refIndex,
    parseMeta: b.parseMeta,
    scopeRuleIndex: b.scopeRuleIndex,
    derivedIds: b.derivedIds,
    skipped: b.skipped,
  };
}

function snap(path: string, text: string): FileSnapshot {
  return { path, contents: new TextEncoder().encode(text), hash: `h-${text.length}` };
}

describe("incremental scope recomputation", () => {
  it("deleting a nested AGENTS.md un-shadows the root and drops the overrides edge", () => {
    const b = build("scope-monorepo");
    const { patch, scope } = applyFileChanges(
      b.store,
      { created: [], changed: [], deleted: ["packages/api/AGENTS.md"] },
      incrementalOpts(b, "scope-monorepo"),
    );

    expect(scope).toBeDefined();
    expect(patch.removedEdgeIds).toContain("overrides|file:packages/api/AGENTS.md|file:AGENTS.md");

    const groups = resolveContext("packages/api/src/server.ts", scope!.scopeIndex);
    const agents = groups.find((g) => g.format === "agents-md")!;
    expect(agents.matches).toHaveLength(1);
    expect(agents.matches[0]).toMatchObject({ sourcePath: "AGENTS.md", status: "active" });
  });

  it("re-creating the nested AGENTS.md flips the root back to shadowed", () => {
    const b = build("scope-monorepo");
    applyFileChanges(
      b.store,
      { created: [], changed: [], deleted: ["packages/api/AGENTS.md"] },
      incrementalOpts(b, "scope-monorepo"),
    );
    const { patch, scope } = applyFileChanges(
      b.store,
      { created: [snap("packages/api/AGENTS.md", "# A2 back\n")], changed: [], deleted: [] },
      incrementalOpts(b, "scope-monorepo"),
    );

    expect(patch.addedEdges.some((e) => e.type === "overrides")).toBe(true);
    const agents = resolveContext("packages/api/src/server.ts", scope!.scopeIndex).find(
      (g) => g.format === "agents-md",
    )!;
    expect(agents.matches.map((m) => [m.sourcePath, m.status])).toEqual([
      ["packages/api/AGENTS.md", "active"],
      ["AGENTS.md", "shadowed"],
    ]);
  });

  it("editing a rule's paths changes glob answers", () => {
    const b = build("scope-monorepo");
    const { scope } = applyFileChanges(
      b.store,
      {
        created: [],
        changed: [
          snap(".claude/rules/style.md", '---\npaths: ["docs/**"]\n---\n\nNarrowed rule.\n'),
        ],
        deleted: [],
      },
      incrementalOpts(b, "scope-monorepo"),
    );

    expect(scope).toBeDefined();
    const groups = resolveContext("packages/api/src/server.ts", scope!.scopeIndex);
    expect(groups.find((g) => g.format === "claude-rules")).toBeUndefined();
    const docsGroups = resolveContext("docs/readme.md", scope!.scopeIndex);
    expect(docsGroups.find((g) => g.format === "claude-rules")).toBeDefined();
  });

  it("non-scope document edits skip the scope pass", () => {
    const b = build("basic-docs");
    const paths = b.store.allFilePaths();
    const docPath = paths.find((p) => p.endsWith(".md"))!;
    const { scope } = applyFileChanges(
      b.store,
      { created: [], changed: [snap(docPath, "# Plain edit\n")], deleted: [] },
      incrementalOpts(b, "basic-docs"),
    );
    expect(scope).toBeUndefined();
  });

  it("editing an imported file's @imports updates chains", () => {
    const b = build("claude-imports/fence");
    // ok.md gains its own import of fenced.md — depth 2 chain appears
    const { scope } = applyFileChanges(
      b.store,
      { created: [], changed: [snap("ok.md", "# OK\n\n@./fenced.md\n")], deleted: [] },
      incrementalOpts(b, "claude-imports/fence"),
    );
    expect(scope).toBeDefined();
    const claude = resolveContext("anything.ts", scope!.scopeIndex).find(
      (g) => g.format === "claude-md",
    )!;
    expect(claude.matches.map((m) => m.sourcePath)).toEqual(["CLAUDE.md", "ok.md", "fenced.md"]);
    expect(claude.matches[2]!.via).toEqual({ importedFrom: "ok.md", depth: 2 });
  });
});
