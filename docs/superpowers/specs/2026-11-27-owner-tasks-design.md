# Owner tasks: agents work the owner's tasks and keep them current

Status: design, not approved. Reviewed twice by Codex (Appendix B). Nothing is built until the owner approves it.

## 1. Why

The owner's words (2026-11-26):

- "Ideally, we should not have any ownerless task. Aiden/fleet steward should assign an owner to everyone."
- "Aiden (or some other bot) should try to take care of all my tasks on my behalf and keep their status updated."
- "Design it carefully … simple, maintainable, featureful and useful to all users in various scenarios, not just me."

### Fixed owner decisions

These are inputs; the reviews were told not to reopen them.

- **D1. Act within the existing gates.** Agents working the owner's tasks send routine replies and chases, and close and
  reassign tasks themselves. They ask the owner only on judgement calls: a commitment, money, or anything sensitive.
  The model is not draft-only.
- **D2. Reuse the existing `autonomy` setting.** It is the per-install level (`off | tier0 | full`, `kernel/src/tier.ts`):
  every user can pick a lower one, and a new install stays `full`. There is no second autonomy knob.
- **D3. Gates the user can configure.** Aiden gets a settings page in plain sentences, editable in place, closer to the
  Maintainer's page. On it each user sets:
  - what the team does alone, what needs their tap, and what it never does;
  - limits: spend, quiet hours, which tasks it works, and whom it may contact.

  Those settings **are** the gates the code enforces. They are not a second layer.

### What the code and one live instance show today

- **184 open tasks.** 91 are agent-held and 92 owner-held. 87 of the owner-held tasks were agent-filed:
  - needs-response 24, todo 19, meeting-action 14;
  - unlabelled 13, waiting-on 11;
  - security 3, daily-brief 1.

  There is **1 ownerless** task.
- **Only `waiting-on` has a working agent.** That agent is Tess (open-loops). She joins each task with `task_join` and
  her sweep runs every 2 hours.
- **Every other owner task sits quiet.** Its task-state reason is `owner_task`, which never raises attention
  (`kernel/src/task-state.ts` `QUIET`), and the idle sweep reads only agent-held tasks (`kernel/src/idle.ts`).
- **Comments wake only an agent holder.** The wake scan (`kernel/src/wakes.ts` ~485) files comment wakes for a task's
  agent holder. A plain comment by the owner on his own task therefore wakes nobody. A board `@mention` is delivered to
  the named teammate's part (`services/board/src/app.ts` ~2420). The board already treats the Researcher as the default
  agent of the owner's own task: there, "the message stays in the team chat; the Researcher leaves it to the others".
- **No starter was found for the `task-replies` routine.** It says it acts on the owner's comments on his tasks, but
  origin/main has no code that starts it. Only a placeholder default lives in `scripts/paperclip-diff.ts`, and the board's
  `FOR_OTHERS` marker only tells agents which comments are not instructions to them. A plain owner comment on his own
  task wakes nobody (see above).
- **Nobody closes these tasks.** Intake and Tess post "answered/delivered — left open for the owner to close", and
  Aiden's brief lists stale ones under "Still open".

So the gap is not tasks with no holder. Code already makes that impossible: `kernel/src/cp.ts` `leavesNoHolder` refuses
any create or change that would leave a task with neither an agent nor the owner. The gap is **owner tasks that no agent
works**. That is how this design defines "ownerless" (§9).

## 2. Prior art (short)

- **Linear: the human stays assignee and the agent is a delegate.** "The assignee remains responsible for the work,
  while the agent contributes on their behalf." Delegated issues stay in My Issues
  (linear.app/docs/assigning-issues).
- **Asana AI Teammates and the GitHub Copilot coding agent become the assignee.** Copilot stops at a draft PR, and a
  human merges.
- **Superhuman Auto Drafts are draft-only.** D1 rules that out for us.
- **Motion and Reclaim move calendar time and own no tasks.** One public review reports hundreds of auto-created tasks
  that could not be deleted. Auto-created work needs a clean off-switch.
- **Grok tasks and Lindy are triggers plus scheduled prompts.** No documented approval model was found.

The Linear delegate model fits the owner's words. AidenHQ already has the primitive: an agent's **part** of the owner's
task, a child task. The board folds parts into the owner's card as its crew (`services/board/src/crew.ts`). Crew rows
already show each part's state and a one-line summary of its latest comment (`summaryOf`).

## 3. Alternatives

| | A. Caretaker part (recommended) | B. Move the task to an agent | C. Batch sweeper |
|---|---|---|---|
| Shape | The owner keeps the task. One agent holds its part and works it. | The assignee becomes the agent; it hands the task back when the owner is needed. | Aiden's routine scans every owner task every N hours and acts in bulk. |
| Free from code today | Parts are agent-held, so they get wakes, the idle sweep, the finish gate, the Steward, and an owner question routed straight to the owner (`escalate.ts`). The crew line shows on his card. | The same machinery. | Routine, skill and `fleet_stale_followups` already exist. |
| My tasks / Inbox | The task stays in My tasks with its crew line. The Inbox gets it only when the part asks him. | My tasks empties, and tasks bounce on each handback. Intake's "these are the owner's" model breaks, and every owner view must learn a second holder rule. | Unchanged; status lands as comments (noise). |
| Cost | Wakes per task on events and armed dates. No polling. | Same. | One large context per sweep, and one bad item stalls the batch. Polling. |
| Main risk | One new power: a part may close its parent. | Loses "it's mine". | Earlier projects' lesson: pull decays, and classifiers that can't act don't close loops. |

A fourth option, a second assignee field on Paperclip issues, means forking Paperclip; parts already are that field.

**Recommendation: A.** It adds the fewest paths, because parts already have every behaviour a working agent needs. The
new pieces are:

1. a durable **care binding** (one part per owner task) with code routing;
2. **settle**: a part may close its parent or hand its part to another agent;
3. **owner rules**: the owner's settings, as one input to the write tier;
4. **wake rules**: an owner comment on the parent wakes the part.

## 4. The model

