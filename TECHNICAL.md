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
| Media | yt-dlp (official PyInstaller *onedir* build), audio-only → ffmpeg (Debian) `loudnorm` → PCM → `@discordjs/voice` inline volume → `opusscript` | Same loudness for every video, live `/vol` without restarting the stream |
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
  index.ts      entrypoint: config, Discord client, command registration, interaction routing, channel/role checks, shutdown
  config.ts     typed env parsing (ConfigError → exit 78)
  cookies.ts    mandatory YouTube cookies.txt: read + validate like yt-dlp's MozillaCookieJar (ConfigError → exit 78)
  commands.ts   slash command definitions (COMMAND_DEFINITIONS) and name → discriminated union Command
  youtube.ts    URL allowlist → canonical https://www.youtube.com/watch?v=<id>
  ytdlp.ts      yt-dlp metadata resolution + audio source (yt-dlp → ffmpeg loudnorm → 48 kHz s16le PCM)
  voice.ts      pure voice-channel choice for /add across the VOICE_CHANNEL_ID list, mention formatting
  errors.ts     internal error-code catalog (E1xx–E5xx), yt-dlp stderr classifier, code-only user messages
  state.ts      persistent bot state (/vol level) in STATE_FILE: versioned JSON, serialised atomic writes
  queue.ts      pure TrackQueue (enqueue/remove/move/promote/shuffle)
  player.ts     MusicPlayer: voice connection, AudioPlayer, queue advancement
  menu.ts       /mn component UI (embed + select + buttons) and its collector
  format.ts     duration/markdown helpers
  health.ts     GET /healthz
  logger.ts     JSON-lines logger, LOG_LEVEL threshold, error serializer with token redaction
  permissions.ts  invite permission set, required channel permissions and the pure missing-permission check
