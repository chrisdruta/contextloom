import * as vscode from "vscode";
import { DiagnosticsPublisher } from "../diagnostics/publisher";
import { exportGraphJson } from "../export/export";
import type { GraphStore } from "../graph/store";
import { SettingsService } from "../settings/service";
import { normalizeWorkspaceRelativePath } from "../shared/paths";
import type { ParserDiagnostic } from "../shared/types";
import { LoomPanel } from "../webview/panel";
import { IndexerService } from "./indexer";
import { GraphOutlineProvider, GraphRootsProvider, LooseThreadsProvider } from "./views";

let indexer: IndexerService | undefined;
let statusBar: vscode.StatusBarItem | undefined;

/** Internal API returned from activate() — used by integration tests. Unstable. */
export interface ContextLoomTestApi {
  openRoot(root: string): Promise<void>;
  reindexAndWait(): Promise<void>;
  getStore(): GraphStore | null;
  exportJson(): string | null;
  search(query: string): string[];
  getDiagnostics(): ParserDiagnostic[];
  onDidUpdate: IndexerService["onDidUpdate"];
}

export function activate(context: vscode.ExtensionContext): ContextLoomTestApi {
  const settings = new SettingsService();
  const diagnostics = new DiagnosticsPublisher();
  indexer = new IndexerService(context, settings, diagnostics);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "contextloom.openGraph";
  statusBar.text = "$(type-hierarchy) ContextLoom";
  statusBar.tooltip = "Open ContextLoom graph";
  statusBar.show();

  const rootsProvider = new GraphRootsProvider(() => settings.settings.roots);
  const looseProvider = new LooseThreadsProvider(indexer);
  const outlineProvider = new GraphOutlineProvider(indexer);

  context.subscriptions.push(
    settings,
    diagnostics,
    indexer,
    statusBar,
    vscode.window.registerTreeDataProvider("contextloom.graphRoots", rootsProvider),
    vscode.window.registerTreeDataProvider("contextloom.looseThreads", looseProvider),
    vscode.window.registerTreeDataProvider("contextloom.graphOutline", outlineProvider),
  );

  indexer.onDidStateChange((s) => {
    if (!statusBar) return;
    if (s.state === "indexing") {
      statusBar.text = "$(sync~spin) ContextLoom indexing…";
    } else if (s.state === "ready") {
      statusBar.text = `$(check) ContextLoom ${s.nodeCount ?? 0} nodes`;
    } else if (s.state === "degraded") {
      statusBar.text = `$(warning) ContextLoom ${s.message ?? "degraded"}`;
    } else if (s.state === "error") {
      statusBar.text = "$(error) ContextLoom";
      statusBar.tooltip = s.message;
    }
  });

  const openGraph = async (rootArg?: string) => {
    const root = normalizeWorkspaceRelativePath(typeof rootArg === "string" ? rootArg : "");
    if (root === null) {
      void vscode.window.showErrorMessage("ContextLoom graph roots must be inside the workspace.");
      return;
    }
    rootsProvider.addAdHoc(root);
    LoomPanel.show(context.extensionUri, indexer!, settings);
    await indexer!.openRoot(root);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("contextloom.openGraph", openGraph),

    vscode.commands.registerCommand("contextloom.openGraphForFolder", async (uri?: vscode.Uri) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      let root = "";
      if (uri) {
        root = vscode.workspace.asRelativePath(uri, false);
        if (root === uri.fsPath) root = "";
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Open Graph for Folder",
          defaultUri: folder.uri,
        });
        if (!picked?.[0]) return;
        root = vscode.workspace.asRelativePath(picked[0], false);
        if (root === picked[0].fsPath) root = "";
      }
      await openGraph(root);
    }),

    vscode.commands.registerCommand("contextloom.focusCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (!indexer!.store) {
        await openGraph("");
      } else {
        LoomPanel.show(context.extensionUri, indexer!, settings);
      }
      const nodeId = `file:${rel.replace(/\\/g, "/")}`;
      LoomPanel.current?.focusNode(nodeId);
    }),

    vscode.commands.registerCommand("contextloom.findLooseThreads", async () => {
      if (!indexer!.store) await openGraph("");
      looseProvider.refresh();
      await vscode.commands.executeCommand("contextloom.looseThreads.focus");
    }),

    vscode.commands.registerCommand("contextloom.refreshGraph", async () => {
      await indexer!.reindex("Manual refresh");
      rootsProvider.refresh();
      looseProvider.refresh();
    }),

    vscode.commands.registerCommand("contextloom.exportGraph", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Export is disabled in untrusted workspaces.");
        return;
      }
      if (!indexer!.store) {
        await openGraph("");
      }
      const store = indexer!.store;
      if (!store) return;
      const json = exportGraphJson(store, indexer!.currentRoot);
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        saveLabel: "Export Graph",
        defaultUri: vscode.Uri.file("contextloom-graph.json"),
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
      void vscode.window.showInformationMessage(`Exported graph to ${uri.fsPath}`);
    }),

    vscode.commands.registerCommand("contextloom._revealNode", (nodeId: string) => {
      LoomPanel.show(context.extensionUri, indexer!, settings);
      LoomPanel.current?.focusNode(nodeId);
    }),

    vscode.window.registerWebviewPanelSerializer(LoomPanel.viewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        LoomPanel.revive(panel, context.extensionUri, indexer!, settings);
        const stored = (state ?? {}) as { root?: unknown };
        const root = normalizeWorkspaceRelativePath(
          typeof stored.root === "string" ? stored.root : "",
        );
        await indexer!.openRoot(root ?? "");
      },
    }),
  );

  const api: ContextLoomTestApi = {
    openRoot: (root) => indexer!.openRoot(root),
    reindexAndWait: () => indexer!.reindex("test"),
    getStore: () => indexer!.store,
    exportJson: () =>
      indexer!.store ? exportGraphJson(indexer!.store, indexer!.currentRoot) : null,
    search: (query) => indexer!.search(query),
    getDiagnostics: () => indexer!.diagnosticsList,
    onDidUpdate: indexer.onDidUpdate,
  };
  return api;
}

export function deactivate(): void {
  indexer?.dispose();
  indexer = undefined;
}
