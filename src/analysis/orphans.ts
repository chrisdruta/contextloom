import type { GraphStore } from "../graph/store";
import type { ContextEdge, ContextNode } from "../shared/types";

export interface LooseThread {
  kind: "orphan" | "broken-link" | "ambiguous-wiki";
  nodeId?: string;
  edgeId?: string;
  path?: string;
  message: string;
  range?: ContextEdge["occurrences"][0];
}

export function findOrphans(store: GraphStore): ContextNode[] {
  const orphans: ContextNode[] = [];
  for (const node of store.allNodes()) {
    if (node.type !== "document" && node.type !== "instruction") continue;
    if (node.metadata.entryPoint === true) continue;

    const incoming = store
      .incoming(node.id)
      .filter((e) => e.type === "link" || e.type === "wiki-link" || e.type === "references");
    // contains from directory doesn't count as a "link"
    if (incoming.length === 0) {
      orphans.push(node);
    }
  }
  return orphans;
}

export function findBrokenLinks(store: GraphStore): ContextEdge[] {
  return store.allEdges().filter((e) => e.type === "broken-ref");
}

export function collectLooseThreads(
  store: GraphStore,
  ambiguousDiagnostics: { message: string; range?: ContextEdge["occurrences"][0] }[] = [],
): LooseThread[] {
  const threads: LooseThread[] = [];

  for (const n of findOrphans(store)) {
    threads.push({
      kind: "orphan",
      nodeId: n.id,
      path: n.path,
      message: `Orphaned document: ${n.path ?? n.label}`,
    });
  }

  for (const e of findBrokenLinks(store)) {
    const occ = e.occurrences[0];
    threads.push({
      kind: "broken-link",
      nodeId: e.target,
      edgeId: e.id,
      path: occ?.path,
      message: `Broken link: ${String(e.metadata.rawTarget ?? e.target)}`,
      range: occ,
    });
  }

  for (const d of ambiguousDiagnostics) {
    threads.push({
      kind: "ambiguous-wiki",
      path: d.range?.path,
      message: d.message,
      range: d.range,
    });
  }

  return threads;
}
