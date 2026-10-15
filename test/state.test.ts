import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Logger, LogLevel } from "../src/logger.ts";
import { DEFAULT_STATE, parseState, StateStore, serializeState } from "../src/state.ts";

interface Entry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function recordingLogger(): { readonly logger: Logger; readonly entries: Entry[] } {
  const entries: Entry[] = [];
  const log =
    (level: LogLevel) =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      entries.push({ level, message, fields });
    };
  return {
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    entries,
  };
}

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "state-test-")), "nested", "state.json");
}

describe("parseState", () => {
  it("round-trips through serializeState", () => {
    assert.deepEqual(parseState(serializeState({ volume: 42 })), {
      ok: true,
      state: { volume: 42 },
    });
  });

  it("rejects malformed, foreign and out-of-range files", () => {
    assert.equal(parseState("{nope").ok, false);
    assert.equal(parseState("[]").ok, false);
    assert.equal(parseState('{"volume": 50}').ok, false);
    assert.equal(parseState('{"version": 2, "volume": 50}').ok, false);
    assert.equal(parseState('{"version": 1, "volume": 151}').ok, false);
    assert.equal(parseState('{"version": 1, "volume": -1}').ok, false);
    assert.equal(parseState('{"version": 1, "volume": 50.5}').ok, false);
    assert.equal(parseState('{"version": 1, "volume": "50"}').ok, false);
  });
});

describe("StateStore", () => {
  it("starts from the defaults when nothing was saved", async () => {
    const { logger, entries } = recordingLogger();
    assert.deepEqual(await new StateStore(await tempPath(), logger).load(), DEFAULT_STATE);
    assert.equal(entries[0]?.level, "info");
  });

  it("persists the volume for the next start", async () => {
    const path = await tempPath();
    const { logger } = recordingLogger();
    await new StateStore(path, logger).save({ volume: 65 });
    assert.deepEqual(await new StateStore(path, logger).load(), { volume: 65 });
    assert.deepEqual(await readdir(join(path, "..")), ["state.json"]);
  });

  it("keeps the last of several concurrent saves", async () => {
    const path = await tempPath();
    const { logger } = recordingLogger();
    const store = new StateStore(path, logger);
    await Promise.all([10, 20, 30, 40].map((volume) => store.save({ volume })));
    assert.deepEqual(parseState(await readFile(path, "utf8")), { ok: true, state: { volume: 40 } });
  });

  it("falls back to the defaults on an invalid file and logs E501", async () => {
    const path = await tempPath();
    const { logger, entries } = recordingLogger();
    await new StateStore(path, logger).save({ volume: 1 });
    await writeFile(path, "garbage");
    assert.deepEqual(await new StateStore(path, logger).load(), DEFAULT_STATE);
    assert.equal(entries.at(-1)?.fields?.errorCode, "E501");
  });

  it("rejects the save when the directory is not writable", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores directory permissions");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "state-ro-"));
    await chmod(dir, 0o500);
    const { logger } = recordingLogger();
    await assert.rejects(new StateStore(join(dir, "state.json"), logger).save({ volume: 5 }));
    await chmod(dir, 0o700);
  });
});
