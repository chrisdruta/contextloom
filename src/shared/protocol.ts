import { z } from "zod";
import { PROTOCOL_VERSION } from "./types";

const SourceRangeSchema = z.object({
  path: z.string(),
  start: z.object({
    line: z.number(),
    column: z.number(),
    offset: z.number(),
  }),
  end: z.object({
    line: z.number(),
    column: z.number(),
    offset: z.number(),
  }),
});

const ProvenanceSchema = z.object({
  parserId: z.string(),
  parserVersion: z.number(),
  origin: z.enum(["explicit", "inferred"]),
  confidence: z.number(),
});

export const ContextNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  path: z.string().optional(),
  metadata: z.record(z.unknown()),
  provenance: ProvenanceSchema,
  cacheable: z.boolean(),
});

export const ContextEdgeSchema = z.object({
  id: z.string(),
  type: z.string(),
  source: z.string(),
  target: z.string(),
  occurrences: z.array(SourceRangeSchema),
  metadata: z.record(z.unknown()),
  provenance: ProvenanceSchema,
  cacheable: z.boolean(),
});

export const EnvelopeSchema = z.object({
  v: z.number(),
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

// Host → webview payloads
export const GraphSnapshotPayload = z.object({
  root: z.string(),
  nodes: z.array(ContextNodeSchema),
  edges: z.array(ContextEdgeSchema),
  showExternalLinks: z.boolean().optional(),
});

export const GraphPatchPayload = z.object({
  addedNodes: z.array(ContextNodeSchema),
  updatedNodes: z.array(ContextNodeSchema),
  removedNodeIds: z.array(z.string()),
  addedEdges: z.array(ContextEdgeSchema),
  updatedEdges: z.array(ContextEdgeSchema).optional(),
  removedEdgeIds: z.array(z.string()),
});

export const GraphStatusPayload = z.object({
  state: z.enum(["indexing", "ready", "degraded", "error"]),
  nodeCount: z.number().optional(),
  edgeCount: z.number().optional(),
  progress: z.number().optional(),
  message: z.string().optional(),
});

export const SelectionDetailsPayload = z.object({
  kind: z.enum(["node", "edge", "none"]),
  node: ContextNodeSchema.optional(),
  edge: ContextEdgeSchema.optional(),
  incoming: z.array(ContextEdgeSchema).optional(),
  outgoing: z.array(ContextEdgeSchema).optional(),
});

export const SearchResultsPayload = z.object({
  query: z.string(),
  matchIds: z.array(z.string()),
});

// Webview → host
export const NodeOpenPayload = z.object({
  path: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
});

export const NodeRevealPayload = z.object({
  path: z.string(),
});

export const ViewSearchPayload = z.object({
  query: z.string(),
});

export const ViewFiltersPayload = z.object({
  hiddenNodeTypes: z.array(z.string()),
  hiddenEdgeTypes: z.array(z.string()),
  showInferred: z.boolean(),
  showExternal: z.boolean(),
});

export function makeEnvelope(type: string, payload: unknown, id?: string): Envelope {
  return {
    v: PROTOCOL_VERSION,
    id: id ?? cryptoRandomId(),
    type,
    payload,
  };
}

export function parseEnvelope(raw: unknown): Envelope | null {
  const r = EnvelopeSchema.safeParse(raw);
  if (!r.success) return null;
  if (r.data.v !== PROTOCOL_VERSION) return null;
  return r.data;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
