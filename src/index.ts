import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  MessageFlags,
  type Role,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from "discord.js";
import {
  COMMAND_DEFINITIONS,
  type Command,
  PRIVILEGED_COMMANDS,
  toCommand,
  URL_OPTION,
} from "./commands.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { describeTrack } from "./format.ts";
import { startHealthServer } from "./health.ts";
import { createLogger, type Logger } from "./logger.ts";
import { openMenu } from "./menu.ts";
import {
  auditKey,
  type ChannelAudit,
  missingPermissions,
  TEXT_CHANNEL_PERMISSIONS,
  VOICE_CHANNEL_PERMISSIONS,
} from "./permissions.ts";
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

type CommandInteraction = ChatInputCommandInteraction<"cached">;

function hasDjRole(member: GuildMember | null, config: Config): boolean {
  return member?.roles.cache.has(config.djRoleId) ?? false;
}

async function replyPrivately(interaction: CommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

async function handleAdd(
  interaction: CommandInteraction,
  argument: string,
  runtime: Runtime,
): Promise<void> {
  const url = parseYouTubeUrl(argument);
  if (url === undefined) {
    await replyPrivately(
      interaction,
      "Only YouTube video links are accepted, for example `/add url:https://youtu.be/dQw4w9WgXcQ`.",
    );
    return;
  }
  if (runtime.player.queueIsFull) {
    await replyPrivately(interaction, `The queue is full (${runtime.config.maxQueueSize} tracks).`);
    return;
  }
  // yt-dlp usually needs longer than the 3 seconds Discord allows before the first response.
  await interaction.deferReply();
  let info: Awaited<ReturnType<YtDlp["resolve"]>>;
  try {
    info = await runtime.ytDlp.resolve(url);
  } catch (error) {
    runtime.logger.warn("track resolve failed", { url, error });
    const reason = error instanceof TrackResolveError ? error.message : "unexpected error";
    await interaction.editReply(`⚠️ Could not add that video: ${reason}`);
    return;
  }
  try {
    const result = runtime.player.enqueue(info, interaction.user.id);
    await interaction.editReply(
      result.kind === "started"
        ? `➕ Added ${describeTrack(result.track)}, starting playback.`
        : `➕ Added ${describeTrack(result.track)} at position **${result.position}**.`,
    );
  } catch (error) {
    if (error instanceof QueueFullError) {
      await interaction.editReply(`The queue is full (${error.capacity} tracks).`);
      return;
    }
    throw error;
  }
}

async function dispatch(
  interaction: CommandInteraction,
  command: Command,
  runtime: Runtime,
): Promise<void> {
  const { player } = runtime;
  switch (command.kind) {
    case "add":
      await handleAdd(interaction, command.url, runtime);
      return;
    case "forceSkip": {
      const skipped = player.forceSkip();
      await interaction.reply(
        skipped === undefined ? "Nothing is playing." : `⏭️ Skipped ${describeTrack(skipped)}`,
      );
      return;
    }
    case "manage":
      await openMenu(interaction, {
        player,
        logger: runtime.logger,
        isAuthorized: (component: ButtonInteraction | StringSelectMenuInteraction) =>
          component.inCachedGuild() &&
          component.guildId === runtime.config.guildId &&
          hasDjRole(component.member, runtime.config),
      });
      return;
    case "disconnect": {
      const cleared = player.disconnect();
      await interaction.reply(`👋 Disconnected and cleared ${cleared} queued track(s).`);
      return;
    }
  }
}

async function handleCommand(interaction: CommandInteraction, runtime: Runtime): Promise<void> {
  const { config, logger } = runtime;
  const command = toCommand(interaction.commandName, interaction.options.getString(URL_OPTION));
  if (command === undefined) {
    logger.warn("unknown command", { command: interaction.commandName });
    await replyPrivately(interaction, "Unknown command.");
    return;
  }
  if (interaction.channelId !== config.textChannelId) {
    logger.info("command denied", {
      command: command.kind,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      reason: "wrong channel",
    });
    await replyPrivately(interaction, `Music commands only work in <#${config.textChannelId}>.`);
    return;
  }
  if (PRIVILEGED_COMMANDS.has(command.kind) && !hasDjRole(interaction.member, config)) {
    logger.info("command denied", {
      command: command.kind,
      userId: interaction.user.id,
      reason: "missing DJ role",
      djRoleId: config.djRoleId,
    });
    await replyPrivately(interaction, `⛔ This command requires the <@&${config.djRoleId}> role.`);
    return;
  }
  logger.info("command received", { command: command.kind, userId: interaction.user.id });
  await dispatch(interaction, command, runtime);
}

async function auditChannels(
  guild: Guild,
  textChannel: GuildTextBasedChannel,
  voiceChannel: VoiceBasedChannel,
): Promise<ChannelAudit[]> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  return [
    {
      role: "text",
      channelId: textChannel.id,
      channelName: textChannel.name,
      missing: missingPermissions(textChannel.permissionsFor(me), TEXT_CHANNEL_PERMISSIONS),
    },
    {
      role: "voice",
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      missing: missingPermissions(voiceChannel.permissionsFor(me), VOICE_CHANNEL_PERMISSIONS),
    },
  ];
}

