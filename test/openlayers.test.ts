// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import DragPan from "ol/interaction/DragPan.js";
import DoubleClickZoom from "ol/interaction/DoubleClickZoom.js";
import Overlay from "ol/Overlay.js";
import VectorLayer from "ol/layer/Vector.js";
import View from "ol/View.js";
import { Circle as CircleStyle, Icon, Style } from "ol/style.js";

import { OpenLayersAdapter } from "../src/openlayers.js";
import type { LayerSpec, MarkerWidget, PointerEvent } from "../src/index.js";

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
  overlays: Overlay[] = [];
  dragPan = new DragPan();
  dblZoom = new DoubleClickZoom();
  view = new View({ center: [0, 0], zoom: 6 }); // real View ⇒ getProjection()/calculateExtent() work
  private target = document.createElement("div");
  private viewport = document.createElement("div");

  getInteractions() { return { getArray: () => [this.dragPan, this.dblZoom] }; }
  addLayer(l: VectorLayer) { this.added.push(l); }
  removeLayer(l?: VectorLayer) { if (l) this.added = this.added.filter((x) => x !== l); }
  /** Collection-like over `added` (only the members the adapter's highlight path uses). */
  getLayers() {
    return {
      getArray: () => this.added,
      getLength: () => this.added.length,
      insertAt: (i: number, l: VectorLayer) => { this.added.splice(i, 0, l); },
    };
  }
  setView(v: View) { this.view = v; }
  addOverlay(o: Overlay) { this.overlays.push(o); const el = o.getElement(); if (el) document.body.appendChild(el); }
  removeOverlay(o: Overlay) { this.overlays = this.overlays.filter((x) => x !== o); o.getElement()?.remove(); }
  on(ev: string, fn: (e: unknown) => unknown) {
    (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(fn);
    // Return a key the real `unByKey` can resolve: it calls `key.target.removeEventListener(key.type, key.listener)`.
    return { type: ev, listener: fn, target: { removeEventListener: (t: string, l: unknown) => { const a = this.handlers.get(t); if (a) this.handlers.set(t, a.filter((h) => h !== l)); } } };
  }
  emit(ev: string, payload: unknown) { for (const fn of this.handlers.get(ev) ?? []) fn(payload); }
  getView() { return this.view; }
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

describe("OpenLayersAdapter — modifier keys on pointer events", () => {
  it("forwards the live modifier state (read off MapBrowserEvent.originalEvent), default false", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5], originalEvent: { metaKey: true, shiftKey: true } });
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5], originalEvent: {} });
    expect(events[0]).toMatchObject({ metaKey: true, shiftKey: true, ctrlKey: false, altKey: false });
    expect(events[1]).toMatchObject({ metaKey: false, shiftKey: false, ctrlKey: false, altKey: false });
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

describe("OpenLayersAdapter — marker widgets", () => {
  const W = (id: string, items: unknown[]) => ({ id, anchor: { lon: 0, lat: 0 }, child: { dir: "h" as const, items } });

  it("mounts a card overlay and routes a card tap to onPointer as a widget hit", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    adapter.setWidgets([W("w1", [{ kind: "text", value: "NN", editable: true }, { kind: "coord" }]) as never]);
    const el = map.overlays[0]!.getElement() as HTMLElement;
    expect(el.classList.contains("draw-adapter-widget")).toBe(true);
    const card = el.querySelector(".draw-adapter-widget-card") as HTMLElement;
    expect(card.querySelector("input")).not.toBeNull();
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
    card.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(events.some((e) => e.type === "click" && e.hit?.overlay === "widget" && e.hit.props["id"] === "w1")).toBe(true);
    adapter.destroy();
    expect(map.overlays).toHaveLength(0); // overlay removed on teardown
  });

  it("the capture-phase pointerdown guard ignores presses originating on a card", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    adapter.setWidgets([W("w1", [{ kind: "glyph", svg: "<svg></svg>" }]) as never]);
    const card = (map.overlays[0]!.getElement() as HTMLElement).querySelector(".draw-adapter-widget-card") as HTMLElement;
    const down = map.viewportListeners.find((l) => l.ev === "pointerdown")!;
    events.length = 0;
    down.fn({ target: card, stopPropagation() {} } as never); // capture listener sees a card press
    expect(events).toHaveLength(0); // guard bailed → no map "down"
  });

  it("fires onWidgetEdit per keystroke", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const edits: { id: string; value: string }[] = [];
    adapter.onWidgetEdit((e) => edits.push(e));
    adapter.setWidgets([W("w1", [{ kind: "text", value: "", editable: true }]) as never]);
    const input = (map.overlays[0]!.getElement() as HTMLElement).querySelector("input") as HTMLInputElement;
    input.value = "A";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edits).toEqual([{ id: "w1", value: "A" }]);
  });
});

