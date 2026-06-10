// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MapLibreAdapter } from "../src/maplibre.js";
import type { LayerSpec, PointerEvent } from "../src/index.js";

// jsdom never fires `Image.onload`, so `loadSpriteImage` (used by registerSymbols)
// would hang. Stub a synchronous-ish image that resolves on `src` assignment.
class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(_w?: number, _h?: number) {}
  set src(_v: string) { queueMicrotask(() => this.onload?.()); }
}
beforeAll(() => vi.stubGlobal("Image", FakeImage));
afterAll(() => vi.unstubAllGlobals());

const LAYERS: LayerSpec[] = [
  { id: "area", kind: "fill" },
  { id: "guide", kind: "line" },
  { id: "symbols", kind: "symbol" },
  { id: "label", kind: "text" },
  { id: "handles", kind: "circle" },
];

interface MlLayer { id: string; type: string; source: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }

/** A record-only stand-in for `maplibregl.Map` — no WebGL, just captures what the
 *  adapter builds so we can assert the data-driven contract. */
class FakeMlMap {
  sources = new Map<string, { data: unknown }>();
  layers: MlLayer[] = [];
  images = new Set<string>();
  paint: Record<string, Record<string, unknown>> = {};
  handlers = new Map<string, ((e: unknown) => void)[]>();
  queryResult: { layer: { id: string }; properties: Record<string, unknown> }[] = [];
  dragPan = { enable: vi.fn(), disable: vi.fn() };
  doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
  private canvas = { style: {} as Record<string, string> };
  private container = document.createElement("div");

  isStyleLoaded() { return true; }
  addSource(id: string, def: { data: unknown }) { this.sources.set(id, { data: def.data }); }
  getSource(id: string) {
    const s = this.sources.get(id);
    return s ? { setData: (d: unknown) => (s.data = d) } : undefined;
  }
  addLayer(l: MlLayer) { this.layers.push(l); }
  getLayer(id: string) { return this.layers.find((l) => l.id === id); }
  removeLayer(id: string) { this.layers = this.layers.filter((l) => l.id !== id); }
  removeSource(id: string) { this.sources.delete(id); }
  setPaintProperty(id: string, k: string, v: unknown) { (this.paint[id] ??= {})[k] = v; }
  hasImage(id: string) { return this.images.has(id); }
  addImage(id: string) { this.images.add(id); }
  removeImage(id: string) { this.images.delete(id); }
  on(ev: string, fn: (e: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(fn); }
  off() {}
  once() {}
  emit(ev: string, payload: unknown) { for (const fn of this.handlers.get(ev) ?? []) fn(payload); }
  queryRenderedFeatures() { return this.queryResult; }
  project(_: [number, number]) { return { x: 1, y: 2 }; }
  unproject(_: [number, number]) { return { lat: 3, lng: 4 }; }
  getCenter() { return { lat: 10, lng: 20 }; }
  getBounds() { return { getEast: () => 30, getWest: () => 10, getNorth: () => 40, getSouth: () => 20 }; }
  triggerRepaint = vi.fn();
  getCanvas() { return this.canvas; }
  getContainer() { return this.container; }
}

function build(hitOverlays?: Set<string>) {
  const map = new FakeMlMap();
  const adapter = new MapLibreAdapter({ map: map as never, layers: LAYERS, ...(hitOverlays ? { hitOverlays } : {}) });
  return { map, adapter };
}

const layer = (m: FakeMlMap, id: string) => m.layers.find((l) => l.id === id)!;

describe("MapLibreAdapter — overlay manifest → layers", () => {
  it("creates one geojson source per overlay", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    for (const l of LAYERS) expect(map.sources.has(l.id)).toBe(true);
  });

  it("fill ⇒ a fill layer + an optional outline (`__stroke`) line layer", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(layer(map, "area").type).toBe("fill");
    const stroke = layer(map, "area__stroke");
    expect(stroke.type).toBe("line");
    expect(stroke.filter).toEqual(["has", "stroke"]);
  });

