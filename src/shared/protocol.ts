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
  v: z.number().int(),
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(128),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

// Host → webview payloads
export const GraphSnapshotPayload = z.object({
  root: z.string(),
  /** Workspace-folder URI (multi-root revival); persisted by the webview. */
  folder: z.string().max(4096).optional(),
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

export const ViewFocusPayload = z.object({
  nodeId: z.string().min(1).max(4096),
});

// Webview → host
export const NodeOpenPayload = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().max(10_000_000).optional(),
  column: z.number().int().positive().max(10_000_000).optional(),
});

export const NodeRevealPayload = z.object({
  path: z.string().min(1).max(4096),
});

export const ViewSearchPayload = z.object({
  query: z.string().max(1000),
});

export const NodeDetailsPayload = z
  .object({
    nodeId: z.string().min(1).max(4096).optional(),
    edgeId: z.string().min(1).max(4096).optional(),
  })
  .refine((value) => Boolean(value.nodeId) !== Boolean(value.edgeId));

export const ViewFiltersPayload = z.object({
  hiddenNodeTypes: z.array(z.string().max(128)).max(100),
  hiddenEdgeTypes: z.array(z.string().max(128)).max(100),
  showInferred: z.boolean(),
  showExternal: z.boolean(),
});

// Agent context (v0.2) — additive, protocol version unchanged: both sides
// ignore unknown message types, and no existing payload schema changes.

/** Wire form of a ScopeMatch, enriched with sourceLabel for direct rendering. */
export const ScopeMatchWire = z.object({
  source: z.string().min(1).max(4096),
  sourcePath: z.string().max(4096),
  sourceLabel: z.string().max(512).optional(),
  // string, not enum: v0.3 adds copilot/windsurf without a protocol change
  format: z.string().max(64),
  mechanism: z.enum(["ancestry", "glob", "always", "model-decision", "manual"]),
  status: z.enum(["active", "shadowed", "conditional"]),
  rank: z.number(),
  reason: z.string().max(1024),
  confidence: z.number(),
  via: z.object({ importedFrom: z.string().max(4096), depth: z.number() }).optional(),
});

export const ScopeMatchGroupWire = z.object({
  format: z.string().max(64),
  matches: z.array(ScopeMatchWire).max(500),
  note: z.string().max(1024).optional(),
});

/** webview → host: request agent context for a node or a bare path. */
export const ContextRequestPayload = z
  .object({
    nodeId: z.string().min(1).max(4096).optional(),
    filePath: z.string().min(1).max(4096).optional(),
  })
  .refine((value) => Boolean(value.nodeId) !== Boolean(value.filePath));

/** host → webview: resolved context for a subject file. */
export const ContextDetailsPayload = z.object({
  subject: z.object({
    filePath: z.string().max(4096),
    nodeId: z.string().max(4096).optional(),
  }),
  groups: z.array(ScopeMatchGroupWire).max(20),
  /** true ⇒ webview switches the Inspector to the Agent Context tab. */
  reveal: z.boolean().optional(),
});

/** host → webview: reverse lookup for an instruction-family selection. */
export const ContextAppliesToPayload = z.object({
  sourceNodeId: z.string().min(1).max(4096),
  subjectNodeIds: z.array(z.string().max(4096)).max(2000),
  truncated: z.boolean().optional(),
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
