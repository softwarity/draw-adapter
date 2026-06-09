// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import DragPan from "ol/interaction/DragPan.js";
import DoubleClickZoom from "ol/interaction/DoubleClickZoom.js";
import VectorLayer from "ol/layer/Vector.js";
import { Circle as CircleStyle, Icon, Style } from "ol/style.js";

import { OpenLayersAdapter } from "../src/openlayers.js";
import type { LayerSpec, PointerEvent } from "../src/index.js";

const LAYERS: LayerSpec[] = [
  { id: "area", kind: "fill" },
  { id: "guide", kind: "line" },
  { id: "symbols", kind: "symbol" },
  { id: "label", kind: "text" },
  { id: "handles", kind: "circle" },
];

interface Hit { feature: { getProperties: () => Record<string, unknown> }; layer: unknown }

/** Record-only stand-in for `ol/Map`. */
class FakeOlMap {
  added: VectorLayer[] = [];
  handlers = new Map<string, ((e: unknown) => unknown)[]>();
  viewportListeners: { ev: string; fn: (e: unknown) => void; capture: boolean }[] = [];
  hits: Hit[] = [];
  dragPan = new DragPan();
  dblZoom = new DoubleClickZoom();
  private target = document.createElement("div");
  private viewport = document.createElement("div");

  getInteractions() { return { getArray: () => [this.dragPan, this.dblZoom] }; }
  addLayer(l: VectorLayer) { this.added.push(l); }
  removeLayer() {}
  on(ev: string, fn: (e: unknown) => unknown) {
    (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(fn);
    return { ev };
  }
  emit(ev: string, payload: unknown) { for (const fn of this.handlers.get(ev) ?? []) fn(payload); }
  getView() { return { getCenter: () => [0, 0], calculateExtent: () => [0, 0, 1, 1] }; }
  getSize() { return [800, 600]; }
  getTargetElement() { return this.target; }
  getViewport() {
    return {
      addEventListener: (ev: string, fn: (e: unknown) => void, capture?: boolean) =>
        this.viewportListeners.push({ ev, fn, capture: !!capture }),
      removeEventListener() {},
    };
  }
  getPixelFromCoordinate() { return [1, 2]; }
  getCoordinateFromPixel() { return [0, 0]; }
  getEventCoordinate() { return [0, 0]; }
  getEventPixel() { return [5, 5]; }
  forEachFeatureAtPixel(_p: number[], cb: (f: unknown, l: unknown) => unknown) {
    for (const { feature, layer } of this.hits) if (cb(feature, layer)) break;
  }
}

function build(hitOverlays?: Set<string>) {
  const map = new FakeOlMap();
  const adapter = new OpenLayersAdapter({ map: map as never, layers: LAYERS, ...(hitOverlays ? { hitOverlays } : {}) });
  return { map, adapter };
}

/** Fake `FeatureLike` for a style function. */
const feat = (props: Record<string, unknown>, geomType = "Point") =>
  ({ get: (k: string) => props[k], getGeometry: () => ({ getType: () => geomType }) }) as never;

/** The style produced by overlay `id` for a feature carrying `props`. */
async function styleOf(id: string, props: Record<string, unknown>, geomType?: string) {
  const { map, adapter } = build();
  await adapter.ready();
  const i = LAYERS.findIndex((l) => l.id === id);
  const styleFn = map.added[i]!.getStyle() as (f: never) => Style | Style[];
  await adapter.registerSymbols({ MOD: '<svg stroke="currentColor"/>' });
  return styleFn(feat(props, geomType));
}

describe("OpenLayersAdapter — styleFor maps props → ol/style", () => {
  it("builds one vector layer per overlay", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(map.added).toHaveLength(LAYERS.length);
    expect(map.added.every((l) => l instanceof VectorLayer)).toBe(true);
  });

  it("fill ⇒ rgba(fillColor, fillOpacity) + an outline when `stroke` is set", async () => {
    const s = (await styleOf("area", { fillColor: "#f0883e", fillOpacity: 0.35, stroke: "#222", strokeWidth: 2 })) as Style;
    expect(s.getFill()!.getColor()).toBe("rgba(240, 136, 62, 0.35)");
    expect(s.getStroke()!.getWidth()).toBe(2);
  });

  it("line ⇒ stroke colour/width + dash; a Polygon also gets a fill", async () => {
    const line = (await styleOf("guide", { stroke: "#58a6ff", strokeWidth: 3, dash: [2, 4] })) as Style;
    expect(line.getStroke()!.getColor()).toBe("rgba(88, 166, 255, 1)");
    expect(line.getStroke()!.getWidth()).toBe(3);
    expect(line.getStroke()!.getLineDash()).toEqual([2, 4]);
    const poly = (await styleOf("guide", { stroke: "#58a6ff", fillColor: "#0f0" }, "Polygon")) as Style;
    expect(poly.getFill()).not.toBeNull();
  });

  it("circle ⇒ a CircleStyle dot reading radius/fill/stroke", async () => {
    const s = (await styleOf("handles", { radius: 7, fill: "#fff", stroke: "#58a6ff", strokeWidth: 2 })) as Style;
    const img = s.getImage() as CircleStyle;
    expect(img).toBeInstanceOf(CircleStyle);
    expect(img.getRadius()).toBe(7);
    expect(img.getFill()!.getColor()).toBe("#fff");
  });

  it("circle with an `icon` data-URI ⇒ [dot, Icon] with the rotation", async () => {
    const s = (await styleOf("handles", { radius: 0, icon: "data:image/svg+xml,%3Csvg/%3E", iconRotate: 90 })) as Style[];
    expect(Array.isArray(s)).toBe(true);
    expect(s[0]!.getImage()).toBeInstanceOf(CircleStyle);
    expect(s[1]!.getImage()).toBeInstanceOf(Icon);
  });

  it("text ⇒ a Text with the string + halo", async () => {
    const s = (await styleOf("label", { text: "EMBD TS", textColor: "#fff", textHalo: "#000", textSize: 13 })) as Style;
    expect(s.getText()!.getText()).toBe("EMBD TS");
    expect(s.getText()!.getStroke()!.getColor()).toBe("#000");
  });

  it("label box: padding from textBoxSize; drawn only when bg and/or border is set", async () => {
    // bg + large ⇒ backgroundFill + [10,13,10,13] padding
    const bgT = ((await styleOf("label", { text: "x", textBackground: "#fff", textBoxSize: "large" })) as Style).getText()!;
    expect(bgT.getBackgroundFill()).not.toBeNull();
    expect(bgT.getPadding()).toEqual([10, 13, 10, 13]);
    // border-only + small ⇒ backgroundStroke (no fill) + [3,5,3,5] padding
    const bdT = ((await styleOf("label", { text: "x", textBorder: "#000", textBoxSize: "small" })) as Style).getText()!;
    expect(bdT.getBackgroundFill()).toBeNull();
    expect(bdT.getBackgroundStroke()).not.toBeNull();
    expect(bdT.getPadding()).toEqual([3, 5, 3, 5]);
    // neither ⇒ no box at all
    const noT = ((await styleOf("label", { text: "x" })) as Style).getText()!;
    expect(noT.getBackgroundFill()).toBeNull();
    expect(noT.getBackgroundStroke()).toBeNull();
  });

  it("symbol ⇒ an Icon once the sprite is registered", async () => {
    const s = (await styleOf("symbols", { symbol: "MOD", symbolColor: "#9a6700", size: 1 })) as Style;
    expect(s.getImage()).toBeInstanceOf(Icon);
  });
});