  it("line ⇒ main line (no dash) + `__dash` (has dash) + `__fill` (polygons)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(layer(map, "guide").filter).toEqual(["!", ["has", "dash"]]);
    expect(layer(map, "guide__dash").filter).toEqual(["has", "dash"]);
    expect(layer(map, "guide__fill").filter).toEqual(["==", ["geometry-type"], "Polygon"]);
  });

  it("circle ⇒ a circle layer + a `__icon` symbol layer (handle glyphs)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(layer(map, "handles").type).toBe("circle");
    expect(layer(map, "handles__icon").type).toBe("symbol");
    expect(layer(map, "handles__icon").filter).toEqual(["any", ["has", "icon"], ["has", "symbol"]]);
  });

  it("text ⇒ text-max-width is PX→EM (maxWidth / textSize), not raw px", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const mw = layer(map, "label").layout!["text-max-width"];
    expect(mw).toEqual(["/", ["coalesce", ["get", "maxWidth"], 130], ["coalesce", ["get", "textSize"], 13]]);
  });

  it("text ⇒ a per-feature label-box image (`__box|bg|border|size|radius`) that rotates with the text", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const l = layer(map, "label");
    const img = l.layout!["icon-image"] as unknown[];
    expect(img[0]).toBe("case"); // box id only when bg/border, else ""
    expect(JSON.stringify(img)).toContain("__box|"); // builds the per-combo id
    expect(l.layout!["icon-text-fit"]).toBe("both");
    expect(l.layout!["icon-text-fit-padding"]).toBeUndefined(); // padding baked in the image, not layer-wide
    expect(l.layout!["icon-rotate"]).toEqual(["coalesce", ["get", "rotation"], 0]); // box follows the text
  });

  it("materializes a label-box image on `styleimagemissing` without throwing (no canvas in jsdom ⇒ no-op)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    expect(() => map.emit("styleimagemissing", { id: "__box|#ffffff|#000000|large|round" })).not.toThrow();
  });

  it("circle paint reads radius/fill/stroke/strokeWidth from feature props", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const p = layer(map, "handles").paint!;
    expect(p["circle-radius"]).toEqual(["coalesce", ["get", "radius"], 5]);
    expect(p["circle-color"]).toEqual(["coalesce", ["get", "fill"], "#ffffff"]);
  });
});

describe("MapLibreAdapter — setOverlay & dash", () => {
  it("pushes the FeatureCollection onto the source", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const fc = { type: "FeatureCollection" as const, features: [] };
    adapter.setOverlay("area", fc);
    expect(map.sources.get("area")!.data).toBe(fc);
  });

  it("sets `line-dasharray` on the `__dash` sub-layer from a baked `dash` prop", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    adapter.setOverlay("guide", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { dash: [2, 3] } }],
    });
    expect(map.paint["guide__dash"]!["line-dasharray"]).toEqual([2, 3]);
  });
});

describe("MapLibreAdapter — hit-testing", () => {
  it("returns the first HITTABLE overlay in MapLibre's top-first order", async () => {
    const { map, adapter } = build(new Set(["handles", "area"]));
    await adapter.ready();
    let lastHit: PointerEvent["hit"];
    adapter.onPointer((e) => { if (e.type === "move") lastHit = e.hit; });
    // queryRenderedFeatures yields top-first; `label` is not hittable → skipped.
    map.queryResult = [
      { layer: { id: "label" }, properties: { text: "x" } },
      { layer: { id: "handles" }, properties: { role: "v0" } },
      { layer: { id: "area" }, properties: {} },
    ];
    map.emit("mousemove", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    expect(lastHit?.overlay).toBe("handles");
    expect(lastHit?.props["role"]).toBe("v0");
  });

  it("maps `__dash`/`__fill` sub-layers back to their overlay id", async () => {
    const { map, adapter } = build(new Set(["guide"]));
    await adapter.ready();
    let lastHit: PointerEvent["hit"];
    adapter.onPointer((e) => { if (e.type === "move") lastHit = e.hit; });
    map.queryResult = [{ layer: { id: "guide__dash" }, properties: { role: "lon" } }];
    map.emit("mousemove", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    expect(lastHit?.overlay).toBe("guide");
  });
});

describe("MapLibreAdapter — modifier keys on pointer events", () => {
  it("forwards the live modifier state (read off `originalEvent`), default false", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    map.emit("mousemove", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 }, originalEvent: { ctrlKey: true, altKey: true } });
    map.emit("mousemove", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 }, originalEvent: {} });
    expect(events[0]).toMatchObject({ ctrlKey: true, altKey: true, metaKey: false, shiftKey: false });
    expect(events[1]).toMatchObject({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  });
});

