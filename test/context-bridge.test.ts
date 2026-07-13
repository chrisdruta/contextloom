import { describe, expect, it } from "vitest";
import type { ScopeMatch, ScopeMatchGroup } from "../src/scope/types";
import { ContextDetailsPayload } from "../src/shared/protocol";
import { toWireGroups } from "../src/webview/context-bridge";

const match = (over: Partial<ScopeMatch>): ScopeMatch => ({
  source: "file:AGENTS.md",
  sourcePath: "AGENTS.md",
  format: "agents-md",
  mechanism: "ancestry",
  status: "active",
  rank: 1,
  reason: "nearest AGENTS.md",
  confidence: 1,
  ...over,
});

describe("toWireGroups", () => {
  const groups: ScopeMatchGroup[] = [
    {
      format: "agents-md",
      matches: [
        match({}),
        match({ source: "file:packages/api/AGENTS.md", sourcePath: "packages/api/AGENTS.md" }),
      ],
      note: undefined,
    },
    {
      format: "claude-md",
      matches: [
        match({
          source: "file:shared/rules.md",
          sourcePath: "shared/rules.md",
          format: "claude-md",
          via: { importedFrom: "CLAUDE.md", depth: 1 },
        }),
      ],
      note: "All files load, concatenated root→leaf.",
    },
  ];

  it("enriches with labels and preserves structure", () => {
    const labels = new Map([
      ["file:AGENTS.md", "AGENTS.md"],
      ["file:shared/rules.md", "Shared rules"],
    ]);
    const wire = toWireGroups(groups, (id) => labels.get(id));
    expect(wire[0]!.matches[0]!.sourceLabel).toBe("AGENTS.md");
    expect(wire[0]!.matches[1]!.sourceLabel).toBeUndefined(); // unknown node tolerated
    expect(wire[1]!.note).toContain("concatenated");
    expect(wire[1]!.matches[0]!.via).toEqual({ importedFrom: "CLAUDE.md", depth: 1 });
  });

  it("produces wire-schema-valid output", () => {
    const wire = toWireGroups(groups, () => undefined);
    const r = ContextDetailsPayload.safeParse({
      subject: { filePath: "src/a.ts" },
      groups: wire,
    });
    expect(r.success).toBe(true);
  });
});
