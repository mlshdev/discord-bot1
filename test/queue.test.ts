import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueueFullError, type Track, TrackQueue } from "../src/queue.ts";

function track(uid: string): Track {
  return {
    uid,
    url: `https://www.youtube.com/watch?v=${uid.padEnd(11, "x")}`,
    title: uid,
    durationSeconds: 60,
    uploader: undefined,
    requestedBy: "1",
  };
}

function uids(queue: TrackQueue): string[] {
  return queue.items.map((item) => item.uid);
}

function filled(...ids: string[]): TrackQueue {
  const queue = new TrackQueue(10);
  for (const id of ids) {
    queue.enqueue(track(id));
  }
  return queue;
}

describe("TrackQueue", () => {
  it("enqueues in order and returns the position", () => {
    const queue = new TrackQueue(10);
    assert.equal(queue.enqueue(track("a")), 1);
    assert.equal(queue.enqueue(track("b")), 2);
    assert.deepEqual(uids(queue), ["a", "b"]);
  });

  it("rejects tracks beyond capacity", () => {
    const queue = new TrackQueue(1);
    queue.enqueue(track("a"));
    assert.equal(queue.isFull, true);
    assert.throws(() => queue.enqueue(track("b")), QueueFullError);
  });

  it("shifts from the front", () => {
    const queue = filled("a", "b");
    assert.equal(queue.shift()?.uid, "a");
    assert.deepEqual(uids(queue), ["b"]);
  });

  it("removes by uid", () => {
    const queue = filled("a", "b", "c");
    assert.equal(queue.remove("b")?.uid, "b");
    assert.equal(queue.remove("missing"), undefined);
    assert.deepEqual(uids(queue), ["a", "c"]);
  });

  it("moves tracks within bounds", () => {
    const queue = filled("a", "b", "c");
    assert.equal(queue.move("c", -1), true);
    assert.deepEqual(uids(queue), ["a", "c", "b"]);
    assert.equal(queue.move("a", -1), false);
    assert.equal(queue.move("b", 1), false);
    assert.equal(queue.move("missing", 1), false);
  });

  it("promotes a track to the front", () => {
    const queue = filled("a", "b", "c");
    assert.equal(queue.promote("c")?.uid, "c");
    assert.deepEqual(uids(queue), ["c", "a", "b"]);
    assert.equal(queue.promote("missing"), undefined);
  });

  it("shuffles deterministically with an injected random source", () => {
    const queue = filled("a", "b", "c", "d");
    queue.shuffle(() => 0);
    assert.deepEqual(uids(queue).sort(), ["a", "b", "c", "d"]);
    assert.deepEqual(uids(queue), ["b", "c", "d", "a"]);
  });

  it("clears and reports the count", () => {
    const queue = filled("a", "b");
    assert.equal(queue.clear(), 2);
    assert.equal(queue.size, 0);
  });

  it("returns a defensive copy of items", () => {
    const queue = filled("a");
    (queue.items as Track[]).push(track("b"));
    assert.equal(queue.size, 1);
  });
});
