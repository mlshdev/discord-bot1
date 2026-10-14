import { PermissionsBitField, type PermissionsString } from "discord.js";

// The bot's managed role, requested by the invite link. View Channel and Send Messages are not
// part of it; the bot gets them from @everyone or from channel overrides.
export const INVITE_PERMISSIONS: readonly PermissionsString[] = [
  "PrioritySpeaker",
  "Connect",
  "Speak",
  "UseVAD",
  "UseApplicationCommands",
  "UseEmbeddedActivities",
  "UseSoundboard",
  "UseExternalSounds",
  "BypassSlowmode",
];

export const INVITE_PERMISSIONS_INTEGER = new PermissionsBitField(INVITE_PERMISSIONS).bitfield;

// Slash command replies and the queue manager go through the interaction webhook and need no
// channel permission. Only the unprompted "now playing" announcements are channel messages.
export const TEXT_CHANNEL_PERMISSIONS: readonly PermissionsString[] = [
  "ViewChannel",
  "SendMessages",
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
