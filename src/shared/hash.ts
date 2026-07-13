import { createHash } from "node:crypto";

export function contentHash(data: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(typeof data === "string" ? data : Buffer.from(data));
  return h.digest("hex").slice(0, 16);
}

export function settingsHash(obj: unknown): string {
  return contentHash(JSON.stringify(obj));
}
