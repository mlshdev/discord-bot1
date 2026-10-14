export type Command =
  | { readonly kind: "add"; readonly argument: string }
  | { readonly kind: "forceSkip" }
  | { readonly kind: "manage" }
  | { readonly kind: "disconnect" };

export const PRIVILEGED_COMMANDS: ReadonlySet<Command["kind"]> = new Set([
  "forceSkip",
  "manage",
  "disconnect",
]);

export const PREFIX = "!";

const NO_ARGUMENT_COMMANDS: Readonly<Record<string, Command>> = {
  ff: { kind: "forceSkip" },
  mn: { kind: "manage" },
  won: { kind: "disconnect" },
};

export function parseCommand(content: string): Command | undefined {
  const [head, ...rest] = content.trim().split(/\s+/);
  if (head === undefined || !head.startsWith(PREFIX)) {
    return undefined;
  }
  const name = head.slice(PREFIX.length).toLowerCase();
  if (name === "add") {
    return { kind: "add", argument: rest.join(" ") };
  }
  if (rest.length > 0 || !Object.hasOwn(NO_ARGUMENT_COMMANDS, name)) {
    return undefined;
  }
  return NO_ARGUMENT_COMMANDS[name];
}
