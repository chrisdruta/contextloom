import type { AtImportCandidate } from "../parsers/at-imports";
import { normalizePath } from "../shared/ids";
import { resolveLinkTarget } from "../shared/paths";
import type { ContextNode, ParserDiagnostic, SourceRange } from "../shared/types";

/** Claude Code's documented @import recursion limit. */
export const MAX_IMPORT_DEPTH = 4;

export interface ImportExpansion {
  /** Imported file, workspace-relative. */
  path: string;
  /** 1 = imported directly by the root instruction file. */
  depth: number;
  /** The file whose @import pulled this one in. */
  via: string;
  /** Location of the @import occurrence in `via`. */
  range: SourceRange;
}

export interface ImportAnalysis {
  diagnostics: ParserDiagnostic[];
  /** Instruction path → ordered, depth-annotated expansion (depth ≤ MAX_IMPORT_DEPTH). */
  chains: Map<string, ImportExpansion[]>;
}

export interface ImportLink {
  target: string;
  range: SourceRange;
}

/**
 * Build the @import adjacency from document/instruction node metadata.
 * Only targets that resolve to existing workspace files participate —
 * missing targets already surface as broken-ref diagnostics upstream.
 */
export function buildImportAdjacency(
  nodes: Iterable<ContextNode>,
  workspaceRoot: string,
  exists: (path: string) => boolean,
): Map<string, ImportLink[]> {
  const adjacency = new Map<string, ImportLink[]>();
  for (const node of nodes) {
    if (!node.path) continue;
    const candidates = node.metadata.atImports;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const links: ImportLink[] = [];
    for (const candidate of candidates as AtImportCandidate[]) {
      const resolved = resolveLinkTarget(candidate.rawTarget, node.path, workspaceRoot);
      if (resolved.external || resolved.outsideWorkspace || !resolved.path) continue;
      const target = normalizePath(resolved.path);
      if (!exists(target)) continue;
      links.push({ target, range: candidate.range });
    }
    if (links.length > 0) adjacency.set(normalizePath(node.path), links);
  }
  return adjacency;
}

/**
 * Post-resolve pass enforcing @import depth ≤ 4 and cycle detection. Parsers
 * are per-file pure, so this cross-file walk is the only place either can be
 * checked. Imports beyond the limit stay visible as graph edges but are
 * excluded from `chains`, so scope resolution never claims them active.
 */
export function analyzeImports(
  rootPaths: Iterable<string>,
  adjacency: Map<string, ImportLink[]>,
): ImportAnalysis {
  const diagnostics: ParserDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const chains = new Map<string, ImportExpansion[]>();

  const report = (code: "import-cycle" | "import-depth", message: string, range: SourceRange) => {
    const key = `${code}|${range.path}|${range.start.offset}`;
    if (seenDiagnostics.has(key)) return;
    seenDiagnostics.add(key);
    diagnostics.push({ severity: "error", message, range, code });
  };

  for (const root of rootPaths) {
    const normalizedRoot = normalizePath(root);
    if (!adjacency.has(normalizedRoot)) continue;
    const expansions: ImportExpansion[] = [];
    const onPath = new Set<string>([normalizedRoot]);

    const visit = (from: string, depth: number) => {
      for (const link of adjacency.get(from) ?? []) {
        if (onPath.has(link.target)) {
          report(
            "import-cycle",
            `@import cycle: ${link.target} is already in this import chain`,
            link.range,
          );
          continue;
        }
        if (depth > MAX_IMPORT_DEPTH) {
          report(
            "import-depth",
            `@import exceeds Claude Code's depth limit of ${MAX_IMPORT_DEPTH}: ${link.target}`,
            link.range,
          );
          continue;
        }
        expansions.push({ path: link.target, depth, via: from, range: link.range });
        onPath.add(link.target);
        visit(link.target, depth + 1);
        onPath.delete(link.target);
      }
    };

    visit(normalizedRoot, 1);
    chains.set(normalizedRoot, expansions);
  }

  return { diagnostics, chains };
}
