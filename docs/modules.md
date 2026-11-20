# Modules: the kernel contract

A module author builds against the kernel's routes, not Paperclip's. This page covers the task routes a module
service calls and the rules the kernel applies to each; the wider `module.yaml` surface is in
[configuration.md](configuration.md#modules), and the kernel's own routes are listed in `kernel/src/backplane.ts`.

Every call carries the module's own token. A route that names a role is refused with 403 unless the module's
`module.yaml` `roles.requests` lists it; the compiler writes that list into the grants table.

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
GET /v1/tasks?source=release:instance:
```

**Accepts** a module token and only the `release:instance:` family: `release:instance:<40-hex sha>` (the release
train's stamp) and the runner-era `release:instance:<ms stamp>`. Only open tasks are returned, and only to
`github`, the module that owns the release train (its code host part). The answer is `{ tasks: [{ id, identifier, status, createdAt, source }] }`.

**Refuses** with 400 any other `source:` family and any other caller. A row whose description carries a marker of
another family, or merely mentions the family in prose, is never returned: the kernel matches the marker again on
every row rather than trusting the control plane's text search. A row that carries another module's
`<!-- aidenhq-module:… -->` marker is not the caller's either, so it is never returned (see the close rule below).
This is the only way a module can enumerate tasks by source; there is no route for another module's family.

## `POST /v1/tasks/:task/close` — close a task the module filed

Grant: `kernel.tasks`.

```json
{ "status": "done", "body": "**Not landed:** it was approved but failed: <reason>." }
```

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
