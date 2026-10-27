export type VoiceChoice =
  | { readonly ok: true; readonly channelId: string }
  | {
      readonly ok: false;
      readonly reason: "not in a voice channel" | "not in an allowed voice channel";
    };

type SkipReason = "not found" | "not a voice channel" | "unavailable";

function isUnavailableChannelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 10003 || error.code === 50001 || error.code === 50013;
}

export async function resolveVoiceChannels<T, V extends T>(
  ids: readonly string[],
  fetch: (id: string) => Promise<T | null>,
  isVoice: (channel: T) => channel is V,
  onSkip: (id: string, reason: SkipReason, error?: unknown) => void,
): Promise<V[]> {
  const channels: V[] = [];
  for (const id of ids) {
    let channel: T | null;
    try {
      channel = await fetch(id);
    } catch (error) {
      if (!isUnavailableChannelError(error)) throw error;
      onSkip(id, "unavailable", error);
      continue;
    }
    if (channel === null) {
      onSkip(id, "not found");
    } else if (isVoice(channel)) {
      channels.push(channel);
    } else {
      onSkip(id, "not a voice channel");
    }
  }
  return channels;
}

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
  if (allowed.length === 0) {
    return memberChannelId === null
      ? { ok: false, reason: "not in a voice channel" }
      : { ok: true, channelId: memberChannelId };
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