describe("MapLibreAdapter — snapshot toolbar (supported ⇒ enabled)", () => {
  const snapBtn = (bar: HTMLElement) => bar.querySelector<HTMLButtonElement>('button[data-tool="snapshot"]');

  it("adds an ENABLED snapshot button by default and triggers a repaint on click", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const bar = adapter.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }]);
    const btn = snapBtn(bar)!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.title).toMatch(/^Snapshot: click to file/); // default onClick = download; fixed tooltip
    btn.click(); // snapshot() listens for `render`, then triggers a repaint
    expect(map.triggerRepaint).toHaveBeenCalled();
    adapter.destroy();
  });

  it("omits the snapshot button when snapshot: 'none'", async () => {
    const { adapter } = build();
    await adapter.ready();
    const bar = adapter.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }], { snapshot: "none" });
    expect(snapBtn(bar)).toBeNull();
    adapter.destroy();
  });
});

describe("MapLibreAdapter — symbols & teardown", () => {
  it("registerSymbols adds a default-tinted image and tracks it", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    await adapter.registerSymbols({ MOD: "<svg>currentColor</svg>" });
    expect(map.images.has("MOD")).toBe(true);
  });

  it("destroy removes every layer, source, image and re-enables map gestures", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    await adapter.registerSymbols({ MOD: "<svg>currentColor</svg>" });
    expect(map.layers.length).toBeGreaterThan(0);
    adapter.destroy();
    expect(map.layers.length).toBe(0);
    expect(map.sources.size).toBe(0);
    expect(map.images.size).toBe(0);
    expect(map.dragPan.enable).toHaveBeenCalled();
    expect(map.doubleClickZoom.enable).toHaveBeenCalled();
  });
});

describe("MapLibreAdapter — click synthesized on release (no native-click dependency)", () => {
  it("emits a click on release (down+up at one spot)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const types: string[] = [];
    adapter.onPointer((e) => types.push(e.type));
    map.emit("mousedown", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    map.emit("mouseup", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    expect(types).toEqual(["down", "up", "click"]); // click comes from the release, not map.on("click")
  });

  it("a moved release is a drag — no click", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const types: string[] = [];
    adapter.onPointer((e) => types.push(e.type));
    map.emit("mousedown", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    map.emit("mousemove", { lngLat: { lat: 1, lng: 2 }, point: { x: 60, y: 60 }, originalEvent: { buttons: 1 } });
    map.emit("mouseup", { lngLat: { lat: 1, lng: 2 }, point: { x: 60, y: 60 } });
    expect(types).not.toContain("click");
  });
});

describe("MapLibreAdapter — touch click fallback + contextmenu (0.3.0)", () => {
  it("a native click with no prior mouseup (a touch tap) still emits a click", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const types: string[] = [];
    adapter.onPointer((e) => types.push(e.type));
    map.emit("click", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    expect(types).toContain("click");
  });

  it("the native click is deduped after a mouse release (no double click)", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const types: string[] = [];
    adapter.onPointer((e) => types.push(e.type));
    map.emit("mousedown", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } });
    map.emit("mouseup", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } }); // synthesizes the click
    map.emit("click", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 } }); // native — deduped
    expect(types.filter((t) => t === "click")).toHaveLength(1);
  });

  it("right-click emits a contextmenu event", async () => {
    const { map, adapter } = build();
    await adapter.ready();
    const events: PointerEvent[] = [];
    adapter.onPointer((e) => events.push(e));
    let prevented = false;
    map.emit("contextmenu", { lngLat: { lat: 1, lng: 2 }, point: { x: 5, y: 5 }, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(events.some((e) => e.type === "contextmenu")).toBe(true);
  });
});
