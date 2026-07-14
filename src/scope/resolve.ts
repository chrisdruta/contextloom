import { normalizePath, pathFromId } from "../shared/ids";
import {
  agentsMdAdapter,
  claudeMdAdapter,
  claudeRulesAdapter,
  claudeSkillsAdapter,
  cursorAdapter,
} from "./adapters";
import type { FormatAdapter, ScopeIndex, ScopeMatchGroup } from "./types";

/** Fixed registration order (PLAN G.2) — output group order is stable. */
const ADAPTERS: FormatAdapter[] = [
  agentsMdAdapter,
  claudeMdAdapter,
  claudeRulesAdapter,
  claudeSkillsAdapter,
  cursorAdapter,
];

/**
 * Which repository instructions apply to this file — and why?
 * Works for any workspace-relative path, indexed or not (a .ts source file is
 * the canonical subject). Never merges across formats: different tools read
 * different files, and pretending otherwise invents certainty.
 */
export function resolveContext(filePath: string, index: ScopeIndex): ScopeMatchGroup[] {
  const rel = normalizePath(filePath);
  const groups: ScopeMatchGroup[] = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.enabled(index.settings)) continue;
    const matches = adapter.matches(rel, index);
    if (matches.length === 0) continue;
    matches.sort((a, b) => a.rank - b.rank);
    groups.push({ format: adapter.format, matches, note: groupNote(adapter.format, matches) });
  }
  return groups;
}

/** G.4: conflicts are reported, never resolved. */
function groupNote(
  format: ScopeMatchGroup["format"],
  matches: ScopeMatchGroup["matches"],
): string | undefined {
  const active = matches.filter((m) => m.status === "active").length;
  if (active <= 1) return undefined;
  switch (format) {
    case "claude-md": {
      const base =
        "All files load, concatenated root→leaf — later files never override earlier ones.";
      // Oracle-verified vs Claude Code 2.1.x (scripts/oracle-validation.ts):
      // @imports expand only in the CLAUDE.md nearest the session cwd.
      return matches.some((m) => m.via)
        ? `${base} @imports expand only for the CLAUDE.md nearest Claude Code's working directory; ancestor files load unexpanded.`
        : base;
    }
    case "agents-md":
      return "Merge mode: all files apply root→leaf (Cursor/VS Code semantics; the agents.md spec itself is nearest-wins).";
    case "cursor":
      return "All apply — Cursor does not document a reading order for simultaneously active rules.";
    default:
      return "All apply — the order shown is the tool's documented reading order.";
  }
}

/**
 * Reverse lookup: every file a given instruction source is active for.
 * Powers on-selection applies-to highlighting (G.4) — applies-to edges are
 * never materialized in the store.
 */
export function filesInScope(
  sourceNodeId: string,
  index: ScopeIndex,
  allFiles: Iterable<string>,
): string[] {
  const sourcePath = pathFromId(sourceNodeId);
  if (!sourcePath) return [];

  const adapters = ADAPTERS.filter(
    (a) =>
      a.enabled(index.settings) &&
      ((index.instructionPathsByFormat.get(a.format)?.has(sourcePath) ?? false) ||
        (index.rulesByFormat.get(a.format) ?? []).some((r) => r.sourcePath === sourcePath)),
  );
  if (adapters.length === 0) return [];

  const out: string[] = [];
  for (const file of allFiles) {
    const rel = normalizePath(file);
    if (rel === sourcePath) continue;
    const hit = adapters.some((a) =>
      a.matches(rel, index).some((m) => m.sourcePath === sourcePath && m.status === "active"),
    );
    if (hit) out.push(rel);
  }
  return out.sort();
}
