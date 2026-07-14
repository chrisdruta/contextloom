import * as vscode from "vscode";
import type { LooseThread } from "../analysis/orphans";
import type { GraphStore } from "../graph/store";
import type { ContextNode } from "../shared/types";
import type { IndexerRegistry } from "./indexer-registry";

export class GraphRootsProvider implements vscode.TreeDataProvider<RootItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** folder uri → ad-hoc roots opened this session */
  private readonly adHoc = new Map<string, string[]>();

  constructor(private readonly getSavedRoots: () => string[]) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  addAdHoc(root: string, folderUri?: string): void {
    const key = folderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
    const list = this.adHoc.get(key) ?? [];
    if (!list.includes(root) && !this.getSavedRoots().includes(root)) {
      list.push(root);
      this.adHoc.set(key, list);
      this.refresh();
    }
  }

  getTreeItem(element: RootItem): vscode.TreeItem {
    if (element.kind === "folder") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("root-folder");
      item.tooltip = element.folderUri;
      return item;
    }
    const item = new vscode.TreeItem(
      element.label || "(workspace root)",
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon("folder-library");
    item.command = {
      command: "contextloom.openGraph",
      title: "Open Graph",
      arguments: [element.root, element.folderUri],
    };
    item.tooltip = element.root || "Workspace root";
    return item;
  }

  getChildren(element?: RootItem): RootItem[] {
    if (element) return element.children ?? [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return this.rootItems(folders[0]);
    // Multi-root: one expandable group per workspace folder
    return folders.map((folder) => ({
      kind: "folder" as const,
      label: folder.name,
      folderUri: folder.uri.toString(),
      children: this.rootItems(folder),
    }));
  }

  private rootItems(folder: vscode.WorkspaceFolder | undefined): RootItem[] {
    const folderUri = folder?.uri.toString();
    const roots = new Set<string>([
      "",
      ...this.getSavedRoots(),
      ...(this.adHoc.get(folderUri ?? "") ?? []),
    ]);
    return [...roots].map((root) => ({
      kind: "root" as const,
      root,
      folderUri,
      label: root || "(workspace root)",
    }));
  }
}

interface RootItem {
  kind: "folder" | "root";
  label: string;
  root?: string;
  folderUri?: string;
  children?: RootItem[];
}

export class LooseThreadsProvider implements vscode.TreeDataProvider<ThreadItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ThreadItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private threads: LooseThread[] = [];

  constructor(private readonly indexer: IndexerRegistry) {
    indexer.onDidUpdate((ev) => {
      this.threads = ev.looseThreads;
      this._onDidChange.fire(undefined);
    });
  }

  refresh(): void {
    this.threads = this.indexer.looseThreads;
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: ThreadItem): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(element.icon ?? "list-unordered");
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.thread?.message;
    item.iconPath = new vscode.ThemeIcon(
      element.thread?.kind === "orphan" ? "circle-outline" : "warning",
    );
    if (element.thread?.nodeId) {
      item.command = {
        command: "contextloom._revealNode",
        title: "Reveal",
        arguments: [element.thread.nodeId],
      };
    }
    return item;
  }

  getChildren(element?: ThreadItem): ThreadItem[] {
    if (!element) {
      const orphans = this.threads.filter((t) => t.kind === "orphan");
      const broken = this.threads.filter((t) => t.kind === "broken-link");
      const ambiguous = this.threads.filter((t) => t.kind === "ambiguous-wiki");
      return [
        {
          kind: "group",
          label: `Orphans (${orphans.length})`,
          icon: "files",
          children: orphans,
        },
        {
          kind: "group",
          label: `Broken links (${broken.length})`,
          icon: "error",
          children: broken,
        },
        {
          kind: "group",
          label: `Ambiguous wiki links (${ambiguous.length})`,
          icon: "question",
          children: ambiguous,
        },
      ];
    }
    if (element.kind === "group" && element.children) {
      return element.children.map((t) => ({
        kind: "thread" as const,
        label: t.path ?? t.message,
        description: t.kind,
        thread: t,
      }));
    }
    return [];
  }
}

interface ThreadItem {
  kind: "group" | "thread";
  label: string;
  description?: string;
  icon?: string;
  children?: LooseThread[];
  thread?: LooseThread;
}

