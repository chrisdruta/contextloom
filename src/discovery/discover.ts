import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import type { ResolvedSettings } from "../settings/schema";
import { contentHash } from "../shared/hash";
import { normalizePath } from "../shared/ids";
import { normalizeWorkspaceRelativePath } from "../shared/paths";
import type { FileSnapshot } from "../shared/types";

const MAX_IGNORE_FILE_BYTES = 1024 * 1024;

export interface DiscoveryResult {
  files: FileSnapshot[];
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

export interface DiscoverOptions {
  /** Absolute workspace root */
  workspaceRoot: string;
  /** Workspace-relative root to scan ("" = whole workspace) */
  graphRoot: string;
  settings: ResolvedSettings;
  /** Optional cancel check */
  isCancelled?: () => boolean;
  /** VS Code files.exclude / search.exclude globs (already flattened) */
  vscodeExcludes?: string[];
}

/**
 * Pure filesystem discovery (no vscode). Used by tests and by the VS Code wrapper.
 */
export function discoverFiles(opts: DiscoverOptions): DiscoveryResult {
  const { workspaceRoot, graphRoot, settings } = opts;
  const files: FileSnapshot[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let truncated = false;

  const safeGraphRoot = normalizeWorkspaceRelativePath(graphRoot);
  if (safeGraphRoot === null) {
    return {
      files,
      skipped: [{ path: graphRoot, reason: "outside-workspace" }],
      truncated: false,
    };
  }

  const absWorkspaceRoot = resolve(workspaceRoot);
  const absRoot = safeGraphRoot
    ? resolve(absWorkspaceRoot, ...safeGraphRoot.split("/"))
    : absWorkspaceRoot;

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = realpathSync(absWorkspaceRoot);
  } catch {
    return { files, skipped: [{ path: graphRoot, reason: "unreadable" }], truncated: false };
  }
  const visitedDirectories = new Set<string>();

  const includeMatchers = settings.include.map((g) => picomatch(g, { dot: true }));
  const excludeMatchers = [...settings.exclude, ...(opts.vscodeExcludes ?? [])].map((g) =>
    picomatch(g, { dot: true }),
  );

  const ig = settings.respectGitignore ? loadGitignoreChain(workspaceRoot, graphRoot) : null;

  const maxBytes = settings.limits.maxFileSizeKb * 1024;
  const maxFiles = settings.limits.maxFiles;

  walk(absRoot);

  return { files, skipped, truncated };

  function walk(dir: string): void {
    if (opts.isCancelled?.()) return;
    if (truncated) return;

    let entries: string[];
    try {
      const realDir = realpathSync(dir);
      if (!isWithin(realWorkspaceRoot, realDir) || visitedDirectories.has(realDir)) return;
      visitedDirectories.add(realDir);
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Load nested gitignore
    let localIg = ig;
    if (settings.respectGitignore) {
      const giPath = join(dir, ".gitignore");
      if (existsSync(giPath)) {
        try {
          const content = readIgnoreFile(giPath);
          if (content === null) throw new Error("oversized .gitignore");
          const relDir = normalizePath(relative(workspaceRoot, dir));
          const child = ignore();
          if (ig) child.add(ig);
          // ignore package paths are relative to cwd of rules — prefix
          const lines = content.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
          for (const line of lines) {
            if (line.startsWith("!") || line.startsWith("/")) {
              child.add(relDir ? `${relDir}/${line.replace(/^\//, "")}` : line.replace(/^\//, ""));
            } else {
              child.add(relDir ? `${relDir}/**/${line}` : line);
              child.add(relDir ? `${relDir}/${line}` : line);
            }
          }
          localIg = child;
        } catch {
          // ignore unreadable gitignore
        }
      }
    }

    for (const name of entries) {
      if (truncated || opts.isCancelled?.()) return;
      const abs = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }

      if (st.isSymbolicLink()) {
        if (!settings.followSymlinks) {
          const rel = normalizePath(relative(workspaceRoot, abs));
          skipped.push({ path: rel, reason: "symlink" });
          continue;
        }
        // follow carefully
        try {
          const target = realpathSync(abs);
          if (!isWithin(realWorkspaceRoot, target)) {
            const rel = normalizePath(relative(absWorkspaceRoot, abs));
            skipped.push({ path: rel, reason: "symlink-outside-workspace" });
            continue;
          }
          st = statSync(abs);
        } catch {
          continue;
        }
      }

      const rel = normalizePath(relative(workspaceRoot, abs));

      if (st.isDirectory()) {
        // Always allow agent config dirs even if "dot"
        const base = name;
        if (
          base === "node_modules" ||
          base === ".git" ||
          base === "dist" ||
          base === "build" ||
          base === "out"
        ) {
          if (excludeMatchers.some((m) => m(rel) || m(`${rel}/**`))) {
            continue;
          }
        }
        if (excludeMatchers.some((m) => m(rel) || m(`${rel}/**`))) continue;
        if (localIg?.ignores(rel) || localIg?.ignores(`${rel}/`)) continue;
        walk(abs);
        continue;
      }

      if (!st.isFile()) continue;

      // Include check
      if (!includeMatchers.some((m) => m(rel))) continue;
      if (excludeMatchers.some((m) => m(rel))) {
        skipped.push({ path: rel, reason: "exclude" });
        continue;
      }
      if (localIg?.ignores(rel)) {
        skipped.push({ path: rel, reason: "gitignore" });
        continue;
      }

      if (st.size > maxBytes) {
        skipped.push({ path: rel, reason: `too-large (${st.size} bytes)` });
        continue;
      }

      // Binary guard: null byte in first 8k
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
      const sample = buf.subarray(0, Math.min(8192, buf.length));
      if (sample.includes(0)) {
        skipped.push({ path: rel, reason: "binary" });
        continue;
      }

      if (files.length >= maxFiles) {
        truncated = true;
        skipped.push({ path: rel, reason: "maxFiles" });
        continue;
      }

      const contents = new Uint8Array(buf);
      files.push({
        path: rel,
        contents,
        hash: contentHash(contents),
      });
    }
  }
}

function loadGitignoreChain(workspaceRoot: string, graphRoot: string): Ignore {
  const ig = ignore();
  // Root .gitignore
  const rootGi = join(workspaceRoot, ".gitignore");
  if (existsSync(rootGi)) {
    try {
      const content = readIgnoreFile(rootGi);
      if (content !== null) ig.add(content);
    } catch {
      // ignore
    }
  }
  // Walk graphRoot ancestors for nested — applied during walk
  void graphRoot;
  void sep;
  return ig;
}

function readIgnoreFile(path: string): string | null {
  if (statSync(path).size > MAX_IGNORE_FILE_BYTES) return null;
  return readFileSync(path, "utf8");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
