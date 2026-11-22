// A stale PR outside the agents org cost two days of dead work: the `fleet-check` bullet told the Steward to have an
// Engineer close it with `aidenhq close`, but that command reaches only the agents org, the repos on maintainer_repos and the
// product repo's Dependabot PRs, so the close was refused and the same stale PR filed another close task the next pass. The lint keeps the caveat:
// a fleet skill section that names `aidenhq close` must also state its scope and where an outside-scope PR goes (the
// Maintainer, never the owner), in that same section.
// The stale-PR nudge had the same shape: "nudge its agent" had no reachable form, a comment does not dispatch an Engineer,
// and the Steward's status write on another agent's task was refused, so the nudge turned into a second task for the same
// PR — whose branch exists only in the workspace of the task that pushed it. Two runs died on that (a default-branch
// clone cannot fetch the branch). The Steward now makes that status write itself (task_route, role fleet-settle); the second
// lint keeps the reachable path in the section that nudge lives in.
// The Maintainer's `github_product_issue` card reads the delegating task's text as the request chain and refuses a write it
// does not ask for: the product-bug step told the Steward to create the task with the evidence but never to ask for the
// issue to be filed, so every report was refused and the bug went unfiled (or cost a second task whose own brief was
// the report). The third lint keeps the explicit filing ask in that step.
// The brief's own text becomes the card's request, so a literal host, uuid or task id in it is a detail the reviewer
// demands while `github_product_issue` refuses it: the filing loops. The fourth lint keeps the brief-neutrality rule
// beside "The issue is public", covering the title and evidence fields too, so both the brief and the issue stay neutral.
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
      // (`aidenhq close` reaches only the agents org, the repos on maintainer_repos and the product repo's Dependabot PRs).
      const scope = /outside the agents org/.test(section) || (/outside that scope/.test(section) && /reaches only the agents org/.test(section) && /maintainer_repos/.test(section) && /Dependabot PRs/.test(section));
      const missing = [];
      if (!scope) missing.push("the close scope (`outside the agents org`)");
      if (!/goes to the Maintainer/.test(section)) missing.push("the outside-scope path (`goes to the Maintainer`)");
      return missing.length ? [{ section: first, missing }] : [];
    });
}

/**
 * Every stale-PR section that tells the Steward to nudge an open task's agent without saying how the nudge reaches that
 * agent: a status write on its own task (the Steward's `task_route`) and never a second task for the same PR (whose branch
 * only that task's workspace has).
 */
function stalePrNudgeProblems(text) {
  return sections(text)
    .filter((section) => section.includes("A stale PR"))
    .flatMap((section) => {
      const flat = section.replace(/\s+/g, " ");
      if (!(/still open/i.test(flat) && /(nudge|status write)/i.test(flat))) return [];
      const missing = [];
      if (!(/status write/i.test(flat) && /task_route/.test(flat))) missing.push("the status-write sentence");
      if (!/never file a second task for the same PR/i.test(flat)) missing.push("the \"never file a second task for the same PR\" sentence");
      return missing.length ? [{ section: flat.slice(0, 60), missing }] : [];
    });
}

/** The filing ask the Maintainer task's description must open with: the card's reviewer reads it as the request chain. */
const FILING_ASK = /^>? ?File one GitHub issue on the product repository/m;

/** Every fleet skill whose product-bug step omits the explicit filing ask. */
function filingAskProblems(text) {
  return sections(text)
    .filter((section) => /A product bug/.test(section) && /task_create/.test(section) && /maintainer/.test(section))
    .filter((section) => !section.split("\n").some((line) => FILING_ASK.test(line)))
    .map((section) => section.split("\n").find((line) => line.trim())?.replace(/^\W+\s*/, "").slice(0, 60) ?? "section");
}

const filingAskMessage = (file, section) => `${file}: the product-bug step "${section}" must tell the Steward to open the Maintainer task with an explicit 'File one GitHub issue on the product repository' ask — the filing card is refused without it.`;

/**
 * Every product-bug step that hands the Maintainer a body to file must say that the body written into the brief, its
 * title and evidence fields, is already neutral: the card's reviewer reads the delegating task's text as the request, so a
 * literal host, uuid or task id there becomes a detail it demands and `github_product_issue` refuses it, and the filing
 * loops. The rule covers both the brief and the finished issue, so "The issue is public" stays.
 */
