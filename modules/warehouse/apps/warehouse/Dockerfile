# The upstream postgres 17.12 image on a trixie base from 2026-11-04, which predates DSA-6613-1: its zlib1g is
# 1:1.3.dfsg+really1.3.1-1+b1 (CVE-2026-85091). The base's own trixie-security suite publishes the fixed
# 1:1.3.dfsg+really1.3.1-1+deb13u1, so this installs it over the base. The install stays unpinned: an apt pin in a
# Dockerfile with no release arm is dated against noble, which does not list this Debian revision. PostgreSQL stays 17.12
# and the upstream entrypoint, locale and uid are unchanged, so the existing app-warehouse_pgdata volume needs no upgrade.
FROM postgres:17.12@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c
RUN apt-get update && apt-get install -y --no-install-recommends zlib1g
RUN rm -rf /var/lib/apt/lists/*
