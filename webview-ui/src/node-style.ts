/**
 * Node/edge visual vocabulary shared by both renderers and the filter chips.
 * Types are distinguished by shape as well as color (a11y — never color alone).
 */

export const NODE_COLORS: Record<string, string> = {
  instruction: "#c586c0",
  document: "#4fc1ff",
  agent: "#ce9178",
  skill: "#4ec9b0",
  command: "#d7ba7d",
  config: "#75beff",
  missing: "#f14c4c",
  external: "#89d185",
  "source-file": "#dcdcaa",
  directory: "#8a8a8a",
};

export function nodeColor(type: string): string {
  return NODE_COLORS[type] ?? "#cccccc";
}

export function nodeShape(type: string): string {
  switch (type) {
    case "instruction":
      return "diamond";
    case "agent":
      return "pentagon";
    case "skill":
      return "tag";
    case "command":
      return "vee";
    case "config":
      return "octagon";
    case "directory":
      return "round-rectangle";
    case "missing":
      return "hexagon";
    default:
      return "ellipse";
  }
}

/** Edges whose direction is semantic get bezier curves + arrowheads. */
export const SEMANTIC_EDGE_TYPES = new Set([
  "uses-skill",
  "defines-agent",
  "overrides",
  "inherits-from",
  "applies-to",
]);

export function edgeColor(type: string): string {
  switch (type) {
    case "broken-ref":
      return "#f14c4c";
    case "wiki-link":
      return "#dcdcaa";
    case "references":
      return "#89d185";
    case "uses-skill":
      return "#4ec9b0";
    case "defines-agent":
      return "#ce9178";
    case "overrides":
      return "#f14c4c";
    case "inherits-from":
      return "#c586c0";
    case "applies-to": // defensive — applies-to is query-time, not stored
      return "#3794ff";
    default:
      return "#888888";
  }
}

export function edgeLineStyle(type: string, origin: string): "solid" | "dashed" | "dotted" {
  if (type === "broken-ref" || type === "overrides" || type === "applies-to") return "dashed";
  if (origin === "inferred") return "dashed";
  if (type === "wiki-link") return "dotted";
  return "solid";
}
