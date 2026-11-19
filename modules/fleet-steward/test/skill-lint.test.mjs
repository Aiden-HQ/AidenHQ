// A stale PR outside the agents org cost two days of dead work: the `fleet-check` bullet told the Steward to have an
// Engineer close it with `aidenhq close`, but that command reaches only the agents org and the product repo's Dependabot
// PRs, so the close was refused and the same stale PR filed another close task the next pass. The lint keeps the caveat:
// a fleet skill section that names `aidenhq close` must also state its scope and the owner path, in that same section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const skills = new URL("../skills/", import.meta.url);
const fleetCheck = readFileSync(new URL("fleet-check/SKILL.md", skills), "utf8");

/** A skill split into sections: a top-level bullet or a heading starts one; its continuation lines belong to it. */
function sections(text) {
  const out = [];
  let current = [];
  for (const line of text.split("\n")) {
    if ((/^- |^#{1,6} /.test(line)) && current.length) { out.push(current.join("\n")); current = []; }
    current.push(line);
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

/** Every section that names `aidenhq close` without the close scope and the owner path, with what it is missing. */
function closeScopeProblems(text) {
  return sections(text)
    .filter((section) => section.includes("aidenhq close"))
    .flatMap((section) => {
      const first = section.split("\n").find((line) => line.trim())?.replace(/^\W+\s*/, "").slice(0, 60) ?? "section";
      // "outside the agents org" is the rule; "outside that scope" only reads once the same section names that scope
      // (`aidenhq close` reaches only the agents org and the product repo's Dependabot PRs).
      const scope = /outside the agents org/.test(section) || (/outside that scope/.test(section) && /reaches only the agents org/.test(section) && /Dependabot PRs/.test(section));
      const missing = [];
      if (!scope) missing.push("the close scope (`outside the agents org`)");
      if (!/is the owner's/.test(section)) missing.push("the owner path (`is the owner's`)");
      return missing.length ? [{ section: first, missing }] : [];
    });
}

const message = (file, p) => `${file}: the section "${p.section}" names \`aidenhq close\` without ${p.missing.join(" and ")}: state that aidenhq close reaches only the agents org (aidenhq-alpha) and the product repo's Dependabot PRs, and that an outside-scope PR is the owner's (no close task; the digest and one \`outside-close-scope\` log line)`;

test("a fleet skill section naming `aidenhq close` must state its scope and the owner path", () => {
  const problems = closeScopeProblems(fleetCheck).map((p) => message("fleet-check/SKILL.md", p));
  assert.deepEqual(problems, []);
});

test("the lint bites: the old bullet, with no scope sentence, fails with the fix", () => {
  const old = "- **A stale PR** (`pr:<repo>#<n>`): find the task that opened it (`task_search`). If that task is still open, nudge its\n  agent once: merge it if the checks are green, fix it if red, or close it as superseded (its Engineer closes it with\n  `aidenhq close <PR link> --reason \"<one line>\"`). If the task is done, `task_create` to the app's owner (else the\n  Engineer): \"merge, fix or close <PR> with one line why\". Log `pr · <repo>#<n>`; never the same nudge twice.\n";
  const problems = closeScopeProblems(old);
  assert.equal(problems.length, 1);
  assert.match(problems[0].missing.join(), /outside the agents org/);
  assert.match(message("old", problems[0]), /state that aidenhq close reaches only the agents org/);
  // A scope sentence alone is not enough: the owner path has to be there too.
  assert.equal(closeScopeProblems(old.replace("Log `pr", "`aidenhq close` reaches only the agents org. Log `pr")).length, 1);
  // "outside that scope" only reads with the scope named: on its own it is still a missing caveat.
  assert.equal(closeScopeProblems(old.replace("Log `pr", "a PR outside that scope is the owner's. Log `pr")).length, 1);
});

test("the merged bullet keeps the actions it had and the outside-scope line", () => {
  const found = sections(fleetCheck).find((s) => s.includes("A stale PR"));
  assert.ok(found, "the stale-PR bullet is present");
  const bullet = found.replace(/\s+/g, " ");
  for (const kept of ["merge it if the checks are green", "fix it if red", "close it as superseded", "Never the same nudge twice"]) {
    assert.ok(bullet.includes(kept), `still says "${kept}"`);
  }
  for (const added of ["reaches only the agents org", "Dependabot PRs", "outside that scope", "is the owner's", "file no close task", "outside-close-scope"]) {
    assert.ok(bullet.includes(added), `states "${added}"`);
  }
});

test("the lint runs over every fleet skill, not only this one", () => {
  const problems = readdirSync(skills, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => closeScopeProblems(readFileSync(new URL(`${d.name}/SKILL.md`, skills), "utf8")).map((p) => message(`${d.name}/SKILL.md`, p)));
  assert.deepEqual(problems, []);
});
