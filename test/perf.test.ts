/**
 * Performance guard tests for PLAN §Q budgets, with generous hard limits to
 * absorb CI variance. Measured values log to the console; targets (1k files
 * < 2 s cold index, single-file patch < 150 ms) are asserted at 5× headroom.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFileChanges, buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { contentHash } from "../src/shared/hash";
import type { FileSnapshot } from "../src/shared/types";
import { defaultSettings } from "./helpers";

const FILE_COUNT = 1000;
const SECTION_SIZE = 50;

function generateCorpus(root: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const section = Math.floor(i / SECTION_SIZE);
    const dir = join(root, `section-${section}`);
    mkdirSync(dir, { recursive: true });
    const next = `doc-${(i + 1) % SECTION_SIZE}`;
    const lines = [
      `# Document ${i}`,
      "",
      `Sibling link: [next](./${next}.md)`,
      section > 0 ? "Cross link: [index](../section-0/doc-0.md)" : "",
      i % 7 === 0 ? "Wiki link: [[doc-1]]" : "",
      "",
      "Some body text to make parsing non-trivial. ".repeat(20),
    ];
    writeFileSync(join(dir, `doc-${i % SECTION_SIZE}.md`), lines.join("\n"));
  }
}

describe("performance budgets (PLAN §Q)", () => {
  const registry = new ParserRegistry();
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "cl-perf-"));
    generateCorpus(workspace, FILE_COUNT);
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it(`cold-indexes ${FILE_COUNT} files within budget`, () => {
    const t0 = performance.now();
    const result = buildGraph({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const ms = performance.now() - t0;
    console.log(`[perf] cold index ${FILE_COUNT} files: ${ms.toFixed(0)} ms (target 2000)`);
    expect(result.fileCount).toBe(FILE_COUNT);
    expect(ms).toBeLessThan(10_000); // 5× headroom over the 2 s target
  });

  it("applies a single-file patch within budget", () => {
    const build = buildGraph({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const path = "section-1/doc-3.md";
    const contents = new TextEncoder().encode(
      "# Document changed\n\n[new link](../section-2/doc-4.md)\n",
    );
    const snap: FileSnapshot = { path, contents, hash: contentHash(contents) };

    const t0 = performance.now();
    const { patch } = applyFileChanges(
      build.store,
      { created: [], changed: [snap], deleted: [] },
      {
        workspaceRoot: workspace,
        settings: defaultSettings(),
        registry,
        refIndex: build.refIndex,
        parseMeta: build.parseMeta,
        scopeRuleIndex: build.scopeRuleIndex,
        derivedIds: build.derivedIds,
        skipped: build.skipped,
      },
    );
    const ms = performance.now() - t0;
    console.log(`[perf] single-file patch: ${ms.toFixed(1)} ms (target 150)`);
    expect(patch.addedEdges.length + patch.updatedEdges.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(750); // 5× headroom over the 150 ms target
  });

  it("applies an instruction-file patch (scope recompute) within budget", () => {
    writeFileSync(join(workspace, "CLAUDE.md"), "# Root claude\n");
    writeFileSync(join(workspace, "section-1", "AGENTS.md"), "# Section agents\n");
    const build = buildGraph({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings(),
      registry,
    });
    const contents = new TextEncoder().encode("# Section agents — edited\n");
    const snap: FileSnapshot = {
      path: "section-1/AGENTS.md",
      contents,
      hash: contentHash(contents),
    };

    const t0 = performance.now();
    const { scope } = applyFileChanges(
      build.store,
      { created: [], changed: [snap], deleted: [] },
      {
        workspaceRoot: workspace,
        settings: defaultSettings(),
        registry,
        refIndex: build.refIndex,
        parseMeta: build.parseMeta,
        scopeRuleIndex: build.scopeRuleIndex,
        derivedIds: build.derivedIds,
        skipped: build.skipped,
      },
    );
    const ms = performance.now() - t0;
    console.log(`[perf] instruction patch incl. scope recompute: ${ms.toFixed(1)} ms (target 150)`);
    expect(scope).toBeDefined();
    expect(ms).toBeLessThan(750); // 5× headroom over the 150 ms target
  });
});
