import { useRef } from "preact/hooks";
import {
  type ContextDetails,
  type GraphEdge,
  type GraphNode,
  type InspectorTab,
  type ScopeMatchGroup,
  getVsCodeApi,
  makeEnvelope,
} from "./protocol";

const vscode = getVsCodeApi();

const FORMAT_NAMES: Record<string, string> = {
  "agents-md": "AGENTS.md",
  "claude-md": "CLAUDE.md / imports",
  "claude-rules": "Claude rules",
  "claude-skills": "Claude skills & commands",
  cursor: "Cursor rules",
};

export function InspectorTabs({
  active,
  onSelect,
}: {
  active: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
}) {
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "context", label: "Agent Context" },
  ];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    refs.current[next]?.focus();
    onSelect(tabs[next]!.id);
  };

  return (
    <div class="tabs" role="tablist" aria-label="Inspector sections">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`tabpanel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          class={active === tab.id ? "tab active" : "tab"}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function AgentContextTab({
  context,
  loading,
}: {
  context: ContextDetails | null;
  loading: boolean;
}) {
  if (loading && !context) {
    return (
      <p class="muted" aria-live="polite">
        Resolving context…
      </p>
    );
  }
  if (!context) {
    return <p class="muted">Select a file-backed node to see which instructions govern it.</p>;
  }
  return (
    <div>
      <p class="subject">
        Context for <code>{context.subject.filePath}</code>
      </p>
      {context.groups.length === 0 && (
        <p class="muted">No agent instructions apply to this file.</p>
      )}
      {context.groups.map((group) => (
        <ContextGroup key={group.format} group={group} />
      ))}
    </div>
  );
}

function ContextGroup({ group }: { group: ScopeMatchGroup }) {
  return (
    <section class="ctx-group">
      <h4>{FORMAT_NAMES[group.format] ?? group.format}</h4>
      <table class="ctx-table">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Source</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {group.matches.map((m) => (
            <tr key={`${m.source}:${m.rank}`}>
              <td>
                <span class={`badge status-${m.status}`}>{m.status}</span>
              </td>
              <td>
                <button
                  type="button"
                  class="linkish"
                  onClick={() =>
                    vscode.postMessage(makeEnvelope("node/open", { path: m.sourcePath }))
                  }
                >
                  {m.sourceLabel ?? m.sourcePath}
                </button>
                {m.confidence < 1 && <span class="muted small"> · confidence {m.confidence}</span>}
              </td>
              <td>{m.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {group.note && <p class="muted small">{group.note}</p>}
    </section>
  );
}

export function NodeDetails({
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
      {!!node.metadata.description && (
        <section>
          <h4>Description</h4>
          <p>{String(node.metadata.description)}</p>
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

export function EdgeDetails({ edge }: { edge: GraphEdge }) {
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
