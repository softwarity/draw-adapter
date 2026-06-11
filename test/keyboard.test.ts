// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { bindKeyListener, refocusMap } from "../src/keyboard.js";
import type { KeyEvent } from "../src/index.js";
import { FakeAdapter } from "../src/testing.js";

describe("bindKeyListener", () => {
  it("forwards a normalized key event and makes the container focusable", () => {
    const el = document.createElement("div");
    const seen: KeyEvent[] = [];
    bindKeyListener(el, (e) => seen.push(e));
    expect(el.getAttribute("tabindex")).toBe("-1"); // click-focusable, not in tab order
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", metaKey: true, bubbles: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: "Backspace", code: "Backspace", meta: true, ctrl: false, shift: false, alt: false });
  });

  it("preventDefault forwards to the native event", () => {
    const el = document.createElement("div");
    bindKeyListener(el, (e) => e.preventDefault());
    const ev = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("skips editable targets (so typing in an input never triggers a map shortcut)", () => {
    const el = document.createElement("div");
    const input = document.createElement("input");
    el.appendChild(input);
    document.body.appendChild(el);
    const seen: string[] = [];
    bindKeyListener(el, (e) => seen.push(e.key));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); // from the input → ignored
    expect(seen).toHaveLength(0);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); // from the map → forwarded
    expect(seen).toEqual(["Delete"]);
    el.remove();
  });

  it("does not override an existing tabindex, and teardown detaches", () => {
    const el = document.createElement("div");
    el.setAttribute("tabindex", "0");
    const seen: string[] = [];
    const off = bindKeyListener(el, (e) => seen.push(e.key));
    expect(el.getAttribute("tabindex")).toBe("0"); // left as-is
    off();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(seen).toHaveLength(0);
  });
});

describe("FakeAdapter.onKey", () => {
  it("replays key events via the key() helper", () => {
    const a = new FakeAdapter();
    const seen: Array<{ key: string; meta: boolean }> = [];
    a.onKey((e) => seen.push({ key: e.key, meta: e.meta }));
    a.key("Backspace");
    a.key("Delete", { meta: true });
    expect(seen).toEqual([{ key: "Backspace", meta: false }, { key: "Delete", meta: true }]);
  });
});

describe("refocusMap", () => {
  it("focuses the target (making it focusable) so onKey works after a chrome click", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    refocusMap(el);
    expect(el.getAttribute("tabindex")).toBe("-1"); // made focusable
    expect(document.activeElement).toBe(el);
    el.remove();
  });

  it("is a no-op while a text field is focused (keeps the editor's caret)", () => {
    const el = document.createElement("div");
    const input = document.createElement("input");
    document.body.append(el, input);
    input.focus();
    refocusMap(el);
    expect(document.activeElement).toBe(input); // not stolen from the input
    el.remove(); input.remove();
  });
});
