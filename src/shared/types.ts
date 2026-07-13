/** Shared domain types — pure TS, no vscode imports. */

export type Origin = "explicit" | "inferred";

export interface SourceRange {
  path: string;
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

export interface Provenance {
  parserId: string;
  parserVersion: number;
  origin: Origin;
  confidence: number;
}

export type NodeType =
  | "document"
  | "instruction"
  | "agent"
  | "skill"
  | "command"
  | "directory"
  | "heading"
  | "source-file"
  | "external"
  | "missing";

export type EdgeType =
  | "link"
  | "wiki-link"
  | "contains"
  | "references"
  | "broken-ref"
  | "applies-to"
  | "inherits-from"
  | "overrides"
  | "uses-skill"
  | "defines-agent"
  | "duplicate-of"
  | "related-concept"
  | "semantic-similarity";

export interface ContextNode {
  id: string;
  type: NodeType;
  label: string;
  path?: string;
  range?: SourceRange;
  scope?: string;
  metadata: Record<string, unknown>;
  provenance: Provenance;
  cacheable: boolean;
}

export interface ContextEdge {
  id: string;
  type: EdgeType;
  source: string;
  target: string;
  occurrences: SourceRange[];
  metadata: Record<string, unknown>;
  provenance: Provenance;
  cacheable: boolean;
}

export type RawReferenceKind = "md-link" | "wiki-link" | "image" | "import" | "frontmatter-ref";

export interface RawReference {
  kind: RawReferenceKind;
  rawTarget: string;
  range: SourceRange;
  /** Optional link text / alias for display */
  text?: string;
}

export interface ParserDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  range: SourceRange;
  code?: string;
}

export interface ScopeRule {
  sourcePath: string;
  format: string;
  mechanism: "ancestry" | "glob" | "always" | "model-decision" | "manual";
  globs?: string[];
  metadata?: Record<string, unknown>;
}

export interface FileSnapshot {
  path: string;
  contents: Uint8Array;
  hash: string;
  languageId?: string;
}

export interface ParseResult {
  nodes: ContextNode[];
  references: RawReference[];
  edges: ContextEdge[];
  diagnostics: ParserDiagnostic[];
  scopeRules: ScopeRule[];
}

export interface GraphPatch {
  addedNodes: ContextNode[];
  updatedNodes: ContextNode[];
  removedNodeIds: string[];
  addedEdges: ContextEdge[];
  updatedEdges: ContextEdge[];
  removedEdgeIds: string[];
}

export interface GraphSnapshot {
  schemaVersion: number;
  root: string;
  nodes: ContextNode[];
  edges: ContextEdge[];
  generatedAt: string;
}

export const GRAPH_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;
