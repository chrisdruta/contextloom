import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph/builder";
import { CursorRulesParser, isCursorRulePath } from "../src/parsers/cursor";
import { ParserRegistry } from "../src/parsers/registry";
import type { FileSnapshot } from "../src/shared/types";
import { defaultSettings, fixturePath } from "./helpers";

const parser = new CursorRulesParser();
const ctx = {
  workspaceRoot: fixturePath("cursor-rules"),
  settings: defaultSettings(),
  log: () => {},
};

function snapshot(path: string): FileSnapshot {
  return {
    path,
    contents: new Uint8Array(readFileSync(fixturePath("cursor-rules", ...path.split("/")))),
    hash: "x",
  };
}

describe("isCursorRulePath", () => {
  it("claims .cursor/rules .mdc files and legacy .cursorrules only", () => {
    expect(isCursorRulePath(".cursor/rules/a.mdc")).toBe(true);
    expect(isCursorRulePath("pkg/.cursor/rules/sub/a.mdc")).toBe(true);
    expect(isCursorRulePath(".cursorrules")).toBe(true);
    expect(isCursorRulePath("docs/a.mdc")).toBe(false); // .mdc outside .cursor/rules
    expect(isCursorRulePath(".cursor/rules/a.md")).toBe(false);
  });
});

describe("CursorRulesParser modes", () => {
  it("alwaysApply → always, confidence 1", () => {
    const r = parser.parse(snapshot(".cursor/rules/always.mdc"), ctx);
    expect(r.scopeRules[0]).toMatchObject({ format: "cursor", mechanism: "always" });
    expect(r.nodes[0]!.type).toBe("instruction");
    expect(r.nodes[0]!.metadata.format).toBe("cursor");
  });

  it("YAML-list globs → glob at confidence 0.8", () => {
    const r = parser.parse(snapshot(".cursor/rules/globbed-list.mdc"), ctx);
    expect(r.scopeRules[0]).toMatchObject({
      mechanism: "glob",
      globs: ["**/*.ts", "**/*.tsx"],
    });
    expect(r.scopeRules[0]!.metadata).toMatchObject({ confidence: 0.8 });
  });

  it("unquoted comma-string globs survive via tolerant fallback", () => {
    const r = parser.parse(snapshot(".cursor/rules/globbed-string.mdc"), ctx);
    expect(r.scopeRules[0]).toMatchObject({
      mechanism: "glob",
      globs: ["*.ts", "src/**/*.tsx"],
    });
    expect(r.scopeRules[0]!.metadata).toMatchObject({ tolerantParse: true });
    expect(r.diagnostics.some((d) => d.code === "cursor-tolerant-frontmatter")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "malformed-frontmatter")).toBe(false);
  });

  it("description-only → model-decision", () => {
    const r = parser.parse(snapshot(".cursor/rules/described.mdc"), ctx);
    expect(r.scopeRules[0]!.mechanism).toBe("model-decision");
  });

  it("no frontmatter → manual", () => {
    const r = parser.parse(snapshot(".cursor/rules/manual.mdc"), ctx);
    expect(r.scopeRules[0]!.mechanism).toBe("manual");
  });

  it("legacy .cursorrules → recognition only, always-on", () => {
    const r = parser.parse(snapshot(".cursorrules"), ctx);
    expect(r.nodes[0]!.metadata.legacy).toBe(true);
    expect(r.scopeRules[0]).toMatchObject({ mechanism: "always" });
  });
});

describe("cursor discovery pipeline", () => {
  it("full build reaches all rules including nested and legacy", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("cursor-rules"),
      graphRoot: "",
      settings: defaultSettings(),
      registry: new ParserRegistry(),
    });
    const cursorNodes = result.store
      .allNodes()
      .filter((n) => n.metadata.format === "cursor")
      .map((n) => n.path)
      .sort();
    expect(cursorNodes).toEqual([
      ".cursor/rules/always.mdc",
      ".cursor/rules/described.mdc",
      ".cursor/rules/globbed-list.mdc",
      ".cursor/rules/globbed-string.mdc",
      ".cursor/rules/manual.mdc",
      ".cursor/rules/sub/nested.mdc",
      ".cursorrules",
    ]);
  });

  it("cursor parser is disabled when format is removed from agents.formats", () => {
    const settings = defaultSettings({ agents: { formats: ["agents-md", "claude"] } });
    const ids = new ParserRegistry()
      .matching(".cursor/rules/always.mdc", settings)
      .map((p) => p.id);
    expect(ids).not.toContain("cursor");
  });
});
