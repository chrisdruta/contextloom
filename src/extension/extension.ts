import * as vscode from "vscode";
import { DiagnosticsPublisher } from "../diagnostics/publisher";
import { exportGraphJson } from "../export/export";
import type { GraphStore } from "../graph/store";
import { resolveContext } from "../scope/resolve";
import type { ScopeMatchGroup } from "../scope/types";
import { SettingsService } from "../settings/service";
import { normalizeWorkspaceRelativePath } from "../shared/paths";
import type { ParserDiagnostic } from "../shared/types";
import { LoomPanel } from "../webview/panel";
import { IndexerRegistry } from "./indexer-registry";
import {
  AgentsSkillsProvider,
  GraphOutlineProvider,
  GraphRootsProvider,
  LooseThreadsProvider,
} from "./views";

let registry: IndexerRegistry | undefined;
let statusBar: vscode.StatusBarItem | undefined;

/** Internal API returned from activate() — used by integration tests. Unstable. */
export interface ContextLoomTestApi {
  openRoot(root: string, folderName?: string): Promise<void>;
  reindexAndWait(): Promise<void>;
  getStore(): GraphStore | null;
  exportJson(): string | null;
  search(query: string): string[];
  getDiagnostics(): ParserDiagnostic[];
  resolveContext(filePath: string): ScopeMatchGroup[];
  onDidUpdate: IndexerRegistry["onDidUpdate"];
}

function findFolder(ref?: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (ref) {
    return folders.find((f) => f.uri.toString() === ref || f.name === ref);
  }
  return folders.length === 1 ? folders[0] : undefined;
}

