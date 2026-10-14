import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { demuxProbe, StreamType } from "@discordjs/voice";
import type { Logger } from "./logger.ts";
import type { TrackInfo } from "./queue.ts";

const execFileAsync = promisify(execFile);

const RESOLVE_TIMEOUT_MS = 45_000;
const STDERR_TAIL_BYTES = 4096;
const PROBE_BYTES = 16 * 1024;
const METADATA_TEMPLATE = "%(.{id,title,duration,uploader,channel,live_status,webpage_url})j";

// Audio-only formats exclusively (never a muxed video format), Opus first so it is passed
// through to Discord untouched; anything else falls back to a single ffmpeg encode.
export const AUDIO_FORMAT = "bestaudio[acodec=opus]/bestaudio";

const PASSTHROUGH_TYPES: ReadonlySet<StreamType> = new Set([
  StreamType.WebmOpus,
  StreamType.OggOpus,
]);

export class TrackResolveError extends Error {
  override readonly name = "TrackResolveError";
}

export class AudioSourceError extends Error {
  override readonly name = "AudioSourceError";
}

export interface AudioSource {
  readonly stream: Readable;
  readonly inputType: StreamType;
  readonly transcoded: boolean;
  readonly finished: Promise<SourceOutcome>;
  stop(): void;
}

export type SourceOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly stopped: true }
  | { readonly ok: false; readonly stopped: false; readonly reason: string };

export interface YtDlpOptions {
  readonly ytDlpPath: string;
  readonly ffmpegPath: string;
  readonly nodePath: string;
  readonly cookiesFile: string | undefined;
  readonly audioBitrateKbps: number;
  readonly logger: Logger;
}

interface Pipeline {
  readonly child: ChildProcess;
  readonly stderr: () => string;
}

interface RawMetadata {
  readonly id: unknown;
  readonly title: unknown;
  readonly duration: unknown;
  readonly uploader: unknown;
  readonly channel: unknown;
  readonly live_status: unknown;
  readonly webpage_url: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseMetadata(stdout: string, fallbackUrl: string): TrackInfo {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line === "") {
    throw new TrackResolveError("yt-dlp returned no metadata");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TrackResolveError("yt-dlp returned malformed metadata");
  }
  if (!isRecord(parsed)) {
    throw new TrackResolveError("yt-dlp returned malformed metadata");
  }
  const raw = parsed as Partial<RawMetadata>;
  if (raw.live_status === "is_live" || raw.live_status === "is_upcoming") {
    throw new TrackResolveError("Live streams and premieres are not supported");
  }
  const title = asString(raw.title);
  if (title === undefined) {
    throw new TrackResolveError("yt-dlp returned a video without a title");
  }
  return {
    url: asString(raw.webpage_url) ?? fallbackUrl,
    title,
    durationSeconds:
      typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : undefined,
    uploader: asString(raw.uploader) ?? asString(raw.channel),
  };
}

export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const error = lines.findLast((line) => line.startsWith("ERROR:"));
  const message = (error ?? lines.at(-1) ?? "unknown error").replace(/^ERROR:\s*/, "");
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}

function tailCollector(child: ChildProcess): () => string {
  let tail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  return () => tail;
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("close", (code: number | null) => resolve(code));
    child.once("error", () => resolve(-1));
  });
}

export class YtDlp {
  readonly #options: YtDlpOptions;
  readonly #cookiesPath: string | undefined;

  private constructor(options: YtDlpOptions, cookiesPath: string | undefined) {
    this.#options = options;
    this.#cookiesPath = cookiesPath;
  }

  // yt-dlp rewrites the cookie jar on exit, so it must not point at a read-only mount.
  static async create(options: YtDlpOptions): Promise<YtDlp> {
    if (options.cookiesFile === undefined) {
      return new YtDlp(options, undefined);
    }
    const target = join(tmpdir(), "discord-bot1-cookies.txt");
    await copyFile(options.cookiesFile, target);
    await chmod(target, 0o600);
    return new YtDlp(options, target);
  }

