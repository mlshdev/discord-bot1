# discord-bot1

A Discord music bot that plays **YouTube only**, in **one** voice channel on **one** server, driven by prefix commands in **one** text channel. Audio is fetched with [yt-dlp](https://github.com/yt-dlp/yt-dlp), which uses [Deno](https://deno.com) to solve YouTube's JavaScript challenges. The container image is rebuilt automatically whenever yt-dlp publishes a new release.

Only audio is ever downloaded, never video. YouTube's Opus audio goes straight to Discord without being re-encoded.

## Commands

All commands only work in the text channel set by `TEXT_CHANNEL_ID` on the server set by `GUILD_ID`. Everything else is ignored.

| Command | Who | What it does |
|---|---|---|
| `!add <youtube-url>` | everyone | Adds a YouTube video to the queue. If nothing is playing, playback starts in `VOICE_CHANNEL_ID`. |
| `!!ff` | `DJ_ROLE_ID` only | Force-skips the current song. |
| `!!mn` | `DJ_ROLE_ID` only | Opens the interactive queue manager. |
| `!!won` | `DJ_ROLE_ID` only | Stops playback, clears the queue and leaves the voice channel. |

Accepted links: `youtube.com/watch?v=…`, `youtu.be/…`, `music.youtube.com/watch?v=…`, `/shorts/…`, `/live/…` (finished streams only), `/embed/…`. Playlist parameters are ignored and only the linked video is added. Live streams, premieres and non-YouTube links are rejected.

### Queue manager (`!!mn`)

The menu shows what is playing now and the queue, ten tracks per page. It updates itself whenever the queue changes.

- **Select a track** from the dropdown, then **Play now** (force play), **Move up**, **Move down** or **Remove**.
- **Force skip**, **Pause/Resume**, **Shuffle** and **Clear queue** act on the whole queue.
- **Prev/Next** page through long queues. **Close** ends the menu.

Only members with the DJ role can use the buttons. Anyone else gets a private "not allowed" reply. The menu stops responding after five minutes without use.

## Setup

### 1. Create the Discord application

1. Create an application and a bot at <https://discord.com/developers/applications>.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The bot uses prefix commands, so it needs this.
3. Invite the bot with the `bot` scope and these permissions: *View Channels*, *Send Messages*, *Read Message History*, *Embed Links*, *Connect*, *Speak*.
4. Turn on Developer Mode in Discord (Settings → Advanced), then copy the server ID, both channel IDs and the DJ role ID.

### 2. Configure

```zsh
cp .env.example .env
$EDITOR .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Bot token |
| `GUILD_ID` | yes | — | The only server the bot responds in |
| `TEXT_CHANNEL_ID` | yes | — | The only channel commands are read from. A voice channel's built-in chat also works. |
| `VOICE_CHANNEL_ID` | yes | — | The voice channel the bot plays in |
| `DJ_ROLE_ID` | yes | — | Role allowed to use `!!ff`, `!!mn` and `!!won` |
| `MAX_QUEUE_SIZE` | no | `100` | Maximum number of queued tracks (1–1000) |
| `IDLE_DISCONNECT_SECONDS` | no | `300` | How long the bot stays in voice with an empty queue before leaving. `0` means never leave. |
| `AUDIO_BITRATE_KBPS` | no | `128` | Opus bitrate (16–510). Only used in the rare case a video has no Opus audio and has to be re-encoded. Opus audio is passed through at its original quality. |
| `HEALTH_PORT` | no | `8080` | Port for the `GET /healthz` endpoint |
| `DENO_PATH` | no | `deno` on `PATH` | Deno binary yt-dlp uses for YouTube challenges. The image sets it to `/usr/local/bin/deno`. |
| `YTDLP_COOKIES_FILE` | no | — | Path to a Netscape `cookies.txt`, for when YouTube asks the bot to "confirm you're not a bot" |
| `APP_ENV` | no | `production` | Environment name included in log lines |

The bot checks the IDs at startup. If one is wrong it exits with code `78`.

### 3. Run

```zsh
docker compose pull
docker compose up -d
docker compose logs -f discord-bot1
```

`compose.yml` uses `ghcr.io/mlshdev/discord-bot1:latest` with `pull_policy: always`, so every `docker compose up -d` pulls the newest build, including each new yt-dlp release.

#### YouTube cookies (optional)

Servers hosted in data centres are often blocked by YouTube. If `!add` fails with "Sign in to confirm you're not a bot":

1. Export a `cookies.txt` from a logged-in browser session. A throwaway account is recommended.
2. Save it as `discord-bot1/config/cookies.txt`. Git ignores this file.
3. Set `YTDLP_COOKIES_FILE=/config/cookies.txt` in `.env` and restart the bot.

The file is mounted read-only. The bot works on a private copy inside the container's `/tmp`.

## Health and logs

- `GET /healthz` on `HEALTH_PORT` returns `200 {"status":"ok"}` once the bot is logged in and has checked its channels. Before that it returns `503`. Docker's `HEALTHCHECK` uses this endpoint.
- Logs are written as one JSON object per line to stdout/stderr. Read them with `docker compose logs`.

## Images

`ghcr.io/mlshdev/discord-bot1` is published for `linux/arm64` and `linux/amd64`, with these tags:

| Tag | Meaning |
|---|---|
| `latest` | Newest build from `main` (used by `compose.yml`) |
| `ytdlp-<version>` | Newest build bundling that yt-dlp release |
| `sha-<commit>` | An exact commit |

See [TECHNICAL.md](TECHNICAL.md) for architecture, development and the CI/CD pipeline.
