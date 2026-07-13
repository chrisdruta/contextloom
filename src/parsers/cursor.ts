import { fileId, normalizePath } from "../shared/ids";
import { basename } from "../shared/paths";
import type {
  ContextNode,
  FileSnapshot,
  ParseResult,
  ParserDiagnostic,
  Provenance,
  ScopeRule,
} from "../shared/types";
import { globList, parseTolerantFrontmatter } from "./frontmatter-tolerant";
import { MarkdownParser } from "./markdown";
import type { ContextParser, ParseContext } from "./types";

export const CURSOR_PARSER_ID = "cursor";
export const CURSOR_PARSER_VERSION = 1;

const PROV = (confidence = 1): Provenance => ({
  parserId: CURSOR_PARSER_ID,
  parserVersion: CURSOR_PARSER_VERSION,
  origin: "explicit",
  confidence,
});

export function isCursorRulePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (basename(normalized) === ".cursorrules") return true;
  return (
    normalized.toLowerCase().endsWith(".mdc") &&
    (normalized.includes("/.cursor/rules/") || normalized.startsWith(".cursor/rules/"))
  );
}

/**
 * Cursor rules adapter: .cursor/rules/**\/*.mdc (4 activation modes from
 * description/globs/alwaysApply) plus legacy .cursorrules recognition.
 * Glob-derived scope carries confidence 0.8 — the dialect is underdocumented.
 */
export class CursorRulesParser implements ContextParser {
  readonly id = CURSOR_PARSER_ID;
  readonly version = CURSOR_PARSER_VERSION;
  readonly patterns: string[] = []; // claims-only parser

  private readonly markdown = new MarkdownParser();

  enabled(settings: ParseContext["settings"]): boolean {
    return settings.agents.enabled && settings.agents.formats.includes("cursor");
  }

  claims(path: string): boolean {
    return isCursorRulePath(path);
  }

  parse(file: FileSnapshot, ctx: ParseContext): ParseResult {
    if (basename(file.path) === ".cursorrules") {
      return this.parseLegacy(file);
    }

    const text = new TextDecoder().decode(file.contents);
    const base = this.markdown.parse(file, ctx);
    const diagnostics: ParserDiagnostic[] = [...base.diagnostics];
    const fm = parseTolerantFrontmatter(text);
    if (fm.fallback) {
      diagnostics.push({
        severity: "info",
        message: "Cursor rule frontmatter is not strict YAML; parsed tolerantly",
        range: lineOneRange(file.path),
        code: "cursor-tolerant-frontmatter",
      });
      // The markdown parser reported the same block as malformed — drop that.
      const idx = diagnostics.findIndex((d) => d.code === "malformed-frontmatter");
      if (idx >= 0) diagnostics.splice(idx, 1);
    }

    const globs = globList(fm.data.globs);
    const alwaysApply = fm.data.alwaysApply === true;
    const description = typeof fm.data.description === "string" ? fm.data.description : undefined;

    // 4 modes per Cursor docs: alwaysApply > globs > description-only > manual
    const mechanism = alwaysApply
      ? ("always" as const)
      : globs.length > 0
        ? ("glob" as const)
        : description
          ? ("model-decision" as const)
          : ("manual" as const);
    const confidence = mechanism === "glob" ? 0.8 : 1;

    const scopeRules: ScopeRule[] = [
      {
        sourcePath: file.path,
        format: "cursor",
        mechanism,
        globs: mechanism === "glob" ? globs : undefined,
        metadata: {
          confidence,
          rawFrontmatter: fm.data,
          tolerantParse: fm.fallback,
        },
      },
    ];

    const nodes: ContextNode[] = base.nodes.map((n) => {
      if (n.type === "document" && n.path === file.path) {
        return {
          ...n,
          type: "instruction" as const,
          label: basename(file.path),
          scope: cursorScope(file.path),
          metadata: {
            ...n.metadata,
            format: "cursor",
            description,
            mechanism,
            globs: globs.length > 0 ? globs : undefined,
            alwaysApply,
          },
          provenance: PROV(confidence),
        };
      }
      return { ...n, provenance: PROV() };
    });

    return { nodes, references: base.references, edges: base.edges, diagnostics, scopeRules };
  }

  /** Legacy .cursorrules: recognition only, always-on. */
  private parseLegacy(file: FileSnapshot): ParseResult {
    return {
      nodes: [
        {
          id: fileId(file.path),
          type: "instruction",
          label: ".cursorrules",
          path: file.path,
          scope: cursorScope(file.path),
          metadata: { format: "cursor", legacy: true, mechanism: "always" },
          provenance: PROV(),
          cacheable: true,
        },
      ],
      references: [],
      edges: [],
      diagnostics: [],
      scopeRules: [
        {
          sourcePath: file.path,
          format: "cursor",
          mechanism: "always",
          metadata: { legacy: true },
        },
      ],
    };
  }
}

/** Owning directory: the dir containing `.cursor`, or the file's dir for legacy. */
function cursorScope(path: string): string {
  const segments = normalizePath(path).split("/");
  const idx = segments.lastIndexOf(".cursor");
  if (idx >= 0) return segments.slice(0, idx).join("/");
  return segments.slice(0, -1).join("/");
}

function lineOneRange(path: string) {
  return {
    path,
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
}
