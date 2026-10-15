# syntax=docker/dockerfile:1

FROM docker.io/library/node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM docker.io/library/debian:trixie-slim AS ytdlp
# Bumped automatically by .github/workflows/ytdlp-release.yml on every upstream release.
ARG YT_DLP_VERSION=2026.08.19
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/yt-dlp
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) bin="yt-dlp_linux" ;; \
      arm64) bin="yt-dlp_linux_aarch64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}"; \
    curl -fsSL --retry 5 -o "${bin}.zip" "${base}/${bin}.zip"; \
    curl -fsSL --retry 5 -o SHA2-256SUMS "${base}/SHA2-256SUMS"; \
    grep -E "  ${bin}\.zip$" SHA2-256SUMS | sha256sum -c -; \
    mkdir -p /opt/yt-dlp; \
    unzip -q "${bin}.zip" -d /opt/yt-dlp; \
    mv "/opt/yt-dlp/${bin}" /opt/yt-dlp/yt-dlp; \
    chmod -R a+rX,go-w /opt/yt-dlp; \
    test "$(/opt/yt-dlp/yt-dlp --version)" = "${YT_DLP_VERSION}"

FROM docker.io/library/node:24-trixie-slim AS runtime
ARG YT_DLP_VERSION=2026.08.19
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Persistent bot state (/data/state.json). Compose bind-mounts the file; without that, the anonymous
# volume is owned by the runtime user so it stays writable.
RUN mkdir -p /data && chown 1000:1000 /data
VOLUME ["/data"]
ENV NODE_ENV=production \
    PATH=/opt/yt-dlp:${PATH} \
    XDG_CACHE_HOME=/tmp/.cache \
    HEALTH_PORT=8080
LABEL org.opencontainers.image.title="discord-bot1" \
      org.opencontainers.image.description="YouTube-only Discord music bot backed by yt-dlp" \
      io.github.yt-dlp.version="${YT_DLP_VERSION}"
USER 1000:1000
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HEALTH_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.ts"]
