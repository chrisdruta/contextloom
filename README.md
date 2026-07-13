# ContextLoom — Docs & Agent Context Graph

> **See how your repository's context is woven together.**

ContextLoom is a VS Code extension that turns a repository's documentation and AI-agent configuration into a navigable, typed knowledge graph.

Point it at a repo (or a subdirectory like `/docs`) and it renders Markdown documents, `AGENTS.md` / `CLAUDE.md` instruction files as nodes, with their links and relationships as edges — search, filters, broken-link diagnostics, and an inspector that explains every relationship.

## Features (v0.1 MVP)

- **Open Graph** for the workspace or any folder
- Markdown discovery honoring `.gitignore`, VS Code excludes, and ContextLoom globs
- Full link parsing: inline, reference-style, images, fragments, frontmatter, wiki links `[[…]]`
- Two-phase link resolution that **never guesses** (ambiguous wiki links → diagnostic, not edge)
- Interactive Loom View — **Cytoscape.js + fcose layout** (with a lightweight canvas fallback via `contextloom.graph.renderer`): pan, zoom, select, hover neighborhood, search (`/`), type filters
- Loom View survives window reloads (panel state is restored)
- **Thread Inspector** with provenance (parser, origin, confidence, source ranges)
- **Loose Threads** view: orphans + broken links
- Problems-panel diagnostics for broken / ambiguous links
- Incremental refresh on file changes (debounced watcher)
- `AGENTS.md` / `CLAUDE.md` / `CLAUDE.local.md` recognized as typed **instruction** nodes
- Graph Outline (accessibility path — full keyboard / screen-reader tree)
- Deterministic JSON export

## Quick start

```bash
bun install
bun run build
```

Press **F5** in VS Code/Cursor with this folder open to launch the Extension Development Host, then run:

**Command Palette → `ContextLoom: Open Graph`**

Or right-click a folder in the Explorer → **ContextLoom: Open Graph for Folder**.

## Commands

| Command | Description |
|---|---|
| `ContextLoom: Open Graph` | Open Loom View for workspace root (or saved root) |
| `ContextLoom: Open Graph for Folder` | Open graph scoped to a folder |
| `ContextLoom: Focus on Current File` | Center the graph on the active Markdown file |
| `ContextLoom: Find Loose Threads` | Focus the orphans & broken-links view |
| `ContextLoom: Refresh Graph` | Full reindex |
| `ContextLoom: Export Graph (JSON)` | Deterministic JSON export |

## Supported formats (MVP)

| Format | Support |
|---|---|
| Markdown (`.md`, `.mdc`) | Full links, wiki links, frontmatter, headings |
| `AGENTS.md` | Typed instruction node + body links |
| `CLAUDE.md` / `CLAUDE.local.md` | Typed instruction node + `@import` references |

**v0.2 (planned):** scope resolution ("which instructions apply to this file?"), `.claude/` agents/skills/commands/rules, Cursor rules.

## Settings

See VS Code Settings under **ContextLoom**. Key options:

- `contextloom.roots` — saved graph roots
- `contextloom.include` / `contextloom.exclude` — discovery globs
- `contextloom.respectGitignore` — honor `.gitignore` (default `true`)
- `contextloom.wikiLinks.enabled` / `resolution` — wiki-link parsing
- `contextloom.diagnostics.enabled` — Problems panel
- `contextloom.agents.enabled` — instruction-file recognition
- `contextloom.limits.maxFiles` / `maxFileSizeKb` — safety caps

## Privacy

**No telemetry. No network. Local-first.**

All indexing and analysis runs on your machine. ContextLoom never executes repository code and never writes into the repository (export is an explicit user action). See [PRIVACY.md](./PRIVACY.md).

## Accessibility

The canvas graph is not screen-reader navigable. Use the **Graph Outline** view (Activity Bar → ContextLoom) for a fully keyboard-accessible tree of the same data. Webview chrome supports tab order, `/` search, and `Esc` to clear selection.

## Development

```bash
bun install
bun run build            # esbuild dual-entry (extension + webview)
bun run test             # Vitest unit tests (includes §Q perf guards)
bun run test:integration # @vscode/test-cli extension-host tests (needs a display; CI runs xvfb)
bun run bench:renderers  # ADR-001 renderer bake-off numbers
bun run typecheck
bun run lint
```

See [docs/development.md](./docs/development.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture

- **Host:** TypeScript, Graphology store, mdast parser, zod-validated protocol (both sides)
- **Webview:** Preact chrome + **Cytoscape.js/fcose** renderer behind a `GraphRenderer` interface (canvas fallback selectable; see [ADR-001](./docs/adr/001-graph-rendering.md))
- **Parsers:** pure functions (no `vscode` import) — unit-tested in Vitest; extension-host behavior covered by `@vscode/test-cli` integration tests on Linux and Windows CI

Details: [docs/architecture.md](./docs/architecture.md) · [docs/graph-model.md](./docs/graph-model.md)

## Roadmap

| Version | Focus |
|---|---|
| **0.1** | Markdown + instruction-file graph (this release) |
| **0.2** | Agent context scope resolution, `.claude/`, Cursor |
| **0.3** | Weave Health analysis suite |
| **0.4+** | Opt-in LLM features via `vscode.lm` |

Full plan: [PLAN.md](./PLAN.md).

## License

[MIT](./LICENSE)
