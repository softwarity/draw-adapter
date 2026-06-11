// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { clampCursor, gaugeBounds, dialAngle, dialValueFromAngle } from "../src/widget.js";
import { FakeAdapter } from "../src/testing.js";
import type { WidgetDial, WidgetGauge } from "../src/index.js";

const gauge = (over: Partial<WidgetGauge> = {}): WidgetGauge => ({
  kind: "gauge", min: 250, max: 600, step: 10,
  cursors: [{ name: "base", value: 260 }, { name: "top", value: 410 }], ...over,
});

describe("gauge math — clampCursor", () => {
  it("snaps to step and clamps within [min, max]", () => {
    const g = gauge({ cursors: [{ name: "a", value: 300 }] });
    expect(clampCursor(303, 0, g)).toBe(300); // snap to step 10
    expect(clampCursor(700, 0, g)).toBe(600); // clamp max
    expect(clampCursor(100, 0, g)).toBe(250); // clamp min
  });

  it("cursors cannot cross — each is clamped by its neighbours", () => {
    const g = gauge(); // base 260, top 410
    expect(clampCursor(500, 0, g)).toBe(410); // base can't pass top
    expect(clampCursor(200, 1, g)).toBe(260); // top can't pass base
  });

  it("3 cursors hold their order — the middle is clamped by both sides", () => {
    const g = gauge({ cursors: [{ name: "a", value: 300 }, { name: "b", value: 400 }, { name: "c", value: 500 }] });
    expect(clampCursor(999, 1, g)).toBe(500); // middle ≤ top neighbour
    expect(clampCursor(0, 1, g)).toBe(300);   // middle ≥ base neighbour
  });

  it("beyond.below reaches one step below min and emits min - step", () => {
    const g = gauge({ beyond: { below: true }, cursors: [{ name: "a", value: 250 }] });
    expect(gaugeBounds(g)).toEqual({ lo: 240, hi: 600 });
    expect(clampCursor(244, 0, g)).toBe(240); // snaps to min - step (the notch)
    expect(clampCursor(0, 0, g)).toBe(240);   // clamped to the notch
  });

  it("beyond.above reaches one step above max", () => {
    const g = gauge({ beyond: { above: true }, cursors: [{ name: "a", value: 600 }] });
    expect(clampCursor(9999, 0, g)).toBe(610); // max + step
  });
});

describe("dial math — angle mapping (fixed convention)", () => {
  const d: WidgetDial = { kind: "dial", name: "spd", min: 0, max: 100, value: 0, sweep: 240 };
  it("min at 150°, max at 150 + sweep, midpoint straight up", () => {
    expect(dialAngle(0, d)).toBe(150);
    expect(dialAngle(100, d)).toBe(390); // = 30° (mod 360)
    expect(dialAngle(50, d)).toBe(270);  // straight up
  });
  it("pointer angle → value; a press in the bottom gap clamps to the nearer end", () => {
    expect(dialValueFromAngle(150, d)).toBe(0);
    expect(dialValueFromAngle(270, d)).toBe(50);
    expect(dialValueFromAngle(30, d)).toBe(100);  // == 390, the max end
    expect(dialValueFromAngle(60, d)).toBe(100);  // bottom gap, nearer max
    expect(dialValueFromAngle(120, d)).toBe(0);   // bottom gap, nearer min
  });
});

describe("FakeAdapter — dragGauge", () => {
  it("fires onWidgetEdit({ id, name, value: String(value) })", () => {
    const a = new FakeAdapter();
    const edits: { id: string; name?: string; value: string }[] = [];
    a.onWidgetEdit((e) => edits.push(e));
    a.dragGauge("g1", "baseFL", 260);
    expect(edits).toEqual([{ id: "g1", name: "baseFL", value: "260" }]);
  });
});
