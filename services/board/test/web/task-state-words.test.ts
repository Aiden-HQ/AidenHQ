import { expect, it } from "vitest";
import type { ShownState } from "../../web/src/types.js";
import { stateWords } from "../../web/src/ui/TaskState.js";

const s = (o: Partial<ShownState>): ShownState => ({ task: "t", identifier: null, kind: "waiting", reason: "module_wait", since: "2026-11-20T10:00:00.000Z", holder: null, attention: [], ...o });

it("a module's wait reads in plain words, stalled when an agent must act, with the wait's own note", () => {
  expect(stateWords(s({ ref: "checks" })).detail).toBe("CI checks");
  expect(stateWords(s({ ref: "conflict", note: "rebase needed" })).detail).toBe("merge conflict · rebase needed");
  expect(stateWords(s({ ref: "design_review", attention: [{ who: "agent", why: "stalled_wait", ref: "design_review" }] })).detail).toBe("stalled · design review");
});
