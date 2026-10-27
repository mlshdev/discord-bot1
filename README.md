# discord-bot1

A Discord music bot that plays **YouTube only**, in any voice channel or a configured set of voice channels (one at a time) on **one** server, driven by slash commands in **one** text channel. It runs on Node.js 24 LTS. Audio is fetched with [yt-dlp](https://github.com/yt-dlp/yt-dlp), which uses that same Node.js binary, sandboxed, to solve YouTube's JavaScript challenges. The container image is rebuilt automatically whenever yt-dlp publishes a new release.

Only audio is ever downloaded, never video. Every track is loudness-normalised (EBU R128, −14 LUFS, the same reference YouTube uses), so quiet and loud videos play at the same level, and DJs can turn the volume up or down with `/vol`.

## Commands

The bot uses Discord's slash commands. Type `/` in the message box and pick a command from the list; Discord shows each one's description and fills in the `url` field for `/add`. The commands are registered on the server set by `GUILD_ID` every time the bot starts, so they appear immediately and only on that server.

Commands only run in the text channel set by `TEXT_CHANNEL_ID`. Used anywhere else, the bot answers with a private reply pointing to that channel. Refusals and errors are always private (only you see them) and are never posted in the channel; results such as "Added …" are visible to everyone. Errors show only a short code such as `E201`. What the code means is logged for the bot's operator, see [Error codes](#error-codes).

| Command | Who | What it does |
|---|---|---|
| `/add url:<youtube-url>` | everyone | Adds a YouTube video to the queue. If the bot is not already in voice, it joins the channel of the requester when `VOICE_CHANNEL_ID` is omitted (the requester must be in voice). With one configured ID it joins that channel even if the requester is not in voice; with several, the requester must be in one of them. Once playing, the bot stays in that channel until `/won` or idle timeout, and every `/add` uses the same queue. |
| `/ff` | any `DJ_ROLE_ID` role | Force-skips the current song. |
| `/mn` | any `DJ_ROLE_ID` role | Opens the interactive queue manager. |
| `/won` | any `DJ_ROLE_ID` role | Stops playback, clears the queue and leaves the voice channel. |
| `/vol [level:<0-150>]` | any `DJ_ROLE_ID` role | Sets the volume in percent of the normalised loudness, for the current and all later tracks. Without `level` it privately shows the current volume. The level is saved and survives bot and container restarts. It starts at `100` on a fresh install. |

Server admins can further limit who sees each command, and in which channels, under **Server Settings → Integrations → *bot name* → Command Permissions**. The bot's own channel and DJ-role checks still apply on top.

Accepted links, over `https://` or `http://`:

| Host | Paths |
|---|---|
| `youtube.com`, `www.youtube.com`, `m.youtube.com` (mobile browser), `music.youtube.com` | `/watch?v=…`, `/shorts/…`, `/live/…` (finished streams only), `/embed/…`, `/v/…` |
| `youtu.be`, `www.youtu.be` (share links) | `/…` |

Extra parameters such as `&t=42s`, `?si=…` and `&list=…` are ignored, and only the linked video is added, never a playlist. Live streams, premieres and non-YouTube links are rejected.

### Queue manager (`/mn`)

The menu shows what is playing now and the queue, ten tracks per page. It updates itself whenever the queue changes.

- **Select a track** from the dropdown, then **Play now** (force play), **Move up**, **Move down** or **Remove**.
- **Force skip**, **Pause/Resume**, **Shuffle** and **Clear queue** act on the whole queue.
- **Prev/Next** page through long queues. **Close** ends the menu.

Only members with one of the DJ roles can use the buttons. Anyone else gets a private "not allowed" reply. The menu stops responding after five minutes without use, and after 14 minutes at most, because Discord only lets the bot edit a slash-command reply for 15 minutes. Run `/mn` again to get a fresh one.

## Installation

This walks through everything from an empty Discord account to a bot playing music on your server. It takes about 15 minutes.

### What you need

- A Linux host, `amd64` or `arm64`, with Docker Engine and Docker Compose 2.24 or newer. The bot only makes outbound HTTPS connections (to Discord and YouTube) and needs no open inbound ports.
- A Discord account with the **Manage Server** permission on the server you want to add the bot to. Only members with that permission can install bots.
- A YouTube account for the bot to sign in with, ideally a throwaway one. YouTube blocks anonymous downloads from servers, so the bot refuses to start without its cookies ([YouTube cookies](#youtube-cookies)).

### Step 1: Create the application and bot user

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it, accept the terms and click **Create**.
2. On **General Information**, copy the **Application ID**. You need it for the invite link in step 2.
3. Open the **Bot** page and click **Reset Token**, then copy the token. This is `DISCORD_TOKEN`. Discord shows it only once. Anyone who has it controls the bot, so never commit or share it.
4. Still on **Bot**, leave all three **Privileged Gateway Intents** (Presence, Server Members, Message Content) **off**. Slash commands arrive as interactions, so the bot never needs to read message text. If you turned **Message Content Intent** on for an older version of this bot, you can turn it off.
5. Optional but recommended: turn off **Public Bot** so only you can add the bot to servers. If the portal refuses to save, first open **Installation**, set **Install Link** to **None**, and save. Then turn **Public Bot** off.

### Step 2: Invite the bot to your server

1. In the portal, open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick **`bot`** and **`applications.commands`**. Without `applications.commands` the bot cannot register its slash commands and exits at startup.
3. Under **Bot Permissions**, tick exactly these nine:

   | Permission | Role in this bot |
   |---|---|
   | Connect | Join the voice channel |
   | Speak | Play audio |
   | Use Voice Activity | Voice permission granted with the voice set |
   | Priority Speaker | Voice permission granted with the voice set |
   | Use Soundboard | Voice permission granted with the voice set |
   | Use External Sounds | Voice permission granted with the voice set |
   | Use Embedded Activities | Voice permission granted with the voice set |
   | Use Application Commands | Slash-command permission granted with the set |
   | Bypass Slowmode | "Now playing" announcements are not delayed if the text channel has slowmode |

   The bot's code uses Connect, Speak and Bypass Slowmode; the others are part of the requested set but no current feature depends on them. Do not grant *Administrator*.

   **View Channels** and **Send Messages** are deliberately not in this list. The bot gets them from `@everyone`, which has both by default. Slash-command replies and the queue manager need neither, because Discord delivers them through the interaction itself. Only the unprompted "now playing" announcements are posted as normal channel messages.
4. If an **Integration Type** selector is shown, choose **Guild Install**.
5. Copy the generated URL, open it in a browser, pick your server and click **Authorize**.

You can also build the link yourself. `4543733985968384` is the sum of the nine permissions above:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=4543733985968384&integration_type=0
```

After authorising, the bot appears offline in the member list and Discord creates a role with the bot's name. That role carries the nine permissions.

If the bot was added earlier with the old link (`scope=bot`, `permissions=3230720`), open the new link and authorise again for the same server. Discord adds the `applications.commands` scope without kicking the bot. If the bot's role in **Server Settings → Roles** still shows the old permissions afterwards, set them there by hand.

### Step 3: Prepare the channels and the DJ role

1. Choose or create:
   - a **text channel** for commands. The text chat built into a voice channel also works.
   - a **voice channel** to play in.
   - a **DJ role** for the people allowed to skip, open the queue manager and stop the bot. Give this role to those members. Everyone in the text channel can still use `/add`.
2. If either channel is private, meaning `@everyone` is denied **View Channel** on the channel or its category, or if `@everyone` cannot send messages there, the bot does not get those permissions either. Open the channel's **Edit Channel → Permissions**, add the bot's role and allow:
   - on the text channel: View Channel, Send Messages
   - on the voice channel: View Channel, Connect, Speak
3. If the voice channel has a user limit, leave room for the bot. It cannot join a full channel.

### Step 4: Collect the IDs

1. In Discord, open **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click to copy each ID:

   | Right-click | Menu item | Variable |
   |---|---|---|
   | The server icon | Copy Server ID | `GUILD_ID` |
   | The command text channel | Copy Channel ID | `TEXT_CHANNEL_ID` |
   | The voice channel(s), only if restricting playback | Copy Channel ID | `VOICE_CHANNEL_ID` |
   | The DJ role(s), in **Server Settings → Roles** | Copy Role ID | `DJ_ROLE_ID` |

   Each ID is a 17–20 digit number. `VOICE_CHANNEL_ID` is optional; when provided, it and `DJ_ROLE_ID` take comma-separated IDs, for example `DJ_ROLE_ID=111111111111111111,222222222222222222`. If you use a voice channel's built-in chat for commands, `TEXT_CHANNEL_ID` may be the same as that voice channel ID.

### Step 5: Deploy on the host

```sh
mkdir -p ~/discord-bot1 && cd ~/discord-bot1
curl -fsSLO https://raw.githubusercontent.com/mlshdev/discord-bot1/main/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/mlshdev/discord-bot1/main/.env.example
touch state.json
sudo chown 1000:1000 state.json && sudo chmod 600 state.json
chmod 600 .env
"${EDITOR:-nano}" .env
```

Fill in `DISCORD_TOKEN` and the four IDs. Every variable is described in [Configuration](#configuration). Put the exported `cookies.txt` next to `compose.yml` as described in [YouTube cookies](#youtube-cookies). Both files must exist before the first start: Docker turns a missing bind-mount source into an empty directory. Then start the bot:

```sh
docker compose up -d
```

The image `ghcr.io/mlshdev/discord-bot1:latest` is public, so you don't need to log in to a registry.

### Step 6: Check that it works

1. `docker compose ps` shows the container as `healthy` within about 30 seconds.
2. `docker compose logs discord-bot1` contains `"message":"slash commands registered"` and `"message":"bot ready"` lines, and the bot shows as online in Discord.
3. In the command channel, type `/add`, pick the bot's command, paste `https://www.youtube.com/watch?v=dQw4w9WgXcQ` into `url` and press Enter. The bot shows "is thinking…", then `➕ Added …, starting playback.`, joins the voice channel and plays.
4. As a member with the DJ role, run `/vol level:60` to turn the volume down, `/mn` to open the queue manager, and `/won` to stop.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Container exits with code `78`, log says `invalid youtube cookies` | `cookies.txt` next to `compose.yml` is missing (Docker then creates a directory with that name: `sudo rm -r cookies.txt` and put the file there), unreadable, malformed, signed out or expired. The `error.message` names the exact problem. Fix it as described in [YouTube cookies](#youtube-cookies). |
| Container exits with code `78`, log says `invalid configuration` | A required variable is missing, a required ID is not a 17–20 digit number, or `DJ_ROLE_ID` has an empty entry (`a,,b` or a trailing comma). The message names the variable. Fix `.env`. |
| Logs say `ignoring invalid voice channel` | A `VOICE_CHANNEL_ID` entry is malformed, missing, inaccessible or not a voice channel. The bot continues with usable entries; correct the ID or channel access and recreate the container to include it. If none are usable, `/add` follows the requester into their voice channel. |
| `/add` asks you to join voice | Without usable `VOICE_CHANNEL_ID` entries, join any voice channel first. With several usable IDs, join one of those channels. Then use `/add` again. |
| Container exits with code `78`, log says `startup validation failed` | A required text channel or DJ role is invalid, or the bot is not on that server. Check step 3 and step 4. If the error has `code` `50001` and a route ending in `/commands`, the bot was invited without the `applications.commands` scope: authorise the link from step 2 again. |
| Container exits with code `1`, log says `discord login failed` | The token is wrong or was reset (step 1.3). |
| Typing `/` does not list the bot's commands | Restart the bot and check for `slash commands registered` in the logs. In Discord, press Ctrl+R (Cmd+R on macOS) to reload. Also check **Server Settings → Integrations** in case an admin hid the commands. |
| The bot answers "Music commands only work in #…" | Commands only run in `TEXT_CHANNEL_ID`. |
| "The application did not respond" | The bot was offline or still starting. Check `docker compose ps` and the logs. |
| `missing discord permissions` in the logs, or `failed to send announcement` with `code` `50013` (Missing Permissions) / `50001` (Missing Access) | The bot lacks a permission in that channel. The `missing` field names the exact permissions. Fix the channel overrides from step 3.2. The bot re-checks on its own and logs `discord permissions ok` once fixed. Commands keep working meanwhile; only the "now playing" announcements are lost. |
| The bot does not join voice | It is missing Connect or View Channel on the voice channel, or the channel is full. |
| `/add` answers with error code `E201` or `E210` | YouTube no longer accepts the cookies. Look for `yt-dlp warning` lines in the logs: "cookies are no longer valid" means they were rotated. Export fresh ones as described in [YouTube cookies](#youtube-cookies) and run `docker compose up -d --force-recreate`. |
| The volume resets to 100 after a restart, logs show `could not save bot state` (`E501`) | `state.json` is not writable by UID 1000. Run `sudo chown 1000:1000 state.json`, then `/vol` again. |
| Logs show `bot state path is a directory` (`E501`) | `state.json` did not exist when the container was created, so Docker created a directory with that name. Run `docker compose down && sudo rm -r state.json && touch state.json && sudo chown 1000:1000 state.json && docker compose up -d`. |
| `youtube cookies file has unreadable lines` in the logs | yt-dlp skips those lines. Each line needs 7 fields separated by **tabs**. Copy-paste through a terminal or chat often turns tabs into spaces, so copy the file itself instead (`scp`). |

### Update and uninstall

- **Update:** `docker compose up -d`. With `pull_policy: always`, this pulls the newest image every time. The saved volume in `state.json` is kept.
- **Uninstall:** `docker compose down`, then remove the bot under **Server Settings → Integrations**, or kick it from the member list.

## Configuration

All settings come from `.env`. `.env.example` is the template.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Bot token |
| `GUILD_ID` | yes | — | The only server the bot responds in |
| `TEXT_CHANNEL_ID` | yes | — | The only channel commands run in, and where "now playing" is announced. A voice channel's built-in chat also works. |
| `VOICE_CHANNEL_ID` | no | unrestricted | Optional comma-separated list of voice channels the bot may play in (at most 25 usable IDs). Invalid, missing, inaccessible and non-voice entries are skipped with a warning. If no usable IDs remain, `/add` joins the requester's voice channel; the requester must be in voice. With one usable ID, the bot can join it even if the requester is not in voice. With several, the requester must be in one of them. |
| `DJ_ROLE_ID` | yes | — | One or more roles allowed to use `/ff`, `/mn`, `/won` and `/vol`, comma-separated (at most 25). Any one of them is enough. |
| `MAX_QUEUE_SIZE` | no | `100` | Maximum number of queued tracks (1–1000) |
| `IDLE_DISCONNECT_SECONDS` | no | `300` | How long the bot stays in voice with an empty queue before leaving. `0` means never leave. |
| `AUDIO_BITRATE_KBPS` | no | `128` | Bitrate of the Opus stream sent to Discord (16–510). Every track is re-encoded once after loudness normalisation and volume. Discord caps a voice channel at 64 kbps by default, 96–384 kbps with server boosts. |
| `HEALTH_PORT` | no | `8080` | Port for the `GET /healthz` endpoint |
| `STATE_FILE` | no | `/data/state.json` | Path *inside the container* where the bot keeps its persistent state (the `/vol` level). `compose.yml` bind-mounts `./state.json` there read-write. |
| `YTDLP_COOKIES_FILE` | no | `/config/cookies.txt` | Path *inside the container* to the signed-in YouTube `cookies.txt`. `compose.yml` bind-mounts `./cookies.txt` there read-only. The file itself is required, see [YouTube cookies](#youtube-cookies). |
| `APP_ENV` | no | `production` | Environment name included in log lines |
| `LOG_LEVEL` | no | `info` | Lowest severity written: `debug`, `info`, `warn` or `error`. `debug` adds voice and player state changes. |

The bot checks the IDs at startup. If one is wrong it exits with code `78`.

### YouTube cookies

YouTube answers servers that are not signed in with "Sign in to confirm you're not a bot", so the bot needs the cookies of a signed-in account and does not start without them. Use a throwaway account: the cookies log in to it, and heavy use can get it flagged.

1. Export the cookies so the browser cannot rotate them afterwards. YouTube invalidates exported cookies as soon as the same session is used again in the browser. This is the most common reason cookies "do not work":
   1. Open a new private/incognito window and sign in to YouTube there.
   2. In that same tab, go to `https://www.youtube.com/robots.txt`.
   3. Export the cookies for `youtube.com` in **Netscape** format, for example with the "Get cookies.txt LOCALLY" extension (allow it in private windows). JSON exports do not work.
   4. Close the private window without signing out, and never open it again.
2. Copy the file to the host as `cookies.txt`, next to `compose.yml`. Copy the file itself (`scp`), do not paste its contents: the fields must stay separated by tabs. The container runs as UID 1000, so the file must be readable by that user. Keep it private: `sudo chown 1000:1000 cookies.txt && sudo chmod 600 cookies.txt`. Git ignores this file.
3. Run `docker compose up -d --force-recreate`. The log shows `youtube cookies loaded` with the number of YouTube cookies and when the session expires.

At startup the bot checks that the file is a Netscape `cookies.txt`, that yt-dlp can parse it, and that it holds an unexpired signed-in session (`LOGIN_INFO` plus `SAPISID` for `.youtube.com`). If any check fails it exits with code `78` and names the problem. It cannot tell from the file alone whether YouTube has already rotated the cookies. That shows up later as a `yt-dlp warning` in the logs and error code `E201` on `/add`.

The file is mounted read-only and is read once at startup. The bot works on a private copy inside the container's `/tmp`, which yt-dlp updates as YouTube refreshes the session. After replacing the file, recreate the container so the bot reads it again.

## Health and logs

- `GET /healthz` on `HEALTH_PORT` returns `200 {"status":"ok"}` once the bot is logged in and has checked its channels. Before that it returns `503`. Docker's `HEALTHCHECK` uses this endpoint.
- Logs are one JSON object per line: `info` and `debug` go to stdout, `warn` and `error` to stderr. Docker's `json-file` driver stores them (rotated at 10 MB). Read them with `docker compose logs -f discord-bot1`, or filter with `jq`, for example `docker compose logs --no-log-prefix discord-bot1 | jq 'select(.severity == "warn" or .severity == "error")'`.
- Every line has `timestamp` (UTC), `severity`, `message`, `service` and `environment`, plus fields for the event. Errors carry an `error` object with `name`, `message` and `stack`, and depending on the error: Discord's `code`, `status`, `method` and `route`; Node's `code`, `syscall` and `path`; and a `cause` chain. Tokens in interaction and webhook routes are replaced with `[redacted]`.

  ```json
  {"timestamp":"2026-10-14T16:20:03.118Z","severity":"warn","message":"missing discord permissions","service":"discord-bot1","environment":"production","channel":"text","channelId":"123456789012345678","channelName":"music","missing":["SendMessages"]}
  {"timestamp":"2026-10-14T16:21:40.502Z","severity":"warn","message":"failed to send announcement","service":"discord-bot1","environment":"production","error":{"name":"DiscordAPIError[50013]","message":"Missing Permissions","code":50013,"status":403,"method":"POST","route":"/api/v10/channels/123456789012345678/messages","stack":"…"}}
  ```

- Main messages:

  | Message | Severity | Meaning |
  |---|---|---|
  | `slash commands registered` | info | `/add`, `/ff`, `/mn`, `/won` and `/vol` were registered on the server |
  | `bot ready` | info | Logged in and the channels were validated |
  | `discord permissions ok` / `missing discord permissions` | info / warn | Permission check of the command channel and usable configured voice channels. It runs at startup and again whenever a role or watched channel changes, and is logged only when the result changes. |
  | `ignoring invalid voice channel` | warn | An optional voice-channel entry was skipped. Includes its ID and reason; correct `.env` or channel access and recreate to retry it. |
  | `command received` / `command denied` | info | A command was accepted, or refused (`reason` is `missing DJ role`, `wrong channel` or `not in an allowed voice channel` or `not in a voice channel`) |
  | `command failed` | error | A command threw (`E100`). The user gets a private reply with only the code. Includes `command` and `interactionId`. |
  | `menu interaction denied` | info | A queue-manager button was clicked by someone without any DJ role |
  | `now playing` | info | A track started. Includes the current `volume`. |
  | `volume changed` | info | A DJ used `/vol`. Includes `from`, `to` and `userId`. |
  | `bot state loaded` / `no saved bot state, using defaults` | info | Startup read of `STATE_FILE`, with the restored `volume` |
  | `could not save bot state` / `ignoring invalid bot state` / `could not read bot state` | warn | `E501`. The bot keeps running with the volume in memory or the default. |
  | `youtube cookies loaded` / `invalid youtube cookies` | info / error | The cookie file passed the startup check, or did not (exit code 78) |
  | `yt-dlp warning` | warn | A `WARNING:` line from yt-dlp, for example rotated cookies or skipped cookie lines |
  | `track resolve failed` / `audio source failed` | warn | yt-dlp could not resolve or stream a video. Includes `errorCode`, `errorClass` and the raw reason. |
  | `voice connection failed` / `voice connection lost` | error / warn | The bot could not join voice (`E401`), or lost the connection (`E402`). Nothing is posted in the channel. |
  | `discord gateway disconnected` / `reconnecting` / `resumed` | warn / info | Gateway connection drops and recoveries, with the close code |
  | `invalid configuration` / `startup validation failed` / `discord login failed` / `fatal startup error` | error | Startup failures. These exit with code 78, 78, 1 and 1. |

### Error codes

Discord users only ever see a code. Every log line for a failure carries the same `errorCode` plus an `errorClass` that explains it, so find the meaning with:

```sh
docker compose logs --no-log-prefix discord-bot1 | jq 'select(.errorCode == "E201")'
```

The full catalog lives in `src/errors.ts` and in [TECHNICAL.md](TECHNICAL.md#error-codes). Codes `E2xx` come from yt-dlp and YouTube, `E3xx` from audio playback, `E4xx` from the voice connection, `E5xx` from the bot's state file, and `E1xx` are bugs in the bot.

## Images

`ghcr.io/mlshdev/discord-bot1` is published for `linux/arm64` and `linux/amd64`, with these tags:

| Tag | Meaning |
|---|---|
| `latest` | Newest build from `main` (used by `compose.yml`) |
| `ytdlp-<version>` | Newest build bundling that yt-dlp release |
| `sha-<commit>` | An exact commit |

See [TECHNICAL.md](TECHNICAL.md) for architecture, development and the CI/CD pipeline.
