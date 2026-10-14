import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  auditKey,
  INVITE_PERMISSIONS,
  INVITE_PERMISSIONS_INTEGER,
  missingPermissions,
  TEXT_CHANNEL_PERMISSIONS,
  VOICE_CHANNEL_PERMISSIONS,
} from "../src/permissions.ts";

describe("missingPermissions", () => {
  it("lists exactly the permissions that are not granted", () => {
    const granted = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    assert.deepEqual(missingPermissions(granted, TEXT_CHANNEL_PERMISSIONS), ["SendMessages"]);
    assert.deepEqual(missingPermissions(granted, VOICE_CHANNEL_PERMISSIONS), ["Connect", "Speak"]);
  });

  it("reports nothing when everything is granted", () => {
    const granted = new PermissionsBitField(VOICE_CHANNEL_PERMISSIONS);
    assert.deepEqual(missingPermissions(granted, VOICE_CHANNEL_PERMISSIONS), []);
  });

  it("treats Administrator as every permission", () => {
    const granted = new PermissionsBitField(PermissionFlagsBits.Administrator);
    assert.deepEqual(missingPermissions(granted, TEXT_CHANNEL_PERMISSIONS), []);
  });

  it("reports everything when no permissions resolve", () => {
    assert.deepEqual(missingPermissions(null, VOICE_CHANNEL_PERMISSIONS), [
      ...VOICE_CHANNEL_PERMISSIONS,
    ]);
  });
});

describe("INVITE_PERMISSIONS", () => {
  it("matches the permissions integer in the invite link", () => {
    assert.equal(INVITE_PERMISSIONS_INTEGER, 4543733985968384n);
    assert.deepEqual(new PermissionsBitField(4543733985968384n).toArray(), [...INVITE_PERMISSIONS]);
  });

  it("covers the voice permissions the bot checks for", () => {
    const granted = new PermissionsBitField(INVITE_PERMISSIONS);
    assert.deepEqual(missingPermissions(granted, VOICE_CHANNEL_PERMISSIONS), ["ViewChannel"]);
  });
});

describe("auditKey", () => {
  it("changes only when the audit result changes", () => {
    const base = { role: "text", channelId: "1", channelName: "music" } as const;
    const a = auditKey([{ ...base, missing: ["EmbedLinks"] }]);
    assert.equal(a, auditKey([{ ...base, channelName: "renamed", missing: ["EmbedLinks"] }]));
    assert.notEqual(a, auditKey([{ ...base, missing: [] }]));
  });
});
