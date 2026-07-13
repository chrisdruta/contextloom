import { describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store";
import type { ContextEdge, ContextNode } from "../src/shared/types";

function node(id: string, type: ContextNode["type"] = "document", path?: string): ContextNode {
  return {
    id,
    type,
    label: id,
    path,
    metadata: {},
    provenance: { parserId: "t", parserVersion: 1, origin: "explicit", confidence: 1 },
    cacheable: true,
  };
}

function edge(type: string, source: string, target: string): ContextEdge {
  return {
    id: `${type}|${source}|${target}`,
    type: type as ContextEdge["type"],
    source,
    target,
    occurrences: [],
    metadata: {},
    provenance: { parserId: "t", parserVersion: 1, origin: "explicit", confidence: 1 },
    cacheable: true,
  };
}

describe("GraphStore", () => {
  it("upserts nodes and edges with reverse index", () => {
    const s = new GraphStore();
    s.upsertNode(node("file:a.md", "document", "a.md"));
    s.upsertNode(node("file:b.md", "document", "b.md"));
    s.upsertEdge(edge("link", "file:a.md", "file:b.md"));
    expect(s.nodeCount()).toBe(2);
    expect(s.incoming("file:b.md")).toHaveLength(1);
    expect(s.outgoing("file:a.md")).toHaveLength(1);
  });

  it("merges edge occurrences", () => {
    const s = new GraphStore();
    s.upsertNode(node("file:a.md", "document", "a.md"));
    s.upsertNode(node("file:b.md", "document", "b.md"));
    const e1 = edge("link", "file:a.md", "file:b.md");
    e1.occurrences = [
      {
        path: "a.md",
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 2, offset: 1 },
      },
    ];
    s.upsertEdge(e1);
    const e2 = edge("link", "file:a.md", "file:b.md");
    e2.occurrences = [
      {
        path: "a.md",
        start: { line: 3, column: 1, offset: 10 },
        end: { line: 3, column: 2, offset: 11 },
      },
    ];
    s.upsertEdge(e2);
    expect(s.edgeCount()).toBe(1);
    expect(s.outgoing("file:a.md")[0]!.occurrences).toHaveLength(2);
  });

  it("replaceAll produces patch", () => {
    const s = new GraphStore();
    s.upsertNode(node("file:a.md", "document", "a.md"));
    const patch = s.replaceAll([node("file:b.md", "document", "b.md")], []);
    expect(patch.removedNodeIds).toContain("file:a.md");
    expect(patch.addedNodes.map((n) => n.id)).toContain("file:b.md");
  });

  it("path and basename indexes", () => {
    const s = new GraphStore();
    s.upsertNode(node("file:docs/Guide.md", "document", "docs/Guide.md"));
    expect(s.pathToId("docs/Guide.md")).toBe("file:docs/Guide.md");
    expect(s.pathsByBasename("guide")).toContain("docs/Guide.md");
  });
});
