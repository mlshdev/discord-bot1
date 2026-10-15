import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, totalDuration } from "../src/format.ts";
import type { Track } from "../src/queue.ts";
import {
  extractWarnings,
  parseMetadata,
  summarizeStderr,
  TrackResolveError,
} from "../src/ytdlp.ts";

const URL_FALLBACK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("parseMetadata", () => {
  it("maps yt-dlp JSON to track info", () => {
    const stdout = `${JSON.stringify({
      id: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      duration: 213,
      uploader: "Rick Astley",
      live_status: "not_live",
      webpage_url: URL_FALLBACK,
    })}\n`;
    assert.deepEqual(parseMetadata(stdout, "fallback"), {
      url: URL_FALLBACK,
      title: "Never Gonna Give You Up",
      durationSeconds: 213,
      uploader: "Rick Astley",
    });
  });

  it("falls back to channel and the requested URL", () => {
    const info = parseMetadata(
      JSON.stringify({ title: "T", channel: "C", duration: null }),
      URL_FALLBACK,
    );
    assert.equal(info.url, URL_FALLBACK);
    assert.equal(info.uploader, "C");
    assert.equal(info.durationSeconds, undefined);
  });

  it("rejects live streams", () => {
    assert.throws(
      () => parseMetadata(JSON.stringify({ title: "T", live_status: "is_live" }), URL_FALLBACK),
      (error: unknown) => error instanceof TrackResolveError && error.code === "E205",
    );
  });

  it("rejects empty and malformed output", () => {
    assert.throws(() => parseMetadata("", URL_FALLBACK), TrackResolveError);
    assert.throws(() => parseMetadata("{nope", URL_FALLBACK), TrackResolveError);
    assert.throws(() => parseMetadata("[]", URL_FALLBACK), TrackResolveError);
    assert.throws(() => parseMetadata("{}", URL_FALLBACK), TrackResolveError);
  });
});

describe("summarizeStderr", () => {
  it("prefers the last ERROR line without its prefix", () => {
    const stderr = "WARNING: x\nERROR: [youtube] abc: Video unavailable\n";
    assert.equal(summarizeStderr(stderr), "[youtube] abc: Video unavailable");
  });

  it("falls back to the last line and a default", () => {
    assert.equal(summarizeStderr("first\nsecond\n"), "second");
    assert.equal(summarizeStderr(""), "unknown error");
  });
});

describe("extractWarnings", () => {
  it("returns WARNING lines without their prefix", () => {
    const stderr =
      "[youtube] x: Downloading webpage\nWARNING: [youtube] The provided YouTube account cookies are no longer valid.\nERROR: boom\n";
    assert.deepEqual(extractWarnings(stderr), [
      "[youtube] The provided YouTube account cookies are no longer valid.",
    ]);
    assert.deepEqual(extractWarnings(""), []);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    assert.equal(formatDuration(5), "0:05");
    assert.equal(formatDuration(213), "3:33");
    assert.equal(formatDuration(3723), "1:02:03");
    assert.equal(formatDuration(undefined), "?:??");
    assert.equal(formatDuration(-1), "?:??");
  });

  it("sums durations and propagates unknowns", () => {
    const base = { uid: "a", url: "", title: "", uploader: undefined, requestedBy: "1" };
    const known: Track[] = [
      { ...base, durationSeconds: 60 },
      { ...base, durationSeconds: 30 },
    ];
    assert.equal(totalDuration(known), 90);
    assert.equal(totalDuration([...known, { ...base, durationSeconds: undefined }]), undefined);
  });
});
