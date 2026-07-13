import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import * as vscode from "vscode";
import { exportGraphJson } from "../export/export";
import type { IndexerService } from "../extension/indexer";
import { filesInScope, resolveContext } from "../scope/resolve";
import type { SettingsService } from "../settings/service";
import { normalizeWorkspaceRelativePath } from "../shared/paths";
import {
  ContextRequestPayload,
  type Envelope,
  GraphPatchPayload,
  GraphSnapshotPayload,
  type GraphStatusPayload,
  NodeDetailsPayload,
  NodeOpenPayload,
  NodeRevealPayload,
  SelectionDetailsPayload,
  ViewFiltersPayload,
  ViewSearchPayload,
  makeEnvelope,
  parseEnvelope,
} from "../shared/protocol";
import { toWireGroups } from "./context-bridge";

const INSTRUCTION_FAMILY = new Set(["instruction", "agent", "skill", "command"]);
const APPLIES_TO_CAP = 2000;

export class LoomPanel {
  public static readonly viewType = "contextloom.loom";
  public static current: LoomPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private snapshotWasCapped = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly indexer: IndexerService,
    private readonly settings: SettingsService,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(
      this.indexer.onDidUpdate((ev) => {
        const exceedsViewCap =
          (this.indexer.store?.nodeCount() ?? 0) > this.settings.settings.graph.maxNodes;
        if (ev.full || exceedsViewCap || this.snapshotWasCapped) {
          this.postSnapshot();
        } else if (ev.patch) {
          this.post(
            makeEnvelope("graph/patch", {
              addedNodes: ev.patch.addedNodes,
              updatedNodes: ev.patch.updatedNodes,
              removedNodeIds: ev.patch.removedNodeIds,
              addedEdges: [...ev.patch.addedEdges, ...ev.patch.updatedEdges],
              removedEdgeIds: ev.patch.removedEdgeIds,
            }),
          );
        }
      }),
      this.indexer.onDidStateChange((s) => {
        const maxNodes = this.settings.settings.graph.maxNodes;
        const capped = (s.nodeCount ?? 0) > maxNodes;
        this.post(
          makeEnvelope("graph/status", {
            state:
              s.state === "indexing"
                ? "indexing"
                : s.state === "error"
                  ? "error"
                  : s.state === "degraded"
                    ? "degraded"
                    : "ready",
            nodeCount: capped ? maxNodes : s.nodeCount,
            edgeCount: capped ? undefined : s.edgeCount,
            message: capped ? `Showing ${maxNodes} of ${s.nodeCount} nodes (view cap)` : s.message,
          } satisfies import("zod").infer<typeof GraphStatusPayload>),
        );
      }),
    );
  }

  static show(
    extensionUri: vscode.Uri,
    indexer: IndexerService,
    settings: SettingsService,
  ): LoomPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (LoomPanel.current) {
      LoomPanel.current.panel.reveal(column);
      return LoomPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      LoomPanel.viewType,
      "ContextLoom — Loom View",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );

    LoomPanel.current = new LoomPanel(panel, extensionUri, indexer, settings);
    return LoomPanel.current;
  }

  /** Re-attach to a panel VS Code restored after a window reload. */
  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    indexer: IndexerService,
    settings: SettingsService,
  ): LoomPanel {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
    };
    LoomPanel.current?.dispose();
    LoomPanel.current = new LoomPanel(panel, extensionUri, indexer, settings);
    return LoomPanel.current;
  }

  focusNode(nodeId: string): void {
    this.post(makeEnvelope("view/focus", { nodeId }));
  }

  /** Host-initiated: resolve and reveal agent context for a workspace file. */
  showAgentContext(relPath: string): void {
    this.postContext({ filePath: relPath }, undefined, true);
  }

  /**
   * Answer a context request. File subjects get context/details (the resolved
   * groups); instruction-family nodes additionally get context/appliesTo (the
   * reverse set for on-selection highlighting). Subjects need not be indexed —
   * a bare .ts path is the canonical case.
   */
  private postContext(
    payload: { nodeId?: string; filePath?: string },
    reqId?: string,
    reveal = false,
  ): void {
    const store = this.indexer.store;
    const scopeIndex = this.indexer.scopeIndex;
    if (!store || !scopeIndex) return;

    let filePath: string | null = null;
    const node = payload.nodeId ? store.getNode(payload.nodeId) : undefined;
    if (payload.nodeId) {
      if (!node?.path) return;
      filePath = node.path;
    } else if (payload.filePath) {
      filePath = normalizeWorkspaceRelativePath(payload.filePath);
    }
    if (filePath === null) return;

    const groups = resolveContext(filePath, scopeIndex);
    this.post(
      makeEnvelope(
        "context/details",
        {
          subject: { filePath, nodeId: store.pathToId(filePath) },
          groups: toWireGroups(groups, (id) => store.getNode(id)?.label),
          reveal: reveal || undefined,
        },
        reqId,
      ),
    );

    // After details, so the reverse highlight wins for instruction selections.
    if (node && INSTRUCTION_FAMILY.has(node.type)) {
      const subjects = filesInScope(node.id, scopeIndex, store.allFilePaths());
      const subjectNodeIds = subjects
        .map((p) => store.pathToId(p))
        .filter((id): id is string => Boolean(id))
        .slice(0, APPLIES_TO_CAP);
      this.post(
        makeEnvelope("context/appliesTo", {
          sourceNodeId: node.id,
          subjectNodeIds,
          truncated: subjects.length > APPLIES_TO_CAP || undefined,
        }),
      );
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    const env = parseEnvelope(raw);
    if (!env) return;

    switch (env.type) {
      case "ready":
        this.postSnapshot();
        break;
      case "node/open": {
        const p = NodeOpenPayload.safeParse(env.payload);
        if (!p.success || !this.isKnownPath(p.data.path)) return;
        await openAt(p.data.path, p.data.line, p.data.column);
        break;
      }
      case "node/reveal": {
        const p = NodeRevealPayload.safeParse(env.payload);
        if (!p.success || !this.isKnownPath(p.data.path)) return;
        await revealInExplorer(p.data.path);
        break;
      }
      case "node/details": {
        const p = NodeDetailsPayload.safeParse(env.payload);
        if (!p.success) return;
        this.postDetails(p.data.nodeId, p.data.edgeId, env.id);
        break;
      }
      case "context/request": {
        const p = ContextRequestPayload.safeParse(env.payload);
        if (!p.success) return;
        this.postContext(p.data, env.id);
        break;
      }
      case "view/search": {
        const p = ViewSearchPayload.safeParse(env.payload);
        if (!p.success) return;
        const matchIds = this.indexer.search(p.data.query);
        this.post(makeEnvelope("view/searchResults", { query: p.data.query, matchIds }, env.id));
        break;
      }
      case "view/filters": {
        const p = ViewFiltersPayload.safeParse(env.payload);
        if (!p.success) return;
        // Persist filter state
        void vscode.commands.executeCommand("contextloom._storeFilters", p.data);
        break;
      }
      case "export/request": {
        await this.doExport();
        break;
      }
      case "refresh": {
        await this.indexer.reindex("Manual refresh");
        break;
      }
      default:
        break;
    }
  }

  private isKnownPath(path: string): boolean {
    const safePath = normalizeWorkspaceRelativePath(path);
    if (safePath === null || safePath !== path.replace(/\\/g, "/")) return false;

    const store = this.indexer.store;
    if (!store) return false;
    if (
      store
        .allNodes()
        .some(
          (node) =>
            node.path === safePath && !["missing", "external", "directory"].includes(node.type),
        )
    ) {
      return true;
    }
    return store
      .allEdges()
      .some((edge) => edge.occurrences.some((occurrence) => occurrence.path === safePath));
  }

  private postSnapshot(): void {
    const store = this.indexer.store;
    if (!store) {
      this.post(
        makeEnvelope("graph/status", {
          state: "indexing",
          message: "Building graph…",
        }),
      );
      return;
    }

    const maxNodes = this.settings.settings.graph.maxNodes;
    const allNodes = store.allNodes().sort((a, b) => {
      const aDirectory = a.type === "directory" ? 1 : 0;
      const bDirectory = b.type === "directory" ? 1 : 0;
      return aDirectory - bDirectory || a.id.localeCompare(b.id);
    });
    const nodes = allNodes.slice(0, maxNodes);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const maxEdges = maxNodes * 10;
    const edges = store
      .allEdges()
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, maxEdges);
    const capped = nodes.length < allNodes.length;
    this.snapshotWasCapped = capped;

    const payload = {
      root: this.indexer.currentRoot,
      nodes,
      edges,
      showExternalLinks: this.settings.settings.graph.showExternalLinks,
    };
    // Validate shape in dev
    GraphSnapshotPayload.safeParse(payload);
    this.post(makeEnvelope("graph/snapshot", payload));
    this.post(
      makeEnvelope("graph/status", {
        state: "ready",
        nodeCount: nodes.length,
        edgeCount: edges.length,
        message: capped
          ? `Showing ${nodes.length} of ${allNodes.length} nodes (view cap)`
          : undefined,
      }),
    );
  }

  private postDetails(nodeId?: string, edgeId?: string, reqId?: string): void {
    const store = this.indexer.store;
    if (!store) {
      this.post(makeEnvelope("selection/details", { kind: "none" }, reqId));
      return;
    }

    if (edgeId) {
      const edge = store.getEdge(edgeId);
      if (!edge) {
        this.post(makeEnvelope("selection/details", { kind: "none" }, reqId));
        return;
      }
      this.post(makeEnvelope("selection/details", { kind: "edge", edge }, reqId));
      return;
    }

    if (nodeId) {
      const node = store.getNode(nodeId);
      if (!node) {
        this.post(makeEnvelope("selection/details", { kind: "none" }, reqId));
        return;
      }
      this.post(
        makeEnvelope(
          "selection/details",
          {
            kind: "node",
            node,
            incoming: store.incoming(nodeId),
            outgoing: store.outgoing(nodeId),
          },
          reqId,
        ),
      );
      return;
    }

    this.post(makeEnvelope("selection/details", { kind: "none" }, reqId));
  }

  private async doExport(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Export is disabled in untrusted workspaces.");
      return;
    }
    const store = this.indexer.store;
    if (!store) return;
    const json = exportGraphJson(store, this.indexer.currentRoot);
    const uri = await vscode.window.showSaveDialog({
      filters: { JSON: ["json"] },
      defaultUri: vscode.Uri.file("contextloom-graph.json"),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
    void vscode.window.showInformationMessage(`Exported graph to ${uri.fsPath}`);
  }

  private post(env: Envelope): void {
    void this.panel.webview.postMessage(env);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const nonce = getNonce();
    // Note: 'unsafe-inline' is deliberately absent from style-src — with a
    // nonce present browsers ignore it anyway (CSP3), which is why the app
    // stylesheet is injected via adoptedStyleSheets (webview-ui/src/styles.ts),
    // not a <style> element.
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ContextLoom</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-focusBorder);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --list-hover: var(--vscode-list-hoverBackground);
      --font: var(--vscode-font-family);
      --font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    html, body, #app { height: 100%; margin: 0; }
    body {
      font-family: var(--font);
      font-size: var(--font-size);
      color: var(--fg);
      background: var(--bg);
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="app" data-renderer="${this.settings.settings.graph.renderer}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    LoomPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

async function openAt(relPath: string, line?: number, column?: number): Promise<void> {
  const uri = confinedWorkspaceUri(relPath);
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  if (line != null) {
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function revealInExplorer(relPath: string): Promise<void> {
  const uri = confinedWorkspaceUri(relPath);
  if (!uri) return;
  await vscode.commands.executeCommand("revealInExplorer", uri);
}

function confinedWorkspaceUri(relPath: string): vscode.Uri | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return null;
  const safePath = normalizeWorkspaceRelativePath(relPath);
  if (safePath === null || safePath !== relPath.replace(/\\/g, "/")) return null;

  const uri = vscode.Uri.joinPath(folder.uri, ...relPath.split("/"));
  try {
    const root = realpathSync(folder.uri.fsPath);
    const target = realpathSync(uri.fsPath);
    const rel = relative(root, target);
    if (rel !== "" && (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) return null;
    return uri;
  } catch {
    return null;
  }
}

function getNonce(): string {
  return randomBytes(24).toString("base64url");
}
