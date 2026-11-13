# node 24.22.2 bookworm-slim, pinned by digest (the same base the agent computers use).
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
