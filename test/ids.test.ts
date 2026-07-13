import { describe, expect, it } from "vitest";
import {
  dirId,
  edgeId,
  fileId,
  missingId,
  normalizePath,
  pathFromId,
  urlId,
} from "../src/shared/ids";
import { normalizeWorkspaceRelativePath } from "../src/shared/paths";

describe("normalizePath", () => {
  it("normalizes separators and dots", () => {
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
    expect(normalizePath("./a/./b")).toBe("a/b");
    expect(normalizePath("a/b/../c")).toBe("a/c");
  });

  it("does not escape above root", () => {
    expect(normalizePath("../../etc/passwd")).toBe("etc/passwd");
  });
});

describe("normalizeWorkspaceRelativePath", () => {
  it("normalizes safe relative paths", () => {
    expect(normalizeWorkspaceRelativePath("docs/./guide/../README.md")).toBe("docs/README.md");
    expect(normalizeWorkspaceRelativePath("docs\\README.md")).toBe("docs/README.md");
  });

  it("rejects absolute and escaping paths", () => {
    expect(normalizeWorkspaceRelativePath("../../etc/passwd")).toBeNull();
    expect(normalizeWorkspaceRelativePath("/etc/passwd")).toBeNull();
    expect(normalizeWorkspaceRelativePath("C:\\Windows\\system.ini")).toBeNull();
    expect(normalizeWorkspaceRelativePath("bad\0path.md")).toBeNull();
  });
});

describe("identity scheme", () => {
  it("prefixes correctly", () => {
    expect(fileId("docs/a.md")).toBe("file:docs/a.md");
    expect(dirId("docs")).toBe("dir:docs");
    expect(missingId("docs/x.md")).toBe("missing:docs/x.md");
    expect(urlId("https://Example.com/path/")).toBe("url:https://example.com/path");
    expect(edgeId("link", "file:a", "file:b")).toBe("link|file:a|file:b");
  });

  it("pathFromId", () => {
    expect(pathFromId("file:docs/a.md")).toBe("docs/a.md");
    expect(pathFromId("heading:docs/a.md#setup")).toBe("docs/a.md");
    expect(pathFromId("url:https://x.com")).toBeNull();
  });
});
