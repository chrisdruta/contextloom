import type { GraphStore } from "../graph/store";
import type { GraphSnapshot } from "../shared/types";
import { GRAPH_SCHEMA_VERSION } from "../shared/types";

/**
 * Deterministic JSON export: nodes/edges sorted by id for byte-stability.
 */
export function exportGraphJson(store: GraphStore, root: string): string {
  const snapshot: GraphSnapshot = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    root,
    nodes: store.allNodes().sort((a, b) => a.id.localeCompare(b.id)),
    edges: store
      .allEdges()
      .map((e) => ({
        ...e,
        occurrences: [...e.occurrences].sort(
          (a, b) => a.path.localeCompare(b.path) || a.start.offset - b.start.offset,
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    generatedAt: "", // strip for determinism; caller may set
  };

  // Stable stringify with sorted metadata keys
  return `${stableStringify(snapshot)}\n`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k]);
    }
    return out;
  }
  return value;
}
