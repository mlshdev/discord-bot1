import {
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from "discord.js";

export type Command =
  | { readonly kind: "add"; readonly url: string }
  | { readonly kind: "forceSkip" }
  | { readonly kind: "manage" }
  | { readonly kind: "disconnect" }
  | { readonly kind: "volume"; readonly level: number | null };

export const PRIVILEGED_COMMANDS: ReadonlySet<Command["kind"]> = new Set([
  "forceSkip",
  "manage",
  "disconnect",
  "volume",
]);

export const CommandName = {
  add: "add",
  forceSkip: "ff",
  manage: "mn",
  disconnect: "won",
  volume: "vol",
} as const satisfies Record<Command["kind"], string>;

export const URL_OPTION = "url";
export const LEVEL_OPTION = "level";
export const MAX_VOLUME_LEVEL = 150;

export interface CommandOptions {
  readonly url: string | null;
  readonly level: number | null;
}

const URL_MAX_LENGTH = 200;

function guildCommand(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}

export const COMMAND_DEFINITIONS: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  guildCommand(CommandName.add, "Add a YouTube video to the queue")
    .addStringOption((option) =>
      option
        .setName(URL_OPTION)
        .setDescription("YouTube video link")
        .setRequired(true)
        .setMaxLength(URL_MAX_LENGTH),
    )
    .toJSON(),
  guildCommand(CommandName.forceSkip, "Force-skip the current song (DJ only)").toJSON(),
  guildCommand(CommandName.manage, "Open the queue manager (DJ only)").toJSON(),
  guildCommand(CommandName.disconnect, "Stop, clear the queue and leave voice (DJ only)").toJSON(),
  guildCommand(CommandName.volume, "Show or set the playback volume (DJ only)")
    .addIntegerOption((option) =>
      option
        .setName(LEVEL_OPTION)
        .setDescription(`Volume in percent of the normalised loudness, 0–${MAX_VOLUME_LEVEL}`)
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(MAX_VOLUME_LEVEL),
    )
    .toJSON(),
];

// Each option is null when the interaction carried none.
export function toCommand(name: string, options: CommandOptions): Command | undefined {
  switch (name) {
    case CommandName.add:
      return options.url === null ? undefined : { kind: "add", url: options.url };
    case CommandName.forceSkip:
      return { kind: "forceSkip" };
    case CommandName.manage:
      return { kind: "manage" };
    case CommandName.disconnect:
      return { kind: "disconnect" };
    case CommandName.volume:
      return { kind: "volume", level: options.level };
    default:
      return undefined;
  }
}
