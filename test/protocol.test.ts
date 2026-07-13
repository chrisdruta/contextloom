import { describe, expect, it } from "vitest";
import {
  ContextAppliesToPayload,
  ContextDetailsPayload,
  ContextRequestPayload,
  GraphSnapshotPayload,
  NodeDetailsPayload,
  NodeOpenPayload,
  ViewSearchPayload,
  makeEnvelope,
  parseEnvelope,
} from "../src/shared/protocol";

describe("protocol", () => {
  it("round-trips envelopes", () => {
    const env = makeEnvelope("graph/status", { state: "ready", nodeCount: 3 });
    const parsed = parseEnvelope(env);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("graph/status");
  });

  it("rejects version mismatch", () => {
    expect(parseEnvelope({ v: 99, id: "x", type: "ready", payload: {} })).toBeNull();
  });

  it("validates snapshot payload", () => {
    const r = GraphSnapshotPayload.safeParse({
      root: "",
      nodes: [
        {
          id: "file:a.md",
          type: "document",
          label: "a",
          metadata: {},
          provenance: {
            parserId: "markdown",
            parserVersion: 1,
            origin: "explicit",
            confidence: 1,
          },
          cacheable: true,
        },
      ],
      edges: [],
    });
    expect(r.success).toBe(true);
  });

  it("bounds and validates webview requests", () => {
    expect(NodeOpenPayload.safeParse({ path: "docs/a.md", line: 1 }).success).toBe(true);
    expect(NodeOpenPayload.safeParse({ path: "", line: -1 }).success).toBe(false);
    expect(ViewSearchPayload.safeParse({ query: "x".repeat(1001) }).success).toBe(false);
    expect(NodeDetailsPayload.safeParse({ nodeId: "file:a.md" }).success).toBe(true);
    expect(NodeDetailsPayload.safeParse({ nodeId: "a", edgeId: "b" }).success).toBe(false);
  });
});

describe("agent context protocol (v0.2)", () => {
  const match = {
    source: "file:AGENTS.md",
    sourcePath: "AGENTS.md",
    sourceLabel: "AGENTS.md",
    format: "agents-md",
    mechanism: "ancestry",
    status: "active",
    rank: 1,
    reason: "nearest AGENTS.md (1 level up)",
    confidence: 1,
  };

  it("context/request accepts exactly one of nodeId / filePath", () => {
    expect(ContextRequestPayload.safeParse({ nodeId: "file:a.md" }).success).toBe(true);
    expect(ContextRequestPayload.safeParse({ filePath: "src/a.ts" }).success).toBe(true);
    expect(
      ContextRequestPayload.safeParse({ nodeId: "file:a.md", filePath: "src/a.ts" }).success,
    ).toBe(false);
    expect(ContextRequestPayload.safeParse({}).success).toBe(false);
  });

  it("context/details round-trips all statuses and via info", () => {
    const payload = {
      subject: { filePath: "packages/api/src/server.ts", nodeId: undefined },
      groups: [
        {
          format: "claude-md",
          note: "All files load, concatenated root→leaf.",
          matches: [
            match,
            { ...match, status: "shadowed", rank: 2 },
            {
              ...match,
              status: "conditional",
              rank: 3,
              via: { importedFrom: "CLAUDE.md", depth: 1 },
            },
          ],
        },
      ],
      reveal: true,
    };
    const r = ContextDetailsPayload.safeParse(payload);
    expect(r.success).toBe(true);
    expect(r.data!.groups[0]!.matches[2]!.via).toEqual({ importedFrom: "CLAUDE.md", depth: 1 });
  });

  it("rejects oversized context payloads", () => {
    expect(
      ContextDetailsPayload.safeParse({
        subject: { filePath: "a.ts" },
        groups: [{ format: "cursor", matches: Array.from({ length: 501 }, () => match) }],
      }).success,
    ).toBe(false);
    expect(
      ContextAppliesToPayload.safeParse({
        sourceNodeId: "file:AGENTS.md",
        subjectNodeIds: Array.from({ length: 2001 }, (_, i) => `file:${i}.md`),
      }).success,
    ).toBe(false);
  });

  it("context/appliesTo round-trips", () => {
    const r = ContextAppliesToPayload.safeParse({
      sourceNodeId: "file:.claude/rules/style.md",
      subjectNodeIds: ["file:a.ts", "file:b.tsx"],
      truncated: true,
    });
    expect(r.success).toBe(true);
  });
});
