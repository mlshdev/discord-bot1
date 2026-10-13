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
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { describeTrack } from "./format.ts";
import type { Logger } from "./logger.ts";
import { type MoveDirection, type Track, type TrackInfo, TrackQueue } from "./queue.ts";
import { type AudioSource, AudioSourceError, type YtDlp } from "./ytdlp.ts";

const CONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
const SOURCE_EXIT_GRACE_MS = 10_000;

export interface PlayerOptions {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly ytDlp: YtDlp;
  readonly maxQueueSize: number;
  readonly idleDisconnectSeconds: number;
  readonly announce: (content: string) => Promise<void>;
  readonly logger: Logger;
}

export interface PlayerSnapshot {
  readonly current: Track | undefined;
  readonly paused: boolean;
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

export class MusicPlayer extends EventEmitter<PlayerEvents> {
  readonly #options: PlayerOptions;
  readonly #queue: TrackQueue;
  readonly #audioPlayer: AudioPlayer;
  #connection: VoiceConnection | undefined;
  #current: Track | undefined;
  #source: AudioSource | undefined;
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
      void this.#advance();
    });
    this.#audioPlayer.on("stateChange", () => this.emit("change"));
    this.#audioPlayer.on("error", (error) => {
      const track = (error.resource as AudioResource<Track>).metadata;
      this.#options.logger.error("audio player error", { error, url: track.url });
    });
  }

  get queueIsFull(): boolean {
    return this.#queue.isFull;
  }

  snapshot(): PlayerSnapshot {
    return {
      current: this.#current,
      paused: this.#audioPlayer.state.status === AudioPlayerStatus.Paused,
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
          this.#options.logger.error("voice connection failed", { error });
          await this.#safeAnnounce("⚠️ Could not join the voice channel. Try `!add` again later.");
          return;
        }
        if (await this.#start(next, generation)) {
          return;
        }
      }
    } finally {
      this.#advancing = false;
      this.emit("change");
    }
  }

  // Resolves true once advancing should stop: the track is playing or the player was reset meanwhile.
  async #start(track: Track, generation: number): Promise<boolean> {
    const { logger } = this.#options;
    let source: AudioSource;
    try {
      source = await this.#options.ytDlp.open(track.url);
    } catch (error) {
      if (generation !== this.#generation) {
        return true;
      }
      const reason = error instanceof AudioSourceError ? `: ${error.message}` : "";
      logger.error("failed to open audio source", { error, url: track.url });
      void this.#safeAnnounce(`⚠️ Could not play ${describeTrack(track)}${reason}, skipping.`);
      return false;
    }
    if (generation !== this.#generation) {
      source.stop();
      return true;
    }
    this.#source = source;
    this.#current = track;
    void source.finished.then((outcome) => {
      if (!outcome.ok && !outcome.stopped) {
        logger.warn("audio source failed", { url: track.url, reason: outcome.reason });
        void this.#safeAnnounce(`⚠️ Playback of ${describeTrack(track)} failed: ${outcome.reason}`);
      }
    });
    const resource = createAudioResource(source.stream, {
      inputType: source.inputType,
      metadata: track,
    });
    this.#audioPlayer.play(resource);
    logger.info("now playing", {
      url: track.url,
      title: track.title,
      requestedBy: track.requestedBy,
      inputType: source.inputType,
      transcoded: source.transcoded,
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
      logger.warn("voice connection lost");
      const cleared = this.disconnect();
      void this.#safeAnnounce(
        `👋 Lost the voice connection; stopped playback and cleared ${cleared} queued track(s).`,
      );
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
