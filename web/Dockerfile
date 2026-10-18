# web/Dockerfile — build the SPA, serve via nginx (also reverse-proxies /api to bot-core)
FROM node:22-bookworm-slim AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY shared /app/shared
COPY web/ .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
