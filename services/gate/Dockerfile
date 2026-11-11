# syntax=docker/dockerfile:1
# The gate: no dependencies beyond Node itself.
FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json gate.mjs main.mjs ./
USER node
CMD ["node", "main.mjs"]
