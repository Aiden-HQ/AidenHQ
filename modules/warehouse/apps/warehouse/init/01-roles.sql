-- Runs once, on first init of an empty pgdata volume (postgres image convention).
-- READONLY_PASSWORD is read from its secret file (/run/secrets/READONLY_PASSWORD, from the vault).
--
-- Convention: each source creates schema src_<source>, owned by its writer role (a member of
-- `writers`), and GRANTs SELECT on its curated views to agents_open unless restricted.
-- Restricted schemas (e.g. people_data) grant only to their own role, never to agents_open.
-- Apps use app_<app> schemas the same way.

\set ro_pw `cat /run/secrets/READONLY_PASSWORD`

CREATE ROLE agents_open NOLOGIN;
CREATE ROLE writers NOLOGIN;
CREATE ROLE readonly LOGIN PASSWORD :'ro_pw';
GRANT agents_open TO readonly;
ALTER ROLE readonly SET default_transaction_read_only = on;
ALTER ROLE readonly SET statement_timeout = '15s';

-- Grants are the real control; the GUCs above are only defaults a session could change.
-- readonly gets SELECT through agents_open only: no CREATE anywhere, no temp tables.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE warehouse FROM PUBLIC;
-- Never GRANT a restricted role (e.g. people_data) to readonly: the SQL tool gives each access tier
-- its own LOGIN role instead of SET ROLE, so a query can't switch tiers.
