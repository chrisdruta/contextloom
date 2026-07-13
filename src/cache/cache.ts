import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ParseResult } from "../shared/types";

const CACHE_SCHEMA = 1;

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

    if (!this.storagePath || !existsSync(this.storagePath)) return;

    try {
      const raw = readFileSync(this.storagePath, "utf8");
      const data = JSON.parse(raw) as CacheFile;
      if (data.schemaVersion !== CACHE_SCHEMA) return;
      if (data.settingsHash !== settingsHash) return;
      if (data.parserFingerprint !== parserFingerprint) return;
      for (const [path, entry] of Object.entries(data.entries ?? {})) {
        this.entries.set(path, reviveParseResult(entry));
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
    if (json.length > 50 * 1024 * 1024) {
      // Evict half of entries (oldest insertion order — Map order)
      const keys = [...this.entries.keys()];
      for (let i = 0; i < Math.floor(keys.length / 2); i++) {
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

function reviveParseResult(entry: CacheEntry): CacheEntry {
  // JSON round-trip is fine for our plain data
  return entry;
}

export function cachePathForStorage(storageUriFsPath: string): string {
  return join(storageUriFsPath, `index-cache-v${CACHE_SCHEMA}.json`);
}
