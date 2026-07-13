import Graph from "graphology";
import { edgeId } from "../shared/ids";
import type {
  ContextEdge,
  ContextNode,
  GraphPatch,
  GraphSnapshot,
  NodeType,
} from "../shared/types";
import { GRAPH_SCHEMA_VERSION } from "../shared/types";

type NodeAttrs = ContextNode;
type EdgeAttrs = {
  edgeType: ContextEdge["type"];
  edgeId: string;
  occurrences: ContextEdge["occurrences"];
  metadata: Record<string, unknown>;
  provenance: ContextEdge["provenance"];
  cacheable: boolean;
};

/**
 * Graphology-backed store with reverse index and patch computation.
 */
export class GraphStore {
  private graph = new Graph<NodeAttrs, EdgeAttrs>({
    multi: false,
    type: "directed",
    allowSelfLoops: true,
  });
  /** path → node id for file-backed nodes */
  private pathIndex = new Map<string, string>();
  /** basename (lower) → set of file paths (for wiki resolution) */
  private basenameIndex = new Map<string, Set<string>>();
  /** target node id → edge ids pointing to it */
  private reverseEdges = new Map<string, Set<string>>();
  private _root = "";

  get root(): string {
    return this._root;
  }

  setRoot(root: string): void {
    this._root = root;
  }

  clear(): void {
    this.graph.clear();
    this.pathIndex.clear();
    this.basenameIndex.clear();
    this.reverseEdges.clear();
  }

  nodeCount(): number {
    return this.graph.order;
  }

  edgeCount(): number {
    return this.graph.size;
  }

  hasNode(id: string): boolean {
    return this.graph.hasNode(id);
  }

  getNode(id: string): ContextNode | undefined {
    if (!this.graph.hasNode(id)) return undefined;
    return this.graph.getNodeAttributes(id);
  }

  getEdge(id: string): ContextEdge | undefined {
    // edge id stored as attribute; find by iterating (small graphs) or index
    for (const { edge, attributes } of this.graph.edgeEntries()) {
      if (attributes.edgeId === id) {
        const [source, target] = [this.graph.source(edge), this.graph.target(edge)];
        return toContextEdge(id, source, target, attributes);
      }
    }
    return undefined;
  }

  getEdgeByEndpoints(type: string, source: string, target: string): ContextEdge | undefined {
    const id = edgeId(type, source, target);
    return this.getEdge(id);
  }

  allNodes(): ContextNode[] {
    return this.graph.mapNodes((_n, attrs) => attrs);
  }

  allEdges(): ContextEdge[] {
    const out: ContextEdge[] = [];
    for (const { edge, attributes } of this.graph.edgeEntries()) {
      out.push(
        toContextEdge(
          attributes.edgeId,
          this.graph.source(edge),
          this.graph.target(edge),
          attributes,
        ),
      );
    }
    return out;
  }

  /** Incoming edges to a node. */
  incoming(nodeId: string): ContextEdge[] {
    const ids = this.reverseEdges.get(nodeId);
    if (!ids) return [];
    const out: ContextEdge[] = [];
    for (const eid of ids) {
      const e = this.getEdge(eid);
      if (e) out.push(e);
    }
    return out;
  }

  /** Outgoing edges from a node. */
  outgoing(nodeId: string): ContextEdge[] {
    if (!this.graph.hasNode(nodeId)) return [];
    const out: ContextEdge[] = [];
    this.graph.forEachOutEdge(nodeId, (edge, attributes, _s, target) => {
      out.push(toContextEdge(attributes.edgeId, nodeId, target, attributes));
    });
    return out;
  }

  pathToId(path: string): string | undefined {
    return this.pathIndex.get(path);
  }

  /** All file paths currently indexed. */
  allFilePaths(): string[] {
    return [...this.pathIndex.keys()];
  }

  /** Basename index lookup (lowercase basename without extension variants). */
  pathsByBasename(base: string): string[] {
    const set = this.basenameIndex.get(base.toLowerCase());
    return set ? [...set] : [];
  }

  upsertNode(node: ContextNode): "added" | "updated" {
    if (this.graph.hasNode(node.id)) {
      this.graph.replaceNodeAttributes(node.id, node);
      this.indexNode(node);
      return "updated";
    }
    this.graph.addNode(node.id, node);
    this.indexNode(node);
    return "added";
  }

