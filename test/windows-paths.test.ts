import { describe, expect, it } from "vitest";
import { findBrokenLinks } from "../src/analysis/orphans";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { resolveLinkTarget } from "../src/shared/paths";
import { defaultSettings, fixturePath } from "./helpers";

describe("windows-style paths", () => {
  const registry = new ParserRegistry();

  it("resolves backslash and URL-encoded links in the fixture", () => {
    const result = buildGraph({
      workspaceRoot: fixturePath("windows-paths"),
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    // All four README links resolve; nothing is broken.
    expect(findBrokenLinks(result.store)).toHaveLength(0);
    const links = result.store
      .allEdges()
      .filter((e) => e.type === "link" && e.source === "file:README.md");
    const targets = new Set(links.map((e) => e.target));
    expect(targets).toContain("file:docs/guide.md");
    expect(targets).toContain("file:docs/My Notes.md");
  });

  it("normalizes backslash separators in link targets", () => {
    const r = resolveLinkTarget("docs\\sub\\file.md", "README.md", "/ws");
    expect(r.path).toBe("docs/sub/file.md");
    expect(r.outsideWorkspace).toBe(false);
  });

  it("decodes percent-encoded targets", () => {
    const r = resolveLinkTarget("docs/My%20Notes.md", "README.md", "/ws");
    expect(r.path).toBe("docs/My Notes.md");
  });

  it("still catches traversal escapes written with backslashes", () => {
    const r = resolveLinkTarget("..\\..\\outside.md", "docs/a.md", "/ws");
    expect(r.outsideWorkspace).toBe(true);
  });

  it("case-sensitive IDs: differing case yields distinct node identities", () => {
    // Committed fixtures cannot contain case-colliding filenames (they would
    // not check out on Windows/macOS), so assert the identity rule directly.
    const a = resolveLinkTarget("Docs/Guide.md", "README.md", "/ws");
    const b = resolveLinkTarget("docs/guide.md", "README.md", "/ws");
    expect(a.path).not.toBe(b.path);
  });
});
