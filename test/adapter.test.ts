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
  it("injects xmlns on a namespaceless <svg> (a data: image is strict XML ⇒ would load empty otherwise)", () => {
    const decoded = decodeURIComponent(svgToDataUrl("<svg><path/></svg>").split(",")[1]!);
    expect(decoded).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it("does not duplicate an xmlns that is already present", () => {
    const decoded = decodeURIComponent(svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>').split(",")[1]!);
    expect(decoded.match(/xmlns=/g)).toHaveLength(1);
  });
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

  it("records setProjection / viewArea / highlightArea", () => {
    const a = new FakeAdapter();
    expect(a.projection).toBe("mercator"); // default
    a.setProjection({ kind: "proj4", code: "EPSG:3995", def: "+proj=stere" });
    expect(a.projection).toMatchObject({ kind: "proj4", code: "EPSG:3995" });
    a.viewArea([110, -10, -110, 72], { padding: 16 });
    expect(a.viewedArea).toEqual({ extent: [110, -10, -110, 72], opts: { padding: 16 } });
    a.highlightArea([-90, 0, 30, 90], { color: "#f00" });
    expect(a.highlightedArea).toEqual([-90, 0, 30, 90]);
    expect(a.highlightStyle).toMatchObject({ color: "#f00" });
    a.highlightArea(null);
    expect(a.highlightedArea).toBeNull();
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

describe("FakeAdapter — marker widgets", () => {
  it("records the widget set and surfaces it by id", () => {
    const a = new FakeAdapter();
    a.setWidgets([{ id: "v1", anchor: { lon: 3, lat: 46 }, child: { dir: "v", items: [{ kind: "coord" }] } }]);
    expect(a.widgets).toHaveLength(1);
    expect(a.widget("v1")?.anchor).toEqual({ lon: 3, lat: 46 });
  });

  it("editWidget fires onWidgetEdit({ id, value })", () => {
    const a = new FakeAdapter();
    const edits: { id: string; value: string }[] = [];
    a.onWidgetEdit((e) => edits.push(e));
    a.editWidget("v1", "ETNA");
    expect(edits).toEqual([{ id: "v1", value: "ETNA" }]);
  });

  it("deleteWidget fires onWidgetDelete({ id })", () => {
    const a = new FakeAdapter();
    const deleted: { id: string }[] = [];
    a.onWidgetDelete((e) => deleted.push(e));
    a.deleteWidget("v1");
    expect(deleted).toEqual([{ id: "v1" }]);
  });

  it("clickWidget surfaces a { overlay:'widget', props:{ id } } hit via onPointer", () => {
    const a = new FakeAdapter();
    const events: import("../src/index.js").PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    a.clickWidget("v1");
    expect(events[0]).toMatchObject({ type: "click", hit: { overlay: "widget", props: { id: "v1" } } });
  });

  it("setCoordFormat is recorded for the consumer's formatter", () => {
    const a = new FakeAdapter();
    const fmt = (ll: { lon: number; lat: number }) => `${ll.lon}/${ll.lat}`;
    a.setCoordFormat(fmt);
    expect(a.coordFormat).toBe(fmt);
  });
});

describe("FakeAdapter — onBlur", () => {
  it("fires on .blur() (the window-focus-lost signal for deselect)", () => {
    const a = new FakeAdapter();
    let blurred = 0;
    a.onBlur(() => blurred++);
    a.blur();
    expect(blurred).toBe(1);
  });
});

describe("FakeAdapter — camera + overlay + actions (0.3.0)", () => {
  it("exposes container/bounds/zoom, records fitBounds + overlay visibility", () => {
    const a = new FakeAdapter();
    expect(a.getBounds()).toEqual([-1, -1, 1, 1]);
    expect(typeof a.getZoom()).toBe("number");
    expect(a.getContainer()).toBeTruthy();
    a.fitBounds([1, 2, 3, 4]);
    expect(a.fittedBounds).toEqual([1, 2, 3, 4]);
    a.setOverlayVisible("guide", false);
    expect(a.overlayVisible["guide"]).toBe(false);
  });

  it("actionWidget fires onWidgetAction({ id, event })", () => {
    const a = new FakeAdapter();
    const acts: { id: string; event: string }[] = [];
    a.onWidgetAction((e) => acts.push(e));
    a.actionWidget("v1", "draw-again");
    expect(acts).toEqual([{ id: "v1", event: "draw-again" }]);
  });

  it("send surfaces a contextmenu (right-click) hit", () => {
    const a = new FakeAdapter();
    const events: import("../src/index.js").PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    a.send("contextmenu", 1, 2, "area", { featureId: "x" });
    expect(events[0]).toMatchObject({ type: "contextmenu", hit: { overlay: "area", props: { featureId: "x" } } });
  });
});

describe("FakeAdapter — carousel edit (named control)", () => {
  it("editWidget(id, value, name) fires onWidgetEdit({ id, name, value })", () => {
    const a = new FakeAdapter();
    const edits: { id: string; name?: string; value: string }[] = [];
    a.onWidgetEdit((e) => edits.push(e));
    a.editWidget("c1", "OCNL", "coverage");
    expect(edits).toEqual([{ id: "c1", name: "coverage", value: "OCNL" }]);
  });
});
