import type picomatch from "picomatch";
import type { ResolvedSettings } from "../settings/schema";
import type { ScopeRule } from "../shared/types";
import type { ImportExpansion } from "./imports";

export type ScopeFormat = "agents-md" | "claude-md" | "claude-rules" | "claude-skills" | "cursor";

export type ScopeStatus = "active" | "shadowed" | "conditional";

export type ScopeMechanism = "ancestry" | "glob" | "always" | "model-decision" | "manual";

/** One instruction source that applies (or is shadowed/conditional) for a file. */
export interface ScopeMatch {
  /** Node id of the instruction/rule/skill source. */
  source: string;
  sourcePath: string;
  format: ScopeFormat;
  mechanism: ScopeMechanism;
  status: ScopeStatus;
  /** Ordering within the format (1 = first in the tool's reading order). */
  rank: number;
  /** Human sentence, e.g. "nearest AGENTS.md (2 levels up)". */
  reason: string;
  /** 1.0 except tolerant-parse formats (cursor globs: 0.8). */
  confidence: number;
  /** Present for @import expansions. */
  via?: { importedFrom: string; depth: number };
}

export interface ScopeMatchGroup {
  format: ScopeFormat;
  matches: ScopeMatch[];
  /** G.4 note for same-format multi-active overlap, when applicable. */
  note?: string;
}

/** Per-format semantics owner (PLAN G.2). Pure — no I/O, no vscode. */
export interface FormatAdapter {
  readonly format: ScopeFormat;
  enabled(settings: ResolvedSettings): boolean;
  matches(filePath: string, index: ScopeIndex): ScopeMatch[];
}

/** Immutable per-build snapshot the adapters query. */
export interface ScopeIndex {
  workspaceRoot: string;
  settings: ResolvedSettings;
  /** All scope rules keyed by ScopeRule.format ("agents-md", "claude-md", "claude-rules", "claude-skills", "cursor"). */
  rulesByFormat: Map<string, ScopeRule[]>;
  /** Instruction file paths per ancestry format (constant-time existence checks). */
  instructionPathsByFormat: Map<string, Set<string>>;
  /** Instruction path → ordered @import expansion (from analyzeImports). */
  importChains: Map<string, ImportExpansion[]>;
  /** Memoized picomatch({dot: true}) matcher. */
  matcher(glob: string): ReturnType<typeof picomatch>;
}
