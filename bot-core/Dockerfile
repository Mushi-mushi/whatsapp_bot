# bot-core/Dockerfile
FROM node:22-bookworm-slim AS build

# Build tools for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot-core

COPY bot-core/package.json bot-core/package-lock.json ./
RUN npm ci

COPY shared /app/shared
COPY bot-core/tsconfig.json ./
COPY bot-core/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/bot-core/node_modules ./node_modules
COPY --from=build --chown=node:node /app/bot-core/dist ./dist
COPY --from=build --chown=node:node /app/bot-core/package.json ./package.json
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    AUTH_DIR=/data/auth \
    DB_PATH=/data/bot.db \
    API_PORT=5000

EXPOSE 5000
USER node
CMD ["node", "dist/index.js"]
