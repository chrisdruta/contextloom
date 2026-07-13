/**
 * Renderer bake-off (ADR-001): measures what can be measured headlessly.
 *
 * - Cytoscape + fcose: real layout compute time (headless cytoscape core),
 *   full (randomize) and incremental (randomize: false after adding a node).
 * - Canvas renderer: per-frame simulation cost of the exact force math in
 *   webview-ui/src/renderer.ts (center gravity + capped pairwise repulsion +
 *   springs + integration), reported as ms/frame against the 16.7 ms budget.
 *
 * Run: bun run scripts/bench-renderers.ts
 */
import cytoscape, { type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

interface SyntheticGraph {
  nodes: { id: string }[];
  edges: { id: string; source: string; target: string }[];
}

/** Docs-like topology: a directory tree spine plus cross links. */
function generateGraph(n: number, seed = 42): SyntheticGraph {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
  const edges: SyntheticGraph["edges"] = [];
  for (let i = 1; i < n; i++) {
    const parent = Math.floor(rand() * i);
    edges.push({ id: `t${i}`, source: `n${parent}`, target: `n${i}` });
  }
  const extra = Math.floor(n * 0.5);
  for (let i = 0; i < extra; i++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b) edges.push({ id: `x${i}`, source: `n${a}`, target: `n${b}` });
  }
  return { nodes, edges };
}

function toElements(g: SyntheticGraph): ElementDefinition[] {
  return [
    ...g.nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id } })),
    ...g.edges.map((e) => ({ group: "edges" as const, data: e })),
  ];
}

function benchFcose(g: SyntheticGraph): { fullMs: number; incrementalMs: number } {
  const cy = cytoscape({ headless: true, styleEnabled: false, elements: toElements(g) });
  const layoutOpts = {
    name: "fcose",
    quality: "default",
    animate: false,
    randomize: true,
  } as Record<string, unknown>;

  const t0 = performance.now();
  cy.elements()
    .layout(layoutOpts as { name: string })
    .run();
  const fullMs = performance.now() - t0;

  cy.add([
    { group: "nodes", data: { id: "new" } },
    { group: "edges", data: { id: "enew", source: "n0", target: "new" } },
  ]);
  const t1 = performance.now();
  cy.elements()
    .layout({ ...layoutOpts, randomize: false } as unknown as { name: string })
    .run();
  const incrementalMs = performance.now() - t1;

  cy.destroy();
  return { fullMs, incrementalMs };
}

/** Mirrors CanvasRenderer.simulate() in webview-ui/src/renderer.ts. */
function benchCanvasFrame(g: SyntheticGraph): { frameMs: number; repulsionCoverage: number } {
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  g.nodes.forEach((n, i) => {
    const angle = (i / g.nodes.length) * Math.PI * 2;
    const r = 80 + Math.sqrt(g.nodes.length) * 30;
    positions.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 });
  });

  const REPULSION_CAP = 400; // renderer.ts caps the quadratic term
  const frames = 30;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    for (const n of g.nodes) {
      const p = positions.get(n.id)!;
      p.vx += -p.x * 0.0005;
      p.vy += -p.y * 0.0005;
    }
    const rep = g.nodes.slice(0, REPULSION_CAP);
    for (let i = 0; i < rep.length; i++) {
      for (let j = i + 1; j < rep.length; j++) {
        const a = positions.get(rep[i]!.id)!;
        const b = positions.get(rep[j]!.id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const force = 800 / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx -= dx;
        a.vy -= dy;
        b.vx += dx;
        b.vy += dy;
      }
    }
    for (const e of g.edges) {
      const a = positions.get(e.source)!;
      const b = positions.get(e.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const fo = (dist - 120) * 0.01;
      a.vx += (dx / dist) * fo;
      a.vy += (dy / dist) * fo;
      b.vx -= (dx / dist) * fo;
      b.vy -= (dy / dist) * fo;
    }
    for (const n of g.nodes) {
      const p = positions.get(n.id)!;
      p.vx *= 0.85;
      p.vy *= 0.85;
      p.x += p.vx;
      p.y += p.vy;
    }
  }
  const frameMs = (performance.now() - t0) / frames;
  return { frameMs, repulsionCoverage: Math.min(1, REPULSION_CAP / g.nodes.length) };
}

/** The strategy the shipped renderer actually uses (see cytoscape-renderer.ts). */
function benchShippedStrategy(g: SyntheticGraph): { concentricMs: number; hoodMs: number } {
  const cy = cytoscape({ headless: true, styleEnabled: false, elements: toElements(g) });
  const t0 = performance.now();
  cy.elements()
    .layout({ name: "concentric", ...({ animate: false } as Record<string, unknown>) })
    .run();
  const concentricMs = performance.now() - t0;

  cy.add([
    { group: "nodes", data: { id: "new" } },
    { group: "edges", data: { id: "enew", source: "n0", target: "new" } },
  ]);
  const hood = cy.getElementById("new").closedNeighborhood().closedNeighborhood();
  const t1 = performance.now();
  hood
    .layout({
      name: "fcose",
      ...({ quality: "default", animate: false, randomize: false, fit: false } as Record<
        string,
        unknown
      >),
    })
    .run();
  const hoodMs = performance.now() - t1;
  cy.destroy();
  return { concentricMs, hoodMs };
}

const sizes = [500, 2000, 5000];
console.log(
  "size | fcose full | fcose incr (full graph) | concentric full | fcose 2-hop patch | canvas sim/frame | canvas repulsion coverage",
);
console.log(
  "---- | ---------- | ----------------------- | --------------- | ----------------- | ---------------- | -------------------------",
);
for (const size of sizes) {
  const g = generateGraph(size);
  const fc = benchFcose(g);
  const st = benchShippedStrategy(g);
  const cv = benchCanvasFrame(g);
  console.log(
    `${size} | ${fc.fullMs.toFixed(0)} ms | ${fc.incrementalMs.toFixed(0)} ms | ${st.concentricMs.toFixed(0)} ms | ${st.hoodMs.toFixed(0)} ms | ${cv.frameMs.toFixed(2)} ms (budget 16.7) | ${(cv.repulsionCoverage * 100).toFixed(0)}% of nodes`,
  );
}
console.log(
  "\nNotes: canvas numbers exclude draw() cost (edges+nodes+labels each frame);",
  "cytoscape renders only on change while the canvas sim runs unconditionally via rAF.",
  "\nfcose quality:'draft' crashes headless (cose-base spectral path, cytoscape-fcose#2.2.0) — not usable.",
);
