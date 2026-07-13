/** Minimal protocol types for the webview (mirrors host schemas). */

export interface Envelope {
  v: number;
  id: string;
  type: string;
  payload: unknown;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  path?: string;
  metadata: Record<string, unknown>;
  provenance: {
    parserId: string;
    parserVersion: number;
    origin: "explicit" | "inferred";
    confidence: number;
  };
  cacheable: boolean;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  occurrences: {
    path: string;
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
  }[];
  metadata: Record<string, unknown>;
  provenance: GraphNode["provenance"];
  cacheable: boolean;
}

export interface FilterState {
  hiddenNodeTypes: string[];
  hiddenEdgeTypes: string[];
  showInferred: boolean;
  showExternal: boolean;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(msg: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
  }
}

export function getVsCodeApi() {
  if (typeof window.acquireVsCodeApi === "function") {
    return window.acquireVsCodeApi();
  }
  // Dev fallback
  return {
    postMessage: (msg: unknown) => console.log("postMessage", msg),
    getState: () => null,
    setState: (_s: unknown) => {},
  };
}

export function makeEnvelope(type: string, payload: unknown, id?: string): Envelope {
  return {
    v: 1,
    id: id ?? Math.random().toString(36).slice(2),
    type,
    payload,
  };
}
