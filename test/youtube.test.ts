import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseYouTubeUrl } from "../src/youtube.ts";

const CANONICAL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("parseYouTubeUrl", () => {
  const accepted: readonly string[] = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/v/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "<https://youtu.be/dQw4w9WgXcQ>",
    "  https://youtu.be/dQw4w9WgXcQ  ",
  ];
  for (const input of accepted) {
    it(`accepts ${input}`, () => {
      assert.equal(parseYouTubeUrl(input), CANONICAL);
    });
  }

  const rejected: readonly string[] = [
    "",
    "not a url",
    "dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL1234567890",
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/123456",
    "ftp://youtu.be/dQw4w9WgXcQ",
    "javascript:alert(1)",
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(parseYouTubeUrl(input), undefined);
    });
  }
});
