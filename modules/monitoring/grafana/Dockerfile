# Grafana with its provisioning and dashboards baked in (modules ship no bind mounts); release date in docs/design/monitoring.md.
FROM grafana/grafana:13.3.0@sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana-dashboards
