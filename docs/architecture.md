# Architecture

ContextLoom is a VS Code extension with two esbuild entry points:

1. **Extension host** (`src/extension/extension.ts`) — discovery, parse, resolve, store, diagnostics, commands, views
2. **Webview** (`webview-ui/src/main.tsx`) — Preact chrome + `GraphRenderer` seam

## Rendering

`GraphRenderer` (webview-ui/src/renderer.ts) has three implementations:

- **CytoscapeRenderer** (default) — Cytoscape.js + fcose. Layout strategy is
  measured, not naive ([ADR-001](./adr/001-graph-rendering.md)): full fcose up
  to 1,500 visible nodes, concentric beyond; small patches lay out only the
  affected 2-hop neighborhood.
- **CanvasRenderer** — hand-rolled force sim, ~30 KB; selectable via
  `contextloom.graph.renderer: "canvas"`. Repulsion capped at 400 nodes.
- **NullRenderer** — seam proof for tests.

The renderer lives outside Preact's render tree; the host passes the chosen
renderer via a `data-renderer` attribute on the webview root element.

## Layers

```
src/
  extension/      activation, DI, indexer, tree views
  commands/       (commands registered in extension.ts for MVP)
  discovery/      file enumeration + ignore chain
  parsers/        registry, MarkdownParser, InstructionFileParser
  graph/          Graphology store, link resolver, builder
  analysis/       orphans, broken links
  cache/          content-hash cache
  diagnostics/    Problems-panel publisher (single writer)
  webview/        panel lifecycle + protocol host side
  settings/       zod-validated config
  export/         deterministic JSON
  shared/         types, ids, paths, protocol schemas
webview-ui/       Preact app + GraphRenderer
```

## Indexing flow

```
discover → parse (cache hit?) → resolve RawReferences → GraphStore → analysis → diagnostics → webview snapshot
```

**Two-phase design:** parsers emit unresolved `RawReference`s; `LinkResolver` turns them into edges / `missing:` nodes / ambiguity diagnostics. Incremental updates re-parse changed files and re-resolve affected references without re-parsing the whole corpus.

## Protocol

Envelope: `{ v: 1, id, type, payload }` with zod validation on both sides —
the webview imports the same schemas from `src/shared/protocol.ts` (no
hand-mirrored types).

Key messages: `graph/snapshot`, `graph/patch`, `graph/status`, `selection/details`, `node/open`, `view/search`, `view/filters`, `export/request`.

The Loom View panel registers a `WebviewPanelSerializer`; the webview persists
`{ root, filters }` via `webview.setState`, so the panel revives with its
graph after a window reload.

## Security

- Strict webview CSP (nonce scripts only)
- Markdown never rendered as HTML
- Path resolution confined to workspace (escapes → `missing:` / outside-workspace)
- No telemetry
