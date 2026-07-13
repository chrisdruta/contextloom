import { describe, expect, it } from "vitest";
import { GraphSnapshotPayload, makeEnvelope, parseEnvelope } from "../src/shared/protocol";

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
});
