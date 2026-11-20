import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Registry tests run real git commands in temp dirs. On a CI host running a dozen jobs at once that work can take
    // longer than vitest's 5s default (registry.test timed out at 5s on 2026-11-14). A hang still fails, just later.
    testTimeout: 30_000,
    // The warehouse's point as compile writes it for the shipped source modules (scripts/test/points.test.ts keeps it equal).
    env: { WAREHOUSE_POINTS_FILE: "test/fixtures/warehouse-points.json" },
  },
});
