import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/discovery/discover";
import { defaultSettings } from "./helpers";

describe("secure discovery", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects graph roots that escape the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cl-discovery-"));
    dirs.push(workspace);
    const result = discoverFiles({
      workspaceRoot: workspace,
      graphRoot: "../../",
      settings: defaultSettings(),
    });
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toContainEqual({ path: "../../", reason: "outside-workspace" });
  });

  it("does not follow symlinks outside the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "cl-discovery-"));
    dirs.push(parent);
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "# Secret");
    symlinkSync(outside, join(workspace, "linked"), "dir");

    const result = discoverFiles({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings({ followSymlinks: true }),
    });
    expect(result.files).toHaveLength(0);
    expect(result.skipped.some((entry) => entry.reason === "symlink-outside-workspace")).toBe(true);
  });

  it("breaks symlink directory cycles", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cl-discovery-"));
    dirs.push(workspace);
    mkdirSync(join(workspace, "docs"));
    writeFileSync(join(workspace, "docs", "a.md"), "# A");
    symlinkSync(workspace, join(workspace, "docs", "loop"), "dir");

    const result = discoverFiles({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings({ followSymlinks: true }),
    });
    expect(result.files.map((file) => file.path)).toEqual(["docs/a.md"]);
  });

  it("ignores oversized gitignore files instead of loading them", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cl-discovery-"));
    dirs.push(workspace);
    writeFileSync(join(workspace, ".gitignore"), `*.md\n${"#".repeat(1024 * 1024)}`);
    writeFileSync(join(workspace, "a.md"), "# A");

    const result = discoverFiles({
      workspaceRoot: workspace,
      graphRoot: "",
      settings: defaultSettings(),
    });
    expect(result.files.map((file) => file.path)).toEqual(["a.md"]);
  });
});
