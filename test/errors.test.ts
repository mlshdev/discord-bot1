import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyYtDlpError, ERROR_CODES, errorFields, userMessage } from "../src/errors.ts";

describe("classifyYtDlpError", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "ERROR: [youtube] y3MnpLrtnyY: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser or --cookies",
      "E201",
    ],
    ["ERROR: [youtube] abc: Video unavailable. This video is private", "E202"],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "E202"],
    ["ERROR: [youtube] abc: Join this channel to get access to members-only content", "E202"],
    ["ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate", "E203"],
    [
      "ERROR: [youtube] abc: The uploader has not made this video available in your country",
      "E204",
    ],
    ["ERROR: [youtube] abc: This live event will begin in 3 hours.", "E205"],
    ["ERROR: [youtube] abc: Requested format is not available", "E206"],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "E207"],
    ["ERROR: [youtube] abc: HTTP Error 429: Too Many Requests", "E207"],
    ["ERROR: something new", "E299"],
  ];
  for (const [stderr, code] of cases) {
    it(`maps "${stderr.slice(7, 60)}…" to ${code}`, () => {
      assert.equal(classifyYtDlpError(stderr), code);
    });
  }
});

describe("error catalog", () => {
  it("uses E + three digits and describes every code", () => {
    for (const [code, description] of Object.entries(ERROR_CODES)) {
      assert.match(code, /^E\d{3}$/);
      assert.ok(description.length > 0);
    }
  });

  it("keeps the description out of the user message", () => {
    const message = userMessage("Could not add that video.", "E201");
    assert.equal(message, "⚠️ Could not add that video. Error code `E201`.");
    assert.ok(!message.includes(ERROR_CODES.E201));
    assert.deepEqual(errorFields("E201"), { errorCode: "E201", errorClass: ERROR_CODES.E201 });
  });
});
