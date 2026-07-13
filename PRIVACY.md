# Privacy

ContextLoom is **local-first and private by default**.

## What we collect

**Nothing.** There is no telemetry, no crash reporting, no analytics, and no phone-home version checks (Marketplace handles updates).

## What runs where

- All file discovery, parsing, graph building, and analysis run **on your machine** inside the VS Code extension host and webview.
- The deterministic core makes **no network requests**.
- ContextLoom **never executes** repository code or scripts found in the repo.
- ContextLoom **never writes** into the repository. Export writes only to a path you choose via a save dialog.

## Workspace Trust

In untrusted workspaces, ContextLoom activates in limited mode:

- Read-only indexing and graph viewing work.
- Export is disabled.
- Workspace-level symlink / include / exclude overrides are restricted so a malicious `.vscode/settings.json` cannot redirect discovery.

## Future AI features

Any LLM-assisted features (planned post-0.1 via VS Code's `vscode.lm` API) will be:

- **Off by default**
- **Opt-in** with explicit per-invocation consent
- Never applied to gitignored files
- Accompanied by a "what was sent" disclosure

Changing this privacy posture requires a **major version bump** and explicit opt-in.
