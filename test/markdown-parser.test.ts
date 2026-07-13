import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarkdownParser } from "../src/parsers/markdown";
import { contentHash } from "../src/shared/hash";
import { defaultSettings, fixturePath } from "./helpers";

function snap(rel: string) {
  const abs = fixturePath(rel);
  const buf = readFileSync(abs);
  const contents = new Uint8Array(buf);
  // path relative to fixture root for the file itself
  const path = rel.includes("/") ? rel.split("/").slice(1).join("/") : rel;
  return { path, contents, hash: contentHash(contents) };
}

describe("MarkdownParser", () => {
  const parser = new MarkdownParser();
  const ctx = {
    workspaceRoot: fixturePath("basic-docs"),
    settings: defaultSettings(),
    log: () => {},
  };

  it("extracts links, frontmatter, headings", () => {
    const file = {
      path: "docs/architecture.md",
      contents: new Uint8Array(readFileSync(fixturePath("basic-docs/docs/architecture.md"))),
      hash: "x",
    };
    const result = parser.parse(file, ctx);
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node.type).toBe("document");
    expect(node.label).toBe("Architecture");
    expect(node.metadata.tags).toEqual(["design", "core"]);
    expect(node.metadata.headingSlugs).toContain("graph-model");
    expect(result.references.some((r) => r.rawTarget.includes("guide.md"))).toBe(true);
    expect(result.references.every((r) => r.range.start.line > 0)).toBe(true);
  });

  it("extracts wiki links when enabled", () => {
    const file = {
      path: "index.md",
      contents: new Uint8Array(readFileSync(fixturePath("wiki-links/index.md"))),
      hash: "x",
    };
    const result = parser.parse(file, ctx);
    const wikis = result.references.filter((r) => r.kind === "wiki-link");
    expect(wikis.length).toBeGreaterThanOrEqual(4);
  });

  it("does not crash on malicious fixtures", () => {
    const file = {
      path: "evil.md",
      contents: new Uint8Array(readFileSync(fixturePath("malicious/evil.md"))),
      hash: "x",
    };
    const result = parser.parse(file, ctx);
    expect(result.nodes).toHaveLength(1);
    // script tags are not executed / not stored as HTML
    expect(result.references.some((r) => r.rawTarget.startsWith("data:"))).toBe(false);
  });

  it("marks root README as entry point", () => {
    const file = {
      path: "README.md",
      contents: new Uint8Array(readFileSync(fixturePath("basic-docs/README.md"))),
      hash: "x",
    };
    const result = parser.parse(file, ctx);
    expect(result.nodes[0]!.metadata.entryPoint).toBe(true);
  });
});