test/           node:test unit tests for every pure module
```

## Request flow

1. On `ClientReady`, `guild.commands.set(COMMAND_DEFINITIONS)` bulk-overwrites the guild's command set (`PUT /applications/<id>/guilds/<id>/commands`). Guild commands appear in the client instantly, unlike global ones, and only exist on `GUILD_ID`. Re-running it with the same definitions is a no-op on Discord's side. Every command is `contexts: [Guild]`, `integration_types: [GuildInstall]`. A failure (typically `50001` when the invite lacked `applications.commands`) is a startup validation failure and exits 78.
2. `InteractionCreate` events that are not chat-input commands from the cached `GUILD_ID` guild are ignored. Component clicks are handled by the menu's own collector.
3. `toCommand(commandName, url option)` maps the interaction to a `Command`. Outside `TEXT_CHANNEL_ID` the bot answers ephemerally and logs `command denied` with `reason: "wrong channel"`. Commands in `PRIVILEGED_COMMANDS` need at least one of the `DJ_ROLE_ID` roles (`config.djRoleIds.some(...)`). Refusals and usage errors are ephemeral, results are public. A thrown error is logged as `command failed` and answered with an ephemeral follow-up or reply.
4. `/add`:
   1. The URL and the queue limit are checked first and answered ephemerally. Only then does the bot call `deferReply()`, because yt-dlp regularly takes longer than the 3 s Discord allows for the first response. The result is sent with `editReply()`.
   2. `parseYouTubeUrl` checks the host against an allowlist and validates the 11-character video ID. It then rebuilds a canonical URL, so user text never reaches yt-dlp's argv, and `--` is always passed before the URL as well.
   3. `yt-dlp --print '%(.{…})j'` resolves the metadata. Live streams and premieres are rejected.
   4. The track is enqueued, and playback starts if the player is idle.
5. Playback (`YtDlp.open`):

   ```
   yt-dlp -f "bestaudio[acodec=opus]/bestaudio" -o - URL
     → ffmpeg -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -ac 2 -f s16le      decode + normalise
     → createAudioResource(StreamType.Raw, inlineVolume) → VolumeTransformer   /vol gain, live
     → prism-media Opus encoder (opusscript) at AUDIO_BITRATE_KBPS             the only encode
   ```

   - **No video, ever.** The format selector only matches audio-only formats. There is no `/best` fallback that could pick a muxed video stream, so a video without an audio-only format fails at `/add` with a clear error. `resolve()` uses the same selector, so the failure shows up before the track is queued.
   - **Every track is normalised.** yt-dlp does not expose YouTube's own `loudnessDb`, so ffmpeg's single-pass (dynamic) EBU R128 `loudnorm` brings every source to −14 LUFS integrated, −1.5 dBTP true peak, LRA 11, YouTube's reference level. `loudnorm` resamples internally to 192 kHz, so `-ar 48000` is required. Opus passthrough was dropped on purpose, because both normalisation and live volume need decoded PCM.
   - **Volume.** `/vol` sets `VolumeTransformer` to `level / 100` on the playing resource and remembers it for the next ones (`MusicPlayer.setVolume`, 0–150, default 100, not persisted across restarts). Above 100 % the 1.5 dB of true-peak headroom runs out quickly and samples clip at int16, hence the cap of 150.
   - **Encoder.** `@discordjs/voice` encodes PCM through `prism-media`, which loads `@discordjs/opus` or `opusscript`. `opusscript` (pure JS/asm.js, `^0.0.8` as declared by `prism-media`'s peer range) is used because the image installs with `--ignore-scripts`, and the native addon's prebuild step would not run. Verified in the hardened container: 5 s of audio encoded in about 2.5 s at 128 kbps, so one stream is well within real time.
   - ffmpeg accepts any audio codec yt-dlp delivers (Opus, AAC, mono), so there is no separate fallback path.
   - Transport encryption uses Node's native `aes-256-gcm`.
   - DAVE is handled by `@snazzah/davey`.
6. yt-dlp needs a JavaScript runtime to solve YouTube's challenges (EJS). The bot passes `--no-js-runtimes --js-runtimes node:<process.execPath>`, so the only runtime yt-dlp can use is the exact Node binary running the bot. There is no `PATH` lookup and nothing to configure.
   - `yt_dlp_ejs` holds only the solver *scripts*. It is not a runtime, so a JavaScript engine is still required.
   - The official onedir build bundles `yt_dlp_ejs` (0.8.0 in yt-dlp 2026.08.19), so the scripts come from the Python package, `ejs:github` and `ejs:npm` stay disabled, and nothing is downloaded at solve time.
   - yt-dlp pipes the scripts to `node --permission -`. Under the permission model the solver has no filesystem, network, child-process, worker or native-addon access.
   - Verified in the hardened container. yt-dlp's debug output lists the challenge providers as `bun (unavailable), deno (unavailable), node, quickjs (unavailable)`, shows `Running node: /usr/local/bin/node --permission -` with the solver lib/core v0.8.0 taken from the Python package, and then picks format 251 (Opus).

### Player invariants (`player.ts`)

- `#advance()` is the only place that takes tracks from the queue, and the `#advancing` flag makes it re-entrancy-safe. `AudioPlayerStatus.Idle` is the only trigger after a track ends.
- Forced transitions (skip, play now, disconnect) kill the current yt-dlp process, and ffmpeg too if it is running, *before* calling `AudioPlayer.stop(true)`.
- `open()` is synchronous: it only spawns yt-dlp and ffmpeg and pipes them together. A `#generation` counter, bumped by `disconnect()`, throws away a connection attempt that finishes after the player was reset.
- A track that ends naturally keeps its processes for a 10 s grace period. That way a non-zero yt-dlp exit, such as a 403 partway through the stream, is still logged as `E302`.
- If the bot cannot join voice, the track goes back to the front of the queue instead of being dropped.
- **Voice channel per session.** `VOICE_CHANNEL_ID` and `DJ_ROLE_ID` are comma lists (`snowflakeList` in `config.ts`: trimmed, deduplicated in order, empty entries rejected, at most 25). `chooseVoiceChannel` (`voice.ts`, pure, unit-tested) picks the target for `/add`. With a session running (`player.voiceChannelId` set) it keeps that channel. Otherwise it takes the requester's channel if it is allowed, or the only allowed channel if there is exactly one. Otherwise it refuses ephemerally before deferring. `enqueue()` stores the channel only when no session exists (`??=`), and `disconnect()` clears it, which also covers the idle timeout and lost connections. Startup fetches every listed voice channel and role and fails with exit 78 on the first one that is missing. The permission audit and its `ChannelUpdate` watch cover every listed voice channel.
- A connection that is lost for real (still `Disconnected` after 5 s, or `Destroyed`) clears the queue and logs `E402`. Nothing is posted in the channel. An intentional disconnect detaches `#connection` before calling `destroy()`, so it is not logged as lost.

