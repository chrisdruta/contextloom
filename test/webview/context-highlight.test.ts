// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { NullRenderer } from "../../webview-ui/src/renderer";

describe("GraphRenderer.setLayout seam", () => {
  it("NullRenderer records the layout for assertions", () => {
    const renderer = new NullRenderer();
    expect(renderer.lastLayout).toBe("fcose");
    renderer.setLayout("hierarchy");
    expect(renderer.lastLayout).toBe("hierarchy");
  });
});

describe("GraphRenderer.setContextHighlight seam", () => {
  it("NullRenderer records the last highlight for assertions", () => {
    const renderer = new NullRenderer();
    renderer.mount(document.createElement("div"));
    expect(renderer.lastContextHighlight).toBeNull();

    renderer.setContextHighlight({
      subjectId: "file:src/a.ts",
      sourceIds: ["file:AGENTS.md", "file:.claude/rules/style.md"],
    });
    expect(renderer.lastContextHighlight).toEqual({
      subjectId: "file:src/a.ts",
      sourceIds: ["file:AGENTS.md", "file:.claude/rules/style.md"],
    });

    renderer.setContextHighlight(null);
    expect(renderer.lastContextHighlight).toBeNull();
  });
});
