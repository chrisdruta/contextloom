import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AgentContextTab, EdgeDetails, InspectorTabs, NodeDetails } from "./inspector";
import { nodeColor } from "./node-style";
import {
  ContextAppliesToPayload,
  type ContextDetails,
  ContextDetailsPayload,
  type FilterState,
  GraphPatchPayload,
  GraphSnapshotPayload,
  GraphStatusPayload,
  type InspectorTab,
  SearchResultsPayload,
  type SelectionDetails,
  SelectionDetailsPayload,
  ViewFocusPayload,
  getVsCodeApi,
  makeEnvelope,
  parseEnvelope,
} from "./protocol";
import type { WebviewState } from "./protocol";
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
  const [context, setContext] = useState<ContextDetails | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(
    () => vscode.getState()?.inspectorTab ?? "details",
  );
  const [seenTypes, setSeenTypes] = useState<Set<string>>(() => new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Canonical chip order; only types present in the graph render (progressive
  // complexity — repos without .claude/ never see agent chips).
  const NODE_TYPE_ORDER = useMemo(
    () => [
      "document",
      "instruction",
      "agent",
      "skill",
      "command",
      "config",
      "missing",
      "external",
      "source-file",
      "directory",
    ],
    [],
  );
  const nodeTypes = useMemo(
    () => NODE_TYPE_ORDER.filter((t) => seenTypes.has(t) || t === "document"),
    [NODE_TYPE_ORDER, seenTypes],
  );

  const selectTab = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab);
    persistState({ inspectorTab: tab });
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const renderer = createRenderer(rendererKindFromDom());
    rendererRef.current = renderer;
    renderer.mount(hostRef.current);
    renderer.setFilters(vscode.getState()?.filters ?? DEFAULT_FILTERS);

    renderer.onSelect((sel) => {
      if (sel.nodeId) {
        vscode.postMessage(makeEnvelope("node/details", { nodeId: sel.nodeId }));
        // one request feeds both the Agent Context tab and the highlight
        setContext(null);
        setContextLoading(true);
        vscode.postMessage(makeEnvelope("context/request", { nodeId: sel.nodeId }));
      } else if (sel.edgeId) {
        vscode.postMessage(makeEnvelope("node/details", { edgeId: sel.edgeId }));
        renderer.setContextHighlight(null);
      } else {
        setDetails({ kind: "none" });
        setContext(null);
        setContextLoading(false);
        renderer.setContextHighlight(null);
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
          setSeenTypes(new Set(p.nodes.map((n) => n.type)));
          persistState({ root: p.root, folder: p.folder });
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
          if (rest.addedNodes.length > 0) {
            setSeenTypes((prev) => {
              const next = new Set(prev);
              for (const n of rest.addedNodes) next.add(n.type);
              return next;
            });
          }
          break;
        }
        case "context/details": {
          const r = ContextDetailsPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          const p = r.data;
          setContext(p);
          setContextLoading(false);
          if (p.reveal) {
            setInspectorTab("context");
            persistState({ inspectorTab: "context" });
          }
          const activeSources = p.groups
            .flatMap((g) => g.matches)
            .filter((m) => m.status === "active")
            .map((m) => m.source);
          renderer.setContextHighlight(
            activeSources.length > 0 || p.subject.nodeId
              ? { subjectId: p.subject.nodeId, sourceIds: [...new Set(activeSources)] }
              : null,
          );
          break;
        }
        case "context/appliesTo": {
          const r = ContextAppliesToPayload.safeParse(env.payload);
          if (!r.success) return warnInvalid(env.type);
          const p = r.data;
          if (p.subjectNodeIds.length > 0) {
            renderer.setContextHighlight({
              subjectId: p.sourceNodeId,
              sourceIds: p.subjectNodeIds,
              reverseArrows: true,
            });
          }
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
        setContext(null);
        rendererRef.current?.setContextHighlight(null);
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
              <span class="dot" aria-hidden="true" style={{ background: nodeColor(t) }} />
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
          {details.kind === "edge" && details.edge && <EdgeDetails edge={details.edge} />}
          {details.kind === "node" && details.node && !details.node.path && (
            <NodeDetails
              node={details.node}
              incoming={details.incoming ?? []}
              outgoing={details.outgoing ?? []}
            />
          )}
          {details.kind === "node" && details.node?.path && (
            <div>
              <InspectorTabs active={inspectorTab} onSelect={selectTab} />
              <div
                role="tabpanel"
                id={`tabpanel-${inspectorTab}`}
                aria-labelledby={`tab-${inspectorTab}`}
              >
                {inspectorTab === "details" ? (
                  <NodeDetails
                    node={details.node}
                    incoming={details.incoming ?? []}
                    outgoing={details.outgoing ?? []}
                  />
                ) : (
                  <AgentContextTab context={context} loading={contextLoading} />
                )}
              </div>
            </div>
          )}
          {details.kind === "none" &&
            (context ? (
              // Standalone subject (Show Applicable Agent Context on an
              // un-graphed file): context tab only.
              <AgentContextTab context={context} loading={contextLoading} />
            ) : (
              <p class="muted">Select a node or edge to inspect provenance and relationships.</p>
            ))}
        </aside>
      </div>
    </div>
  );
}
