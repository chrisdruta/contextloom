import { describe, expect, it } from "vitest";
import { resolveSettings } from "../src/settings/schema";

describe("resolveSettings", () => {
  it("applies defaults", () => {
    const s = resolveSettings({});
    expect(s.respectGitignore).toBe(true);
    expect(s.limits.maxFiles).toBe(20_000);
    expect(s.wikiLinks.resolution).toBe("shortest-unique");
  });

  it("falls back invalid values with warning", () => {
    const warnings: string[] = [];
    const s = resolveSettings({ limits: { maxFiles: "nope", maxFileSizeKb: 512 } } as never, (m) =>
      warnings.push(m),
    );
    expect(s.limits.maxFiles).toBe(20_000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("accepts valid overrides", () => {
    const s = resolveSettings({
      respectGitignore: false,
      graph: { showExternalLinks: true, maxNodes: 100 },
    });
    expect(s.respectGitignore).toBe(false);
    expect(s.graph.showExternalLinks).toBe(true);
    expect(s.graph.maxNodes).toBe(100);
  });
});