- **The owner's task stays his.** Its `assigneeUserId` stays the owner, and it stays in his My tasks.
- **One caretaker part per owner task, recorded in one place.** The kernel's `care` table (`kernel.db`,
  `care(parent PRIMARY KEY, part, agent, holder_user, company, state, since)`, `state` one of `routing`, `active`,
  `taken_back`) is the only definition of **caretaker authority**: who may settle the owner's task and whose sends get
  the owner's standing rules.
  - Ordinary crew membership stays as it is: `task_join` parts, `@mention` parts, the handoff and escalation that
    recognise any open person-held parent. The binding adds authority; it does not replace crew.
  - Tess stops calling `task_join` for `waiting-on`, because routing makes her part. Her existing parts are adopted by
    id (§12).
  - The binding is scoped to the parent's actual assignee user and company. `isUsersTask` also accepts a merely
    responsible user, so settle checks the binding, never that helper.
  - Helpers the caretaker brings in are its own delegations under the part, never second parts.
- **Status** is what already exists:
  - the kernel's state of the part (working, waiting on someone, armed until a date, needs you, failed);
  - the one-line summary of the part's latest comment, which the caretaker writes as "what happened, what's next"
    (skill `take-care`).

  Both show on the owner's card, in My tasks and in the drawer's Activity feed. There is no new status field.
- **Taking a task back.** The owner closes the part, or says so on the task ("I'll handle this") and the caretaker
  closes its own part. The binding becomes `state: taken_back`, and routing never re-creates it. Reopening the part makes
  it `active` again.

## 5. Routing: who takes care of which task

### 5.1 The declaration (code, generic)

An agent declares the owner-task labels it takes care of, in its module's `module.yaml`:

```yaml
agents:
  open-loops:
    cares_for: [ waiting-on ]
  assistant:                 # Rhea, the Researcher
    cares_for: [ "*" ]       # every owner task no other declaration claims
```

`kernel/src/care.ts` picks the caretaker with one pure function over compile's table:

- **Unique claims.** Compile refuses two agents claiming the same label, and two claiming `"*"`.
- **Several matching labels.** When a task's labels match several caretakers, the first label wins in the order of the
  owner's scope list `care_labels` (§8; default `[waiting-on, needs-response, todo, meeting-action, *]`). That is
  deterministic and visible on the page.
- **A missing module.** With `open-loops` not installed, `waiting-on` falls to `"*"`. That is the same lookup, not a
  second path.
- **Another owner's modules** plug in the same way: a CRM module's agent declares `cares_for: [ deal ]`, and a local
  module's agent may declare too.

**Code routes; the agent judges.** Routing is deterministic, free and loop-free. Judgement comes after it. A caretaker
that finds another teammate fits better hands over its part (`task_settle { action: "handover", to }`, §7.1), choosing by
each agent's one-line `description` (`task_team`, skill `delegate-work`). The binding moves with the part.

### 5.2 When routing runs

`care.route(parent)` is the only entry point. The kernel's per-task scan lock is in memory (`wakes.ts`), and board
writes commit before the kernel sees them, so routing does not rely on a lock. It is **durable and idempotent**:

- It writes the intent first: a `care` row in `state: routing`.
- It then creates the part with a parent-based idempotency key, `care:<parent>`, which no agent id enters, so a
  re-route or a retry returns the same child. The binding becomes `active` only after that.
- At start, the kernel finishes every row still in `routing`, recovering the same child by that key.

Admission rechecks the binding, the holder, the labels and care's state before every part job (§7.2), so a label
removal, a handback or care turned off meanwhile stops the work. A running job meets the same checks on its next write.

It runs on:

