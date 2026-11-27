# Modules: the kernel contract

A module author builds against the kernel's routes, not Paperclip's. This page covers the task routes a module
service calls and the rules the kernel applies to each; the wider `module.yaml` surface is in
[configuration.md](configuration.md#modules), and the kernel's own routes are listed in `kernel/src/backplane.ts`.

Every call carries the module's own token. A route that names a role is refused with 403 unless the module's
`module.yaml` `roles.requests` lists it; the compiler writes that list into the grants table.

### A refusal's shape

A refused call answers a 4xx (or a 5xx for an upstream failure) with one error body, and the client
the kernel is called through (`kernel/sdk/src/kernel-client.ts`, copied into every module that calls it) throws it
as a `KernelError`:

```json
{ "error": { "code": 403, "type": "no-grants", "message": "agent <id> has no grants" } }
```

`status` is the HTTP status; `body.type` names the refusal (`no-grants`, `not-your-agent`, `bad-profile`,
`task-not-assigned`, `provenance-unsettled`, `task-closed`, `job-running`, `wake-not-claimed`, …) and `body.message`
is the kernel's own words, so a module can say on a task what it was refused and by which rule without re-parsing the
message. `body` is absent when the answer carried none. Retry a refusal the kernel can clear on a recompile or a
re-queue (`no-grants`, `not-your-agent`, `bad-profile`, `task-not-assigned`, `provenance-unsettled`) a bounded number
of times; a refusal that never changes is final. A refusal that shows the wake stale (`task-not-assigned`, a missing task, `task-closed`) drops it with a log line and no notice: a closed task takes no work by design, so a refusal for it is bookkeeping. Never retry a 429 as a refusal: that is "busy", and
the work stays where it is until it comes back.

## What a connection answers: a need, or a signed-in success

A connection's MCP server answers a tool call it cannot serve, where only the owner can fix why, with `needsOwner(need)`
(`kernel/sdk/src/vendor/needs.ts`, byte-identical in every connection). The proxy records the connection as down, tells the
owner, and wakes the waiting task when it clears; the agent reads the kernel's own words, never the need's.

```ts
type Need = { cause: "not_connected" | "expired" | "scope" | "sso" | "restricted"; detail: string; scope?: string; org?: string; url?: string; account?: string };
```

`account`: the account of a multi-account connection a need is about (an `expired` sign-in, say). The down state is keyed
by it, so a healthy account's success never clears another's need and only that account's tasks wake. Omit it and the
need is about the whole connection, as github, jira and slack's are.

A successful answer a connection's sign-in served is marked `signedIn(result, account?)`: it is the only answer that
clears a full need (`not_connected`, `expired`), and with `account` it clears that account alone. Mark only the account
that actually served the call: an answer from one account proves nothing about another whose sign-in failed.

## `POST /v1/codehost/<op>` — a module's typed code host operations

Grant: the module's `module.yaml` `codehost:` block, per op. The kernel checks the grant and every field's shape, then
calls the code host module, which holds the GitHub sign-in: no op returns a token.

```yaml
codehost:
  read: { repos: [ "@product" ] }                     # a PR, or a repo's open PRs
```

## `POST /v1/tasks` — file a task

Grant: `kernel.tasks`.

```json
{ "title": "...", "description": "...", "role": "platform-engineer", "source": "dependabot:acme/app/7", "parent": "<task id>" }
```

Send `role` (an agent holding it is assigned) or `agent` (an agent by Paperclip id), never both. The kernel appends
`<!-- source:<source> -->` and `<!-- aidenhq-module:<module> -->` to the description itself; text in the request never
adds a marker. Filing the same `source` twice answers the first task with `deduplicated: true`, so a restarted service
adopts its own task instead of opening a second one.

## `GET /v1/tasks?source=<family>` — list a module's own tasks

Grant: `kernel.tasks` (the same role as filing; no extra role is needed).

```http
GET /v1/tasks?source=<module>:
```

**Accepts** a module token and a `source` that starts with the caller's own module name (`<module>:…`, for example the
design module's `design:pass:`), or, for `github` alone (the module that owns the release train, its code host part),
`release:instance:`. Only open tasks are returned. A `<module>:` row is the one the kernel's filing record says this module
filed under that family; a release row is one whose description carries `<!-- source:release:instance:<40-hex sha> -->`. The
answer is `{ tasks: [{ id, identifier, status, createdAt, source }] }`.

**Refuses** with 400 any other `source:` family and any other caller. A row that merely mentions the family in prose is never
returned: the kernel checks each row again rather than trusting the control plane's text search. A row that carries another
module's `<!-- aidenhq-module:… -->` marker is not the caller's either, so it is never returned (see the close rule below).
No route lists another module's family.

## `POST /v1/tasks/:task/close` — close a task the module filed

Grant: `kernel.tasks`.

```json
{ "status": "cancelled", "body": "**Not landed:** it was approved but failed: <reason>." }
```

`status` is `done` only when the write did what the task exists for, and `cancelled` for every other ending. The
release train's bump closes `done` only when its apply card ended `done`, and `cancelled` when its card ended failed,
unknown, rejected, cancelled or stale — or when filing the apply was refused for good.

The rule, for every module: the task's description carries this module's `<!-- aidenhq-module:<module> -->` marker
and **no other** module's marker, and the task has no `createdByAgentId`. Every other task is refused with 403,
whatever its source and whatever card it holds.

A task with a second module's marker is refused even when it also carries this module's: neither module may close it
as its own, so a task that more than one module has touched is settled by a person. There is no release-specific
widening — a task without a module marker is refused, and a task with no `kernel.apply` record is admitted only by the
marker rule above.

## `POST /v1/tasks/:task/comment` — add a line to a task the module filed

Grant: `kernel.tasks`.

```json
{ "body": "**ACME-1 is still blocked.** Its latest reason: ..." }
```

The same ownership rule as closing it: the description carries this module's `<!-- aidenhq-module:<module> -->` marker and no
other module's, and no agent made the task. Every other task is refused with 403, an unknown one with 404, an empty `body` with 400.

The line is posted as the card's own agent through the kernel's post path, so it carries the kernel's own tag
(`<!-- aidenhq:job=<task> kind=comment -->`): it wakes nobody and is never read as the owner's words, and the control plane's
reopen never runs, so a card its delegator has closed stays closed. A closed or cancelled task takes no comment and answers
`{ "comment": "", "already": true }`; one with no agent assignee is refused with 409.

Use it to keep a card the module already opened current — a module that dedupes its escalations by episode posts the newest
reason here instead of filing a second card.

## `GET /v1/wakes/pending?task=<task>` — is a wake still waiting for a task?

Grant: `kernel.jobs`.

```http
GET /v1/wakes/pending?task=<task id>
```

Answers `{ "pending": true | false }`: whether the kernel still holds a wake for the task that has not started a job —
an open row (due now or scheduled for later), or one a dispatcher has claimed whose job has not started. A task with a
live job is not pending: read `GET /v1/jobs?task=<task>` for that. The two together say whether a task is in flight.

Only a wake for an agent this module dispatches counts; a task the module does not dispatch answers `false`. The task is
read by id and must match `[\w.:-]{1,100}`; anything else is refused with 400. The answer is a read only: nothing is
claimed or changed.

Dispatch uses it before folding a routine run into an earlier open run of the same routine (`routines.ts`): an earlier
run whose job ended and left no wake is idle, not in flight, so a new run proceeds instead of being cancelled into it.

## Job views: a refused write and its rule code

Grant: `kernel.jobs`, for `GET /v1/jobs?open=1` and `GET /v1/jobs?task=<task>`.

A job the kernel admits carries `refused` when its last write was refused at plan time and nothing later went through: the
words the refusal gave (`<kind>: <reason>`). A refusal whose kind names a rule also carries `refusedCode`, that rule's stable
identifier, so a dispatcher matches the code and never the message's prose. A write that goes
through clears all of them. `executor@1` sends the code beside its words in the plan's 422
(`{ "error": "...", "code": "..." }`); a module whose plan throws an error carrying `code` needs no more than that, and a
refusal with no code answers without one.

A coded refusal also carries `refusedKind` and `refusedSource`: the kind the caller asked for, and the module whose kind the
kernel routed (the `module` of the kind's entry in the registry). Neither is anything the executor says — the code is the
executor's, so the kernel records the kind and module it routed itself. All three together name a rule: a dispatcher that acts
terminally on a code without checking them would let any executor block a task by returning someone else's code, and the
module alone is too broad, since another kind in the same module could return the same code.