  upsertEdge(edge: ContextEdge): "added" | "updated" {
    // Ensure endpoints exist
    if (!this.graph.hasNode(edge.source)) {
      this.upsertNode(placeholderNode(edge.source));
    }
    if (!this.graph.hasNode(edge.target)) {
      this.upsertNode(placeholderNode(edge.target));
    }

    const key = edge.id;
    // graphology key: use edge id as undirected key via find
    const existingKey = this.findGraphEdgeKey(edge.source, edge.target, edge.type);
    if (existingKey) {
      const prev = this.graph.getEdgeAttributes(existingKey);
      const mergedOcc = mergeOccurrences(prev.occurrences, edge.occurrences);
      this.graph.replaceEdgeAttributes(existingKey, {
        edgeType: edge.type,
        edgeId: key,
        occurrences: mergedOcc,
        metadata: { ...prev.metadata, ...edge.metadata },
        provenance: edge.provenance,
        cacheable: edge.cacheable,
      });
      return "updated";
    }

    this.graph.addEdgeWithKey(key, edge.source, edge.target, {
      edgeType: edge.type,
      edgeId: key,
      occurrences: edge.occurrences,
      metadata: edge.metadata,
      provenance: edge.provenance,
      cacheable: edge.cacheable,
    });
    this.addReverse(edge.target, key);
    return "added";
  }

  removeNode(id: string): boolean {
    if (!this.graph.hasNode(id)) return false;
    const node = this.graph.getNodeAttributes(id);
    // Remove reverse index for edges touching this node
    this.graph.forEachEdge(id, (edge, attrs) => {
      this.removeReverse(this.graph.target(edge), attrs.edgeId);
      this.removeReverse(this.graph.source(edge), attrs.edgeId);
    });
    this.graph.dropNode(id);
    this.unindexNode(node);
    return true;
  }

  removeEdge(id: string): boolean {
    if (!this.graph.hasEdge(id)) {
      // try find by edgeId attr
      const key = this.findEdgeKeyById(id);
      if (!key) return false;
      const target = this.graph.target(key);
      this.graph.dropEdge(key);
      this.removeReverse(target, id);
      return true;
    }
    const target = this.graph.target(id);
    this.graph.dropEdge(id);
    this.removeReverse(target, id);
    return true;
  }

  /**
   * Remove all nodes/edges associated with a file path (file node + its out edges,
   * and clean broken-ref targets that become unused).
   */
  removeFile(path: string): GraphPatch {
    const patch = emptyPatch();
    const id = this.pathIndex.get(path) ?? `file:${path}`;
    if (!this.graph.hasNode(id)) return patch;

    // Collect out-edges
    const outEdges: string[] = [];
    this.graph.forEachOutEdge(id, (edge, attrs) => {
      outEdges.push(attrs.edgeId);
    });
    for (const eid of outEdges) {
      this.removeEdge(eid);
      patch.removedEdgeIds.push(eid);
    }

    // In-edges stay — they'll be re-resolved to missing
    this.removeNode(id);
    patch.removedNodeIds.push(id);
    return patch;
  }

