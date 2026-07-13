import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { type LooseThread, collectLooseThreads } from "../analysis/orphans";
import { IndexCache, cachePathForStorage } from "../cache/cache";
import type { DiagnosticsPublisher } from "../diagnostics/publisher";
import { type BuildResult, applyFileChanges, buildGraph } from "../graph/builder";
import type { GraphStore } from "../graph/store";
import { ParserRegistry } from "../parsers/registry";
import type { SettingsService } from "../settings/service";
import { contentHash } from "../shared/hash";
import type { GraphPatch, ParserDiagnostic } from "../shared/types";
import type { FileSnapshot } from "../shared/types";

const DEBOUNCE_MS = 200;
const STORM_EVENT_THRESHOLD = 200;

export type IndexState = "idle" | "indexing" | "ready" | "degraded" | "error";

export class IndexerService implements vscode.Disposable {
  readonly registry = new ParserRegistry();
  private cache: IndexCache;
  private build: BuildResult | null = null;
  private root = "";
  private workspaceRoot = "";
  private state: IndexState = "idle";
  private generation = 0;
  private watcher: vscode.FileSystemWatcher | undefined;
  private pendingEvents: { type: "create" | "change" | "delete"; uri: vscode.Uri }[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidUpdate = new vscode.EventEmitter<{
    store: GraphStore;
    patch?: GraphPatch;
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
  ) {
    const storagePath = context.storageUri?.fsPath
      ? cachePathForStorage(context.storageUri.fsPath)
      : null;
    this.cache = new IndexCache(storagePath);

    this.disposables.push(
      this.settings.onDidChange(() => {
        void this.reindex("Settings changed");
      }),
    );
  }

  get store(): GraphStore | null {
    return this.build?.store ?? null;
  }

  get currentRoot(): string {
    return this.root;
  }

  get looseThreads(): LooseThread[] {
    if (!this.build) return [];
    const ambiguous = this.build.diagnostics
      .filter((d) => d.code === "ambiguous-wiki-link")
      .map((d) => ({ message: d.message, range: d.range }));
    return collectLooseThreads(this.build.store, ambiguous);
  }

  get diagnosticsList(): ParserDiagnostic[] {
    return this.build?.diagnostics ?? [];
  }

  async openRoot(graphRoot: string): Promise<void> {
    this.root = graphRoot;
    await this.reindex();
  }

  async reindex(reason?: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.setState("error", "No workspace folder open");
      return;
    }

    this.workspaceRoot = folder.uri.fsPath;
    const gen = ++this.generation;
    this.setState("indexing", reason ?? "Indexing…");

    this.cache.load(this.settings.settingsHash, this.registry.versionFingerprint());

    // Yield so UI can update
    await yieldToEventLoop();
    if (gen !== this.generation) return;

    try {
      const result = buildGraph({
        workspaceRoot: this.workspaceRoot,
        graphRoot: this.root,
        settings: this.settings.settings,
        registry: this.registry,
        cache: this.cache,
        isCancelled: () => gen !== this.generation,
        onProgress: (p) => {
          if (gen !== this.generation) return;
          this._onDidStateChange.fire({
            state: "indexing",
            message: p.message,
            nodeCount: undefined,
          });
        },
      });

      if (gen !== this.generation) return;

      this.build = result;
      this.diagnostics.publish(
        result.diagnostics,
        this.workspaceRoot,
        this.settings.settings.diagnostics.enabled,
      );

      this.ensureWatcher();
      this.setState(
        result.truncated ? "degraded" : "ready",
        result.truncated
          ? `Indexed ${result.fileCount} files (hit maxFiles cap)`
          : `✓ ${result.store.nodeCount()} nodes`,
      );

      this._onDidUpdate.fire({
        store: result.store,
        full: true,
        diagnostics: result.diagnostics,
        looseThreads: this.looseThreads,
        state: this.state,
      });
    } catch (err) {
      this.setState("error", err instanceof Error ? err.message : String(err));
    }
  }

