import { describe, expect, it } from "vitest";
import { ParserRegistry } from "../src/parsers/registry";
import { resolveSettings } from "../src/settings/schema";

const settings = resolveSettings({});

function parserIds(path: string): string[] {
  return new ParserRegistry().matching(path, settings).map((p) => p.id);
}

describe("ParserRegistry.matching", () => {
  it("routes instruction files exclusively to the instruction parser", () => {
    expect(parserIds("AGENTS.md")).toEqual(["instruction"]);
    expect(parserIds("packages/api/CLAUDE.md")).toEqual(["instruction"]);
    expect(parserIds("CLAUDE.local.md")).toEqual(["instruction"]);
    expect(parserIds(".claude/CLAUDE.md")).toEqual(["instruction"]);
  });

  it("routes plain markdown to the markdown parser", () => {
    expect(parserIds("docs/a.md")).toEqual(["markdown"]);
    expect(parserIds("README.md")).toEqual(["markdown"]);
  });

  it("matches files inside dotted directories (dot: true regression)", () => {
    // Discovery walks dotted dirs with dot:true; the registry must match them too.
    expect(parserIds(".claude/rules/style.md")).toContain("markdown");
    expect(parserIds(".cursor/notes/readme.md")).toContain("markdown");
  });

  it("falls back to pattern matching when the claiming parser is disabled", () => {
    const disabled = resolveSettings({ agents: { enabled: false } });
    const ids = new ParserRegistry().matching("AGENTS.md", disabled).map((p) => p.id);
    expect(ids).toEqual(["markdown"]);
  });

  it("returns no parsers for unmatched paths", () => {
    expect(parserIds("src/index.ts")).toEqual([]);
    expect(parserIds(".claude/skills/deploy/scripts/run.sh")).toEqual([]);
  });
});
