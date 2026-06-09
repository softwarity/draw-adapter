import { describe, expect, it } from "vitest";

import { cursorForHit, rgba, wrapLabel, colorizeSprite, svgToDataUrl } from "../src/index.js";
import { FakeAdapter } from "../src/testing.js";

describe("cursorForHit", () => {
  it("is empty with no hit", () => expect(cursorForHit(undefined)).toBe(""));
  it("honours an explicit per-feature cursor prop (wins over defaults)", () =>
    expect(cursorForHit({ overlay: "guide", props: { role: "lon", cursor: "ew-resize" } })).toBe("ew-resize"));
  it("ignores an empty/non-string cursor prop and falls back", () =>
    expect(cursorForHit({ overlay: "handles", props: { role: "v0", cursor: "" } })).toBe("grab"));
  it("is move for a whole-shape move handle", () =>
    expect(cursorForHit({ overlay: "handles", props: { role: "center", move: true } })).toBe("move"));
  it("is grab for a draggable vertex/handle (role)", () =>
    expect(cursorForHit({ overlay: "handles", props: { role: "v0" } })).toBe("grab"));
  it("is grab for a control handle", () =>
    expect(cursorForHit({ overlay: "handles", props: { control: true } })).toBe("grab"));
  it("is pointer for a non-draggable hit", () =>
    expect(cursorForHit({ overlay: "area", props: { featureId: "x" } })).toBe("pointer"));
});

describe("rgba", () => {
  it("expands #rgb", () => expect(rgba("#f80", 0.5)).toBe("rgba(255, 136, 0, 0.5)"));
  it("expands #rrggbb", () => expect(rgba("#58a6ff", 1)).toBe("rgba(88, 166, 255, 1)"));
  it("passes non-hex through", () => expect(rgba("red", 0.3)).toBe("red"));
});

describe("wrapLabel", () => {
  it("returns text unchanged when maxPx <= 0", () => expect(wrapLabel("a b c", 0, 12)).toBe("a b c"));
});

describe("sprite utils", () => {
  it("colorizes currentColor", () =>
    expect(colorizeSprite('<path stroke="currentColor"/>', "#123")).toBe('<path stroke="#123"/>'));
  it("encodes a data url", () => expect(svgToDataUrl("<svg/>")).toMatch(/^data:image\/svg\+xml/));
});

describe("FakeAdapter", () => {
  it("records overlays and replays pointer hits", () => {
    const a = new FakeAdapter();
    const seen: string[] = [];
    a.onPointer((e) => seen.push(`${e.type}:${e.hit?.overlay ?? "-"}`));
    a.setOverlay("handles", { type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { role: "center" } },
    ] });
    a.send("down", 1, 2, "handles", { role: "center" });
    a.send("up", 0, 0);
    expect(seen).toEqual(["down:handles", "up:-"]);
    expect(a.feature("handles", "center")).toBeDefined();
  });

  it("tracks pan + cursor state", () => {
    const a = new FakeAdapter();
    a.setPanEnabled(false);
    a.setCursor("crosshair");
    expect(a.panEnabled).toBe(false);
    expect(a.cursor).toBe("crosshair");
  });

  it("forwards held modifiers on the pointer event (default all false)", () => {
    const a = new FakeAdapter();
    const events: import("../src/index.js").PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    // injected modifier on a drag move (the modifier-gated-drag use case)
    a.send("move", 1, 2, undefined, undefined, { ctrlKey: true });
    a.send("move", 1, 2, undefined, undefined, { metaKey: true, shiftKey: true });
    a.send("up", 0, 0); // none ⇒ all false
    expect(events[0]).toMatchObject({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
    expect(events[1]).toMatchObject({ ctrlKey: false, metaKey: true, shiftKey: true, altKey: false });
    expect(events[2]).toMatchObject({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
  });
});
