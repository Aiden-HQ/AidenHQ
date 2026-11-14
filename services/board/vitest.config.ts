import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Several tests write real SQLite files; on a CI host running a dozen jobs at once their fsyncs can take
    // longer than vitest's 5s default (costs.test timed out at 10s on 2026-11-14). A hang still fails, just later.
    testTimeout: 30_000,
  },
});
