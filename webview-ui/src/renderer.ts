/**
 * GraphRenderer interface + renderer implementations behind the seam:
 * CytoscapeRenderer (default), CanvasRenderer (fallback), NullRenderer (tests).
 */
import { CytoscapeRenderer } from "./cytoscape-renderer";
import type { FilterState, GraphEdge, GraphNode } from "./protocol";

export interface GraphPatchView {
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodeIds: string[];
  addedEdges: GraphEdge[];
  removedEdgeIds: string[];
}

/** On-selection agent-context emphasis (G.4): subject + its instruction sources. */
export interface ContextHighlight {
  subjectId?: string;
  sourceIds: string[];
  /** Arrows point subject → sources instead (instruction-node selections). */
  reverseArrows?: boolean;
}

export interface GraphRenderer {
  mount(container: HTMLElement): void;
  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void;
  applyPatch(patch: GraphPatchView): void;
  setFilters(filters: FilterState): void;
  focusNode(nodeId: string): void;
  /** Transient decoration only — never persisted, never part of exports. */
  setContextHighlight(highlight: ContextHighlight | null): void;
  destroy(): void;
  onSelect(handler: (sel: { nodeId?: string; edgeId?: string }) => void): void;
  onOpen(handler: (node: GraphNode) => void): void;
}

export class NullRenderer implements GraphRenderer {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private selectHandler?: (sel: { nodeId?: string; edgeId?: string }) => void;
  private openHandler?: (node: GraphNode) => void;
  private el?: HTMLElement;
  /** Recorded for seam tests. */
  lastContextHighlight: ContextHighlight | null = null;

  mount(container: HTMLElement): void {
    this.el = container;
    container.innerHTML =
      '<div style="padding:1rem;opacity:0.7">Null renderer (graph seam). Nodes: 0</div>';
  }

  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.nodes = nodes;
    this.edges = edges;
    this.render();
  }

  applyPatch(patch: GraphPatchView): void {
    const map = new Map(this.nodes.map((n) => [n.id, n]));
    for (const id of patch.removedNodeIds) map.delete(id);
    for (const n of [...patch.addedNodes, ...patch.updatedNodes]) map.set(n.id, n);
    this.nodes = [...map.values()];

    const emap = new Map(this.edges.map((e) => [e.id, e]));
    for (const id of patch.removedEdgeIds) emap.delete(id);
    for (const e of patch.addedEdges) emap.set(e.id, e);
    this.edges = [...emap.values()];
    this.render();
  }

  setFilters(_filters: FilterState): void {}

  setContextHighlight(highlight: ContextHighlight | null): void {
    this.lastContextHighlight = highlight;
  }

  focusNode(nodeId: string): void {
    this.selectHandler?.({ nodeId });
  }

  destroy(): void {
    if (this.el) this.el.innerHTML = "";
  }

  onSelect(handler: (sel: { nodeId?: string; edgeId?: string }) => void): void {
    this.selectHandler = handler;
  }

  onOpen(handler: (node: GraphNode) => void): void {
    this.openHandler = handler;
  }

  private render(): void {
    if (!this.el) return;
    this.el.innerHTML = `<div style="padding:1rem;font-family:var(--font)">
      <p>Null renderer — ${this.nodes.length} nodes, ${this.edges.length} edges</p>
      <ul style="max-height:100%;overflow:auto">${this.nodes
        .slice(0, 100)
        .map(
          (n) =>
            `<li data-id="${escapeHtml(n.id)}" style="cursor:pointer">${escapeHtml(n.label)} <small>(${n.type})</small></li>`,
        )
        .join("")}</ul></div>`;
    for (const li of this.el.querySelectorAll("li[data-id]")) {
      li.addEventListener("click", () => {
        const id = (li as HTMLElement).dataset.id!;
        this.selectHandler?.({ nodeId: id });
      });
      li.addEventListener("dblclick", () => {
        const id = (li as HTMLElement).dataset.id!;
        const node = this.nodes.find((n) => n.id === id);
        if (node) this.openHandler?.(node);
      });
    }
  }
}

/** Lightweight canvas force-ish renderer (no cytoscape dependency required for build). */
export class CanvasRenderer implements GraphRenderer {
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  private filters: FilterState = {
    hiddenNodeTypes: ["directory"],
    hiddenEdgeTypes: ["contains"],
    showInferred: false,
    showExternal: false,
  };
  private selectHandler?: (sel: { nodeId?: string; edgeId?: string }) => void;
  private openHandler?: (node: GraphNode) => void;
  private selectedId?: string;
  private hoverId?: string;
  private contextHighlight: ContextHighlight | null = null;
  private raf = 0;
  private dragging: string | null = null;
  private pan = { x: 0, y: 0 };
  private scale = 1;
  private lastMouse = { x: 0, y: 0 };
  private panning = false;
  private ro?: ResizeObserver;

