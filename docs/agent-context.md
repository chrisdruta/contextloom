# Agent Context — formats, semantics, and the scope resolver

ContextLoom's differentiating question: **"Which repository instructions apply to file X — and why?"** This document is the normative reference for the v0.2 scope-resolution engine (`src/scope/`). Format semantics were verified against first-party documentation (agents.md spec, Anthropic Claude Code docs, Cursor docs) in July 2026; per-tool caveats are flagged inline.

## Conceptual model

Exactly three orthogonal **activation mechanisms** exist across every supported format:

1. **Ancestry** — the file's directory chain selects instruction files (`AGENTS.md` nearest-wins; `CLAUDE.md` concatenate-all).
2. **Glob** — frontmatter patterns select files (`paths` in Claude rules/skills, `globs` in Cursor).
3. **Mode** — always-on / model-decision / manual. Model-decision and manual entries are *reported as conditional*, never claimed active.

A **format adapter** owns its format's semantics and emits `ScopeMatch` records. The resolver **never merges across formats** — different tools read different files, and pretending otherwise invents certainty. Scope resolution is always **workspace-wide**, even when the graph view root is a subdirectory, and works for any workspace path — un-indexed source files are the canonical subject.

## Per-format semantics

### AGENTS.md (`agents-md`)

Plain Markdown, placeable in any directory. Per the agents.md spec, **the nearest AGENTS.md in the ancestor chain takes precedence** (override, not merge). ContextLoom marks the nearest file `active` and ancestors `shadowed`, with `overrides` edges in the graph.

**Caveat:** some consumers (Cursor, VS Code) *merge* nested files root→leaf instead. Set `contextloom.agents.agentsMdMode: "merge"` to model those tools — all files become `active` in root→leaf rank order.

### CLAUDE.md family (`claude-md`)

`CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` in every ancestor directory are **all loaded, concatenated root→leaf — never overriding**. `CLAUDE.local.md` ranks immediately after its sibling. Ranks in the Agent Context panel are the concatenation order.

`@path` imports are expanded recursively through any imported file, with Claude Code's documented **depth limit of 4** and cycle detection — violations are Problems-panel **errors** (`import-depth`, `import-cycle`), and offending imports are excluded from the resolved context (shown in the graph, never claimed active). Imports inside code fences and inline code spans are ignored. Expansions inherit their importer's rank and carry `via` provenance (importing file + depth).

Only repository-local files are indexed; the user-global `~/.claude` and managed layers are out of scope.

### `.claude/` directory (`claude-rules`, `claude-skills`)

| Artifact | Location | Semantics |
|---|---|---|
| Agents | `.claude/agents/**/*.md` | Identity = frontmatter `name` (not the filename; missing name ⇒ warning). `skills:` entries resolve by skill name — preferring the agent's own `.claude` root, then the workspace root, then a unique match; ambiguity ⇒ diagnostic without an edge; missing ⇒ `missing-skill` **error**. |
| Skills | `.claude/skills/<name>/SKILL.md` | `name` must match the directory (mismatch ⇒ warning; directory wins). `paths:` globs ⇒ active on match; no `paths` ⇒ *conditional (model-decision)*. Supporting files (`scripts/`, `references/`, `assets/`) get `contains` edges. |
| Commands | `.claude/commands/**/*.md` | Skills code path; *conditional (manual invocation)*. A same-name skill in the same `.claude` root shadows the command (flagged, not hidden). |
| Rules | `.claude/rules/**/*.md` | `paths:` globs (YAML list or comma-string) ⇒ active on match; no `paths` ⇒ **always-on**. Rule nodes are `instruction`-typed with `format: claude-rules`. |
| Settings | `.claude/settings.json`, `settings.local.json` | `config` node exposing **key names only** (permission rule counts, hook event names, env var names) — never values. |

Nested `<pkg>/.claude/` directories are scoped to their package: globs match relative to the `.claude` root, and cross-package skill name clashes get qualified labels (`pkgs/web:deploy`).

### Cursor (`cursor`)

`.cursor/rules/**/*.mdc` (extension mandatory) in the file's ancestor chain, plus legacy `.cursorrules` (recognition only, always-on). Four activation modes from frontmatter:

| Frontmatter | Mode | Status |
|---|---|---|
| `alwaysApply: true` | always | active |
| `globs:` (comma-string or list) | glob | active on match, **confidence 0.8** |
| `description:` only | model-decision | conditional |
| none | manual | conditional (`@mention` only) |

**Caveat encoded as tolerant parsing:** Cursor frontmatter is not reliable YAML (`globs: *.ts` is an invalid alias). Strict YAML is tried first; on failure a line-based fallback extracts `description`/`globs`/`alwaysApply` with an info diagnostic, and the raw frontmatter is preserved in metadata. The glob dialect is underdocumented — hence the 0.8 confidence on glob-derived matches.

## Conflict surfacing

Conflicts are **reported, never resolved**. When multiple same-format sources are simultaneously active, the group note states the tool's documented reading order (CLAUDE.md concatenation; AGENTS.md merge mode) or says exactly that no order is documented (Cursor). Semantic contradiction detection is out of deterministic scope.

## Graph representation

- `applies-to` is **query-time only** — computed on selection via `resolveContext`/`filesInScope`, never materialized in the store (a glob rule × N files is a hairball generator; PLAN §G.4).
- Build-time derived edges (provenance `parserId: "scope"`, never cached): `overrides` (AGENTS.md nearest → each shadowed ancestor), `inherits-from` (nested instruction → nearest same-format ancestor), `uses-skill` (agent → skill), `defines-agent` (agents dir → agent), skill `contains`.

## Surfaces

- **Command:** `ContextLoom: Show Applicable Agent Context` (palette, editor context menu, Explorer context menu) — works for any workspace file, whether or not it appears in the graph.
- **Inspector → Agent Context tab:** one table per format (Status / Source / Reason), rank-ordered, with jump-to-source links.
- **On-selection highlighting:** selecting a file dims the graph and outlines its active instruction sources with dashed arrows; selecting an instruction/agent/skill highlights everything it governs.
- **Agents & Skills view:** all agents, skills, commands, and rules with frontmatter descriptions.

## Settings

| Key | Default | Effect |
|---|---|---|
| `contextloom.agents.enabled` | `true` | Master switch for agent-format recognition |
| `contextloom.agents.agentsMdMode` | `"nearest"` | `nearest` (spec) vs `merge` (Cursor/VS Code consumers) — query-time only, never invalidates the cache |
| `contextloom.agents.formats` | `["agents-md", "claude", "cursor"]` | Enabled format adapters |

## Fixture matrix

The PLAN.md §G.3 worked example is a literal fixture (`test/fixtures/scope-monorepo/`) asserted row-by-row in `test/scope-resolve.test.ts`, in both `nearest` and `merge` modes. `@import` depth/cycle cases live in `test/fixtures/claude-imports/`, `.claude/` artifacts in `test/fixtures/claude-dir/`, and Cursor modes in `test/fixtures/cursor-rules/`.
