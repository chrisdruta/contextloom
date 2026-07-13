// @vitest-environment jsdom
import { render } from "preact";
import { describe, expect, it } from "vitest";
import type { ContextDetails } from "../../webview-ui/src/protocol";

// inspector.tsx calls getVsCodeApi() at module load; in jsdom the dev
// fallback (console-logging postMessage) is used automatically.
import { AgentContextTab, InspectorTabs } from "../../webview-ui/src/inspector";

function mount(ui: preact.ComponentChild): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(ui, host);
  return host;
}

const context: ContextDetails = {
  subject: { filePath: "packages/api/src/server.ts", nodeId: undefined },
  groups: [
    {
      format: "agents-md",
      matches: [
        {
          source: "file:packages/api/AGENTS.md",
          sourcePath: "packages/api/AGENTS.md",
          sourceLabel: "AGENTS.md",
          format: "agents-md",
          mechanism: "ancestry",
          status: "active",
          rank: 1,
          reason: "nearest AGENTS.md (1 level up)",
          confidence: 1,
        },
        {
          source: "file:AGENTS.md",
          sourcePath: "AGENTS.md",
          sourceLabel: "AGENTS.md",
          format: "agents-md",
          mechanism: "ancestry",
          status: "shadowed",
          rank: 2,
          reason: "overridden by packages/api/AGENTS.md",
          confidence: 1,
        },
      ],
    },
    {
      format: "cursor",
      note: "All apply — Cursor does not document a reading order.",
      matches: [
        {
          source: "file:.cursor/rules/ts.mdc",
          sourcePath: ".cursor/rules/ts.mdc",
          format: "cursor",
          mechanism: "glob",
          status: "conditional",
          rank: 1,
          reason: "description-only rule",
          confidence: 0.8,
        },
      ],
    },
  ],
};

describe("AgentContextTab", () => {
  it("renders per-format tables with status badges in rank order", () => {
    const host = mount(<AgentContextTab context={context} loading={false} />);
    const headings = [...host.querySelectorAll("h4")].map((h) => h.textContent);
    expect(headings).toEqual(["AGENTS.md", "Cursor rules"]);

    const badges = [...host.querySelectorAll(".ctx-table .badge")].map((b) => b.textContent);
    expect(badges).toEqual(["active", "shadowed", "conditional"]);

    const firstRow = host.querySelector("tbody tr")!;
    expect(firstRow.textContent).toContain("nearest AGENTS.md (1 level up)");
  });

  it("renders the group note and sub-1 confidence", () => {
    const host = mount(<AgentContextTab context={context} loading={false} />);
    expect(host.textContent).toContain("Cursor does not document a reading order");
    expect(host.textContent).toContain("confidence 0.8");
  });

  it("jump-to-source is a real button per row", () => {
    const host = mount(<AgentContextTab context={context} loading={false} />);
    const buttons = host.querySelectorAll("tbody button.linkish");
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.textContent).toBe("AGENTS.md");
  });

  it("shows the subject path heading", () => {
    const host = mount(<AgentContextTab context={context} loading={false} />);
    expect(host.querySelector(".subject")!.textContent).toContain("packages/api/src/server.ts");
  });

  it("renders empty and loading states", () => {
    const empty = mount(
      <AgentContextTab context={{ subject: { filePath: "a.ts" }, groups: [] }} loading={false} />,
    );
    expect(empty.textContent).toContain("No agent instructions apply");

    const loading = mount(<AgentContextTab context={null} loading={true} />);
    expect(loading.textContent).toContain("Resolving context…");
  });
});

describe("InspectorTabs", () => {
  it("marks the active tab and exposes tablist semantics", () => {
    const host = mount(<InspectorTabs active="context" onSelect={() => {}} />);
    const tablist = host.querySelector('[role="tablist"]')!;
    expect(tablist).toBeTruthy();
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0"]);
  });

  it("ArrowRight moves selection", () => {
    let selected = "";
    const host = mount(
      <InspectorTabs
        active="details"
        onSelect={(t) => {
          selected = t;
        }}
      />,
    );
    const first = host.querySelector('[role="tab"]') as HTMLButtonElement;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(selected).toBe("context");
  });
});
