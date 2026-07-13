import { fileId } from "../shared/ids";
import { basename, dirname } from "../shared/paths";
import type {
  ContextNode,
  FileSnapshot,
  ParseResult,
  Provenance,
  RawReference,
  SourceRange,
} from "../shared/types";
import { MarkdownParser } from "./markdown";
import type { ContextParser, ParseContext } from "./types";

export const INSTRUCTION_PARSER_ID = "instruction";
export const INSTRUCTION_PARSER_VERSION = 1;

const PROV = (): Provenance => ({
  parserId: INSTRUCTION_PARSER_ID,
  parserVersion: INSTRUCTION_PARSER_VERSION,
  origin: "explicit",
  confidence: 1,
});

/** Instruction filenames that this parser claims. */
const INSTRUCTION_NAMES = new Set(["agents.md", "claude.md", "claude.local.md"]);

export function isInstructionFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (INSTRUCTION_NAMES.has(base)) return true;
  // .claude/CLAUDE.md
  if (base === "claude.md" && dirname(path).endsWith(".claude")) return true;
  return false;
}

export function instructionFormat(path: string): "agents-md" | "claude-md" | null {
  const base = basename(path).toLowerCase();
  if (base === "agents.md") return "agents-md";
  if (base === "claude.md" || base === "claude.local.md") return "claude-md";
  return null;
}

/**
 * InstructionFileParser claims AGENTS.md / CLAUDE.md and reuses MarkdownParser
 * for body parsing, then reclassifies the node as `instruction`.
 */
export class InstructionFileParser implements ContextParser {
  readonly id = INSTRUCTION_PARSER_ID;
  readonly version = INSTRUCTION_PARSER_VERSION;
  readonly patterns = [
    "**/AGENTS.md",
    "**/CLAUDE.md",
    "**/CLAUDE.local.md",
    "**/.claude/CLAUDE.md",
  ];

  private readonly markdown = new MarkdownParser();

  enabled(settings: ParseContext["settings"]): boolean {
    return settings.agents.enabled;
  }

  claims(path: string): boolean {
    return isInstructionFile(path);
  }

  parse(file: FileSnapshot, ctx: ParseContext): ParseResult {
    if (!isInstructionFile(file.path)) {
      return { nodes: [], references: [], edges: [], diagnostics: [], scopeRules: [] };
    }

    const base = this.markdown.parse(file, ctx);
    const format = instructionFormat(file.path) ?? "agents-md";
    const text = new TextDecoder().decode(file.contents);

    // Reclassify document node → instruction
    const nodes: ContextNode[] = base.nodes.map((n) => {
      if (n.type === "document" && n.path === file.path) {
        return {
          ...n,
          type: "instruction" as const,
          label: basename(file.path),
          scope: dirname(file.path),
          metadata: {
            ...n.metadata,
            format,
            subtype: format,
          },
          provenance: PROV(),
        };
      }
      return { ...n, provenance: PROV() };
    });

    // Extract @import references from CLAUDE.md (not inside code)
    const references: RawReference[] = [...base.references];
    if (format === "claude-md") {
      for (const imp of extractAtImports(text, file.path)) {
        references.push(imp);
      }
    }

    const scopeRules =
      format === "agents-md" || format === "claude-md"
        ? [
            {
              sourcePath: file.path,
              format,
              mechanism: "ancestry" as const,
            },
          ]
        : [];

    return {
      nodes,
      references,
      edges: base.edges,
      diagnostics: base.diagnostics,
      scopeRules,
    };
  }
}

/** Extract @path imports (Claude Code style), max depth handled by resolver later. */
function extractAtImports(source: string, path: string): RawReference[] {
  const refs: RawReference[] = [];
  const lines = source.split("\n");
  let offset = 0;
  let inFence = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      offset += line.length + 1;
      continue;
    }

    // Skip lines that are only inline code-ish; match @path not in `code`
    const re = /@([^\s`]+)/g;
    let m: RegExpExecArray | null;
    // Simple: skip if line has odd number of backticks before match — use mask
    const codeSpans = maskBackticks(line);

    for (;;) {
      m = re.exec(line);
      if (m === null) break;
      if (codeSpans[m.index]) continue;
      const target = m[1]!;
      // Skip email-like and bare @mentions without path chars
      if (!target.includes("/") && !target.includes(".") && !target.endsWith(".md")) {
        // Still allow @AGENTS.md style
        if (!/\.(md|mdc|txt|json)$/i.test(target)) continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      refs.push({
        kind: "import",
        rawTarget: target,
        range: {
          path,
          start: { line: lineIdx + 1, column: start + 1, offset: offset + start },
          end: { line: lineIdx + 1, column: end + 1, offset: offset + end },
        },
      });
    }
    offset += line.length + 1;
  }
  return refs;
}

function maskBackticks(line: string): boolean[] {
  const mask = new Array(line.length).fill(false);
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "`") {
      inCode = !inCode;
      mask[i] = true;
    } else if (inCode) {
      mask[i] = true;
    }
  }
  return mask;
}
