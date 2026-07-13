import { classifyClaudePath } from "../parsers/claude-dir";
import type { ResolvedSettings } from "../settings/schema";
import { dirId, edgeId, fileId, missingId, urlId } from "../shared/ids";
import { basename, dirname, extname, resolveLinkTarget } from "../shared/paths";
import type {
  ContextEdge,
  ContextNode,
  ParserDiagnostic,
  Provenance,
  RawReference,
  SourceRange,
} from "../shared/types";
import type { GraphStore } from "./store";

const RESOLVER_PROV = (parserId = "resolver"): Provenance => ({
  parserId,
  parserVersion: 1,
  origin: "explicit",
  confidence: 1,
});

export interface SkillIndexEntry {
  path: string;
  claudeRoot: string;
}

export interface ResolveInput {
  sourcePath: string;
  references: RawReference[];
  /** Heading slugs on the source file (for intra-file anchors). */
  sourceHeadingSlugs?: string[];
  /** Heading slugs by path for fragment validation. */
  headingSlugsByPath: Map<string, string[]>;
  /** Set of existing file paths in the index (workspace-relative). */
  existingFiles: Set<string>;
  /** Optional: also check non-md files exist (from a broader set). */
  pathExists?: (path: string) => boolean;
  settings: ResolvedSettings;
  workspaceRoot: string;
  /** Basename → paths for wiki resolution. */
  basenameIndex: Map<string, string[]>;
  /** Skill name → SKILL.md locations, for uses-skill references. */
  skillIndex?: Map<string, SkillIndexEntry[]>;
}

export interface ResolveOutput {
  nodes: ContextNode[];
  edges: ContextEdge[];
  diagnostics: ParserDiagnostic[];
}

/**
 * Two-phase link resolver: RawReference → edges / missing / ambiguous diagnostics.
 */
