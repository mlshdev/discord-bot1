import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseVoiceChannel, mentionList } from "../src/voice.ts";

const A = "111111111111111111";
const B = "222222222222222222";
const OTHER = "333333333333333333";

describe("chooseVoiceChannel", () => {
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
