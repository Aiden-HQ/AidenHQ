// A stale PR outside the agents org cost two days of dead work: the `fleet-check` bullet told the Steward to have an
// Engineer close it with `aidenhq close`, but that command reaches only the agents org, the repos on maintainer_repos and the
// product repo's Dependabot PRs (since widened to the whole product repo), so the close was refused and the same stale PR filed another close task the next pass. The lint keeps the caveat:
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
// A monitor task checked a condition and then ended its run in `backlog`, which dispatches nothing: the chain died, and
// nudges and a reopen only moved updatedAt. The fifth lint keeps the handbook's `## Monitors` section: its arming sentence,
// its `task_finish` exception and the sentence that supersedes a parking brief — written as what to do, not as a ban
// (`fleet-change`), which the lint holds too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const skills = new URL("../skills/", import.meta.url);
const fleetCheck = readFileSync(new URL("fleet-check/SKILL.md", skills), "utf8");
const stewardHandbook = readFileSync(new URL("../agents/fleet-steward/AGENTS.md", import.meta.url), "utf8");

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
      // (`aidenhq close` reaches only the agents org, the repos on maintainer_repos and the product repo).
      const scope = /outside the agents org/.test(section) || (/outside that scope/.test(section) && /reaches only the agents org/.test(section) && /maintainer_repos/.test(section) && /product repo/.test(section));
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

/** The `## Monitors` section's own body, whitespace collapsed, or "" when the handbook has none. */
function monitorsSection(text) {
  const start = text.indexOf("\n## Monitors\n");
  if (start === -1) return "";
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", "## Monitors".length);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
}

/**
 * A sentence that reads as an avoid-list or ban: the recorded decision is that a handbook rule says what to do (skill
 * `fleet-change`), and the rule's own meaning carries without the prohibition.
 */
