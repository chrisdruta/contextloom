import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { filesInScope, resolveContext } from "../src/scope/resolve";
import type { ScopeMatchGroup } from "../src/scope/types";
import { defaultSettings, fixturePath } from "./helpers";

function build(settings = defaultSettings()) {
  return buildGraph({
    workspaceRoot: fixturePath("scope-monorepo"),
    graphRoot: "",
    settings,
    registry: new ParserRegistry(),
  });
}

function group(groups: ScopeMatchGroup[], format: string): ScopeMatchGroup | undefined {
  return groups.find((g) => g.format === format);
}

describe("resolveContext — PLAN.md G.3 worked example", () => {
  it("packages/api/src/server.ts matches the G.3 table row-by-row", () => {
    const { scopeIndex } = build();
    const groups = resolveContext("packages/api/src/server.ts", scopeIndex);

    // A2 active, A1 shadowed (nearest-wins)
    const agents = group(groups, "agents-md")!;
    expect(agents.matches).toHaveLength(2);
    expect(agents.matches[0]).toMatchObject({
      sourcePath: "packages/api/AGENTS.md",
      status: "active",
      rank: 1,
    });
    expect(agents.matches[0]!.reason).toContain("nearest AGENTS.md");
    expect(agents.matches[1]).toMatchObject({
      sourcePath: "AGENTS.md",
      status: "shadowed",
    });
    expect(agents.matches[1]!.reason).toContain("overridden by packages/api/AGENTS.md");

    // C1 rank 1, C2 rank 2 — both active, concatenation not override
    const claude = group(groups, "claude-md")!;
    expect(claude.matches.map((m) => [m.sourcePath, m.status, m.rank])).toEqual([
      ["CLAUDE.md", "active", 1],
      ["packages/api/CLAUDE.md", "active", 2],
    ]);
    expect(claude.matches[1]!.reason).toContain("does not override");
    expect(claude.note).toContain("concatenated root→leaf");

    // R1 active via glob
    const rules = group(groups, "claude-rules")!;
    expect(rules.matches).toHaveLength(1);
    expect(rules.matches[0]).toMatchObject({
      sourcePath: ".claude/rules/style.md",
      status: "active",
      mechanism: "glob",
    });
    expect(rules.matches[0]!.reason).toContain("**/*.ts");
  });

  it("packages/web/src/app.tsx: A1, C1, R1 active — no shadowing", () => {
    const { scopeIndex } = build();
    const groups = resolveContext("packages/web/src/app.tsx", scopeIndex);

    const agents = group(groups, "agents-md")!;
    expect(agents.matches).toHaveLength(1);
    expect(agents.matches[0]).toMatchObject({ sourcePath: "AGENTS.md", status: "active" });

    const claude = group(groups, "claude-md")!;
    expect(claude.matches.map((m) => m.sourcePath)).toEqual(["CLAUDE.md"]);

    const rules = group(groups, "claude-rules")!;
    expect(rules.matches[0]!.reason).toContain("**/*.tsx");
  });

  it("merge mode flips shadowed AGENTS.md to active root→leaf", () => {
    const { scopeIndex } = build(defaultSettings({ agents: { agentsMdMode: "merge" } }));
    const agents = group(resolveContext("packages/api/src/server.ts", scopeIndex), "agents-md")!;
    expect(agents.matches.map((m) => [m.sourcePath, m.status, m.rank])).toEqual([
      ["AGENTS.md", "active", 1],
      ["packages/api/AGENTS.md", "active", 2],
    ]);
    expect(agents.note).toContain("Merge mode");
  });

  it("markdown files resolve too (instruction files govern docs)", () => {
    const { scopeIndex } = build();
    const groups = resolveContext("packages/api/AGENTS.md", scopeIndex);
    // A file's own AGENTS.md chain includes itself — nearest is itself
    const agents = group(groups, "agents-md")!;
    expect(agents.matches[0]!.sourcePath).toBe("packages/api/AGENTS.md");
  });

  it("disabled formats produce no groups", () => {
    const { scopeIndex } = build(defaultSettings({ agents: { formats: ["claude"] } }));
    const groups = resolveContext("packages/api/src/server.ts", scopeIndex);
    expect(group(groups, "agents-md")).toBeUndefined();
    expect(group(groups, "claude-md")).toBeDefined();
  });
});

