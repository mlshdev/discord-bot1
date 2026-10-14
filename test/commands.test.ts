import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PREFIX, PRIVILEGED_COMMANDS, parseCommand } from "../src/commands.ts";

describe("parseCommand", () => {
  it("parses !add with its argument", () => {
    assert.deepEqual(parseCommand("!add https://youtu.be/dQw4w9WgXcQ"), {
      kind: "add",
      argument: "https://youtu.be/dQw4w9WgXcQ",
    });
  });

  it("parses !add without an argument", () => {
    assert.deepEqual(parseCommand("!add"), { kind: "add", argument: "" });
  });

  it("is case-insensitive and trims whitespace", () => {
    assert.deepEqual(parseCommand("  !FF  "), { kind: "forceSkip" });
  });

  it("parses the privileged commands", () => {
    assert.deepEqual(parseCommand("!ff"), { kind: "forceSkip" });
    assert.deepEqual(parseCommand("!mn"), { kind: "manage" });
    assert.deepEqual(parseCommand("!won"), { kind: "disconnect" });
  });

  it("ignores privileged commands with trailing text", () => {
    assert.equal(parseCommand("!ff now"), undefined);
  });

  it("ignores unknown input", () => {
    assert.equal(parseCommand(""), undefined);
    assert.equal(parseCommand("hello"), undefined);
    assert.equal(parseCommand("!play x"), undefined);
    assert.equal(parseCommand("!addhttps://youtu.be/x"), undefined);
    assert.equal(parseCommand("!constructor"), undefined);
  });

  it("uses the same single-character prefix for every command", () => {
    assert.equal(PREFIX, "!");
    assert.equal(parseCommand("!!ff"), undefined);
    assert.equal(parseCommand("!!add https://youtu.be/dQw4w9WgXcQ"), undefined);
    assert.equal(parseCommand("ff"), undefined);
  });

  it("marks only role-gated commands as privileged", () => {
    assert.deepEqual([...PRIVILEGED_COMMANDS].sort(), ["disconnect", "forceSkip", "manage"]);
  });
});
