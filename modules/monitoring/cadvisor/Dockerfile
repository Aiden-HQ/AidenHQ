# cAdvisor v0.60.6's binary on Alpine 3.24 (release dates in docs/design/monitoring.md). Upstream v0.61.1, the newest release,
# is still built on Alpine 3.23, whose image ships libcrypto3/libssl3 3.5.8-r0, krb5-libs 1.22.1-r0, musl 1.2.5-r23 and zlib
# 1.3.2-r0 (v3.23 main carries openssl 3.5.9-r0 at most): the final stage here is Alpine 3.24 instead, with the base's
# packages upgraded to the v3.24 repository's.
FROM ghcr.io/google/cadvisor:v0.61.1@sha256:4929b70e82079d001d0028b85d6a4dd25ad4666b719455c9542b983489963916 AS upstream

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk upgrade --no-cache

RUN apk add --no-cache libc6-compat device-mapper findutils ndctl thin-provisioning-tools zfs && \
    echo 'hosts: files mdns4_minimal [NOTFOUND=return] dns mdns4' >> /etc/nsswitch.conf && \
    rm -rf /var/cache/apk/*

# The runtime files the published image's final stage carries; libipmctl stays off (google/cadvisor#3482).
COPY --from=upstream /usr/local/lib/libpfm.so* /usr/local/lib/
COPY --from=upstream /usr/bin/cadvisor /usr/bin/cadvisor
COPY --from=upstream /usr/bin/entrypoint.sh /usr/bin/entrypoint.sh
COPY --from=upstream /usr/bin/healthcheck.sh /usr/bin/healthcheck.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD /usr/bin/healthcheck.sh

ENTRYPOINT ["/usr/bin/entrypoint.sh"]
