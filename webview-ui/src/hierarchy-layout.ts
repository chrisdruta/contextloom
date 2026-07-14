import type { GraphNode } from "./protocol";

export interface Point {
  x: number;
  y: number;
}

const X_SPACING = 190;
const Y_SPACING = 95;
const BAND_GAP = 60;

/**
 * Semantic layered layout for the agent-context use case: instruction/config
 * files form the top band, agents/skills/commands the second, then documents
 * cascade down by link depth from the instruction layer and entry points
 * (README/index). Unreached nodes (orphans) form the bottom band. Wide bands
 * wrap into multiple rows; rows sort by path so directory siblings cluster.
 *
 * Pure — testable without cytoscape or a DOM.
 */
export function computeHierarchyPositions(
  nodes: GraphNode[],
  edges: { source: string; target: string }[],
): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const band = new Map<string, number>();
  const seeds: string[] = [];

  for (const n of nodes) {
    if (n.type === "instruction" || n.type === "config") {
      band.set(n.id, 0);
      seeds.push(n.id);
    } else if (n.type === "agent" || n.type === "skill" || n.type === "command") {
      band.set(n.id, 1);
      seeds.push(n.id);
    } else if (n.metadata.entryPoint === true) {
      band.set(n.id, 2);
      seeds.push(n.id);
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }

  // BFS from the seed bands along link direction; documents start at band 2
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const nextBand = Math.max(2, (band.get(id) ?? 2) + 1);
    for (const target of adjacency.get(id) ?? []) {
      if (band.has(target)) continue;
      band.set(target, nextBand);
      queue.push(target);
    }
  }

  // Unreached nodes (orphans) sink to the bottom
  let maxBand = 0;
  for (const b of band.values()) maxBand = Math.max(maxBand, b);
  for (const n of nodes) {
    if (!band.has(n.id)) band.set(n.id, maxBand + 1);
  }

  const byBand = new Map<number, string[]>();
  for (const n of nodes) {
    const b = band.get(n.id)!;
    const list = byBand.get(b) ?? [];
    list.push(n.id);
    byBand.set(b, list);
  }

  const sortKey = (id: string) => byId.get(id)?.path ?? byId.get(id)?.label ?? id;
  const maxPerRow = Math.max(6, Math.ceil(Math.sqrt(nodes.length) * 1.8));

  const positions = new Map<string, Point>();
  let y = 0;
  for (const b of [...byBand.keys()].sort((a, z) => a - z)) {
    const members = byBand.get(b)!.sort((a, z) => sortKey(a).localeCompare(sortKey(z)));
    const rows = Math.ceil(members.length / maxPerRow);
    for (let i = 0; i < members.length; i++) {
      const row = Math.floor(i / maxPerRow);
      const inThisRow = Math.min(maxPerRow, members.length - row * maxPerRow);
      const col = i % maxPerRow;
      positions.set(members[i]!, {
        x: (col - (inThisRow - 1) / 2) * X_SPACING,
        y: y + row * Y_SPACING,
      });
    }
    y += rows * Y_SPACING + BAND_GAP;
  }
  return positions;
}
