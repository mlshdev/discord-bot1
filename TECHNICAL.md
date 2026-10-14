# discord-bot1 — technical notes

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict` plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` | Static typing everywhere |
| Runtime | **Node.js 24 LTS** ("Krypton"), which runs `.ts` directly through built-in type stripping | See [Why Node.js 24 and not Bun](#why-nodejs-24-and-not-bun). One Node binary runs the bot, the tests and yt-dlp's challenge solver. |
| Package manager and scripts | **npm** (`npm ci`, `npm run`, `package-lock.json`), bundled with Node | No second toolchain. Dependabot's `npm` ecosystem tracks the lockfile. |
| Lint and format | Biome | Replaces ESLint and Prettier |
| Tests | `node:test`, run on Node | Tests run on the same runtime as production |
| Discord | `discord.js` 14, `@discordjs/voice` 0.19 | |
| Media | yt-dlp (official PyInstaller *onedir* build), audio-only; Opus passthrough, with ffmpeg (Debian) as fallback only | Avoids re-encoding wherever possible |
| yt-dlp JS runtime | **The image's own Node.js**, under Node's permission model | yt-dlp starts the solver as `node --permission -`, which denies filesystem, network, child-process and worker access. No extra runtime is shipped. |

The supported Node line is recorded in `.node-version` (used by CI) and `engines.node` in `package.json`.

### Why Node.js 24 and not Bun

The code itself is plain Node: `node:child_process` (spawning yt-dlp and ffmpeg), `node:http` (health), `node:events`, `node:fs/promises`, `node:stream`, and `node:test` for tests. It uses no Node-only syntax and no API newer than Node 24. The deciding factors are the dependencies and yt-dlp:

- **Voice.** `@discordjs/voice` is built and tested against Node. It uses UDP sockets (`node:dgram`), Node's native `aes-256-gcm`, and the N-API addon `@snazzah/davey` for DAVE, the end-to-end voice encryption Discord has required since 2026-03-01. Voice is the critical path, and none of this is validated on Bun.
- **yt-dlp has dropped modern Bun.** Since its 2026 announcement ([yt-dlp#16766](https://github.com/yt-dlp/yt-dlp/issues/16766)), yt-dlp supports Bun only from 1.2.11 to **1.3.14**, the last release built from the original Zig codebase. Newer Bun versions, including every current one, get a "not supported, do not report bugs" warning. yt-dlp also notes that Bun has no sandboxing options.
- **Node sandboxes the solver.** yt-dlp runs Node (≥ 22, preference 900) as `node --permission -`. This lets the image drop Deno completely without weakening the solver's isolation, and saves about 110 MB.

Node 24 is an LTS line, supported until 2028-04-30, and the image's Node binary serves as the bot runtime and the EJS runtime at the same time.

There is no build step. Node strips the types at load time, so the source must stay within erasable syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports keep their `.ts` extension (`allowImportingTsExtensions`).

## Layout

```
src/
  index.ts      entrypoint: config, Discord client, message routing, role checks, shutdown
  config.ts     typed env parsing (ConfigError → exit 78)
  commands.ts   single "!" prefix (PREFIX) parser → discriminated union Command
  youtube.ts    URL allowlist → canonical https://www.youtube.com/watch?v=<id>
  ytdlp.ts      yt-dlp metadata resolution + audio source (Opus passthrough, ffmpeg fallback)
  queue.ts      pure TrackQueue (enqueue/remove/move/promote/shuffle)
  player.ts     MusicPlayer: voice connection, AudioPlayer, queue advancement
  menu.ts       !mn component UI (embed + select + buttons) and its collector
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
5. yt-dlp needs a JavaScript runtime to solve YouTube's challenges (EJS). The bot passes `--no-js-runtimes --js-runtimes node:<process.execPath>`, so the only runtime yt-dlp can use is the exact Node binary running the bot. There is no `PATH` lookup and nothing to configure.
   - `yt_dlp_ejs` holds only the solver *scripts*. It is not a runtime, so a JavaScript engine is still required.
   - The official onedir build bundles `yt_dlp_ejs` (0.8.0 in yt-dlp 2026.08.19), so the scripts come from the Python package, `ejs:github` and `ejs:npm` stay disabled, and nothing is downloaded at solve time.
   - yt-dlp pipes the scripts to `node --permission -`. Under the permission model the solver has no filesystem, network, child-process, worker or native-addon access.
   - Verified in the hardened container. yt-dlp's debug output lists the challenge providers as `bun (unavailable), deno (unavailable), node, quickjs (unavailable)`, shows `Running node: /usr/local/bin/node --permission -` with the solver lib/core v0.8.0 taken from the Python package, and then picks format 251 (Opus).

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

## Discord contract: intents vs. permissions

Discord has two separate access mechanisms, and setup guides often mix them up. "Message Content" is a **gateway intent**, not a permission.

| Mechanism | Where it is set | What this bot uses |
|---|---|---|
| Gateway intents | `Client({ intents })` in `index.ts`. Privileged ones must also be switched on under **Developer Portal → Bot → Privileged Gateway Intents**. | `Guilds`, `GuildVoiceStates`, `GuildMessages`, and the privileged **`MessageContent`** (`1 << 15`) |
| Permissions | The invite link (`permissions=` bitfield), the bot's role and channel overrides | View Channels, Send Messages, Embed Links, Read Message History, Connect, Speak = `3230720` |

- `MessageContent` is needed because the bot reads plain-text prefix commands. Discord only exempts DMs, mentions of the bot and replies to the bot's own messages. Without the intent, `message.content` is empty for ordinary guild messages.
- Requesting a privileged intent that the portal has not enabled makes Discord close the gateway with `4014`. discord.js then rejects `login()` (`Used disallowed intents` / `Privileged intent provided is not enabled or whitelisted`), and the bot logs `discord login failed` and exits with code 1.
- Apps with fewer than 10,000 users can turn the switch on themselves. Above that, Discord requires a privileged-intent review, which a single-guild bot never reaches.
- No `GuildMembers` intent is needed. `message.member` and `interaction.member` arrive with the event, and `roles.cache` is filled from them, so the DJ-role check works without it.
- The `bot` scope is the only scope. `applications.commands` is not requested because there are no slash commands.

See README → *Installation* for the step-by-step setup.

## Container image

`Dockerfile` has three stages:

| Stage | Base | Purpose |
|---|---|---|
| `deps` | `node:24-trixie-slim` | `npm ci --omit=dev --ignore-scripts`. Runs per native arch, so npm installs the right `@snazzah/davey-linux-*` optional prebuild. |
| `ytdlp` | `debian:trixie-slim` | Downloads `yt-dlp_linux[_aarch64].zip` for `YT_DLP_VERSION`, checks it against the release's `SHA2-256SUMS`, unpacks it to `/opt/yt-dlp`, and asserts `--version` |
| `runtime` | `node:24-trixie-slim` | Adds Debian `ffmpeg` (fallback only) and copies in yt-dlp, `node_modules` and `src`. Runs as `1000:1000` with a `HEALTHCHECK`. |

The onedir yt-dlp build is used instead of the single-file binary on purpose. The single-file binary unpacks itself into `/tmp` on every start, which is slower and needs an executable `/tmp`.

Image size is about 1.1 GB, of which Debian's `ffmpeg` and its libraries account for roughly 420 MB. `dive --ci` passes.

### Runtime hardening (verified locally with OrbStack)

- Capability probe: `cap_drop: [ALL]` with no `cap_add`, plus `read_only: true` and `no-new-privileges`. Under these settings, metadata resolution with Node solving the challenges under `--permission`, Opus passthrough, the ffmpeg fallback, the health server and the config/login error paths all ran with **no permission errors**, so no capability is added back.
- The only writable path is the `/tmp` tmpfs. It holds yt-dlp's cache (`XDG_CACHE_HOME=/tmp/.cache`) and the private copy of the cookies file. yt-dlp rewrites its cookie jar on exit, so it cannot use the read-only mount directly.
- `init: true` gives the container a real PID 1 that reaps the yt-dlp and ffmpeg child processes.

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | On `ubuntu-slim` with Node from `.node-version`: `npm ci`, `biome ci`, `tsc`, `node --test` |
| `docker.yml` | every PR; push to `main` touching image inputs; Mon/Thu 03:00 UTC; `workflow_dispatch` | Native matrix (`ubuntu-26.04-arm` → `linux/arm64`, `ubuntu-26.04` → `linux/amd64`), no QEMU. Each arch builds with `--load` and is validated in a hardened container: yt-dlp version matches the pin, ffmpeg has libopus, yt-dlp detects Node 24 and the bundled EJS solver, `node --permission` runs under the hardened settings, discord.js/voice/davey import, and a missing config exits 78. On `main` it then pushes by digest. A merge job builds the manifest list tagged `latest`, `ytdlp-<ver>` and `sha-<sha>`. Scheduled runs use `no-cache` and `pull` for a clean rebuild. |
| `ytdlp-release.yml` | every 30 min; `workflow_dispatch` | Polls `yt-dlp/yt-dlp` for its latest release. When the release is new and its Linux assets plus `SHA2-256SUMS` are uploaded, it rewrites `ARG YT_DLP_VERSION` in the `Dockerfile`, and pushes the commit to `main` over SSH with a write deploy key (secret `YTDLP_BUMP_DEPLOY_KEY`). That push triggers `docker.yml`. |
| `dependabot-automerge.yml` | Dependabot PRs | Turns on auto-merge, which waits for the required checks |

`.github/dependabot.yml` covers the `docker`, `github-actions` and `npm` ecosystems on Mon/Thu 00:00 UTC. Node is pinned to the 24 LTS line, so two major updates are ignored on purpose: `node` in `docker` and `@types/node` in `npm`. Without those rules, auto-merge would move the bot to the next Node major without anyone looking. Minor and patch updates still flow in. Moving to the next LTS is a deliberate change that touches `.node-version`, `engines.node`, both `FROM` lines, `@types/node`, the `node-24\.` check in `docker.yml`, and these ignore rules.

### Why poll, and why a deploy key

- GitHub Actions cannot subscribe to release events from a repository you don't own, so `ytdlp-release.yml` polls upstream instead.
- The watcher pushes with a deploy key, not `GITHUB_TOKEN`, for two reasons. Pushes made with `GITHUB_TOKEN` don't trigger other workflows. And on a personal account the GitHub Actions app can't be a ruleset bypass actor, while a deploy key can.
- Dependabot PRs are auto-merged with `GITHUB_TOKEN`, so the merge doesn't trigger `docker.yml` on its own. The Mon/Thu 03:00 UTC clean rebuild runs three hours after Dependabot's 00:00 UTC check and publishes the merged updates.

### Repository requirements

- **Settings → Actions → General → Workflow permissions** is set to read/write so GHCR packages can be published and Dependabot PRs auto-merged. This is already configured.
- `main` is protected by the `main` ruleset. It blocks force-pushes and deletion, and requires `check`, `build (linux/arm64)` and `build (linux/amd64)` to pass, which is what Dependabot auto-merge waits for. Deploy keys (the yt-dlp watcher) and repository admins can bypass it.
- To rotate the deploy key, generate a new ed25519 key pair, then run `gh repo deploy-key add --allow-write` for the public key and `gh secret set YTDLP_BUMP_DEPLOY_KEY` for the private key.
- The image path comes from `github.repository`, lowercased. `compose.yml` assumes `mlshdev/discord-bot1`, so update it if the repository lives elsewhere.
- Deployments track `:latest` (`pull_policy: always`), so a new build reaches the server on its next `docker compose up -d`.

## Development

Use Node 24 (`brew install node@24`, or any version manager that reads `.node-version`). Newer Node majors also run the code, but CI and the image use 24.

```zsh
npm ci
cp .env.example .env            # fill in real IDs
npm run dev                     # node --watch --env-file=.env src/index.ts
npm run check                   # biome + tsc + tests
npm run format                  # biome --write
```

To run locally you need `yt-dlp` and `ffmpeg` (with libopus) on `PATH`, or `YTDLP_PATH` and `FFMPEG_PATH` pointing at them. yt-dlp needs either `yt_dlp_ejs` installed or the official standalone build, which bundles it. The Node binary running the bot solves the challenges, so it must be version 22 or newer.

Without a local Node 24, run the checks in the same image CI uses:

```zsh
docker run --rm --user 1000:1000 -e npm_config_cache=/tmp/npm -v "$PWD:/app" -w /app \
  docker.io/library/node:24-trixie-slim sh -c 'npm ci && npm run check'
```

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
