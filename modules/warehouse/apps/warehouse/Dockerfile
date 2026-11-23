# The upstream postgres 17.12 image on a trixie base from 2026-11-04, which predates the fixes for two of its packages:
# zlib1g is 1:1.3.dfsg+really1.3.1-1+b1 (CVE-2026-85091) and libc6, libc-bin, libc-l10n and locales are
# 2.41-12+deb13u4 (CVE-2026-19499, CVE-2026-5435 and twelve more, all fixed in 2.41-12+deb13u5). The base's own trixie
# and trixie-security suites publish 1:1.3.dfsg+really1.3.1-1+deb13u1 and 2.41-12+deb13u5, so this installs them over the
# base. The installs stay unpinned: an apt pin in a Dockerfile with no release arm is dated against noble, which does not
# list these Debian revisions. PostgreSQL stays 17.12 and the upstream entrypoint, locale and uid are unchanged, so the
# existing app-warehouse_pgdata volume needs no upgrade.
FROM postgres:17.12@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c
RUN apt-get update && apt-get install -y --no-install-recommends zlib1g
RUN apt-get update && apt-get install -y --no-install-recommends libc6 libc-bin libc-l10n locales
# pgvector for task search (docs/design/task-search.md): the base's own PGDG trixie repo, 0.8.7-1.pgdg13+2
# (published 2026-11-10). sources.sql creates the extension.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-pgvector=0.8.7-1.pgdg13+2
RUN rm -rf /var/lib/apt/lists/*