describe("OpenLayersAdapter — static widget sprites", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const STATIC_W: MarkerWidget = {
    id: "w1", anchor: { lon: 2, lat: 1 }, static: true, labelId: "main",
    child: { dir: "v", items: [{ kind: "text", value: "FL340" }] },
  };
  // The lazy sprite layer is the only layer added by setWidgets([static]) (a static widget renders no
  // DOM card overlay), so it's whatever appears in `map.added` that wasn't there after ready().
  const freshLayer = (map: FakeOlMap, before: Set<VectorLayer>) => map.added.find((l) => !before.has(l))!;

  // Regression guard for SPRITE-COLLISION-SPEC: the sprite layer must NOT declutter. Placement is the
  // consumer's pass, so OpenLayers must never auto-hide a sprite that overlaps a basemap label or
  // another icon (a declutter layer drops overlapping icons — and they stop hit-testing — exactly the
  // MapLibre collision symptom). `getDeclutter()` must stay falsy.
  it("renders sprites on a non-declutter layer (never auto-hidden by overlap)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const before = new Set(map.added);
    adapter.setWidgets([STATIC_W]);
    await flush();
    const fresh = map.added.filter((l) => !before.has(l));
    expect(fresh).toHaveLength(1); // exactly the lazy sprite layer
    expect(fresh[0]!.getDeclutter()).toBeFalsy();
  });

  it("a sprite hit surfaces overlay=text-boxes carrying the widget's featureId + labelId", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const before = new Set(map.added);
    adapter.setWidgets([STATIC_W]);
    await flush();
    const spriteLayer = freshLayer(map, before);
    let lastHit: PointerEvent["hit"];
    adapter.onPointer((e) => { if (e.type === "move") lastHit = e.hit; });
    // The sprite layer reuses the call-out overlay, so the consumer's existing text-boxes interaction
    // (drag = reposition, tap = select) handles the press unchanged.
    map.hits = [{ feature: { getProperties: () => ({ featureId: "w1", labelId: "main", geometry: {} }) }, layer: spriteLayer }];
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5] });
    expect(lastHit?.overlay).toBe("text-boxes");
    expect(lastHit?.props["featureId"]).toBe("w1");
    expect(lastHit?.props["labelId"]).toBe("main");
  });
});

describe("OpenLayersAdapter — atomic press + focus resilience", () => {
  const downEvt = () => ({ target: document.createElement("div"), clientX: 5, clientY: 5, stopPropagation() {} });
  const featureHit = (map: FakeOlMap, props: Record<string, unknown>) =>
    [{ feature: { getProperties: () => ({ ...props, geometry: {} }) }, layer: map.added[0]! }];

  it("emits the click on release with the down hit, even if the hit-test would now miss (re-render race)", async () => {
    const { map, adapter } = build(new Set(["area"]));
    await adapter.ready();
    let clickHit: PointerEvent["hit"];
    adapter.onPointer((e) => { if (e.type === "click") clickHit = e.hit; });
    map.hits = featureHit(map, { featureId: "f1" });
    map.viewportListeners.find((l) => l.ev === "pointerdown")!.fn(downEvt()); // down ⇒ pressHit = f1
    map.hits = []; // select re-rendered → the feature is no longer under the pixel
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 5, clientY: 5 })); // release at the down spot
    expect(clickHit).toMatchObject({ overlay: "area", props: { featureId: "f1" } });
  });

  it("window blur purges the press state (dragging) so the next gesture starts clean", async () => {
    const { map, adapter } = build(new Set(["area"]));
    await adapter.ready();
    const moveHits: (PointerEvent["hit"])[] = [];
    adapter.onPointer((e) => { if (e.type === "move") moveHits.push(e.hit); });
    map.hits = featureHit(map, { featureId: "f1" });
    map.viewportListeners.find((l) => l.ev === "pointerdown")!.fn(downEvt()); // dragging = true
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5], originalEvent: {} });
    expect(moveHits.at(-1)).toBeUndefined(); // dragging ⇒ hover hit-test skipped
    window.dispatchEvent(new Event("blur"));
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5], originalEvent: {} });
    expect(moveHits.at(-1)).toMatchObject({ overlay: "area" }); // blur reset ⇒ hovering resumes
  });
});

describe("OpenLayersAdapter — swallowed-up recovery", () => {
  it("a move with no button held finalises the press (emits up, resumes hovering)", async () => {
    const map = new FakeOlMap();
    const adapter = new OpenLayersAdapter({ map: map as never, layers: LAYERS, hitOverlays: new Set(["area"]) });
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    map.hits = [{ feature: { getProperties: () => ({ featureId: "f1", geometry: {} }) }, layer: map.added[0]! }];
    map.viewportListeners.find((l) => l.ev === "pointerdown")!.fn({ target: document.createElement("div"), stopPropagation() {} }); // dragging = true
    // a move with NO button held ⇒ the press already ended without an up
    map.emit("pointermove", { coordinate: [0, 0], pixel: [5, 5], originalEvent: { buttons: 0 } });
    expect(events.some((e) => e.type === "up")).toBe(true); // synthetic up emitted
    expect(events.at(-1)).toMatchObject({ type: "move", hit: { overlay: "area" } }); // hovering resumed
  });
});

