import type { PermissionsBitField, PermissionsString } from "discord.js";

export const TEXT_CHANNEL_PERMISSIONS: readonly PermissionsString[] = [
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "ReadMessageHistory",
];

export const VOICE_CHANNEL_PERMISSIONS: readonly PermissionsString[] = [
  "ViewChannel",
  "Connect",
  "Speak",
];

export interface ChannelAudit {
  readonly role: "text" | "voice";
  readonly channelId: string;
  readonly channelName: string;
  readonly missing: readonly PermissionsString[];
}

// `null` means Discord resolved no permissions at all for the bot in that channel.
export function missingPermissions(
  granted: Readonly<PermissionsBitField> | null,
  required: readonly PermissionsString[],
): PermissionsString[] {
  if (granted === null) {
    return [...required];
  }
  return required.filter((permission) => !granted.has(permission, true));
}

export function auditKey(audits: readonly ChannelAudit[]): string {
  return audits
    .map((audit) => `${audit.role}:${audit.channelId}:${audit.missing.join(",")}`)
    .join("|");
}
