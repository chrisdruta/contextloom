import type { z } from "zod";
import type { ScopeMatchGroup } from "../scope/types";
import type { ContextDetailsPayload } from "../shared/protocol";

type WireGroups = z.infer<typeof ContextDetailsPayload>["groups"];

/**
 * Map scope-engine groups to the wire shape, enriching each match with the
 * source node's label so the webview renders without a second round trip.
 */
export function toWireGroups(
  groups: ScopeMatchGroup[],
  getLabel: (nodeId: string) => string | undefined,
): WireGroups {
  return groups.map((group) => ({
    format: group.format,
    note: group.note,
    matches: group.matches.map((match) => ({
      source: match.source,
      sourcePath: match.sourcePath,
      sourceLabel: getLabel(match.source),
      format: match.format,
      mechanism: match.mechanism,
      status: match.status,
      rank: match.rank,
      reason: match.reason,
      confidence: match.confidence,
      via: match.via,
    })),
  }));
}
