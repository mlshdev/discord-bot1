import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  auditKey,
  missingPermissions,
  TEXT_CHANNEL_PERMISSIONS,
  VOICE_CHANNEL_PERMISSIONS,
} from "../src/permissions.ts";

describe("missingPermissions", () => {
  it("lists exactly the permissions that are not granted", () => {
    const granted = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]);
    assert.deepEqual(missingPermissions(granted, TEXT_CHANNEL_PERMISSIONS), [
      "EmbedLinks",
      "ReadMessageHistory",
    ]);
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

describe("auditKey", () => {
  it("changes only when the audit result changes", () => {
    const base = { role: "text", channelId: "1", channelName: "music" } as const;
    const a = auditKey([{ ...base, missing: ["EmbedLinks"] }]);
    assert.equal(a, auditKey([{ ...base, channelName: "renamed", missing: ["EmbedLinks"] }]));
    assert.notEqual(a, auditKey([{ ...base, missing: [] }]));
  });
});