  mount(container: HTMLElement): void {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.cursor = "grab";
    container.innerHTML = "";
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d") ?? undefined;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    };
    resize();
    this.ro = new ResizeObserver(resize);
    this.ro.observe(container);

    canvas.addEventListener("mousedown", (e) => this.onPointerDown(e));
    canvas.addEventListener("mousemove", (e) => this.onPointerMove(e));
    canvas.addEventListener("mouseup", (e) => this.onPointerUp(e));
    canvas.addEventListener("mouseleave", () => {
      this.dragging = null;
      this.panning = false;
    });
    canvas.addEventListener("dblclick", (e) => {
      const id = this.hitTest(e);
      if (id) {
        const n = this.nodes.find((x) => x.id === id);
        if (n) this.openHandler?.(n);
      }
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.scale = Math.min(4, Math.max(0.2, this.scale * delta));
        this.draw();
      },
      { passive: false },
    );

    this.loop();
  }

  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.contextHighlight = null;
    this.nodes = nodes;
    this.edges = edges;
    this.layoutSeed();
    this.draw();
  }

  applyPatch(patch: GraphPatchView): void {
    this.contextHighlight = null;
    const map = new Map(this.nodes.map((n) => [n.id, n]));
    for (const id of patch.removedNodeIds) {
      map.delete(id);
      this.positions.delete(id);
    }
    for (const n of [...patch.addedNodes, ...patch.updatedNodes]) {
      map.set(n.id, n);
      if (!this.positions.has(n.id)) {
        this.positions.set(n.id, {
          x: (Math.random() - 0.5) * 400,
          y: (Math.random() - 0.5) * 400,
          vx: 0,
          vy: 0,
        });
      }
    }
    this.nodes = [...map.values()];

    const emap = new Map(this.edges.map((e) => [e.id, e]));
    for (const id of patch.removedEdgeIds) emap.delete(id);
    for (const e of patch.addedEdges) emap.set(e.id, e);
    this.edges = [...emap.values()];
    this.draw();
  }

  setFilters(filters: FilterState): void {
    this.filters = filters;
    this.draw();
  }

  setContextHighlight(highlight: ContextHighlight | null): void {
    this.contextHighlight = highlight;
    this.draw();
  }

  focusNode(nodeId: string): void {
    this.selectedId = nodeId;
    const p = this.positions.get(nodeId);
    if (p && this.canvas) {
      const rect = this.canvas.getBoundingClientRect();
      this.pan.x = rect.width / 2 - p.x * this.scale;
      this.pan.y = rect.height / 2 - p.y * this.scale;
    }
    this.selectHandler?.({ nodeId });
    this.draw();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.canvas?.remove();
  }

  onSelect(handler: (sel: { nodeId?: string; edgeId?: string }) => void): void {
    this.selectHandler = handler;
  }

  onOpen(handler: (node: GraphNode) => void): void {
    this.openHandler = handler;
  }

  private visibleNodes(): GraphNode[] {
    return this.nodes.filter((n) => {
      if (this.filters.hiddenNodeTypes.includes(n.type)) return false;
      if (n.type === "external" && !this.filters.showExternal) return false;
      if (n.provenance.origin === "inferred" && !this.filters.showInferred) return false;
      return true;
    });
  }

  private visibleEdges(): GraphEdge[] {
    const vis = new Set(this.visibleNodes().map((n) => n.id));
    return this.edges.filter((e) => {
      if (this.filters.hiddenEdgeTypes.includes(e.type)) return false;
      if (e.provenance.origin === "inferred" && !this.filters.showInferred) return false;
      return vis.has(e.source) && vis.has(e.target);
    });
  }

  private layoutSeed(): void {
    const vis = this.visibleNodes();
    const n = Math.max(vis.length, 1);
    vis.forEach((node, i) => {
      if (this.positions.has(node.id)) return;
      const angle = (i / n) * Math.PI * 2;
      const r = 80 + Math.sqrt(n) * 30;
      this.positions.set(node.id, {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      });
    });
  }

  private loop = (): void => {
    this.simulate();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private simulate(): void {
    const vis = this.visibleNodes();
    const edges = this.visibleEdges();
    // Simple force simulation (few iterations worth per frame)
    for (const n of vis) {
      const p = this.positions.get(n.id);
      if (!p || this.dragging === n.id) continue;
      // weak center gravity
      p.vx += -p.x * 0.0005;
      p.vy += -p.y * 0.0005;
    }
    // Bound the quadratic part of the simulation for hostile/very large graphs.
    const repulsionNodes = vis.slice(0, 400);
    for (let i = 0; i < repulsionNodes.length; i++) {
      for (let j = i + 1; j < repulsionNodes.length; j++) {
        const a = this.positions.get(repulsionNodes[i]!.id)!;
        const b = this.positions.get(repulsionNodes[j]!.id)!;
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
    // springs
    for (const e of edges) {
      const a = this.positions.get(e.source);
      const b = this.positions.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ideal = 120;
      const f = (dist - ideal) * 0.01;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const n of vis) {
      const p = this.positions.get(n.id);
      if (!p || this.dragging === n.id) continue;
      p.vx *= 0.85;
      p.vy *= 0.85;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.scale, this.scale);

    const visIds = new Set(this.visibleNodes().map((n) => n.id));
    const neighborhood = new Set<string>();
    if (this.contextHighlight) {
      // Context emphasis takes precedence: subject + its instruction sources
      if (this.contextHighlight.subjectId) neighborhood.add(this.contextHighlight.subjectId);
      for (const id of this.contextHighlight.sourceIds) neighborhood.add(id);
    } else if (this.hoverId || this.selectedId) {
      const focus = this.hoverId ?? this.selectedId!;
      neighborhood.add(focus);
      for (const e of this.visibleEdges()) {
        if (e.source === focus) neighborhood.add(e.target);
        if (e.target === focus) neighborhood.add(e.source);
      }
    }

    // edges
    for (const e of this.visibleEdges()) {
      const a = this.positions.get(e.source);
      const b = this.positions.get(e.target);
      if (!a || !b) continue;
      const dim =
        neighborhood.size > 0 && !neighborhood.has(e.source) && !neighborhood.has(e.target);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edgeColor(e.type, dim);
      ctx.lineWidth = e.type === "broken-ref" ? 1.5 : 1;
      if (e.type === "broken-ref" || e.provenance.origin === "inferred") {
        ctx.setLineDash([4, 4]);
      } else if (e.type === "wiki-link") {
        ctx.setLineDash([2, 2]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // context-highlight overlay: dashed accent lines subject → each source
    if (this.contextHighlight?.subjectId) {
      const subject = this.positions.get(this.contextHighlight.subjectId);
      if (subject) {
        ctx.strokeStyle = "#3794ff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        for (const id of this.contextHighlight.sourceIds) {
          const src = this.positions.get(id);
          if (!src) continue;
          ctx.beginPath();
          ctx.moveTo(src.x, src.y);
          ctx.lineTo(subject.x, subject.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }

    // nodes
    for (const n of this.visibleNodes()) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      const dim = neighborhood.size > 0 && !neighborhood.has(n.id);
      const r = n.type === "instruction" ? 10 : n.type === "missing" ? 7 : 8;
      ctx.beginPath();
      if (n.type === "instruction") {
        // diamond
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
      } else {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = nodeColor(n.type, dim || (n.id !== this.selectedId && dim));
      if (dim) ctx.globalAlpha = 0.25;
      else ctx.globalAlpha = 1;
      ctx.fill();
      if (n.id === this.selectedId || n.id === this.hoverId) {
        ctx.strokeStyle = "var(--accent, #3794ff)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--fg") || "#ccc";
      ctx.font = "11px sans-serif";
      ctx.fillText(n.label.slice(0, 28), p.x + r + 4, p.y + 3);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    void visIds;
  }

  private onPointerDown(e: MouseEvent): void {
    const id = this.hitTest(e);
    this.lastMouse = { x: e.offsetX, y: e.offsetY };
    if (id) {
      this.dragging = id;
      this.selectedId = id;
      this.selectHandler?.({ nodeId: id });
    } else {
      this.panning = true;
      this.selectedId = undefined;
      this.selectHandler?.({});
    }
    this.draw();
  }

  private onPointerMove(e: MouseEvent): void {
    const dx = e.offsetX - this.lastMouse.x;
    const dy = e.offsetY - this.lastMouse.y;
    this.lastMouse = { x: e.offsetX, y: e.offsetY };

    if (this.dragging) {
      const p = this.positions.get(this.dragging);
      if (p) {
        p.x += dx / this.scale;
        p.y += dy / this.scale;
        p.vx = 0;
        p.vy = 0;
      }
    } else if (this.panning) {
      this.pan.x += dx;
      this.pan.y += dy;
    } else {
      this.hoverId = this.hitTest(e);
    }
    this.draw();
  }

  private onPointerUp(_e: MouseEvent): void {
    this.dragging = null;
    this.panning = false;
  }

  private hitTest(e: MouseEvent): string | undefined {
    const x = (e.offsetX - this.pan.x) / this.scale;
    const y = (e.offsetY - this.pan.y) / this.scale;
    let best: string | undefined;
    let bestD = 14;
    for (const n of this.visibleNodes()) {
      const p = this.positions.get(n.id);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }
}

function nodeColor(type: string, _dim: boolean): string {
  switch (type) {
    case "instruction":
      return "#c586c0";
    case "document":
      return "#4fc1ff";
    case "missing":
      return "#f14c4c";
    case "external":
      return "#89d185";
    case "source-file":
      return "#dcdcaa";
    default:
      return "#cccccc";
  }
}

function edgeColor(type: string, dim: boolean): string {
  const alpha = dim ? "40" : "aa";
  if (type === "broken-ref") return `#f14c4c${alpha}`;
  if (type === "wiki-link") return `#dcdcaa${alpha}`;
  if (type === "references") return `#89d185${alpha}`;
  return `#888888${alpha}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RendererKind = "cytoscape" | "canvas" | "null";

/** Factory: cytoscape (default, ADR-001); canvas as lightweight fallback; null for seam tests. */
export function createRenderer(kind: RendererKind = "cytoscape"): GraphRenderer {
  if (kind === "null") return new NullRenderer();
  if (kind === "canvas") return new CanvasRenderer();
  return new CytoscapeRenderer();
}
