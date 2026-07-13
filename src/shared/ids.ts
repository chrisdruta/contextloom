/** Node/edge identity helpers (Section F.1). */

/** Normalize a workspace-relative path: `/`-separated, no leading `./`, no trailing `/`. */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  // Strip drive letter prefix if present (Windows absolute — shouldn't happen for relative)
  p = p.replace(/^[a-zA-Z]:/, "");
  // Collapse // and resolve . and .. segments without escaping above root
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export function fileId(path: string): string {
  return `file:${normalizePath(path)}`;
}

export function dirId(path: string): string {
  return `dir:${normalizePath(path)}`;
}

export function headingId(path: string, slug: string): string {
  return `heading:${normalizePath(path)}#${slug}`;
}

export function missingId(path: string): string {
  return `missing:${normalizePath(path)}`;
}

export function urlId(url: string): string {
  // Normalize: strip trailing slash on non-root paths, lowercase scheme/host for http(s)
  try {
    const u = new URL(url);
    u.hash = "";
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") {
      href = href.slice(0, -1);
    }
    return `url:${href}`;
  } catch {
    return `url:${url}`;
  }
}

export function edgeId(type: string, source: string, target: string): string {
  return `${type}|${source}|${target}`;
}

/** Extract workspace-relative path from a file:/dir:/missing: id, or null. */
export function pathFromId(id: string): string | null {
  if (id.startsWith("file:")) return id.slice(5);
  if (id.startsWith("dir:")) return id.slice(4);
  if (id.startsWith("missing:")) return id.slice(8);
  if (id.startsWith("heading:")) {
    const rest = id.slice(8);
    const hash = rest.lastIndexOf("#");
    return hash >= 0 ? rest.slice(0, hash) : rest;
  }
  return null;
}
