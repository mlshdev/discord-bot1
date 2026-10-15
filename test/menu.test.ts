import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type APIButtonComponent, type APIStringSelectComponent, ComponentType } from "discord.js";
import { MenuAction, type MenuState, normalizeState, PAGE_SIZE, renderMenu } from "../src/menu.ts";
import type { PlayerSnapshot } from "../src/player.ts";
import type { Track } from "../src/queue.ts";

function track(n: number): Track {
  return {
    uid: `t${n}`,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: `Song ${n}`,
    durationSeconds: 60,
    uploader: undefined,
    requestedBy: "1",
  };
}

function snapshot(count: number, playing = true): PlayerSnapshot {
  return {
    current: playing ? track(0) : undefined,
    paused: false,
    volume: 100,
    upcoming: Array.from({ length: count }, (_, i) => track(i + 1)),
  };
}

function state(overrides: Partial<MenuState> = {}): MenuState {
  return { page: 0, selectedUid: undefined, notice: undefined, ...overrides };
}

function buttons(view: ReturnType<typeof renderMenu>): Map<string, APIButtonComponent> {
  const result = new Map<string, APIButtonComponent>();
  for (const row of view.components) {
    for (const component of row.toJSON().components) {
      if ("custom_id" in component && component.type === ComponentType.Button) {
        result.set(component.custom_id, component);
      }
    }
  }
  return result;
}

describe("renderMenu", () => {
  it("disables track actions until a track is selected", () => {
    const view = renderMenu(snapshot(3), state(), false);
    const b = buttons(view);
    assert.equal(b.get(MenuAction.playNow)?.disabled, true);
    assert.equal(b.get(MenuAction.remove)?.disabled, true);
    assert.equal(b.get(MenuAction.skip)?.disabled, false);
  });

  it("enables track actions for a selection and bounds move buttons", () => {
    const b = buttons(renderMenu(snapshot(3), state({ selectedUid: "t1" }), false));
    assert.equal(b.get(MenuAction.playNow)?.disabled, false);
    assert.equal(b.get(MenuAction.up)?.disabled, true);
    assert.equal(b.get(MenuAction.down)?.disabled, false);
  });

  it("paginates the select menu", () => {
    const view = renderMenu(snapshot(PAGE_SIZE + 3), state({ page: 1 }), false);
    const select = view.components[0]?.toJSON().components[0] as APIStringSelectComponent;
    assert.deepEqual(
      select.options.map((option) => option.value),
      ["t11", "t12", "t13"],
    );
    const b = buttons(view);
    assert.equal(b.get(MenuAction.prev)?.disabled, false);
    assert.equal(b.get(MenuAction.next)?.disabled, true);
  });

  it("renders a disabled placeholder for an empty queue", () => {
    const view = renderMenu(snapshot(0, false), state(), false);
    const select = view.components[0]?.toJSON().components[0] as APIStringSelectComponent;
    assert.equal(select.disabled, true);
    assert.equal(buttons(view).get(MenuAction.skip)?.disabled, true);
  });

  it("drops components when closed", () => {
    assert.equal(renderMenu(snapshot(2), state(), true).components.length, 0);
  });
});

describe("normalizeState", () => {
  it("clears stale selections and clamps the page", () => {
    const s = state({ page: 5, selectedUid: "gone" });
    normalizeState(s, snapshot(3));
    assert.equal(s.page, 0);
    assert.equal(s.selectedUid, undefined);
  });
});
