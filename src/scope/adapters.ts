import type { ResolvedSettings } from "../settings/schema";
import { fileId, normalizePath } from "../shared/ids";
import type { ScopeRule } from "../shared/types";
import type { FormatAdapter, ScopeIndex, ScopeMatch } from "./types";

/** Ancestor directories of a file, nearest first, ending with "" (workspace root). */
export function ancestorDirs(filePath: string): string[] {
  const segments = normalizePath(filePath).split("/");
  const dirs: string[] = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    dirs.push(segments.slice(0, i).join("/"));
  }
  dirs.push("");
  return dirs;
}

function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Path relative to root, or null when the file is not under it ("" = whole workspace). */
function relativeTo(path: string, root: string): string | null {
  if (root === "") return path;
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function levelsUpLabel(fileDir: string, instructionDir: string): string {
  const fileDepth = fileDir === "" ? 0 : fileDir.split("/").length;
  const instrDepth = instructionDir === "" ? 0 : instructionDir.split("/").length;
  const up = fileDepth - instrDepth;
  if (up <= 0) return "same directory";
  return up === 1 ? "1 level up" : `${up} levels up`;
}

const agentsEnabled = (s: ResolvedSettings, format: string) =>
  s.agents.enabled && s.agents.formats.includes(format);

/**
 * AGENTS.md (agents.md spec): the nearest file in the ancestor chain wins.
 * `agents.agentsMdMode: "merge"` models Cursor/VS Code consumers, which merge
 * nested files root→leaf instead of overriding.
 */
export const agentsMdAdapter: FormatAdapter = {
  format: "agents-md",
  enabled: (s) => agentsEnabled(s, "agents-md"),
  matches(filePath, index): ScopeMatch[] {
    const paths = index.instructionPathsByFormat.get("agents-md");
    if (!paths || paths.size === 0) return [];
    const fileDir = ancestorDirs(filePath)[0] ?? "";
    const found: { path: string; dir: string }[] = [];
    for (const dir of ancestorDirs(filePath)) {
      const candidate = join(dir, "AGENTS.md");
      if (paths.has(candidate)) found.push({ path: candidate, dir });
    }
    if (found.length === 0) return [];

    const merge = index.settings.agents.agentsMdMode === "merge";
    if (merge) {
      // Root-first, all active (Cursor/VS Code semantics)
      return found
        .slice()
        .reverse()
        .map((f, i) => ({
          source: fileId(f.path),
          sourcePath: f.path,
          format: "agents-md" as const,
          mechanism: "ancestry" as const,
          status: "active" as const,
          rank: i + 1,
          reason: `merged root→leaf (${levelsUpLabel(fileDir, f.dir)}) — merge mode`,
          confidence: 1,
        }));
    }

    return found.map((f, i) => ({
      source: fileId(f.path),
      sourcePath: f.path,
      format: "agents-md" as const,
      mechanism: "ancestry" as const,
      status: i === 0 ? ("active" as const) : ("shadowed" as const),
      rank: i + 1,
      reason:
        i === 0
          ? `nearest AGENTS.md (${levelsUpLabel(fileDir, f.dir)})`
          : `overridden by ${found[0]!.path} (nearest-wins; merged instead under Cursor/VS Code semantics)`,
      confidence: 1,
    }));
  },
};

/**
 * CLAUDE.md family: every ancestor file loads, concatenated root→leaf — never
 * overriding. CLAUDE.local.md appends after its sibling; @import expansions
 * inherit their importer's position.
 */
export const claudeMdAdapter: FormatAdapter = {
  format: "claude-md",
  enabled: (s) => agentsEnabled(s, "claude"),
  matches(filePath, index): ScopeMatch[] {
    const paths = index.instructionPathsByFormat.get("claude-md");
    if (!paths || paths.size === 0) return [];

    // Root-first ancestor walk; within a dir: CLAUDE.md / .claude/CLAUDE.md, then CLAUDE.local.md
    const ordered: string[] = [];
    for (const dir of ancestorDirs(filePath).reverse()) {
      for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
        const candidate = join(dir, name);
        if (paths.has(candidate)) ordered.push(candidate);
      }
    }
    if (ordered.length === 0) return [];

    const matches: ScopeMatch[] = [];
    let rank = 0;
    for (const path of ordered) {
      rank++;
      matches.push({
        source: fileId(path),
        sourcePath: path,
        format: "claude-md",
        mechanism: "ancestry",
        status: "active",
        rank,
        reason:
          rank === 1
            ? "ancestor CLAUDE.md — concatenated first"
            : `concatenated after ${matches[matches.length - 1]!.sourcePath} — does not override it`,
        confidence: 1,
      });
      for (const exp of index.importChains.get(path) ?? []) {
        rank++;
        matches.push({
          source: fileId(exp.path),
          sourcePath: exp.path,
          format: "claude-md",
          mechanism: "ancestry",
          status: "active",
          rank,
          reason: `imported by ${exp.via} (@import, depth ${exp.depth})`,
          confidence: 1,
          via: { importedFrom: exp.via, depth: exp.depth },
        });
      }
    }
    return matches;
  },
};