  search(query: string): string[] {
    if (!this.build || !query.trim()) return [];
    const q = query.toLowerCase();
    const hits: { id: string; score: number }[] = [];
    for (const n of this.build.store.allNodes()) {
      let score = 0;
      if (n.label.toLowerCase().includes(q)) score += 3;
      if (n.path?.toLowerCase().includes(q)) score += 2;
      const tags = n.metadata.tags;
      if (Array.isArray(tags) && tags.some((t) => String(t).toLowerCase().includes(q))) {
        score += 1;
      }
      if (score > 0) hits.push({ id: n.id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 50).map((h) => h.id);
  }

  private ensureWatcher(): void {
    this.watcher?.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const pattern = new vscode.RelativePattern(folder, "**/*.{md,mdc}");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate((uri) => this.queueEvent("create", uri));
    this.watcher.onDidChange((uri) => this.queueEvent("change", uri));
    this.watcher.onDidDelete((uri) => this.queueEvent("delete", uri));
    this.disposables.push(this.watcher);
  }

  private queueEvent(type: "create" | "change" | "delete", uri: vscode.Uri): void {
    this.pendingEvents.push({ type, uri });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushEvents(), DEBOUNCE_MS);
  }

  private async flushEvents(): Promise<void> {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    if (!this.build || events.length === 0) return;

    // Storm detection
    const corpus = this.build.fileCount || 1;
    if (events.length > STORM_EVENT_THRESHOLD || events.length > corpus * 0.2) {
      await this.reindex("Watcher storm — full reindex");
      return;
    }

    const created: FileSnapshot[] = [];
    const changed: FileSnapshot[] = [];
    const deleted: string[] = [];

    for (const ev of events) {
      const rel = normalizeRel(this.workspaceRoot, ev.uri.fsPath);
      if (!rel) continue;
      if (
        this.root &&
        !rel.startsWith(this.root === "" ? "" : `${this.root}/`) &&
        rel !== this.root
      ) {
        // outside graph root — skip unless root is workspace
        if (this.root !== "") continue;
      }

      if (ev.type === "delete") {
        deleted.push(rel);
        continue;
      }
      try {
        const buf = readFileSync(ev.uri.fsPath);
        const snap: FileSnapshot = {
          path: rel,
          contents: new Uint8Array(buf),
          hash: contentHash(new Uint8Array(buf)),
        };
        if (ev.type === "create") created.push(snap);
        else changed.push(snap);
      } catch {
        // file may have vanished
        deleted.push(rel);
      }
    }

    const { patch, diagnostics } = applyFileChanges(
      this.build.store,
      { created, changed, deleted },
      {
        workspaceRoot: this.workspaceRoot,
        settings: this.settings.settings,
        registry: this.registry,
        cache: this.cache,
        refIndex: this.build.refIndex,
        parseMeta: this.build.parseMeta,
      },
    );

    // Merge diagnostics for touched files
    this.build.diagnostics = [
      ...this.build.diagnostics.filter(
        (d) =>
          !created.some((f) => f.path === d.range.path) &&
          !changed.some((f) => f.path === d.range.path) &&
          !deleted.includes(d.range.path),
      ),
      ...diagnostics,
    ];

    this.diagnostics.publish(
      this.build.diagnostics,
      this.workspaceRoot,
      this.settings.settings.diagnostics.enabled,
    );

    this._onDidUpdate.fire({
      store: this.build.store,
      patch,
      full: false,
      diagnostics: this.build.diagnostics,
      looseThreads: this.looseThreads,
      state: "ready",
    });
    this.setState("ready", `✓ ${this.build.store.nodeCount()} nodes`);
  }

  private setState(state: IndexState, message?: string): void {
    this.state = state;
    this._onDidStateChange.fire({
      state,
      message,
      nodeCount: this.build?.store.nodeCount(),
      edgeCount: this.build?.store.edgeCount(),
    });
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) d.dispose();
    this.watcher?.dispose();
    this._onDidUpdate.dispose();
    this._onDidStateChange.dispose();
  }
}

function normalizeRel(workspaceRoot: string, absPath: string): string | null {
  const root = workspaceRoot.replace(/\\/g, "/");
  const abs = absPath.replace(/\\/g, "/");
  if (!abs.startsWith(root)) return null;
  let rel = abs.slice(root.length);
  if (rel.startsWith("/")) rel = rel.slice(1);
  return rel;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
