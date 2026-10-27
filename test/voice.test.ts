import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseVoiceChannel, mentionList, resolveVoiceChannels } from "../src/voice.ts";

const A = "111111111111111111";
const B = "222222222222222222";
const OTHER = "333333333333333333";

describe("chooseVoiceChannel", () => {
  it("follows the requester in any voice channel when no IDs are configured", () => {
    assert.deepEqual(chooseVoiceChannel([], undefined, OTHER), { ok: true, channelId: OTHER });
    assert.deepEqual(chooseVoiceChannel([], B, OTHER), { ok: true, channelId: B });
  });

  it("requires the requester to join voice when no IDs are configured", () => {
    assert.deepEqual(chooseVoiceChannel([], undefined, null), {
      ok: false,
      reason: "not in a voice channel",
    });
  });

  it("stays in the channel of the running session", () => {
    assert.deepEqual(chooseVoiceChannel([A, B], B, A), { ok: true, channelId: B });
    assert.deepEqual(chooseVoiceChannel([A, B], B, null), { ok: true, channelId: B });
  });

  it("follows the requester into an allowed channel", () => {
    assert.deepEqual(chooseVoiceChannel([A, B], undefined, B), { ok: true, channelId: B });
  });

  it("uses the only allowed channel without requiring voice", () => {
    assert.deepEqual(chooseVoiceChannel([A], undefined, null), { ok: true, channelId: A });
    assert.deepEqual(chooseVoiceChannel([A], undefined, OTHER), { ok: true, channelId: A });
  });

  it("refuses when several channels are allowed and the requester is in none", () => {
    assert.equal(chooseVoiceChannel([A, B], undefined, null).ok, false);
    assert.equal(chooseVoiceChannel([A, B], undefined, OTHER).ok, false);
  });
});

describe("mentionList", () => {
  it("formats channel and role mentions", () => {
    assert.equal(mentionList([A, B], "channel"), `<#${A}>, <#${B}>`);
    assert.equal(mentionList([A], "role"), `<@&${A}>`);
  });
});

describe("resolveVoiceChannels", () => {
  type Channel = { id: string; kind: "voice" | "text" };
  type VoiceChannel = Channel & { kind: "voice" };
  const isVoice = (channel: Channel): channel is VoiceChannel => channel.kind === "voice";

  it("skips missing, inaccessible and non-voice entries but keeps valid voice channels", async () => {
    const missing = "444444444444444444";
    const inaccessible = "555555555555555555";
    const notVoice = "666666666666666666";
    const forbidden = "777777777777777777";
    const skipped: string[] = [];
    const channels = await resolveVoiceChannels(
      [A, missing, inaccessible, notVoice, forbidden, B],
      async (id): Promise<Channel | null> => {
        if (id === missing) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        if (id === inaccessible) throw Object.assign(new Error("Missing Access"), { code: 50001 });
        if (id === forbidden)
          throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
        if (id === notVoice) return { id, kind: "text" };
        return { id, kind: "voice" };
      },
      isVoice,
      (id) => skipped.push(id),
    );
    assert.deepEqual(channels, [
      { id: A, kind: "voice" },
      { id: B, kind: "voice" },
    ]);
    assert.deepEqual(skipped, [missing, inaccessible, notVoice, forbidden]);
  });

  it("falls back to unrestricted voice when every configured channel is invalid", async () => {
    const channels = await resolveVoiceChannels<Channel, VoiceChannel>(
      [A],
      async (): Promise<Channel | null> => null,
      isVoice,
      () => {},
    );
    assert.deepEqual(
      chooseVoiceChannel(
        channels.map((channel) => channel.id),
        undefined,
        B,
      ),
      {
        ok: true,
        channelId: B,
      },
    );
    assert.deepEqual(channels, []);
  });

  it("does not treat transient failures as invalid channels", async () => {
    const failure = { code: 503 };
    await assert.rejects(
      resolveVoiceChannels(
        [A],
        async (): Promise<Channel | null> => {
          throw failure;
        },
        isVoice,
        () => assert.fail("unexpected skip"),
      ),
      (error: unknown) => error === failure,
    );
  });
});
