import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "test/fixtures", "test/integration"],
    environment: "node",
    globals: false,
  },
});
