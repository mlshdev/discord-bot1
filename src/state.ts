import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_VOLUME_LEVEL } from "./commands.ts";
import { errorFields } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { DEFAULT_VOLUME } from "./player.ts";

const STATE_VERSION = 1;

export interface BotState {
  readonly volume: number;
}

export const DEFAULT_STATE: BotState = { volume: DEFAULT_VOLUME };

export type StateParseResult =
  | { readonly ok: true; readonly state: BotState }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseState(contents: string): StateParseResult {
  if (contents.trim() === "") {
    return { ok: true, state: DEFAULT_STATE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  if (parsed.version !== STATE_VERSION) {
    return { ok: false, reason: `unsupported version ${JSON.stringify(parsed.version)}` };
  }
  const { volume } = parsed;
  if (
    typeof volume !== "number" ||
    !Number.isInteger(volume) ||
    volume < 0 ||
    volume > MAX_VOLUME_LEVEL
  ) {
    return { ok: false, reason: `volume must be an integer from 0 to ${MAX_VOLUME_LEVEL}` };
  }
  return { ok: true, state: { volume } };
}

export function serializeState(state: BotState): string {
  return `${JSON.stringify({ version: STATE_VERSION, volume: state.volume }, null, 2)}\n`;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

// A missing, unreadable or invalid file never stops the bot: it starts from the defaults and
// the next successful save repairs the file.
export class StateStore {
  readonly #path: string;
  readonly #logger: Logger;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  async load(): Promise<BotState> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") {
        this.#logger.info("no saved bot state, using defaults", { path: this.#path });
      } else if (code === "EISDIR") {
        this.#logger.warn("bot state path is a directory, using defaults", {
          ...errorFields("E501"),
          path: this.#path,
          hint: "Docker creates a missing bind-mount source as a directory: remove it, then touch state.json and chown 1000:1000 it",
        });
      } else {
        this.#logger.warn("could not read bot state, using defaults", {
          ...errorFields("E501"),
          path: this.#path,
          error,
        });
      }
      return DEFAULT_STATE;
    }
    const result = parseState(contents);
    if (!result.ok) {
      this.#logger.warn("ignoring invalid bot state, using defaults", {
        ...errorFields("E501"),
        path: this.#path,
        reason: result.reason,
      });
      return DEFAULT_STATE;
    }
    this.#logger.info("bot state loaded", { path: this.#path, volume: result.state.volume });
    return result.state;
  }

  // Saves run one after another, so the file always ends up holding the latest state.
  save(state: BotState): Promise<void> {
    const next = this.#pending.then(() => this.#write(state));
    this.#pending = next.catch(() => undefined);
    return next;
  }

  // Rewritten in place, because rename() over a single-file bind mount fails with EBUSY. The file
  // is a few dozen bytes written in one call; a torn write reads back as empty or invalid and
  // falls back to the defaults.
  async #write(state: BotState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const handle = await open(this.#path, "w", 0o600);
    try {
      await handle.writeFile(serializeState(state), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
