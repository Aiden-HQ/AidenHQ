-- Shared sources (docs/design/sources.md): the roles, schemas and src_meta every
-- source writer needs. Idempotent; run as the superuser by ops/warehouse-sources.sh (apply-config.sh runs it), which sets
-- the psql variables pw_src_<source> (empty = that source's module isn't enabled).
--
-- Each writer src_<source> (member of `writers`) owns schema src_<source>; it creates its own tables and views at start
-- (src/sources.ts in its connection) and grants SELECT on its views to agents_open, which `readonly` (apps-mcp's
-- warehouse tools) reads through. Every source is readable by every agent with warehouse read, Slack DMs and private
-- channels included (owner, 2026-11-11: Glean and the live tools already expose them); channel_type stays a column so a
-- gate can be added later.

SET client_min_messages = warning;
-- Passwords never appear in a statement's text: the DO block reads them from session settings, and a failed
-- CREATE/ALTER ROLE is re-raised without its statement (the error context would quote the password).
-- (This SELECT prints them: ops/warehouse-sources.sh discards psql's output.)
SELECT set_config('aidenhq.pw_src_slack', :'pw_src_slack', false),
       set_config('aidenhq.pw_src_github', :'pw_src_github', false),
       set_config('aidenhq.pw_src_jira', :'pw_src_jira', false),
       set_config('aidenhq.pw_src_meetings', :'pw_src_meetings', false),
       set_config('aidenhq.pw_src_docs', :'pw_src_docs', false),
       set_config('aidenhq.pw_src_security', :'pw_src_security', false),
       set_config('aidenhq.pw_src_hubspot', :'pw_src_hubspot', false),
       set_config('aidenhq.pw_src_tasks', :'pw_src_tasks', false),
       set_config('aidenhq.pw_src_telegram', :'pw_src_telegram', false);

DO $$
DECLARE
  r text;
  pw text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agents_open') THEN CREATE ROLE agents_open NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'writers') THEN CREATE ROLE writers NOLOGIN; END IF;

  FOREACH r IN ARRAY ARRAY['src_slack', 'src_github', 'src_jira', 'src_meetings', 'src_docs', 'src_security', 'src_hubspot', 'src_telegram'] LOOP
    pw := current_setting('aidenhq.pw_' || r);
    CONTINUE WHEN pw = '';
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE writers', r, pw);
      ELSE
        EXECUTE format('ALTER ROLE %I PASSWORD %L', r, pw);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'setting the login of % failed (SQLSTATE %)', r, SQLSTATE;
    END;
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', r, r);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', r);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO agents_open', r);
    EXECUTE format('ALTER ROLE %I SET search_path = %I, src_meta', r, r);
  END LOOP;
END $$;
SELECT set_config('aidenhq.pw_src_slack', '', false), set_config('aidenhq.pw_src_github', '', false), set_config('aidenhq.pw_src_jira', '', false),
       set_config('aidenhq.pw_src_meetings', '', false), set_config('aidenhq.pw_src_docs', '', false), set_config('aidenhq.pw_src_security', '', false), set_config('aidenhq.pw_src_hubspot', '', false), set_config('aidenhq.pw_src_telegram', '', false);

-- Task search (the warehouse module's search service, docs/design/task-search.md): src_tasks writes one row per Paperclip task, with an embedding, and
-- answers the board's searches. Not a source agents read: no agents_open grant (never raw rows for agents).
-- The extension ships with the warehouse image: an older image still running (the app redeploys on its own schedule) skips it,
-- and task search answers "unavailable" until the new image runs and this runs again; nothing else here waits on it.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_available_extensions WHERE name = 'vector') THEN CREATE EXTENSION IF NOT EXISTS vector;
  ELSE RAISE NOTICE 'pgvector is not in this warehouse image yet: task search waits for the new image';
  END IF;
END $$;
DO $$
DECLARE
  pw text := current_setting('aidenhq.pw_src_tasks');
BEGIN
  IF pw <> '' THEN
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_tasks') THEN
        EXECUTE format('CREATE ROLE src_tasks LOGIN PASSWORD %L IN ROLE writers', pw);
      ELSE
        EXECUTE format('ALTER ROLE src_tasks PASSWORD %L', pw);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'setting the login of src_tasks failed (SQLSTATE %)', SQLSTATE;
    END;
    CREATE SCHEMA IF NOT EXISTS src_tasks AUTHORIZATION src_tasks;
    REVOKE ALL ON SCHEMA src_tasks FROM PUBLIC;
    -- The extension's types and operators live in public, which init revokes from PUBLIC: this role alone may use them.
    GRANT USAGE ON SCHEMA public TO src_tasks;
    ALTER ROLE src_tasks SET search_path = src_tasks, src_meta, public;
  END IF;
END $$;
SELECT set_config('aidenhq.pw_src_tasks', '', false);

CREATE SCHEMA IF NOT EXISTS src_meta;
REVOKE ALL ON SCHEMA src_meta FROM PUBLIC;
GRANT USAGE ON SCHEMA src_meta TO writers, agents_open;

-- One sequence for every source row and change: a row's seq is bumped whenever it is written with a difference, so
-- "rows new since my cursor" is `seq > cursor` on any view.
CREATE SEQUENCE IF NOT EXISTS src_meta.seq;
GRANT USAGE ON SEQUENCE src_meta.seq TO writers;

