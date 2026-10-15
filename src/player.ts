import { EventEmitter } from "node:events";
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { MAX_VOLUME_LEVEL } from "./commands.ts";
import { errorFields } from "./errors.ts";
import { describeTrack } from "./format.ts";
import type { Logger } from "./logger.ts";
import { type MoveDirection, type Track, type TrackInfo, TrackQueue } from "./queue.ts";
import type { AudioSource, YtDlp } from "./ytdlp.ts";

const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
const SOURCE_EXIT_GRACE_MS = 10_000;

export const DEFAULT_VOLUME = 100;

export interface PlayerOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly ytDlp: YtDlp;
  readonly maxQueueSize: number;
  readonly idleDisconnectSeconds: number;
  readonly audioBitrateKbps: number;
  readonly announce: (content: string) => Promise<void>;
  readonly logger: Logger;
}

export interface PlayerSnapshot {
  readonly current: Track | undefined;
  readonly paused: boolean;
  readonly volume: number;
  readonly upcoming: readonly Track[];
}

export type EnqueueResult =
  | { readonly kind: "started"; readonly track: Track }
  | { readonly kind: "queued"; readonly track: Track; readonly position: number };

interface PlayerEvents {
  change: [];
}

export class VoiceConnectError extends Error {
  override readonly name = "VoiceConnectError";
}

export class VolumeRangeError extends Error {
  override readonly name = "VolumeRangeError";
}

export class MusicPlayer extends EventEmitter<PlayerEvents> {
  readonly #options: PlayerOptions;
  readonly #queue: TrackQueue;
  readonly #audioPlayer: AudioPlayer;
  #connection: VoiceConnection | undefined;
  #current: Track | undefined;
  #source: AudioSource | undefined;
  #resource: AudioResource<Track> | undefined;
  #volume = DEFAULT_VOLUME;
  #advancing = false;
  #idleTimer: NodeJS.Timeout | undefined;
  #nextUid = 1;
  #generation = 0;

