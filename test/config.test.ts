import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const A = "111111111111111111";
const B = "222222222222222222";

function env(overrides: Record<string, string>): Record<string, string> {
  return {
    DISCORD_TOKEN: "token",
    GUILD_ID: "100000000000000000",
    TEXT_CHANNEL_ID: "200000000000000000",
    VOICE_CHANNEL_ID: A,
    DJ_ROLE_ID: B,
    ...overrides,
  };
}

describe("loadConfig ID lists", () => {
  it("accepts omitted or blank voice channel IDs without restricting voice", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      GUILD_ID: "100000000000000000",
      TEXT_CHANNEL_ID: "200000000000000000",
      DJ_ROLE_ID: B,
    });
    assert.deepEqual(config.voiceChannelIds, []);
    assert.deepEqual(loadConfig(env({ VOICE_CHANNEL_ID: "  " })).voiceChannelIds, []);
  });

  it("keeps a single ID working", () => {
    const config = loadConfig(env({}));
    assert.deepEqual(config.voiceChannelIds, [A]);
    assert.deepEqual(config.djRoleIds, [B]);
  });

  it("splits on commas, trims and removes duplicates in order", () => {
    const config = loadConfig(
      env({ VOICE_CHANNEL_ID: ` ${B} , ${A},${B}`, DJ_ROLE_ID: `${A},${B}` }),
    );
    assert.deepEqual(config.voiceChannelIds, [B, A]);
    assert.deepEqual(config.djRoleIds, [A, B]);
  });

  it("rejects empty entries and non-snowflakes", () => {
    assert.throws(() => loadConfig(env({ VOICE_CHANNEL_ID: `${A},,${B}` })), /empty entry/);
    assert.throws(() => loadConfig(env({ DJ_ROLE_ID: `${A},` })), /empty entry/);
    assert.throws(() => loadConfig(env({ DJ_ROLE_ID: `${A};${B}` })), /"111111111111111111;222/);
    assert.throws(
      () => loadConfig(env({ VOICE_CHANNEL_ID: `${A},general` })),
      (error: unknown) => error instanceof ConfigError && /"general"/.test(error.message),
    );
    assert.throws(() => loadConfig(env({ VOICE_CHANNEL_ID: `${A},` })), /empty entry/);
  });

  it("caps the list length", () => {
    const ids = Array.from({ length: 26 }, (_, i) => String(100000000000000000n + BigInt(i)));
    assert.throws(() => loadConfig(env({ DJ_ROLE_ID: ids.join(",") })), /at most 25/);
  });
});