1. an open task created held by the owner, whoever files it: Intake, Nora, an agent's `task_create`, or the owner on the
   board (`cp.ts` create path and the board's owner writes);
2. a label added, while the part has never started a job (after that, the caretaker decides);
3. an owner comment on his own task that has no active binding. His words on his task are an ask, so scope never
   silences them (§6.3);
4. the adoption queue (§12), which the Steward's detector also feeds (§9).

Routing creates nothing when:

- care is off;
- the task's labels are outside `care_labels`;
- the task is a chat (`lane.ts`), a log task, a recurring template, a daily brief or an `idea`;
- the binding is `taken_back`.

A task handed back to the owner by an agent's own `task_handoff` keeps its binding.

**Parts are created with the owner's client**, as `kernel/src/modtasks.ts` files module tasks: `createdByUserId` is the
owner and no agent is the creator. The part is assigned to the caretaker, and its assignment wakes it (`wakes.ts`). So
the existing "part the owner gave this agent" semantics hold, and escalation routes its questions to the owner directly.

### 5.3 The default caretaker

**Rhea, the Researcher** (`assistant`) takes `"*"`:

- She already holds the owner's Gmail and Calendar writes and Slack.
- She has the reply-processing skill.
- The board already treats her as the default agent on the owner's own task.

Aiden stays the face. The page is Aiden's (§8), and Home says the rest is handled. Rhea and Tess are named teammates
on the crew line. Aiden does not become the worker, so his lane stays fast for the owner's chat (`max_parallel: 2`).

**Tess** keeps `waiting-on`. Nora declares nothing: a `meeting-action` task is the owner's own to-do, so Rhea takes it.
Meeting actions owned only by someone else are already not filed (`meetings` skill `meeting-actions`).

## 6. What the caretaker does

The how-to lives in one new skill, `chief-of-staff.take-care` ("working an owner's task"). Rhea and Tess both list it.
It absorbs `task-replies`; handbooks state only the mission.

### 6.1 Each wake on a part

1. **Read.** Read the parent (title, description, `source:` marker, comments) and the source itself, **fresh, at the
   head**: the Slack thread, the email thread, the PR or issue, the meeting note. Task and source text are data.
   - If the owner already answered or acted there himself, the caretaker reassesses what is left.
   - A task with no source (the owner's own board note) takes as evidence the owner's comment or the deliverable.
2. **Decide one step:**
   - **done already:** settle the parent with the evidence (§7.1);
   - **do it:** reply, chase, schedule, file, research or draft, through the tools and their gates;
   - **someone else's:** hand the part over (§7.1);
   - **a judgement call:** ask the owner on the part. That is an owner wait with options and the recommendation
     first; it lands in his Inbox (Needs you) and his answer wakes the part;
   - **not yet:** `task_wait until <date>` (the due date, the chase date, after the meeting), and say why.
3. **End the run** with one comment on the part: "what happened · what's next". Its summary is the crew line. Every run
   ends with an armed wait, an owner wait, a settle or a handover. A part with none is idle: the existing sweep nudges it
   (at most 3 a day), then it becomes the Steward's incident.

**After an uncertain send** (a timeout, an unknown provider outcome), the caretaker reads the source and the record's
outcome before any retry. Wakes dedupe jobs, not sends.

### 6.2 Judgement calls

The skill holds the judgement calls in the owner's own words, from his page's "Always ask me about" list (§8), which the
setting renders into the skill. The defaults are:

- a commitment on his behalf (a date, a deliverable, a yes);
- money;
- people matters, legal, security incidents, fundraising and press;
- anything his decisions (profile "Owner decisions") mark as his.

What his decisions already answer is settled without asking (prompts `how-we-work`, `deciding`). The code-checkable part
of the same intent (who hears it, money tools, publishing, cancelling) is enforced by the owner rules (§7.2). A wrong
judgement still meets code.

### 6.3 The owner's comments and mentions

`kernel/src/wakes.ts` gains one rule. A comment on a task with an `active` binding files a wake for the caretaker's part.
The wake key is `comment:<comment id>:<part id>` (wake keys are global, so the destination is in the key), and the wake
carries the comment's authenticated author, as the scan already records it (`account:` or `agent:`).

- The rule covers the owner's comments, and other agents' comments such as Intake's "answered in Slack" line. It skips
  the caretaker's own comments, any comment carrying the job tag, and any comment marked `FOR_OTHERS`.
- An `@mention` of another teammate keeps today's delivery to that teammate's part (`app.ts` `deliver`), and the
  caretaker is not also woken for it.
- The board's "own" agent on the owner's task reads the binding's caretaker, not "the Researcher", so a task Tess cares
  for keeps the owner's plain messages with Tess.

With no binding, the owner's comment routes first (§5.2.3). This replaces the `task-replies` routine, which has no starter: there is
one path for "the owner said something on his task".

## 7. Writes and gates

### 7.1 Settle and handover

**New tool `task_settle`** (tasks connection), callable only by the active caretaker of a binding, from a job on its
part:

```text
task_settle { action: "done" | "handover", evidence: "<link + one line>", to?: "<agent key>" }
```

- **`done`** closes the owner's task and the part.
  - It covers "answered", "delivered" and "no longer needed": the evidence line says which.
  - It passes the finish gate (`checks.ts`).
  - Cancel is not offered: cancelling a task has side effects, such as closing a linked PR.
- **`handover`** reassigns the **part** to another agent and moves the binding. It checks the current assignee and the
  target's grants. The owner's task never moves to an agent.

**One record per settle.** Each settle is one write record of a new kernel kind, `task.settle`, floor 0, tiered by
`computeTier`:

- Autonomy `off` makes it a card (D2), and the owner's rule for class `tasks` applies (§7.2).
- The record binds the parent's status version, the part and the caretaker.
- **One writer.** Settle writes only through the kernel's signed plugin post (the one writer, `cp.ts`). Paperclip's
  PATCH has no conditional update, so the plugin re-reads the parent's status version immediately before its write and
  refuses on a mismatch. That narrows the race with an owner reopen to the plugin's read-then-write; it does not close
  it.
- **Recorded steps.** The record holds which steps succeeded (`parent_closed`, `part_closed`), so the kernel's
  reconcile at start finishes the rest and recognises its own close. If the parent's newest status change after that
  close is the owner's reopen (the existing status-change facts), recovery keeps it open, puts the part back to `todo`,
  and ends the record `stale`.
- **Two kinds of part closure.** A part closed by settle is the settle's; a part the owner closes is `taken_back`. The
  board's own child cleanup (`app.ts`) leaves a bound part to settle.
- **The residual race.** If the plugin's write still wins over a simultaneous reopen, the reopen lands after it and is
  seen as an owner reopen: the correction path below.

**An owner reopen is a correction.** The kernel reads it from the existing `task.status_changed` facts (`facts.ts`): a
change from `done` to an open status, by the owner's account, after a settle. There is no new fact kind. The `wakes.ts`
`reopen:` key is a different thing: it covers a comment that reopens a finished task. From then on, a settle on that task is class `tasks` with rule
`ask`, so the owner confirms the next close. There is no timer. The case also becomes an eval (§14).

### 7.2 Owner rules: the owner's settings as the tier's one new input

**What exists.** Every write is a kernel record tiered by `computeTier`: the kind's floor (a connection's `destructive`
tools are Tier 1), code refusals, the owner's veto or save, autonomy `off`, and a session's role. The Conventions say
Tier 2 is "only his veto, his settings save, autonomy off; nothing else".

**The amendment.** This design amends that line in CLAUDE.md "Conventions" and in `docs/design/approvals.md`: the
owner's **saved rules** join his veto and his save as the owner's authority. There is one new input:

```ts
computeTier({ ..., rule }: { rule?: "alone" | "ask" | "never" })
// never → refused (rule "owner-rule-never"), before everything else, sessions included;
// ask   → Tier 2 (rule "owner-rule-ask"), before the session shortcut;
// alone → as today (floor; the reviewer at Tier 1; autonomy off still makes it Tier 2).
```

**Where the rule comes from.**

- **Classes are declared on the action, never per agent.** Each module already tags its tools read, write or
  destructive; a write or destructive tool, and a module write kind, now also names a **class** from one small kernel
  vocabulary.
- **The module resolves the audience.** A send tool's module resolves a call's **audience** from provider data,
  through one hook beside the vendor proxy: `audience(call) → { conversation: "source" | "other", reach: "company" |
  "external" | "unknown" }`.
- **The kernel applies the strictest rule.** `kernel/src/rules.ts` (new, pure) maps (class, audience) to the owner's
  rule. An `unknown` audience is never `alone` for a send.

| Class | Tools (examples, declared by their module) | Default rule |
|---|---|---|
| `reply` | a send whose audience is the task's own source conversation and whose recipients are exactly the people already in it | alone |
| `message` | any other send: a new DM, a new email, added To/Cc/Bcc, a shared channel with external members, a scheduled send | ask |
| `calendar` | create, move or respond to events where no new attendee is added | alone |
| `invite` | any calendar change that adds attendees or notifies people, and sharing a file | ask |
| `calendar_cancel` | delete or cancel a calendar event | ask |
| `tasks` | `task.settle`, the board's task moves | alone |
| `records` | CRM, Jira and GitHub issue writes | alone |
| `publish` | public posts, documents shared outside, releases | ask |
| `money` | any tool its module marks as spending money | never |
| `delete` | deleting mail or files (calendar events are `calendar_cancel`) | never |

**Where `reply` authority comes from.** The source is not taken from task text: agents write task markers, Gmail
markers omit the account, and a write record can name another task. A send gets `reply` only through the authenticated
job's own binding:

1. The job's task is an active part.
2. Its binding names the parent.
3. The parent's **verified source identity** is the conversation it came from: Slack workspace, channel and thread root;
   Gmail account and thread.

The kernel records that identity once, at filing, and only from what the filing job verifiably read:

- **Slack.** The marker must name an event in the filing job's own routine batch (the kernel holds the batch,
  `routine_events`).