CREATE TABLE IF NOT EXISTS src_meta.ingest_run (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  scope text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  rows integer NOT NULL DEFAULT 0,
  error text,
  commit text,
  status text
);
ALTER TABLE src_meta.ingest_run ADD COLUMN IF NOT EXISTS commit text;
-- A non-error marker for a scope that was not a normal pass (e.g. security's "retired": a target no longer in the
-- inventory whose replacement was scanned cleanly). status is null for a normal pass; error stays the failure signal.
ALTER TABLE src_meta.ingest_run ADD COLUMN IF NOT EXISTS status text;
-- A completed scope's reliable count (SourceStore.run): total = what the source reported for it, fetched = distinct records the
-- pass read. Null when the pass stopped early, resumed mid-scope or the API gives no total.
ALTER TABLE src_meta.ingest_run ADD COLUMN IF NOT EXISTS total integer;
ALTER TABLE src_meta.ingest_run ADD COLUMN IF NOT EXISTS fetched integer;
CREATE INDEX IF NOT EXISTS ingest_run_source ON src_meta.ingest_run (source, finished_at DESC);
COMMENT ON TABLE src_meta.ingest_run IS 'One row per ingest pass of a source writer: source (slack, telegram, github, jira, hubspot, meetings, docs, security, app-auditor), scope (what it covered), rows written with a difference, error when it failed, commit for a repo target (the checkout''s git HEAD, so the row says which tree the pass read), status for a non-error marker (e.g. retired), total and fetched for a completed scope whose API gave a reliable count (fetched below total = records missed).';
GRANT INSERT ON src_meta.ingest_run TO writers;
GRANT USAGE ON SEQUENCE src_meta.ingest_run_id_seq TO writers;
GRANT SELECT ON src_meta.ingest_run TO agents_open;

-- Consumer cursors (source_new / source_ack in apps-mcp), keyed by the consumer's Paperclip agent id, the view and the
-- read's filter (filter_key: '' unfiltered, else a hash of the filter), so acking a filtered read never moves the cursor of
-- another filter past rows it hasn't read; written only by apps-mcp as the superuser.
CREATE TABLE IF NOT EXISTS src_meta.cursor (
  agent_id text NOT NULL,
  view text NOT NULL,
  filter_key text NOT NULL DEFAULT '',
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, view, filter_key)
);
ALTER TABLE src_meta.cursor ADD COLUMN IF NOT EXISTS filter_key text NOT NULL DEFAULT '';
DO $$ BEGIN
  IF (SELECT array_length(conkey, 1) FROM pg_constraint WHERE conrelid = 'src_meta.cursor'::regclass AND contype = 'p') = 2 THEN
    ALTER TABLE src_meta.cursor DROP CONSTRAINT cursor_pkey, ADD PRIMARY KEY (agent_id, view, filter_key);
  END IF;
END $$;
COMMENT ON TABLE src_meta.cursor IS 'Each consumer agent''s read position (src_meta.seq) per source view and filter (filter_key '''' = unfiltered); advanced by source_ack.';
GRANT SELECT ON src_meta.cursor TO agents_open;

-- People across sources: one row per human, and each source identity (src_<source>.users) linked to one. apps-mcp
-- (modules/apps-platform/apps-mcp/src/people.ts) is the one writer: it proposes links only on an exact email match across sources,
-- never on names. Approving (or rejecting) is the owner's alone; a proposal is never overwritten.
CREATE TABLE IF NOT EXISTS src_meta.person (
  person_id bigserial PRIMARY KEY,
  display_name text,
  email text UNIQUE, -- lowercased; the email that proposed this person
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS src_meta.person_identity (
  source text NOT NULL, -- slack | github | jira
  source_user_id text NOT NULL, -- that source's users.user_id
  person_id bigint NOT NULL REFERENCES src_meta.person ON DELETE CASCADE,
  confidence real NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  evidence text NOT NULL,
  display_name text, -- as the source showed it when proposed
  email text,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (source, source_user_id)
);
ALTER TABLE src_meta.person_identity ADD COLUMN IF NOT EXISTS decided_by text; -- agent key that confirmed or rejected it (person_identity_decide)
ALTER TABLE src_meta.person_identity ADD COLUMN IF NOT EXISTS decision_reason text;
CREATE INDEX IF NOT EXISTS person_identity_person ON src_meta.person_identity (person_id);
CREATE OR REPLACE VIEW src_meta.people_identities AS
  SELECT p.person_id, p.display_name AS person_name, p.email AS person_email, i.source, i.source_user_id, i.display_name, i.email,
    i.status, i.confidence, i.evidence, i.proposed_at, i.decided_at, i.decided_by, i.decision_reason
  FROM src_meta.person p JOIN src_meta.person_identity i USING (person_id);
COMMENT ON VIEW src_meta.people_identities IS 'Who is who across sources: each source user id (join src_<source>.users on user_id) linked to a person. status proposed = matched on the same email in two or more sources, not yet confirmed by the owner; approved = confirmed. Users not listed are unlinked. Never link people by name yourself.';
GRANT SELECT ON src_meta.person, src_meta.person_identity, src_meta.people_identities TO agents_open;
