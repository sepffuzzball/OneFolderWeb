FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4317 \
    DATA_ROOT=/data/library \
    SETTINGS_DIR=/data/settings \
    THUMBNAIL_DIR=/data/thumbnails \
    BACKUP_DIR=/data/backups \
    TRASH_DIR=/data/trash
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
VOLUME ["/data/library", "/data/settings", "/data/thumbnails", "/data/backups", "/data/trash"]
EXPOSE 4317
CMD ["node", "dist/server/server/index.js"]