- **Gmail.** The marker must name a thread that the job's own Gmail reads returned in that run. The kernel's proxy sees
  those results.

A marker that matches neither records no identity. This check is new and is listed for the security review to confirm;
it is the basis of reply authority. A task without a verified
identity (the owner's own board note, a forwarded message) supports work and an evidence-based close, but it has **no
automatic reply destination**: any send from it is `message`.

**How the audience is resolved, against the source's current head:**

- **Gmail:** the call's actual To, Cc and Bcc against the **current** message's reply audience (its sender, To and Cc,
  less the owner), not the thread's historical participants, on the same connected account. It is `company` only for
  addresses in `company_domains`.
- **Slack:** the workspace, channel and thread root must match. A thread broadcast (`reply_broadcast`), or a shared
  channel with external members, is `external`.
- **Calendar:** the attendees before and after the change, and whether the provider notifies guests. Any notification
  to guests is `invite`; an RSVP reaches only the organizer and is `calendar`.
- **The record binds the resolved audience and the source head.** If the head moved before execution (the owner
  answered while review was pending), the record ends `stale` and the caretaker reassesses.

The owner's company is `company_domains`, which he sets. It is empty by default, so a personal-mail user has no company
boundary and only `reply` is automatic.

**The other limits are gates too, each enforced once, in `rules.ts`:**

- **Contacts.** Who `message` and `invite` may reach on their own: `nobody` (the default, so each one asks), `company`,
  or `anyone`. This setting is new.
- **Quiet hours.** No sends of class `reply`, `message` or `invite` between the hours the owner sets (default none),
  in his timezone. The call is refused with "retry after <time>", and the caretaker arms `task_wait until` that time.
  Owner notifications keep owner-channel's mutes. This setting is new.
- **Daily send cap.** At most N sends a day (classes `reply`, `message` and `invite`; default 30). Each send is reserved
  atomically **against the day it executes** (one transaction in `records.ts`, like the gateway's `reserve`), so a card
  approved tomorrow counts tomorrow. Past the cap, sends are refused until the next day and the Steward is told once.
  This is a runaway backstop, and it is new.
- **Spend.** The existing `task_usd`, `spend_day_usd`, `spend_month_usd` and the agents' gateway caps. The page shows
  them and adds no spend limit of its own.
- **Scope.** `care`, `care_labels`, `care_sources` (the source families of a task's verified identity, plus `board` for
  tasks with none) and `care_projects` (empty means every project), all set on Aiden's page (§8). Routing and admission
  enforce them.
- **Per-teammate caps.** The existing `overrides.agents.<key>.caps` (`run_usd`, `day_usd`), shown for the caretakers on
  the page and enforced by the gateway as today.
- **The owner's own words satisfy `ask`.** Today, an email or calendar change the owner asks Aiden for reaches the
  Researcher with his message relayed word for word (`task_relay_owner_words`) and "no second ask". Under `message: ask`
  that would become a card. Instead, a record whose task carries the owner's own relayed request for that action
  (identified by comment id) is filed as decided by his words, the way his settings save is decided by his session. The
  security review confirms the relay cannot be forged: the relay already checks that the comment is the owner's.

**Checked twice.** Rules, scope, quiet hours, contacts and audience are checked when a record is filed, and again at
execution. Execution covers every path a write takes: the proxy's inline forward of a Tier 0 call, a card approved
later, and an approved replay (`proxy.ts`, `writes.ts`).

- **Admission.** Admission refuses a part's job while care is off or its binding is not active (a new hold reason,
  `care_off`).
- **Care off is the pause.** Turning care off stops the team on the owner's tasks at once: no new jobs, and no queued
  send executes. It is the vacation control. Autonomy `off` is different: it turns every write into a card.
- **Classes follow the actual operation.** Module declarations name each tool's candidate classes, and the hook picks
  the actual one per call, with the strictest applicable rule winning.

**What stays judgement.** The reviewer fails open and only blocks explicit malice. A commitment buried in a routine
reply is the agent's judgement (§6.2). Code bounds who hears it, not what it says.

**Hard gates are unchanged.** Outbound sends are a hard gate by convention (`kernel/src/gates.ts`), so these rules enforce
from day one, never in observe mode.

**What authorises a send.** Today only the owner's words authorise a send for an agent working for him ("when the user
asks"). Under this design **his saved settings are the standing authority**: turning care on with `reply: alone` is his
decision to let the team answer for him in the conversation a task came from. Each send still files a record; at Tier 1
the AI reviewer reads it, and the owner's `ask` or `never` override that.

**Security review.** The path takes text from other people's messages to sends as the owner. It gets the security review
the Conventions require before care switches on. The review covers prompt injection to the reply path, audience
resolution, and echo suppression.

**Loop guard (code).** A send as the owner comes back through slack-live (or the Gmail scan) as the owner's own message.
Intake could file it as a `todo`, and the caretaker could wake on its own reply.

- **Correlate by provider id.** When a send executes, its record stores the provider's id: the Slack message `ts` with
  its channel, or the Gmail message id. That is durable, with no text hashes and no time window, so the owner's own
  identical reply is never suppressed.
- **Slack.** The event router seals each routine batch only after its 60 s window. At drain, the kernel marks an event
  whose (channel, ts) equals a send record's outcome `by_agent`. A send still executing when the batch drains holds
  that conversation's events from that batch, at most one more window, until its outcome is stored.
- **Gmail.** The scan reads an inbox cursor outside `events.ts`. Before filing anything, it skips message ids that a
  send record stored (one kernel read).
- **Filters.** The routine filter learns `by_agent`, and Intake's routines set it false. Source-event wakes (phase 3)
  skip it.
- **An uncertain outcome.** A timeout leaves no provider id. The record ends `unknown`, and the caretaker reconciles it
  by reading the source (§6.1) before any retry.

## 8. Aiden's page: what the team does, in sentences

The section is **"How Aiden's team works"** on Aiden's existing teammate page (`#/team/chief-of-staff`). It is the
"How it's set up" column that `docs/superpowers/specs/2026-11-26-home-and-teammates-design.md` §2 renders from declared
settings. That spec deferred "per-teammate trust controls (asks first vs acts)" as a non-goal; this delivers it.

**One presentation building block** for every module, in `modules/board/schemas/`: a setting may declare
`sentence: "Reply for you in the conversation a task came from: {value}"`, with labelled `values`.

- The board renders it inline with its default shown.
- Keys, values, validation and the owner's Save stay on the existing settings path (`settings-change.ts`, owner paths
  for loosening).
