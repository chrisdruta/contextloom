import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type FilterState,
  GraphPatchPayload,
  GraphSnapshotPayload,
  GraphStatusPayload,
  SearchResultsPayload,
  type SelectionDetails,
  SelectionDetailsPayload,
  ViewFocusPayload,
  getVsCodeApi,
  makeEnvelope,
  parseEnvelope,
} from "./protocol";
import type { GraphEdge, GraphNode, WebviewState } from "./protocol";
import { type GraphRenderer, type RendererKind, createRenderer } from "./renderer";
import { applyStylesheet } from "./styles";

applyStylesheet();

const vscode = getVsCodeApi();

const DEFAULT_FILTERS: FilterState = {
  hiddenNodeTypes: ["directory"],
  hiddenEdgeTypes: ["contains"],
  showInferred: false,
  showExternal: false,
};

function persistState(partial: WebviewState): void {
  vscode.setState({ ...(vscode.getState() ?? {}), ...partial });
}

function rendererKindFromDom(): RendererKind {
  const attr = document.getElementById("app")?.dataset.renderer;
  return attr === "canvas" || attr === "null" || attr === "cytoscape" ? attr : "cytoscape";
}

function warnInvalid(type: string): void {
  console.warn(`[ContextLoom] dropped invalid ${type} message`);
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [filters, setFilters] = useState<FilterState>(
    () => vscode.getState()?.filters ?? DEFAULT_FILTERS,
  );
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState<SelectionDetails>({ kind: "none" });
  const [matchIds, setMatchIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const nodeTypes = useMemo(
    () => ["document", "instruction", "missing", "external", "source-file", "directory"],
    [],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const renderer = createRenderer(rendererKindFromDom());
    rendererRef.current = renderer;
    renderer.mount(hostRef.current);
    renderer.setFilters(vscode.getState()?.filters ?? DEFAULT_FILTERS);

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
      const env = parseEnvelope(event.data);
      if (!env) return;

      switch (env.type) {
        case "graph/snapshot": {
          const r = GraphSnapshotPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          const p = r.data;
          renderer.setGraph(p.nodes, p.edges);
          setNodeCount(p.nodes.length);
          setEdgeCount(p.edges.length);
          persistState({ root: p.root });
          if (p.showExternalLinks != null) {
            const showExternal = p.showExternalLinks;
            setFilters((f) => {
              const next = { ...f, showExternal };
              renderer.setFilters(next);
              persistState({ filters: next });
              return next;
            });
          }
          setStatus("Ready");
          break;
        }
        case "graph/patch": {
          const r = GraphPatchPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          const { updatedEdges, ...rest } = r.data;
          renderer.applyPatch({
            ...rest,
            addedEdges: [...rest.addedEdges, ...(updatedEdges ?? [])],
          });
          break;
        }
        case "graph/status": {
          const r = GraphStatusPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          const p = r.data;
          setStatus(p.message ?? p.state);
          if (p.nodeCount != null) setNodeCount(p.nodeCount);
          if (p.edgeCount != null) setEdgeCount(p.edgeCount);
          break;
        }
        case "selection/details": {
          const r = SelectionDetailsPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          setDetails(r.data);
          break;
        }
        case "view/searchResults": {
          const r = SearchResultsPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          setMatchIds(r.data.matchIds);
          if (r.data.matchIds[0]) renderer.focusNode(r.data.matchIds[0]);
          break;
        }
        case "view/focus": {
          const r = ViewFocusPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          renderer.focusNode(r.data.nodeId);
          vscode.postMessage(makeEnvelope("node/details", { nodeId: r.data.nodeId }));
          break;
        }
        default:
          break;
      }
    };

    const onError = (e: ErrorEvent) => {
      setFatalError(`Webview error: ${e.message}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      setFatalError(`Webview error: ${String(e.reason)}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

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
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      renderer.destroy();
    };
  }, []);

  const updateFilters = useCallback((next: FilterState) => {
    setFilters(next);
    rendererRef.current?.setFilters(next);
    persistState({ filters: next });
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
      {fatalError && <div class="error-banner">{fatalError}</div>}
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
