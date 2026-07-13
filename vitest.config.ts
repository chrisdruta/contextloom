import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  resolve: {
    alias: {
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-runtime",
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "test/fixtures", "test/integration"],
    // webview component tests opt into jsdom via // @vitest-environment jsdom
    environment: "node",
    globals: false,
  },
});
