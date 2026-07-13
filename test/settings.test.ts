import { describe, expect, it } from "vitest";
import { cacheRelevantSettings, resolveSettings } from "../src/settings/schema";
import { settingsHash } from "../src/shared/hash";

describe("resolveSettings", () => {
  it("applies defaults", () => {
    const s = resolveSettings({});
    expect(s.respectGitignore).toBe(true);
    expect(s.limits.maxFiles).toBe(20_000);
    expect(s.wikiLinks.resolution).toBe("shortest-unique");
    expect(s.agents.agentsMdMode).toBe("nearest");
    expect(s.agents.formats).toEqual(["agents-md", "claude", "cursor"]);
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

  it("rejects resource limits above safe caps", () => {
    const s = resolveSettings({
      graph: { showExternalLinks: false, maxNodes: 100_000 },
      limits: { maxFiles: 1_000_000, maxFileSizeKb: 1_000_000 },
    });
    expect(s.graph.maxNodes).toBe(3000);
    expect(s.limits.maxFiles).toBe(20_000);
    expect(s.limits.maxFileSizeKb).toBe(1024);
  });
});

describe("cacheRelevantSettings", () => {
  it("keeps the cache hash stable across agentsMdMode changes", () => {
    const nearest = resolveSettings({ agents: { agentsMdMode: "nearest" } });
    const merge = resolveSettings({ agents: { agentsMdMode: "merge" } });
    expect(settingsHash(cacheRelevantSettings(nearest))).toBe(
      settingsHash(cacheRelevantSettings(merge)),
    );
  });

  it("changes the cache hash when agents.formats changes", () => {
    const base = resolveSettings({});
    const noCursor = resolveSettings({ agents: { formats: ["agents-md", "claude"] } });
    expect(settingsHash(cacheRelevantSettings(base))).not.toBe(
      settingsHash(cacheRelevantSettings(noCursor)),
    );
  });

  it("changes the cache hash when agents.enabled changes", () => {
    const on = resolveSettings({});
    const off = resolveSettings({ agents: { enabled: false } });
    expect(settingsHash(cacheRelevantSettings(on))).not.toBe(
      settingsHash(cacheRelevantSettings(off)),
    );
  });
});
