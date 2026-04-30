import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
      exclude: [
        "tests/**",
        "src/index.ts",
        "dist/**",
        "**/*.d.ts",
        "node_modules/**",
        "**/*.config.*",
        "vitest.config.ts",
      ],
    },
  },
});
