import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexCache } from "../src/cache/cache";
import type { ParseResult } from "../src/shared/types";

const emptyResult = (): ParseResult => ({
  nodes: [],
  references: [],
  edges: [],
  diagnostics: [],
  scopeRules: [],
});

describe("IndexCache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("round-trips entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    const cache = new IndexCache(path);
    cache.load("settings1", "markdown@1");
    cache.set("docs/a.md", {
      contentHash: "abc",
      parserId: "markdown",
      parserVersion: 1,
      parseResult: emptyResult(),
    });
    cache.persist();

    const cache2 = new IndexCache(path);
    cache2.load("settings1", "markdown@1");
    expect(cache2.get("docs/a.md", "abc", "markdown", 1)).not.toBeNull();
    expect(cache2.get("docs/a.md", "zzz", "markdown", 1)).toBeNull();
  });

  it("invalidates on settings hash change", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    const cache = new IndexCache(path);
    cache.load("s1", "p1");
    cache.set("a.md", {
      contentHash: "h",
      parserId: "markdown",
      parserVersion: 1,
      parseResult: emptyResult(),
    });
    cache.persist();

    const cache2 = new IndexCache(path);
    cache2.load("s2", "p1");
    expect(cache2.get("a.md", "h", "markdown", 1)).toBeNull();
  });

  it("survives corrupt cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    writeFileSync(path, "{not json", "utf8");
    const cache = new IndexCache(path);
    cache.load("s", "p");
    expect(cache.get("a", "h", "markdown", 1)).toBeNull();
  });

  it("rejects structurally invalid cache entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        settingsHash: "s",
        parserFingerprint: "p",
        entries: {
          "a.md": {
            contentHash: "h",
            parserId: "markdown",
            parserVersion: 1,
            parseResult: { nodes: "not-an-array" },
          },
        },
      }),
    );
    const cache = new IndexCache(path);
    cache.load("s", "p");
    expect(cache.get("a.md", "h", "markdown", 1)).toBeNull();
  });
});