export function resolveReferences(input: ResolveInput): ResolveOutput {
  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const nodeIds = new Set<string>();

  const exists = (p: string) => input.existingFiles.has(p) || (input.pathExists?.(p) ?? false);

  const addNode = (n: ContextNode) => {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
  };

  const addEdge = (e: ContextEdge) => {
    const existing = edges.find((x) => x.id === e.id);
    if (existing) {
      existing.occurrences.push(...e.occurrences);
      return;
    }
    edges.push(e);
  };

  const sourceId = fileId(input.sourcePath);

  for (const ref of input.references) {
    if (ref.kind === "wiki-link") {
      resolveWiki(ref, input, exists, addNode, addEdge, diagnostics, sourceId);
      continue;
    }

    if (ref.rel === "uses-skill") {
      resolveUsesSkill(ref, input, addNode, addEdge, diagnostics, sourceId);
      continue;
    }

    // md-link, image, import, frontmatter-ref
    const resolved = resolveLinkTarget(ref.rawTarget, input.sourcePath, input.workspaceRoot);

    if (resolved.external && resolved.url) {
      const tid = urlId(resolved.url);
      addNode({
        id: tid,
        type: "external",
        label: resolved.url,
        metadata: { url: resolved.url },
        provenance: RESOLVER_PROV(),
        cacheable: true,
      });
      const edgeType = ref.kind === "image" ? "references" : "link";
      addEdge(
        makeEdge(edgeType, sourceId, tid, [ref.range], {
          rawTarget: ref.rawTarget,
          external: true,
        }),
      );
      continue;
    }

    if (resolved.outsideWorkspace || !resolved.path) {
      const label = resolved.path ?? ref.rawTarget;
      const tid = missingId(label);
      addNode({
        id: tid,
        type: "missing",
        label: basename(label) || label,
        path: resolved.path ?? undefined,
        metadata: {
          reason: resolved.outsideWorkspace ? "outside-workspace" : "unresolved",
          rawTarget: ref.rawTarget,
        },
        provenance: RESOLVER_PROV(),
        cacheable: false,
      });
      addEdge(
        makeEdge("broken-ref", sourceId, tid, [ref.range], {
          rawTarget: ref.rawTarget,
          outsideWorkspace: resolved.outsideWorkspace,
        }),
      );
      diagnostics.push({
        severity: "warning",
        message: resolved.outsideWorkspace
          ? `Link escapes workspace: ${ref.rawTarget}`
          : `Unresolved link: ${ref.rawTarget}`,
        range: ref.range,
        code: resolved.outsideWorkspace ? "outside-workspace" : "unresolved",
      });
      continue;
    }

    const targetPath = resolved.path;
    const fragment = resolved.fragment;

    // Intra-file fragment only
    if (fragment && targetPath === input.sourcePath && ref.rawTarget.trim().startsWith("#")) {
      const slugs = input.sourceHeadingSlugs ?? input.headingSlugsByPath.get(targetPath) ?? [];
      if (!slugs.includes(fragment)) {
        diagnostics.push({
          severity: "warning",
          message: `Broken fragment: #${fragment}`,
          range: ref.range,
          code: "broken-fragment",
        });
      }
      // No edge for pure intra-file anchors
      continue;
    }

    // Directory target?
    const isDirLink = ref.rawTarget.endsWith("/") || (!extname(targetPath) && !exists(targetPath));

    if (exists(targetPath)) {
      const tid = fileId(targetPath);
      // Ensure target node exists if not yet in store (source-file or will be filled by parser)
      if (!input.existingFiles.has(targetPath)) {
        addNode({
          id: tid,
          type: "source-file",
          label: basename(targetPath),
          path: targetPath,
          metadata: {},
          provenance: RESOLVER_PROV(),
          cacheable: true,
        });
      }

      // Fragment validation
      if (fragment) {
        const slugs = input.headingSlugsByPath.get(targetPath) ?? [];
        if (slugs.length > 0 && !slugs.includes(fragment)) {
          diagnostics.push({
            severity: "warning",
            message: `Broken fragment: ${targetPath}#${fragment}`,
            range: ref.range,
            code: "broken-fragment",
          });
        }
      }

      const isMd = /\.mdc?$/i.test(targetPath);
      const edgeType =
        ref.kind === "image" || ref.kind === "import" ? "references" : isMd ? "link" : "references";

      addEdge(
        makeEdge(edgeType, sourceId, tid, [ref.range], {
          rawTarget: ref.rawTarget,
          fragment: fragment ?? undefined,
          kind: ref.kind,
        }),
      );
      continue;
    }

    // Maybe it's a directory that has indexed children
    if (isDirLink || looksLikeDir(targetPath, input.existingFiles)) {
      const tid = dirId(targetPath);
      addNode({
        id: tid,
        type: "directory",
        label: basename(targetPath) || targetPath || ".",
        path: targetPath,
        metadata: {},
        provenance: RESOLVER_PROV(),
        cacheable: true,
      });
      addEdge(
        makeEdge("references", sourceId, tid, [ref.range], {
          rawTarget: ref.rawTarget,
          kind: ref.kind,
        }),
      );
      continue;
    }

    // Missing target
    const tid = missingId(targetPath);
    addNode({
      id: tid,
      type: "missing",
      label: basename(targetPath),
      path: targetPath,
      metadata: { rawTarget: ref.rawTarget, fragment: fragment ?? undefined },
      provenance: RESOLVER_PROV(),
      cacheable: false,
    });
    addEdge(
      makeEdge("broken-ref", sourceId, tid, [ref.range], {
        rawTarget: ref.rawTarget,
        fragment: fragment ?? undefined,
        kind: ref.kind,
      }),
    );
    diagnostics.push({
      severity: "warning",
      message: `Broken link: ${ref.rawTarget} → ${targetPath}`,
      range: ref.range,
      code: "broken-link",
    });
  }

  // Ensure directory contains edges for the source file's parent chain
  ensureDirContains(input.sourcePath, addNode, addEdge);

  return { nodes, edges, diagnostics };
}

