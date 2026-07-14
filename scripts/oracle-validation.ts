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
 *  - ancestor CLAUDE.md files concatenate root→leaf          → resolver ✓
 *  - descendant CLAUDE.md files lazy-load (absent at start)  → resolver ✓
 *  - AGENTS.md is not read natively                          → resolver ✓
 *  - @AGENTS.md interop import loads AGENTS.md content       → resolver ✓
 *  - @imports expand ONLY in the CLAUDE.md located exactly at the session
 *    cwd (not even the cwd-nearest file) → resolver reports expansions as
 *    `conditional` with the required directory in the reason.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/builder";
import { ParserRegistry } from "../src/parsers/registry";
import { resolveContext } from "../src/scope/resolve";
import { SettingsSchema } from "../src/settings/schema";

const PROMPT =
  "List every string of the form ORACLE-MARKER-<something> that appears anywhere in your " +
  "system context or project instructions. Reply with ONLY the marker strings, comma-separated, nothing else.";

const MARKER_BY_PATH: Record<string, string> = {
  "CLAUDE.md": "ORACLE-MARKER-C1",
  "shared/imported.md": "ORACLE-MARKER-IMP",
  "AGENTS.md": "ORACLE-MARKER-A1",
  "packages/api/CLAUDE.md": "ORACLE-MARKER-C2",
  "packages/api/notes.md": "ORACLE-MARKER-APIIMP",
  "packages/web/CLAUDE.md": "ORACLE-MARKER-WEB",
};

function makeOracleRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cl-oracle-"));
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write(
    "CLAUDE.md",
    "# Root\n\nORACLE-MARKER-C1\n\nImport: @shared/imported.md\n\nInterop: @AGENTS.md\n",
  );
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

const CASES = [
  { cwd: "", subject: "README.md" },
  { cwd: "packages/api", subject: "packages/api/notes.md" },
  { cwd: "packages/api/src", subject: "packages/api/src/server.ts" },
];

function parentDir(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

const root = makeOracleRepo();
let failures = 0;
try {
  const graph = buildGraph({
    workspaceRoot: root,
    graphRoot: "",
    settings: SettingsSchema.parse({}),
    registry: new ParserRegistry(),
  });

  for (const c of CASES) {
    // Expected per the resolver + the oracle-verified cwd rule: ancestor
    // files always load; an @import expansion loads iff its importing file
    // sits exactly at the session cwd.
    const matches = resolveContext(c.subject, graph.scopeIndex)
      .filter((g) => g.format === "claude-md")
      .flatMap((g) => g.matches);
    const expected = new Set<string>();
    for (const m of matches) {
      const marker = MARKER_BY_PATH[m.sourcePath];
      if (!marker) continue;
      if (!m.via) expected.add(marker);
      else if (parentDir(m.via.importedFrom) === c.cwd) expected.add(marker);
    }

    const actual = probe(join(root, c.cwd));
    const missing = [...expected].filter((m) => !actual.has(m));
    const extra = [...actual].filter((m) => !expected.has(m));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) failures++;
    console.log(`cwd=${c.cwd || "(root)"}  ${ok ? "OK" : "MISMATCH"}`);
    console.log(`  claude loaded : ${[...actual].sort().join(", ") || "(none)"}`);
    console.log(`  expected      : ${[...expected].sort().join(", ")}`);
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
