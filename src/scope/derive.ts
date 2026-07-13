import { fileId, normalizePath } from "../shared/ids";
import { basename } from "../shared/paths";
import type { ContextEdge, ContextNode, Provenance, SourceRange } from "../shared/types";
import { ancestorDirs } from "./adapters";

const SCOPE_PROV = (): Provenance => ({
  parserId: "scope",
  parserVersion: 1,
  origin: "explicit",
  confidence: 1,
});

export interface DeriveInput {
  /** All nodes emitted by parsing/resolution (pre-store). */
  nodes: ContextNode[];
  /** Every discovered file path (parsed or not). */
  allPaths: Iterable<string>;
  /** Discovery skips (binary/oversized) — still shown inside skill dirs. */
  skipped: { path: string; reason: string }[];
}

export interface DeriveOutput {
  /** New nodes (source-file placeholders) and updated nodes (qualified labels). */
  nodes: ContextNode[];
  edges: ContextEdge[];
}

/**
 * Build-time structural edges (cheap, static — O(instruction files)):
 * overrides, inherits-from, skill contains. applies-to stays query-time only
 * (resolveContext/filesInScope). All output is cacheable:false and recomputed
 * on every build (F.5: derived state is never cached).
 */
export function deriveStructuralEdges(input: DeriveInput): DeriveOutput {
  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));

  const instructionsOf = (format: string): ContextNode[] =>
    input.nodes.filter((n) => n.type === "instruction" && n.metadata.format === format && n.path);

  // AGENTS.md: nearest → each ancestor (overrides + inherits-from the nearest)
  const agentsFiles = new Set(instructionsOf("agents-md").map((n) => n.path!));
  for (const path of agentsFiles) {
    const ancestors = ancestorsOfInstruction(path, "AGENTS.md", agentsFiles);
    for (const [i, ancestor] of ancestors.entries()) {
      edges.push(
        makeEdge("overrides", fileId(path), fileId(ancestor), path, {
          note: "nearest-wins per the agents.md spec; merged instead under Cursor/VS Code semantics",
        }),
      );
      if (i === 0) {
        edges.push(makeEdge("inherits-from", fileId(path), fileId(ancestor), path));
      }
    }
  }

  // CLAUDE.md: nested → nearest ancestor (concatenation chain, never overriding)
  const claudeFiles = new Set(instructionsOf("claude-md").map((n) => n.path!));
  for (const path of claudeFiles) {
    const nearest = nearestClaudeAncestor(path, claudeFiles);
    if (nearest) {
      edges.push(
        makeEdge("inherits-from", fileId(path), fileId(nearest), path, {
          note: "concatenates after its ancestor — does not override it",
        }),
      );
    }
  }

  // Skills: contains edges to every file under the skill directory
  const skills = input.nodes.filter((n) => n.type === "skill" && n.path);
  const skillDirs = skills.map((n) => ({
    node: n,
    dir: n.path!.replace(/\/SKILL\.md$/, ""),
  }));
  const allFiles = [
    ...new Set([...input.allPaths, ...input.skipped.map((s) => s.path)].map(normalizePath)),
  ];
  for (const { node, dir } of skillDirs) {
    for (const path of allFiles) {
      if (!path.startsWith(`${dir}/`) || path === node.path) continue;
      const convention = path.slice(dir.length + 1).split("/")[0];
      edges.push(
        makeEdge("contains", node.id, fileId(path), node.path!, {
          convention: ["scripts", "references", "assets"].includes(convention ?? "")
            ? convention
            : undefined,
        }),
      );
      if (!nodeById.has(fileId(path))) {
        nodes.push({
          id: fileId(path),
          type: "source-file",
          label: basename(path),
          path,
          scope: dir,
          metadata: { skillSupportingFile: true },
          provenance: SCOPE_PROV(),
          cacheable: false,
        });
      }
    }
  }

  // Qualified labels on cross-package name clashes (apps/web:deploy)
  const byName = new Map<string, ContextNode[]>();
  for (const skill of skills) {
    const name = String(skill.metadata.name ?? skill.label);
    byName.set(name, [...(byName.get(name) ?? []), skill]);
  }
  for (const [name, clashing] of byName) {
    if (clashing.length < 2) continue;
    for (const skill of clashing) {
      const root = String(skill.metadata.claudeRoot ?? "");
      if (root === "") continue; // workspace-root skill keeps the bare name
      nodes.push({
        ...skill,
        label: `${root}:${name}`,
        metadata: { ...skill.metadata, qualifiedName: `${root}:${name}` },
      });
    }
  }

  // Commands shadowed by a same-name skill in the same .claude root
  const skillKeys = new Set(
    skills.map((s) => `${String(s.metadata.claudeRoot ?? "")}|${String(s.metadata.name ?? "")}`),
  );
  for (const command of input.nodes.filter((n) => n.type === "command")) {
    const key = `${String(command.metadata.claudeRoot ?? "")}|${String(command.metadata.name ?? "")}`;
    if (skillKeys.has(key)) {
      nodes.push({
        ...command,
        metadata: { ...command.metadata, shadowedBySkill: true },
      });
    }
  }

  return { nodes, edges };
}

/** All same-name instruction files in strictly-ancestor directories, nearest first. */
function ancestorsOfInstruction(path: string, name: string, existing: Set<string>): string[] {
  const out: string[] = [];
  // skip the file's own directory (index 0 is dirname)
  for (const dir of ancestorDirs(path).slice(1)) {
    const candidate = dir === "" ? name : `${dir}/${name}`;
    if (existing.has(candidate)) out.push(candidate);
  }
  return out;
}

function nearestClaudeAncestor(path: string, existing: Set<string>): string | null {
  for (const dir of ancestorDirs(path).slice(1)) {
    for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
      const candidate = dir === "" ? name : `${dir}/${name}`;
      if (existing.has(candidate) && candidate !== path) return candidate;
    }
  }
  return null;
}

function makeEdge(
  type: ContextEdge["type"],
  source: string,
  target: string,
  atPath: string,
  metadata: Record<string, unknown> = {},
): ContextEdge {
  return {
    id: `${type}|${source}|${target}`,
    type,
    source,
    target,
    occurrences: [lineOneRange(atPath)],
    metadata,
    provenance: SCOPE_PROV(),
    cacheable: false,
  };
}

function lineOneRange(path: string): SourceRange {
  return {
    path,
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
}