function briefNeutralityProblems(text) {
  return sections(text)
    .filter((section) => /A product bug/.test(section) && /task_create/.test(section) && /maintainer/.test(section))
    .flatMap((section) => {
      const first = section.split("\n").find((line) => line.trim())?.replace(/^\W+\s*/, "").slice(0, 60) ?? "section";
      const flat = section.replace(/\s+/g, " ");
      const missing = [];
      if (!/The issue is public/.test(flat)) missing.push("the \"The issue is public\" sentence");
      if (!/the body you put in the brief/i.test(flat)) missing.push("the brief-body sentence (`the body you put in the brief`)");
      // The title and evidence have to fall under that same rule, in the sentence that states it: the phrase elsewhere in
      // the step says nothing about them being neutral.
      if (!/body you put in the brief under that rule already[^:.]{0,80}title and evidence fields/i.test(flat)) missing.push("that the title and evidence fields fall under the same rule");
      if (!/holds the post to it/.test(flat)) missing.push("why a literal value loops (the reviewer holds the post to the brief's text)");
      if (!/filing loops/.test(flat)) missing.push("why a literal value loops (the filing loops)");
      if (!/by role/.test(flat) || !/leave a task's id out/i.test(flat)) missing.push("the general rule (name a thing by role, leave a task's id out)");
      return missing.length ? [{ section: first, missing }] : [];
    });
}

const briefNeutralityMessage = (file, p) => `${file}: the product-bug step "${p.section}" must say the body written into the brief, its title and evidence fields, is already neutral, beside the existing "The issue is public" sentence: the github_product_issue card reads the delegating task's text as the request, so a literal internal address, uuid or task id there becomes a detail it demands and refuses, and the filing loops — name a thing by role and leave a task's id out. Missing: ${p.missing.join("; ")}.`;

/**
 * Every memory-proposal step that asks for a `task_propose_rule` without naming the instance repository: the Engineer job
 * clones only the repositories its task names, so the proposal closes with the memory file untouched.
 */
