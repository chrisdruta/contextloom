import * as vscode from "vscode";
import { settingsHash } from "../shared/hash";
import { type ResolvedSettings, cacheRelevantSettings, resolveSettings } from "./schema";

export class SettingsService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<ResolvedSettings>();
  readonly onDidChange = this._onDidChange.event;

  private current: ResolvedSettings;
  private hash: string;
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.current = this.read();
    this.hash = settingsHash(cacheRelevantSettings(this.current));
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("contextloom")) {
        this.current = this.read();
        this.hash = settingsHash(cacheRelevantSettings(this.current));
        this._onDidChange.fire(this.current);
      }
    });
  }

  get settings(): ResolvedSettings {
    return this.current;
  }

  get settingsHash(): string {
    return this.hash;
  }

  private read(): ResolvedSettings {
    const cfg = vscode.workspace.getConfiguration("contextloom");
    const raw: Record<string, unknown> = {
      roots: cfg.get("roots"),
      include: cfg.get("include"),
      exclude: cfg.get("exclude"),
      respectGitignore: cfg.get("respectGitignore"),
      followSymlinks: cfg.get("followSymlinks"),
      wikiLinks: {
        enabled: cfg.get("wikiLinks.enabled"),
        resolution: cfg.get("wikiLinks.resolution"),
      },
      graph: {
        showExternalLinks: cfg.get("graph.showExternalLinks"),
        maxNodes: cfg.get("graph.maxNodes"),
      },
      diagnostics: {
        enabled: cfg.get("diagnostics.enabled"),
      },
      limits: {
        maxFiles: cfg.get("limits.maxFiles"),
        maxFileSizeKb: cfg.get("limits.maxFileSizeKb"),
      },
      agents: {
        enabled: cfg.get("agents.enabled"),
      },
    };
    return resolveSettings(raw, (msg) => {
      console.warn(`[ContextLoom] ${msg}`);
    });
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChange.dispose();
  }
}
