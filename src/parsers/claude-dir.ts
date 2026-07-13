import { dirId, fileId, normalizePath } from "../shared/ids";
import { basename } from "../shared/paths";
import type {
  ContextEdge,
  ContextNode,
  FileSnapshot,
  ParseResult,
  ParserDiagnostic,
  Provenance,
  RawReference,
  ScopeRule,
  SourceRange,
} from "../shared/types";
import { MarkdownParser } from "./markdown";
import type { ContextParser, ParseContext } from "./types";

export const CLAUDE_DIR_PARSER_ID = "claude-dir";
export const CLAUDE_DIR_PARSER_VERSION = 1;

const PROV = (): Provenance => ({
  parserId: CLAUDE_DIR_PARSER_ID,
  parserVersion: CLAUDE_DIR_PARSER_VERSION,
  origin: "explicit",
  confidence: 1,
});

export type ClaudeArtifactKind = "agent" | "skill" | "command" | "rule" | "config";

export interface ClaudeClassification {
  kind: ClaudeArtifactKind;
  /** Directory containing the `.claude` dir; "" at workspace root. */
  claudeRoot: string;
  /** Skill directory name for kind "skill". */
  skillDir?: string;
}

/** Classify a path under its nearest `.claude/` directory, or null. */
export function classifyClaudePath(path: string): ClaudeClassification | null {
  const segments = normalizePath(path).split("/");
  const idx = segments.lastIndexOf(".claude");
  if (idx < 0) return null;
  const claudeRoot = segments.slice(0, idx).join("/");
  const rest = segments.slice(idx + 1);
  if (rest.length === 0) return null;

  if (rest.length === 1 && (rest[0] === "settings.json" || rest[0] === "settings.local.json")) {
    return { kind: "config", claudeRoot };
  }
  const isMd = rest[rest.length - 1]!.toLowerCase().endsWith(".md");
  if (rest[0] === "agents" && rest.length >= 2 && isMd) return { kind: "agent", claudeRoot };
  if (rest[0] === "commands" && rest.length >= 2 && isMd) return { kind: "command", claudeRoot };
  if (rest[0] === "rules" && rest.length >= 2 && isMd) return { kind: "rule", claudeRoot };
  if (rest[0] === "skills" && rest.length === 3 && rest[2] === "SKILL.md") {
    return { kind: "skill", claudeRoot, skillDir: rest[1] };
  }
  return null;
}

/**
 * Parses `.claude/` directory artifacts: agents, skills, commands, rules, and
 * settings.json. `.claude/CLAUDE.md` stays with InstructionFileParser and
 * non-SKILL.md markdown inside skill dirs falls through to MarkdownParser.
 */
export class ClaudeDirectoryParser implements ContextParser {
  readonly id = CLAUDE_DIR_PARSER_ID;
  readonly version = CLAUDE_DIR_PARSER_VERSION;
  readonly patterns: string[] = []; // claims-only parser

  private readonly markdown = new MarkdownParser();

  enabled(settings: ParseContext["settings"]): boolean {
    return settings.agents.enabled && settings.agents.formats.includes("claude");
  }

  claims(path: string): boolean {
    return classifyClaudePath(path) !== null;
  }

  parse(file: FileSnapshot, ctx: ParseContext): ParseResult {
    const classification = classifyClaudePath(file.path);
    if (!classification) {
      return { nodes: [], references: [], edges: [], diagnostics: [], scopeRules: [] };
    }
    if (classification.kind === "config") {
      return this.parseSettings(file, classification);
    }
    return this.parseMarkdownArtifact(file, ctx, classification);
  }

