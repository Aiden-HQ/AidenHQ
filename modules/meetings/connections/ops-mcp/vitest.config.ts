import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // These tests write real transcript, vault and SQLite files. On a CI host running a dozen jobs at once their
    // fsyncs can take longer than vitest's 5s default (organize, pipeline and safety timed out at 9.0-9.7s on
    // 2026-11-14). A hang still fails, just later.
    testTimeout: 30_000,
  },
});
