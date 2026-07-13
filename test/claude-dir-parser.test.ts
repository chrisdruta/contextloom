import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph/builder";
import { ClaudeDirectoryParser, classifyClaudePath } from "../src/parsers/claude-dir";
import { ParserRegistry } from "../src/parsers/registry";
import type { FileSnapshot } from "../src/shared/types";
import { defaultSettings, fixturePath } from "./helpers";

const parser = new ClaudeDirectoryParser();
const ctx = {
  workspaceRoot: fixturePath("claude-dir"),
  settings: defaultSettings(),
  log: () => {},
};

function snapshot(path: string): FileSnapshot {
  return {
    path,
    contents: new Uint8Array(readFileSync(fixturePath("claude-dir", ...path.split("/")))),
    hash: "x",
  };
}

describe("classifyClaudePath", () => {
  it("classifies each artifact class", () => {
    expect(classifyClaudePath(".claude/agents/reviewer.md")?.kind).toBe("agent");
    expect(classifyClaudePath(".claude/agents/sub/dir.md")?.kind).toBe("agent");
    expect(classifyClaudePath(".claude/commands/ship.md")?.kind).toBe("command");
    expect(classifyClaudePath(".claude/rules/style.md")?.kind).toBe("rule");
    expect(classifyClaudePath(".claude/skills/deploy/SKILL.md")).toMatchObject({
      kind: "skill",
      skillDir: "deploy",
    });
    expect(classifyClaudePath(".claude/settings.json")?.kind).toBe("config");
    expect(classifyClaudePath(".claude/settings.local.json")?.kind).toBe("config");
  });

  it("does not claim CLAUDE.md, supporting files, or unrelated paths", () => {
    expect(classifyClaudePath(".claude/CLAUDE.md")).toBeNull();
    expect(classifyClaudePath(".claude/skills/deploy/references/notes.md")).toBeNull();
    expect(classifyClaudePath(".claude/skills/deploy/scripts/run.sh")).toBeNull();
    expect(classifyClaudePath("docs/agents/reviewer.md")).toBeNull();
  });

  it("handles nested package .claude dirs", () => {
    expect(classifyClaudePath("pkgs/web/.claude/skills/deploy/SKILL.md")).toMatchObject({
      kind: "skill",
      claudeRoot: "pkgs/web",
      skillDir: "deploy",
    });
  });
});

