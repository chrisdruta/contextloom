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

  it("round-trips claude-dir parse results (config node, rel refs, scope rules)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    const range = {
      path: ".claude/agents/reviewer.md",
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 2, offset: 1 },
    };
    const result: ParseResult = {
      nodes: [
        {
          id: "file:.claude/settings.json",
          type: "config",
          label: "settings.json",
          path: ".claude/settings.json",
          metadata: { topLevelKeys: ["permissions"] },
          provenance: {
            parserId: "claude-dir",
            parserVersion: 1,
            origin: "explicit",
            confidence: 1,
          },
          cacheable: true,
        },
      ],
      references: [{ kind: "frontmatter-ref", rel: "uses-skill", rawTarget: "deploy", range }],
      edges: [],
      diagnostics: [],
      scopeRules: [
        {
          sourcePath: ".claude/skills/deploy/SKILL.md",
          format: "claude-skills",
          mechanism: "glob",
          globs: ["**/*.ts"],
          metadata: { name: "deploy", claudeRoot: "" },
        },
      ],
    };
    const cache = new IndexCache(path);
    cache.load("s1", "claude-dir@1");
    cache.set(".claude/agents/reviewer.md", {
      contentHash: "h",
      parserId: "claude-dir",
      parserVersion: 1,
      parseResult: result,
    });
    cache.persist();

    const cache2 = new IndexCache(path);
    cache2.load("s1", "claude-dir@1");
    const hit = cache2.get(".claude/agents/reviewer.md", "h", "claude-dir", 1);
    expect(hit).not.toBeNull();
    expect(hit!.references[0]!.rel).toBe("uses-skill");
    expect(hit!.scopeRules[0]!.globs).toEqual(["**/*.ts"]);
  });

  it("a v0.1 parser fingerprint invalidates cleanly on upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    const cache = new IndexCache(path);
    cache.load("s1", "instruction@1,markdown@1"); // v0.1 fingerprint
    cache.set("a.md", {
      contentHash: "h",
      parserId: "markdown",
      parserVersion: 1,
      parseResult: emptyResult(),
    });
    cache.persist();

    const cache2 = new IndexCache(path);
    cache2.load("s1", "claude-dir@1,cursor@1,instruction@1,markdown@2"); // v0.2 fingerprint
    expect(cache2.get("a.md", "h", "markdown", 1)).toBeNull();
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
