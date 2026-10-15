import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError } from "../src/config.ts";
import { loadCookies, parseCookies } from "../src/cookies.ts";

const NOW = Date.UTC(2026, 9, 15);
const FUTURE = String(Math.floor(NOW / 1000) + 86_400 * 365);
const PAST = String(Math.floor(NOW / 1000) - 60);
const HEADER = "# Netscape HTTP Cookie File";

function row(name: string, expires = FUTURE, domain = ".youtube.com"): string {
  return [domain, domain.startsWith(".") ? "TRUE" : "FALSE", "/", "TRUE", expires, name, "v"].join(
    "\t",
  );
}

function file(...rows: string[]): string {
  return [HEADER, "", ...rows, ""].join("\n");
}

describe("parseCookies", () => {
  it("accepts a signed-in YouTube session", () => {
    const report = parseCookies(
      file(
        row("LOGIN_INFO"),
        `#HttpOnly_${row("__Secure-3PAPISID")}`,
        row("NID", FUTURE, ".google.com"),
      ),
      "c.txt",
      NOW,
    );
    assert.equal(report.entries, 3);
    assert.equal(report.youtubeEntries, 2);
    assert.deepEqual(report.skippedLines, []);
    assert.equal(report.loginExpiresAt?.getTime(), Number(FUTURE) * 1000);
  });

  it("accepts CRLF line endings, a BOM and the short header", () => {
    const contents = `﻿# HTTP Cookie File\r\n${row("LOGIN_INFO")}\r\n${row("SAPISID", "0")}\r\n`;
    assert.equal(parseCookies(contents, "c.txt", NOW).entries, 2);
  });

  it("reports lines yt-dlp would skip", () => {
    const report = parseCookies(
      file(row("LOGIN_INFO"), row("SAPISID"), ".youtube.com TRUE / TRUE 0 PREF x"),
      "c.txt",
      NOW,
    );
    assert.deepEqual(report.skippedLines, [5]);
  });

  it("rejects files that are not Netscape formatted", () => {
    assert.throws(() => parseCookies('[{"name":"x"}]', "c.txt", NOW), /is JSON/);
    assert.throws(() => parseCookies(row("LOGIN_INFO"), "c.txt", NOW), /first line must be/);
    assert.throws(() => parseCookies(file(), "c.txt", NOW), /contains no cookies/);
    assert.throws(
      () => parseCookies(file(".youtube.com TRUE / TRUE 0 LOGIN_INFO x"), "c.txt", NOW),
      /tab-separated/,
    );
  });

  it("rejects a subdomain flag that disagrees with the domain", () => {
    const bad = ["youtube.com", "TRUE", "/", "TRUE", FUTURE, "LOGIN_INFO", "v"].join("\t");
    assert.throws(() => parseCookies(file(bad), "c.txt", NOW), /line 3: the second field/);
  });

  it("rejects cookies without a signed-in session", () => {
    assert.throws(
      () => parseCookies(file(row("PREF"), row("SAPISID")), "c.txt", NOW),
      /no signed-in YouTube session/,
    );
    assert.throws(
      () =>
        parseCookies(file(row("LOGIN_INFO", FUTURE, ".google.com"), row("SAPISID")), "c.txt", NOW),
      /no signed-in YouTube session/,
    );
  });

  it("rejects an expired session", () => {
    assert.throws(
      () => parseCookies(file(row("LOGIN_INFO", PAST), row("SAPISID")), "c.txt", NOW),
      (error: unknown) => error instanceof ConfigError && /expired/.test(error.message),
    );
  });
});

describe("loadCookies", () => {
  it("reads and validates the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookies-test-"));
    const path = join(dir, "cookies.txt");
    const contents = file(row("LOGIN_INFO"), row("SAPISID"));
    await writeFile(path, contents);
    const loaded = await loadCookies(path, NOW);
    assert.equal(loaded.contents, contents);
    assert.equal(loaded.report.entries, 2);
  });

  it("explains a missing file", async () => {
    await assert.rejects(
      loadCookies(join(tmpdir(), "does-not-exist", "cookies.txt"), NOW),
      (error: unknown) => error instanceof ConfigError && /does not exist/.test(error.message),
    );
  });
});