describe("OpenLayersAdapter — drag-vs-pan (capture phase)", () => {
  it("registers `pointerdown` in the CAPTURE phase on the viewport", () => {
    const { map, adapter } = build();
    adapter.onPointer(() => {});
    const down = map.viewportListeners.find((l) => l.ev === "pointerdown");
    expect(down?.capture).toBe(true);
  });

  it("stopPropagation only fires for a DRAGGABLE hit (preserves clicks)", async () => {
    const { map, adapter } = build(new Set(["handles", "area"]));
    await adapter.ready();
    adapter.onPointer(() => {});
    const fire = (props: Record<string, unknown>, layerIdx: number) => {
      map.hits = [{ feature: { getProperties: () => ({ ...props, geometry: {} }) }, layer: map.added[layerIdx] }];
      const stop = vi.fn();
      map.viewportListeners.find((l) => l.ev === "pointerdown")!.fn({ stopPropagation: stop } as never);
      return stop;
    };
    expect(fire({ role: "v0" }, 4).mock.calls.length).toBe(1); // handle → stopped
    expect(fire({ featureId: "x" }, 0).mock.calls.length).toBe(0); // plain area → not stopped
  });
});

describe("OpenLayersAdapter — hit-testing (top-of-stack wins)", () => {
  it("returns the highest-z overlay among the tolerance candidates", async () => {
    const { map, adapter } = build(new Set(["area", "handles"]));
    await adapter.ready();
    let lastHit: PointerEvent["hit"];
    adapter.onPointer((e) => { if (e.type === "move") lastHit = e.hit; });
    // Report `area` (z0) BEFORE `handles` (z4): the adapter must still pick handles.
    map.hits = [
      { feature: { getProperties: () => ({ featureId: "a", geometry: {} }) }, layer: map.added[0] },
      { feature: { getProperties: () => ({ role: "v0", geometry: {} }) }, layer: map.added[4] },
    ];
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5] });
    expect(lastHit?.overlay).toBe("handles");
  });
});

describe("OpenLayersAdapter — pan + teardown", () => {
  it("setPanEnabled toggles DragPan; destroy re-enables DragPan + DoubleClickZoom", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const pan = vi.spyOn(map.dragPan, "setActive");
    const dbl = vi.spyOn(map.dblZoom, "setActive");
    adapter.setPanEnabled(false);
    expect(pan).toHaveBeenLastCalledWith(false);
    adapter.destroy();
    expect(pan).toHaveBeenLastCalledWith(true);
    expect(dbl).toHaveBeenLastCalledWith(true);
  });
});
