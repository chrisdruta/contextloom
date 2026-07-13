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
| `bun run test` | Vitest unit tests (includes perf guards) |
| `bun run test:integration` | `@vscode/test-cli` extension-host tests (needs a display; CI uses xvfb on Linux) |
| `bun run bench:renderers` | Renderer bake-off (ADR-001) |
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
- `monorepo/` — Section 9 sample tree (also the integration-test workspace, copied to `.vscode-test/workspace`)
- `malicious/` — hostile Markdown / YAML
- `windows-paths/` — backslash separators, `%20`-encoded targets, space-named files

Symlink and large-corpus cases are generated at test time (`test/discovery.test.ts`, `test/perf.test.ts`) — they are not committed because they would not survive checkout on all platforms.

## Performance baselines (dev container, x64, 2026-07-13)

- Cold index, 1,000 generated files: **809 ms** (PLAN §Q target: 2,000 ms) — guarded by `test/perf.test.ts` at 5× headroom
- Single-file incremental patch: **8.1 ms** (target: 150 ms)
- Renderer layout numbers: see [ADR-001](./adr/001-graph-rendering.md); reproduce with `bun run bench:renderers`

## Debugging

1. `bun run build`
2. F5 → Extension Development Host
3. Open a folder with Markdown docs
4. Command Palette → **ContextLoom: Open Graph**

## Releases

Versioning is semver, automated by **release-please** (`.github/workflows/release.yml`): merge conventional-commit PRs to `main`, then merge the release PR it opens. On release, CI packages the `.vsix`, attaches it to the GitHub release, and publishes to the VS Code Marketplace / Open VSX when the `VSCE_PAT` / `OVSX_PAT` repository secrets are configured (publishing is skipped silently until then). PR titles are checked for conventional-commit format in CI.

Manual fallback:

```bash
bun run package
# vsce publish --no-dependencies
# ovsx publish *.vsix
```
