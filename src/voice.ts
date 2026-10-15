export type VoiceChoice =
  | { readonly ok: true; readonly channelId: string }
  | { readonly ok: false; readonly reason: "not in an allowed voice channel" };

// While the bot is in a channel it stays there; otherwise it follows the requester. With a single
// allowed channel the requester does not have to be in voice at all.
export function chooseVoiceChannel(
  allowed: readonly string[],
  botChannelId: string | undefined,
  memberChannelId: string | null,
): VoiceChoice {
  if (botChannelId !== undefined) {
    return { ok: true, channelId: botChannelId };
  }
  if (memberChannelId !== null && allowed.includes(memberChannelId)) {
    return { ok: true, channelId: memberChannelId };
  }
  const [only] = allowed;
  if (allowed.length === 1 && only !== undefined) {
    return { ok: true, channelId: only };
  }
  return { ok: false, reason: "not in an allowed voice channel" };
}

export function mentionList(ids: readonly string[], kind: "channel" | "role"): string {
  return ids.map((id) => (kind === "channel" ? `<#${id}>` : `<@&${id}>`)).join(", ");
}
