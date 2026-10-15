import { readFile } from "node:fs/promises";
import { ConfigError } from "./config.ts";

// Same check as Python's MozillaCookieJar, which yt-dlp uses to load the file.
const HEADER = /#( Netscape)? HTTP Cookie File/;
const HTTPONLY_PREFIX = "#HttpOnly_";
const FIELD_COUNT = 7;
const YOUTUBE_DOMAIN = /(^|\.)youtube\.com$/;
// yt-dlp treats the account as signed in only with LOGIN_INFO plus one SAPISID variant.
const LOGIN_COOKIE = "LOGIN_INFO";
const SAPISID_COOKIES: ReadonlySet<string> = new Set([
  "SAPISID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
]);
const HOWTO = "https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies";

interface CookieEntry {
  readonly domain: string;
  readonly name: string;
  readonly expiresAt: number | undefined;
}

export interface CookieReport {
  readonly entries: number;
  readonly youtubeEntries: number;
  readonly skippedLines: readonly number[];
  readonly loginExpiresAt: Date | undefined;
}

export interface LoadedCookies {
  readonly path: string;
  readonly contents: string;
  readonly report: CookieReport;
}

function parseEntry(line: string, lineNumber: number, path: string): CookieEntry | undefined {
  const fields = line.split("\t");
  if (fields.length !== FIELD_COUNT) {
    return undefined;
  }
  const [domain = "", includeSubdomains = "", , , expires = "", name = ""] = fields;
  if (expires !== "" && !/^\d+(\.\d+)?$/.test(expires)) {
    return undefined;
  }
  // MozillaCookieJar asserts this and then rejects the whole file, not just the line.
  if ((includeSubdomains === "TRUE") !== domain.startsWith(".")) {
    throw new ConfigError(
      `${path} line ${lineNumber}: the second field must be TRUE exactly when the domain starts with "." (got "${domain}" with "${includeSubdomains}")`,
    );
  }
  const seconds = Number(expires);
  return {
    domain: domain.toLowerCase(),
    name,
    expiresAt: expires === "" || seconds === 0 ? undefined : seconds * 1000,
  };
}

function isLive(entry: CookieEntry, now: number): boolean {
  return entry.expiresAt === undefined || entry.expiresAt > now;
}

function earliest(entries: readonly CookieEntry[]): Date | undefined {
  const times = entries.flatMap((entry) =>
    entry.expiresAt === undefined ? [] : [entry.expiresAt],
  );
  return times.length === 0 ? undefined : new Date(Math.min(...times));
}

export function parseCookies(contents: string, path: string, now: number): CookieReport {
  const lines = contents.replace(/^﻿/, "").split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  if (first.startsWith("[") || first.startsWith("{")) {
    throw new ConfigError(`${path} is JSON; yt-dlp needs the Netscape cookies.txt format`);
  }
  if (!HEADER.test(first)) {
    throw new ConfigError(
      `${path} is not a Netscape cookies.txt: the first line must be "# Netscape HTTP Cookie File"`,
    );
  }

  const entries: CookieEntry[] = [];
  const skippedLines: number[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.startsWith(HTTPONLY_PREFIX) ? raw.slice(HTTPONLY_PREFIX.length) : raw;
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }
    const entry = parseEntry(line, index + 1, path);
    if (entry === undefined) {
      skippedLines.push(index + 1);
    } else {
      entries.push(entry);
    }
  }

  if (entries.length === 0) {
    throw new ConfigError(
      skippedLines.length === 0
        ? `${path} contains no cookies`
        : `${path} has no readable cookies: every line must have 7 tab-separated fields (copy-paste often turns tabs into spaces)`,
    );
  }

  const youtube = entries.filter((entry) => YOUTUBE_DOMAIN.test(entry.domain));
  const login = youtube.filter((entry) => entry.name === LOGIN_COOKIE);
  const sapisid = youtube.filter((entry) => SAPISID_COOKIES.has(entry.name));
  if (login.length === 0 || sapisid.length === 0) {
    throw new ConfigError(
      `${path} has no signed-in YouTube session (needs LOGIN_INFO and SAPISID for .youtube.com); export it from youtube.com while logged in, see ${HOWTO}`,
    );
  }
  const liveLogin = login.filter((entry) => isLive(entry, now));
  const liveSapisid = sapisid.filter((entry) => isLive(entry, now));
  if (liveLogin.length === 0 || liveSapisid.length === 0) {
    const expired = earliest([...login, ...sapisid]);
    throw new ConfigError(
      `${path} holds an expired YouTube session (expired ${expired?.toISOString() ?? "earlier"}); export fresh cookies, see ${HOWTO}`,
    );
  }

  return {
    entries: entries.length,
    youtubeEntries: youtube.length,
    skippedLines,
    loginExpiresAt: earliest([...liveLogin, ...liveSapisid]),
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadCookies(path: string, now: number = Date.now()): Promise<LoadedCookies> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    const reason =
      code === "ENOENT"
        ? "does not exist; place your exported cookies.txt next to compose.yml"
        : code === "EACCES"
          ? "is not readable by UID 1000; run chown 1000:1000 on it"
          : code === "EISDIR"
            ? "is a directory: Docker creates a missing bind-mount source as one, so remove it on the host and put your cookies.txt there"
            : "could not be read";
    throw new ConfigError(`YouTube cookies file ${path} ${reason}`, { cause: error });
  }
  return { path, contents, report: parseCookies(contents, path, now) };
}
