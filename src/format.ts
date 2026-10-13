import { escapeMarkdown } from "discord.js";
import type { Track } from "./queue.ts";

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "?:??";
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function describeTrack(track: Track): string {
  return `**${escapeMarkdown(truncate(track.title, 200))}** \`${formatDuration(track.durationSeconds)}\``;
}

export function totalDuration(tracks: readonly Track[]): number | undefined {
  let sum = 0;
  for (const track of tracks) {
    if (track.durationSeconds === undefined) {
      return undefined;
    }
    sum += track.durationSeconds;
  }
  return sum;
}
