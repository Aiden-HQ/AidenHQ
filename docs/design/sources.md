# Shared sources and the warehouse

Each external system (Slack, GitHub, Jira, HubSpot, Drive, meeting notes, security findings) is ingested once into the shared
warehouse (Postgres). Every agent that needs that data reads rows that are new since its own cursor, instead of re-crawling the
live system. Ingest is code only; judgment about the rows stays with each consumer. One stored copy per source means a live
feed (such as the Slack event queue) is never drained by one consumer, bot posts and edits are kept, and backfilled items never
look like recent changes.

## Writers

Each source has exactly one writer, contributed by its module through the `warehouse.sources` point
(`modules/warehouse/schemas/sources.json`; compiled to `config/points/warehouse.json`, one module per schema). A writer logs in
to the warehouse as its own role `src_<source>`, owns the schema `src_<source>`, creates its tables and views at start and grants
SELECT on its views to `agents_open`. The roles, schemas and shared `src_meta` tables are set up by
`modules/warehouse/apps/warehouse/sources.sql`.

| Schema | Writer | Covers |
|---|---|---|
| `src_slack` | slack-live | Every Socket Mode event the owner's token receives, before any filtering: bot posts, thread replies, edits (a new revision; the old text goes to the change log), deletes (tombstones that keep no copy of the text). A 15-minute gap sync with the owner's user token covers disconnects; a weekly full re-read of the last week tombstones what Slack no longer returns. |
| `src_telegram` | telegram-live | Every chat of the owner's own Telegram account (TDLib, signed in by QR): messages with their reply and forward context, edits (a new revision; the old text goes to the change log), deletes (tombstones that keep no copy of the text), chats and users. Reading never marks a chat read. A first sync of the last 30 days, newest chats first, then every update live. |
| `src_github` | github-mcp | Issues and PRs in the configured orgs, and every Projects v2 board found in them (items and field values), using the owner's GitHub sign-in (background calls keep a 20% rate-limit reserve). Every 15 minutes. |
| `src_jira` | jira-mcp | Issues, sprints and boards for the configured site, and Confluence pages (metadata and a search excerpt). Runs inside jira-mcp so there is one OAuth token pair and one refresh. |
| `src_hubspot` | hubspot-mcp | Contacts, companies, deals and activities. Runs inside hubspot-mcp, sharing its OAuth token pair. |
| `src_docs` | google-workspace-mcp | Drive file metadata for the primary account (30-day baseline, then every change). A separate pass stores a short summary of Docs and Slides. |
| `src_meetings` | ops-mcp | Every published meeting note, read from ops-mcp's own records (full note, capped, with a tombstone if it disappears). |
| `src_security` | security scanner | Findings in what the instance runs, by target. A finding reviewed as not affected is excluded from the `findings` view. |
| `src_tasks` | warehouse search service | The task search index ([task-search.md](task-search.md)); not readable by `agents_open`. |
| `src_meta` | apps-mcp and sources.sql | Shared tables, below. |

Slack is stored in full, including DMs and private channels, and is readable by every agent with warehouse read.
`channel_type` is a column so a gate could be added later; there is none today.

Long documents are stored as metadata, a cheap-model summary and a link. A summary records the revision, model and prompt
version it came from, is made only after the document has been quiet a few hours, and is a pointer, never evidence: consumers
read the document live before quoting or acting. Document text is fenced as data for the summariser, which has no tools.

## Conventions in kernel/sdk/src/source-store.ts

All writers share one `SourceStore` (a byte-identical copy lives in each connection; edit the shared one and run
`node scripts/sync-shared.ts`).

- **Typed upserts** keep `first_seen_at` and write the common columns `baseline`, `ingested_at` and `seq`.
- **`seq`** comes from one sequence, `src_meta.seq`, and is bumped whenever a row is written with a difference. "New since my
  cursor" is therefore `seq > cursor` on any view.
- **Change log.** Differences in a table's tracked fields are written to `<schema>.change` with `observed_at`. Source times
  (`source_updated_at`) are kept separate and never invented.
- **Baseline.** The first sync of a source, channel, org or board writes rows with `baseline = true` and no change-log entries.
  Consumers skip baseline rows unless they ask for them, so backfill never looks like news.
- **Text caps.** Long text is cut to about 4 KB with a `*_truncated` flag and a URL for the rest.
- **Ingest runs.** Each pass writes a `src_meta.ingest_run` row (source, scope, rows written, error, for a repo target the
  commit scanned, and `status` for a non-error marker such as a retired security target). apps-mcp reports each source's
  last good pass, whether the latest failed, and its expected pass interval (the median gap between its good passes in the
  last 24 h, whole minutes, null under 3 good passes); the Fleet Steward's detector raises a stale or failing source, and a
  failing pass is only an outage past twice the source's own interval (never under 15 minutes, never over 60, and slack's
  fixed hour).
  The configured scope list is authoritative: a source that stops syncing a scope (an org dropped from its config) writes
  `status = 'retired'` for it, and `/internal/sources` leaves a scope out of both its failing and short lists while its newest
  pass is retired, so its detector key recovers within one tick instead of after the 8-day window.
  A writer whose API gives a reliable total for a scope it read to its end records `total` and `fetched` on that pass
  (`SourceStore.run`'s `pass.complete`; HubSpot first); the Fleet Steward flags a scope whose last two such passes both fetched fewer.

## Reading

apps-mcp (`modules/apps-platform/apps-mcp/src/sources.ts`) gives agents three tools:

- `warehouse_query`: one read-only SELECT as the `readonly` login (15 s limit, 200 rows, 200,000-byte result cap). Grants are
  the real control. Rows are untrusted data.
- `source_new(view, filter, limit)`: rows of a view newer than the caller's cursor, oldest first. Filters are code: channel ids,
  repos, projects (the column each view maps them to in its module's `warehouse.sources` entry) and a full-text `q` on views
  that have one. Baseline rows are skipped. A page is at most `limit` rows (max 500) and 1 MB of row JSON, each row cut to
  20 KB; a page ended early by the size guard returns fewer rows with `capped: true`, and `more` stays true while rows remain.
  Rows younger than five seconds wait, so a transaction that took a lower `seq` but committed later is not missed.
- `source_ack(view, cursor)`: advances the cursor to what `source_new` returned, after the rows were handled.

The views `source_new` serves are the `VIEWS` table built from the contributed sources. Cursors live in `src_meta.cursor`, keyed
by the agent's identity (the kernel's assertion, never a tool argument), the view and the filter (`filter_key`: empty when
unfiltered, else a hash of the scopes and `q`, carried in the cursor token as `<seq>.<key>`), and only apps-mcp writes them.
Acking a filtered read therefore never moves another read's cursor past rows it didn't return; a filtered read starts after the
later of its own cursor and the unfiltered one. A channel, repo or project with no row in any view of that source is refused,
with the nearest real values, so a guessed scope can't read nothing silently.

## People

`src_meta.person` and `src_meta.person_identity` link a human's ids across sources. apps-mcp (`people.ts`) proposes a link only
on an exact (case-insensitive) email match across the sources' `users` tables, never on names. Bots and noreply addresses are
skipped, and a proposal is never overwritten. Confirming or rejecting a link is a decision, not something an agent infers (a
tool for the librarian role); the view `src_meta.people_identities` shows status and evidence.

## Where judgment goes

Each consumer applies its own code prefilter (channels, keywords, products) and then its own model. There is no shared extractor
and no signal webhooks. If a gate is needed later, it belongs in the consumer's read path (an optional step of `source_new`),
never in ingest, so stored rows stay raw and a gate's mistakes stay visible.