describe("OpenLayersAdapter — onBlur", () => {
  it("fires the onBlur callback when the window loses focus", async () => {
    const map = new FakeOlMap();
    const adapter = new OpenLayersAdapter({ map: map as never, layers: LAYERS });
    await adapter.ready();
    let blurred = 0;
    adapter.onBlur(() => blurred++);
    window.dispatchEvent(new Event("blur"));
    expect(blurred).toBe(1);
    adapter.destroy();
  });
});

describe("OpenLayersAdapter — camera + overlay + contextmenu (0.3.0)", () => {
  it("getBounds/getZoom/getContainer + fitBounds + setOverlayVisible", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(adapter.getBounds()).toHaveLength(4);
    expect(adapter.getZoom()).toBe(6);
    expect(adapter.getContainer()).toBeTruthy();
    adapter.fitBounds([1, 2, 3, 4]); // no throw (fake view.fit)
    adapter.setOverlayVisible("area", false);
    expect(map.added[0]!.getVisible()).toBe(false);
  });

  it("right-click emits a contextmenu event (browser menu suppressed)", async () => {
    const { map, adapter } = build(new Set(["area"]));
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    map.hits = [{ feature: { getProperties: () => ({ featureId: "f", geometry: {} }) }, layer: map.added[0]! }];
    let prevented = false;
    map.viewportListeners.find((l) => l.ev === "contextmenu")!.fn({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(events.some((e) => e.type === "contextmenu" && e.hit?.overlay === "area")).toBe(true);
  });
});

describe("OpenLayersAdapter — onViewChange single-slot (no listener leak on re-call)", () => {
  it("re-calling onViewChange drops the previous handler (only the latest fires)", () => {
    const { map, adapter } = build();
    const cb1 = vi.fn(), cb2 = vi.fn();
    adapter.onViewChange(cb1);
    adapter.onViewChange(cb2); // must unByKey cb1's key before registering cb2
    map.emit("moveend", {});
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
    expect(map.handlers.get("moveend")).toHaveLength(1); // no leaked listener
  });
});

describe("OpenLayersAdapter — setActiveTool (consumer-driven highlight)", () => {
  it("highlights the bar button by id and clears with null", () => {
    const { adapter } = build();
    const bar = adapter.addToolbar([{ id: "cb", title: "CB", svg: "<svg/>", onClick: vi.fn() }], { lock: false, snapshot: "none" });
    const cb = bar.querySelector('button[data-tool="cb"]') as HTMLElement;
    adapter.setActiveTool("cb");
    expect(cb.classList.contains("active")).toBe(true);
    expect(cb.style.background).toBe("rgb(219, 234, 254)"); // #dbeafe
    adapter.setActiveTool(null);
    expect(bar.querySelector("button.active")).toBeNull();
  });
});

describe("OpenLayersAdapter — setProjection / viewArea / highlightArea", () => {
  const FC = {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [10, 20] }, properties: { role: "v0" } }],
  };

  it("setProjection({proj4}) rebuilds the view onto the registered CRS + re-reads overlays", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    adapter.setOverlay("handles", FC);
    expect(map.getView().getProjection().getCode()).toBe("EPSG:3857"); // starts Mercator
    adapter.setProjection({ kind: "proj4", code: "EPSG:3995", def: "+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs" });
    // First proj4 use loads the optional peer asynchronously — poll until the swap lands.
    await vi.waitFor(() => expect(map.getView().getProjection().getCode()).toBe("EPSG:3995"));
    // Overlay was re-read into the new projection (a feature is present in the source).
    expect(map.added.length).toBeGreaterThan(0);
  });

  it("setProjection('mercator') is a no-op when already Mercator (no view swap)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const before = map.getView();
    adapter.setProjection("mercator");
    expect(map.getView()).toBe(before); // same View instance — not rebuilt
  });

  it("viewArea fits the densified, projected extent (no throw, dateline-aware)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const fit = vi.spyOn(map.getView(), "fit");
    adapter.viewArea([110, -10, -110, 72], { padding: 20 }); // area M (antimeridian)
    expect(fit).toHaveBeenCalledOnce();
    const ext = fit.mock.calls[0]![0] as number[];
    expect(ext).toHaveLength(4);
    expect(ext[2]!).toBeGreaterThan(ext[0]!); // a real, non-empty extent
  });

  it("highlightArea adds a non-hittable frame layer below the overlays; null clears it", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const overlayCount = map.added.length;
    adapter.highlightArea([-90, 0, 30, 90], { color: "#f00", dash: [4, 4] });
    expect(map.added.length).toBe(overlayCount + 1);
    const hl = map.added[0]!; // inserted before the first drawing overlay
    expect(hl.getSource()!.getFeatures().length).toBe(1);
    adapter.highlightArea(null);
    expect(hl.getSource()!.getFeatures().length).toBe(0); // cleared, layer kept
  });
});
