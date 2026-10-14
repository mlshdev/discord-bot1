import {
  type ButtonInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type StringSelectMenuInteraction,
} from "discord.js";
import { type Command, PRIVILEGED_COMMANDS, parseCommand } from "./commands.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { describeTrack } from "./format.ts";
import { startHealthServer } from "./health.ts";
import { createLogger, type Logger } from "./logger.ts";
import { openMenu } from "./menu.ts";
import { MusicPlayer } from "./player.ts";
import { QueueFullError } from "./queue.ts";
import { parseYouTubeUrl } from "./youtube.ts";
import { TrackResolveError, YtDlp } from "./ytdlp.ts";

const SERVICE = "discord-bot1";

interface Runtime {
  readonly config: Config;
  readonly logger: Logger;
  readonly ytDlp: YtDlp;
  readonly player: MusicPlayer;
}

function hasDjRole(member: GuildMember | null, config: Config): boolean {
  return member?.roles.cache.has(config.djRoleId) ?? false;
}

async function handleAdd(
  message: Message<true>,
  argument: string,
  runtime: Runtime,
): Promise<void> {
  const url = parseYouTubeUrl(argument);
  if (url === undefined) {
    await message.reply(
      "Usage: `!add <youtube-video-url>` — only YouTube video links are accepted.",
    );
    return;
  }
  if (runtime.player.queueIsFull) {
    await message.reply(`The queue is full (${runtime.config.maxQueueSize} tracks).`);
    return;
  }
  await message.channel.sendTyping().catch(() => undefined);
  let info: Awaited<ReturnType<YtDlp["resolve"]>>;
  try {
    info = await runtime.ytDlp.resolve(url);
  } catch (error) {
    runtime.logger.warn("track resolve failed", { url, error });
    const reason = error instanceof TrackResolveError ? error.message : "unexpected error";
    await message.reply(`⚠️ Could not add that video: ${reason}`);
    return;
  }
  try {
    const result = runtime.player.enqueue(info, message.author.id);
    await message.reply(
      result.kind === "started"
        ? `➕ Added ${describeTrack(result.track)}, starting playback.`
        : `➕ Added ${describeTrack(result.track)} at position **${result.position}**.`,
    );
  } catch (error) {
    if (error instanceof QueueFullError) {
      await message.reply(`The queue is full (${error.capacity} tracks).`);
      return;
    }
    throw error;
  }
}

async function dispatch(message: Message<true>, command: Command, runtime: Runtime): Promise<void> {
  const { player } = runtime;
  switch (command.kind) {
    case "add":
      await handleAdd(message, command.argument, runtime);
      return;
    case "forceSkip": {
      const skipped = player.forceSkip();
      await message.reply(
        skipped === undefined ? "Nothing is playing." : `⏭️ Skipped ${describeTrack(skipped)}`,
      );
      return;
    }
    case "manage":
      await openMenu(message, {
        player,
        logger: runtime.logger,
        isAuthorized: (interaction: ButtonInteraction | StringSelectMenuInteraction) =>
          interaction.inCachedGuild() &&
          interaction.guildId === runtime.config.guildId &&
          hasDjRole(interaction.member, runtime.config),
      });
      return;
    case "disconnect": {
      const cleared = player.disconnect();
      await message.reply(`👋 Disconnected and cleared ${cleared} queued track(s).`);
      return;
    }
  }
}

async function handleMessage(message: Message, runtime: Runtime): Promise<void> {
  const { config } = runtime;
  if (
    message.author.bot ||
    !message.inGuild() ||
    message.guildId !== config.guildId ||
    message.channelId !== config.textChannelId
  ) {
    return;
  }
  const command = parseCommand(message.content);
  if (command === undefined) {
    return;
  }
  if (PRIVILEGED_COMMANDS.has(command.kind) && !hasDjRole(message.member, config)) {
    await message.reply(`⛔ This command requires the <@&${config.djRoleId}> role.`);
    return;
  }
  runtime.logger.info("command received", { command: command.kind, userId: message.author.id });
  await dispatch(message, command, runtime);
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    createLogger(SERVICE, process.env.APP_ENV ?? "production").error("invalid configuration", {
      error,
    });
    process.exit(error instanceof ConfigError ? 78 : 1);
  }
  const logger = createLogger(SERVICE, config.environment);

  const ytDlp = await YtDlp.create({
    ytDlpPath: config.ytDlpPath,
    ffmpegPath: config.ffmpegPath,
    nodePath: process.execPath,
    cookiesFile: config.ytDlpCookiesFile,
    audioBitrateKbps: config.audioBitrateKbps,
    logger,
  });
  logger.info("yt-dlp detected", { version: await ytDlp.version() });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });

  let runtime: Runtime | undefined;
  const health = startHealthServer(
    config.healthPort,
    () => runtime !== undefined && client.isReady(),
    logger,
  );

  client.once(Events.ClientReady, async (ready) => {
    try {
      const guild = await ready.guilds.fetch(config.guildId);
      const textChannel = await guild.channels.fetch(config.textChannelId);
      const voiceChannel = await guild.channels.fetch(config.voiceChannelId);
      if (textChannel === null || !textChannel.isTextBased()) {
        throw new ConfigError("TEXT_CHANNEL_ID does not point to a text channel in the guild");
      }
      if (voiceChannel === null || !voiceChannel.isVoiceBased()) {
        throw new ConfigError("VOICE_CHANNEL_ID does not point to a voice channel in the guild");
      }
      const announceChannel: GuildTextBasedChannel = textChannel;
      const player = new MusicPlayer({
        guildId: guild.id,
        voiceChannelId: voiceChannel.id,
        adapterCreator: guild.voiceAdapterCreator,
        ytDlp,
        maxQueueSize: config.maxQueueSize,
        idleDisconnectSeconds: config.idleDisconnectSeconds,
        announce: async (content) => {
          await announceChannel.send({ content });
        },
        logger,
      });
      runtime = { config, logger, ytDlp, player };
      logger.info("bot ready", {
        user: ready.user.tag,
        guild: guild.name,
        textChannel: textChannel.name,
        voiceChannel: voiceChannel.name,
      });
    } catch (error) {
      logger.error("startup validation failed", { error });
      await client.destroy();
      process.exit(78);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (runtime === undefined) {
      return;
    }
    handleMessage(message, runtime).catch((error: unknown) =>
      logger.error("command failed", { error, messageId: message.id }),
    );
  });
  client.on(Events.Error, (error) => logger.error("discord client error", { error }));
  client.on(Events.Warn, (warning) => logger.warn("discord client warning", { warning }));

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });
    runtime?.player.disconnect();
    health.close();
    await client.destroy();
    process.exit(0);
  };
  process.once("SIGTERM", (signal) => void shutdown(signal));
  process.once("SIGINT", (signal) => void shutdown(signal));
  process.on("unhandledRejection", (error) => logger.error("unhandled rejection", { error }));

  try {
    await client.login(config.discordToken);
  } catch (error) {
    logger.error("discord login failed", { error });
    health.close();
    await client.destroy();
    process.exit(1);
  }
}

await main();
