# Task search (hybrid keyword + meaning, over the warehouse)

Status: building (owner-approved, 2026-11-23). Replaces the board's substring text filter.

## Why

The Tasks page's text box matches substrings of title, identifier and label names, over the open tasks and the last 48 hours
of Done. The owner searches by what a task was about ("review module" for the code-review work), by a file it touched, or for
something finished weeks ago. None of that works today.

## Shape

One search operation over one warehouse row per Paperclip task, owned by the warehouse module: its `warehouse-search`
service (`modules/warehouse/search/`, module.yaml `services`) writes the rows and answers the board. The kernel knows nothing
of search; the service reads what it needs through generic kernel seams with the module's own token (`warehouse_token`):
- the control plane as the owner, `GET /v1/cp/read/*` (role `kernel.cp-read`): the issue, its comments, the company's issues
  (paged, and the 50 most recently updated), its projects and agents;
- a task's work, `GET /v1/work?task=` (role `kernel.work-read`): its PRs (`pr.opened` facts), the files its landed writes
  changed and its last job's final message, whole;
- the fact log, `GET /v1/facts?since=` (role `kernel.flow-read`): each fact's seq, type and task, for an incremental reader.

Why the warehouse module and not a module of its own: the rows live in the warehouse, the install boundary is the same (no
warehouse, no search), and one owner keeps the index, the worker, the query and the summarizer together.

- **Row** (`src_tasks.task_search`, warehouse Postgres, role and schema `src_tasks`; the service is the one writer). Key:
  the task id. Card fields (identifier, title, status, `closed_at`, assignee agent, project, label ids, priority, source
  `updated_at`), the composed document `doc`, the optional `summary` and `tags`, `content_hash` (what a summary was made from), `embed_hash`, `model`, `embedding`
  (pgvector `vector`, exact scan, no ANN index), `gen` and `deleted`. A `tsv` written with the row from its parts ('simple'
  config, GIN-indexed): the head line at weight A, the fields without their markers, and the keyword-only terms. The table comes from `tableDdl` in `kernel/sdk/src/source-store.ts`
  and `migrate()` under its advisory lock (the SourceStore pattern). Not readable by `agents_open`: the schema grants nothing to it.
  Agents get search later as a tool of the module under their own grants, never raw rows.
- **Document.** `buildDoc()` (one function, `modules/warehouse/search/src/search-doc.ts`): identifier and title; labels, project, agent,
  status; each PR (`repo#number title`, from `pr.opened` facts) and its URL; changed paths of the task's landed writes (at
  most 60, each also as its segments so `jobs.ts` and `kernel` match: Postgres keeps `kernel/src/jobs.ts` as one token).
  A write now keeps its plan's paths on its record (`records.paths`); a record filed before that gives what its stored
  card diff names, which a long diff cut short, so older tasks' paths are partial. Then the description
  (4 KB), the comments (4 KB, newest kept), the last job's final message (2 KB); then the summary and tags when present. The
  embedding input is the document cut to 8,000 characters.
- **Embedding model:** `google/gemini-embedding-001`, cosine ≥ 0.63 (the eval below), through the kernel's model
  gateway like every other call, with the source writers' key (`gateway_source_key`), so spend lands in the ledger (as
  "Source writers") and under the install's limits. The gateway gains a generic `POST /api/v1/embeddings` (priced from OpenRouter's `/embeddings/models`
  list, a catalog of its own). `provider.zdr` is forced as on every call.

## Indexing: one rebuild function

`rebuild(task, gen)` (`modules/warehouse/search/src/search.ts`) is the only writer:

1. Read the issue as the owner (`GET /api/issues/:id`). A 404 is a confirmed deletion: the row becomes a tombstone
   (`deleted`, content cleared) at `gen`. Any other failure leaves the task dirty, with backoff.
2. Read its comments and the task's work (PRs, changed paths, last final) through the kernel. Build the document.
3. `embed_hash` = sha256 of the embedding text and model. The row is always rewritten at the new generation (card fields
   fresh); an unchanged, already embedded text keeps its stored vector without a model call.
4. Summaries on (below): reuse the stored summary when the content part of the hash is unchanged, else ask the cheap model;
   a failed call means no summary this time (the row is indexed without one).
5. Embed. A failed embed still writes the row (keyword search finds it) with `embedding` null, and the task is marked again
   at a new generation (backing off to an hour), so its retry always wins over the row it wrote.
