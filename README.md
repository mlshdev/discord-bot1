# discord-bot1

A Discord music bot that plays **YouTube only**, in **one** voice channel on **one** server, driven by prefix commands in **one** text channel. It runs on Node.js 24 LTS. Audio is fetched with [yt-dlp](https://github.com/yt-dlp/yt-dlp), which uses that same Node.js binary, sandboxed, to solve YouTube's JavaScript challenges. The container image is rebuilt automatically whenever yt-dlp publishes a new release.

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

## Installation

This walks through everything from an empty Discord account to a bot playing music on your server. It takes about 15 minutes.

### What you need

- A Linux host, `amd64` or `arm64`, with Docker Engine and Docker Compose 2.24 or newer. The bot only makes outbound HTTPS connections (to Discord and YouTube) and needs no open inbound ports.
- A Discord account with the **Manage Server** permission on the server you want to add the bot to. Only members with that permission can install bots.

### Step 1: Create the application and bot user

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it, accept the terms and click **Create**.
2. On **General Information**, copy the **Application ID**. You need it for the invite link in step 2.
3. Open the **Bot** page and click **Reset Token**, then copy the token. This is `DISCORD_TOKEN`. Discord shows it only once. Anyone who has it controls the bot, so never commit or share it.
4. Still on **Bot**, scroll to **Privileged Gateway Intents**. Turn on **Message Content Intent**, leave **Presence Intent** and **Server Members Intent** off, and click **Save Changes**.

   This is a *gateway intent*, not a permission. It never appears in the invite link's permission list, in role settings or in channel overrides. It is a switch on the application itself that decides whether Discord sends the text of messages to the bot. Prefix commands such as `!add` cannot work without it. If it is off, Discord refuses the bot's connection (close code `4014`), and the bot logs `discord login failed` with `Used disallowed intents` or `Privileged intent provided is not enabled or whitelisted` and exits.
5. Optional but recommended: turn off **Public Bot** so only you can add the bot to servers. If the portal refuses to save, first open **Installation**, set **Install Link** to **None**, and save. Then turn **Public Bot** off.

### Step 2: Invite the bot to your server

1. In the portal, open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick **`bot`** only. The bot has no slash commands, so `applications.commands` is not needed.
3. Under **Bot Permissions**, tick exactly these:

   | Permission | Why the bot needs it |
   |---|---|
   | View Channels | See the command channel and the voice channel |
   | Send Messages | Answer commands and announce tracks |
   | Embed Links | Draw the `!!mn` queue manager |
   | Read Message History | Answer commands as replies. Discord requires this to reply to a message. |
   | Connect | Join the voice channel |
   | Speak | Play audio |

   Do not grant *Administrator* or anything else. The bot never needs more than this.
4. If an **Integration Type** selector is shown, choose **Guild Install**.
5. Copy the generated URL, open it in a browser, pick your server and click **Authorize**.

You can also build the link yourself. `3230720` is the sum of the six permissions above:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=3230720&integration_type=0
```

After authorising, the bot appears offline in the member list and Discord creates a role with the bot's name. That role carries the six permissions.

### Step 3: Prepare the channels and the DJ role

1. Choose or create:
   - a **text channel** for commands. The text chat built into a voice channel also works.
   - a **voice channel** to play in.
   - a **DJ role** for the people allowed to skip, open the queue manager and stop the bot. Give this role to those members. Everyone in the text channel can still use `!add`.
2. If either channel is private, meaning `@everyone` is denied **View Channel** on the channel or its category, the bot's role does not reach it. Open the channel's **Edit Channel → Permissions**, add the bot's role and allow:
   - on the text channel: View Channel, Send Messages, Embed Links, Read Message History
   - on the voice channel: View Channel, Connect, Speak
3. If the voice channel has a user limit, leave room for the bot. It cannot join a full channel.

### Step 4: Collect the IDs

1. In Discord, open **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click to copy each ID:

   | Right-click | Menu item | Variable |
   |---|---|---|
   | The server icon | Copy Server ID | `GUILD_ID` |
   | The command text channel | Copy Channel ID | `TEXT_CHANNEL_ID` |
   | The voice channel | Copy Channel ID | `VOICE_CHANNEL_ID` |
   | The DJ role, in **Server Settings → Roles** | Copy Role ID | `DJ_ROLE_ID` |

   Each ID is a 17–20 digit number. If you use the voice channel's own chat for commands, `TEXT_CHANNEL_ID` and `VOICE_CHANNEL_ID` are the same.

### Step 5: Deploy on the host

```sh
mkdir -p ~/discord-bot1 && cd ~/discord-bot1
curl -fsSLO https://raw.githubusercontent.com/mlshdev/discord-bot1/main/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/mlshdev/discord-bot1/main/.env.example
mkdir -p discord-bot1/config
chmod 600 .env
"${EDITOR:-nano}" .env
```

Fill in `DISCORD_TOKEN` and the four IDs. Every variable is described in [Configuration](#configuration). Then start the bot:

```sh
docker compose up -d
```

The image `ghcr.io/mlshdev/discord-bot1:latest` is public, so you don't need to log in to a registry.

### Step 6: Check that it works

1. `docker compose ps` shows the container as `healthy` within about 30 seconds.
2. `docker compose logs discord-bot1` contains a `"message":"bot ready"` line with your server and channel names, and the bot shows as online in Discord.
3. In the command channel, send `!add https://www.youtube.com/watch?v=dQw4w9WgXcQ`. The bot replies `➕ Added …, starting playback.`, joins the voice channel and plays.
4. As a member with the DJ role, send `!!mn` to open the queue manager, and `!!won` to stop.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Container exits with code `78`, log says `invalid configuration` | A required variable is missing, or an ID is not a 17–20 digit number. Fix `.env`. |
| Container exits with code `78`, log says `startup validation failed` | An ID points at the wrong place, or the bot is not on that server or cannot see a channel. Check step 3 and step 4. |
| Container exits with code `1`, log says `discord login failed` | The token is wrong or was reset (step 1.3), or **Message Content Intent** is off (step 1.4). |
| The bot is online but ignores commands | Commands only count in `TEXT_CHANNEL_ID` on `GUILD_ID`. Messages from other bots are ignored. |
| `Missing Permissions` or `Missing Access` in the logs | The bot's role lacks one of the six permissions in that channel. Check the channel overrides from step 3.2. |
| The bot does not join voice | It is missing Connect or View Channel on the voice channel, or the channel is full. |
| `!add` answers "Sign in to confirm you're not a bot" | YouTube is blocking the host's IP address. See [YouTube cookies](#youtube-cookies-optional). |

### Update and uninstall

- **Update:** `docker compose up -d`. With `pull_policy: always`, this pulls the newest image every time.
- **Uninstall:** `docker compose down`, then remove the bot under **Server Settings → Integrations**, or kick it from the member list.

## Configuration

All settings come from `.env`. `.env.example` is the template.

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
| `YTDLP_COOKIES_FILE` | no | — | Path to a Netscape `cookies.txt`, for when YouTube asks the bot to "confirm you're not a bot" |
| `APP_ENV` | no | `production` | Environment name included in log lines |

The bot checks the IDs at startup. If one is wrong it exits with code `78`.

### YouTube cookies (optional)

Servers hosted in data centres are often blocked by YouTube. If `!add` fails with "Sign in to confirm you're not a bot":

1. Export a `cookies.txt` from a logged-in browser session. A throwaway account is recommended.
2. Save it as `discord-bot1/config/cookies.txt` next to `compose.yml`. The container runs as UID 1000, so the file must be readable by that user. The cookies log in to the account, so keep them private: `sudo chown 1000:1000 discord-bot1/config/cookies.txt && sudo chmod 600 discord-bot1/config/cookies.txt`. Git ignores this file.
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
