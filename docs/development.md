# Development

## Prerequisites

- [Bun](https://bun.sh) 1.1+
- Node 20+ (for VS Code test host if used)
- VS Code or Cursor for F5 debugging

## Scripts

| Script | Purpose |
|---|---|
| `bun run build` | Bundle extension + webview to `dist/` |
| `bun run watch` | Rebuild on change |
| `bun run test` | Vitest unit tests |
| `bun run typecheck` | `tsc --noEmit` host + webview |
| `bun run lint` | Biome check |
| `bun run package` | Produce `.vsix` via vsce |

## Fixtures

Under `test/fixtures/`:

- `basic-docs/` — happy-path links + frontmatter
- `broken-links/` — missing files, fragments, traversal
- `wiki-links/` — unique, ambiguous, aliases
- `nested-agents-md/` — AGENTS.md hierarchy
- `nested-claude-md/` — CLAUDE.md + `@import`
- `monorepo/` — Section 9 sample tree
- `malicious/` — hostile Markdown / YAML

## Debugging

1. `bun run build`
2. F5 → Extension Development Host
3. Open a folder with Markdown docs
4. Command Palette → **ContextLoom: Open Graph**

## Release notes

Versioning is semver. Conventional commits recommended. Publish with:

```bash
bun run package
# vsce publish --no-dependencies
# ovsx publish *.vsix
```