6. One statement: `INSERT … ON CONFLICT (task_id) DO UPDATE … WHERE task_search.gen < EXCLUDED.gen`. A write from an older
   generation changes nothing, so a late answer can never overwrite a newer edit or bring back a tombstone.

**Dirty queue** (`search_dirty` in the service's own SQLite, `/data/search.db`: task, gen, due, tries, backfill). `mark(task)` takes the next `gen` from one
counter and sets `due` 20 s out, keeping an earlier one, so a burst of events costs one rebuild and an edit pulls a backed-off
retry forward. Marks come from: every fact with a task (a cursor over
`GET /v1/facts`, kept beside the queue), the company's 50 most recently updated issues read every 15 s, each newer than its
row (title and description edits make no fact), and reconcile. A worker takes due rows a few at a time, live changes before reconcile's backfill (a task changed
meanwhile turns live); a row is removed only if its `gen` is still the one it rebuilt (`DELETE … WHERE task = ? AND gen = ?`).
While the warehouse can't hold the rows (down, or no pgvector yet) the queue waits untouched.

**Backfill and reconcile** are one pass, a minute after start and every six hours (a pass that didn't complete is tried
again ten minutes on), paging through the company's issues (every
status, routine runs included), with three separate rules:
- discovery: an issue with no row, or `updatedAt` newer than its row's, is marked as its page is read;
- re-embedding: a row embedded by another model is marked (the query only compares vectors of the current model);
- deletion: only after every page was read (ending on a short page) are live rows the listing never named marked, and their
  rebuild clears one only on a 404. A failed page ends the pass having marked what it saw; listing drift during a pass at
  worst marks a live task, whose rebuild finds it.

## Query

`POST /search {q, closed_before?, after?, limit?, keyword?}` on the service, the module's board provider (module.yaml
`providers.board`, bearer `warehouse_search_api_token`): the board calls it through the kernel's generic
`/v1/board-api/warehouse/search`. One operation:

