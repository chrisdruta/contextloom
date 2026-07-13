import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InstructionFileParser, isInstructionFile } from "../src/parsers/instruction";
import { defaultSettings, fixturePath } from "./helpers";

describe("InstructionFileParser", () => {
  const parser = new InstructionFileParser();
  const ctx = {
    workspaceRoot: fixturePath("nested-agents-md"),
    settings: defaultSettings(),
    log: () => {},
  };

  it("classifies AGENTS.md and CLAUDE.md", () => {
    expect(isInstructionFile("AGENTS.md")).toBe(true);
    expect(isInstructionFile("packages/api/AGENTS.md")).toBe(true);
    expect(isInstructionFile("CLAUDE.md")).toBe(true);
    expect(isInstructionFile("docs/readme.md")).toBe(false);
  });

  it("emits instruction nodes", () => {
    const file = {
      path: "AGENTS.md",
      contents: new Uint8Array(readFileSync(fixturePath("nested-agents-md/AGENTS.md"))),
      hash: "x",
    };
    const result = parser.parse(file, ctx);
    expect(result.nodes[0]!.type).toBe("instruction");
    expect(result.nodes[0]!.metadata.format).toBe("agents-md");
    expect(result.scopeRules).toHaveLength(1);
  });

  it("extracts @import from CLAUDE.md", () => {
    const file = {
      path: "CLAUDE.md",
      contents: new Uint8Array(readFileSync(fixturePath("nested-claude-md/CLAUDE.md"))),
      hash: "x",
    };
    const result = parser.parse(file, {
      ...ctx,
      workspaceRoot: fixturePath("nested-claude-md"),
    });
    expect(result.nodes[0]!.type).toBe("instruction");
    expect(result.references.some((r) => r.kind === "import")).toBe(true);
  });

  it("disabled when agents.enabled is false", () => {
    expect(parser.enabled(defaultSettings({ agents: { enabled: false } }))).toBe(false);
  });
});
