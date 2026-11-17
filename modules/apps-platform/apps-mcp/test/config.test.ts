import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

describe("test configuration", () => {
  // Real git work in temp dirs waits on a shared disk: a CI host running a dozen jobs at once is slower than the
  // 5s default. A missing override turns those waits into false timeouts, so CI checks it here.
  it("allows file and git work 30s under load", () => {
    expect(config.test?.testTimeout).toBe(30_000);
  });
});
