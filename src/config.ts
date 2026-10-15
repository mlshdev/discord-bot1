import { isLogLevel, type LogLevel } from "./logger.ts";

export interface Config {
  readonly discordToken: string;
  readonly guildId: string;
  readonly textChannelId: string;
  readonly voiceChannelId: string;
  readonly djRoleId: string;
  readonly maxQueueSize: number;
  readonly idleDisconnectSeconds: number;
  readonly healthPort: number;
  readonly ytDlpPath: string;
  readonly ffmpegPath: string;
  readonly ytDlpCookiesFile: string;
  readonly audioBitrateKbps: number;
  readonly environment: string;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

const SNOWFLAKE = /^\d{17,20}$/;

export const DEFAULT_COOKIES_FILE = "/config/cookies.txt";

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(`${key} is required`);
  }
  return value;
}

function optional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function snowflake(env: Env, key: string): string {
  const value = required(env, key);
  if (!SNOWFLAKE.test(value)) {
    throw new ConfigError(`${key} must be a Discord snowflake ID, got "${value}"`);
  }
  return value;
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, key);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function logLevel(env: Env): LogLevel {
  const raw = optional(env, "LOG_LEVEL")?.toLowerCase() ?? "info";
  if (!isLogLevel(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(env: Env): Config {
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    guildId: snowflake(env, "GUILD_ID"),
    textChannelId: snowflake(env, "TEXT_CHANNEL_ID"),
    voiceChannelId: snowflake(env, "VOICE_CHANNEL_ID"),
    djRoleId: snowflake(env, "DJ_ROLE_ID"),
    maxQueueSize: integer(env, "MAX_QUEUE_SIZE", 100, 1, 1000),
    idleDisconnectSeconds: integer(env, "IDLE_DISCONNECT_SECONDS", 300, 0, 86_400),
    healthPort: integer(env, "HEALTH_PORT", 8080, 1, 65_535),
    ytDlpPath: optional(env, "YTDLP_PATH") ?? "yt-dlp",
    ffmpegPath: optional(env, "FFMPEG_PATH") ?? "ffmpeg",
    ytDlpCookiesFile: optional(env, "YTDLP_COOKIES_FILE") ?? DEFAULT_COOKIES_FILE,
    audioBitrateKbps: integer(env, "AUDIO_BITRATE_KBPS", 128, 16, 510),
    environment: optional(env, "APP_ENV") ?? "production",
    logLevel: logLevel(env),
  };
}