  snapshot(root?: string): GraphSnapshot {
    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      root: root ?? this._root,
      nodes: this.allNodes(),
      edges: this.allEdges(),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Replace entire store contents; returns full snapshot patch. */
  replaceAll(nodes: ContextNode[], edges: ContextEdge[]): GraphPatch {
    const prevNodeIds = new Set(this.graph.nodes());
    const prevEdgeIds = new Set<string>();
    this.graph.forEachEdge((_e, attrs) => {
      prevEdgeIds.add(attrs.edgeId);
    });

    this.clear();
    const patch = emptyPatch();

    for (const n of nodes) {
      this.upsertNode(n);
      if (prevNodeIds.has(n.id)) patch.updatedNodes.push(n);
      else patch.addedNodes.push(n);
    }
    for (const e of edges) {
      this.upsertEdge(e);
      if (prevEdgeIds.has(e.id)) patch.updatedEdges.push(e);
      else patch.addedEdges.push(e);
    }

    for (const id of prevNodeIds) {
      if (!this.graph.hasNode(id)) patch.removedNodeIds.push(id);
    }
    for (const id of prevEdgeIds) {
      if (!this.findEdgeKeyById(id)) patch.removedEdgeIds.push(id);
    }

    return patch;
  }

  applyNodesAndEdges(
    nodes: ContextNode[],
    edges: ContextEdge[],
    removeNodeIds: string[] = [],
    removeEdgeIds: string[] = [],
  ): GraphPatch {
    const patch = emptyPatch();

    for (const id of removeEdgeIds) {
      if (this.removeEdge(id)) patch.removedEdgeIds.push(id);
    }
    for (const id of removeNodeIds) {
      if (this.removeNode(id)) patch.removedNodeIds.push(id);
    }

    for (const n of nodes) {
      const op = this.upsertNode(n);
      if (op === "added") patch.addedNodes.push(n);
      else patch.updatedNodes.push(n);
    }
    for (const e of edges) {
      const op = this.upsertEdge(e);
      if (op === "added") patch.addedEdges.push(e);
      else patch.updatedEdges.push(e);
    }

    return patch;
  }

  private indexNode(node: ContextNode): void {
    if (
      node.path &&
      (node.type === "document" ||
        node.type === "instruction" ||
        node.type === "source-file" ||
        node.type === "agent" ||
        node.type === "skill" ||
        node.type === "command")
    ) {
      this.pathIndex.set(node.path, node.id);
      const base = node.path.split("/").pop()!.toLowerCase();
      const noExt = base.replace(/\.mdc?$/i, "");
      for (const key of new Set([base, noExt])) {
        let set = this.basenameIndex.get(key);
        if (!set) {
          set = new Set();
          this.basenameIndex.set(key, set);
        }
        set.add(node.path);
      }
    }
  }

  private unindexNode(node: ContextNode): void {
    if (!node.path) return;
    this.pathIndex.delete(node.path);
    const base = node.path.split("/").pop()!.toLowerCase();
    const noExt = base.replace(/\.mdc?$/i, "");
    for (const key of [base, noExt]) {
      const set = this.basenameIndex.get(key);
      if (set) {
        set.delete(node.path);
        if (set.size === 0) this.basenameIndex.delete(key);
      }
    }
  }

  private addReverse(target: string, edgeIdStr: string): void {
    let set = this.reverseEdges.get(target);
    if (!set) {
      set = new Set();
      this.reverseEdges.set(target, set);
    }
    set.add(edgeIdStr);
  }

  private removeReverse(target: string, edgeIdStr: string): void {
    const set = this.reverseEdges.get(target);
    if (set) {
      set.delete(edgeIdStr);
      if (set.size === 0) this.reverseEdges.delete(target);
    }
  }

  private findGraphEdgeKey(source: string, target: string, type: string): string | null {
    const want = edgeId(type, source, target);
    if (this.graph.hasEdge(want)) return want;
    return null;
  }

  private findEdgeKeyById(id: string): string | null {
    if (this.graph.hasEdge(id)) return id;
    for (const { edge, attributes } of this.graph.edgeEntries()) {
      if (attributes.edgeId === id) return edge;
    }
    return null;
  }
}

function toContextEdge(id: string, source: string, target: string, attrs: EdgeAttrs): ContextEdge {
  return {
    id,
    type: attrs.edgeType,
    source,
    target,
    occurrences: attrs.occurrences,
    metadata: attrs.metadata,
    provenance: attrs.provenance,
    cacheable: attrs.cacheable,
  };
}

function emptyPatch(): GraphPatch {
  return {
    addedNodes: [],
    updatedNodes: [],
    removedNodeIds: [],
    addedEdges: [],
    updatedEdges: [],
    removedEdgeIds: [],
  };
}

function mergeOccurrences(
  a: ContextEdge["occurrences"],
  b: ContextEdge["occurrences"],
): ContextEdge["occurrences"] {
  const key = (r: ContextEdge["occurrences"][0]) => `${r.path}:${r.start.offset}:${r.end.offset}`;
  const map = new Map(a.map((r) => [key(r), r]));
  for (const r of b) map.set(key(r), r);
  return [...map.values()];
}

function placeholderNode(id: string): ContextNode {
  let type: NodeType = "missing";
  let label = id;
  let path: string | undefined;
  if (id.startsWith("file:")) {
    type = "source-file";
    path = id.slice(5);
    label = path.split("/").pop() ?? path;
  } else if (id.startsWith("dir:")) {
    type = "directory";
    path = id.slice(4);
    label = path.split("/").pop() || path || ".";
  } else if (id.startsWith("url:")) {
    type = "external";
    label = id.slice(4);
  } else if (id.startsWith("missing:")) {
    type = "missing";
    path = id.slice(8);
    label = path.split("/").pop() ?? path;
  }
  return {
    id,
    type,
    label,
    path,
    metadata: { placeholder: true },
    provenance: {
      parserId: "store",
      parserVersion: 1,
      origin: "explicit",
      confidence: 1,
    },
    cacheable: false,
  };
}