### Queue manager (`menu.ts`)

- `renderMenu(snapshot, state, closed)` is a pure function of the player snapshot plus per-menu state (`page`, `selectedUid`, `notice`).
- Tracks are referenced by a per-process `uid`, never by position, so concurrent edits cannot hit the wrong track.
- Every interaction re-checks the DJ roles. Unauthorised clicks get an ephemeral reply.
- `/mn` answers with `reply({ withResponse: true })` and collects components on the returned message. Each click is answered with `update()` on its own fresh interaction token.
- The menu subscribes to `MusicPlayer`'s `change` event and re-renders through `editReply()` on the `/mn` interaction, debounced to 1 s. The collector ends after 5 minutes idle or 14 minutes in total, and then the components are removed. The cap exists because the `/mn` interaction token, which every refresh and the final close edit use, expires after 15 minutes.

## Discord contract: interactions, intents and permissions

Discord has three separate access mechanisms, and setup guides often mix them up.

| Mechanism | Where it is set | What this bot uses |
|---|---|---|
| OAuth2 scopes | The invite link (`scope=`) | `bot` and `applications.commands` |
| Gateway intents | `Client({ intents })` in `index.ts`. Privileged ones must also be switched on under **Developer Portal → Bot → Privileged Gateway Intents**. | `Guilds`, `GuildVoiceStates`. No privileged intent. |
| Permissions | The invite link (`permissions=` bitfield), the bot's role and channel overrides | `INVITE_PERMISSIONS` = `4543733985968384` (below) |

- **Slash commands instead of prefix commands.** Interactions are delivered over the gateway regardless of intents, carry the invoking member with their roles, and are answered through the interaction webhook. So the bot needs neither `GuildMessages` nor the privileged `MessageContent` intent, which Discord reserves for bots that actually need message text. Without `MessageContent` there is no `4014` close code to run into.
- No `GuildMembers` intent is needed. `interaction.member` arrives with the event and `roles.cache` is filled from it, so the DJ-role check works without it.
- **Invite permissions** (`INVITE_PERMISSIONS` in `permissions.ts`, checked against the integer by a unit test): Priority Speaker, Connect, Speak, Use Voice Activity, Use Application Commands, Use Embedded Activities, Use Soundboard, Use External Sounds, Bypass Slowmode. These are the permissions the owner chose. The code depends on Connect and Speak to play, and on Bypass Slowmode so announcements are not throttled in a slowmode channel. The rest have no feature behind them.
- **What needs channel permissions.** Interaction replies, follow-ups and component updates go through `/interactions/<id>/<token>` and `/webhooks/<app>/<token>`, which need no channel permission. Only the unprompted announcements (`MusicPlayer.announce` → `channel.send`) are channel messages. So the audit checks `TEXT_CHANNEL_PERMISSIONS` = View Channel, Send Messages and `VOICE_CHANNEL_PERMISSIONS` = View Channel, Connect, Speak. View Channel and Send Messages are not in the invite set; they come from `@everyone`, which grants both by default, or from channel overrides. If they are missing, the audit warns and announcements fail with `50001`/`50013`, but commands still work.
- Admins can restrict commands further per role or channel in **Server Settings → Integrations**. The bot does not set `default_member_permissions`, so it does not fight those overrides; its own channel and DJ-role checks always run on top.

See README → *Installation* for the step-by-step setup.

## Logging

- `createLogger({ service, environment, level, sink? })` writes one JSON object per line. `info` and `debug` go to stdout, `warn` and `error` to stderr. Entries below `LOG_LEVEL` are dropped. The `sink` parameter exists so tests can capture the output.
- `serializeError` is applied to the `error` field of a log entry. Besides `name`, `message` and `stack`, it keeps the fields that explain a failure:
  - `DiscordAPIError`: `code` (for example 50013 Missing Permissions, 50001 Missing Access), `status` and `method`. `url` is logged as `route`, the path only. `redactRoute` replaces the token segment of `/interactions/<id>/<token>` and `/webhooks/<id>/<token>` with `[redacted]`.
  - Node `SystemError`: `code`, `syscall` and `path`, for example `ENOENT` when yt-dlp or ffmpeg is missing.
  - `cause`, up to 3 levels deep.