  private parseMarkdownArtifact(
    file: FileSnapshot,
    ctx: ParseContext,
    classification: ClaudeClassification,
  ): ParseResult {
    const { kind, claudeRoot } = classification;
    const base = this.markdown.parse(file, ctx);
    const diagnostics: ParserDiagnostic[] = [...base.diagnostics];
    const references: RawReference[] = [...base.references];
    const edges: ContextEdge[] = [...base.edges];
    const scopeRules: ScopeRule[] = [];
    const text = new TextDecoder().decode(file.contents);

    const docNode = base.nodes.find((n) => n.type === "document" && n.path === file.path);
    const frontmatter = (docNode?.metadata.frontmatter ?? {}) as Record<string, unknown>;
    const fmName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
    const fileStem = basename(file.path).replace(/\.md$/i, "");

    let label = fmName ?? fileStem;
    if (kind === "agent" && !fmName) {
      diagnostics.push({
        severity: "warning",
        message: "Agent frontmatter is missing `name`; using the filename as identity",
        range: keyRange(text, file.path, "name") ?? lineOneRange(file.path),
        code: "agent-missing-name",
      });
    }
    if (kind === "skill") {
      const dirName = classification.skillDir!;
      if (fmName && fmName !== dirName) {
        diagnostics.push({
          severity: "warning",
          message: `Skill name "${fmName}" does not match its directory "${dirName}" — the directory name wins`,
          range: keyRange(text, file.path, "name") ?? lineOneRange(file.path),
          code: "skill-name-mismatch",
        });
      }
      label = dirName;
    }

    const nodeType = kind === "rule" ? "instruction" : kind;
    const metadata: Record<string, unknown> = {
      ...docNode?.metadata,
      format: kind === "rule" ? "claude-rules" : "claude-dir",
      claudeKind: kind,
      claudeRoot,
      name: label,
    };
    for (const key of ["description", "tools", "model", "memory", "when_to_use"]) {
      if (frontmatter[key] !== undefined) metadata[key] = frontmatter[key];
    }

    const nodes: ContextNode[] = base.nodes.map((n) => {
      if (n === docNode) {
        return {
          ...n,
          type: nodeType,
          label,
          scope: claudeRoot,
          metadata,
          provenance: PROV(),
        };
      }
      return { ...n, provenance: PROV() };
    });

    // Agent `skills:` entries are skill names, not paths — the resolver
    // matches them against the skill index (rel: "uses-skill").
    if (kind === "agent") {
      const skillsRange = keyRange(text, file.path, "skills") ?? lineOneRange(file.path);
      for (const skillName of stringList(frontmatter.skills)) {
        references.push({
          kind: "frontmatter-ref",
          rel: "uses-skill",
          rawTarget: skillName,
          range: skillsRange,
        });
      }
      edges.push({
        id: `defines-agent|${dirId(agentsDir(claudeRoot))}|${fileId(file.path)}`,
        type: "defines-agent",
        source: dirId(agentsDir(claudeRoot)),
        target: fileId(file.path),
        occurrences: [lineOneRange(file.path)],
        metadata: {},
        provenance: PROV(),
        cacheable: true,
      });
    }

    if (kind === "skill" || kind === "rule" || kind === "command") {
      const globs = stringList(frontmatter.paths);
      const format = kind === "rule" ? "claude-rules" : "claude-skills";
      const mechanism =
        kind === "command"
          ? ("manual" as const)
          : globs.length > 0
            ? ("glob" as const)
            : kind === "rule"
              ? ("always" as const)
              : ("model-decision" as const);
      scopeRules.push({
        sourcePath: file.path,
        format,
        mechanism,
        globs: globs.length > 0 && kind !== "command" ? globs : undefined,
        metadata: { kind, name: label, claudeRoot },
      });
    }

    return { nodes, references, edges, diagnostics, scopeRules };
  }

  /** settings.json → a `config` node exposing key names only, never values. */
  private parseSettings(file: FileSnapshot, classification: ClaudeClassification): ParseResult {
    const diagnostics: ParserDiagnostic[] = [];
    const metadata: Record<string, unknown> = {
      format: "claude-dir",
      claudeKind: "config",
      claudeRoot: classification.claudeRoot,
    };

    try {
      const parsed = JSON.parse(new TextDecoder().decode(file.contents)) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata.topLevelKeys = Object.keys(parsed);
        const permissions = parsed.permissions as Record<string, unknown> | undefined;
        if (permissions && typeof permissions === "object") {
          metadata.permissionRuleCounts = Object.fromEntries(
            Object.entries(permissions).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]),
          );
        }
        const hooks = parsed.hooks as Record<string, unknown> | undefined;
        if (hooks && typeof hooks === "object") {
          metadata.hookEvents = Object.keys(hooks);
        }
        const env = parsed.env as Record<string, unknown> | undefined;
        if (env && typeof env === "object") {
          metadata.envVarNames = Object.keys(env);
        }
      }
    } catch (err) {
      diagnostics.push({
        severity: "warning",
        message: `Malformed JSON in ${basename(file.path)}: ${err instanceof Error ? err.message : String(err)}`,
        range: lineOneRange(file.path),
        code: "malformed-settings-json",
      });
    }

    return {
      nodes: [
        {
          id: fileId(file.path),
          type: "config",
          label: basename(file.path),
          path: file.path,
          scope: classification.claudeRoot,
          metadata,
          provenance: PROV(),
          cacheable: true,
        },
      ],
      references: [],
      edges: [],
      diagnostics,
      scopeRules: [],
    };
  }
}

function agentsDir(claudeRoot: string): string {
  return claudeRoot === "" ? ".claude/agents" : `${claudeRoot}/.claude/agents`;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Range of a top-level `key:` line inside the frontmatter block, if present. */
function keyRange(text: string, path: string, key: string): SourceRange | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = text.split("\n");
  const re = new RegExp(`^${key}\\s*:`);
  let offset = 0;
  const fmEndLine = fm[0].split("\n").length;
  for (let i = 0; i < Math.min(lines.length, fmEndLine); i++) {
    const line = lines[i]!;
    if (re.test(line)) {
      return {
        path,
        start: { line: i + 1, column: 1, offset },
        end: { line: i + 1, column: line.length + 1, offset: offset + line.length },
      };
    }
    offset += line.length + 1;
  }
  return null;
}

function lineOneRange(path: string): SourceRange {
  return {
    path,
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
}
