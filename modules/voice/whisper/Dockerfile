# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

# Rebuild of the upstream v1.10.0 image on patched bases: python:3.12 slim on Debian trixie (3.12.16; bookworm's
# remaining high and critical rows have no fix in Debian, and the full trixie image ships fixable libpq and
# libopenexr builds), static ffmpeg 9.0.2 and refreshed Python dependencies.
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM swaggerapi/swagger-ui:v5.35.0@sha256:3e7305b17cb806a2925ed16145eae469a6084ab50d82fcec7ede600bba91650b AS swagger-ui

FROM python:3.12.16-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

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
# pyannote-audio 4 sends usage metrics to an external endpoint by default; this service keeps audio and its metadata on the host.
ENV PYANNOTE_METRICS_ENABLED=false

# Deliberately no torchcodec: its wheels link the shared FFmpeg 4-7 libraries (libavcodec.so.61 and friends) and this image
# ships the static FFmpeg 9 CLI only, so it cannot load on any architecture; it also has no Linux aarch64 wheel. whisperx
# hands pyannote-audio 4 an in-memory waveform, which is the path this service takes, so decoding still works without it.
WORKDIR /app
ADD --checksum=sha256:fe37ff1a8b2dd6fe308b0c8cd17a9b61a04bc6375a0377046d0f4849c07b8128 https://github.com/ahmetoner/whisper-asr-webservice/archive/da8044cdd11a20068abedf56de9d8f5ba9da26f5.tar.gz /tmp/src.tar.gz
RUN tar -xzf /tmp/src.tar.gz --strip-components=1 -C /app && rm /tmp/src.tar.gz

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --from=swagger-ui /usr/share/nginx/html/swagger-ui.css swagger-ui-assets/swagger-ui.css
COPY --from=swagger-ui /usr/share/nginx/html/swagger-ui-bundle.js swagger-ui-assets/swagger-ui-bundle.js

# The whisperx/pyannote set goes in with --no-deps, so prove no transitive dependency is missing: every line pip check
# reports must be one of the two tolerated kinds. (1) whisperx and pyannote declare torchcodec, which this image omits on
# purpose - its wheels load the shared FFmpeg 4-7 libraries the image does not ship, and whisperx passes pyannote an
# in-memory waveform instead. (2) whisperx 3.8.6's own metadata bounds (torch~=2.8.0, torchaudio~=2.8.0,
# torchvision~=0.23.0, huggingface-hub<1.0.0) name the vulnerable torch line this change removes; no whisperx release
# declares 2.10. Poetry's own dev-only extras are excluded too: poetry installs them outside the app environment.
# Anything else - a genuinely missing package from a future bump - fails the build here rather than the first request, and a
# pip check that cannot run at all (exit 2+) fails it too instead of passing silently on empty output.
RUN poetry config virtualenvs.in-project true \
 && poetry install --extras cpu \
 && "$POETRY_VENV/bin/pip" install pillow==13.0.0 certifi==2026.10.23 nltk==3.10.4 \
 && "$POETRY_VENV/bin/pip" install --no-deps av==19.0.2 \
 && "$POETRY_VENV/bin/pip" install --no-deps -U --index-url=https://download.pytorch.org/whl/cpu "torch==2.10.0" "torchaudio==2.10.0" "torchvision==0.25.0" \
 && "$POETRY_VENV/bin/pip" install --no-deps -U "whisperx==3.8.6" "pyannote-audio==4.0.7" "pyannote-core==6.1.0" "pyannote-database==6.1.1" "pyannote-metrics==4.2.0" "pyannote-pipeline==4.1.0" "pyannoteai-sdk==0.4.0" "optuna==5.0.0" "grpcio==1.85.1" "googleapis-common-protos==1.76.0" "opentelemetry-api==1.45.2" "opentelemetry-sdk==1.45.2" "opentelemetry-semantic-conventions==0.66b2" "opentelemetry-proto==1.45.2" "opentelemetry-exporter-otlp==1.45.2" "opentelemetry-exporter-otlp-common==0.66b2" "opentelemetry-exporter-otlp-proto-common==1.45.2" "opentelemetry-exporter-otlp-proto-http==1.45.2" "opentelemetry-exporter-otlp-proto-grpc==1.45.2" "opentelemetry-exporter-http-transport==0.66b2" \
 && "$POETRY_VENV/bin/pip" install --no-deps -U "aiohttp==3.14.5" "black==26.10.1" "urllib3==2.8.0" "lightning==2.6.6" "pytorch-lightning==2.6.6" "yarl==1.25.1" "dulwich==1.2.21" "poetry==2.5.1" "poetry-core==2.5.0" "virtualenv==21.15.5" "pymdown-extensions==12.3" "filelock==4.2.9" "python-discovery==1.9.4" "pbs-installer==2026.10.25" "distlib==0.4.4" \
 && { "$POETRY_VENV/bin/pip" check > /tmp/pip-check.txt 2>&1 || [ $? -le 1 ]; } \
 && ! grep -vE '^(poetry [0-9.]+ requires |No broken requirements found\.$|(pyannote-audio|whisperx) [0-9.]+ requires torchcodec, which is not installed\.$)' /tmp/pip-check.txt | grep -vE '^whisperx [0-9.]+ has requirement (huggingface-hub<1\.0\.0|torch~=2\.8\.0|torchaudio~=2\.8\.0|torchvision~=0\.23\.0), but you have ' | grep -q . \
 && "$POETRY_VENV/bin/python" -c "import app.factory.asr_model_factory, app.asr_models.mbain_whisperx_engine, app.asr_models.faster_whisper_engine"

