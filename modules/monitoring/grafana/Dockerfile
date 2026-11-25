# Grafana with its provisioning and dashboards baked in (modules ship no bind mounts); release date in docs/design/monitoring.md.
FROM grafana/grafana:13.3.2@sha256:81556409ba48b2b922e0adb69a2511337d8ba7578f11962eefa6149a2d815101
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana-dashboards
