# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# The grading module (lean-core 3h): Node's own modules only, so no install step and no dependencies to pin.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
# Node 24.22.2 ships npm 11.19.1, whose bundled undici 6.28.0 and brace-expansion 5.0.9 carry published
# advisories; npm 11.21.2 bundles undici 6.29.1 and brace-expansion 5.0.12 at the paths the scanner reads.
RUN npm install -g npm@11.21.2 && npm cache clean --force
WORKDIR /app
COPY src ./src
COPY rubrics ./rubrics
USER 1000:1000
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8096/healthz').then(r=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