function resolveWiki(
  ref: RawReference,
  input: ResolveInput,
  exists: (p: string) => boolean,
  addNode: (n: ContextNode) => void,
  addEdge: (e: ContextEdge) => void,
  diagnostics: ParserDiagnostic[],
  sourceId: string,
): void {
  let targetPart = ref.rawTarget;
  let fragment: string | undefined;
  const hash = targetPart.indexOf("#");
  if (hash >= 0) {
    fragment = targetPart.slice(hash + 1) || undefined;
    targetPart = targetPart.slice(0, hash);
  }

  if (input.settings.wikiLinks.resolution === "root-relative") {
    const path = targetPart.replace(/\\/g, "/").replace(/^\//, "");
    const candidates = [path, path.endsWith(".md") ? path : `${path}.md`];
    const hit = candidates.find((c) => exists(c));
    if (hit) {
      addEdge(
        makeEdge("wiki-link", sourceId, fileId(hit), [ref.range], {
          rawTarget: ref.rawTarget,
          fragment,
        }),
      );
      return;
    }
    const tid = missingId(candidates[1] ?? path);
    addNode({
      id: tid,
      type: "missing",
      label: basename(path),
      path: candidates[1] ?? path,
      metadata: { wiki: true, rawTarget: ref.rawTarget },
      provenance: RESOLVER_PROV(),
      cacheable: false,
    });
    addEdge(makeEdge("broken-ref", sourceId, tid, [ref.range], { rawTarget: ref.rawTarget }));
    diagnostics.push({
      severity: "warning",
      message: `Broken wiki link: [[${ref.rawTarget}]]`,
      range: ref.range,
      code: "broken-wiki-link",
    });
    return;
  }

  // shortest-unique basename (Obsidian-style)
  const needle = targetPart.replace(/\\/g, "/");
  const base = basename(needle)
    .toLowerCase()
    .replace(/\.mdc?$/i, "");
  const withPath = needle.includes("/");

  let candidates: string[] = [];
  if (withPath) {
    const norm = needle.replace(/^\//, "");
    const opts = [norm, norm.endsWith(".md") ? norm : `${norm}.md`];
    candidates = opts.filter((c) => exists(c));
  } else {
    const byBase = input.basenameIndex.get(base) ?? input.basenameIndex.get(`${base}.md`) ?? [];
    // Also try exact basename keys
    const all = new Set<string>([
      ...byBase,
      ...(input.basenameIndex.get(base.toLowerCase()) ?? []),
    ]);
    // Filter existing
    candidates = [...all].filter((p) => exists(p));
    // If empty, scan all files for basename match
    if (candidates.length === 0) {
      for (const f of input.existingFiles) {
        const b = basename(f)
          .toLowerCase()
          .replace(/\.mdc?$/i, "");
        if (b === base) candidates.push(f);
      }
    }
  }

  if (candidates.length === 1) {
    const hit = candidates[0]!;
    addEdge(
      makeEdge("wiki-link", sourceId, fileId(hit), [ref.range], {
        rawTarget: ref.rawTarget,
        fragment,
      }),
    );
    if (fragment) {
      const slugs = input.headingSlugsByPath.get(hit) ?? [];
      if (slugs.length > 0 && !slugs.includes(fragment)) {
        diagnostics.push({
          severity: "warning",
          message: `Broken fragment in wiki link: [[${ref.rawTarget}]]`,
          range: ref.range,
          code: "broken-fragment",
        });
      }
    }
    return;
  }

  if (candidates.length > 1) {
    diagnostics.push({
      severity: "warning",
      message: `Ambiguous wiki link: [[${ref.rawTarget}]] → ${candidates.join(", ")}`,
      range: ref.range,
      code: "ambiguous-wiki-link",
    });
    // No edge — never guess
    return;
  }

  // Missing
  const guess = needle.endsWith(".md") ? needle : `${needle}.md`;
  const tid = missingId(guess);
  addNode({
    id: tid,
    type: "missing",
    label: basename(guess),
    path: guess,
    metadata: { wiki: true, rawTarget: ref.rawTarget },
    provenance: RESOLVER_PROV(),
    cacheable: false,
  });
  addEdge(
    makeEdge("broken-ref", sourceId, tid, [ref.range], {
      rawTarget: ref.rawTarget,
      wiki: true,
    }),
  );
  diagnostics.push({
    severity: "warning",
    message: `Broken wiki link: [[${ref.rawTarget}]]`,
    range: ref.range,
    code: "broken-wiki-link",
  });
}

/** Skill name → SKILL.md locations, from parsed skill nodes. */
export function buildSkillIndex(nodes: Iterable<ContextNode>): Map<string, SkillIndexEntry[]> {
  const index = new Map<string, SkillIndexEntry[]>();
  for (const node of nodes) {
    if (node.type !== "skill" || !node.path) continue;
    const name = typeof node.metadata.name === "string" ? node.metadata.name : node.label;
    const claudeRoot = typeof node.metadata.claudeRoot === "string" ? node.metadata.claudeRoot : "";
    const entries = index.get(name) ?? [];
    entries.push({ path: node.path, claudeRoot });
    index.set(name, entries);
  }
  return index;
}

/**
 * Resolve an agent's `skills:` entry by skill name: prefer the agent's own
 * .claude root, then the workspace root, then a unique match anywhere.
 * Ambiguity yields a diagnostic and no edge (never guess).
 */
function resolveUsesSkill(
  ref: RawReference,
  input: ResolveInput,
  addNode: (n: ContextNode) => void,
  addEdge: (e: ContextEdge) => void,
  diagnostics: ParserDiagnostic[],
  sourceId: string,
): void {
  const name = ref.rawTarget;
  const candidates = input.skillIndex?.get(name) ?? [];
  const agentRoot = classifyClaudePath(input.sourcePath)?.claudeRoot ?? "";

  let chosen: SkillIndexEntry | undefined;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (candidates.length > 1) {
    const sameRoot = candidates.filter((c) => c.claudeRoot === agentRoot);
    const atWorkspaceRoot = candidates.filter((c) => c.claudeRoot === "");
    if (sameRoot.length === 1) chosen = sameRoot[0];
    else if (atWorkspaceRoot.length === 1) chosen = atWorkspaceRoot[0];
    else {
      diagnostics.push({
        severity: "warning",
        message: `Ambiguous skill "${name}": ${candidates.map((c) => c.path).join(", ")}`,
        range: ref.range,
        code: "ambiguous-skill",
      });
      return;
    }
  }

  if (!chosen) {
    const expected =
      agentRoot === ""
        ? `.claude/skills/${name}/SKILL.md`
        : `${agentRoot}/.claude/skills/${name}/SKILL.md`;
    const tid = missingId(expected);
    addNode({
      id: tid,
      type: "missing",
      label: name,
      path: expected,
      metadata: { reason: "missing-skill", rawTarget: name },
      provenance: RESOLVER_PROV(),
      cacheable: false,
    });
    addEdge(makeEdge("broken-ref", sourceId, tid, [ref.range], { rawTarget: name }));
    diagnostics.push({
      severity: "error",
      message: `Agent references missing skill "${name}"`,
      range: ref.range,
      code: "missing-skill",
    });
    return;
  }

  addEdge(makeEdge("uses-skill", sourceId, fileId(chosen.path), [ref.range], { skill: name }));
}

function makeEdge(
  type: ContextEdge["type"],
  source: string,
  target: string,
  occurrences: SourceRange[],
  metadata: Record<string, unknown> = {},
): ContextEdge {
  return {
    id: edgeId(type, source, target),
    type,
    source,
    target,
    occurrences,
    metadata,
    provenance: RESOLVER_PROV(),
    cacheable: true,
  };
}

function looksLikeDir(path: string, files: Set<string>): boolean {
  const prefix = path === "" ? "" : `${path}/`;
  for (const f of files) {
    if (prefix === "" ? true : f.startsWith(prefix)) {
      if (prefix === "" || f.length > prefix.length) return true;
    }
  }
  return false;
}

function ensureDirContains(
  filePath: string,
  addNode: (n: ContextNode) => void,
  addEdge: (e: ContextEdge) => void,
): void {
  const fileNodeId = fileId(filePath);
  let dir = dirname(filePath);
  let childId = fileNodeId;
  const seen = new Set<string>();

  while (!seen.has(dir)) {
    seen.add(dir);
    const dId = dirId(dir);
    addNode({
      id: dId,
      type: "directory",
      label: dir === "" ? "." : basename(dir) || dir,
      path: dir,
      metadata: {},
      provenance: RESOLVER_PROV(),
      cacheable: true,
    });
    addEdge(makeEdge("contains", dId, childId, [], { structural: true }));
    if (dir === "") break;
    childId = dId;
    dir = dirname(dir);
  }
}

/** Build basename index from a set of paths. */
export function buildBasenameIndex(paths: Iterable<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of paths) {
    const base = basename(p).toLowerCase();
    const noExt = base.replace(/\.mdc?$/i, "");
    for (const key of new Set([base, noExt])) {
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
  }
  return map;
}

/** Collect heading slugs from store nodes' metadata. */
export function headingSlugsFromStore(store: GraphStore): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of store.allNodes()) {
    if (n.path && Array.isArray(n.metadata.headingSlugs)) {
      map.set(n.path, n.metadata.headingSlugs as string[]);
    }
  }
  return map;
}
