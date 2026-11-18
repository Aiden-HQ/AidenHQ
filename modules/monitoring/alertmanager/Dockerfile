# Alertmanager with its config baked in (modules ship no bind mounts); release date in docs/design/monitoring.md.
# v0.35.0 (2026-11-09): klauspost/compress v1.20.3 fixes GO-2026-6865 (a security exception in .github/supply-chain-exceptions.yaml).
FROM prom/alertmanager:v0.35.0@sha256:e638797febd034838eca8b98cdbd46f951e9bf7f178777aa8669167406a9946c
COPY alertmanager.yml /etc/alertmanager/
