import picomatch from "picomatch";
import type { ResolvedSettings } from "../settings/schema";
import type { FileSnapshot, ParseResult } from "../shared/types";
import { InstructionFileParser, isInstructionFile } from "./instruction";
import { MarkdownParser } from "./markdown";
import type { ContextParser, ParseContext } from "./types";
import { TYPE_PRECEDENCE } from "./types";

export class ParserRegistry {
  private readonly parsers: ContextParser[];

  constructor(parsers?: ContextParser[]) {
    // Registration order: instruction first (more specific), then markdown
    this.parsers = parsers ?? [new InstructionFileParser(), new MarkdownParser()];
  }

  list(): readonly ContextParser[] {
    return this.parsers;
  }

  /** Pick parsers that match path and are enabled. Instruction files use instruction parser only. */
  matching(path: string, settings: ResolvedSettings): ContextParser[] {
    const enabled = this.parsers.filter((p) => p.enabled(settings));
    if (isInstructionFile(path) && settings.agents.enabled) {
      const instr = enabled.filter((p) => p.id === "instruction");
      if (instr.length > 0) return instr;
    }
    return enabled.filter((p) => p.patterns.some((pat) => picomatch.isMatch(path, pat)));
  }

  parse(file: FileSnapshot, ctx: ParseContext): ParseResult {
    const parsers = this.matching(file.path, ctx.settings);
    if (parsers.length === 0) {
      return { nodes: [], references: [], edges: [], diagnostics: [], scopeRules: [] };
    }

    // Normally one parser; if multiple, merge
    let merged: ParseResult = {
      nodes: [],
      references: [],
      edges: [],
      diagnostics: [],
      scopeRules: [],
    };

    for (const parser of parsers) {
      const result = parser.parse(file, ctx);
      merged = mergeParseResults(merged, result);
    }
    return merged;
  }

  /** Version fingerprint for cache keys. */
  versionFingerprint(): string {
    return this.parsers.map((p) => `${p.id}@${p.version}`).join(",");
  }
}

function mergeParseResults(a: ParseResult, b: ParseResult): ParseResult {
  const nodeMap = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) {
    const existing = nodeMap.get(n.id);
    if (!existing) {
      nodeMap.set(n.id, n);
      continue;
    }
    const pa = TYPE_PRECEDENCE[existing.type] ?? 0;
    const pb = TYPE_PRECEDENCE[n.type] ?? 0;
    const winner = pb > pa ? n : existing;
    const loser = pb > pa ? existing : n;
    nodeMap.set(n.id, {
      ...winner,
      metadata: { ...loser.metadata, ...winner.metadata },
    });
  }

  const edgeMap = new Map(a.edges.map((e) => [e.id, e]));
  for (const e of b.edges) {
    const existing = edgeMap.get(e.id);
    if (!existing) {
      edgeMap.set(e.id, e);
    } else {
      edgeMap.set(e.id, {
        ...existing,
        occurrences: [...existing.occurrences, ...e.occurrences],
      });
    }
  }

  return {
    nodes: [...nodeMap.values()],
    references: [...a.references, ...b.references],
    edges: [...edgeMap.values()],
    diagnostics: [...a.diagnostics, ...b.diagnostics],
    scopeRules: [...a.scopeRules, ...b.scopeRules],
  };
}
