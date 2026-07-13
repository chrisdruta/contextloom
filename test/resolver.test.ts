import { describe, expect, it } from "vitest";
import { buildBasenameIndex, resolveReferences } from "../src/graph/resolver";
import type { RawReference } from "../src/shared/types";
import { defaultSettings } from "./helpers";

function ref(rawTarget: string, kind: RawReference["kind"] = "md-link"): RawReference {
  return {
    kind,
    rawTarget,
    range: {
      path: "docs/a.md",
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 10, offset: 9 },
    },
  };
}

describe("resolveReferences", () => {
  const existing = new Set(["docs/a.md", "docs/b.md", "README.md"]);
  const basenameIndex = buildBasenameIndex(existing);
  const settings = defaultSettings();

  it("resolves relative links", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("./b.md")],
      headingSlugsByPath: new Map(),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.edges.some((e) => e.type === "link" && e.target === "file:docs/b.md")).toBe(true);
  });

  it("creates broken-ref for missing targets", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("./gone.md")],
      headingSlugsByPath: new Map(),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.edges.some((e) => e.type === "broken-ref")).toBe(true);
    expect(out.nodes.some((n) => n.type === "missing")).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "broken-link")).toBe(true);
  });

  it("flags outside-workspace traversal", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("../../../../etc/passwd")],
      headingSlugsByPath: new Map(),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.diagnostics.some((d) => d.code === "outside-workspace")).toBe(true);
  });

  it("validates fragments", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("./b.md#missing-slug")],
      headingSlugsByPath: new Map([["docs/b.md", ["real-slug"]]]),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.diagnostics.some((d) => d.code === "broken-fragment")).toBe(true);
  });

  it("wiki-link unique resolve", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("b", "wiki-link")],
      headingSlugsByPath: new Map(),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.edges.some((e) => e.type === "wiki-link" && e.target === "file:docs/b.md")).toBe(
      true,
    );
  });

  it("wiki-link ambiguous → diagnostic, no edge", () => {
    const files = new Set(["notes/Shared.md", "other/Shared.md"]);
    const out = resolveReferences({
      sourcePath: "index.md",
      references: [
        {
          kind: "wiki-link",
          rawTarget: "Shared",
          range: {
            path: "index.md",
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 5, offset: 4 },
          },
        },
      ],
      headingSlugsByPath: new Map(),
      existingFiles: files,
      settings,
      workspaceRoot: "/ws",
      basenameIndex: buildBasenameIndex(files),
    });
    expect(out.diagnostics.some((d) => d.code === "ambiguous-wiki-link")).toBe(true);
    expect(out.edges.filter((e) => e.type === "wiki-link")).toHaveLength(0);
  });

  it("external URLs become external nodes", () => {
    const out = resolveReferences({
      sourcePath: "docs/a.md",
      references: [ref("https://example.com/page")],
      headingSlugsByPath: new Map(),
      existingFiles: existing,
      settings,
      workspaceRoot: "/ws",
      basenameIndex,
    });
    expect(out.nodes.some((n) => n.type === "external")).toBe(true);
  });
});
