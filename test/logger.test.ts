import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger, type LogLevel, redactRoute, serializeError } from "../src/logger.ts";

function capture(level: LogLevel): { lines: Array<Record<string, unknown>>; streams: LogLevel[] } {
  const lines: Array<Record<string, unknown>> = [];
  const streams: LogLevel[] = [];
  const logger = createLogger({
    service: "svc",
    environment: "test",
    level,
    sink: (severity, line) => {
      streams.push(severity);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  logger.debug("d");
  logger.info("i", { n: 1 });
  logger.warn("w");
  logger.error("e", { error: new Error("boom") });
  return { lines, streams };
}

describe("createLogger", () => {
  it("writes one JSON object per line with the standard fields", () => {
    const { lines } = capture("debug");
    assert.equal(lines.length, 4);
    const info = lines[1];
    assert.equal(info?.severity, "info");
    assert.equal(info?.message, "i");
    assert.equal(info?.service, "svc");
    assert.equal(info?.environment, "test");
    assert.equal(info?.n, 1);
    assert.match(String(info?.timestamp), /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("drops entries below the configured level", () => {
    assert.deepEqual(capture("warn").streams, ["warn", "error"]);
    assert.deepEqual(capture("info").streams, ["info", "warn", "error"]);
  });

  it("serializes the error field", () => {
    const error = capture("error").lines[0]?.error as Record<string, unknown>;
    assert.equal(error.name, "Error");
    assert.equal(error.message, "boom");
  });
});

describe("serializeError", () => {
  it("keeps Discord REST error details and redacts interaction tokens", () => {
    const error = Object.assign(new Error("Missing Permissions"), {
      name: "DiscordAPIError[50013]",
      code: 50013,
      status: 403,
      method: "POST",
      url: "https://discord.com/api/v10/interactions/123456789012345678/aW50ZXJhY3Rpb24/callback?with_response=true",
    });
    const serialized = serializeError(error);
    assert.equal(serialized.code, 50013);
    assert.equal(serialized.status, 403);
    assert.equal(serialized.method, "POST");
    assert.equal(serialized.route, "/api/v10/interactions/123456789012345678/[redacted]/callback");
  });

  it("keeps Node system error details", () => {
    const error = Object.assign(new Error("spawn yt-dlp ENOENT"), {
      code: "ENOENT",
      syscall: "spawn yt-dlp",
      path: "yt-dlp",
    });
    const serialized = serializeError(error);
    assert.equal(serialized.code, "ENOENT");
    assert.equal(serialized.syscall, "spawn yt-dlp");
    assert.equal(serialized.path, "yt-dlp");
  });

  it("follows causes up to a fixed depth", () => {
    let error = new Error("level 0");
    for (let depth = 1; depth <= 5; depth++) {
      error = new Error(`level ${depth}`, { cause: error });
    }
    let node = serializeError(error);
    let hops = 0;
    while (typeof node.cause === "object") {
      node = node.cause;
      hops++;
    }
    assert.equal(hops, 3);
    assert.equal(serializeError(new Error("x", { cause: "reason" })).cause, "reason");
  });
});

describe("redactRoute", () => {
  it("redacts webhook tokens and leaves other routes alone", () => {
    assert.equal(
      redactRoute("https://discord.com/api/v10/webhooks/1/secret-token/messages/@original"),
      "/api/v10/webhooks/1/[redacted]/messages/@original",
    );
    assert.equal(
      redactRoute("https://discord.com/api/v10/channels/42/messages"),
      "/api/v10/channels/42/messages",
    );
  });
});
