# discord-bot1 — technical notes

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict` plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` | Static typing everywhere |
| Runtime | **Node.js 26**, which runs `.ts` directly through built-in type stripping | `@discordjs/voice` targets Node, and the DAVE end-to-end voice encryption that Discord has required since 2026-03-01 depends on the native `@snazzah/davey` addon. Neither is validated on Bun, and voice is the critical path. |
| Package manager and scripts | **Bun** (`bun install`, `bun run`, `bun.lock`) | Fast installs. Dependabot's `bun` ecosystem tracks the lockfile. |
| Lint and format | Biome | Replaces ESLint and Prettier |
| Tests | `node:test`, run on Node | Tests run on the same runtime as production |
| Discord | `discord.js` 14, `@discordjs/voice` 0.19 | |
| Media | yt-dlp (official PyInstaller *onedir* build), audio-only; Opus passthrough, with ffmpeg (Debian) as fallback only | Avoids re-encoding wherever possible |
| yt-dlp JS runtime | **Deno** (`denoland/deno:bin-*`) | yt-dlp's recommended and only default-enabled runtime. Its challenge solver runs with no Deno permissions; yt-dlp considers Node and Bun insecure for this. |

There is no build step. Node strips the types at load time, so the source must stay within erasable syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports keep their `.ts` extension (`allowImportingTsExtensions`).

## Layout

```
src/
  index.ts      entrypoint: config, Discord client, message routing, role checks, shutdown
  config.ts     typed env parsing (ConfigError → exit 78)
  commands.ts   prefix parser → discriminated union Command
  youtube.ts    URL allowlist → canonical https://www.youtube.com/watch?v=<id>
  ytdlp.ts      yt-dlp metadata resolution + audio source (Opus passthrough, ffmpeg fallback)
  queue.ts      pure TrackQueue (enqueue/remove/move/promote/shuffle)
  player.ts     MusicPlayer: voice connection, AudioPlayer, queue advancement
  menu.ts       !!mn component UI (embed + select + buttons) and its collector
  format.ts     duration/markdown helpers
  health.ts     GET /healthz
  logger.ts     JSON-lines logger
test/           node:test unit tests for every pure module
```

## Request flow

1. `MessageCreate` events are dropped unless they come from a non-bot author in `GUILD_ID` / `TEXT_CHANNEL_ID`.
2. `parseCommand` turns the message into a `Command`. Commands in `PRIVILEGED_COMMANDS` need `member.roles.cache.has(DJ_ROLE_ID)`.
3. `!add`:
   1. `parseYouTubeUrl` checks the host against an allowlist and validates the 11-character video ID. It then rebuilds a canonical URL, so user text never reaches yt-dlp's argv, and `--` is always passed before the URL as well.
   2. `yt-dlp --print '%(.{…})j'` resolves the metadata. Live streams and premieres are rejected.
   3. The track is enqueued, and playback starts if the player is idle.
4. Playback (`YtDlp.open`):

   ```
   yt-dlp -f "bestaudio[acodec=opus]/bestaudio" -o - URL
     → demuxProbe (first 16 KiB)
       ├─ WebM/Opus or Ogg/Opus (48 kHz stereo) → createAudioResource(type)      no ffmpeg, no re-encode
       └─ anything else → ffmpeg -c:a libopus -b:a <bitrate> -f ogg → OggOpus   one encode
   ```

   - **No video, ever.** The format selector only matches audio-only formats. There is no `/best` fallback that could pick a muxed video stream, so a video without an audio-only format fails at `!add` with a clear error. `resolve()` uses the same selector, so the failure shows up before the track is queued.
   - **Transcoding is minimised.** YouTube offers Opus in WebM (itag 251/250/249) for practically every video, so the downloaded bytes are only demuxed into Opus packets and sent to Discord. Verified in the container: `webm/opus`, `transcoded: false`, with no ffmpeg process started.
   - **Fallback.** `demuxProbe` sends anything it can't validate as Discord-ready (48 kHz stereo) Opus to a single ffmpeg encode to Ogg/Opus. That covers AAC-only formats and mono Opus. The fallback was checked with an AAC input stream. `AUDIO_BITRATE_KBPS` only applies here.
   - Passthrough Opus keeps YouTube's original bitrate, about 130 kbps VBR for itag 251.
   - In both paths `@discordjs/voice` only demuxes, so no Opus encoder package (`@discordjs/opus` or `opusscript`) is needed.
   - Transport encryption uses Node's native `aes-256-gcm`.
   - DAVE is handled by `@snazzah/davey`.
