# Contributing to ContextLoom

## Setup

```bash
bun install
bun run build
bun run test
```

Press **F5** to launch the Extension Development Host.

## Principles

1. **Fixture-first** — parsers and resolvers should come with fixtures under `test/fixtures/`.
2. **No `vscode` in pure core** — `src/parsers`, `src/graph`, `src/analysis`, `src/cache` must remain unit-testable in Vitest.
3. **Never guess edges** — ambiguity produces diagnostics, not edges.
4. **Windows-safe paths** — always normalize to `/` workspace-relative form.
5. **Conventional commits** — `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Project layout

```
src/           extension host (activation, discovery, graph, diagnostics, webview host)
webview-ui/    Preact Loom View + GraphRenderer
test/          Vitest tests + fixtures
docs/          architecture & model docs
```

## Adding a format adapter (v0.2+)

1. Implement `ContextParser` in `src/parsers/`.
2. Register it in `ParserRegistry` (specific patterns before `**/*.md`).
3. Add fixtures under `test/fixtures/`.
4. Document verified semantics with a date.

## License

By contributing, you agree your contributions are licensed under the MIT License.
