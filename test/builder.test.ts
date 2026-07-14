import { describe, expect, it } from "vitest";
import { findBrokenLinks, findOrphans } from "../src/analysis/orphans";
import { exportGraphJson } from "../src/export/export";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { defaultSettings, fixturePath } from "./helpers";

describe("buildGraph", () => {
  const registry = new ParserRegistry();

  it("builds basic-docs graph", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("basic-docs"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    expect(result.fileCount).toBeGreaterThanOrEqual(4);
    expect(result.store.nodeCount()).toBeGreaterThan(0);
    const edges = result.store.allEdges().filter((e) => e.type === "link");
    expect(edges.length).toBeGreaterThan(0);
  });

  it("detects broken links", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("broken-links"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const broken = findBrokenLinks(result.store);
    expect(broken.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === "broken-link")).toBe(true);
  });

  it("wiki links: unique ok, ambiguous diagnostic", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("wiki-links"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const wiki = result.store.allEdges().filter((e) => e.type === "wiki-link");
    expect(wiki.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === "ambiguous-wiki-link")).toBe(true);
  });

  it("recognizes instruction nodes in nested-agents", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("nested-agents-md"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const instructions = result.store.allNodes().filter((n) => n.type === "instruction");
    expect(instructions.length).toBeGreaterThanOrEqual(2);
  });

  it("monorepo fixture: orphans and broken rollback", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("monorepo"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const broken = findBrokenLinks(result.store);
    expect(broken.some((e) => e.target.includes("rollback"))).toBe(true);
    const orphans = findOrphans(result.store);
    // packages/web/README.md should be an orphan
    expect(orphans.some((n) => n.path?.includes("packages/web"))).toBe(true);
  });

  it("links to real program/asset files become source-file nodes, not missing", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("code-links"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const store = result.store;

    // Existing non-md targets: source-file nodes with references edges
    for (const path of ["src/main.luau", "assets/logo.png", "wally.toml"]) {
      const node = store.getNode(`file:${path}`);
      expect(node?.type).toBe("source-file");
      const incoming = store.incoming(`file:${path}`);
      expect(incoming.some((e) => e.type === "references")).toBe(true);
      expect(incoming.some((e) => e.type === "broken-ref")).toBe(false);
    }
    // No false "unresolved" diagnostics for files that exist on disk
    expect(
      result.diagnostics.filter((d) => d.code === "unresolved" && d.message.includes("luau")),
    ).toHaveLength(0);

    // Truly absent target still classifies as missing + broken-ref + diagnostic
    expect(store.getNode("missing:src/ghost.py")?.type).toBe("missing");
    expect(
      result.diagnostics.some((d) => d.code === "broken-link" && d.message.includes("ghost")),
    ).toBe(true);

    // Directory links keep their dir-node behavior (pathExists is files-only)
    expect(store.getNode("dir:src")?.type).toBe("directory");
  });

  it("export is deterministic", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("basic-docs"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const a = exportGraphJson(result.store, "");
    const b = exportGraphJson(result.store, "");
    expect(a).toBe(b);
    expect(a).toContain('"schemaVersion": 1');
  });

  it("cancellation stops build", () => {
    let cancel = false;
    const result = buildGraph({
      workspaceRoot: fixturePath("basic-docs"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
      isCancelled: () => {
        cancel = true;
        return true;
      },
    });
    expect(cancel).toBe(true);
    expect(result.fileCount).toBe(0);
  });
});
