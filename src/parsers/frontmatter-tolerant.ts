import { parse as parseYaml } from "yaml";

export interface TolerantFrontmatter {
  data: Record<string, unknown>;
  /** True when strict YAML failed and the line-based fallback was used. */
  fallback: boolean;
  /** True when a frontmatter block was present at all. */
  present: boolean;
}

/**
 * Cursor .mdc frontmatter is not reliable YAML (`globs: *.ts` is an invalid
 * alias). Try strict YAML first; on failure fall back to line-based
 * `key: value` extraction so real-world rules still classify.
 */
export function parseTolerantFrontmatter(text: string): TolerantFrontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, fallback: false, present: false };
  const block = match[1]!;

  try {
    const parsed = parseYaml(block, { maxAliasCount: 100 });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, fallback: false, present: true };
    }
  } catch {
    // fall through to line-based extraction
  }

  const data: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const value = m[2]!.trim();
    data[m[1]!] =
      value === "true" ? true : value === "false" ? false : value.replace(/^["']|["']$/g, "");
  }
  return { data, fallback: true, present: true };
}

/** Accept comma-separated string or list forms for glob values. */
export function globList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