5. yt-dlp needs a JavaScript runtime to solve YouTube's challenges (EJS). The bot passes `--no-js-runtimes --js-runtimes deno[:$DENO_PATH]`, so Deno is the only runtime yt-dlp can use. It can never silently fall back to Node.
   - yt-dlp starts Deno with `--no-prompt --no-remote --no-npm --no-config` and grants no permissions (no network, filesystem or env access).
   - The official onedir build bundles `yt_dlp_ejs`, so no remote components are fetched.
   - Deno's analysis cache lives in `DENO_DIR=/tmp/.cache/deno`, on the tmpfs.

### Player invariants (`player.ts`)

- `#advance()` is the only place that takes tracks from the queue, and the `#advancing` flag makes it re-entrancy-safe. `AudioPlayerStatus.Idle` is the only trigger after a track ends.
- Forced transitions (skip, play now, disconnect) kill the current yt-dlp process, and ffmpeg too if it is running, *before* calling `AudioPlayer.stop(true)`.
- `open()` is async because it waits for the probe. A `#generation` counter, bumped by `disconnect()`, throws away any source or connection attempt that finishes after the player was reset.
- A track that ends naturally keeps its processes for a 10 s grace period. That way a non-zero yt-dlp exit, such as a 403 partway through the stream, is still reported to the channel.
- If the bot cannot join voice, the track goes back to the front of the queue instead of being dropped.
- A connection that is lost for real (still `Disconnected` after 5 s, or `Destroyed`) clears the queue and posts an announcement. An intentional disconnect detaches `#connection` before calling `destroy()`, so it does not post that announcement.

### Queue manager (`menu.ts`)

- `renderMenu(snapshot, state, closed)` is a pure function of the player snapshot plus per-menu state (`page`, `selectedUid`, `notice`).
- Tracks are referenced by a per-process `uid`, never by position, so concurrent edits cannot hit the wrong track.
- Every interaction re-checks the DJ role. Unauthorised clicks get an ephemeral reply.
- The menu subscribes to `MusicPlayer`'s `change` event and re-renders, debounced to 1 s. The collector ends after 5 minutes idle, and then the components are removed.

## Container image

`Dockerfile` has four stages:

| Stage | Base | Purpose |
|---|---|---|
| `bun` | `oven/bun:1.4.3-slim` | Provides the `bun` binary only |
| `deno` | `denoland/deno:bin-2.9.7` | Provides the `/deno` binary only. Dependabot's `docker` ecosystem tracks this tag. |
| `deps` | `node:26-trixie-slim` | `bun install --frozen-lockfile --production --ignore-scripts`. Runs per native arch, so the right `@snazzah/davey-linux-*` prebuild is chosen. |
| `ytdlp` | `debian:trixie-slim` | Downloads `yt-dlp_linux[_aarch64].zip` for `YT_DLP_VERSION`, checks it against the release's `SHA2-256SUMS`, unpacks it to `/opt/yt-dlp`, and asserts `--version` |
| `runtime` | `node:26-trixie-slim` | Adds Debian `ffmpeg` (fallback only) and copies in yt-dlp, `deno`, `node_modules` and `src`. Runs as `1000:1000` with a `HEALTHCHECK`. |

The onedir yt-dlp build is used instead of the single-file binary on purpose. The single-file binary unpacks itself into `/tmp` on every start, which is slower and needs an executable `/tmp`.

Image size is about 1.2 GB. Debian's `ffmpeg` and its libraries account for roughly 420 MB and Deno for about 110 MB. `dive --ci` passes.

### Runtime hardening (verified locally with OrbStack)