  #baseArgs(): string[] {
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      // Only the Node binary running the bot may solve YouTube's JS challenges; yt-dlp starts it
      // with --permission, so the solver has no filesystem, network or child-process access.
      "--no-js-runtimes",
      "--js-runtimes",
      `node:${this.#options.nodePath}`,
      "--format",
      AUDIO_FORMAT,
    ];
    if (this.#cookiesPath !== undefined) {
      args.push("--cookies", this.#cookiesPath);
    }
    return args;
  }

  async version(): Promise<string> {
    const { stdout } = await execFileAsync(this.#options.ytDlpPath, ["--version"], {
      timeout: 15_000,
    });
    return stdout.trim();
  }

  async resolve(url: string): Promise<TrackInfo> {
    const args = [...this.#baseArgs(), "--skip-download", "--print", METADATA_TEMPLATE, "--", url];
    try {
      const { stdout } = await execFileAsync(this.#options.ytDlpPath, args, {
        timeout: RESOLVE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return parseMetadata(stdout, url);
    } catch (error) {
      if (error instanceof TrackResolveError) {
        throw error;
      }
      const stderr =
        isRecord(error) && typeof error.stderr === "string" ? error.stderr : String(error);
      const killed = isRecord(error) && error.killed === true;
      throw new TrackResolveError(
        killed ? "Timed out while resolving the video" : summarizeStderr(stderr),
        { cause: error },
      );
    }
  }

  async open(url: string): Promise<AudioSource> {
    const { ytDlpPath, logger } = this.#options;
    const pipelines: Pipeline[] = [];
    let stopped = false;
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const { child } of pipelines) {
        child.kill("SIGKILL");
      }
    };

    const downloader = spawn(
      ytDlpPath,
      [...this.#baseArgs(), "--quiet", "--output", "-", "--", url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    pipelines.push({ child: downloader, stderr: tailCollector(downloader) });
    downloader.on("error", (error) => logger.error("failed to spawn yt-dlp", { error }));
    const output = downloader.stdout;
    if (output === null) {
      stop();
      throw new AudioSourceError("yt-dlp stdout is not available");
    }
    output.on("error", (error) => logger.debug("yt-dlp pipe closed", { error }));

    let probe: Awaited<ReturnType<typeof demuxProbe>>;
    try {
      probe = await demuxProbe(output, PROBE_BYTES);
    } catch (error) {
      stop();
      throw new AudioSourceError("Could not read the audio stream", { cause: error });
    }

    if (PASSTHROUGH_TYPES.has(probe.type)) {
      return {
        stream: probe.stream,
        inputType: probe.type,
        transcoded: false,
        finished: this.#outcome(pipelines, () => stopped),
        stop,
      };
    }

    if (output.readableEnded) {
      const code = await exitOf(downloader);
      if (code !== 0) {
        stop();
        throw new AudioSourceError(summarizeStderr(pipelines[0]?.stderr() ?? ""));
      }
    }

    const encoder = this.#spawnEncoder();
    pipelines.push({ child: encoder, stderr: tailCollector(encoder) });
    if (encoder.stdin === null || encoder.stdout === null) {
      stop();
      throw new AudioSourceError("ffmpeg pipes are not available");
    }
    encoder.stdin.on("error", (error) => logger.debug("ffmpeg stdin closed", { error }));
    encoder.stdout.on("error", (error) => logger.debug("ffmpeg stdout closed", { error }));
    probe.stream.pipe(encoder.stdin);
    return {
      stream: encoder.stdout,
      inputType: StreamType.OggOpus,
      transcoded: true,
      finished: this.#outcome(pipelines, () => stopped),
      stop,
    };
  }

  #spawnEncoder(): ChildProcess {
    const { ffmpegPath, audioBitrateKbps, logger } = this.#options;
    const encoder = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "libopus",
        "-b:a",
        `${audioBitrateKbps}k`,
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    encoder.on("error", (error) => logger.error("failed to spawn ffmpeg", { error }));
    return encoder;
  }

  #outcome(pipelines: readonly Pipeline[], isStopped: () => boolean): Promise<SourceOutcome> {
    return Promise.all(pipelines.map(({ child }) => exitOf(child))).then((codes): SourceOutcome => {
      if (isStopped()) {
        return { ok: false, stopped: true };
      }
      const failed = codes.findIndex((code) => code !== 0);
      if (failed !== -1) {
        return {
          ok: false,
          stopped: false,
          reason: summarizeStderr(pipelines[failed]?.stderr() ?? ""),
        };
      }
      return { ok: true };
    });
  }
}
