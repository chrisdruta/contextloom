import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FilterState, GraphEdge, GraphNode } from "./protocol";
import { getVsCodeApi, makeEnvelope } from "./protocol";
import { type GraphRenderer, createRenderer } from "./renderer";

const vscode = getVsCodeApi();

const DEFAULT_FILTERS: FilterState = {
  hiddenNodeTypes: ["directory"],
  hiddenEdgeTypes: ["contains"],
  showInferred: false,
  showExternal: false,
};

interface Details {
  kind: "node" | "edge" | "none";
  node?: GraphNode;
  edge?: GraphEdge;
  incoming?: GraphEdge[];
  outgoing?: GraphEdge[];
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState<Details>({ kind: "none" });
  const [matchIds, setMatchIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const nodeTypes = useMemo(
    () => ["document", "instruction", "missing", "external", "source-file", "directory"],
    [],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const renderer = createRenderer("canvas");
    rendererRef.current = renderer;
    renderer.mount(hostRef.current);
    renderer.setFilters(DEFAULT_FILTERS);

    renderer.onSelect((sel) => {
      if (sel.nodeId) {
        vscode.postMessage(makeEnvelope("node/details", { nodeId: sel.nodeId }));
      } else if (sel.edgeId) {
        vscode.postMessage(makeEnvelope("node/details", { edgeId: sel.edgeId }));
      } else {
        setDetails({ kind: "none" });
      }
    });

    renderer.onOpen((node) => {
      if (node.path) {
        vscode.postMessage(
          makeEnvelope("node/open", {
            path: node.path,
          }),
        );
      }
    });

    const onMsg = (event: MessageEvent) => {
      const env = event.data as { v?: number; type?: string; payload?: unknown };
      if (!env || env.v !== 1 || !env.type) return;

      switch (env.type) {
        case "graph/snapshot": {
          const p = env.payload as {
            nodes: GraphNode[];
            edges: GraphEdge[];
            showExternalLinks?: boolean;
          };
          renderer.setGraph(p.nodes, p.edges);
          setNodeCount(p.nodes.length);
          setEdgeCount(p.edges.length);
          if (p.showExternalLinks != null) {
            setFilters((f) => {
              const next = { ...f, showExternal: p.showExternalLinks! };
              renderer.setFilters(next);
              return next;
            });
          }
          setStatus("Ready");
          break;
        }
        case "graph/patch": {
          const p = env.payload as {
            addedNodes: GraphNode[];
            updatedNodes: GraphNode[];
            removedNodeIds: string[];
            addedEdges: GraphEdge[];
            removedEdgeIds: string[];
          };
          renderer.applyPatch(p);
          break;
        }
        case "graph/status": {
          const p = env.payload as {
            state: string;
            message?: string;
            nodeCount?: number;
            edgeCount?: number;
          };
          setStatus(p.message ?? p.state);
          if (p.nodeCount != null) setNodeCount(p.nodeCount);
          if (p.edgeCount != null) setEdgeCount(p.edgeCount);
          break;
        }
        case "selection/details": {
          setDetails(env.payload as Details);
          break;
        }
        case "view/searchResults": {
          const p = env.payload as { matchIds: string[] };
          setMatchIds(p.matchIds);
          if (p.matchIds[0]) renderer.focusNode(p.matchIds[0]);
          break;
        }
        case "view/focus": {
          const p = env.payload as { nodeId: string };
          renderer.focusNode(p.nodeId);
          vscode.postMessage(makeEnvelope("node/details", { nodeId: p.nodeId }));
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("message", onMsg);
    vscode.postMessage(makeEnvelope("ready", {}));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "+" || e.key === "=") {
        // zoom handled by wheel; noop
      }
      if (e.key === "Escape") {
        setDetails({ kind: "none" });
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("keydown", onKey);
      renderer.destroy();
    };
  }, []);

  const updateFilters = useCallback((next: FilterState) => {
    setFilters(next);
    rendererRef.current?.setFilters(next);
    vscode.postMessage(makeEnvelope("view/filters", next));
  }, []);

  const toggleNodeType = (type: string) => {
    const hidden = new Set(filters.hiddenNodeTypes);
    if (hidden.has(type)) hidden.delete(type);
    else hidden.add(type);
    updateFilters({ ...filters, hiddenNodeTypes: [...hidden] });
  };

  const onSearch = (q: string) => {
    setSearch(q);
    vscode.postMessage(makeEnvelope("view/search", { query: q }));
  };

  return (
    <div class="shell">
      <header class="toolbar">
        <div class="brand">ContextLoom</div>
        <input
          ref={searchInputRef}
          class="search"
          type="search"
          placeholder="Search nodes… (/)"
          value={search}
          onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
          aria-label="Search graph"
        />
        <fieldset class="filters" aria-label="Node type filters">
          {nodeTypes.map((t) => (
            <button
              type="button"
              key={t}
              class={filters.hiddenNodeTypes.includes(t) ? "chip off" : "chip"}
              onClick={() => toggleNodeType(t)}
              title={`Toggle ${t}`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            class={filters.showExternal ? "chip" : "chip off"}
            onClick={() => updateFilters({ ...filters, showExternal: !filters.showExternal })}
          >
            external
          </button>
        </fieldset>
        <div class="actions">
          <button
            type="button"
            class="btn"
            onClick={() => vscode.postMessage(makeEnvelope("refresh", {}))}
          >
            Refresh
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => vscode.postMessage(makeEnvelope("export/request", {}))}
          >
            Export
          </button>
        </div>
        <div class="status" aria-live="polite">
          {status} · {nodeCount} nodes · {edgeCount} edges
          {matchIds.length > 0 ? ` · ${matchIds.length} matches` : ""}
        </div>
      </header>
      <div class="main">
        <div class="canvas-host" ref={hostRef} role="img" aria-label="Context graph canvas" />
        <aside class="inspector" aria-label="Thread Inspector">
          <h2>Thread Inspector</h2>
          {details.kind === "none" && (
            <p class="muted">Select a node or edge to inspect provenance and relationships.</p>
          )}
          {details.kind === "node" && details.node && (
            <NodeDetails
              node={details.node}
              incoming={details.incoming ?? []}
              outgoing={details.outgoing ?? []}
            />
          )}
          {details.kind === "edge" && details.edge && <EdgeDetails edge={details.edge} />}
        </aside>
      </div>
      <style>{css}</style>
    </div>
  );
}

function NodeDetails({
  node,
  incoming,
  outgoing,
}: {
  node: GraphNode;
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
}) {
  return (
    <div>
      <div class="badge">{node.type}</div>
      <h3>{node.label}</h3>
      {node.path && (
        <button
          type="button"
          class="linkish"
          onClick={() => vscode.postMessage(makeEnvelope("node/open", { path: node.path }))}
        >
          {node.path}
        </button>
      )}
      {node.path && (
        <div>
          <button
            type="button"
            class="btn small"
            onClick={() => vscode.postMessage(makeEnvelope("node/reveal", { path: node.path }))}
          >
            Reveal in Explorer
          </button>
        </div>
      )}
      <section>
        <h4>Provenance</h4>
        <ul class="meta">
          <li>
            parser: {node.provenance.parserId}@{node.provenance.parserVersion}
          </li>
          <li>origin: {node.provenance.origin}</li>
          <li>confidence: {node.provenance.confidence}</li>
        </ul>
      </section>
      {!!node.metadata.format && (
        <section>
          <h4>Format</h4>
          <p>{String(node.metadata.format)}</p>
        </section>
      )}
      <section>
        <h4>Outgoing ({outgoing.filter((e) => e.type !== "contains").length})</h4>
        <ul class="rel">
          {outgoing
            .filter((e) => e.type !== "contains")
            .slice(0, 40)
            .map((e) => (
              <li key={e.id}>
                <span class="etype">{e.type}</span> → {e.target}
                {e.occurrences[0] && (
                  <button
                    type="button"
                    class="linkish small"
                    onClick={() =>
                      vscode.postMessage(
                        makeEnvelope("node/open", {
                          path: e.occurrences[0]!.path,
                          line: e.occurrences[0]!.start.line,
                          column: e.occurrences[0]!.start.column,
                        }),
                      )
                    }
                  >
                    L{e.occurrences[0].start.line}
                  </button>
                )}
              </li>
            ))}
        </ul>
      </section>
      <section>
        <h4>Incoming / backlinks ({incoming.filter((e) => e.type !== "contains").length})</h4>
        <ul class="rel">
          {incoming
            .filter((e) => e.type !== "contains")
            .slice(0, 40)
            .map((e) => (
              <li key={e.id}>
                <span class="etype">{e.type}</span> ← {e.source}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function EdgeDetails({ edge }: { edge: GraphEdge }) {
  return (
    <div>
      <div class="badge">{edge.type}</div>
      <h3>
        {edge.source} → {edge.target}
      </h3>
      <section>
        <h4>Provenance</h4>
        <ul class="meta">
          <li>parser: {edge.provenance.parserId}</li>
          <li>origin: {edge.provenance.origin}</li>
          <li>confidence: {edge.provenance.confidence}</li>
        </ul>
      </section>
      <section>
        <h4>Occurrences ({edge.occurrences.length})</h4>
        <ul class="rel">
          {edge.occurrences.map((o, i) => (
            <li key={`${o.path}:${o.start.offset}:${i}`}>
              <button
                type="button"
                class="linkish"
                onClick={() =>
                  vscode.postMessage(
                    makeEnvelope("node/open", {
                      path: o.path,
                      line: o.start.line,
                      column: o.start.column,
                    }),
                  )
                }
              >
                {o.path}:{o.start.line}:{o.start.column}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {!!edge.metadata.rawTarget && (
        <section>
          <h4>Raw target</h4>
          <code>{String(edge.metadata.rawTarget)}</code>
        </section>
      )}
    </div>
  );
}

const css = `
.shell { display:flex; flex-direction:column; height:100%; }
.toolbar {
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:8px 10px; border-bottom:1px solid var(--border);
  background: var(--bg);
}
.brand { font-weight:600; margin-right:8px; }
.search {
  flex:1; min-width:140px; max-width:280px;
  background: var(--input-bg); color: var(--input-fg);
  border:1px solid var(--border); border-radius:4px; padding:4px 8px;
}
.filters { display:flex; flex-wrap:wrap; gap:4px; border:none; margin:0; padding:0; min-inline-size:0; }
.chip {
  border:1px solid var(--border); background: transparent; color: var(--fg);
  border-radius:999px; padding:2px 8px; font-size:11px; cursor:pointer;
}
.chip.off { opacity:0.45; text-decoration: line-through; }
.actions { display:flex; gap:4px; }
.btn {
  background: var(--button-bg); color: var(--button-fg);
  border:none; border-radius:4px; padding:4px 10px; cursor:pointer;
}
.btn.small { padding:2px 6px; font-size:11px; margin-top:4px; }
.status { font-size:11px; color: var(--muted); margin-left:auto; }
.main { display:flex; flex:1; min-height:0; }
.canvas-host { flex:1; min-width:0; position:relative; }
.inspector {
  width:300px; max-width:40%; border-left:1px solid var(--border);
  padding:12px; overflow:auto;
}
.inspector h2 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }
.inspector h3 { margin:4px 0 8px; font-size:16px; }
.inspector h4 { margin:12px 0 4px; font-size:12px; color:var(--muted); }
.muted { color: var(--muted); }
.badge {
  display:inline-block; font-size:10px; text-transform:uppercase;
  padding:2px 6px; border-radius:4px; border:1px solid var(--border);
}
.linkish {
  background:none; border:none; color: var(--accent); cursor:pointer;
  padding:0; text-align:left; font: inherit; text-decoration: underline;
  word-break: break-all;
}
.linkish.small { font-size:11px; margin-left:6px; }
.meta, .rel { margin:0; padding-left:16px; font-size:12px; }
.rel li { margin:2px 0; word-break: break-all; }
.etype { color: var(--muted); margin-right:4px; }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
