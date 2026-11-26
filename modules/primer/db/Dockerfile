# The upstream postgres 17.12 image on a trixie base from 2026-11-04. Its Debian packages are already current for the
# 2026-11-26 scan (krb5 1.21.3-5+deb13u2, glibc 2.41-12+deb13u5, openssl 3.5.9-1~deb13u1), so unlike
# modules/warehouse/apps/warehouse/Dockerfile this installs no apt upgrades. What remains is the image's own
# /usr/local/bin/gosu, its prebuilt 1.20 release (2026-10-25) cut with go1.24.6: 3 critical and 29 high stdlib rows in the
# 2026-11-26 scan. gosu 1.20 is the newest release and its assets still carry go1.24.6, so this replaces
# /usr/local/bin/gosu with one built from gosu 1.20's source by Go 1.26.11 (2026-11-10), the release that clears the
# stdlib advisories. Both downloads are verified by sha256, per architecture: the base is multi-arch and the documented
# hosts are amd64 and arm64. This stays in the final stage: a golang build stage would add that image to image-scan's
# registry scan. The toolchain, sources and downloader are deleted before the layer ends, so the image keeps only the
# rebuilt binary. .github/image-scan-exceptions.yaml ignores this path when the final `RUN gosu --version` is present.
# PostgreSQL stays 17.12 and the upstream entrypoint, locale and uid are unchanged, so the existing db volume needs no
# upgrade.
# ca-certificates and curl stay unpinned: they ride on the base image's digest (scripts/supply-chain/pins.ts), and an
# apt pin in a Dockerfile with no release arm is dated against noble, which lists no Debian revision, so it would fail
# the 7-day rule rather than pin anything real. modules/warehouse/apps/warehouse/Dockerfile installs them the same way.
FROM postgres:17.12@sha256:87c8b42f423b45d5247e6aa8fdb2e7762fec164c68a50fe3eb07e7bfcaf4dbcf
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