export class GraphOutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
  private readonly _onDidChange = new vscode.EventEmitter<OutlineItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly indexer: IndexerRegistry) {
    indexer.onDidUpdate(() => this._onDidChange.fire(undefined));
  }

  getTreeItem(element: OutlineItem): vscode.TreeItem {
    const collapsible =
      element.children && element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.description = element.description;
    item.iconPath = new vscode.ThemeIcon(iconForType(element.nodeType));
    if (element.nodeId) {
      item.command = {
        command: "contextloom._revealNode",
        title: "Reveal",
        arguments: [element.nodeId],
      };
    }
    if (element.path) {
      item.tooltip = element.path;
    }
    return item;
  }

  getChildren(element?: OutlineItem): OutlineItem[] {
    const store = this.indexer.store;
    if (!store) return [];

    if (!element) {
      // Group by type
      const byType = new Map<string, ContextNode[]>();
      for (const n of store.allNodes()) {
        if (n.type === "directory") continue;
        const list = byType.get(n.type) ?? [];
        list.push(n);
        byType.set(n.type, list);
      }
      return [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, nodes]) => ({
          id: `type:${type}`,
          label: `${type} (${nodes.length})`,
          nodeType: type,
          children: nodes
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((n) => nodeToItem(n, store)),
        }));
    }

    return element.children ?? [];
  }
}

function nodeToItem(n: ContextNode, store: GraphStore): OutlineItem {
  const out = store.outgoing(n.id).filter((e) => e.type !== "contains");
  const incoming = store.incoming(n.id).filter((e) => e.type !== "contains");
  return {
    id: n.id,
    label: n.label,
    description: n.path,
    path: n.path,
    nodeId: n.id,
    nodeType: n.type,
    children: [
      ...out.map((e) => ({
        id: `out:${e.id}`,
        label: `→ ${e.type} ${e.target}`,
        description: "outgoing",
        nodeType: "edge",
      })),
      ...incoming.map((e) => ({
        id: `in:${e.id}`,
        label: `← ${e.type} ${e.source}`,
        description: "incoming",
        nodeType: "edge",
      })),
    ],
  };
}

interface OutlineItem {
  id: string;
  label: string;
  description?: string;
  path?: string;
  nodeId?: string;
  nodeType?: string;
  children?: OutlineItem[];
}

function iconForType(type?: string): string {
  switch (type) {
    case "document":
      return "markdown";
    case "instruction":
      return "law";
    case "agent":
      return "hubot";
    case "skill":
      return "tools";
    case "command":
      return "terminal";
    case "config":
      return "gear";
    case "missing":
      return "warning";
    case "external":
      return "link-external";
    case "directory":
      return "folder";
    case "source-file":
      return "file-code";
    default:
      return "circle-outline";
  }
}

/** Agents & Skills view (PLAN H.1): agents, skills, commands, rules with descriptions. */
export class AgentsSkillsProvider implements vscode.TreeDataProvider<AgentSkillItem> {
  private readonly _onDidChange = new vscode.EventEmitter<AgentSkillItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly indexer: IndexerRegistry) {
    indexer.onDidUpdate(() => this._onDidChange.fire(undefined));
  }

  getTreeItem(element: AgentSkillItem): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(element.icon ?? "list-unordered");
      return item;
    }
    const node = element.node!;
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description =
      typeof node.metadata.description === "string" ? node.metadata.description : "";
    item.tooltip = node.path;
    item.iconPath = new vscode.ThemeIcon(iconForType(element.iconType ?? node.type));
    if (node.path) item.resourceUri = vscode.Uri.file(node.path);
    item.command = {
      command: "contextloom._revealNode",
      title: "Reveal in graph",
      arguments: [node.id],
    };
    if (node.metadata.shadowedBySkill === true) {
      item.description = `${item.description} (shadowed by skill)`.trim();
    }
    return item;
  }

  getChildren(element?: AgentSkillItem): AgentSkillItem[] {
    if (element) return element.children ?? [];
    const store = this.indexer.store;
    if (!store) return [];

    const nodes = store.allNodes();
    const groups: AgentSkillItem[] = [];
    const push = (label: string, icon: string, members: ContextNode[], iconType?: string) => {
      if (members.length === 0) return;
      groups.push({
        kind: "group",
        label: `${label} (${members.length})`,
        icon,
        children: members
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((node) => ({ kind: "leaf" as const, label: node.label, node, iconType })),
      });
    };

    push(
      "Agents",
      "hubot",
      nodes.filter((n) => n.type === "agent"),
    );
    push(
      "Skills",
      "tools",
      nodes.filter((n) => n.type === "skill"),
    );
    push(
      "Commands",
      "terminal",
      nodes.filter((n) => n.type === "command"),
    );
    push(
      "Rules",
      "checklist",
      nodes.filter((n) => n.type === "instruction" && n.metadata.format === "claude-rules"),
      "instruction",
    );
    // Empty ⇒ [] so the viewsWelcome content shows.
    return groups;
  }
}

interface AgentSkillItem {
  kind: "group" | "leaf";
  label: string;
  icon?: string;
  iconType?: string;
  node?: ContextNode;
  children?: AgentSkillItem[];
}
