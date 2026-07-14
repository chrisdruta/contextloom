import * as vscode from "vscode";
import type { LooseThread } from "../analysis/orphans";
import type { DiagnosticsPublisher } from "../diagnostics/publisher";
import type { GraphStore } from "../graph/store";
import type { ScopeIndex } from "../scope/types";
import type { SettingsService } from "../settings/service";
import type { ParserDiagnostic } from "../shared/types";
import type { IndexState, IndexerService } from "./indexer";
import { IndexerService as Indexer } from "./indexer";

/**
 * The stable facade panel/views/status-bar consume: one IndexerService per
 * workspace folder, events relayed from whichever is active. Consumers never
 * re-subscribe on folder switches — setActive re-wires the relays and fires a
 * synthetic full update.
 */
export class IndexerRegistry implements vscode.Disposable {
  private readonly indexers = new Map<string, IndexerService>();
  private active: IndexerService | undefined;
  private relaySubs: vscode.Disposable[] = [];

  private readonly _onDidUpdate = new vscode.EventEmitter<{
    store: GraphStore;
    patch?: import("../shared/types").GraphPatch;
    full: boolean;
    diagnostics: ParserDiagnostic[];
    looseThreads: LooseThread[];
    state: IndexState;
    message?: string;
  }>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private readonly _onDidStateChange = new vscode.EventEmitter<{
    state: IndexState;
    message?: string;
    nodeCount?: number;
    edgeCount?: number;
  }>();
  readonly onDidStateChange = this._onDidStateChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly diagnostics: DiagnosticsPublisher,
  ) {}

  getOrCreate(folder: vscode.WorkspaceFolder): IndexerService {
    const key = folder.uri.toString();
    let indexer = this.indexers.get(key);
    if (!indexer) {
      indexer = new Indexer(this.context, this.settings, this.diagnostics, folder);
      this.indexers.set(key, indexer);
    }
    return indexer;
  }

  /** Make a folder's indexer the one the UI reflects. */
  setActive(indexer: IndexerService): void {
    if (this.active === indexer) return;
    this.active = indexer;
    for (const s of this.relaySubs) s.dispose();
    this.relaySubs = [
      indexer.onDidUpdate((ev) => this._onDidUpdate.fire(ev)),
      indexer.onDidStateChange((ev) => this._onDidStateChange.fire(ev)),
    ];
    // Synthetic full update so views/panel reflect the switch immediately
    const store = indexer.store;
    if (store) {
      this._onDidUpdate.fire({
        store,
        full: true,
        diagnostics: indexer.diagnosticsList,
        looseThreads: indexer.looseThreads,
        state: "ready",
      });
      this._onDidStateChange.fire({
        state: "ready",
        nodeCount: store.nodeCount(),
        edgeCount: store.edgeCount(),
      });
    }
  }

  get activeIndexer(): IndexerService | undefined {
    return this.active;
  }

  /** Folder owning a workspace resource, defaulting sensibly when single-root. */
  static folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (uri) return vscode.workspace.getWorkspaceFolder(uri);
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? folders[0] : undefined;
  }

  /** Dispose indexers for folders removed from the workspace. */
  removeFolders(removed: readonly vscode.WorkspaceFolder[]): void {
    for (const folder of removed) {
      const key = folder.uri.toString();
      const indexer = this.indexers.get(key);
      if (!indexer) continue;
      if (this.active === indexer) {
        for (const s of this.relaySubs) s.dispose();
        this.relaySubs = [];
        this.active = undefined;
        this._onDidStateChange.fire({ state: "idle", message: "Folder removed" });
      }
      indexer.dispose();
      this.indexers.delete(key);
    }
  }

  // Facade accessors (active indexer)
  get store(): GraphStore | null {
    return this.active?.store ?? null;
  }
  get scopeIndex(): ScopeIndex | null {
    return this.active?.scopeIndex ?? null;
  }
  get looseThreads(): LooseThread[] {
    return this.active?.looseThreads ?? [];
  }
  get diagnosticsList(): ParserDiagnostic[] {
    return this.active?.diagnosticsList ?? [];
  }
  get currentRoot(): string {
    return this.active?.currentRoot ?? "";
  }
  get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.active?.folder;
  }

  search(query: string): string[] {
    return this.active?.search(query) ?? [];
  }

  async reindex(reason?: string): Promise<void> {
    await this.active?.reindex(reason);
  }

  dispose(): void {
    for (const s of this.relaySubs) s.dispose();
    for (const indexer of this.indexers.values()) indexer.dispose();
    this.indexers.clear();
    this._onDidUpdate.dispose();
    this._onDidStateChange.dispose();
  }
}
