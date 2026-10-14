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
  | { readonly kind: "disconnect" };

export const PRIVILEGED_COMMANDS: ReadonlySet<Command["kind"]> = new Set([
  "forceSkip",
  "manage",
  "disconnect",
]);

export const CommandName = {
  add: "add",
  forceSkip: "ff",
  manage: "mn",
  disconnect: "won",
} as const satisfies Record<Command["kind"], string>;

export const URL_OPTION = "url";

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
];

// `url` is the value of the `url` option, or null when the interaction carried none.
export function toCommand(name: string, url: string | null): Command | undefined {
  switch (name) {
    case CommandName.add:
      return url === null ? undefined : { kind: "add", url };
    case CommandName.forceSkip:
      return { kind: "forceSkip" };
    case CommandName.manage:
      return { kind: "manage" };
    case CommandName.disconnect:
      return { kind: "disconnect" };
    default:
      return undefined;
  }
}
