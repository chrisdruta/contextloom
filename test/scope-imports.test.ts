import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { analyzeImports, buildImportAdjacency } from "../src/scope/imports";
import { defaultSettings, fixturePath } from "./helpers";

function analyze(fixture: string) {
  const result = buildGraph({
    workspaceRoot: fixturePath(fixture),
    graphRoot: "",
    settings: defaultSettings(),
    registry: new ParserRegistry(),
  });
  const nodes = result.store.allNodes();
  const paths = new Set(nodes.map((n) => n.path).filter((p): p is string => Boolean(p)));
  const adjacency = buildImportAdjacency(nodes, fixturePath(fixture), (p) => paths.has(p));
  const roots = nodes
    .filter((n) => n.type === "instruction" && n.metadata.format === "claude-md")
    .map((n) => n.path!);
  return analyzeImports(roots, adjacency);
}

describe("analyzeImports", () => {
  it("detects a direct two-file cycle", () => {
    const { diagnostics, chains } = analyze("claude-imports/cycle");
    expect(diagnostics.some((d) => d.code === "import-cycle")).toBe(true);
    const chain = chains.get("CLAUDE.md")!;
    // a.md (depth 1) and b.md (depth 2) load; the back-edge b→a is the cycle
    expect(chain.map((e) => `${e.path}@${e.depth}`)).toEqual(["a.md@1", "b.md@2"]);
  });

  it("detects a self-import", () => {
    const { diagnostics, chains } = analyze("claude-imports/selfy");
    expect(diagnostics.filter((d) => d.code === "import-cycle")).toHaveLength(1);
    expect(chains.get("CLAUDE.md")!.map((e) => e.path)).toEqual(["me.md"]);
  });

  it("detects a three-file cycle", () => {
    const { diagnostics, chains } = analyze("claude-imports/tri");
    expect(diagnostics.filter((d) => d.code === "import-cycle")).toHaveLength(1);
    expect(chains.get("CLAUDE.md")!.map((e) => e.path)).toEqual(["x.md", "y.md", "z.md"]);
  });

  it("cuts chains at depth 4 with an error at the depth-5 site", () => {
    const { diagnostics, chains } = analyze("claude-imports/deep");
    const depthErrors = diagnostics.filter((d) => d.code === "import-depth");
    expect(depthErrors).toHaveLength(1);
    expect(depthErrors[0]!.severity).toBe("error");
    expect(depthErrors[0]!.range.path).toBe("d4.md");
    const chain = chains.get("CLAUDE.md")!;
    expect(chain.map((e) => `${e.path}@${e.depth}`)).toEqual([
      "d1.md@1",
      "d2.md@2",
      "d3.md@3",
      "d4.md@4",
    ]);
  });

  it("ignores imports inside code fences and inline code", () => {
    const { diagnostics, chains } = analyze("claude-imports/fence");
    expect(diagnostics).toHaveLength(0);
    expect(chains.get("CLAUDE.md")!.map((e) => e.path)).toEqual(["ok.md"]);
  });

  it("follows @AGENTS.md interop imports", () => {
    const { chains } = analyze("claude-imports/interop");
    expect(chains.get("CLAUDE.md")!.map((e) => e.path)).toEqual(["AGENTS.md"]);
  });

  it("records via and range for each expansion", () => {
    const { chains } = analyze("claude-imports/deep");
    const chain = chains.get("CLAUDE.md")!;
    expect(chain[0]!.via).toBe("CLAUDE.md");
    expect(chain[1]!.via).toBe("d1.md");
    expect(chain[1]!.range.path).toBe("d1.md");
    expect(chain[1]!.range.start.line).toBeGreaterThan(0);
  });
});
