# ---- Stage 1: build the web frontend ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Stage 2: install backend deps (compiles better-sqlite3) ----
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev

# ---- Stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg powers optional on-the-fly transcoding (Settings → enable transcoding).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./server/
COPY --from=web /web/dist ./web/dist

# Default data locations (override with volumes in your deployment).
ENV PORT=8686 \
    DATA_DIR=/data \
    MUSIC_DIR=/music \
    SLSKD_DOWNLOAD_DIR=/slskd-downloads

# Run as the unprivileged `node` user (uid/gid 1000) baked into the base image
# instead of root. The default data locations are created and chowned so a fresh
# container can write to them; when these paths are backed by mounted volumes or
# PVCs, the host must make them writable by uid/gid 1000 (e.g. a pod
# securityContext with fsGroup: 1000, and a one-time chown of existing data).
RUN mkdir -p /data /music /slskd-downloads \
    && chown -R node:node /data /music /slskd-downloads /app
USER node

VOLUME ["/data", "/music", "/slskd-downloads"]
EXPOSE 8686

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8686)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