function memoryProposalProblems(text) {
  return sections(text)
    .filter((section) => section.includes("task_propose_rule") && /memory:/.test(section))
    .filter((section) => !(/(agents org|instance repo|instance's)/i.test(section) && /aidenhq-instance/.test(section)))
    .map((section) => section.split("\n").find((line) => line.trim())?.replace(/^\W+\s*/, "").slice(0, 60) ?? "section");
}

const memoryProposalMessage = (file, section) => `${file}: the memory-proposal step "${section}" must name the instance repository (\`<agents org>/aidenhq-instance\`): a job clones only the repositories its task names, so the proposal closes with the memory file unchanged.`;

const nudgeMessage = (file, p) => `${file}: the section "${p.section}" nudges an open task's agent without ${p.missing.join(" and ")}: state that work reaches an Engineer only through a status write on its own task (task_route), and that a second task is never filed for the same PR because the branch exists only in the task that pushed it`;

const message = (file, p) => `${file}: the section "${p.section}" names \`aidenhq close\` without ${p.missing.join(" and ")}: state that aidenhq close reaches only the agents org, the repos listed in maintainer_repos and the product repo's Dependabot PRs, and that an outside-scope PR goes to the Maintainer (no close task for an Engineer; one \`outside-close-scope\` log line)`;

test("a fleet skill section naming `aidenhq close` must state its scope and the outside-scope path", () => {
  const problems = closeScopeProblems(fleetCheck).map((p) => message("fleet-check/SKILL.md", p));
  assert.deepEqual(problems, []);
});

test("the lint bites: the old bullet, with no scope sentence, fails with the fix", () => {
  const old = "- **A stale PR** (`pr:<repo>#<n>`): find the task that opened it (`task_search`). If that task is still open, nudge its\n  agent once: merge it if the checks are green, fix it if red, or close it as superseded (its Engineer closes it with\n  `aidenhq close <PR link> --reason \"<one line>\"`). If the task is done, `task_create` to the app's owner (else the\n  Engineer): \"merge, fix or close <PR> with one line why\". Log `pr · <repo>#<n>`; never the same nudge twice.\n";
  const problems = closeScopeProblems(old);
  assert.equal(problems.length, 1);
  assert.match(problems[0].missing.join(), /outside the agents org/);
  assert.match(message("old", problems[0]), /state that aidenhq close reaches only the agents org/);
  // A scope sentence alone is not enough: the outside-scope path has to be there too.
  assert.equal(closeScopeProblems(old.replace("Log `pr", "`aidenhq close` reaches only the agents org. Log `pr")).length, 1);
  // "outside that scope" only reads with the scope named: on its own it is still a missing caveat.
  assert.equal(closeScopeProblems(old.replace("Log `pr", "a PR outside that scope goes to the Maintainer. Log `pr")).length, 1);
});

test("the merged bullet keeps the actions it had and the outside-scope line", () => {
  const found = sections(fleetCheck).find((s) => s.includes("A stale PR"));
  assert.ok(found, "the stale-PR bullet is present");
  const bullet = found.replace(/\s+/g, " ");
  for (const kept of ["one line with what to do (merge, fix the named check, or close)", "Never the same nudge twice", "task_route"]) {
    assert.ok(bullet.includes(kept), `still says "${kept}"`);
  }
  for (const added of ["reaches only the agents org", "maintainer_repos", "Dependabot PRs", "outside that scope", "goes to the Maintainer", "file no close task", "outside-close-scope"]) {
    assert.ok(bullet.includes(added), `states "${added}"`);
  }
});

test("the lint runs over every fleet skill, not only this one", () => {
  const problems = readdirSync(skills, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => closeScopeProblems(readFileSync(new URL(`${d.name}/SKILL.md`, skills), "utf8")).map((p) => message(`${d.name}/SKILL.md`, p)));
  assert.deepEqual(problems, []);
});

test("a fleet skill section that nudges an open stale-PR task must state the reachable path", () => {
  const problems = stalePrNudgeProblems(fleetCheck).map((p) => nudgeMessage("fleet-check/SKILL.md", p));
  assert.deepEqual(problems, []);
});

test("the lint bites: the old nudge, with no reachable path, fails with the fix; the replacement passes", () => {
  const old = "- **A stale PR** (`pr:<repo>#<n>`): find the task that opened it (`task_search`). If that task is still open, nudge its\n  agent once: merge it if the checks are green, fix it if red, or close it as superseded (its Engineer closes it with\n  `aidenhq close <PR link> --reason \"<one line>\"`). If the task is done, `task_create` to the app's owner (else the\n  Engineer): \"merge, fix or close <PR> with one line why\". `aidenhq close` reaches only the agents org, the repos on `maintainer_repos`\n  and the product repo's Dependabot PRs: a PR outside that scope is the owner's. Log `pr · <repo>#<n>`; never the same nudge twice.\n";
  const problems = stalePrNudgeProblems(old);
  assert.equal(problems.length, 1);
  assert.match(problems[0].missing.join(), /status-write sentence/);
  assert.match(problems[0].missing.join(), /never file a second task for the same PR/);
  assert.match(nudgeMessage("old", problems[0]), /a second task is never filed for the same PR/);
  const withStatusWriteOnly = old.replace("If that task is still open", "Work reaches an Engineer only through a status write on its own task: `task_route` it. If that task is still open");
  assert.equal(stalePrNudgeProblems(withStatusWriteOnly).length, 1, "the status-write sentence alone is not enough");
  const replacement = "- **A stale PR** (`pr:<repo>#<n>`): find the task that opened it (`task_search`). Work reaches an Engineer only through a\n  status write on its own task, so never file a second task for the same PR. If that task is still open, make the status\n  write yourself: `task_route` *that* task with what to do.\n";
  assert.deepEqual(stalePrNudgeProblems(replacement), []);
  // A section that does not nudge an open task is out of scope.
  assert.deepEqual(stalePrNudgeProblems("- **A stale PR**: if the task is done, `task_create` to the app's owner.\n"), []);
});

test("a fleet skill's product-bug step must ask for the issue to be filed", () => {
  const problems = filingAskProblems(fleetCheck).map((s) => filingAskMessage("fleet-check/SKILL.md", s));
  assert.deepEqual(problems, []);
});

test("a fleet skill's product-bug step must say the brief body is already neutral", () => {
  const problems = briefNeutralityProblems(fleetCheck).map((p) => briefNeutralityMessage("fleet-check/SKILL.md", p));
  assert.deepEqual(problems, []);
});

test("a fleet skill's memory-proposal step must name the instance repository", () => {
  const daily = readFileSync(new URL("knowledge-daily/SKILL.md", skills), "utf8");
  const problems = memoryProposalProblems(daily).map((s) => memoryProposalMessage("knowledge-daily/SKILL.md", s));
  assert.deepEqual(problems, []);
});

test("the memory-repository lint bites: the old bullet fails with the fix", () => {
  const old = "- The new memory is one fact per line, each ending `(source, date)`, at most 4 KB (4096 bytes). Propose it with one\n  `task_propose_rule` per agent (marker `memory:<agent key>:<date>`, title \"Memory update: <agent>\"), the description\n  holding the agent key and the exact full new text of `agents/<key>/memory.md`, fact lines only (compile adds the\n  heading). Nothing changed, no proposal.\n";
  const problems = memoryProposalProblems(old);
  assert.equal(problems.length, 1);
  assert.match(memoryProposalMessage("old", problems[0]), /must name the instance repository/);
  const replacement = old.replace("holding the agent key", "holding the agent key, the target repository `<agents org>/aidenhq-instance`");
  assert.deepEqual(memoryProposalProblems(replacement), []);
});

test("the filing-ask lint bites: the step without the ask fails with the fix", () => {
  const old = "- **A product bug**: the Maintainer reports it as one GitHub issue.\n  1. Its fingerprint is `product-bug:<slug>`.\n  2. `task_create` with `assignee: maintainer`, marker `product-bug:<slug>`, and a description holding the fingerprint, what happened and the evidence.\n  3. Log it.\n";
  const problems = filingAskProblems(old);
  assert.equal(problems.length, 1);
  assert.match(filingAskMessage("old", problems[0]), /must tell the Steward to open the Maintainer task with an explicit 'File one GitHub issue on the product repository' ask — the filing card is refused without it/);
  const replacement = old.replace("  3. Log it.", "> File one GitHub issue on the product repository `Aiden-HQ/AidenHQ`: nothing else is asked for.\n  3. Log it.");
  assert.deepEqual(filingAskProblems(replacement), []);
  // An ask for some other repository or action does not count.
  assert.equal(filingAskProblems(old.replace("  3. Log it.", "File one GitHub issue elsewhere.\n  3. Log it.")).length, 1);
  // A step that does not hand a product bug to the Maintainer is out of scope.
  assert.deepEqual(filingAskProblems("- **A product bug**: routed to the owner, no task.\n"), []);
  // Every fleet skill with a product-bug step is checked, not only this one.
  const every = readdirSync(skills, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => filingAskProblems(readFileSync(new URL(`${d.name}/SKILL.md`, skills), "utf8")).map((s) => filingAskMessage(`${d.name}/SKILL.md`, s)));
  assert.deepEqual(every, []);
});

test("the brief-neutrality lint bites: a step with only the issue sentence fails, and the replacement passes", () => {
  const old = "- **A product bug**: `task_create` with `assignee: maintainer` and the evidence.\n> File one GitHub issue on the product repository `Aiden-HQ/AidenHQ`: nothing else is asked for.\n  The issue is public: a host or uuid becomes a neutral word (`<host>`).\n";
  const problems = briefNeutralityProblems(old);
  assert.equal(problems.length, 1);
  assert.match(problems[0].missing.join(), /the body you put in the brief/);
  assert.match(problems[0].missing.join(), /why a literal value loops/);
  assert.match(briefNeutralityMessage("old", problems[0]), /must say the body written into the brief, its title and evidence fields, is already neutral/);
  const replacement = old.replace(
    "  The issue is public: a host or uuid becomes a neutral word (`<host>`).\n",
    "  The issue is public: a host or uuid becomes a neutral word (`<host>`). Write the body you put in the brief under\n  that rule already, its title and evidence fields too: the card's reviewer reads the delegating task's text as the\n  request and holds the post to it, so a literal address there becomes a detail it demands and `github_product_issue`\n  refuses, and the filing loops — name a listener by role and leave a task's id out.\n",
  );
  assert.deepEqual(briefNeutralityProblems(replacement), []);
  // Dropping the title and evidence clause must fail: the reviewer checks those fields, not only the body.
  const bodyOnly = replacement.replace(", its title and evidence fields too", "");
  assert.equal(briefNeutralityProblems(bodyOnly).length, 1);
  assert.match(briefNeutralityProblems(bodyOnly)[0].missing.join(), /that the title and evidence fields fall under the same rule/);
  // Saying it as a separate sentence, outside the redaction rule, does not count.
  const elsewhere = replacement.replace(", its title and evidence fields too", "") .replace(
    "leave a task's id out.",
    "leave a task's id out. Its title and evidence fields are neutral too.",
  );
  assert.equal(briefNeutralityProblems(elsewhere).length, 1);
  // The lint bites the wording this replaces: the old rule already says the card "refuses a write it does not ask for", so
  // a check for that word alone would pass on it. The live file with the new passage swapped back must fail.
  const asBefore = fleetCheck.replace(
    /body you put in the brief under that rule already[^]*?leave a task's id out\./,
    "body you put in the brief under that rule already: name a listener, container or service by role, and cite a task by its\n   identifier.",
  );
  assert.notEqual(asBefore, fleetCheck, "the original passage was swapped back");
  const asBeforeProblems = briefNeutralityProblems(asBefore);
  assert.equal(asBeforeProblems.length, 1);
  for (const missing of [/the reviewer holds the post to the brief's text/, /the filing loops/, /leave a task's id out/]) {
    assert.match(asBeforeProblems[0].missing.join(), missing);
  }
  // A step that does not hand a product bug to the Maintainer is out of scope.
  assert.deepEqual(briefNeutralityProblems("- **A product bug**: routed to the owner, no task.\n"), []);
  // Every fleet skill with a product-bug step is checked, not only this one.
  const every = readdirSync(skills, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => briefNeutralityProblems(readFileSync(new URL(`${d.name}/SKILL.md`, skills), "utf8")).map((p) => briefNeutralityMessage(`${d.name}/SKILL.md`, p)));
  assert.deepEqual(every, []);
});