# whisperx 3.8 renamed DiarizationPipeline(use_auth_token=…) to token= and inserted num_speakers ahead of the speaker
# limits, switched its default model from pyannote/speaker-diarization-3.1 to the separately gated
# pyannote/speaker-diarization-community-1, and the vendored adapter has two problems on this stack:
#  - the pinned adapter would raise TypeError with an HF_TOKEN set and misapply min/max speakers - fixed by the signature
#    change below, with both calls bound against the installed package so a future whisperx bump fails the build;
#  - it built the diarization pipeline inside load_model(), which webservice.py calls at import, so an HF_TOKEN without
#    the new model's gate failed the whole service at startup - plain transcription included - and the first download ran
#    on the ASGI event loop. Now the load is a daemon thread off the request path, a failure only disables diarization,
#    and a request that asks for speakers builds it on demand. A deployment using diarization must still accept the
#    community-1 gate on its Hugging Face account. Diarization has its own lock: the ASR model lock is held by
#    transcribe() and language_detection() on async routes, so building the pipeline under it (as the first cut did)
#    made a plain request wait on the Hugging Face download, on the event loop.
# transcribe() keeps the model lock across alignment, so the idle monitor cannot evict the model between the ASR pass and
# the align step (both read self.model). Diarization stays outside that lock: diarize_model() takes diarize_lock first,
# so holding model_lock around it would invert the lock order against the prewarm and deadlock.
# diarize_model() holds no reference to self.model across the download, and stores the pipeline into whatever dict is
# current when it finishes: keeping the dict it started with would pin the ASR models through an idle eviction.
# load_model() also has to recreate its dict: release_model() sets self.model to None on idle eviction, and
# whisperx is the one engine whose load_model assigns into it, so a reload after eviction raised TypeError.
RUN sed -z -i \
      -e 's/from threading import Thread/from threading import Lock, Thread/' \
      -e 's|    def __init__(self):\n        super().__init__()\n|    def __init__(self):\n        super().__init__()\n        self.diarize_lock = Lock()\n|' \
      -e 's/use_auth_token=CONFIG\.HF_TOKEN/token=CONFIG.HF_TOKEN/' \
      -e 's/(audio, min_speakers, max_speakers)/(audio, min_speakers=min_speakers, max_speakers=max_speakers)/' \
      -e 's|    def load_model(self):\n        asr_options|    def load_model(self):\n        if self.model is None:\n            self.model = {\x27whisperx\x27: None, \x27diarize_model\x27: None, \x27align_model\x27: {}}\n        asr_options|' \
      -e 's|        if CONFIG\.HF_TOKEN != "":\n            self\.model\[.diarize_model.\] = DiarizationPipeline(\n                token=CONFIG\.HF_TOKEN,\n                device=CONFIG\.DEVICE\n            )|        if CONFIG.HF_TOKEN != "":\n            Thread(target=self.prewarm_diarize, daemon=True).start()|' \
      -e 's|        Thread(target=self\.monitor_idleness, daemon=True)\.start()\n\n    def transcribe(|        Thread(target=self.monitor_idleness, daemon=True).start()\n\n    def prewarm_diarize(self):\n        try:\n            self.diarize_model()\n        except Exception as error:\n            print(f"Diarization unavailable, transcription continues without it: {error}")\n\n    def diarize_model(self):\n        with self.diarize_lock:\n            with self.model_lock:\n                if self.model is None:\n                    self.load_model()\n                if self.model[\x27diarize_model\x27] is not None:\n                    return self.model[\x27diarize_model\x27]\n            pipeline = DiarizationPipeline(token=CONFIG.HF_TOKEN, device=CONFIG.DEVICE)\n            with self.model_lock:\n                if self.model is None:\n                    return pipeline\n                self.model[\x27diarize_model\x27] = pipeline\n                return pipeline\n\n    def transcribe(|' \
      -e 's|        if result\["language"\] in self\.model\[.align_model.\]:\n            model_x, metadata = self\.model\[.align_model.\]\[result\["language"\]\]\n        else:\n            self\.model\[.align_model.\]\[result\["language"\]\] = whisperx\.load_align_model(\n                language_code=result\["language"\], device=CONFIG\.DEVICE\n            )\n            model_x, metadata = self\.model\[.align_model.\]\[result\["language"\]\]\n\n        # Align whisper output\n        result = whisperx\.align(\n            result\["segments"\], model_x, metadata, audio, CONFIG\.DEVICE, return_char_alignments=False\n        )|        with self.model_lock:\n            if self.model is None:\n                self.load_model()\n            if result["language"] in self.model[\x27align_model\x27]:\n                model_x, metadata = self.model[\x27align_model\x27][result["language"]]\n            else:\n                self.model[\x27align_model\x27][result["language"]] = whisperx.load_align_model(\n                    language_code=result["language"], device=CONFIG.DEVICE\n                )\n                model_x, metadata = self.model[\x27align_model\x27][result["language"]]\n\n            # Align whisper output\n            result = whisperx.align(\n                result["segments"], model_x, metadata, audio, CONFIG.DEVICE, return_char_alignments=False\n            )|' \
      app/asr_models/mbain_whisperx_engine.py \
 && sed -i -e "s/self\.model\['diarize_model'\](audio, min_speakers=min_speakers, max_speakers=max_speakers)/self.diarize_model()(audio, min_speakers=min_speakers, max_speakers=max_speakers)/" app/asr_models/mbain_whisperx_engine.py \
 && ! grep -q 'use_auth_token' app/asr_models/mbain_whisperx_engine.py \
 && "$POETRY_VENV/bin/python" -c "import inspect; from whisperx.diarize import DiarizationPipeline as D; p = inspect.signature(D.__init__).parameters; assert 'token' in p and 'use_auth_token' not in p; inspect.signature(D.__call__).bind(None, None, min_speakers=1, max_speakers=2)" \
 && "$POETRY_VENV/bin/python" -c "import ast; t = ast.parse(open('app/asr_models/mbain_whisperx_engine.py').read()); f = {n.name: n for n in ast.walk(t) if isinstance(n, ast.FunctionDef)}; u = lambda name: any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(f['load_model'])); assert not u('DiarizationPipeline'), 'diarization model must not load at startup'; assert 'prewarm_diarize' in f and 'diarize_model' in f, 'deferred diarization helpers missing'; assert any(isinstance(x, ast.Assign) and any(isinstance(y, ast.Attribute) and y.attr == 'model' for y in x.targets) and isinstance(x.value, ast.Dict) for x in ast.walk(f['load_model'])), 'load_model must recreate the model dict after idle eviction'; assert any(isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr == 'diarize_model' for x in ast.walk(f['transcribe'])), 'transcribe must go through diarize_model()'; wi = lambda n: [i.context_expr for i in n.items]; hl = lambda n, a: any(isinstance(x, ast.Attribute) and x.attr == a for c in wi(n) for x in ast.walk(c)); assert any(isinstance(n, ast.With) and hl(n, 'diarize_lock') and any(isinstance(x, ast.Call) and isinstance(x.func, ast.Name) and x.func.id == 'DiarizationPipeline' for x in ast.walk(n)) for n in ast.walk(f['diarize_model'])), 'the diarization download must be serialised by its own lock'; assert not any(isinstance(n, ast.With) and hl(n, 'model_lock') and any(isinstance(x, ast.Call) and isinstance(x.func, ast.Name) and x.func.id == 'DiarizationPipeline' for x in ast.walk(n)) for n in ast.walk(f['diarize_model'])), 'the diarization download must not hold the ASR model lock'; assert not any(isinstance(x, ast.Assign) and isinstance(x.value, ast.Attribute) and x.value.attr == 'model' for x in ast.walk(f['diarize_model'])), 'diarize_model must not keep a reference to the model dict across the download'; assert any(isinstance(n, ast.With) and any(isinstance(x, ast.Attribute) and x.attr == 'model_lock' for i in n.items for x in ast.walk(i.context_expr)) and any(isinstance(x, ast.Attribute) and x.attr == 'align' for x in ast.walk(n)) for n in ast.walk(f['transcribe'])), 'transcribe must hold the model lock across alignment'"

EXPOSE 9000

ENTRYPOINT ["whisper-asr-webservice"]
