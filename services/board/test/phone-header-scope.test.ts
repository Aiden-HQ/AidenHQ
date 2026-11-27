import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "bun:test";

// The phone header rules in web/src/styles.css (no wrap, tighter padding, the identifier hidden under 380) are the task
// drawer's: the run page's own .drawer-head labels the run with its ident (agent · engine · status), so a rule that
// matches .app.mobile .drawer-head unscoped would take that label away.
it("scopes the phone header rules to the task drawer, not a run's", () => {
  const css = readFileSync(join(import.meta.dirname, "../web/src/styles.css"), "utf8");
  const rules = css.match(/^[^{}\n]*\.app\.mobile[^{}\n]*drawer-head[^{}\n]*\{/gm) ?? [];
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.filter((r) => !r.includes(".task-drawer"))).toEqual([]);
});
