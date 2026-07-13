import picomatch from "picomatch";
import type { ResolvedSettings } from "../settings/schema";
import type { ScopeRule } from "../shared/types";
import type { ImportExpansion } from "./imports";
import type { ScopeIndex } from "./types";

export interface ScopeIndexInput {
  workspaceRoot: string;
  settings: ResolvedSettings;
  scopeRules: Iterable<ScopeRule>;
  importChains?: Map<string, ImportExpansion[]>;
}

/** Build the immutable per-index snapshot the format adapters query. */
export function buildScopeIndex(input: ScopeIndexInput): ScopeIndex {
  const rulesByFormat = new Map<string, ScopeRule[]>();
  const instructionPathsByFormat = new Map<string, Set<string>>();

  for (const rule of input.scopeRules) {
    const list = rulesByFormat.get(rule.format) ?? [];
    list.push(rule);
    rulesByFormat.set(rule.format, list);
    if (rule.mechanism === "ancestry") {
      const set = instructionPathsByFormat.get(rule.format) ?? new Set();
      set.add(rule.sourcePath);
      instructionPathsByFormat.set(rule.format, set);
    }
  }
  // Deterministic adapter output regardless of parse order
  for (const list of rulesByFormat.values()) {
    list.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  }

  const matcherCache = new Map<string, ReturnType<typeof picomatch>>();

  return {
    workspaceRoot: input.workspaceRoot,
    settings: input.settings,
    rulesByFormat,
    instructionPathsByFormat,
    importChains: input.importChains ?? new Map(),
    matcher(glob: string) {
      let m = matcherCache.get(glob);
      if (!m) {
        m = picomatch(glob, { dot: true });
        matcherCache.set(glob, m);
      }
      return m;
    },
  };
}