describe("ClaudeDirectoryParser", () => {
  it("parses an agent with frontmatter identity and skills refs", () => {
    const result = parser.parse(snapshot(".claude/agents/reviewer.md"), ctx);
    const node = result.nodes.find((n) => n.path === ".claude/agents/reviewer.md")!;
    expect(node.type).toBe("agent");
    expect(node.label).toBe("reviewer");
    expect(node.metadata.description).toBe("Reviews pull requests");
    expect(node.metadata.model).toBe("sonnet");
    expect(node.scope).toBe("");
    const skillRefs = result.references.filter((r) => r.rel === "uses-skill");
    expect(skillRefs.map((r) => r.rawTarget)).toEqual(["deploy"]);
    expect(result.edges.some((e) => e.type === "defines-agent")).toBe(true);
    // body links still parsed
    expect(result.references.some((r) => r.kind === "md-link")).toBe(true);
  });

  it("warns when an agent has no name", () => {
    const result = parser.parse(snapshot(".claude/agents/broken.md"), ctx);
    expect(result.diagnostics.some((d) => d.code === "agent-missing-name")).toBe(true);
    expect(result.nodes[0]!.label).toBe("broken");
  });

  it("survives malformed frontmatter with a diagnostic", () => {
    const result = parser.parse(snapshot(".claude/agents/malformed.md"), ctx);
    expect(result.diagnostics.some((d) => d.code === "malformed-frontmatter")).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("parses a skill with paths globs", () => {
    const result = parser.parse(snapshot(".claude/skills/deploy/SKILL.md"), ctx);
    const node = result.nodes.find((n) => n.type === "skill")!;
    expect(node.label).toBe("deploy");
    expect(result.scopeRules).toEqual([
      expect.objectContaining({
        format: "claude-skills",
        mechanism: "glob",
        globs: ["**/*.ts", "infra/**"],
      }),
    ]);
  });

  it("warns on skill name/directory mismatch — directory wins", () => {
    const result = parser.parse(snapshot(".claude/skills/mismatch/SKILL.md"), ctx);
    expect(result.diagnostics.some((d) => d.code === "skill-name-mismatch")).toBe(true);
    expect(result.nodes.find((n) => n.type === "skill")!.label).toBe("mismatch");
  });

  it("skill without paths is model-decision", () => {
    const result = parser.parse(snapshot(".claude/skills/advisor/SKILL.md"), ctx);
    expect(result.scopeRules[0]!.mechanism).toBe("model-decision");
  });

  it("commands use the skills code path with manual mechanism", () => {
    const result = parser.parse(snapshot(".claude/commands/ship.md"), ctx);
    expect(result.nodes.find((n) => n.path === ".claude/commands/ship.md")!.type).toBe("command");
    expect(result.scopeRules[0]!.mechanism).toBe("manual");
  });

  it("rules are instruction nodes; paths → glob, absent → always", () => {
    const globbed = parser.parse(snapshot(".claude/rules/style.md"), ctx);
    const node = globbed.nodes.find((n) => n.path === ".claude/rules/style.md")!;
    expect(node.type).toBe("instruction");
    expect(node.metadata.format).toBe("claude-rules");
    expect(globbed.scopeRules[0]).toMatchObject({
      format: "claude-rules",
      mechanism: "glob",
      globs: ["**/*.ts", "**/*.tsx"],
    });

    const always = parser.parse(snapshot(".claude/rules/always.md"), ctx);
    expect(always.scopeRules[0]!.mechanism).toBe("always");
  });

  it("settings.json becomes a config node exposing key names only", () => {
    const result = parser.parse(snapshot(".claude/settings.json"), ctx);
    const node = result.nodes[0]!;
    expect(node.type).toBe("config");
    expect(node.metadata.topLevelKeys).toEqual(["permissions", "hooks", "env"]);
    expect(node.metadata.permissionRuleCounts).toEqual({ allow: 1, deny: 0 });
    expect(node.metadata.hookEvents).toEqual(["PreToolUse"]);
    expect(node.metadata.envVarNames).toEqual(["FOO"]);
    expect(JSON.stringify(node.metadata)).not.toContain("Bash(bun");
    expect(JSON.stringify(node.metadata)).not.toContain("bar");
  });

  it("malformed settings.json yields a diagnostic and a bare config node", () => {
    const result = parser.parse(
      {
        path: ".claude/settings.json",
        contents: new TextEncoder().encode("{ not json"),
        hash: "x",
      },
      ctx,
    );
    expect(result.diagnostics.some((d) => d.code === "malformed-settings-json")).toBe(true);
    expect(result.nodes[0]!.type).toBe("config");
  });
});

describe("uses-skill resolution (full build)", () => {
  const build = () =>
    buildGraph({
      workspaceRoot: fixturePath("claude-dir"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });

  it("resolves an agent's skill to its own claude root despite a nested clash", () => {
    const result = build();
    const usesSkill = result.store.allEdges().filter((e) => e.type === "uses-skill");
    expect(usesSkill).toHaveLength(1);
    expect(usesSkill[0]!.source).toBe("file:.claude/agents/reviewer.md");
    expect(usesSkill[0]!.target).toBe("file:.claude/skills/deploy/SKILL.md");
  });

  it("missing skill produces broken-ref plus an error diagnostic", () => {
    const result = build();
    expect(
      result.diagnostics.some((d) => d.code === "missing-skill" && d.severity === "error"),
    ).toBe(true);
    const broken = result.store
      .allEdges()
      .filter((e) => e.type === "broken-ref" && e.source === "file:.claude/agents/broken.md");
    expect(broken).toHaveLength(1);
  });

  it("all artifact classes appear as typed nodes", () => {
    const result = build();
    const types = new Map<string, number>();
    for (const n of result.store.allNodes()) {
      types.set(n.type, (types.get(n.type) ?? 0) + 1);
    }
    expect(types.get("agent")).toBe(3);
    expect(types.get("skill")).toBe(4); // deploy, mismatch, advisor, pkgs/web deploy
    expect(types.get("command")).toBe(2);
    expect(types.get("config")).toBe(1);
  });
});