  constructor(options: PlayerOptions) {
    super();
    this.#options = options;
    this.#queue = new TrackQueue(options.maxQueueSize);
    this.#audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.#audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.#releaseSource(SOURCE_EXIT_GRACE_MS);
      this.#current = undefined;
      this.#resource = undefined;
      void this.#advance();
    });
    this.#audioPlayer.on("stateChange", (from, to) => {
      options.logger.debug("audio player state", { from: from.status, to: to.status });
      this.emit("change");
    });
    this.#audioPlayer.on("error", (error) => {
      const track = (error.resource as AudioResource<Track>).metadata;
      this.#options.logger.error("audio player error", {
        ...errorFields("E303"),
        error,
        url: track.url,
      });
    });
  }

  get queueIsFull(): boolean {
    return this.#queue.isFull;
  }

  snapshot(): PlayerSnapshot {
    return {
      current: this.#current,
      paused: this.#audioPlayer.state.status === AudioPlayerStatus.Paused,
      volume: this.#volume,
      upcoming: this.#queue.items,
    };
  }

  enqueue(info: TrackInfo, requestedBy: string): EnqueueResult {
    const track: Track = { ...info, uid: `t${this.#nextUid++}`, requestedBy };
    const position = this.#queue.enqueue(track);
    this.emit("change");
    if (this.#current === undefined && !this.#advancing) {
      void this.#advance();
      return { kind: "started", track };
    }
    return { kind: "queued", track, position };
  }

  get volume(): number {
    return this.#volume;
  }

  // Percent of the normalised loudness; applies to the current track at once and to all later ones.
  setVolume(percent: number): void {
    if (!Number.isInteger(percent) || percent < 0 || percent > MAX_VOLUME_LEVEL) {
      throw new VolumeRangeError(
        `Volume must be an integer from 0 to ${MAX_VOLUME_LEVEL}, got ${percent}`,
      );
    }
    this.#volume = percent;
    this.#resource?.volume?.setVolume(percent / 100);
    this.emit("change");
  }

  forceSkip(): Track | undefined {
    const skipped = this.#current;
    if (skipped !== undefined) {
      this.#releaseSource();
      this.#audioPlayer.stop(true);
    }
    return skipped;
  }

  playNow(uid: string): Track | undefined {
    const track = this.#queue.promote(uid);
    if (track === undefined) {
      return undefined;
    }
    if (this.#current !== undefined) {
      this.#releaseSource();
      this.#audioPlayer.stop(true);
    } else if (!this.#advancing) {
      void this.#advance();
    }
    this.emit("change");
    return track;
  }

  togglePause(): boolean {
    const status = this.#audioPlayer.state.status;
    if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
      this.#audioPlayer.unpause();
      return false;
    }
    if (this.#current !== undefined) {
      this.#audioPlayer.pause(true);
      return true;
    }
    return false;
  }

  remove(uid: string): Track | undefined {
    const removed = this.#queue.remove(uid);
    this.emit("change");
    return removed;
  }

  move(uid: string, direction: MoveDirection): boolean {
    const moved = this.#queue.move(uid, direction);
    this.emit("change");
    return moved;
  }

  shuffle(): void {
    this.#queue.shuffle();
    this.emit("change");
  }

  clearQueue(): number {
    const cleared = this.#queue.clear();
    this.emit("change");
    return cleared;
  }

  disconnect(): number {
    this.#generation++;
    const cleared = this.#queue.clear();
    this.#releaseSource();
    this.#audioPlayer.stop(true);
    this.#current = undefined;
    this.#resource = undefined;
    this.#clearIdleTimer();
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    this.emit("change");
    return cleared;
  }

  async #advance(): Promise<void> {
    if (this.#advancing) {
      return;
    }
    this.#advancing = true;
    try {
      for (;;) {
        const next = this.#queue.shift();
        if (next === undefined) {
          this.#scheduleIdleDisconnect();
          return;
        }
        this.#clearIdleTimer();
        const generation = this.#generation;
        try {
          await this.#ensureConnection();
        } catch (error) {
          if (generation !== this.#generation) {
            return;
          }
          this.#queue.unshift(next);
          this.#options.logger.error("voice connection failed", { ...errorFields("E401"), error });
          return;
        }
        if (generation !== this.#generation) {
          return;
        }
        if (this.#start(next)) {
          return;
        }
      }
    } finally {
      this.#advancing = false;
      this.emit("change");
    }
  }

  // Returns true once a track is playing; false means it was skipped and the next one is due.
  #start(track: Track): boolean {
    const { logger, audioBitrateKbps } = this.#options;
    let source: AudioSource;
    try {
      source = this.#options.ytDlp.open(track.url);
    } catch (error) {
      logger.error("failed to open audio source", {
        ...errorFields("E301"),
        error,
        url: track.url,
      });
      return false;
    }
    this.#source = source;
    this.#current = track;
    void source.finished.then((outcome) => {
      if (!outcome.ok && !outcome.stopped) {
        logger.warn("audio source failed", {
          ...errorFields("E302"),
          url: track.url,
          reason: outcome.reason,
        });
      }
    });
    const resource = createAudioResource(source.stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: track,
    });
    resource.volume?.setVolume(this.#volume / 100);
    resource.encoder?.setBitrate(audioBitrateKbps * 1000);
    this.#resource = resource;
    this.#audioPlayer.play(resource);
    logger.info("now playing", {
      url: track.url,
      title: track.title,
      requestedBy: track.requestedBy,
      volume: this.#volume,
    });
    void this.#safeAnnounce(
      `🎶 Now playing ${describeTrack(track)} — requested by <@${track.requestedBy}>`,
    );
    return true;
  }

  async #ensureConnection(): Promise<VoiceConnection> {
    const existing = this.#connection;
    if (existing !== undefined && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        return await entersState(existing, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
      } catch (error) {
        this.#connection = undefined;
        existing.destroy();
        throw new VoiceConnectError("Voice connection did not recover", { cause: error });
      }
    }
    const { guildId, voiceChannelId, adapterCreator, logger } = this.#options;
    const connection = joinVoiceChannel({
      guildId,
      channelId: voiceChannelId,
      adapterCreator,
      selfDeaf: true,
    });
    this.#connection = connection;
    connection.on("error", (error) => logger.error("voice connection error", { error }));
    connection.on("stateChange", (from, to) =>
      logger.debug("voice connection state", { from: from.status, to: to.status }),
    );
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
      ]).catch(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.#connection !== connection) {
        return;
      }
      this.#connection = undefined;
      const cleared = this.disconnect();
      logger.warn("voice connection lost", { ...errorFields("E402"), cleared });
    });
    connection.subscribe(this.#audioPlayer);
    try {
      return await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch (error) {
      this.#connection = undefined;
      connection.destroy();
      throw new VoiceConnectError("Timed out joining the voice channel", { cause: error });
    }
  }

  #scheduleIdleDisconnect(): void {
    this.#clearIdleTimer();
    const seconds = this.#options.idleDisconnectSeconds;
    if (seconds === 0 || this.#connection === undefined) {
      return;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#current === undefined && this.#queue.size === 0) {
        this.#options.logger.info("idle timeout reached, leaving voice channel");
        this.disconnect();
      }
    }, seconds * 1000);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  // A naturally finished source gets a grace period so its exit status can still be reported.
  #releaseSource(graceMs = 0): void {
    const source = this.#source;
    this.#source = undefined;
    if (source === undefined) {
      return;
    }
    if (graceMs === 0) {
      source.stop();
    } else {
      setTimeout(() => source.stop(), graceMs).unref();
    }
  }

  async #safeAnnounce(content: string): Promise<void> {
    try {
      await this.#options.announce(content);
    } catch (error) {
      this.#options.logger.warn("failed to send announcement", { error });
    }
  }
}
