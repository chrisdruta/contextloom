import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ContextEdgeSchema, ContextNodeSchema } from "../shared/protocol";
import type { ParseResult } from "../shared/types";

const CACHE_SCHEMA = 1;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100_000;

export interface CacheEntry {
  contentHash: string;
  parserId: string;
  parserVersion: number;
  parseResult: ParseResult;
}

interface CacheFile {
  schemaVersion: number;
  settingsHash: string;
  parserFingerprint: string;
  entries: Record<string, CacheEntry>;
}

export class IndexCache {
  private entries = new Map<string, CacheEntry>();
  private settingsHash = "";
  private parserFingerprint = "";
  private dirty = false;

  constructor(private readonly storagePath: string | null) {}

  load(settingsHash: string, parserFingerprint: string): void {
    this.settingsHash = settingsHash;
    this.parserFingerprint = parserFingerprint;
    this.entries.clear();
    this.dirty = false;

    if (!this.storagePath || !existsSync(this.storagePath)) return;

    try {
      if (statSync(this.storagePath).size > MAX_CACHE_BYTES) return;
      const raw = readFileSync(this.storagePath, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (!isCacheFile(data)) return;
      if (data.schemaVersion !== CACHE_SCHEMA) return;
      if (data.settingsHash !== settingsHash) return;
      if (data.parserFingerprint !== parserFingerprint) return;
      for (const [path, entry] of Object.entries(data.entries ?? {})) {
        this.entries.set(path, entry);
      }
    } catch {
      // corrupt ⇒ clean reindex
      this.entries.clear();
    }
  }

  get(
    path: string,
    contentHash: string,
    parserId: string,
    parserVersion: number,
  ): ParseResult | null {
    const e = this.entries.get(path);
    if (!e) return null;
    if (e.contentHash !== contentHash) return null;
    if (e.parserId !== parserId || e.parserVersion !== parserVersion) return null;
    return e.parseResult;
  }

  set(path: string, entry: CacheEntry): void {
    this.entries.set(path, entry);
    this.dirty = true;
  }

  delete(path: string): void {
    if (this.entries.delete(path)) this.dirty = true;
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
  }

  /** Atomic persist (tmp + rename). */
  persist(): void {
    if (!this.storagePath || !this.dirty) return;

    const data: CacheFile = {
      schemaVersion: CACHE_SCHEMA,
      settingsHash: this.settingsHash,
      parserFingerprint: this.parserFingerprint,
      entries: Object.fromEntries(this.entries),
    };

    // Serialize Uint8Array-free (parse results shouldn't contain them)
    const json = JSON.stringify(data);
    // Soft size cap ~50MB
    if (Buffer.byteLength(json, "utf8") > MAX_CACHE_BYTES) {
      // Evict half of entries (oldest insertion order — Map order)
      const keys = [...this.entries.keys()];
      for (let i = 0; i < Math.max(1, Math.floor(keys.length / 2)); i++) {
        this.entries.delete(keys[i]!);
      }
      this.persist();
      return;
    }

    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      const tmp = `${this.storagePath}.${process.pid}.tmp`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, this.storagePath);
      this.dirty = false;
    } catch {
      // best-effort
      try {
        unlinkSync(`${this.storagePath}.${process.pid}.tmp`);
      } catch {
        // ignore
      }
    }
  }
}

function isCacheFile(value: unknown): value is CacheFile {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== CACHE_SCHEMA ||
    typeof value.settingsHash !== "string" ||
    typeof value.parserFingerprint !== "string" ||
    !isRecord(value.entries)
  ) {
    return false;
  }

  const entries = Object.values(value.entries);
  if (entries.length > MAX_CACHE_ENTRIES) return false;
  return entries.every(isCacheEntry);
}

function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.contentHash === "string" &&
    typeof value.parserId === "string" &&
    typeof value.parserVersion === "number" &&
    isParseResult(value.parseResult)
  );
}

function isParseResult(value: unknown): value is ParseResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    value.nodes.every((node) => ContextNodeSchema.safeParse(node).success) &&
    Array.isArray(value.edges) &&
    value.edges.every((edge) => ContextEdgeSchema.safeParse(edge).success) &&
    Array.isArray(value.references) &&
    value.references.every(isRawReference) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic) &&
    Array.isArray(value.scopeRules) &&
    value.scopeRules.every(isScopeRule)
  );
}

function isRawReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["md-link", "wiki-link", "image", "import", "frontmatter-ref"].includes(String(value.kind)) &&
    typeof value.rawTarget === "string" &&
    isSourceRange(value.range)
  );
}

function isDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["error", "warning", "info"].includes(String(value.severity)) &&
    typeof value.message === "string" &&
    isSourceRange(value.range)
  );
}

function isScopeRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sourcePath === "string" &&
    typeof value.format === "string" &&
    ["ancestry", "glob", "always", "model-decision", "manual"].includes(String(value.mechanism)) &&
    (value.globs === undefined ||
      (Array.isArray(value.globs) && value.globs.every((glob) => typeof glob === "string"))) &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isSourceRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isPosition(value.start) &&
    isPosition(value.end)
  );
}

function isPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isFinite(value.line) &&
    Number.isFinite(value.column) &&
    Number.isFinite(value.offset)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cachePathForStorage(storageUriFsPath: string, folderKey?: string): string {
  const suffix = folderKey ? `-${folderKey}` : "";
  return join(storageUriFsPath, `index-cache-v${CACHE_SCHEMA}${suffix}.json`);
}