1. Embed `q` (timeout 2.5 s). A failure, timeout or spend refusal sets `semantic: false` and the query goes on keyword only.
2. One SQL statement over every live row: every typed term's lexemes ANDed, the last term's as prefixes (so `WOR-12`,
   `dispat` and `kernel/src/jo` match as typed), OR `1 − (embedding <=> v) ≥ threshold` (calibrated per model by the
   eval's negative queries). Exact cosine over ~11k rows is tens of milliseconds.
3. Rank by reciprocal-rank fusion (k 60) of the keyword rank (`ts_rank_cd`) and the cosine rank.
4. Answer `{ids, done, next, semantic}`: `ids`, every match not closed before `closed_before`, ranked (ids only: the board
   holds those cards, and the answer stays far under the board API's 4 MB); `done`, the matches closed before it, newest close first, a page of `limit` after the cursor `after`
   (`closed_at|task id`), and `next` while more remain. No ranked cut anywhere, so a filter never hides the newest match.

## Board

- The text box sends the query to the board's `GET /api/search?q=` (signed-in session) 250 ms after the last keystroke; the
  board forwards it to the module through the kernel. Without the warehouse module the kernel answers 404 and the board
  says search is unavailable. Saved boards keep `text` as today.
- A card matches the text when the search hit it (identifiers are matched by the prefix search). Chips AND with it
  as today (`cardMatches` takes the hit set). Lanes keep their order and counts.
- While a query runs the field shows a small working mark; the cards stay as they were until the answer lands (no flash).
- Done also lists matching tasks closed before the 48-hour window: newest first, drawn by the board's own card projection
  (`workCard`, the brief, settings and log tasks left out; their crew, the agents on their subtasks, from the rows' parent
  links), each with its close date. The board reads pages until the
  chips keep enough to show (25, then more per "Show more"), so chips apply before any cut; the count reads "33+" while
  pages remain. Clearing the query returns Done to 48 hours. In "All tasks" the search spans every project.
- While a query stays in the field it is asked again every 30 s, so a task created or renamed meanwhile joins the hits
  (the whole answer while only the first page of older closes is read, else the hits alone, so pages read on "Show more"
  stay); a page of older closes is only ever read for the answer to the text in the field.
- `semantic: false`: a quiet note in the filter row, "Meaning search unavailable; showing keyword matches." The search
  route failing: "Search unavailable right now; showing every task." Never an empty error.

## Summaries (optional)

Warehouse module setting `search_summaries` (`on` or `off`, default `off`: quiet start). On, each rebuild whose content changed asks
`~deepseek/deepseek-flash-latest` (ZDR, through the gateway, the source writers' key) for a 2–3 sentence summary and 5–8 tags,
the task text fenced as data. They join the document, so both keyword and meaning search use them.

## Warehouse

- The image adds Debian's `postgresql-17-pgvector` (pinned); `sources.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` and
  makes the `src_tasks` role and schema in its own block (no `agents_open` grant). `init/` only runs on an empty volume, so
  both live in `sources.sql`.
- Rollout on a running install: the warehouse is stateful and redeploys only with an approval, and `ops/warehouse-sources.sh`
  creates the extension only on an image that has it. So: apply the release, deploy the warehouse once, then apply again
  (or run `ops/warehouse-sources.sh`). Until then search answers 503 (the board says so and the text hides nothing), and the
  service's queue and reconcile wait and resume on their own.
- The role's password is the warehouse module's generated secret `warehouse_src_tasks_password`; the service reaches Postgres
  on the `sources` network, like every source writer (the closed legacy link list until 3g).

## Tests

PGlite (Postgres in WASM, with pgvector) runs the real SQL offline in the module's suite (`modules/warehouse/search`): rebuild idempotency and stale-gen
rejection, tombstone safety (a partial listing deletes nothing; a late write can't resurrect), cursor paging of old closes, keyword + meaning union with
summaries off, the query-time embed failure falling back to keyword hits, live changes ahead of the backfill and an
edit pulling a backed-off retry forward, an edit found among the recently updated tasks, and older closed hits carrying
their crew. The kernel suite covers the seams: `GET /v1/facts` behind its role, and a task's work read naming its PRs, paths
and last final.

## New installs

The warehouse is in the default bundle, so search works from the first task: the row appears within a minute of a task
changing. Summaries are off. Without the warehouse module the route answers 503 and the text hides nothing, with the board's
note. Spend is cents (embeddings at $0.01–0.02 per million tokens) and counts against the install's limit.

## Eval

A one-off evaluation (2026-11-23, kept out of the repo: its queries are the owner's tasks) over the instance's ~10.8k work
tasks: 45 scored queries (paraphrases, identifiers and paths, area words, half-typed prefixes) with graded relevance sets,
and 12 queries that should match nothing, each run through the whole hybrid at the lowest threshold where no negative
query returned anything. Every call with `provider.zdr`.

| Encoder | Dim | R@5 | R@10 | MRR | nDCG@10 | Query embed p50 / p95 (from the host) |
| --- | --- | --- | --- | --- | --- | --- |
| **google/gemini-embedding-001** (cosine ≥ 0.63) | 3072 | 0.772 | 0.763 | 0.838 | 0.729 | 318 / 985 ms |
| baai/bge-m3 (≥ 0.58) | 1024 | 0.711 | 0.709 | 0.749 | 0.670 | 375 / 1124 ms |
| openai/text-embedding-3-small (≥ 0.41) | 1536 | 0.692 | 0.677 | 0.785 | 0.633 | 319 / 815 ms |
| qwen/qwen3-embedding-8b, query instruction (≥ 0.55) | 4096 | 0.753 | 0.747 | 0.773 | 0.675 | 1677 / 12833 ms |
| google/gemini-embedding-2 (≥ 0.65) | 3072 | 0.719 | 0.710 | 0.792 | 0.699 | 431 / 503 ms |

Gemini embedding 001 wins (beats 3-small on 24 queries, loses 6; Gemini embedding 2 trails it on every quality metric, paraphrase MRR 0.415 against 0.585, and under ZDR takes one input per call); about $0.15 per million tokens, under $1 to embed every task once.
Reciprocal-rank fusion (k 60) ties the best weighted blend for it and wins clearly for the others; keyword alone scores 0.652
nDCG@10, meaning alone 0.597. The threshold is calibrated per model: a model change re-runs the evaluation. Keyword ranking
follows its findings: the head line weighted A (a task's own id ranked fourth behind tasks citing it; MRR on ids 0.33 to
1.00), the label words every document carries deleted, path segments and the bare id number as keyword-only terms.
A reranker was measured in part and left out (owner): a backlog issue.

Latency (typing to rendered results): 250 ms debounce, the query embedding above, the SQL (exact cosine over 11k 3072-d rows,
the worst case where every row matches: 115 / 331 ms p50 / p95 on a laptop's Docker), the board, kernel and service hops and the
render: about 0.7 s p50 and 1.6 s p95, estimated from those parts; the deployed end-to-end figure is measured after it ships.
