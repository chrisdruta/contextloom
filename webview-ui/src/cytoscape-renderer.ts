/**
 * Cytoscape.js + fcose implementation of the GraphRenderer seam (PLAN §I,
 * ADR-001). The canvas renderer remains available as a lightweight fallback
 * via contextloom.graph.renderer.
 */
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { FilterState, GraphEdge, GraphNode } from "./protocol";
import type { GraphPatchView, GraphRenderer } from "./renderer";

cytoscape.use(fcose);

const NODE_COLORS: Record<string, string> = {
  instruction: "#c586c0",
  document: "#4fc1ff",
  missing: "#f14c4c",
  external: "#89d185",
  "source-file": "#dcdcaa",
  directory: "#8a8a8a",
};

function nodeColor(type: string): string {
  return NODE_COLORS[type] ?? "#cccccc";
}

function nodeShape(type: string): string {
  if (type === "instruction") return "diamond";
  if (type === "directory") return "round-rectangle";
  if (type === "missing") return "hexagon";
  return "ellipse";
}

function edgeColor(type: string): string {
  if (type === "broken-ref") return "#f14c4c";
  if (type === "wiki-link") return "#dcdcaa";
  if (type === "references") return "#89d185";
  return "#888888";
}

function edgeLineStyle(type: string, origin: string): "solid" | "dashed" | "dotted" {
  if (type === "broken-ref" || origin === "inferred") return "dashed";
  if (type === "wiki-link") return "dotted";
  return "solid";
}

function toNodeDefinition(n: GraphNode): ElementDefinition {
  return {
    group: "nodes",
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      origin: n.provenance.origin,
      color: nodeColor(n.type),
      shape: nodeShape(n.type),
    },
  };
}

function toEdgeDefinition(e: GraphEdge): ElementDefinition {
  return {
    group: "edges",
    data: {
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      origin: e.provenance.origin,
      color: edgeColor(e.type),
      lineStyle: edgeLineStyle(e.type, e.provenance.origin),
    },
  };
}

const DEFAULT_FILTERS: FilterState = {
  hiddenNodeTypes: ["directory"],
  hiddenEdgeTypes: ["contains"],
  showInferred: false,
  showExternal: false,
};

export class CytoscapeRenderer implements GraphRenderer {
  private cy?: Core;
  private nodesById = new Map<string, GraphNode>();
  private filters: FilterState = DEFAULT_FILTERS;
  private selectHandler?: (sel: { nodeId?: string; edgeId?: string }) => void;
  private openHandler?: (node: GraphNode) => void;
  private ro?: ResizeObserver;
  private hadFirstLayout = false;
  private lastOpenAt = 0;
  private readonly reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    const styles = getComputedStyle(document.body);
    const fg = styles.getPropertyValue("--fg").trim() || "#cccccc";
    const accent = styles.getPropertyValue("--accent").trim() || "#3794ff";
    const font = styles.getPropertyValue("--font").trim() || "sans-serif";

