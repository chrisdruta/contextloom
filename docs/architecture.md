# Architecture

ContextLoom is a VS Code extension with two esbuild entry points:

1. **Extension host** (`src/extension/extension.ts`) — discovery, parse, resolve, store, diagnostics, commands, views
2. **Webview** (`webview-ui/src/main.tsx`) — Preact chrome + canvas `GraphRenderer`

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

Envelope: `{ v: 1, id, type, payload }` with zod validation on both sides.

Key messages: `graph/snapshot`, `graph/patch`, `graph/status`, `selection/details`, `node/open`, `view/search`, `view/filters`, `export/request`.

## Security

- Strict webview CSP (nonce scripts only)
- Markdown never rendered as HTML
- Path resolution confined to workspace (escapes → `missing:` / outside-workspace)
- No telemetry
