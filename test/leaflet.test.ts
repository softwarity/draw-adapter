// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";

import { LeafletAdapter } from "../src/leaflet.js";
import type { LayerSpec } from "../src/index.js";

const LAYERS: LayerSpec[] = [
  { id: "area", kind: "fill" },
  { id: "guide", kind: "line" },
  { id: "handles", kind: "circle" },
  { id: "label", kind: "text" },
];

function sizedContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  for (const [k, v] of [["clientWidth", 800], ["clientHeight", 600], ["offsetWidth", 800], ["offsetHeight", 600]] as const) {
    Object.defineProperty(el, k, { value: v, configurable: true });
  }
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
  return el;
}

const handlesFC = {
  type: "FeatureCollection" as const,
  features: [
    { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [10, 10] }, properties: { role: "v0", fill: "#fff", stroke: "#58a6ff", radius: 7, strokeWidth: 2 } },
    { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [11, 11] }, properties: { role: "move", move: true, fill: "#fff", stroke: "#58a6ff", radius: 5, strokeWidth: 2, icon: "data:image/svg+xml,%3Csvg/%3E" } },
  ],
};

describe("LeafletAdapter", () => {
  let map: L.Map;
  let el: HTMLElement;

  beforeEach(() => {
    el = sizedContainer();
    map = L.map(el, { center: [10, 10], zoom: 4, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
  });
  afterEach(() => {
    try { map.remove(); } catch { /* ignore */ }
    document.body.innerHTML = "";
  });

  it("creates one z-ordered pane per layer (bottom → top)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const z = (id: string) => Number(map.getPane(`dap-${id}`)!.style.zIndex);
    expect(z("area")).toBeLessThan(z("guide"));
    expect(z("guide")).toBeLessThan(z("handles"));
    expect(z("handles")).toBeLessThan(z("label"));
    a.destroy();
  });

  it("renders handle features into the handles pane (the regression: handles must be visible)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    a.setOverlay("handles", handlesFC);
    const pane = el.querySelector(".leaflet-dap-handles-pane")!;
    expect(pane).not.toBeNull();
    // circleMarkers render as <path>; the move handle adds a divIcon marker.
    expect(pane.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
    expect(pane.querySelectorAll(".leaflet-marker-icon").length).toBeGreaterThanOrEqual(1);
    a.destroy();
  });

  it("clears the overlay on an empty FeatureCollection", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.setOverlay("handles", handlesFC);
    a.setOverlay("handles", { type: "FeatureCollection", features: [] });
    const pane = el.querySelector(".leaflet-dap-handles-pane")!;
    expect(pane.querySelectorAll("path")).toHaveLength(0);
    a.destroy();
  });

  it("renders a visible toolbar above the panes (z-index lifted, buttons present)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([
      { id: "circle", title: "Circle", onClick: vi.fn() },
      { id: "polygon", title: "Polygon", onClick: vi.fn() },
    ], { snapshot: "none", lock: false });
    expect(Number(bar.style.zIndex)).toBeGreaterThanOrEqual(1000);
    expect(bar.querySelector('button[data-tool="circle"]')).not.toBeNull();
    expect(bar.querySelector('button[data-tool="polygon"]')).not.toBeNull();
    expect(bar.classList.contains("draw-adapter-leaflet-toolbar")).toBe(true);
    expect(el.contains(bar)).toBe(true);
    a.destroy();
  });

  it("glyph handles (move/transform/resize) propagate hover → hit (featureGroup, not layerGroup)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    let moveHit: { overlay: string; props: Record<string, unknown> } | undefined;
    a.onPointer((e) => { if (e.type === "move") moveHit = e.hit; });
    a.setOverlay("handles", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [11, 11] }, properties: { role: "size", transform: true, move: true, icon: "data:image/svg+xml,%3Csvg/%3E", radius: 0 } },
      ],
    });
    const markerEl = el.querySelector(".leaflet-dap-handles-pane .leaflet-marker-icon") as HTMLElement | null;
    expect(markerEl).not.toBeNull();
    // Hover the glyph: a layerGroup would swallow this; a featureGroup forwards it.
    markerEl!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: L.point(0, 0), containerPoint: L.point(0, 0), originalEvent: new MouseEvent("mousemove") });
    expect(moveHit?.overlay).toBe("handles");
    expect(moveHit?.props["role"]).toBe("size");
    a.destroy();
  });

  it("a draggable press is captured on MOUSEDOWN (Leaflet's pan trigger), emitting down+hit", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    const downs: Array<string | undefined> = [];
    let stopped = false;
    a.onPointer((e) => { if (e.type === "down") downs.push(e.hit?.props["role"] as string | undefined); });
    a.setOverlay("handles", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [11, 11] }, properties: { role: "size", transform: true, icon: "data:image/svg+xml,%3Csvg/%3E", radius: 0 } }],
    });
    const markerEl = el.querySelector(".leaflet-dap-handles-pane .leaflet-marker-icon") as HTMLElement;
    markerEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    down.stopPropagation = () => { stopped = true; };
    el.dispatchEvent(down); // capture-phase listener on the container runs
    expect(downs).toContain("size");
    expect(stopped).toBe(true); // pan suppressed for the draggable hit
    a.destroy();
  });

  it("emits a dblclick from two quick mousedowns on a hovered hit (manual detection — handle markers are recreated, so no native dblclick fires)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    const dbls: Array<string | undefined> = [];
    a.onPointer((e) => { if (e.type === "dblclick") dbls.push(e.hit?.props["role"] as string | undefined); });
    a.setOverlay("handles", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [11, 11] }, properties: { role: "v1", icon: "data:image/svg+xml,%3Csvg/%3E", radius: 0 } }],
    });
    const markerEl = el.querySelector(".leaflet-dap-handles-pane .leaflet-marker-icon") as HTMLElement;
    markerEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); // → this.hovered = the handle
    const at: MouseEventInit = { bubbles: true, cancelable: true, clientX: 100, clientY: 100 };
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 1st press
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 2nd press, same spot + immediate → double-click
    expect(dbls).toEqual(["v1"]); // exactly one dblclick, carrying the hovered handle
    a.destroy();
  });

  it("lock button (default) freezes navigation; lock wins over the controller's pan toggle", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }]); // lock added by default
    const lockBtn = bar.querySelector<HTMLButtonElement>('button[data-tool="lock"]')!;
    expect(lockBtn).not.toBeNull();
    expect(map.dragging.enabled()).toBe(true);

    lockBtn.click(); // lock
    expect(map.dragging.enabled()).toBe(false);
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    expect(lockBtn.classList.contains("active")).toBe(true);

    a.setPanEnabled(true); // controller asks for pan mid-lock → ignored (lock wins)
    expect(map.dragging.enabled()).toBe(false);

    lockBtn.click(); // unlock → restores pan (the remembered request) + zoom
    expect(map.dragging.enabled()).toBe(true);
    expect(map.scrollWheelZoom.enabled()).toBe(true);
    expect(lockBtn.classList.contains("active")).toBe(false);
    a.destroy();
  });

  it("omits the lock button when lock:false", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }], { lock: false });
    expect(bar.querySelector('button[data-tool="lock"]')).toBeNull();
    a.destroy();
  });

  it("onKey forwards keydown from the focused map container; destroy detaches it", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const keys: Array<{ key: string; meta: boolean }> = [];
    a.onKey((e) => keys.push({ key: e.key, meta: e.meta }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true }));
    expect(keys).toEqual([{ key: "Backspace", meta: true }]);
    a.destroy();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(keys).toHaveLength(1); // nothing after destroy
  });

  it("does NOT treat two FAR-APART mousedowns as a double-click", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    let dbls = 0;
    a.onPointer((e) => { if (e.type === "dblclick") dbls++; });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    expect(dbls).toBe(0); // different positions → two single presses, not a dbl
    a.destroy();
  });

  it("shows the move/grab cursor over a handle (panes inherit the container cursor)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    a.onPointer(() => {});
    a.setOverlay("handles", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [11, 11] }, properties: { role: "center", move: true, icon: "data:image/svg+xml,%3Csvg/%3E" } }],
    });
    const markerEl = el.querySelector(".leaflet-dap-handles-pane .leaflet-marker-icon") as HTMLElement;
    markerEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: L.point(0, 0), containerPoint: L.point(0, 0), originalEvent: new MouseEvent("mousemove") });
    expect(map.getContainer().style.cursor).toBe("move");
    // The inherit rule is injected so the handle element doesn't override it.
    expect(document.getElementById("draw-adapter-leaflet-pane-style")).not.toBeNull();
    a.destroy();
  });

  it("reports pointer events with the hovered hit + lon/lat", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    const events: string[] = [];
    a.onPointer((e) => events.push(`${e.type}:${e.hit?.overlay ?? "-"}`));
    map.fire("click", { latlng: L.latLng(12, 13) });
    expect(events.some((e) => e.startsWith("click:"))).toBe(true);
    a.destroy();
  });

  it("destroy() removes panes and re-enables dragging + double-click zoom", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.setPanEnabled(false);
    a.setDoubleClickZoom(false);
    expect(map.dragging.enabled()).toBe(false);
    a.destroy();
    // The pane DOM is detached (Leaflet keeps the name in its registry, but the
    // element is gone from the document — a re-created adapter overwrites it).
    expect(map.getPane("dap-handles")?.isConnected ?? false).toBe(false);
    expect(map.dragging.enabled()).toBe(true);
    expect(map.doubleClickZoom.enabled()).toBe(true);
  });

  it("wraps the label via CSS at maxWidth (width:max-content + max-width, no canvas maths)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.setOverlay("label", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { text: "EMBD TS FCST", textColor: "#fff", textHalo: "#000", textSize: 13, maxWidth: 180 } }],
    });
    const labelEl = el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement;
    expect(labelEl).not.toBeNull();
    expect(labelEl.innerHTML).toContain("max-width:180px");
    expect(labelEl.innerHTML).toContain("width:max-content");
    expect(labelEl.innerHTML).toContain("white-space:pre-line"); // honour the content's \n line breaks
    expect(labelEl.textContent).toBe("EMBD TS FCST");
    a.destroy();
  });

  it("label box: padding (textBoxSize) + border-radius (textBoxRadius), only when bg/border", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.setOverlay("label", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { text: "X", textBackground: "#fff", textBoxSize: "large", textBoxRadius: "round" } }],
    });
    const boxed = (el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement).innerHTML;
    expect(boxed).toContain("padding:10px 13px");
    expect(boxed).toContain("border-radius:14px");
    // no bg/border ⇒ no box (no padding/background)
    a.setOverlay("label", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { text: "X", textBoxSize: "large" } }],
    });
    const plain = (el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement).innerHTML;
    expect(plain).not.toContain("padding:");
    expect(plain).not.toContain("background:");
    a.destroy();
  });

  it("project/unproject round-trip a point", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const px = a.project({ lat: 10, lon: 10 });
    expect(px).not.toBeNull();
    const back = a.unproject(px!);
    // jsdom has no real layout, so pixels round coarsely — a loose round-trip is
    // enough to prove project/unproject are inverses and wired to the map.
    expect(back!.lat).toBeCloseTo(10, 1);
    expect(back!.lon).toBeCloseTo(10, 1);
    a.destroy();
  });
});
