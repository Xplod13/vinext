import { defineConfig } from "vite-plus";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "github-actions"] : ["default", "agent"],
    setupFiles: [join(import.meta.dirname, "./vitest-setup.ts")],
    env: { __VINEXT_DRAFT_SECRET: randomUUID() },

    alias: {
      "e2e-utils": join(import.meta.dirname, "./next-test-setup.js"),
      "next-test-utils": join(import.meta.dirname, "./next-test-utils.js"),
    },

    fileParallelism: false,
    testTimeout: 30_000,
    globals: true,
    dir: "clone",
  },
});