export function activate(context: vscode.ExtensionContext): ContextLoomTestApi {
  const settings = new SettingsService();
  const diagnostics = new DiagnosticsPublisher();
  registry = new IndexerRegistry(context, settings, diagnostics);
  const reg = registry;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "contextloom.openGraph";
  statusBar.text = "$(type-hierarchy) ContextLoom";
  statusBar.tooltip = "Open ContextLoom graph";
  statusBar.show();

  const rootsProvider = new GraphRootsProvider(() => settings.settings.roots);
  const looseProvider = new LooseThreadsProvider(reg);
  const outlineProvider = new GraphOutlineProvider(reg);
  const agentsProvider = new AgentsSkillsProvider(reg);

  context.subscriptions.push(
    settings,
    diagnostics,
    reg,
    statusBar,
    vscode.window.registerTreeDataProvider("contextloom.graphRoots", rootsProvider),
    vscode.window.registerTreeDataProvider("contextloom.looseThreads", looseProvider),
    vscode.window.registerTreeDataProvider("contextloom.agentsSkills", agentsProvider),
    vscode.window.registerTreeDataProvider("contextloom.graphOutline", outlineProvider),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      reg.removeFolders(e.removed);
      rootsProvider.refresh();
    }),
  );

  reg.onDidStateChange((s) => {
    if (!statusBar) return;
    const folderTag =
      (vscode.workspace.workspaceFolders?.length ?? 0) > 1 && reg.workspaceFolder
        ? ` [${reg.workspaceFolder.name}]`
        : "";
    if (s.state === "indexing") {
      statusBar.text = "$(sync~spin) ContextLoom indexing…";
    } else if (s.state === "ready") {
      statusBar.text = `$(check) ContextLoom ${s.nodeCount ?? 0} nodes${folderTag}`;
    } else if (s.state === "degraded") {
      statusBar.text = `$(warning) ContextLoom ${s.message ?? "degraded"}`;
    } else if (s.state === "error") {
      statusBar.text = "$(error) ContextLoom";
      statusBar.tooltip = s.message;
    } else {
      statusBar.text = "$(type-hierarchy) ContextLoom";
    }
  });

  /** Open (or switch to) a graph for a root inside a workspace folder. */
  const openGraph = async (rootArg?: string, folderRef?: string) => {
    let folder = findFolder(typeof folderRef === "string" ? folderRef : undefined);
    if (!folder) {
      folder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: "Workspace folder to open a graph for",
      });
      if (!folder) return;
    }
    const root = normalizeWorkspaceRelativePath(typeof rootArg === "string" ? rootArg : "");
    if (root === null) {
      void vscode.window.showErrorMessage("ContextLoom graph roots must be inside the workspace.");
      return;
    }
    const indexer = reg.getOrCreate(folder);
    reg.setActive(indexer);
    rootsProvider.addAdHoc(root, folder.uri.toString());
    LoomPanel.show(context.extensionUri, reg, settings);
    await indexer.openRoot(root);
  };

  /** Ensure the folder owning `uri` is indexed and active; return its rel path. */
  const activateFolderFor = async (uri: vscode.Uri): Promise<string | undefined> => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const indexer = reg.getOrCreate(folder);
    reg.setActive(indexer);
    if (!indexer.store) {
      LoomPanel.show(context.extensionUri, reg, settings);
      await indexer.openRoot("");
    } else {
      LoomPanel.show(context.extensionUri, reg, settings);
    }
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("contextloom.openGraph", openGraph),

    vscode.commands.registerCommand("contextloom.openGraphForFolder", async (uri?: vscode.Uri) => {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      if (uri) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return;
        let root = vscode.workspace.asRelativePath(uri, false);
        if (root === uri.fsPath) root = "";
        await openGraph(root, folder.uri.toString());
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Open Graph for Folder",
        defaultUri: vscode.workspace.workspaceFolders[0]!.uri,
      });
      if (!picked?.[0]) return;
      const folder = vscode.workspace.getWorkspaceFolder(picked[0]);
      if (!folder) {
        void vscode.window.showErrorMessage("The folder must be inside the workspace.");
        return;
      }
      let root = vscode.workspace.asRelativePath(picked[0], false);
      if (root === picked[0].fsPath) root = "";
      await openGraph(root, folder.uri.toString());
    }),

    vscode.commands.registerCommand("contextloom.focusCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const rel = await activateFolderFor(editor.document.uri);
      if (!rel) return;
      LoomPanel.current?.focusNode(`file:${rel}`);
    }),

    vscode.commands.registerCommand("contextloom.showAgentContext", async (arg?: unknown) => {
      // Subject: explorer Uri arg > active file editor > the node selected in
      // the Loom view (palette invocations while the graph panel has focus
      // leave activeTextEditor undefined). Any file is a valid subject — a
      // .ts source is the canonical case (stories 7/8).
      let uri: vscode.Uri | undefined;
      if (arg instanceof vscode.Uri) {
        uri = arg;
      } else {
        const editorUri = vscode.window.activeTextEditor?.document.uri;
        if (editorUri?.scheme === "file") uri = editorUri;
      }
      if (!uri) {
        const selectedPath = LoomPanel.current?.lastSelectedFilePath();
        const folder = reg.workspaceFolder;
        if (selectedPath && folder) {
          uri = vscode.Uri.joinPath(folder.uri, ...selectedPath.split("/"));
        }
      }
      const rel = uri ? await activateFolderFor(uri) : undefined;
      if (!rel) {
        void vscode.window.showInformationMessage(
          "Open a workspace file — or select a node in the Loom view — to see its agent context.",
        );
        return;
      }
      const nodeId = `file:${rel}`;
      if (reg.store?.hasNode(nodeId)) {
        LoomPanel.current?.focusNode(nodeId);
      }
      LoomPanel.current?.showAgentContext(rel);
    }),

    vscode.commands.registerCommand("contextloom.findLooseThreads", async () => {
      if (!reg.store) await openGraph("");
      looseProvider.refresh();
      await vscode.commands.executeCommand("contextloom.looseThreads.focus");
    }),

    vscode.commands.registerCommand("contextloom.refreshGraph", async () => {
      await reg.reindex("Manual refresh");
      rootsProvider.refresh();
      looseProvider.refresh();
    }),

    vscode.commands.registerCommand("contextloom.exportGraph", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Export is disabled in untrusted workspaces.");
        return;
      }
      if (!reg.store) {
        await openGraph("");
      }
      const store = reg.store;
      if (!store) return;
      const json = exportGraphJson(store, reg.currentRoot);
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
      LoomPanel.show(context.extensionUri, reg, settings);
      LoomPanel.current?.focusNode(nodeId);
    }),

    vscode.window.registerWebviewPanelSerializer(LoomPanel.viewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        LoomPanel.revive(panel, context.extensionUri, reg, settings);
        const stored = (state ?? {}) as { root?: unknown; folder?: unknown };
        const folder =
          findFolder(typeof stored.folder === "string" ? stored.folder : undefined) ??
          vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const indexer = reg.getOrCreate(folder);
        reg.setActive(indexer);
        const root = normalizeWorkspaceRelativePath(
          typeof stored.root === "string" ? stored.root : "",
        );
        await indexer.openRoot(root ?? "");
      },
    }),
  );

  const api: ContextLoomTestApi = {
    openRoot: async (root, folderName) => {
      const folder = findFolder(folderName) ?? vscode.workspace.workspaceFolders?.[0];
      if (!folder) throw new Error("no workspace folder");
      const indexer = reg.getOrCreate(folder);
      reg.setActive(indexer);
      await indexer.openRoot(root);
    },
    reindexAndWait: () => reg.reindex("test"),
    getStore: () => reg.store,
    exportJson: () => (reg.store ? exportGraphJson(reg.store, reg.currentRoot) : null),
    search: (query) => reg.search(query),
    getDiagnostics: () => reg.diagnosticsList,
    resolveContext: (filePath) => (reg.scopeIndex ? resolveContext(filePath, reg.scopeIndex) : []),
    onDidUpdate: reg.onDidUpdate,
  };
  return api;
}

export function deactivate(): void {
  registry?.dispose();
  registry = undefined;
}
