import { normalizePath } from "./ids";

/** Join workspace-relative segments. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** Directory containing a relative path, or "" for top-level. */
export function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Basename of a path. */
export function basename(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Extension including the dot, lowercased. */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/**
 * Resolve a link target relative to a source file path within a workspace root.
 * Returns { path, fragment, external, outsideWorkspace }.
 */
export function resolveLinkTarget(
  rawTarget: string,
  sourcePath: string,
  _workspaceRoot: string,
): {
  path: string | null;
  fragment: string | null;
  external: boolean;
  outsideWorkspace: boolean;
  url?: string;
} {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return { path: null, fragment: null, external: false, outsideWorkspace: false };
  }

  // Fragment-only
  if (trimmed.startsWith("#")) {
    return {
      path: normalizePath(sourcePath),
      fragment: trimmed.slice(1),
      external: false,
      outsideWorkspace: false,
    };
  }

  // External schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    if (trimmed.startsWith("file:")) {
      // file: URLs are treated as outside / not followed
      return {
        path: null,
        fragment: null,
        external: true,
        outsideWorkspace: true,
        url: trimmed,
      };
    }
    return {
      path: null,
      fragment: null,
      external: true,
      outsideWorkspace: false,
      url: trimmed,
    };
  }

  // mailto / data etc already caught by scheme

  let pathPart = trimmed;
  let fragment: string | null = null;
  const hashIdx = pathPart.indexOf("#");
  if (hashIdx >= 0) {
    fragment = pathPart.slice(hashIdx + 1);
    pathPart = pathPart.slice(0, hashIdx);
  }
  // Strip query
  const qIdx = pathPart.indexOf("?");
  if (qIdx >= 0) pathPart = pathPart.slice(0, qIdx);

  // Decode URI components
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    // keep raw
  }

  pathPart = pathPart.replace(/\\/g, "/");

  let resolved: string;
  if (pathPart.startsWith("/")) {
    // Root-relative within workspace
    resolved = normalizePath(pathPart.slice(1));
  } else {
    const base = dirname(sourcePath);
    resolved = normalizePath(base ? `${base}/${pathPart}` : pathPart);
  }

  // Detect escape above workspace: if raw had enough .. to leave, normalizePath already
  // collapses them. Track if original walked above root.
  const outside = escapesWorkspace(sourcePath, pathPart);

  return {
    path: resolved,
    fragment,
    external: false,
    outsideWorkspace: outside,
  };
}

function escapesWorkspace(sourcePath: string, linkPath: string): boolean {
  if (linkPath.startsWith("/")) return false; // root-relative stays in workspace
  const base = dirname(sourcePath);
  const parts = [...(base ? base.split("/") : []), ...linkPath.split("/")];
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) return true;
    } else {
      depth++;
    }
  }
  return false;
}

/** Ancestor directories from path up to root (excluding the file itself). Closest first. */
export function ancestorDirs(filePath: string): string[] {
  const dirs: string[] = [];
  let d = dirname(filePath);
  while (true) {
    dirs.push(d);
    if (d === "") break;
    d = dirname(d);
  }
  return dirs;
}
