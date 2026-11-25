# The upstream postgres 17.12 image on a trixie base from 2026-11-04, which predates the fixes for three of its packages:
# zlib1g is 1:1.3.dfsg+really1.3.1-1+b1 (CVE-2026-85091), libc6, libc-bin, libc-l10n and locales are 2.41-12+deb13u4
# (CVE-2026-19499, CVE-2026-5435 and twelve more), and krb5 is 1.21.3-5+deb13u1 (CVE-2026-112314, -112320, -112321,
# -112322, -112323 and -119079, DSA-6650-1). The base's own trixie and trixie-security suites publish
# 1:1.3.dfsg+really1.3.1-1+deb13u1, 2.41-12+deb13u5 and 1.21.3-5+deb13u2, so this installs them over the base. The installs
# stay unpinned: an apt pin in a Dockerfile with no release arm is dated against noble, which does not list these Debian
# revisions. CVE-2026-107778 is wont-fix in trixie, so the krb5 upgrade leaves it; the other six are cleared. PostgreSQL
# stays 17.12 and the upstream entrypoint, locale and uid are unchanged, so the existing app-warehouse_pgdata volume needs
# no upgrade.
FROM postgres:17.12@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c
RUN apt-get update && apt-get install -y --no-install-recommends zlib1g
RUN apt-get update && apt-get install -y --no-install-recommends libc6 libc-bin libc-l10n locales
# The krb5 libraries are named so apt upgrades them to trixie-security's +deb13u2 (DSA-6650-1). The install stays
# unpinned (a pin here is dated against noble, which lists no Debian revision) and the installed version is asserted
# instead, so a stale mirror fails the build rather than shipping the base's +deb13u1.
RUN apt-get update && apt-get install -y --no-install-recommends libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0 \
 && for p in libgssapi-krb5-2 libk5crypto3 libkrb5-3 libkrb5support0; do \
      v="$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null)" \
        && dpkg --compare-versions "${v:-0}" ge 1.21.3-5+deb13u2 \
        || { echo "$p is ${v:-not installed}, below 1.21.3-5+deb13u2" >&2; exit 1; }; \
    done
# pgvector for task search (docs/design/task-search.md): the base's own PGDG trixie repo, 0.8.7-1.pgdg13+2
# (published 2026-11-10). sources.sql creates the extension.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-pgvector=0.8.7-1.pgdg13+2
RUN rm -rf /var/lib/apt/lists/*
# The upstream image's gosu is its prebuilt 1.20 release (2026-10-25), cut with go1.24.6: 60 stdlib rows in the
# 2026-11-25 scan. gosu 1.20 is the newest release and its amd64 asset still carries go1.24.6, so this replaces
# /usr/local/bin/gosu with one built from gosu 1.20's source by Go 1.26.11 (2026-11-10), the release that clears the
# stdlib advisories the 1.26.9 build still carried: GO-2026-6809 (crypto/x509, fixed in 1.26.10) and GO-2026-6859
# (net/http, fixed in 1.26.11). Both downloads are verified by sha256, per architecture: the base is multi-arch and the
# documented hosts are amd64 and arm64. This stays in the final stage: a golang build stage would add that image to
# image-scan's registry scan. The toolchain, sources and downloader are deleted before the layer ends, so the image
# keeps only the rebuilt binary. .github/image-scan-exceptions.yaml ignores this path when the final
# `RUN gosu --version` is present.
RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    mkdir -p /tmp/gosu-build; \
    case "$(dpkg --print-architecture)" in \
      amd64) goarch=amd64; gosum=9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec ;; \
      arm64) goarch=arm64; gosum=6c2f29b458b5add0835f18b776f69c8881a6d88428f1484a6da55755e620757e ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/gosu-build/go.tar.gz "https://go.dev/dl/go1.26.11.linux-$goarch.tar.gz"; \
    echo "$gosum  /tmp/gosu-build/go.tar.gz" | sha256sum -c -; \
    curl -fsSLo /tmp/gosu-build/gosu.tar.gz https://github.com/tianon/gosu/archive/refs/tags/1.20.tar.gz; \
    echo "207a2045e890d3ca3326027c5f585733085960b401a49dbc00e3bb628c054cf8  /tmp/gosu-build/gosu.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gosu-build/go.tar.gz -C /tmp/gosu-build; \
    tar -xzf /tmp/gosu-build/gosu.tar.gz -C /tmp/gosu-build; \
    cd /tmp/gosu-build/gosu-1.20; \
    CGO_ENABLED=0 GOTOOLCHAIN=local GOPATH=/tmp/gosu-build/gopath GOCACHE=/tmp/gosu-build/cache \
      /tmp/gosu-build/go/bin/go build -o /usr/local/bin/gosu; \
    cd /; \
    rm -rf /tmp/gosu-build; \
    apt-mark auto '.*' > /dev/null; \
    [ -z "$savedAptMark" ] || apt-mark manual $savedAptMark > /dev/null; \
    apt-get purge -y --auto-remove; \
    rm -rf /var/lib/apt/lists/*
RUN gosu --version