- Permission audit (`permissions.ts`): `missingPermissions` checks the bot's resolved channel permissions (`permissionsFor(me)`, where Administrator counts as everything) against `TEXT_CHANNEL_PERMISSIONS` and `VOICE_CHANNEL_PERMISSIONS`. It runs on `ClientReady` and again on `ChannelUpdate` for the two configured channels and on `GuildRole{Create,Update,Delete}`, all of which arrive with the `Guilds` intent. `auditKey` keeps the logs quiet: the result is logged only when it differs from the previous audit. A missing permission is a warning, not a failure, because it can be fixed while the bot runs.
- The boot logger handles `invalid configuration` and any rejection escaping `main()` (`fatal startup error`), so even a crash before the configuration loads produces JSON instead of a raw Node stack trace.
- At `debug` level, voice connection and audio player state transitions are logged, along with failures that are tolerated (menu edits, replies to interactions that already expired, closed pipes).

## Container image

`Dockerfile` has three stages:

| Stage | Base | Purpose |
|---|---|---|
| `deps` | `node:24-trixie-slim` | `npm ci --omit=dev --ignore-scripts`. Runs per native arch, so npm installs the right `@snazzah/davey-linux-*` optional prebuild. |
| `ytdlp` | `debian:trixie-slim` | Downloads `yt-dlp_linux[_aarch64].zip` for `YT_DLP_VERSION`, checks it against the release's `SHA2-256SUMS`, unpacks it to `/opt/yt-dlp`, and asserts `--version` |
| `runtime` | `node:24-trixie-slim` | Adds Debian `ffmpeg` (fallback only) and copies in yt-dlp, `node_modules` and `src`. Runs as `1000:1000` with a `HEALTHCHECK`. |

The onedir yt-dlp build is used instead of the single-file binary on purpose. The single-file binary unpacks itself into `/tmp` on every start, which is slower and needs an executable `/tmp`.

Image size is about 1.1 GB, of which Debian's `ffmpeg` and its libraries account for roughly 420 MB. `dive --ci` passes.

### Error codes

Nothing technical ever reaches Discord. Users see `⚠️ <one sentence>. Error code \`Exxx\`.` as an ephemeral reply to their own command. Background failures (playback, voice) are only logged. Every failure log line spreads `errorFields(code)`, so it carries `errorCode` and `errorClass` next to the raw `error`/`reason`. `src/errors.ts` is the single source of truth. `/add` defers publicly ("is thinking…"), and on failure `failPrivately` deletes that public reply and sends the code as an ephemeral follow-up.

| Code | Meaning | Raised by |
|---|---|---|
| `E100` | command handler threw an unexpected exception | `index.ts` interaction handler |
| `E101` | queue manager interaction threw an unexpected exception | `menu.ts` collector |
| `E201` | YouTube bot check: the cookies are signed out, rotated or missing | yt-dlp `Sign in to confirm you're not a bot` |
| `E202` | video unavailable: private, removed, members-only or terminated | yt-dlp |
| `E203` | age-restricted, and the cookie account cannot confirm age | yt-dlp |
| `E204` | blocked in the host's country | yt-dlp |
| `E205` | live stream or premiere | `parseMetadata` `live_status`, or yt-dlp |
| `E206` | no audio-only format | yt-dlp `Requested format is not available` |
| `E207` | YouTube rate-limited or refused the request (HTTP 403/429) | yt-dlp |
| `E208` | yt-dlp timed out while resolving (45 s) | `resolve()` |
| `E209` | empty or malformed metadata | `parseMetadata` |
| `E210` | YouTube invalidated the cookies during the request (rotated or signed out) | yt-dlp `cookies are no longer valid` warning, which wins over whatever error follows it |
| `E299` | unclassified yt-dlp failure, so read `error.cause` and add a pattern | `classifyYtDlpError` fallback |
| `E301` | audio pipeline could not be started | `MusicPlayer.#start` |
| `E302` | audio stream failed during playback | `AudioSource.finished` |
| `E303` | audio player emitted an error | `AudioPlayer` `error` event |
| `E401` | could not join the voice channel | `#ensureConnection` |
| `E402` | voice connection was lost | `VoiceConnectionStatus.Destroyed` |
| `E501` | bot state file could not be read, parsed or written | `StateStore.load` / `/vol` save |

