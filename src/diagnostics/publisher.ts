import * as vscode from "vscode";
import type { ParserDiagnostic } from "../shared/types";

/**
 * Single writer for the Problems panel. Scoped per workspace root so
 * multi-root folders publish independently without clobbering each other.
 */
export class DiagnosticsPublisher implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly urisByRoot = new Map<string, Set<string>>();

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("contextloom");
  }

  publish(diagnostics: ParserDiagnostic[], workspaceRoot: string, enabled: boolean): void {
    // Replace only this root's previous entries
    for (const uriStr of this.urisByRoot.get(workspaceRoot) ?? []) {
      this.collection.delete(vscode.Uri.parse(uriStr));
    }
    this.urisByRoot.delete(workspaceRoot);
    if (!enabled) return;

    const byPath = new Map<string, vscode.Diagnostic[]>();

    for (const d of diagnostics) {
      // Only Error/Warning go to Problems (Section P)
      if (d.severity === "info") continue;

      const abs = vscode.Uri.file(
        workspaceRoot.endsWith("/")
          ? workspaceRoot + d.range.path
          : `${workspaceRoot}/${d.range.path}`,
      );
      // Better: join properly
      const uri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), ...d.range.path.split("/"));

      const severity =
        d.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;

      const start = new vscode.Position(
        Math.max(0, d.range.start.line - 1),
        Math.max(0, d.range.start.column - 1),
      );
      const end = new vscode.Position(
        Math.max(0, d.range.end.line - 1),
        Math.max(0, d.range.end.column - 1),
      );

      const diag = new vscode.Diagnostic(new vscode.Range(start, end), d.message, severity);
      diag.source = "ContextLoom";
      diag.code = d.code;

      const list = byPath.get(uri.toString()) ?? [];
      list.push(diag);
      byPath.set(uri.toString(), list);
      void abs;
    }

    for (const [uriStr, diags] of byPath) {
      this.collection.set(vscode.Uri.parse(uriStr), diags);
    }
    this.urisByRoot.set(workspaceRoot, new Set(byPath.keys()));
  }

  /** Drop a folder's diagnostics (folder removed from the workspace). */
  clearRoot(workspaceRoot: string): void {
    for (const uriStr of this.urisByRoot.get(workspaceRoot) ?? []) {
      this.collection.delete(vscode.Uri.parse(uriStr));
    }
    this.urisByRoot.delete(workspaceRoot);
  }

  clear(): void {
    this.collection.clear();
    this.urisByRoot.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
