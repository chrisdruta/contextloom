# ADR-001: Graph rendering library

**Status:** Accepted (2026-07-13)

## Context

PLAN.md §I made a binding decision: Cytoscape.js + cytoscape-fcose behind a
`GraphRenderer` interface, with Graphology as the internal model and Sigma.js
as the escape hatch. The v0.1 implementation instead shipped a hand-rolled
canvas force renderer ("CanvasRenderer") with Cytoscape left unused in
`optionalDependencies`, skipping the Phase 0 Spike 1 validation the plan
required. This ADR records the retroactive bake-off and the final decision.

## Bake-off (2026-07-13, `bun run scripts/bench-renderers.ts`, dev container, x64)

Synthetic docs-like graphs (tree spine + 50% cross links):

| size | fcose full | fcose incr (full graph) | concentric full | fcose 2-hop patch | canvas sim/frame |
|------|-----------|------------------------|-----------------|-------------------|------------------|
| 500  | 391 ms | 247 ms | 11 ms | 1 ms | 2.7 ms |
| 2000 | 5,050 ms | 4,238 ms | 20 ms | 1 ms | 3.5 ms |
| 5000 | 30,794 ms | 26,163 ms | 32 ms | 1 ms | 3.5 ms |

Additional findings:

- **fcose `quality: "draft"` crashes** (`cose-base` spectral path,
  cytoscape-fcose 2.2.0) — the "fast mode" documented upstream is not usable.
- The canvas renderer's per-frame simulation is cheap, but it **caps pairwise
  repulsion at the first 400 nodes** — at 2k nodes only 20% of the graph
  participates in layout, so quality collapses exactly where performance
  would matter. It also runs its rAF loop unconditionally (constant CPU/battery
  drain while the panel is open), and its numbers exclude per-frame draw cost.

## Decision

**CytoscapeRenderer is the default** (`contextloom.graph.renderer: "cytoscape"`),
with a measured layout strategy instead of naive fcose-everywhere:

1. **≤ 1,500 visible nodes:** full fcose (`randomize` on first layout only).
2. **> 1,500 visible nodes:** concentric layout (11–40 ms at 500–5k) — the
   §Q degradation ladder, step 3.
3. **Small patches (≤ 10 new nodes):** fcose on the 2-hop closed neighborhood
   of the affected elements only (~1–6 ms measured), never the full graph —
   full-graph incremental fcose costs ~250 ms at just 500 nodes, which blows
   the §Q 150 ms incremental budget and causes global reshuffling.
4. Removal-only patches keep existing positions (no layout).

The CanvasRenderer stays as a selectable lightweight fallback
(`"canvas"`; ~30 KB vs ~654 KB webview bundle) until v0.2, when real-world
feedback decides whether it earns its maintenance cost. NullRenderer remains
as the seam proof for tests.

## Consequences

- Webview bundle grows from ~30 KB to ~654 KB (bundled locally, no CDN — CSP
  unaffected). Acceptable per PLAN §I.
- Selectors, `:selected` styling, compound-node support (needed for v0.3
  directory grouping), and hover-neighborhood classes come from Cytoscape
  instead of hand-rolled hit-testing.
- What headless benchmarks cannot show — real pan/zoom fps and fcose layout
  *quality* in the actual webview — must be validated in the manual F5 smoke
  test before release. If interaction fps disappoints at scale, the recorded
  escape hatch is Sigma.js v3 + Graphology (PLAN §I fallback), which the
  `GraphRenderer` seam and Graphology store were designed to make a
  renderer-only swap.
