# Grafana with its provisioning and dashboards baked in (modules ship no bind mounts); release date in docs/design/monitoring.md.
FROM grafana/grafana:13.3.1@sha256:0615ec4fbd4072004b7d86b46ded63013a74b7d6eb1119273dd89e8fa25c13cf
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana-dashboards
