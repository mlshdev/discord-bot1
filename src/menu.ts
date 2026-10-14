import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  escapeMarkdown,
  type Message,
  MessageFlags,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { formatDuration, totalDuration, truncate } from "./format.ts";
import type { Logger } from "./logger.ts";
import type { MusicPlayer, PlayerSnapshot } from "./player.ts";

export const PAGE_SIZE = 10;
const MENU_IDLE_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 1_000;

export const MenuAction = {
  select: "mn:select",
  playNow: "mn:playnow",
  up: "mn:up",
  down: "mn:down",
  remove: "mn:remove",
  skip: "mn:skip",
  pause: "mn:pause",
  shuffle: "mn:shuffle",
  clear: "mn:clear",
  prev: "mn:prev",
  next: "mn:next",
  refresh: "mn:refresh",
  close: "mn:close",
} as const;

export type MenuActionId = (typeof MenuAction)[keyof typeof MenuAction];

export interface MenuState {
  page: number;
  selectedUid: string | undefined;
  notice: string | undefined;
}

export interface MenuView {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export function normalizeState(state: MenuState, snapshot: PlayerSnapshot): void {
  if (
    state.selectedUid !== undefined &&
    !snapshot.upcoming.some((track) => track.uid === state.selectedUid)
  ) {
    state.selectedUid = undefined;
  }
  state.page = Math.min(Math.max(state.page, 0), pageCount(snapshot.upcoming.length) - 1);
}

export function focusSelection(state: MenuState, snapshot: PlayerSnapshot): void {
  const index = snapshot.upcoming.findIndex((track) => track.uid === state.selectedUid);
  if (index !== -1) {
    state.page = Math.floor(index / PAGE_SIZE);
  }
}

function button(
  id: MenuActionId,
  label: string,
  style: ButtonStyle,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}

export function renderMenu(snapshot: PlayerSnapshot, state: MenuState, closed: boolean): MenuView {
  const { current, upcoming, paused } = snapshot;
  const pages = pageCount(upcoming.length);
  const start = state.page * PAGE_SIZE;
  const pageItems = upcoming.slice(start, start + PAGE_SIZE);

  const nowPlaying =
    current === undefined
      ? "Nothing is playing."
      : `${paused ? "⏸️" : "▶️"} [${escapeMarkdown(truncate(current.title, 120))}](${current.url}) \`${formatDuration(current.durationSeconds)}\` · <@${current.requestedBy}>`;
  const list =
    pageItems.length === 0
      ? "The queue is empty."
      : pageItems
          .map((track, offset) => {
            const marker = track.uid === state.selectedUid ? "➤ " : "";
            return `${marker}**${start + offset + 1}.** ${escapeMarkdown(truncate(track.title, 80))} \`${formatDuration(track.durationSeconds)}\` · <@${track.requestedBy}>`;
          })
          .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Queue manager")
    .addFields(
      { name: "Now playing", value: nowPlaying },
      { name: `Up next (${upcoming.length})`, value: list },
    )
    .setFooter({
      text: `Page ${state.page + 1}/${pages} · total ${formatDuration(totalDuration(upcoming))}${closed ? " · menu closed" : ""}`,
    });
  if (state.notice !== undefined) {
    embed.setDescription(state.notice);
  }

  if (closed) {
    return { embeds: [embed], components: [] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(MenuAction.select)
    .setPlaceholder(pageItems.length === 0 ? "Queue is empty" : "Select a track to manage");
  if (pageItems.length === 0) {
    select.addOptions(new StringSelectMenuOptionBuilder().setLabel("—").setValue("none"));
    select.setDisabled(true);
  } else {
    select.addOptions(
      pageItems.map((track, offset) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${start + offset + 1}. ${track.title}`, 100))
          .setDescription(formatDuration(track.durationSeconds))
          .setValue(track.uid)
          .setDefault(track.uid === state.selectedUid),
      ),
    );
  }

  const selected = state.selectedUid !== undefined;
  const selectedIndex = upcoming.findIndex((track) => track.uid === state.selectedUid);
  const hasCurrent = current !== undefined;

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(MenuAction.playNow, "Play now", ButtonStyle.Success, !selected),
        button(MenuAction.up, "Move up", ButtonStyle.Secondary, !selected || selectedIndex <= 0),
        button(
          MenuAction.down,
          "Move down",
          ButtonStyle.Secondary,
          !selected || selectedIndex >= upcoming.length - 1,
        ),
        button(MenuAction.remove, "Remove", ButtonStyle.Danger, !selected),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(MenuAction.skip, "Force skip", ButtonStyle.Primary, !hasCurrent),
        button(MenuAction.pause, paused ? "Resume" : "Pause", ButtonStyle.Secondary, !hasCurrent),
        button(MenuAction.shuffle, "Shuffle", ButtonStyle.Secondary, upcoming.length < 2),
        button(MenuAction.clear, "Clear queue", ButtonStyle.Danger, upcoming.length === 0),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(MenuAction.prev, "◀ Prev", ButtonStyle.Secondary, state.page === 0),
        button(MenuAction.next, "Next ▶", ButtonStyle.Secondary, state.page >= pages - 1),
        button(MenuAction.refresh, "Refresh", ButtonStyle.Secondary, false),
        button(MenuAction.close, "Close", ButtonStyle.Secondary, false),
      ),
    ],
  };
}

export interface MenuContext {
  readonly player: MusicPlayer;
  readonly isAuthorized: (interaction: ButtonInteraction | StringSelectMenuInteraction) => boolean;
  readonly logger: Logger;
}

function applyAction(
  id: string,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  state: MenuState,
  player: MusicPlayer,
): boolean {
  const uid = state.selectedUid;
  state.notice = undefined;
  switch (id) {
    case MenuAction.select:
      if (interaction.isStringSelectMenu()) {
        state.selectedUid = interaction.values[0];
      }
      return false;
    case MenuAction.playNow: {
      const track = uid === undefined ? undefined : player.playNow(uid);
      state.selectedUid = undefined;
      state.notice =
        track === undefined
          ? "That track is no longer queued."
          : `▶️ Force playing **${escapeMarkdown(track.title)}**`;
      return false;
    }
    case MenuAction.up:
    case MenuAction.down:
      if (uid !== undefined) {
        player.move(uid, id === MenuAction.up ? -1 : 1);
        focusSelection(state, player.snapshot());
      }
      return false;
    case MenuAction.remove: {
      const track = uid === undefined ? undefined : player.remove(uid);
      state.selectedUid = undefined;
      if (track !== undefined) {
        state.notice = `🗑️ Removed **${escapeMarkdown(track.title)}**`;
      }
      return false;
    }
    case MenuAction.skip: {
      const track = player.forceSkip();
      state.notice =
        track === undefined
          ? "Nothing is playing."
          : `⏭️ Skipped **${escapeMarkdown(track.title)}**`;
      return false;
    }
    case MenuAction.pause:
      state.notice = player.togglePause() ? "⏸️ Paused" : "▶️ Resumed";
      return false;
    case MenuAction.shuffle:
      player.shuffle();
      state.notice = "🔀 Queue shuffled";
      return false;
    case MenuAction.clear:
      state.notice = `🧹 Cleared ${player.clearQueue()} track(s)`;
      state.selectedUid = undefined;
      return false;
    case MenuAction.prev:
      state.page -= 1;
      return false;
    case MenuAction.next:
      state.page += 1;
      return false;
    case MenuAction.refresh:
      return false;
    case MenuAction.close:
      return true;
    default:
      return false;
  }
}

export async function openMenu(message: Message<true>, context: MenuContext): Promise<void> {
  const { player, isAuthorized, logger } = context;
  const state: MenuState = { page: 0, selectedUid: undefined, notice: undefined };
  const render = (closed: boolean): MenuView => {
    const snapshot = player.snapshot();
    normalizeState(state, snapshot);
    return renderMenu(snapshot, state, closed);
  };

  const menu = await message.reply(render(false));
  let pendingRefresh: NodeJS.Timeout | undefined;
  let closed = false;

  const onChange = (): void => {
    if (closed || pendingRefresh !== undefined) {
      return;
    }
    pendingRefresh = setTimeout(() => {
      pendingRefresh = undefined;
      if (!closed) {
        menu
          .edit(render(false))
          .catch((error: unknown) => logger.debug("menu refresh failed", { error }));
      }
    }, REFRESH_DEBOUNCE_MS);
  };
  player.on("change", onChange);

  const collector = menu.createMessageComponentCollector({ idle: MENU_IDLE_MS });

  collector.on("collect", async (interaction) => {
    if (
      interaction.componentType !== ComponentType.Button &&
      interaction.componentType !== ComponentType.StringSelect
    ) {
      return;
    }
    const component = interaction as ButtonInteraction | StringSelectMenuInteraction;
    try {
      if (!isAuthorized(component)) {
        logger.info("menu interaction denied", {
          customId: component.customId,
          userId: component.user.id,
          reason: "missing DJ role",
        });
        await component.reply({
          content: "⛔ You are not allowed to manage the queue.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const shouldClose = applyAction(component.customId, component, state, player);
      if (shouldClose) {
        collector.stop("closed");
        await component.update(render(true));
        return;
      }
      await component.update(render(false));
    } catch (error) {
      logger.error("menu interaction failed", { error, customId: component.customId });
    }
  });

  collector.on("end", (_collected, reason) => {
    closed = true;
    player.off("change", onChange);
    if (pendingRefresh !== undefined) {
      clearTimeout(pendingRefresh);
    }
    if (reason !== "closed") {
      menu
        .edit(render(true))
        .catch((error: unknown) => logger.debug("menu close failed", { error }));
    }
  });
}
