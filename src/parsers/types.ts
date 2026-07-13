import type { ResolvedSettings } from "../settings/schema";
import type { FileSnapshot, ParseResult } from "../shared/types";

export interface ParseContext {
  workspaceRoot: string;
  settings: ResolvedSettings;
  log: (msg: string) => void;
}

export interface ContextParser {
  readonly id: string;
  readonly version: number;
  readonly patterns: string[];
  enabled(settings: ResolvedSettings): boolean;
  parse(file: FileSnapshot, ctx: ParseContext): ParseResult;
  cacheDependsOn?(file: FileSnapshot): string[];
}

/** Classification precedence for node type merges. Higher wins. */
export const TYPE_PRECEDENCE: Record<string, number> = {
  skill: 50,
  agent: 50,
  command: 50,
  instruction: 40,
  document: 30,
  "source-file": 20,
  directory: 10,
  heading: 10,
  external: 5,
  missing: 5,
};
