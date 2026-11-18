# Shared sources and the warehouse

Each external system (Slack, GitHub, Jira, Drive, meeting notes) is ingested once into the shared warehouse
(Postgres). Every agent that needs that data reads rows that are new since its own cursor, instead of re-crawling the
live system. Ingest is code only; judgment about the rows stays with each consumer.

## Why

Several agents watched the same systems and re-crawled them. A live feed such as the Slack event queue can be drained by
one consumer only, drops bot posts and edits, and cannot be replayed. Backfilled items also looked like recent changes,
because records lacked a source time separate from the time we first saw them. One stored copy per source fixes all
three.

## Writers

Each source has exactly one writer. A writer logs in to the warehouse as its own role `src_<source>`, owns the schema
`src_<source>`, creates its tables and views at start and grants SELECT on its views to `agents_open`. The roles, schemas
and shared `src_meta` tables are set up by `modules/warehouse/apps/warehouse/sources.sql`.

| Schema | Writer | Covers |
|---|---|---|
| `src_slack` | channel-slack | Every Socket Mode event the owner's token receives, before any filtering: bot posts, thread replies, edits (a new revision; old text goes to the change log), deletes (tombstones). A 15-minute gap sync (`conversations.history`, plus replies for active threads) covers disconnects; a weekly full re-read of the last week tombstones what Slack no longer returns. |
| `src_github` | github-mcp | Issues and PRs in the configured orgs, and every Projects v2 board found in them (items and field values), using the GitHub App token. Every 15 minutes. |
| `src_jira` | jira-mcp | Issues, sprints and boards for the configured site, and Confluence pages (metadata and a search excerpt). Runs inside jira-mcp so there is one OAuth token pair and one refresh. |
| `src_docs` | google-workspace-mcp | Drive file metadata for the primary account (30-day baseline, then every change). A separate pass stores a short summary of Docs and Slides. |
| `src_meetings` | ops-mcp | Every published meeting note, read from ops-mcp's own records (full note, capped, with a tombstone if it disappears). |
| `src_security` | security scanner | Findings in what the instance runs, by target. |
| `src_meta` | apps-mcp and sources.sql | Shared tables, below. |

Slack is stored in full, including DMs and private channels, and is readable by every agent with warehouse read.
`channel_type` is a column so a gate could be added later; there is none today.

Long documents are stored as metadata, a cheap-model summary and a link. A summary records the revision, model and
prompt version it came from, is made only after the document has been quiet a few hours, and is a pointer, never
evidence: consumers read the document live before quoting or acting. Document text is fenced as data for the
summariser, which has no tools.

## Conventions in kernel/sdk/src/source-store.ts

All writers share one `SourceStore`, imported from `@aidenhq/sdk/source-store`.

- **Typed upserts** keep `first_seen_at` and write the common columns `baseline`, `ingested_at` and `seq`.
- **`seq`** comes from one sequence, `src_meta.seq`, and is bumped whenever a row is written with a difference. "New
  since my cursor" is therefore `seq > cursor` on any view.
- **Change log.** Differences in a table's tracked fields are written to `<schema>.change` with `observed_at`.
  Source times (`source_updated_at`) are kept separate and never invented.
- **Baseline.** The first sync of a source, channel, org or board writes rows with `baseline = true` and no change-log
  entries. Consumers skip baseline rows unless they ask for them, so backfill never looks like news.
- **Text caps.** Long text is cut to about 4 KB with a `*_truncated` flag and a URL for the rest.
- **Ingest runs.** Each pass writes a `src_meta.ingest_run` row (source, scope, rows written, error, and for a repo
  target the commit scanned). apps-mcp reports
  each source's last good pass and whether the latest failed, and the board's fleet-ops detector raises a stale or
  failing source.

## Reading

apps-mcp (`modules/apps-platform/apps-mcp/src/sources.ts`) gives agents three tools:

- `warehouse_query`: one read-only SELECT as the `readonly` login (15 s limit, 200 rows, size-capped). Grants are the
  real control. Rows are untrusted data.
- `source_new(view, filter, limit)`: rows of a view newer than the caller's cursor, oldest first. Filters are code:
  channel ids, repos, projects (the column each view maps them to) and a full-text `q`. Baseline rows are skipped.
  A page is at most `limit` rows (max 500) and at most 1 MB of row JSON, each row cut to 20 KB; a page ended early by
  the size guard returns fewer rows with `capped: true`, and `more` stays true while rows remain.
  Rows younger than five seconds wait, so a transaction that took a lower `seq` but committed later is not missed.
- `source_ack(view, cursor)`: advances the cursor to what `source_new` returned, after the rows were handled.

Cursors live in `src_meta.cursor`, keyed by the agent's Paperclip identity (never a tool argument), the view and the
filter (`filter_key`: empty when unfiltered, else a hash of the scopes and `q`, carried in the cursor token as
`<seq>.<key>`), and only apps-mcp writes them. Acking a filtered read therefore never moves another read's cursor past rows
it didn't return; a filtered read starts after the later of its own cursor and the unfiltered one. A channel, repo or project with no row
in any view of that source is refused, with the nearest real values, so a guessed scope can't read nothing silently. The set of views `source_new` serves is the `VIEWS` table in that file. A security finding that was
reviewed as not affected is excluded from `src_security.findings`.

## People

`src_meta.person` and `src_meta.person_identity` link a human's ids across sources. apps-mcp proposes a link only on an
exact (case-insensitive) email match across the sources' `users` tables, never on names. Bots and noreply addresses are
skipped, and a proposal is never overwritten. Approving or rejecting a link is a decision, not something an agent
infers; the view `src_meta.people_identities` shows status and evidence.

## Where judgment goes

Each consumer applies its own code prefilter (channels, keywords, products) and then its own model. There is no shared
extractor and no signal webhooks. If a gate is needed later, it belongs in the consumer's read path (an optional step
of `source_new`), never in ingest, so stored rows stay raw and a gate's mistakes stay visible.

Not built: shared LLM extraction, email sources, embeddings, per-channel resource grants, Confluence deletes.
