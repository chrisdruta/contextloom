# Changelog

## Unreleased

### Added

- Cytoscape.js + fcose graph renderer (new default) with measured layout strategy: neighborhood-only layout for small patches, concentric fallback above 1,500 visible nodes (ADR-001); canvas renderer remains via `contextloom.graph.renderer`
- Loom View panel revival after window reload (`WebviewPanelSerializer` + persisted root/filters)
- `@vscode/test-cli` integration test suite (commands, indexing, watcher patches, diagnostics) running on Linux and Windows CI
- `windows-paths` fixture, default-off symlink test, and §Q performance guard tests
- Release automation: release-please + Marketplace/Open VSX publish workflow, conventional-commit PR check

### Changed

- Webview validates all inbound protocol messages with the shared zod schemas (previously host-side only)
- File watcher derives its globs from `contextloom.include` and reindexes on `.gitignore` changes

### Fixed

- Watcher leak: old watchers were never disposed across reindexes

## [0.1.0] — 2026-07-13

### Added

- Initial MVP: Markdown + instruction-file knowledge graph for VS Code
- Loom View with pan/zoom/select/search/filters and Thread Inspector
- Loose Threads view (orphans & broken links) and Graph Outline (a11y)
- Problems-panel diagnostics for broken and ambiguous links
- AGENTS.md / CLAUDE.md recognition as typed instruction nodes
- Content-hash parse cache and debounced file-watcher incremental updates
- Deterministic JSON graph export
- Workspace-confined discovery, symlink handling, and webview file operations
- Bounded cache, protocol, indexing, and graph-rendering resource usage
- Minimal production VSIX packaging with audited development dependencies