const AVOID_LIST = /\b(?:Never|Do not|Don't|Avoid)\b/;

/**
 * A sentence that lets a monitor end in `backlog`: the failure the rule exists to prevent, in wording the required
 * phrases do not catch (they can all be present beside it).
 */
const PARK_PERMISSION = /\b(?:may|can|could|should|is (?:fine|ok|okay) to|okay to|ok to)\b[^.]{0,80}\b(?:stay|stays|remain|remains|end|ends|park|parks|leave|leaves)\b[^.]{0,40}\bbacklog\b/i;

/**
 * What the `## Monitors` section is missing or gets wrong: the section itself, the arming sentence (`task_wait` with
 * `until` at least 15 minutes and at most 7 days ahead, `on` only for a real event), the arming being the run's last act
 * instead of `task_finish`,
 * re-arming a run that a brief would park, the `Monitor:` title as the signal, the new fix task when the earlier one is
 * closed or, with no fix task named, stated in the run's comment, and no sentence in the form of a ban or that permits a park.
 */
function monitorProblems(text) {
  const section = monitorsSection(text);
  if (!section) return { missing: ["the `## Monitors` section"], bans: [], permits: [] };
  const missing = [];
  if (!/(?:ends by arming|re-?arms) its next check with `task_wait`/.test(section)) missing.push("the `task_wait` arming sentence");
  // Both ends of the window the kernel enforces: a floor of 15 minutes (`MIN_WAIT`) and a ceiling of 7 days (`MAX_WAIT`).
  const bounds = /`until`[^.]{0,80}\b15 minutes\b/.test(section) && /`until`[^.]{0,120}7 days ahead/.test(section) && /`on` only for a real event/.test(section);
  if (!bounds) missing.push("the `until`/`on` bounds");
  if (!/it parks the task and dispatches the next run/.test(section) || !/`task_finish` would settle the task/.test(section)) missing.push("the `task_finish` exception for monitor runs");
  if (!/this rule supersedes it/.test(section)) missing.push("the sentence that supersedes a parking brief");
  if (!/Every monitor's title starts `Monitor:`/.test(section) || !/secondary signal/.test(section)) missing.push("the `Monitor:` title as the signal, with the source marker secondary");
  if (!/files a new fix task and routes that/.test(section)) missing.push("the new fix task for a closed earlier one");
  // A monitor's first qualifying result with no fix task named: the rule states it and re-arms, filing no work of its own.
  if (!/A brief that names no fix task takes the qualifying result in the run's comment[^.]{0,200}its author's/.test(section)) missing.push("the first qualifying result when the brief names no fix task");
  const sentences = section.split(/(?<=[.:])\s+/);
  const bans = sentences.filter((sentence) => AVOID_LIST.test(sentence)).map((sentence) => sentence.slice(0, 80));
  const permits = sentences.filter((sentence) => PARK_PERMISSION.test(sentence)).map((sentence) => sentence.slice(0, 80));
  return { missing, bans, permits };
}

const monitorMessage = (file, { missing, bans, permits }) => [
  ...(missing.length ? [`${file}: the monitor rule is missing ${missing.join(" and ")}: state that every monitor run ends by arming its next check with \`task_wait\` (\`until\` at least 15 minutes and at most 7 days ahead, \`on\` only for a real event), that this wait is the run's last act because \`task_finish\` would settle the task, and that the rule supersedes a brief that parks the monitor`] : []),
  ...bans.map((sentence) => `${file}: the monitor rule is written as a ban: "${sentence}"; a handbook rule says what to do (skill \`fleet-change\`)`),
  ...permits.map((sentence) => `${file}: the monitor rule permits the parking it exists to prevent: "${sentence}"; a monitor's run ends by arming its next check`),
];

const nudgeMessage = (file, p) => `${file}: the section "${p.section}" nudges an open task's agent without ${p.missing.join(" and ")}: state that work reaches an Engineer only through a status write on its own task (task_route), and that a second task is never filed for the same PR because the branch exists only in the task that pushed it`;

const message = (file, p) => `${file}: the section "${p.section}" names \`aidenhq close\` without ${p.missing.join(" and ")}: state that aidenhq close reaches only the agents org, the repos listed in maintainer_repos and the product repo, and that an outside-scope PR goes to the Maintainer (no close task for an Engineer; one \`outside-close-scope\` log line)`;

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
  for (const added of ["reaches only the agents org", "maintainer_repos", "outside that scope", "goes to the Maintainer", "file no close task", "outside-close-scope"]) {
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

test("the Steward handbook's monitor rule arms the next check and re-arms instead of parking", () => {
  const problems = monitorProblems(stewardHandbook);
  assert.deepEqual(problems, { missing: [], bans: [], permits: [] });
  assert.deepEqual(monitorMessage("agents/fleet-steward/AGENTS.md", problems), []);
});

test("the monitor lint bites: the handbook without the section fails, and a heading alone is not enough", () => {
  const old = stewardHandbook.replace(/\n## Monitors\n[\s\S]*?(?=\n## Done\n)/, "");
  const problems = monitorProblems(old);
  assert.deepEqual(problems.missing, ["the `## Monitors` section"]);
  assert.match(monitorMessage("old", problems)[0], /the monitor rule is missing the `## Monitors` section/);
  // A heading with prose that neither arms nor names the exception is missing every sentence, in one message.
  const headingOnly = old.replace("\n## Done\n", "\n## Monitors\n\nA monitor checks a condition and comes back.\n\n## Done\n");
  const bare = monitorProblems(headingOnly);
  assert.deepEqual(bare.missing, ["the `task_wait` arming sentence", "the `until`/`on` bounds", "the `task_finish` exception for monitor runs", "the sentence that supersedes a parking brief", "the `Monitor:` title as the signal, with the source marker secondary", "the new fix task for a closed earlier one", "the first qualifying result when the brief names no fix task"]);
  assert.equal(monitorMessage("x", bare).length, 1, "the missing items are one message, not one per item");
  // The real section passes.
  assert.deepEqual(monitorProblems(stewardHandbook).missing, []);
});

test("the monitor lint bites: the arming sentence without the 15-minute floor fails, and the floor passes", () => {
  const ceilingOnly = stewardHandbook.replace(
    "`until` between 15 minutes and 7 days ahead",
    "`until` at most 7 days ahead",
  );
  assert.notEqual(ceilingOnly, stewardHandbook, "the floor was swapped back");
  const problems = monitorProblems(ceilingOnly);
  assert.deepEqual(problems.missing, ["the `until`/`on` bounds"], "the rest of the section is intact");
  assert.match(monitorMessage("x", problems)[0], /`until` at least 15 minutes and at most 7 days ahead/);
  // The floor alone, without the ceiling, is not the bound either: the kernel refuses a wait past 7 days.
  const floorOnly = stewardHandbook.replace(
    "`until` between 15 minutes and 7 days ahead",
    "`until` at least 15 minutes ahead",
  );
  assert.equal(monitorProblems(floorOnly).missing.length, 1);
});

test("the monitor lint bites: a rule without the first-issue case fails, and naming it passes", () => {
  const noFirst = stewardHandbook.replace(
    "A brief that names no fix task takes the qualifying result in the run's comment — the condition,\nthe measurement and what would fix it — since filing the fix is its author's. ",
    "",
  );
  assert.notEqual(noFirst, stewardHandbook, "the first-issue sentence was removed");
  const problems = monitorProblems(noFirst);
  assert.deepEqual(problems.missing, ["the first qualifying result when the brief names no fix task"], "everything else is intact");
  assert.match(monitorMessage("x", problems)[0], /first qualifying result/);
});

test("the monitor lint bites: a section written as a ban fails, and the positive wording passes", () => {
  const banned = stewardHandbook.replace(
    "When a brief line has the monitor leave itself in `backlog` at the end of a run, this rule",
    "Never end a monitor's run in `backlog` without an armed wait. When a brief line has the monitor leave itself in `backlog` at the end of a run, this rule",
  );
  const problems = monitorProblems(banned);
  assert.deepEqual(problems.missing, [], "the required sentences are all still there");
  assert.deepEqual(problems.bans, ["Never end a monitor's run in `backlog` without an armed wait."]);
  assert.match(monitorMessage("x", problems)[0], /written as a ban/);
});

test("the monitor lint bites: prose that keeps every phrase but permits a park fails", () => {
  const permissive = stewardHandbook.replace(
    "Then it re-arms.",
    "Then it re-arms. When nothing is due, a monitor may leave itself in backlog until the next pass.",
  );
  const problems = monitorProblems(permissive);
  assert.deepEqual(problems.missing, [], "the required sentences are all still there");
  assert.deepEqual(problems.bans, [], "and it is not worded as a ban");
  assert.deepEqual(problems.permits, ["When nothing is due, a monitor may leave itself in backlog until the next pass."]);
  assert.match(monitorMessage("x", problems)[0], /permits the parking it exists to prevent/);
});
