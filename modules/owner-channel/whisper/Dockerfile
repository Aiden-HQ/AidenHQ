# syntax=docker/dockerfile:1

# Rebuild of the upstream v1.10.0 image on patched bases: current python:3.12 (3.12.16),
# Debian bookworm security updates, static ffmpeg 8.1 and refreshed Python dependencies.
FROM mwader/static-ffmpeg:8.1.2@sha256:33f770f812cbfc3de96c547157fc9faf8bd95a36481753439ffa761045167585 AS ffmpeg

FROM swaggerapi/swagger-ui:v5.9.1@sha256:fb6a252ed453401fda31654112120e3381b5c4998f0059a4e2122d8add293185 AS swagger-ui

FROM python:3.12.16-bookworm@sha256:4209fae09a3e20afd863e528bfddc235da5fd5977983e1996cd54cc9a72e6267

LABEL org.opencontainers.image.source="https://github.com/ahmetoner/whisper-asr-webservice"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends imagemagick libpq5 libpq-dev \
 && rm -rf /var/lib/apt/lists/*

ENV POETRY_VENV=/app/.venv
RUN python3 -m venv "$POETRY_VENV" \
 && "$POETRY_VENV/bin/pip" install -U pip setuptools \
 && "$POETRY_VENV/bin/pip" install poetry==2.1.3
ENV PATH="${PATH}:${POETRY_VENV}/bin"

WORKDIR /app
ADD --checksum=sha256:fe37ff1a8b2dd6fe308b0c8cd17a9b61a04bc6375a0377046d0f4849c07b8128 https://github.com/ahmetoner/whisper-asr-webservice/archive/da8044cdd11a20068abedf56de9d8f5ba9da26f5.tar.gz /tmp/src.tar.gz
RUN tar -xzf /tmp/src.tar.gz --strip-components=1 -C /app && rm /tmp/src.tar.gz

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --from=swagger-ui /usr/share/nginx/html/swagger-ui.css swagger-ui-assets/swagger-ui.css
COPY --from=swagger-ui /usr/share/nginx/html/swagger-ui-bundle.js swagger-ui-assets/swagger-ui-bundle.js

RUN poetry config virtualenvs.in-project true \
 && poetry install --extras cpu \
 && "$POETRY_VENV/bin/pip" install -U "pillow>=13.0.0" "certifi>=2026.10.18" "nltk>=3.10.3" \
 && "$POETRY_VENV/bin/pip" install --no-deps -U "av>=19.0.2"

EXPOSE 9000

ENTRYPOINT ["whisper-asr-webservice"]
