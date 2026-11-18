# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

# Rebuild of the upstream v1.10.0 image on patched bases: python:3.12 slim on Debian trixie (3.12.16; bookworm's
# remaining high and critical rows have no fix in Debian, and the full trixie image ships fixable libpq and
# libopenexr builds), static ffmpeg 9.0.2 and refreshed Python dependencies.
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM swaggerapi/swagger-ui:v5.34.1@sha256:59ee9021a8884437c7fd8aae79e0a46ee6b6dd3afd7f24a587c4501585fde53b AS swagger-ui

FROM python:3.15.2-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

LABEL org.opencontainers.image.source="https://github.com/ahmetoner/whisper-asr-webservice"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends imagemagick libpq5 libpq-dev \
 && rm -rf /var/lib/apt/lists/*

ENV POETRY_VENV=/app/.venv
RUN python3 -m venv "$POETRY_VENV" \
 && "$POETRY_VENV/bin/pip" install pip==26.3 setuptools==84.0.0 \
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
 && "$POETRY_VENV/bin/pip" install pillow==13.0.0 certifi==2026.10.23 nltk==3.10.4 \
 && "$POETRY_VENV/bin/pip" install --no-deps av==19.0.2 \
 && "$POETRY_VENV/bin/pip" install --no-deps -U "aiohttp==3.14.5" "black==26.10.1" "urllib3==2.8.0" "lightning==2.6.6" "pytorch-lightning==2.6.6" "yarl==1.25.1" "dulwich==1.2.21" "poetry==2.5.1" "poetry-core==2.5.0" "virtualenv==21.15.5" "pymdown-extensions==12.3" "filelock==4.2.9" "python-discovery==1.9.4" "pbs-installer==2026.10.25" "distlib==0.4.4"

EXPOSE 9000

ENTRYPOINT ["whisper-asr-webservice"]
