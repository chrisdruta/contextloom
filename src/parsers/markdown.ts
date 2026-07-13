import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { parse as parseYaml } from "yaml";
import { fileId } from "../shared/ids";
import { basename, dirname } from "../shared/paths";
import { makeSlugger } from "../shared/slugger";
import type {
  ContextNode,
  FileSnapshot,
  ParseResult,
  ParserDiagnostic,
  Provenance,
  RawReference,
  SourceRange,
} from "../shared/types";
import { extractAtImports } from "./at-imports";
import type { ContextParser, ParseContext } from "./types";
import { extractWikiLinks } from "./wiki-link";

export const MARKDOWN_PARSER_ID = "markdown";
export const MARKDOWN_PARSER_VERSION = 2;

const PROV = (confidence = 1): Provenance => ({
  parserId: MARKDOWN_PARSER_ID,
  parserVersion: MARKDOWN_PARSER_VERSION,
  origin: "explicit",
  confidence,
});

export class MarkdownParser implements ContextParser {
  readonly id = MARKDOWN_PARSER_ID;
  readonly version = MARKDOWN_PARSER_VERSION;
  readonly patterns = ["**/*.md", "**/*.mdc"];

  enabled(): boolean {
    return true;
  }

  parse(file: FileSnapshot, ctx: ParseContext): ParseResult {
    const text = decodeUtf8(file.contents);
    const diagnostics: ParserDiagnostic[] = [];
    const references: RawReference[] = [];
    const nodes: ContextNode[] = [];

    // Frontmatter
    let title: string | undefined;
    let tags: string[] | undefined;
    let description: string | undefined;
    let frontmatterMeta: Record<string, unknown> = {};
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fmMatch) {
      try {
        const parsed = parseYaml(fmMatch[1]!, { maxAliasCount: 100 });
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          frontmatterMeta = parsed as Record<string, unknown>;
          if (typeof frontmatterMeta.title === "string") title = frontmatterMeta.title;
          if (typeof frontmatterMeta.description === "string") {
            description = frontmatterMeta.description;
          }
          if (Array.isArray(frontmatterMeta.tags)) {
            tags = frontmatterMeta.tags.filter((t): t is string => typeof t === "string");
          } else if (typeof frontmatterMeta.tags === "string") {
            tags = [frontmatterMeta.tags];
          }
        }
      } catch (err) {
        diagnostics.push({
          severity: "warning",
          message: `Malformed YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
          range: rangeAt(file.path, text, 0, Math.min(fmMatch[0].length, text.length)),
          code: "malformed-frontmatter",
        });
      }
    }

    // mdast parse
    let tree: ReturnType<typeof fromMarkdown>;
    try {
      tree = fromMarkdown(text, {
        extensions: [gfm(), frontmatter(["yaml", "toml"])],
        mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml", "toml"])],
      });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        message: `Markdown parse failed: ${err instanceof Error ? err.message : String(err)}`,
        range: rangeAt(file.path, text, 0, Math.min(1, text.length)),
        code: "parse-failed",
      });
      // Still create a node
      nodes.push(makeDocNode(file.path, title, tags, description, frontmatterMeta, text));
      return { nodes, references, edges: [], diagnostics, scopeRules: [] };
    }

    // Headings → slugs + first H1 as title fallback
    const slugger = makeSlugger();
    const headingSlugs: string[] = [];
    let firstH1: string | undefined;

    // Reference definitions map
    const defMap = new Map<string, { url: string; pos?: { start: number; end: number } }>();

    walk(tree, (node) => {
      if (node.type === "heading" && node.position) {
        const textContent = extractText(node);
        const slug = slugger.slug(textContent);
        headingSlugs.push(slug);
        if (node.depth === 1 && !firstH1) firstH1 = textContent;
      }

      if (node.type === "definition" && node.identifier) {
        defMap.set(node.identifier.toLowerCase(), {
          url: node.url ?? "",
          pos: node.position
            ? { start: node.position.start.offset ?? 0, end: node.position.end.offset ?? 0 }
            : undefined,
        });
      }

      if ((node.type === "link" || node.type === "image") && node.url != null) {
        const url = node.url;
        if (!url || url.startsWith("data:")) return;
        const pos = node.position;
        if (!pos) return;
        const range = mdastRange(file.path, pos);
        const kind = node.type === "image" ? "image" : "md-link";
        const linkText = node.type === "link" ? extractText(node) : undefined;
        references.push({
          kind,
          rawTarget: url,
          range,
          text: linkText,
        });
      }

      if (node.type === "linkReference" && node.identifier) {
        const def = defMap.get(node.identifier.toLowerCase());
        if (def?.url) {
          const pos = node.position;
          if (!pos) return;
          references.push({
            kind: "md-link",
            rawTarget: def.url,
            range: mdastRange(file.path, pos),
            text: extractText(node),
          });
        }
      }
    });

    // Wiki links
    if (ctx.settings.wikiLinks.enabled) {
      for (const w of extractWikiLinks(text)) {
        references.push({
          kind: "wiki-link",
          rawTarget: w.rawTarget,
          range: {
            path: file.path,
            start: { line: w.startLine, column: w.startColumn, offset: w.startOffset },
            end: { line: w.endLine, column: w.endColumn, offset: w.endOffset },
          },
          text: w.alias,
        });
      }
    }

    const label = title ?? firstH1 ?? basename(file.path);
    const subtype = classifyDocument(file.path);

    // @import candidates are metadata only: Claude Code expands imports
    // recursively through any imported file, so the import analysis needs
    // them for every document — but plain docs must not grow @mention edges.
    const atImports = extractAtImports(text, file.path);

    nodes.push({
      id: fileId(file.path),
      type: "document",
      label,
      path: file.path,
      metadata: {
        title,
        tags,
        description,
        frontmatter: frontmatterMeta,
        headingSlugs,
        subtype,
        entryPoint: isEntryPoint(file.path, subtype),
        externalLinkCount: 0, // filled by resolver later via patch if needed
        atImports: atImports.length > 0 ? atImports : undefined,
      },
      provenance: PROV(),
      cacheable: true,
    });

    // Cap pathological reference counts
    if (references.length > 10_000) {
      diagnostics.push({
        severity: "warning",
        message: "Reference cap (10,000) exceeded; excess references dropped",
        range: rangeAt(file.path, text, 0, 1),
        code: "ref-cap",
      });
      references.length = 10_000;
    }

    return { nodes, references, edges: [], diagnostics, scopeRules: [] };
  }
}

function makeDocNode(
  path: string,
  title: string | undefined,
  tags: string[] | undefined,
  description: string | undefined,
  frontmatterMeta: Record<string, unknown>,
  text: string,
): ContextNode {
  return {
    id: fileId(path),
    type: "document",
    label: title ?? basename(path),
    path,
    metadata: {
      title,
      tags,
      description,
      frontmatter: frontmatterMeta,
      headingSlugs: [] as string[],
      subtype: classifyDocument(path),
      entryPoint: isEntryPoint(path, classifyDocument(path)),
      parseError: true,
      size: text.length,
    },
    provenance: PROV(),
    cacheable: true,
  };
}

function classifyDocument(path: string): string {
  const base = basename(path).toLowerCase();
  if (base === "readme.md") return "readme";
  if (base === "changelog.md" || base === "history.md") return "changelog";
  if (/^\d{4}-.+\.md$/.test(base) && /\/(adr|decisions)\//i.test(path)) return "adr";
  if (base === "index.md") return "index";
  return "document";
}

function isEntryPoint(path: string, subtype: string): boolean {
  // Root README and index.md are entry points (orphan exemptions)
  const dir = dirname(path);
  if (dir !== "") return false;
  return subtype === "readme" || subtype === "index";
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractText(node: { children?: unknown[]; value?: string }): string {
  if (typeof node.value === "string") return node.value;
  if (!node.children) return "";
  return (node.children as { children?: unknown[]; value?: string; type?: string }[])
    .map((c) => extractText(c))
    .join("");
}

function walk(node: any, visit: (n: any) => void): void {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

function mdastRange(
  path: string,
  pos: {
    start: { line: number; column: number; offset?: number | undefined };
    end: { line: number; column: number; offset?: number | undefined };
  },
): SourceRange {
  return {
    path,
    start: {
      line: pos.start.line,
      column: pos.start.column,
      offset: pos.start.offset ?? 0,
    },
    end: {
      line: pos.end.line,
      column: pos.end.column,
      offset: pos.end.offset ?? 0,
    },
  };
}

function rangeAt(path: string, text: string, start: number, end: number): SourceRange {
  return {
    path,
    start: offsetToPos(text, start),
    end: offsetToPos(text, end),
  };
}

function offsetToPos(
  text: string,
  offset: number,
): { line: number; column: number; offset: number } {
  let line = 1;
  let col = 1;
  const max = Math.min(offset, text.length);
  for (let i = 0; i < max; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col, offset };
}
