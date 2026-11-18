# Prometheus with its config baked in (modules ship no bind mounts); release date in docs/design/monitoring.md.
FROM prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06
COPY prometheus.yml rules.yml /etc/prometheus/