- Capability probe: `cap_drop: [ALL]` with no `cap_add`, plus `read_only: true` and `no-new-privileges`. Under these settings, metadata resolution with Deno solving the challenges, Opus passthrough, the ffmpeg fallback, the health server and the config/login error paths all ran with **no permission errors**, so no capability is added back.
- The only writable path is the `/tmp` tmpfs. It holds yt-dlp's cache (`XDG_CACHE_HOME=/tmp/.cache`), Deno's cache (`DENO_DIR`) and the private copy of the cookies file. yt-dlp rewrites its cookie jar on exit, so it cannot use the read-only mount directly.
- `init: true` gives the container a real PID 1 that reaps the yt-dlp and ffmpeg child processes.

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | On `ubuntu-slim`: `biome ci`, `tsc`, `node --test` |
| `docker.yml` | every PR; push to `main` touching image inputs; Mon/Thu 03:00 UTC; `workflow_dispatch` | Native matrix (`ubuntu-26.04-arm` → `linux/arm64`, `ubuntu-26.04` → `linux/amd64`), no QEMU. Each arch builds with `--load` and is validated in a hardened container: yt-dlp version matches the pin, ffmpeg has libopus, yt-dlp detects Deno and the bundled EJS solver, Deno runs under the hardened settings, discord.js/voice/davey import, and a missing config exits 78. On `main` it then pushes by digest. A merge job builds the manifest list tagged `latest`, `ytdlp-<ver>` and `sha-<sha>`. Scheduled runs use `no-cache` and `pull` for a clean rebuild. |
| `ytdlp-release.yml` | every 30 min; `workflow_dispatch` | Polls `yt-dlp/yt-dlp` for its latest release. When the release is new and its Linux assets plus `SHA2-256SUMS` are uploaded, it rewrites `ARG YT_DLP_VERSION` in the `Dockerfile`, commits to `main`, and dispatches `docker.yml`. |
| `dependabot-automerge.yml` | Dependabot PRs | Turns on auto-merge, which waits for the required checks |

`.github/dependabot.yml` covers the `docker`, `github-actions` and `bun` ecosystems on Mon/Thu 00:00 UTC.

### Why poll and dispatch

- GitHub Actions cannot subscribe to release events from a repository you don't own, so `ytdlp-release.yml` polls upstream instead.
- Commits pushed with `GITHUB_TOKEN` do not trigger `push` workflows. That is why the watcher calls `gh workflow run docker.yml` explicitly, which needs the `actions: write` permission.

### Repository requirements

- **Settings → Actions → General → Workflow permissions** must allow read/write, so the watcher can push and GHCR packages can be published.
- `main` is protected by the `main` ruleset. It requires `check`, `build (linux/arm64)` and `build (linux/amd64)` to pass, which is what Dependabot auto-merge waits for. The GitHub Actions app (so the yt-dlp watcher can push) and repository admins can bypass it.
- The image path comes from `github.repository`, lowercased. `compose.yml` assumes `mlshdev/discord-bot1`, so update it if the repository lives elsewhere.
- Deployments track `:latest` (`pull_policy: always`), so a new build reaches the server on its next `docker compose up -d`.

## Development

```zsh
bun install
cp .env.example .env            # fill in real IDs
bun run dev                     # node --watch --env-file=.env src/index.ts
bun run check                   # biome + tsc + tests
bun run format                  # biome --write
```

To run locally you need `yt-dlp`, `deno` and `ffmpeg` (with libopus) on `PATH`. You can also point `YTDLP_PATH`, `DENO_PATH` and `FFMPEG_PATH` at them.

Local image pre-flight (OrbStack, native arm64):

```zsh
docker buildx build --platform linux/arm64 --load -t discord-bot1:local .
docker run --rm --read-only --cap-drop ALL --tmpfs /tmp --user 1000:1000 discord-bot1:local yt-dlp --version
CI=true dive discord-bot1:local --ci
```

### Contributing

- Keep modules pure where you can (`queue`, `commands`, `youtube`, `format`, `menu.renderMenu`) and cover them in `test/`.
- New syntax must be erasable, or Node will refuse to load the file.
- Update this file and `README.md` in the same change as any behaviour, config or pipeline change.