/** Shared glob semantics for .claude rules and skills/commands. */
function claudeGlobAdapter(format: "claude-rules" | "claude-skills"): FormatAdapter {
  return {
    format,
    enabled: (s) => agentsEnabled(s, "claude"),
    matches(filePath, index): ScopeMatch[] {
      const rules = index.rulesByFormat.get(format) ?? [];
      const matches: ScopeMatch[] = [];
      for (const rule of rules) {
        const claudeRoot =
          typeof rule.metadata?.claudeRoot === "string" ? rule.metadata.claudeRoot : "";
        const rel = relativeTo(filePath, claudeRoot);
        if (rel === null) continue; // scoped to a package the file is outside of

        const match = matchRule(rule, rel, index);
        if (!match) continue;
        matches.push({
          source: fileId(rule.sourcePath),
          sourcePath: rule.sourcePath,
          format,
          mechanism: rule.mechanism,
          status: match.status,
          rank: matches.length + 1,
          reason: match.reason,
          confidence: 1,
        });
      }
      return matches;
    },
  };
}

function matchRule(
  rule: ScopeRule,
  rel: string,
  index: ScopeIndex,
): { status: ScopeMatch["status"]; reason: string } | null {
  const name = typeof rule.metadata?.name === "string" ? rule.metadata.name : rule.sourcePath;
  switch (rule.mechanism) {
    case "glob": {
      const matched = (rule.globs ?? []).find((g) => index.matcher(g)(rel));
      if (!matched) return null;
      return { status: "active", reason: `glob \`${matched}\` matched` };
    }
    case "always":
      return { status: "active", reason: "always-on rule (no paths)" };
    case "model-decision":
      return {
        status: "conditional",
        reason: `skill "${name}" has no paths — the model decides when to load it`,
      };
    case "manual":
      return { status: "conditional", reason: `command "${name}" — manual invocation only` };
    default:
      return null;
  }
}

export const claudeRulesAdapter = claudeGlobAdapter("claude-rules");
export const claudeSkillsAdapter = claudeGlobAdapter("claude-skills");

/** Cursor rules: only .cursor/rules dirs in the file's ancestor chain apply. */
export const cursorAdapter: FormatAdapter = {
  format: "cursor",
  enabled: (s) => agentsEnabled(s, "cursor"),
  matches(filePath, index): ScopeMatch[] {
    const rules = index.rulesByFormat.get("cursor") ?? [];
    const matches: ScopeMatch[] = [];
    for (const rule of rules) {
      const root = cursorRoot(rule.sourcePath);
      const rel = relativeTo(filePath, root);
      if (rel === null) continue;

      const confidence =
        typeof rule.metadata?.confidence === "number" ? rule.metadata.confidence : 1;
      let status: ScopeMatch["status"];
      let reason: string;
      switch (rule.mechanism) {
        case "always":
          status = "active";
          reason = rule.metadata?.legacy ? "legacy .cursorrules — always on" : "alwaysApply rule";
          break;
        case "glob": {
          const matched = (rule.globs ?? []).find((g) => index.matcher(g)(rel));
          if (!matched) continue;
          status = "active";
          reason = `glob \`${matched}\` matched (Cursor glob dialect — parsed tolerantly)`;
          break;
        }
        case "model-decision":
          status = "conditional";
          reason = "description-only rule — the model decides when to apply it";
          break;
        case "manual":
          status = "conditional";
          reason = "manual rule — applies only when @mentioned";
          break;
        default:
          continue;
      }
      matches.push({
        source: fileId(rule.sourcePath),
        sourcePath: rule.sourcePath,
        format: "cursor",
        mechanism: rule.mechanism,
        status,
        rank: matches.length + 1,
        reason,
        confidence,
      });
    }
    return matches;
  },
};

/** Directory containing `.cursor` for rule files, or the file's own dir for legacy .cursorrules. */
function cursorRoot(sourcePath: string): string {
  const segments = normalizePath(sourcePath).split("/");
  const idx = segments.lastIndexOf(".cursor");
  if (idx >= 0) return segments.slice(0, idx).join("/");
  return segments.slice(0, -1).join("/");
}