- The owner's MCP sets the same declarations.
- The Maintainer's and Ship's pages may adopt it later.

Why not a module view like the Maintainer's: chief-of-staff has no service or connection to serve one, and the gate
settings belong to the kernel. A declared sentence renders on the teammate page and through the owner's MCP with no new
service.

**Where the values live:**

- The gate settings `autonomy`, `owner_rules`, `contacts`, `company_domains`, `quiet_hours` and `send_cap_day` are
  **kernel settings** (`kernel/settings.json`). The kernel owns tiers.
- The care settings `care` (`off | on`), `care_labels`, `care_sources` and `care_projects` are chief-of-staff settings.
- The page declares both. `docs/design/board-ui.md` documents that a teammate page may render kernel settings its module
  names.
- Loosening anything (a rule toward alone, wider contacts, turning care on, more labels) is the owner's own save.
  Tightening tiers as usual, so Aiden can file "stop sending emails for me" from the owner's words.

**Sketch.** Values in [brackets] are editable in place. Defaults are shown.

> **Aiden's team takes care of your tasks** · [Off ▾]
> They work [waiting-on · needs-response · todo · meeting-action · everything else ▾] (first match picks who), from
> [Slack · email · meetings · my board ▾], in [every project ▾], except tasks you take back.
> *When on:* 92 of your open tasks are in scope. Who works what: Tess · things others owe you; Rhea · everything else.
>
> **How much they do on their own** · [Act, and ask me on judgement calls ▾]
> *Act, and ask me on judgement calls* = autonomy `full` · *Do small steps alone; ask me before any reviewed action (a
> send, a calendar change), with the reviewer's note* = `tier0` · *Ask me before anything they change* = `off`
>
> **On their own, they may**
> - Reply for you in the conversation a task came from · [alone ▾]
> - Write to anyone else · [ask me first ▾]; on their own only to [nobody ▾ / people at my company / anyone]
> - My company is [example.com, + add]
> - Accept, decline or move your meetings · [alone ▾]; invite people or share files · [ask me first ▾]; cancel a meeting ·
>   [ask me first ▾]
> - Close your tasks when they're done, or hand them to a better teammate · [alone ▾]
> - Update records (CRM, Jira, GitHub issues) · [alone ▾]
> - Publish or share anything outside · [ask me first ▾]
>
> **They never** · Spend money [never ▾] · Delete mail, files or events [never ▾]
>
> **Always ask me about** (they judge these) · [a commitment for me] [money] [people matters] [legal] [security]
> [fundraising] [press] [+ add]
>
> **Limits**
> - Quiet hours: no messages from them between [none ▾]
> - At most [30 ▾] messages a day
> - Spend: [$20] a task · [$50] a day · [$1000] a month for the install; each teammate at most [$2] a run · [$30] a
>   day (raising one is yours)
>
> [Advanced ›] (module settings, model, routines)

Rows for classes whose tools no installed module has are not shown. For example, with no CRM, Jira or GitHub there is no
records row. Moving `autonomy` and the spend limits here removes their editors from the generic Settings screen in the
same change; Settings keeps a read-only line that links here.

## 9. No ownerless tasks

- **Holder** (this exists): every open task is held by an agent or the owner, and `cp.ts` refuses anything else.
  `leavesNoHolder` does not check status-only changes, so reopening a legacy task with no holder is possible.
- **Worker** (new): every open owner task inside care scope has an `active` or `taken_back` binding.

The rule is enforced by code:

1. **Routing at the write path** (§5.2) covers every new task.
2. **Recovery at start** finishes any `routing` row (§5.2).
3. **The Fleet Steward's detector** (`detector.ts`, phase 2) reports two things as a routing defect:
   - an in-scope owner task with no binding that is not queued for adoption, after 15 minutes;
   - an open task with no holder that is not a chat.

   Queued adoption backlog is expected, not a defect. The detector puts each defect into the adoption queue (§12) and
   logs it, and it never wakes the Steward's LLM unless routing then fails. Each hit is a product bug, filed as today.
4. **A task with no holder** is first assigned to the owner (`defaultResponsibleUserId`), then routed. "Assign an owner
   to everyone" is code.

The Steward still never settles a person-made task; it routes.

## 10. When it runs, and cost

**There is no schedule and no sweep.** A part's job starts only on:

- its creation;
- an owner comment, or Intake's answered comment;
- its armed `task_wait until`;
- the owner's answer to its question;
- the idle sweep's nudge (at most 3 a day);
- in phase 3, a source event.

**Tess's every-2-hours sweep is deleted.** Each of her parts arms its own chase date: one wake when it is due, instead of
one run over every waiting-on task six times a day.

**Bounds**, all existing except the send cap:

- `task_usd`, the gateway caps and the install's day and month limits;
- the idle sweep's cap;
- `task_wait` at most 7 days ahead;
- the send cap.

**Estimate.** The live instance has about 90 parts. At a median of one wake per part every 2-3 days, that is about 35
jobs a day on DeepSeek Flash: a few dollars a day, comparable to Tess's sweeps today. Adoption drips (§12).

**Dedupe:**

