import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import {
  COMMAND_DEFINITIONS,
  CommandName,
  PRIVILEGED_COMMANDS,
  toCommand,
  URL_OPTION,
} from "../src/commands.ts";

describe("COMMAND_DEFINITIONS", () => {
  it("registers /add, /ff, /mn and /won", () => {
    assert.deepEqual(
      COMMAND_DEFINITIONS.map((command) => command.name),
      ["add", "ff", "mn", "won"],
    );
  });

  it("gives /add one required url option", () => {
    const add = COMMAND_DEFINITIONS.find((command) => command.name === CommandName.add);
    assert.deepEqual(
      add?.options?.map((option) => [option.name, option.type, option.required]),
      [[URL_OPTION, ApplicationCommandOptionType.String, true]],
    );
  });

  it("only offers the commands inside a server", () => {
    for (const command of COMMAND_DEFINITIONS) {
      assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
      assert.ok(command.description.length > 0);
    }
  });
});

describe("toCommand", () => {
  it("maps /add with its url", () => {
    assert.deepEqual(toCommand("add", "https://youtu.be/dQw4w9WgXcQ"), {
      kind: "add",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    assert.equal(toCommand("add", null), undefined);
  });

  it("maps the DJ commands", () => {
    assert.deepEqual(toCommand("ff", null), { kind: "forceSkip" });
    assert.deepEqual(toCommand("mn", null), { kind: "manage" });
    assert.deepEqual(toCommand("won", null), { kind: "disconnect" });
  });

  it("rejects unknown names", () => {
    assert.equal(toCommand("play", null), undefined);
    assert.equal(toCommand("constructor", null), undefined);
    assert.equal(toCommand("!ff", null), undefined);
  });

  it("marks only role-gated commands as privileged", () => {
    assert.deepEqual([...PRIVILEGED_COMMANDS].sort(), ["disconnect", "forceSkip", "manage"]);
  });
});
