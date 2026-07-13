import { z } from "zod";

export const DEFAULT_INCLUDE = [
  "**/*.md",
  "**/*.mdc",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/SKILL.md",
] as const;

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/vendor/**",
  "**/coverage/**",
] as const;

export const SettingsSchema = z.object({
  roots: z.array(z.string()).default([]),
  include: z.array(z.string()).default([...DEFAULT_INCLUDE]),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
  respectGitignore: z.boolean().default(true),
  followSymlinks: z.boolean().default(false),
  wikiLinks: z
    .object({
      enabled: z.boolean().default(true),
      resolution: z.enum(["shortest-unique", "root-relative"]).default("shortest-unique"),
    })
    .default({}),
  graph: z
    .object({
      showExternalLinks: z.boolean().default(false),
      maxNodes: z.number().int().positive().default(3000),
    })
    .default({}),
  diagnostics: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  limits: z
    .object({
      maxFiles: z.number().int().positive().default(20_000),
      maxFileSizeKb: z.number().int().positive().default(1024),
    })
    .default({}),
  agents: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
});

export type ResolvedSettings = z.infer<typeof SettingsSchema>;

/** Parse raw config; invalid values fall back to defaults with warnings. */
export function resolveSettings(
  raw: Record<string, unknown>,
  onWarning?: (msg: string) => void,
): ResolvedSettings {
  const result = SettingsSchema.safeParse(raw);
  if (result.success) return result.data;

  onWarning?.(
    `Invalid ContextLoom settings; using defaults where needed: ${result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`,
  );

  // Field-by-field fallback
  const defaults = SettingsSchema.parse({});
  const merged: Record<string, unknown> = { ...defaults };

  for (const key of Object.keys(defaults) as (keyof ResolvedSettings)[]) {
    if (raw[key] === undefined) continue;
    const partial = SettingsSchema.pick({ [key]: true } as never).safeParse({
      [key]: raw[key],
    });
    if (partial.success) {
      merged[key] = (partial.data as Record<string, unknown>)[key];
    } else {
      onWarning?.(`contextloom.${key}: invalid value, using default`);
    }
  }

  return SettingsSchema.parse(merged);
}

/** Subset of settings that participate in cache invalidation. */
export function cacheRelevantSettings(s: ResolvedSettings): unknown {
  return {
    include: s.include,
    exclude: s.exclude,
    respectGitignore: s.respectGitignore,
    followSymlinks: s.followSymlinks,
    wikiLinks: s.wikiLinks,
    agents: s.agents,
  };
}
