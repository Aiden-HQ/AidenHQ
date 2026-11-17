# The public HTTPS front door (scripts/front-door.mjs): Caddy, unchanged, built here so the image-scan check sees it (it
# parses requests from the Internet). caddy 2.11.9 (released 2026-11-05; this digest pushed to Docker Hub 2026-11-16),
# pinned by digest: 2.11.8 carries a high go-jose advisory (GHSA-mgcc-cww5-fp2q) that 2.11.9 fixes.
FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
