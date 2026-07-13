/**
 * Webview side of the protocol. Types and validation come from the shared
 * host schemas (src/shared/protocol.ts) so both sides validate identically —
 * there is deliberately no hand-mirrored copy here.
 */
import type { z } from "zod";
import type {
  ContextDetailsPayload,
  ContextEdgeSchema,
  ContextNodeSchema,
  Envelope,
  ScopeMatchGroupWire,
  ScopeMatchWire,
  SelectionDetailsPayload,
  ViewFiltersPayload,
} from "../../src/shared/protocol";

export {
  ContextAppliesToPayload,
  ContextDetailsPayload,
  GraphPatchPayload,
  GraphSnapshotPayload,
  GraphStatusPayload,
  SearchResultsPayload,
  SelectionDetailsPayload,
  ViewFocusPayload,
  makeEnvelope,
  parseEnvelope,
} from "../../src/shared/protocol";
export type { Envelope } from "../../src/shared/protocol";

export type GraphNode = z.infer<typeof ContextNodeSchema>;
export type GraphEdge = z.infer<typeof ContextEdgeSchema>;
export type FilterState = z.infer<typeof ViewFiltersPayload>;
export type SelectionDetails = z.infer<typeof SelectionDetailsPayload>;
export type ContextDetails = z.infer<typeof ContextDetailsPayload>;
export type ScopeMatch = z.infer<typeof ScopeMatchWire>;
export type ScopeMatchGroup = z.infer<typeof ScopeMatchGroupWire>;

export type InspectorTab = "details" | "context";

/** State the webview persists across VS Code restarts (panel revival). */
export interface WebviewState {
  root?: string;
  filters?: FilterState;
  inspectorTab?: InspectorTab;
}

interface VsCodeApi {
  postMessage(msg: Envelope): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let cached: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (cached) return cached;
  if (typeof window.acquireVsCodeApi === "function") {
    cached = window.acquireVsCodeApi();
    return cached;
  }
  // Dev fallback (running outside VS Code)
  let devState: WebviewState | undefined;
  cached = {
    postMessage: (msg) => console.log("postMessage", msg),
    getState: () => devState,
    setState: (s) => {
      devState = s;
    },
  };
  return cached;
}