`classifyYtDlpError` matches yt-dlp's stderr against ordered patterns (first match wins, `E299` otherwise), with a unit test per pattern. Codes are stable: never renumber one, add a new code instead.

### Runtime hardening (verified locally with OrbStack)

- Capability probe: `cap_drop: [ALL]` with no `cap_add`, plus `read_only: true` and `no-new-privileges`. Under these settings, metadata resolution with Node solving the challenges under `--permission`, the yt-dlp → ffmpeg `loudnorm` → inline volume → `opusscript` pipeline, the health server and the config/login error paths all ran with **no permission errors**, so no capability is added back.
- The writable paths are the `/tmp` tmpfs and `/data`. `/tmp` holds yt-dlp's cache (`XDG_CACHE_HOME=/tmp/.cache`) and the private copy of the cookies file. yt-dlp rewrites its cookie jar on exit, so it cannot use the read-only mount directly. `/data` is declared with `VOLUME` and pre-created as `1000:1000` in the image, so it is writable both as the `discord-bot1/data` bind mount and as an anonymous volume when a deployment does not mount it.

### Persistent state (`state.ts`)

`STATE_FILE` (default `/data/state.json`) holds `{"version": 1, "volume": <0–150>}`. It is loaded once before Discord login and passed to `MusicPlayer` as `initialVolume`. After `/vol` applies the new level, it is saved with `StateStore.save`. Saves are chained on one promise, so concurrent `/vol` calls land in order and the file always holds the last value. Each save writes `state.json.tmp` (mode 0600), `fsync`s it and `rename`s it over the file, so a crash or `docker kill` never leaves a torn file.

State is never fatal. A missing file means a fresh install (info). An unreadable or invalid file, or a wrong `version`, falls back to the defaults with `E501` and is repaired by the next successful save. A failed save logs `E501`, and the new volume still plays until the next restart. Verified in the hardened container (read-only rootfs, `cap_drop ALL`, UID 1000): a level saved in one container is restored in a new one through the bind mount, and across `docker start` of the same container through the anonymous volume.

### YouTube cookies (`cookies.ts`)

Cookies are mandatory: without a signed-in session YouTube answers data-centre IPs with "Sign in to confirm you're not a bot". `YTDLP_COOKIES_FILE` only moves the path (default `/config/cookies.txt`), so the file is picked up without any `.env` change. That matters because `docker compose restart` does not re-read `env_file`.

`loadCookies` reads the file once, before Discord login, and fails with a `ConfigError` (exit 78) on anything yt-dlp would reject or silently ignore. The rules mirror yt-dlp 2026.08.19's `YoutubeDLCookieJar` and CPython's `MozillaCookieJar`, which were checked against the real binary in the image:

| Check | Why |
|---|---|
| First line matches `#( Netscape)? HTTP Cookie File` | `MozillaCookieJar` rejects the file otherwise. JSON exports get their own message. |
| 7 tab-separated fields, numeric expiry | yt-dlp skips other lines with only a `WARNING`. Lines are reported by number; if none survive, startup fails. |
| Include-subdomains flag is `TRUE` exactly when the domain starts with `.` | `MozillaCookieJar` asserts this and then rejects the **whole** file. |
| Unexpired `LOGIN_INFO` plus one of `SAPISID` / `__Secure-1PAPISID` / `__Secure-3PAPISID` on `youtube.com` | yt-dlp's `_has_auth_cookies`. Without both, yt-dlp does not treat the session as signed in. |

Rotation can't be detected offline. yt-dlp checks `_has_auth_cookies` after every request and warns "cookies are no longer valid", so `--no-warnings` is not passed. `resolve()` logs every `WARNING:` line as `yt-dlp warning`, on success and on failure. A final `Sign in to confirm you're not a bot` error is replaced with a short, actionable reply in Discord. The raw yt-dlp error is still kept in the logged `cause`.

The validated contents are written to `/tmp/discord-bot1-cookies.txt` (mode 0600). yt-dlp loads that file and saves it again on every run, so refreshed session cookies carry over between tracks until the container is recreated.
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
