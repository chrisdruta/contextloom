/**
 * PLAN §G.5 oracle validation: run real Claude Code against a marker fixture
 * and check the scope resolver agrees with what it actually loads.
 *
 * Requires an authenticated `claude` CLI — run manually, never in CI:
 *   bun run scripts/oracle-validation.ts
 *
 * Method: PLAN §G.5 proposed the `InstructionsLoaded` hook event, but it does
 * not exist (verified against Claude Code 2.1.197 — project-settings hooks
 * with that event never fire). Instead each instruction file carries a unique
 * ORACLE-MARKER-* string and a headless prompt asks the model to list the
 * markers present in its context.
 *
 * Findings recorded in docs/agent-context.md (2026-07, CLI 2.1.197):
 *  - ancestor CLAUDE.md files concatenate root→leaf         → resolver ✓
 *  - descendant CLAUDE.md files lazy-load (absent at start) → resolver ✓
 *  - AGENTS.md is not read natively                         → resolver ✓
 *  - @imports expand ONLY in the CLAUDE.md nearest the session cwd;
 *    ancestor files load unexpanded                          → resolver notes this
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { resolveContext } from "../src/scope/resolve";
import { SettingsSchema } from "../src/settings/schema";

const PROMPT =
  "List every string of the form ORACLE-MARKER-<something> that appears anywhere in your " +
  "system context or project instructions. Reply with ONLY the marker strings, comma-separated, nothing else.";

function makeOracleRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cl-oracle-"));
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write("CLAUDE.md", "# Root\n\nORACLE-MARKER-C1\n\nImport: @shared/imported.md\n");
  write("shared/imported.md", "# Shared\n\nORACLE-MARKER-IMP\n");
  write("AGENTS.md", "# Agents\n\nORACLE-MARKER-A1\n");
  write("packages/api/CLAUDE.md", "# API\n\nORACLE-MARKER-C2\n\nImport: @notes.md\n");
  write("packages/api/notes.md", "# Notes\n\nORACLE-MARKER-APIIMP\n");
  write("packages/api/src/server.ts", "export const server = 1;\n");
  write("packages/web/CLAUDE.md", "# Web\n\nORACLE-MARKER-WEB\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function probe(cwd: string): Set<string> {
  const out = execFileSync("claude", ["-p", PROMPT, "--output-format", "text"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  return new Set(out.match(/ORACLE-MARKER-[A-Z0-9]+/g) ?? []);
}

function resolverMarkers(root: string, filePath: string): Set<string> {
  const result = buildGraph({
    workspaceRoot: root,
    graphRoot: "",
    settings: SettingsSchema.parse({}),
    registry: new ParserRegistry(),
  });
  const markers = new Set<string>();
  const byPath: Record<string, string> = {
    "CLAUDE.md": "ORACLE-MARKER-C1",
    "shared/imported.md": "ORACLE-MARKER-IMP",
    "packages/api/CLAUDE.md": "ORACLE-MARKER-C2",
    "packages/api/notes.md": "ORACLE-MARKER-APIIMP",
    "packages/web/CLAUDE.md": "ORACLE-MARKER-WEB",
  };
  for (const group of resolveContext(filePath, result.scopeIndex)) {
    if (group.format !== "claude-md") continue;
    for (const match of group.matches) {
      const marker = byPath[match.sourcePath];
      if (marker) markers.add(marker);
    }
  }
  return markers;
}

const CASES: { cwd: string; subject: string; importCaveat: string[] }[] = [
  // importCaveat: resolver-claimed markers Claude Code verifiably does NOT
  // load from this cwd (imports of non-cwd-level CLAUDE.md files).
  { cwd: "", subject: "README.md", importCaveat: [] },
  { cwd: "packages/api", subject: "packages/api/notes.md", importCaveat: ["ORACLE-MARKER-IMP"] },
  {
    cwd: "packages/api/src",
    subject: "packages/api/src/server.ts",
    importCaveat: ["ORACLE-MARKER-IMP", "ORACLE-MARKER-APIIMP"],
  },
];

const root = makeOracleRepo();
let failures = 0;
try {
  for (const c of CASES) {
    const actual = probe(join(root, c.cwd));
    const claimed = resolverMarkers(root, c.subject);
    const expected = new Set([...claimed].filter((m) => !c.importCaveat.includes(m)));

    const missing = [...expected].filter((m) => !actual.has(m));
    const extra = [...actual].filter((m) => !claimed.has(m));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) failures++;
    console.log(`cwd=${c.cwd || "(root)"}  ${ok ? "OK" : "MISMATCH"}`);
    console.log(`  claude loaded : ${[...actual].sort().join(", ") || "(none)"}`);
    console.log(`  resolver claim: ${[...claimed].sort().join(", ")}`);
    if (c.importCaveat.length > 0) {
      console.log(
        `  known caveat  : imports not expanded for non-cwd files (${c.importCaveat.join(", ")})`,
      );
    }
    if (missing.length > 0) console.log(`  MISSING from claude: ${missing.join(", ")}`);
    if (extra.length > 0) console.log(`  EXTRA in claude    : ${extra.join(", ")}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(
  failures === 0
    ? "\noracle validation: PASS"
    : `\noracle validation: ${failures} case(s) mismatched`,
);
process.exit(failures === 0 ? 0 : 1);