function reportAudits(audits: readonly ChannelAudit[], logger: Logger): void {
  for (const audit of audits) {
    if (audit.missing.length === 0) {
      logger.info("discord permissions ok", {
        channel: audit.role,
        channelId: audit.channelId,
        channelName: audit.channelName,
      });
    } else {
      logger.warn("missing discord permissions", {
        channel: audit.role,
        channelId: audit.channelId,
        channelName: audit.channelName,
        missing: audit.missing,
      });
    }
  }
}

// Used until the configuration is loaded, and for crashes that escape main().
const bootLogger = createLogger({
  service: SERVICE,
  environment: process.env.APP_ENV ?? "production",
  level: "info",
});

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    bootLogger.error("invalid configuration", { error });
    process.exit(error instanceof ConfigError ? 78 : 1);
  }
  const logger = createLogger({
    service: SERVICE,
    environment: config.environment,
    level: config.logLevel,
  });

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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
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
      // Guild commands replace the whole set in one call and show up in the client instantly.
      const registered = await guild.commands.set([...COMMAND_DEFINITIONS]);
      logger.info("slash commands registered", {
        commands: registered.map((command) => command.name),
      });
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

      // Re-audited whenever a role or one of the two channels changes; logged only on a change.
      let lastAudit = "";
      const reaudit = async (): Promise<void> => {
        try {
          const audits = await auditChannels(guild, announceChannel, voiceChannel);
          const key = auditKey(audits);
          if (key !== lastAudit) {
            lastAudit = key;
            reportAudits(audits, logger);
          }
        } catch (error) {
          logger.warn("permission audit failed", { error });
        }
      };
      await reaudit();
      const watchedChannels = new Set([textChannel.id, voiceChannel.id]);
      client.on(Events.ChannelUpdate, (_old, updated) => {
        if (watchedChannels.has(updated.id)) {
          void reaudit();
        }
      });
      const onRoleChange = (role: Role): void => {
        if (role.guild.id === guild.id) {
          void reaudit();
        }
      };
      client.on(Events.GuildRoleCreate, onRoleChange);
      client.on(Events.GuildRoleUpdate, (_old, updated) => onRoleChange(updated));
      client.on(Events.GuildRoleDelete, onRoleChange);
    } catch (error) {
      logger.error("startup validation failed", { error });
      await client.destroy();
      process.exit(78);
    }
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (
      !interaction.isChatInputCommand() ||
      !interaction.inCachedGuild() ||
      interaction.guildId !== config.guildId
    ) {
      return;
    }
    if (runtime === undefined) {
      void interaction
        .reply({ content: "The bot is still starting, try again.", flags: MessageFlags.Ephemeral })
        .catch((error: unknown) => logger.debug("startup reply failed", { error }));
      return;
    }
    const active = runtime;
    handleCommand(interaction, active).catch(async (error: unknown) => {
      logger.error("command failed", {
        error,
        command: interaction.commandName,
        interactionId: interaction.id,
      });
      await replyPrivately(interaction, "⚠️ Something went wrong running that command.").catch(
        (replyError: unknown) => logger.debug("error reply failed", { error: replyError }),
      );
    });
  });
  client.on(Events.Error, (error) => logger.error("discord client error", { error }));
  client.on(Events.Warn, (warning) => logger.warn("discord client warning", { warning }));
  client.on(Events.ShardDisconnect, (event, shardId) =>
    logger.warn("discord gateway disconnected", { shardId, closeCode: event.code }),
  );
  client.on(Events.ShardReconnecting, (shardId) =>
    logger.info("discord gateway reconnecting", { shardId }),
  );
  client.on(Events.ShardResume, (shardId, replayedEvents) =>
    logger.info("discord gateway resumed", { shardId, replayedEvents }),
  );
  client.on(Events.ShardError, (error, shardId) =>
    logger.error("discord gateway error", { error, shardId }),
  );
  client.on(Events.Invalidated, () => logger.error("discord session invalidated"));

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

try {
  await main();
} catch (error) {
  bootLogger.error("fatal startup error", { error });
  process.exit(1);
}
