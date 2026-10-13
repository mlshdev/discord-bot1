# syntax=docker/dockerfile:1

FROM docker.io/oven/bun:1.4.3-slim AS bun

# yt-dlp's recommended JavaScript runtime for YouTube challenge solving (EJS).
FROM docker.io/denoland/deno:bin-2.9.7 AS deno

FROM docker.io/library/node:26-trixie-slim AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

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

FROM docker.io/library/node:26-trixie-slim AS runtime
ARG YT_DLP_VERSION=2026.08.19
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production \
    PATH=/opt/yt-dlp:${PATH} \
    XDG_CACHE_HOME=/tmp/.cache \
    DENO_DIR=/tmp/.cache/deno \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_PATH=/usr/local/bin/deno \
    HEALTH_PORT=8080
LABEL org.opencontainers.image.title="discord-bot1" \
      org.opencontainers.image.description="YouTube-only Discord music bot backed by yt-dlp" \
      io.github.yt-dlp.version="${YT_DLP_VERSION}"
USER 1000:1000
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HEALTH_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.ts"]