    this.cy = cytoscape({
      container,
      elements: [],
      minZoom: 0.1,
      maxZoom: 4,
      wheelSensitivity: 0.2,
      pixelRatio: window.devicePixelRatio || 1,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            shape: "data(shape)" as "ellipse",
            width: 16,
            height: 16,
            label: "data(label)",
            color: fg,
            "font-family": font,
            "font-size": 11,
            "text-wrap": "ellipsis",
            "text-max-width": "140",
            "text-valign": "center",
            "text-halign": "right",
            "text-margin-x": 4,
            "border-width": 0,
          },
        },
        {
          selector: "node[type = 'instruction']",
          style: { width: 20, height: 20 },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": "data(color)",
            "line-style": "data(lineStyle)" as "solid",
            "line-opacity": 0.65,
            "curve-style": "haystack",
            "haystack-radius": 0,
          },
        },
        {
          selector: "edge[type = 'broken-ref']",
          style: { width: 1.5 },
        },
        {
          selector: "node:selected",
          style: { "border-width": 2, "border-color": accent },
        },
        {
          selector: "edge:selected",
          style: { width: 2.5, "line-opacity": 1 },
        },
        {
          selector: ".faded",
          style: { opacity: 0.2, "text-opacity": 0.2 },
        },
        {
          selector: ".hidden",
          style: { display: "none" },
        },
      ],
    });

    const cy = this.cy;

    cy.on("tap", "node", (ev) => {
      this.selectHandler?.({ nodeId: ev.target.id() });
    });
    cy.on("tap", "edge", (ev) => {
      this.selectHandler?.({ edgeId: ev.target.id() });
    });
    cy.on("tap", (ev) => {
      if (ev.target === cy) this.selectHandler?.({});
    });

    const open = (id: string) => {
      // dbltap and dblclick can both fire for one mouse gesture; dedupe.
      const now = Date.now();
      if (now - this.lastOpenAt < 250) return;
      this.lastOpenAt = now;
      const node = this.nodesById.get(id);
      if (node) this.openHandler?.(node);
    };
    cy.on("dbltap", "node", (ev) => open(ev.target.id()));
    cy.on("dblclick", "node", (ev) => open(ev.target.id()));

    cy.on("mouseover", "node", (ev) => {
      const hood = ev.target.closedNeighborhood();
      cy.elements().not(hood).addClass("faded");
    });
    cy.on("mouseout", "node", () => {
      cy.elements().removeClass("faded");
    });

    this.ro = new ResizeObserver(() => cy.resize());
    this.ro.observe(container);
  }

  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    const cy = this.cy;
    if (!cy) return;
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodes.map(toNodeDefinition));
      const ids = new Set(nodes.map((n) => n.id));
      cy.add(edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map(toEdgeDefinition));
      this.applyFilterClasses();
    });
    this.runLayout(!this.hadFirstLayout);
    this.hadFirstLayout = true;
  }

  applyPatch(patch: GraphPatchView): void {
    const cy = this.cy;
    if (!cy) return;
    const newNodeIds: string[] = [];
    cy.batch(() => {
      for (const id of patch.removedEdgeIds) cy.getElementById(id).remove();
      for (const id of patch.removedNodeIds) {
        cy.getElementById(id).remove();
        this.nodesById.delete(id);
      }
      for (const n of [...patch.addedNodes, ...patch.updatedNodes]) {
        this.nodesById.set(n.id, n);
        const existing = cy.getElementById(n.id);
        const def = toNodeDefinition(n);
        if (existing.nonempty()) {
          existing.data(def.data as Record<string, unknown>);
        } else {
          cy.add(def);
          newNodeIds.push(n.id);
        }
      }
      for (const e of patch.addedEdges) {
        if (cy.getElementById(e.id).nonempty()) continue;
        if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty()) continue;
        cy.add(toEdgeDefinition(e));
      }
      // Seed new nodes near a neighbor (edges exist now) so incremental
      // fcose (randomize: false) has a sane starting position.
      for (const id of newNodeIds) {
        const added = cy.getElementById(id);
        if (added.empty()) continue;
        const neighbors = added.neighborhood().nodes().not(added);
        const anchor = neighbors[0];
        if (anchor) {
          const p = anchor.position();
          added.position({ x: p.x + 40, y: p.y + 40 });
        }
      }
      this.applyFilterClasses();
    });
    // Layout strategy (ADR-001 bake-off): full-graph fcose costs ~260 ms at
    // just 500 nodes, so small patches lay out only the affected 2-hop
    // neighborhood (~2-6 ms measured); big patches re-run the global layout.
    const SMALL_PATCH = 10;
    const affectedIds = [...newNodeIds, ...patch.addedEdges.flatMap((e) => [e.source, e.target])];
    const removed = patch.removedNodeIds.length > 0 || patch.removedEdgeIds.length > 0;
    if (affectedIds.length === 0) {
      // Removal-only or data-only patch: existing positions stay valid.
      if (removed) cy.trigger("render");
      return;
    }
    if (newNodeIds.length <= SMALL_PATCH && affectedIds.length <= SMALL_PATCH * 4) {
      const affected = cy.collection();
      for (const id of new Set(affectedIds)) {
        const ele = cy.getElementById(id);
        if (ele.nonempty()) affected.merge(ele);
      }
      const hood = affected.closedNeighborhood().closedNeighborhood().not(".hidden");
      if (hood.nodes().length > 1) {
        hood
          .layout({
            name: "fcose",
            ...({
              quality: "default",
              randomize: false,
              animate: false,
              fit: false,
            } as Record<string, unknown>),
          })
          .run();
      }
    } else {
      this.runLayout(false);
    }
  }

  setFilters(filters: FilterState): void {
    this.filters = filters;
    const cy = this.cy;
    if (!cy) return;
    cy.batch(() => this.applyFilterClasses());
  }

  focusNode(nodeId: string): void {
    const cy = this.cy;
    if (!cy) return;
    const ele = cy.getElementById(nodeId);
    if (ele.empty()) return;
    cy.elements().unselect();
    ele.select();
    if (this.reducedMotion) {
      cy.center(ele);
    } else {
      cy.animate({ center: { eles: ele } }, { duration: 200 });
    }
    this.selectHandler?.({ nodeId });
  }

  destroy(): void {
    this.ro?.disconnect();
    this.cy?.destroy();
    this.cy = undefined;
  }

  onSelect(handler: (sel: { nodeId?: string; edgeId?: string }) => void): void {
    this.selectHandler = handler;
  }

  onOpen(handler: (node: GraphNode) => void): void {
    this.openHandler = handler;
  }

  private applyFilterClasses(): void {
    const cy = this.cy;
    if (!cy) return;
    const f = this.filters;
    const nodes = cy.nodes();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      const type = n.data("type") as string;
      const origin = n.data("origin") as string;
      const hidden =
        f.hiddenNodeTypes.includes(type) ||
        (type === "external" && !f.showExternal) ||
        (origin === "inferred" && !f.showInferred);
      n.toggleClass("hidden", hidden);
    }
    const edges = cy.edges();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e) continue;
      const type = e.data("type") as string;
      const origin = e.data("origin") as string;
      const hidden =
        f.hiddenEdgeTypes.includes(type) ||
        (origin === "inferred" && !f.showInferred) ||
        e.source().hasClass("hidden") ||
        e.target().hasClass("hidden");
      e.toggleClass("hidden", hidden);
    }
  }

  private runLayout(firstRun: boolean): void {
    const cy = this.cy;
    if (!cy) return;
    const visible = cy.elements().not(".hidden");
    if (visible.length === 0) return;
    if (firstRun) {
      // `fit` zooms small graphs in until they fill the viewport; clamp to a
      // sane reading zoom once the layout settles.
      cy.one("layoutstop", () => {
        if (cy.zoom() > 1.1) {
          cy.zoom(1.1);
          cy.center(visible);
        }
      });
    }
    // ADR-001 bake-off: full fcose is ~0.4 s at 500 nodes but ~5 s at 2k and
    // ~33 s at 5k. Above the threshold fall back to concentric (11-40 ms
    // measured at 500-5k) — the plan's §Q degradation ladder, step 3.
    const FCOSE_MAX_NODES = 1500;
    if (visible.nodes().length > FCOSE_MAX_NODES) {
      visible
        .layout({
          name: "concentric",
          ...({ animate: false, fit: firstRun, avoidOverlap: false } as Record<string, unknown>),
        })
        .run();
      return;
    }
    visible
      .layout({
        name: "fcose",
        // fcose options are untyped; they pass through to the extension.
        ...({
          quality: "default",
          randomize: firstRun,
          animate: !this.reducedMotion,
          animationDuration: 300,
          fit: firstRun,
          padding: 50,
          nodeRepulsion: 6000,
          idealEdgeLength: 110,
          // Labels sit to the right of nodes and are ~10x wider than the
          // node itself; without this the layout packs nodes by their 16px
          // circles and every label overlaps its neighbor.
          nodeDimensionsIncludeLabels: true,
          // Zero-degree nodes (orphan docs, missing targets) are tiled into
          // a grid; pad the tiles so labels stay readable.
          tile: true,
          tilingPaddingVertical: 16,
          tilingPaddingHorizontal: 16,
        } as Record<string, unknown>),
      })
      .run();
  }
}