describe("resolveContext — @import expansions", () => {
  it("imported files appear after their importer with via info", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("nested-claude-md"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });
    const groups = resolveContext("packages/api/anything.ts", result.scopeIndex);
    const claude = group(groups, "claude-md")!;
    expect(claude.matches.map((m) => m.sourcePath)).toEqual([
      "CLAUDE.md",
      "shared/rules.md",
      "packages/api/CLAUDE.md",
    ]);
    expect(claude.matches[1]!.via).toEqual({ importedFrom: "CLAUDE.md", depth: 1 });
    expect(claude.matches[1]!.reason).toContain("imported by CLAUDE.md");
  });
});

describe("filesInScope — reverse lookup", () => {
  it("an instruction's scope subtree, excluding shadowed regions", () => {
    const { scopeIndex, store } = build();
    const all = [
      "AGENTS.md",
      "CLAUDE.md",
      "packages/api/AGENTS.md",
      "packages/api/CLAUDE.md",
      "packages/api/src/server.ts",
      "packages/web/src/app.tsx",
      ".claude/rules/style.md",
    ];
    void store;

    // A2 governs only the api subtree
    expect(filesInScope("file:packages/api/AGENTS.md", scopeIndex, all)).toEqual([
      "packages/api/CLAUDE.md",
      "packages/api/src/server.ts",
    ]);

    // A1 (nearest mode) is shadowed inside packages/api
    expect(filesInScope("file:AGENTS.md", scopeIndex, all)).toEqual([
      ".claude/rules/style.md",
      "CLAUDE.md",
      "packages/web/src/app.tsx",
    ]);

    // R1 applies to ts/tsx anywhere
    expect(filesInScope("file:.claude/rules/style.md", scopeIndex, all)).toEqual([
      "packages/api/src/server.ts",
      "packages/web/src/app.tsx",
    ]);
  });

  it("returns empty for non-instruction sources", () => {
    const { scopeIndex } = build();
    expect(filesInScope("file:packages/api/src/server.ts", scopeIndex, ["AGENTS.md"])).toEqual([]);
  });
});

describe("derived structural edges", () => {
  it("overrides and inherits-from edges materialize for nested instructions", () => {
    const { store } = build();
    const overrides = store.allEdges().filter((e) => e.type === "overrides");
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.source).toBe("file:packages/api/AGENTS.md");
    expect(overrides[0]!.target).toBe("file:AGENTS.md");

    const inherits = store.allEdges().filter((e) => e.type === "inherits-from");
    expect(inherits.map((e) => [e.source, e.target]).sort()).toEqual([
      ["file:packages/api/AGENTS.md", "file:AGENTS.md"],
      ["file:packages/api/CLAUDE.md", "file:CLAUDE.md"],
    ]);
  });

  it("skill directories gain contains edges and supporting-file nodes", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("claude-dir"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });
    const skillId = "file:.claude/skills/deploy/SKILL.md";
    const contains = result.store
      .allEdges()
      .filter((e) => e.type === "contains" && e.source === skillId)
      .map((e) => e.target)
      .sort();
    expect(contains).toEqual([
      "file:.claude/skills/deploy/assets/logo.png",
      "file:.claude/skills/deploy/references/notes.md",
      "file:.claude/skills/deploy/scripts/run.sh",
    ]);
    const script = result.store.getNode("file:.claude/skills/deploy/scripts/run.sh")!;
    expect(script.type).toBe("source-file");
    expect(script.metadata.skillSupportingFile).toBe(true);
  });

  it("cross-package skill name clashes get qualified labels", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("claude-dir"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });
    const nested = result.store.getNode("file:pkgs/web/.claude/skills/deploy/SKILL.md")!;
    expect(nested.label).toBe("pkgs/web:deploy");
    const root = result.store.getNode("file:.claude/skills/deploy/SKILL.md")!;
    expect(root.label).toBe("deploy");
  });

  it("commands shadowed by same-name skills are flagged", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("claude-dir"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });
    expect(result.store.getNode("file:.claude/commands/deploy.md")!.metadata.shadowedBySkill).toBe(
      true,
    );
    expect(
      result.store.getNode("file:.claude/commands/ship.md")!.metadata.shadowedBySkill,
    ).toBeUndefined();
  });
});
