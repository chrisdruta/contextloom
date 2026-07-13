import type { IndexCache } from "../cache/cache";
import { discoverFiles } from "../discovery/discover";
import type { ParserRegistry } from "../parsers/registry";
import type { ResolvedSettings } from "../settings/schema";
import type {
  ContextEdge,
  ContextNode,
  FileSnapshot,
  GraphPatch,
  ParseResult,
  ParserDiagnostic,
  RawReference,
} from "../shared/types";
import { buildBasenameIndex, resolveReferences } from "./resolver";
import { GraphStore } from "./store";

export interface BuildProgress {
  phase: "discover" | "parse" | "resolve" | "done";
  current: number;
  total: number;
  message?: string;
}

export interface BuildResult {
  store: GraphStore;
  diagnostics: ParserDiagnostic[];
  /** path → raw refs for incremental re-resolution */
  refIndex: Map<string, RawReference[]>;
  /** path → parse result meta (heading slugs etc.) */
  parseMeta: Map<string, { headingSlugs: string[]; parserId: string; parserVersion: number }>;
  skipped: { path: string; reason: string }[];
  truncated: boolean;
  fileCount: number;
}

export interface BuilderOptions {
  workspaceRoot: string;
  graphRoot: string;
  settings: ResolvedSettings;
  registry: ParserRegistry;
  cache?: IndexCache;
  isCancelled?: () => boolean;
  onProgress?: (p: BuildProgress) => void;
  vscodeExcludes?: string[];
  /** Reuse existing store or create new */
  store?: GraphStore;
}

/**
 * Full graph build: discover → parse (cache) → resolve → store.
 */
export function buildGraph(opts: BuilderOptions): BuildResult {
  const store = opts.store ?? new GraphStore();
  store.clear();
  store.setRoot(opts.graphRoot);

  opts.onProgress?.({ phase: "discover", current: 0, total: 0, message: "Discovering files…" });

  const discovery = discoverFiles({
    workspaceRoot: opts.workspaceRoot,
    graphRoot: opts.graphRoot,
    settings: opts.settings,
    isCancelled: opts.isCancelled,
    vscodeExcludes: opts.vscodeExcludes,
  });

  if (opts.isCancelled?.()) {
    return emptyResult(store, discovery.skipped, discovery.truncated);
  }

  const files = discovery.files;
  const allPaths = new Set(files.map((f) => f.path));
  const diagnostics: ParserDiagnostic[] = [];
  const refIndex = new Map<string, RawReference[]>();
  const parseMeta = new Map<
    string,
    { headingSlugs: string[]; parserId: string; parserVersion: number }
  >();
  const parseResults = new Map<string, ParseResult>();

  opts.onProgress?.({
    phase: "parse",
    current: 0,
    total: files.length,
    message: "Parsing…",
  });

  for (let i = 0; i < files.length; i++) {
    if (opts.isCancelled?.()) break;
    const file = files[i]!;
    const result = parseFile(file, opts);
    parseResults.set(file.path, result);
    refIndex.set(file.path, result.references);
    diagnostics.push(...result.diagnostics);

    const headingSlugs = (result.nodes[0]?.metadata.headingSlugs as string[] | undefined) ?? [];
    const parser = opts.registry.matching(file.path, opts.settings)[0];
    parseMeta.set(file.path, {
      headingSlugs,
      parserId: parser?.id ?? "markdown",
      parserVersion: parser?.version ?? 1,
    });

    if (i % 25 === 0) {
      opts.onProgress?.({
        phase: "parse",
        current: i + 1,
        total: files.length,
      });
    }
  }

  opts.onProgress?.({
    phase: "resolve",
    current: 0,
    total: files.length,
    message: "Resolving links…",
  });

  const basenameIndex = buildBasenameIndex(allPaths);
  const headingSlugsByPath = new Map<string, string[]>();
  for (const [p, meta] of parseMeta) {
    headingSlugsByPath.set(p, meta.headingSlugs);
  }

  const allNodes: ContextNode[] = [];
  const allEdges: ContextEdge[] = [];
  const nodeMap = new Map<string, ContextNode>();
  const edgeMap = new Map<string, ContextEdge>();

  for (const file of files) {
    if (opts.isCancelled?.()) break;
    const pr = parseResults.get(file.path)!;
    for (const n of pr.nodes) nodeMap.set(n.id, n);
    for (const e of pr.edges) mergeEdge(edgeMap, e);

    const resolved = resolveReferences({
      sourcePath: file.path,
      references: pr.references,
      sourceHeadingSlugs: parseMeta.get(file.path)?.headingSlugs,
      headingSlugsByPath,
      existingFiles: allPaths,
      settings: opts.settings,
      workspaceRoot: opts.workspaceRoot,
      basenameIndex: mapToArrays(basenameIndex),
    });

    for (const n of resolved.nodes) {
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    }
    for (const e of resolved.edges) mergeEdge(edgeMap, e);
    diagnostics.push(...resolved.diagnostics);
  }

  for (const n of nodeMap.values()) allNodes.push(n);
  for (const e of edgeMap.values()) allEdges.push(e);

  store.replaceAll(allNodes, allEdges);

  opts.cache?.persist();
  opts.onProgress?.({
    phase: "done",
    current: files.length,
    total: files.length,
    message: "Ready",
  });

  return {
    store,
    diagnostics,
    refIndex,
    parseMeta,
    skipped: discovery.skipped,
    truncated: discovery.truncated,
    fileCount: files.length,
  };
}

/**
 * Incremental update for changed/created/deleted paths.
 */
