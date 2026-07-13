import * as vscode from "vscode";
import type { ParserDiagnostic } from "../shared/types";

/**
 * Single writer for the Problems panel.
 */
export class DiagnosticsPublisher implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("contextloom");
  }

  publish(diagnostics: ParserDiagnostic[], workspaceRoot: string, enabled: boolean): void {
    this.collection.clear();
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
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
