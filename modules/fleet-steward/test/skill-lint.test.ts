// Each lint keeps the system-specific tokens of a past incident, not whole sentences:
// - a stale PR outside the agents org: `aidenhq close` reaches only the agents org, `maintainer_repos` and the product repo, so
//   the section must say where an outside-scope PR goes (the Maintainer, `outside-close-scope`); and the stale-PR nudge is a
//   status write (`task_route`) on the task that pushed the branch, never a second task for the same PR.
// - the product-bug step: the Maintainer's `github_product_issue` card reads the delegating task's text as the request, so the
//   task must open with the filing ask and keep its title, body and evidence neutral (`<host>`, by role, no task ids).
// - the memory proposal must name the instance repository (a job clones only the repositories its task names).
// - the handbook's `## Monitors` rule: a monitor run ends by arming its next check with `task_wait`.
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

const everySkill = () => readdirSync(skills, { withFileTypes: true }).filter((d) => d.isDirectory())
  .map((d) => ({ file: `${d.name}/SKILL.md`, text: readFileSync(new URL(`${d.name}/SKILL.md`, skills), "utf8") }));

const missingTokens = (section, tokens) => tokens.filter((token) => !token.test(section)).map(String);

/** Sections naming `aidenhq close` need the close scope and the outside-scope path. */
function closeScopeProblems(text) {
  return sections(text).filter((s) => s.includes("aidenhq close")).flatMap((s) => {
    const missing = missingTokens(s, [/maintainer_repos/, /Maintainer/, /outside-close-scope/]);
    return missing.length ? [{ section: s.split("\n")[0].slice(0, 60), missing }] : [];
  });
}

/** The stale-PR section needs the status write (`task_route`) and no second task for the same PR. */
function stalePrProblems(text) {
  return sections(text).filter((s) => s.includes("A stale PR")).flatMap((s) => {
    const missing = missingTokens(s, [/status write/, /`task_route`/, /second task for the same PR/]);
    return missing.length ? [{ section: s.split("\n")[0].slice(0, 60), missing }] : [];
  });
}

/** The product-bug step: the filing ask, the card, and the neutrality tokens. */
function productBugProblems(text) {
  return sections(text).filter((s) => /^## Reporting a product bug/.test(s)).flatMap((s) => {
    const missing = missingTokens(s, [/^>? ?File one GitHub issue on the product repository/m, /github_product_issue/, /`<host>`/, /brief's body, title and evidence/, /by role/, /task ids/, /holds the post to the brief's text/]);
    return missing.length ? [{ section: s.split("\n")[0].slice(0, 60), missing }] : [];
  });
}

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

test("fleet-check: `aidenhq close` states its scope and the outside-scope path", () => {
  assert.deepEqual(closeScopeProblems(fleetCheck), []);
  assert.ok(sections(fleetCheck).some((s) => s.includes("aidenhq close")), "the close section is present");
  assert.equal(closeScopeProblems("- **A stale PR**: `aidenhq close <PR>` it.").length, 1, "the lint bites");
  for (const { file, text } of everySkill()) assert.deepEqual(closeScopeProblems(text), [], file);
});

test("fleet-check: the stale-PR nudge is a status write on the task that pushed the branch", () => {
  assert.deepEqual(stalePrProblems(fleetCheck), []);
  assert.equal(stalePrProblems("- **A stale PR**: nudge its agent.").length, 1, "the lint bites");
});

test("fleet-check: the product-bug step opens with the filing ask and keeps the brief neutral", () => {
  assert.ok(sections(fleetCheck).some((s) => /^## Reporting a product bug/.test(s)), "the product-bug section is present");
  assert.deepEqual(productBugProblems(fleetCheck), []);
  assert.equal(productBugProblems("## Reporting a product bug\n`task_create` with `assignee: maintainer` and evidence.").length, 1, "the lint bites");
});

test("knowledge-daily: the memory-proposal step names the instance repository", () => {
  const daily = readFileSync(new URL("knowledge-daily/SKILL.md", skills), "utf8");
  assert.deepEqual(memoryProposalProblems(daily), []);
  assert.equal(memoryProposalProblems("- Propose with `task_propose_rule`, marker `memory:<agent>:<date>`.").length, 1, "the lint bites");
});

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

const memoryProposalMessage = (file, section) => `${file}: the memory-proposal step "${section}" must name the instance repository (\`<agents org>/aidenhq-instance\`): a job clones only the repositories its task names, so the proposal closes with the memory file unchanged.`;

const nudgeMessage = (file, p) => `${file}: the section "${p.section}" nudges an open task's agent without ${p.missing.join(" and ")}: state that work reaches an Engineer only through a status write on its own task (task_route), and that a second task is never filed for the same PR because the branch exists only in the task that pushed it`;

const message = (file, p) => `${file}: the section "${p.section}" names \`aidenhq close\` without ${p.missing.join(" and ")}: state that aidenhq close reaches only the agents org, the repos listed in maintainer_repos and the product repo, and that an outside-scope PR goes to the Maintainer (no close task for an Engineer; one \`outside-close-scope\` log line)`;

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