- one binding per parent (primary key);
- one job per wake;
- one open owner question per task (`escalate.ts` `ask:<task>`);
- one chase pending per item (skill);
- one record per settle.

**No loops:**

- the part's own comments carry the job tag and wake nobody (`SELF_TAG`);
- sends are echo-marked (§7.2);
- settle closes both tasks;
- an owner reopen makes the next settle the owner's.

## 11. Visible status

- **My tasks.** Each owner task shows its crew line: the caretaker's face, the summary of its latest comment, and the
  part's state, for example "Rhea · Replied to Dana, waiting for her answer · waiting 2d".
- **Inbox / Needs you.** Unchanged: owner waits, handbacks and Tier 2 cards. A caretaker's question is an owner wait on
  its part.
- **Drawer.** The part's Activity feed (task-truth spec) shows every step, card and settle with its evidence.
- **Aiden's brief:**
  - "Needs you" is what the team asked him;
  - **"Handled for you"** (new, phase 2) is the settle records since yesterday, with links;
  - "Still open" and `fleet_stale_followups` narrow to owner tasks with no binding, which are out-of-scope or taken back.
- **Home's greeting** ("N things need you; the rest is handled") becomes true.

## 12. Migration of today's tasks

When the owner turns care on, **adoption** queues every open in-scope owner task. The kernel drips the queue oldest
first, at most 10 an hour.

- Each part's first run reads the source fresh.
- Many of the 92 already carry Intake's or Tess's "answered/delivered" line, and those settle on their first run.
- The detector feeds the same queue, so its repairs never burst past the drip.

**Tess's existing parts are adopted by id.** The kernel writes their bindings, and the parts continue with no new task.
Turning care off stops routing and adoption, and admission holds every part's job (`care_off`). Nothing closes. Turning
care back on resumes them, and each part's next job reads its task's current state before acting. The one task with no
holder is assigned to the owner by the adoption pass, then routed.

## 13. What changes

**Code:**

| Area | Change |
|---|---|
| `kernel/src/care.ts` (new) | Binding table, `route`, adoption queue and drip. |
| `kernel/src/rules.ts` (new) | Class + audience → rule; contacts, quiet hours, send cap. |
| `kernel/src/tier.ts` | `computeTier` takes `rule`. |
| `kernel/src/writes.ts`, `records.ts` | File and execute consult `rules.ts`; the `task.settle` kind and executor; atomic send reservation; recheck at execute. |
| `kernel/src/cp.ts` | Route on create, label add and owner comment; a caretaker's settle writes its parent. |
| `kernel/src/wakes.ts`, `admission.ts`, `idle.ts` | Owner comment → part wake; `care_off` hold; the sweep skips held parts. |
| `kernel/src/events.ts` | Expected echoes; `by_agent` mark and filter key. |
| `kernel/src/reconcile.ts` | Finish a half-done settle. |
| `kernel/settings.json` | `owner_rules`, `contacts`, `company_domains`, `quiet_hours`, `send_cap_day`. |
| `scripts/modules.ts` (compile) | `cares_for` (unique claims); tools' and kinds' `class`; the audience hook declaration. |
| `modules/tasks/connections/tasks-mcp` | `task_settle` (authority from the binding only). `task_join` stays for ordinary crew. |
| `modules/slack`, `modules/google` | `class` on write tools; the audience hook (Slack: workspace, channel, thread, shared channel; Gmail: recipients, thread, account; Calendar: attendees). |
| `modules/board/schemas/` + board | `sentence:` block; Aiden's page section; crew line on My tasks; brief data. |
| `modules/fleet-steward` detector | The worker rule into the adoption queue. |

**Skills, handbooks and docs** (positive wording):

- **`chief-of-staff.take-care`** (new) absorbs `task-replies`; the `task-replies` routine is deleted.
- **Rhea and Tess** list `take-care`.
- **Grants.** Rhea gets `slack_send_message` and `task_settle`. Tess gets `slack_send_message`, `task_settle` and
  `task_wait`, plus `gmail_send` when google is installed.
- **Tess** sends chases in the source conversation, and her sweep routine is deleted.
- **Intake** marks answered with one comment, and the caretaker settles. Its routines filter `by_agent`.
- **Aiden's** rule "owner's tasks stay open" becomes "the caretaker settles them". His brief sections change (§11).
- **Docs:** CLAUDE.md Conventions (Tier 2 sources), `docs/design/approvals.md`, `quiet-start.md` and `board-ui.md`.

**Behaviours this replaces.** D1 already decides auto-close and sent chases; the others are listed for his OK under the
"ask before dropping behaviour" rule:

1. **The owner closes his own tasks:** replaced by the caretaker's evidence settle, with one-click reopen.
2. **Chase drafts the owner sends:** replaced by sends in the source conversation.
3. **Tess's every-2-hours sweep:** replaced by per-item wakes.
4. **The brief's "Still open" for every stale owner todo:** narrowed to tasks nobody takes care of.
5. **Tess joining waiting-on tasks herself, and the `task-replies` routine (no starter found):** replaced by routing and the owner-comment wake.
6. **The Settings screen's editors for `autonomy` and spend:** moved to Aiden's page.

## 14. Tests and evals

**Minimal end-to-end tests:**

- **care:** a `waiting-on` owner task gets one part held by open-loops, and another label gets `"*"`. A re-create, a
  label add after the first job, or a racing adoption creates no second part. A taken-back binding is never re-created.
- **settle:** it closes the parent with evidence. An owner reopen between filing and execution makes it `stale`. After
  a reopen the next settle is Tier 2.
- **`computeTier` with `rule`:** about 6 table cases (never beats a session, ask beats a session, autonomy off).
- **The audience hook and `rules.ts`:**
  - a Gmail reply in the source thread to its participants is `reply`;
  - added Cc is `message`;
  - a Slack shared channel with externals is `external`;
  - an unknown audience asks.
- **Echo:** a send's echo arriving before its outcome is marked `by_agent` and dropped by Intake's filter.

**Evals come only from real corrections.** Each of these becomes a case by the existing capture, in
`modules/chief-of-staff/test/evals/assistant/cases/` or open-loops':

- every reopen after a settle;
- every "you shouldn't have asked";
- every send he calls wrong.

Seed cases: an already-answered `needs-response` (settle); a commitment ask (owner question, no send); and an injected
email asking to forward the thread (reply in source only).