export function applyFileChanges(
  store: GraphStore,
  changes: { created: FileSnapshot[]; changed: FileSnapshot[]; deleted: string[] },
  opts: {
    workspaceRoot: string;
    settings: ResolvedSettings;
    registry: ParserRegistry;
    cache?: IndexCache;
    refIndex: Map<string, RawReference[]>;
    parseMeta: Map<string, { headingSlugs: string[]; parserId: string; parserVersion: number }>;
  },
): { patch: GraphPatch; diagnostics: ParserDiagnostic[] } {
  const diagnostics: ParserDiagnostic[] = [];
  const removeNodeIds: string[] = [];
  const removeEdgeIds: string[] = [];
  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];

  // Deletes
  for (const path of changes.deleted) {
    const id = `file:${path}`;
    // Remove outgoing edges from this file
    for (const e of store.outgoing(id)) {
      removeEdgeIds.push(e.id);
    }
    removeNodeIds.push(id);
    opts.refIndex.delete(path);
    opts.parseMeta.delete(path);
    opts.cache?.delete(path);
  }

  // Rebuild path set after deletes conceptually
  const existingFiles = new Set(store.allFilePaths());
  for (const p of changes.deleted) existingFiles.delete(p);
  for (const f of [...changes.created, ...changes.changed]) existingFiles.add(f.path);

  const touched = [...changes.created, ...changes.changed];

  // Re-parse touched files
  for (const file of touched) {
    const pr = parseFile(file, {
      workspaceRoot: opts.workspaceRoot,
      settings: opts.settings,
      registry: opts.registry,
      cache: opts.cache,
    });
    opts.refIndex.set(file.path, pr.references);
    const headingSlugs = (pr.nodes[0]?.metadata.headingSlugs as string[] | undefined) ?? [];
    const parser = opts.registry.matching(file.path, opts.settings)[0];
    opts.parseMeta.set(file.path, {
      headingSlugs,
      parserId: parser?.id ?? "markdown",
      parserVersion: parser?.version ?? 1,
    });
    for (const n of pr.nodes) nodes.push(n);
    for (const e of pr.edges) edges.push(e);
    diagnostics.push(...pr.diagnostics);

    // Drop old out-edges from this file (will re-add)
    const fid = `file:${file.path}`;
    for (const e of store.outgoing(fid)) {
      if (e.type !== "contains") removeEdgeIds.push(e.id);
    }
  }

  // Re-resolve: touched files + any refs that target touched/deleted paths
  const reResolvePaths = new Set(touched.map((f) => f.path));
  for (const [path, refs] of opts.refIndex) {
    for (const ref of refs) {
      // crude: if raw target mentions a changed basename, re-resolve
      for (const f of touched) {
        const base = f.path.split("/").pop()!;
        if (ref.rawTarget.includes(base.replace(/\.md$/i, ""))) {
          reResolvePaths.add(path);
        }
      }
      for (const d of changes.deleted) {
        const base = d.split("/").pop()!;
        if (ref.rawTarget.includes(base.replace(/\.md$/i, ""))) {
          reResolvePaths.add(path);
        }
      }
    }
  }

  const basenameIndex = buildBasenameIndex(existingFiles);
  const headingSlugsByPath = new Map<string, string[]>();
  for (const [p, meta] of opts.parseMeta) {
    headingSlugsByPath.set(p, meta.headingSlugs);
  }

  for (const path of reResolvePaths) {
    const refs = opts.refIndex.get(path);
    if (!refs) continue;

    // Remove prior non-contains out edges
    const fid = `file:${path}`;
    for (const e of store.outgoing(fid)) {
      if (e.type !== "contains") removeEdgeIds.push(e.id);
    }

    const resolved = resolveReferences({
      sourcePath: path,
      references: refs,
      sourceHeadingSlugs: opts.parseMeta.get(path)?.headingSlugs,
      headingSlugsByPath,
      existingFiles,
      settings: opts.settings,
      workspaceRoot: opts.workspaceRoot,
      basenameIndex: mapToArrays(basenameIndex),
    });
    nodes.push(...resolved.nodes);
    edges.push(...resolved.edges);
    diagnostics.push(...resolved.diagnostics);
  }

  const patch = store.applyNodesAndEdges(nodes, edges, removeNodeIds, [...new Set(removeEdgeIds)]);
  opts.cache?.persist();
  return { patch, diagnostics };
}

function parseFile(
  file: FileSnapshot,
  opts: {
    workspaceRoot: string;
    settings: ResolvedSettings;
    registry: ParserRegistry;
    cache?: IndexCache;
  },
): ParseResult {
  const parsers = opts.registry.matching(file.path, opts.settings);
  const primary = parsers[0];
  if (primary && opts.cache) {
    const hit = opts.cache.get(file.path, file.hash, primary.id, primary.version);
    if (hit) return hit;
  }

  const result = opts.registry.parse(file, {
    workspaceRoot: opts.workspaceRoot,
    settings: opts.settings,
    log: () => {},
  });

  if (primary && opts.cache) {
    opts.cache.set(file.path, {
      contentHash: file.hash,
      parserId: primary.id,
      parserVersion: primary.version,
      parseResult: result,
    });
  }
  return result;
}

function mergeEdge(map: Map<string, ContextEdge>, e: ContextEdge): void {
  const existing = map.get(e.id);
  if (!existing) {
    map.set(e.id, { ...e, occurrences: [...e.occurrences] });
  } else {
    existing.occurrences.push(...e.occurrences);
  }
}

function mapToArrays(m: Map<string, string[]>): Map<string, string[]> {
  return m;
}

function emptyResult(
  store: GraphStore,
  skipped: { path: string; reason: string }[],
  truncated: boolean,
): BuildResult {
  return {
    store,
    diagnostics: [],
    refIndex: new Map(),
    parseMeta: new Map(),
    skipped,
    truncated,
    fileCount: 0,
  };
}
