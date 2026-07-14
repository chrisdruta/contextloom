// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeHierarchyPositions } from "../../webview-ui/src/hierarchy-layout";
import type { GraphNode } from "../../webview-ui/src/protocol";

function node(id: string, type: string, metadata: Record<string, unknown> = {}): GraphNode {
  return {
    id: `file:${id}`,
    type,
    label: id,
    path: id,
    metadata,
    provenance: { parserId: "test", parserVersion: 1, origin: "explicit", confidence: 1 },
    cacheable: true,
  };
}

const edge = (source: string, target: string) => ({
  source: `file:${source}`,
  target: `file:${target}`,
});

describe("computeHierarchyPositions", () => {
  const nodes = [
    node("CLAUDE.md", "instruction"),
    node("AGENTS.md", "instruction"),
    node(".claude/agents/reviewer.md", "agent"),
    node("README.md", "document", { entryPoint: true }),
    node("docs/guide.md", "document"),
    node("docs/deep.md", "document"),
    node("orphan.md", "document"),
    node("src/util.ts", "source-file"),
  ];
  const edges = [
    edge("README.md", "docs/guide.md"),
    edge("docs/guide.md", "docs/deep.md"),
    edge("docs/guide.md", "src/util.ts"),
  ];

  it("layers semantically: instructions on top, then agents, then docs by depth, orphans last", () => {
    const pos = computeHierarchyPositions(nodes, edges);
    const y = (id: string) => pos.get(`file:${id}`)!.y;

    // Same band shares a row
    expect(y("CLAUDE.md")).toBe(y("AGENTS.md"));
    // Strictly descending bands
    expect(y("CLAUDE.md")).toBeLessThan(y(".claude/agents/reviewer.md"));
    expect(y(".claude/agents/reviewer.md")).toBeLessThan(y("README.md"));
    expect(y("README.md")).toBeLessThan(y("docs/guide.md"));
    expect(y("docs/guide.md")).toBeLessThan(y("docs/deep.md"));
    // BFS reaches the linked source file below its linker
    expect(y("src/util.ts")).toBeGreaterThan(y("docs/guide.md"));
    // Orphan sinks below everything reached
    for (const other of ["CLAUDE.md", "README.md", "docs/guide.md", "docs/deep.md"]) {
      expect(y("orphan.md")).toBeGreaterThan(y(other));
    }
  });

  it("wraps wide bands into multiple rows instead of one endless line", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      node(`docs/page-${String(i).padStart(2, "0")}.md`, "document"),
    );
    const pos = computeHierarchyPositions(many, []);
    const ys = new Set([...pos.values()].map((p) => p.y));
    expect(ys.size).toBeGreaterThan(1); // wrapped
    const xs = [...pos.values()].map((p) => p.x);
    const width = Math.max(...xs) - Math.min(...xs);
    expect(width).toBeLessThan(40 * 190); // not a single straight line
  });

  it("sorts rows by path so directory siblings cluster", () => {
    const docs = [
      node("zeta/one.md", "document"),
      node("alpha/two.md", "document"),
      node("alpha/one.md", "document"),
    ];
    const pos = computeHierarchyPositions(docs, []);
    const x = (id: string) => pos.get(`file:${id}`)!.x;
    expect(x("alpha/one.md")).toBeLessThan(x("alpha/two.md"));
    expect(x("alpha/two.md")).toBeLessThan(x("zeta/one.md"));
  });
});
