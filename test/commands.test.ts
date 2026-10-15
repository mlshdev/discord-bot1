import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import {
  COMMAND_DEFINITIONS,
  CommandName,
  LEVEL_OPTION,
  MAX_VOLUME_LEVEL,
  PRIVILEGED_COMMANDS,
  toCommand,
  URL_OPTION,
} from "../src/commands.ts";

const NONE = { url: null, level: null } as const;

describe("COMMAND_DEFINITIONS", () => {
  it("registers /add, /ff, /mn, /won and /vol", () => {
    assert.deepEqual(
      COMMAND_DEFINITIONS.map((command) => command.name),
      ["add", "ff", "mn", "won", "vol"],
    );
  });

  it("gives /vol one optional, bounded integer level", () => {
    const vol = COMMAND_DEFINITIONS.find((command) => command.name === CommandName.volume);
    assert.deepEqual(
      vol?.options?.map((option) => [
        option.name,
        option.type,
        option.required,
        "min_value" in option ? option.min_value : undefined,
        "max_value" in option ? option.max_value : undefined,
      ]),
      [[LEVEL_OPTION, ApplicationCommandOptionType.Integer, false, 0, MAX_VOLUME_LEVEL]],
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
    assert.deepEqual(toCommand("add", { ...NONE, url: "https://youtu.be/dQw4w9WgXcQ" }), {
      kind: "add",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    assert.equal(toCommand("add", NONE), undefined);
  });

  it("maps the DJ commands", () => {
    assert.deepEqual(toCommand("ff", NONE), { kind: "forceSkip" });
    assert.deepEqual(toCommand("mn", NONE), { kind: "manage" });
    assert.deepEqual(toCommand("won", NONE), { kind: "disconnect" });
    assert.deepEqual(toCommand("vol", NONE), { kind: "volume", level: null });
    assert.deepEqual(toCommand("vol", { ...NONE, level: 80 }), { kind: "volume", level: 80 });
  });

  it("rejects unknown names", () => {
    assert.equal(toCommand("play", NONE), undefined);
    assert.equal(toCommand("constructor", NONE), undefined);
    assert.equal(toCommand("!ff", NONE), undefined);
  });

  it("marks only role-gated commands as privileged", () => {
    assert.deepEqual([...PRIVILEGED_COMMANDS].sort(), [
      "disconnect",
      "forceSkip",
      "manage",
      "volume",
    ]);
  });
});
