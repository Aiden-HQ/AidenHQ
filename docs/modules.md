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
`codehost-github`, the module that owns the release train. The answer is `{ tasks: [{ id, identifier, status, createdAt, source }] }`.

**Refuses** with 400 any other `source:` family and any other caller. A row whose description carries a marker of
another family, or merely mentions the family in prose, is never returned: the kernel matches the marker again on
every row rather than trusting the control plane's text search. This is the only way a module can enumerate tasks
by source; there is no route for another module's family.

## `POST /v1/tasks/:task/close` — close a task the module filed

Grant: `kernel.tasks`.

```json
{ "status": "done", "body": "**Not landed:** it was approved but failed: <reason>." }
```

The default rule: the task's description carries `<!-- aidenhq-module:<module> -->` and the task has no
`createdByAgentId`. Every other task is refused with 403, whatever its source.

**Release bumps are the one widening.** A task carrying `<!-- source:release:instance:… -->` (either stamp) may be
closed by `codehost-github` with no module marker, only when:

- it has at least one `kernel.apply` record on it — a task with no record never qualifies;
- **every** record on it was filed by `module === "codehost-github"` (a record is matched by its module name, never
  by a bare id, and one foreign or mixed record refuses the close). The kernel reads all of them, never a capped
  page, so an older foreign record can't be hidden behind newer ones;
- the release marker is its **only** source marker: a task that also carries another family's `<!-- source:… -->` is never
  listed or closed by the train, however many of the records on it are the code host's;
- no other module's marker is in its description, and it has no `createdByAgentId`.

The family is the whole widening: a task outside `release:instance:` keeps the marker rule above.

**The one card-less bump.** The runner that preceded the release train filed its bump with its millisecond stamp and
never carded it. The sweep settles that task with the same close route and `"uncarded": true` in the body. The flag
admits only a `release:instance:<ms stamp>` task whose marker is its only source marker, with no module marker and no
`kernel.apply` record at all.

Because a description can say anything, the marker is not the proof: the kernel also requires the control plane's own
record of the task — its `createdByUserId` is the owner's own control-plane user (read by the kernel from
`/api/cli-auth/me`, never from the task) with no `createdByAgentId`, and its `createdAt` is before the runner retired
with the big switch (2026-11-18T18:23:32Z) and no more than a minute after the stamp its marker names, the order the
runner's `Date.now()`-then-POST produces. A task created after the switch, one another user or an agent created, or one
whose stamp and creation are out of step, is refused however its text reads; a 40-hex train-era task with no card, or
any task with a record, is refused too. It is a separate body field on purpose: the ownership rule
above never admits a record-less task by way of an empty match.
