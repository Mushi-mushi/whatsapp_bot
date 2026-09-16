# bot-core/Dockerfile
FROM node:20-bookworm-slim

# Build tools for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    AUTH_DIR=/data/auth \
    DB_PATH=/data/bot.db \
    API_PORT=5000

EXPOSE 5000
CMD ["npm", "run", "start"]