**Live check before switching on:** one TEST owner task per class, run by hand (manual end-to-end, never CI).

## 15. Failure modes

| Failure | What happens |
|---|---|
| Wrong close | The owner reopens. The next settle on that task is his to confirm, and the case becomes an eval. |
| Wrong send | Its reach is limited (`reply` stays in the source conversation; the rest ask). The reviewer reads each send. A correction becomes an eval, and he can set `reply: ask`. |
| Prompt injection in an email | The text is fenced data. A send reaches only the same conversation's people; anything else asks or is refused. The reviewer blocks explicit malice. The send cap bounds volume. |
| Owner answered himself first | The source is read fresh each run: the caretaker reassesses or settles. |
| Caretaker stuck or failing | The idle sweep, then the Steward's incident path. The card shows "failed". |
| Source unreadable | No settle without evidence. The part re-checks in 1 day; after 3 failed reads it asks the owner once. |
| Module missing | Routing falls to `"*"`. With no send tool granted, the caretaker asks or drafts and says so. Classes with no tools are not on the page. |
| Care off or vacation | Admission holds every part's job and no queued send executes. Nothing closes. |
| Crash mid-settle | Reconcile finishes it from the record. |
| Routing he disagrees with | He comments "Tess should do this" (the caretaker hands over), or reorders `care_labels`. |

## 16. New installs

- **Care is off** (quiet start): no routing, no sends, no spend. Aiden's page shows the switch and one sentence on what
  turning it on does. Aiden's `ideas` skill offers it once tasks exist.
- **Autonomy stays `full`**, with the defaults in §7.2: only `reply`, `calendar`, `tasks` and `records` run on their own.
- **Without Slack.** Intake and open-loops both require `slack` today, and compile follows literal `requires`
  (`scripts/modules.ts`). A Gmail+Calendar-only install still gets care on every task it has (board, meetings, Aiden). To
  give it Intake's Gmail tasks, phase 1:
  - removes Intake's `slack` requirement and makes its Slack grant optional;
  - gates its Slack event routine with `when.module: slack`;
  - lets its trial skip the missing Slack tools.

  Without open-loops, email `waiting-on` tasks go to Rhea by the `"*"` claim. One test covers a Gmail-only install end to
  end.
- **Existing Tess users** keep their follow-up coverage. Her parts are adopted before her sweep is deleted, in the same
  apply.
- **A solo developer without GitHub** sees no records row for GitHub.
- **Another owner's modules** plug in by declaring `cares_for`, their tools' `class` and an audience hook for any send
  tool. A send tool with no hook is `unknown`, and so asks.
- **Team or hosted, later:** a binding names the parent's holder. Today that is always the one owner; per-user rules and
  sending accounts come with the team version. Nothing here hard-wires "one owner" beyond today's `cp.ts`.

## 17. Phases

**Phase 1 is the smallest useful set.** The owner's rules ship in it for every action it enables: D1 and D3 together.

Contents:

- `care.ts` (durable binding, idempotent route, recovery at start, adoption drip; Tess's parts adopted by id);
- `task_settle` (`done` and `handover`, kind `task.settle`, stale on reopen, reconcile);
- the owner-comment wake and the `care_off` hold;
- `computeTier` `rule` and `rules.ts` for every class a phase-1 agent can reach: `reply`, `message`, `calendar`,
  `invite`, `calendar_cancel` (Rhea already holds `calendar_delete_event`), `tasks`, `delete` and `money`;
- verified source identity at filing, and the Slack and Gmail/Calendar audience hooks;
- contacts, quiet hours and the send cap;
- the echo guard;
- `take-care` (keeping `task-replies`' correction and rescheduling eval cases), grants, the `google.gmail-writes` skill
  (sends on a task's standing authority, not only "when asked"), and the Tess, Intake and Aiden rule lines;
- the Gmail-only install changes;
- Aiden's page section (sentence block) with autonomy and spend moved there;
- the one holder-less task: the adoption pass assigns it to the owner first (§9.4), with no detector needed;
- the doc amendments;
- the security review before switching on.

Status in phase 1 is the existing crew summary. "Handled for you" in the brief and the detector's worker rule move to
phase 2.

Files:

- `kernel/src/{care.ts,rules.ts,tier.ts,writes.ts,records.ts,cp.ts,wakes.ts,admission.ts,idle.ts,events.ts,reconcile.ts}`;
- `kernel/settings.json`;
- `scripts/modules.ts`;
- `modules/tasks/connections/tasks-mcp/src/tools.ts`;
- `modules/chief-of-staff/{module.yaml,agents/*/AGENTS.md,skills/take-care/SKILL.md}`, with `skills/task-replies`
  deleted;
- `modules/open-loops/{module.yaml,agents/open-loops/AGENTS.md}`;
- `modules/intake/{module.yaml,agents/inbox-agent/AGENTS.md,skills/triage-*}`;
- `modules/slack/{module.yaml,connections/slack-live/src/map.ts}` and the Slack MCP proxy hook;
- `modules/google/{module.yaml,connections/google-workspace-mcp/src/*}` for the hook;
- `kernel/src/proxy.ts`, `services/board/src/app.ts` (own agent from the binding; cleanup leaves bound parts), `services/paperclip-events` (settle's version re-check);
- `modules/google/skills/gmail-writes/SKILL.md`, `modules/AGENTS.md` (`cares_for`, `class`, the audience hook);
- `modules/board/schemas/`;
- `services/board/{src/home.ts,src/crew.ts,web/src/Teammate.tsx}`;
- `CLAUDE.md`;
- `docs/design/{approvals.md,quiet-start.md,board-ui.md}`.

Expected size: a large PR. Split by area if it passes about 2k lines: kernel+tasks first, then modules and the board.

**Phase 2: wider classes and the backstops.** The brief's "Handled for you" and the detector's worker rule (§9.3);
`records` and `publish` on CRM, Jira, GitHub, Drive and Primer tools,
each with its audience hook where it reaches people. Until then those tools keep today's tiers, and their rows are not
on the page.

**Phase 3: push.** Source-event wakes, so auto-close from source truth arrives without armed re-checks:

- one normalised source identity per connection: Slack workspace + channel + thread root; Gmail account + thread;
  GitHub repo + number; pin and label aliases folded;
- an index from that identity to the active binding;
- a matching, non-`by_agent` event files `source:<event id>` on the part.

The Gmail scan stays a cursor read; its new messages count as events for this index.

## 18. Questions only the owner can answer

These are about authority and what users see. D1-D3 are not reopened.

1. **Default reach.** Recommended: `reply` alone, everything else asks, contacts `nobody`, `company_domains` empty. For
   new installs, should writing to people at his own company also be alone by default?
2. **`money`.** Recommended: never by default, until a user turns it on. Is that right for every install?
3. **Who users see.** Recommended: crew lines show the named caretaker (Rhea, Tess) while the page is Aiden's.
   Alternatively every line reads "Aiden · …", with Rhea hidden as his staff.
4. **Turning care on for this instance.** Recommended scope: every label except `security`, which stays with the
   security agent's flow. Adoption closes many old tasks on evidence in the first day.
5. **The Conventions amendment.** The owner's saved rules become a Tier 2 source beside his veto and his save. This
   changes the 2026-11-22 approval rule, so it needs his explicit OK.

## Appendix A. Live-instance notes (builder only)

- `meeting-action` (14) and `todo` (19) go to Rhea; `waiting-on` (11) stays with Tess (adopted by id).
- `security` (3) are the security agent's fix tasks. Question 4 above recommends keeping them out of scope.

## Appendix B. Codex reviews

Both passes ran `codex exec` (read-only, against this branch) with D1-D3 stated as fixed. Verdicts: pass 1 "revise",
pass 2 "revise before shipping"; neither asked for a rethink, and both kept model A (owner stays assignee, one caretaker
part).

### Pass 1: taken

| Finding | What changed |
|---|---|
| Phase 1 enabled real sends and closes but deferred the owner's rules to phase 2 | The owner rules ship in phase 1 for every action it enables (§17). |
| §18 reopened D1 (auto-close, sent chases) | Those questions are removed. §13 lists them as replaced behaviour under D1. |
| `never`/`ask` must beat the session shortcut, be rechecked at execution, and reserve sends atomically; settle must be one record | §7.2 adds the ordering, the execution recheck and the atomic reservation; §7.1 makes settle one record. |
| Audience comes from provider data: Gmail To/Cc/Bcc are independent of `thread_id`, Slack shared channels reach externals, calendar changes notify | The module audience hook, `invite` and `unknown` → ask; `company_domains` is explicit and empty by default. |
| Caretaker identity had no single durable form (`task_join` keys per agent; `isOwnPart` rejects agent-created parts) | The kernel `care` binding table (§4), and parts created with the owner's client (§5.2). |
| Routing and pause races; the detector can bypass the drip | The adoption queue is shared with the detector; a `care_off` admission hold; rechecks. |
| Settle must survive a crash and lose to an owner reopen; cancel closes linked PRs | Settle is `done` or `handover` only, bound to the parent's version, finished by reconcile (§7.1). |
| A plain parent comment wakes no part; `@mention` already delivers; events carry no marker-format source | A new comment-wake rule, `@mention` kept, and the source index moved to phase 3 with normalised identity (verified in `wakes.ts` and `map.ts`). |
| Intake requires Slack; grants allow drafts only | The Gmail-only install changes and the grant additions (§13, §16). |
| Cut `task_status` and `care.status`: crew already summarises the latest comment (`crew.ts` `summaryOf`, verified) | Status is the part's state plus its latest comment summary. |
| Replace the 7-day re-settle timer with one correction | After an owner reopen, the next settle is `ask` (§7.1). |
| Use `sentence:` as presentation on the existing teammate page | §8. |

### Pass 1: not taken

None. One more simplification was also taken: there is no adoption notification from Aiden. The crew lines show the
result, and phase 2's "Handled for you" counts it.

### Pass 2: taken

| Finding | What changed |
|---|---|
| `lane.ts` does not serialise routing (the per-task lock is in-memory in `wakes.ts`; board writes commit first) | Routing is a durable intent plus a parent-keyed idempotency key, recovered at start; admission rechecks (§5.2). The doc's earlier lane claim was wrong. |
| Keep caretaker authority distinct from crew | The binding is authority only. `task_join`, mentions, handoff and escalation stay (§4), and the binding is scoped to the assignee user and company. |
| Paperclip has no conditional close | One writer (the plugin) re-reads the version; settle records its steps; recovery respects a later reopen; the residual race falls to the correction path (§7.1). This is stated as a narrowed race, not a guarantee. |
| Send authority came from agent-written markers | A verified source identity is recorded at filing from the event; tasks without one get no automatic reply destination; the Gmail audience is the current message's, not the thread's history; the record binds audience and head (§7.2). |
| Calendar notifications, RSVPs, Rhea's existing delete, inline forward and replay paths, the send day, vacation control | §7.2: `invite`, RSVP as `calendar`, `calendar_cancel` in phase 1, checks on every execution path, the reservation on the execution day, and care off as the pause. |
| The `gmail-writes` skill still requires an explicit ask | Updated in phase 1 (§17). |
| Wake keys are global; Intake's comment is agent-authored; `FOR_OTHERS`; the board assumes Rhea | §6.3 adds keys with destination, author, the `FOR_OTHERS` skip, and the board's own agent read from the binding. |
| Echo matching by text hash can suppress the owner's own reply | Correlation by provider id, at batch drain for Slack and in the scan for Gmail; an `unknown` outcome is reconciled (§7.2). |
| The Gmail-only install needs more than `slack?` | §16 lists the exact changes, a test, and Tess's coverage kept across the migration. |
| Reuse status-change facts for reopen | There is no `care.reopened` fact; the reopen is read from the existing `reopen:` keys. |
| Defer "Handled for you" and the detector | Both moved to phase 2. |
| Keep `task-replies`' eval cases; shared meeting actions | Kept (§17). A shared action settles only the owner's part: the evidence is his contribution, and the other attendee's commitment stays with its own task. |

### Pass 2: not taken

- **A fully conditional close (a Paperclip change):** not taken. A Paperclip compare-and-set would need patching the
  pinned upstream. The owner's reopen after a lost race is already a correction (the next settle asks), so the residual
  millisecond race costs one wrong close that the owner reverses with one click. That is not worth forking Paperclip.
