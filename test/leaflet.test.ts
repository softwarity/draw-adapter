// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";

import { LeafletAdapter } from "../src/leaflet.js";
import type { LayerSpec, PointerEvent } from "../src/index.js";

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

  it("glyph handles (move/transform/resize) are hit geometrically (featureGroup child measured)", async () => {
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
    // Pointer at the glyph's projected pixel: hitAt descends into the featureGroup and reports the child.
    const at = map.latLngToContainerPoint([11, 11]);
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: at, containerPoint: at, originalEvent: new MouseEvent("mousemove") });
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
    const at = map.latLngToContainerPoint([11, 11]);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
    down.stopPropagation = () => { stopped = true; };
    el.dispatchEvent(down); // capture-phase listener on the container runs; hit resolved geometrically
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
    const p = map.latLngToContainerPoint([11, 11]);
    const at: MouseEventInit = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y };
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 1st press (hit resolved geometrically)
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 2nd press, same spot + immediate → double-click
    expect(dbls).toEqual(["v1"]); // exactly one dblclick, carrying the geometric handle hit
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

  it("stops propagation on a double-click over a feature (Leaflet's preventOutline can't crash on a re-rendered target)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["guide"]) });
    await a.ready();
    a.onPointer(() => {});
    a.setOverlay("guide", { // a plain line: hittable but NOT draggable (no `role`)
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[9, 10], [11, 10]] }, properties: { stroke: "#333", strokeWidth: 2 } }],
    });
    const at = map.latLngToContainerPoint([10, 10]); // right on the line
    const mkDown = (): MouseEvent => new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
    el.dispatchEvent(mkDown()); // 1st press
    const second = mkDown();
    let stopped = false;
    second.stopPropagation = () => { stopped = true; };
    el.dispatchEvent(second); // 2nd quick press, same spot ⇒ dblclick over the (non-draggable) line
    expect(stopped).toBe(true); // propagation halted even though the hit isn't draggable
    a.destroy();
  });

  it("does NOT stop propagation on a double-click over empty map (native dbl-click zoom preserved)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.onPointer(() => {});
    const at = map.latLngToContainerPoint([10, 10]); // nothing drawn ⇒ no hit
    const mkDown = (): MouseEvent => new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
    el.dispatchEvent(mkDown());
    const second = mkDown();
    let stopped = false;
    second.stopPropagation = () => { stopped = true; };
    el.dispatchEvent(second);
    expect(stopped).toBe(false); // no hit ⇒ Leaflet keeps the event ⇒ its own dbl-click zoom still fires
    a.destroy();
  });

  it("swallows the stray Leaflet click that trails a double-click (no post-draw deselect)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const types: string[] = [];
    a.onPointer((e) => types.push(e.type));
    const p = map.latLngToContainerPoint([10, 10]);
    const at: MouseEventInit = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y };
    const fireClick = (): boolean => map.fire("click", { latlng: L.latLng(10, 10), originalEvent: new MouseEvent("click") }) && true;
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 1st press ⇒ down
    fireClick();                                       // Leaflet's click for the 1st press — legitimate
    el.dispatchEvent(new MouseEvent("mousedown", at)); // 2nd quick press, same spot ⇒ dblclick
    fireClick();                                       // Leaflet's STRAY click for the 2nd press
    // dblclick is emitted, but the trailing click after it is swallowed (would otherwise deselect)
    expect(types).toEqual(["down", "click", "dblclick"]);
    // one-shot: a later, unrelated press clicks normally again
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: p.x + 80, clientY: p.y + 80 }));
    fireClick();
    expect(types.filter((t) => t === "click")).toHaveLength(2);
    a.destroy();
  });

  it("does not emit a click after a drag gesture (parity with MapLibre/OL !moved guard)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const types: string[] = [];
    a.onPointer((e) => types.push(e.type));
    const p = map.latLngToContainerPoint([10, 10]);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: p.x, clientY: p.y })); // down
    // drag: a held-button move well past the 3px threshold (a shape drawn by dragging). Drag moves are
    // tracked on `document` now (robust to fast moves / markers swallowing Leaflet's map mousemove).
    const far = L.point(p.x + 40, p.y + 40);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: p.x + 40, clientY: p.y + 40, buttons: 1 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: p.x + 40, clientY: p.y + 40 })); // press ends
    map.fire("click", { latlng: map.containerPointToLatLng(far), originalEvent: new MouseEvent("click") }); // Leaflet's native post-drag click
    expect(types).toContain("down");
    expect(types).toContain("move");
    expect(types.filter((t) => t === "click")).toHaveLength(0); // drag ⇒ trailing click swallowed ⇒ no post-draw deselect
    // a later stationary press still clicks (select/deselect intact). Far from the drag spot so it
    // isn't read as a double-click (different position).
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: p.x + 200, clientY: p.y + 200 }));
    map.fire("click", { latlng: L.latLng(10, 10), originalEvent: new MouseEvent("click") });
    expect(types.filter((t) => t === "click")).toHaveLength(1);
    a.destroy();
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
    const at = map.latLngToContainerPoint([11, 11]);
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: at, containerPoint: at, originalEvent: new MouseEvent("mousemove") });
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

  it("atomic press: a click reuses the down hit, surviving a setOverlay re-render (no prior hover)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    a.setOverlay("handles", handlesFC);
    let clickHit: PointerEvent["hit"];
    a.onPointer((e) => { if (e.type === "click") clickHit = e.hit; });
    const at = map.latLngToContainerPoint([10, 10]); // the v0 handle (radius 7)
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: at.x, clientY: at.y })); // pressHit captured geometrically
    a.setOverlay("handles", handlesFC); // re-render recreates the DOM — would have stranded a cached hover
    map.fire("click", { latlng: L.latLng(10, 10), originalEvent: new MouseEvent("click") });
    expect(clickHit?.overlay).toBe("handles"); // from the down hit ⇒ no spurious deselect
    a.destroy();
  });

  // ── Geometric hit-test (hitAt): pixel tolerance, z-order, hitOverlays ─────────
  it("hitAt: a click within ~5px of a thin polyline selects it; beyond ~5px misses", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    let hit: PointerEvent["hit"];
    a.onPointer((e) => { if (e.type === "move") hit = e.hit; });
    a.setOverlay("guide", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[9, 10], [11, 10]] }, properties: { stroke: "#333", strokeWidth: 2 } }],
    });
    const probe = (p: L.Point): PointerEvent["hit"] => {
      hit = undefined;
      map.fire("mousemove", { latlng: map.containerPointToLatLng(p), layerPoint: p, containerPoint: p, originalEvent: new MouseEvent("mousemove") });
      return hit;
    };
    const mid = map.latLngToContainerPoint([10, 10]); // exactly on the (horizontal) line
    expect(probe(L.point(mid.x, mid.y + 4))?.overlay).toBe("guide"); // 4px off ⇒ within tolerance
    expect(probe(L.point(mid.x, mid.y + 8))).toBeUndefined();        // 8px off ⇒ beyond tolerance
    a.destroy();
  });

  it("hitAt: the topmost overlay (highest manifest z) wins among overlapping candidates", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    let hit: PointerEvent["hit"];
    a.onPointer((e) => { if (e.type === "move") hit = e.hit; });
    a.setOverlay("guide", { // z-index lower (declared before handles)
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[9, 10], [11, 10]] }, properties: { stroke: "#333", strokeWidth: 2 } }],
    });
    a.setOverlay("handles", { // z-index higher
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { role: "v0", radius: 7, stroke: "#58a6ff", strokeWidth: 2 } }],
    });
    const at = map.latLngToContainerPoint([10, 10]); // both the line and the handle pass here
    map.fire("mousemove", { latlng: L.latLng(10, 10), layerPoint: at, containerPoint: at, originalEvent: new MouseEvent("mousemove") });
    expect(hit?.overlay).toBe("handles"); // higher z beats the line beneath
    a.destroy();
  });

  it("hitAt: an overlay excluded by hitOverlays is pass-through (not hit-tested)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) }); // guide NOT hittable
    await a.ready();
    let hit: PointerEvent["hit"] = { overlay: "sentinel", props: {} };
    a.onPointer((e) => { if (e.type === "move") hit = e.hit; });
    a.setOverlay("guide", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[9, 10], [11, 10]] }, properties: { stroke: "#333", strokeWidth: 2 } }],
    });
    const at = map.latLngToContainerPoint([10, 10]); // right on the (excluded) line
    map.fire("mousemove", { latlng: L.latLng(10, 10), layerPoint: at, containerPoint: at, originalEvent: new MouseEvent("mousemove") });
    expect(hit).toBeUndefined(); // guide opted out ⇒ no hit even though geometrically under the pointer
    a.destroy();
  });

  it("hitAt: a polygon is hit inside its area; a circle handle within radius+tolerance", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    let hit: PointerEvent["hit"];
    a.onPointer((e) => { if (e.type === "move") hit = e.hit; });
    const probe = (p: L.Point): PointerEvent["hit"] => {
      hit = undefined;
      map.fire("mousemove", { latlng: map.containerPointToLatLng(p), layerPoint: p, containerPoint: p, originalEvent: new MouseEvent("mousemove") });
      return hit;
    };
    a.setOverlay("area", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[6, 6], [14, 6], [14, 14], [6, 14], [6, 6]]] }, properties: { fillColor: "#888", fillOpacity: 0.2 } }],
    });
    expect(probe(map.latLngToContainerPoint([10, 10]))?.overlay).toBe("area"); // inside the filled area
    const topEdge = map.latLngToContainerPoint([14, 10]);
    expect(probe(L.point(topEdge.x, topEdge.y - 20))).toBeUndefined();          // 20px above the edge ⇒ outside

    a.setOverlay("handles", {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { role: "v0", radius: 7, stroke: "#58a6ff", strokeWidth: 2 } }],
    });
    const c = map.latLngToContainerPoint([10, 10]);
    expect(probe(L.point(c.x + 10, c.y))?.overlay).toBe("handles"); // 10px from centre, radius 7 ⇒ 3px surface ≤ tol
    expect(probe(L.point(c.x + 15, c.y))?.overlay).toBe("area");    // 15px ⇒ 8px surface > tol ⇒ falls through to the polygon
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

  it("label box: border width is a preset (textBorderWidth), default ~1.4px", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const labelHtml = (props: Record<string, unknown>): string => {
      a.setOverlay("label", { type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { text: "X", textBorder: "#111", ...props } }] });
      return (el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement).innerHTML;
    };
    expect(labelHtml({})).toContain("border:1.4px solid");            // default ⇒ medium ⇒ 1.4px (no regression)
    expect(labelHtml({ textBorderWidth: "small" })).toContain("border:0.8px solid");
    expect(labelHtml({ textBorderWidth: "large" })).toContain("border:2.2px solid");
    a.destroy();
  });

  it("onViewChange is single-slot — re-calling drops the previous handler (no leak)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const cb1 = vi.fn(), cb2 = vi.fn();
    a.onViewChange(cb1);
    a.onViewChange(cb2); // must `off` cb1 before registering cb2
    map.fire("moveend");
    expect(cb1).not.toHaveBeenCalled(); // the old handler was removed
    expect(cb2).toHaveBeenCalledOnce();
    a.destroy();
  });

  it("forwards the live modifier state on the pointer event (read off originalEvent), default false", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const events: PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    const pt = L.point(0, 0);
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: pt, containerPoint: pt, originalEvent: new MouseEvent("mousemove", { ctrlKey: true }) });
    map.fire("mousemove", { latlng: L.latLng(11, 11), layerPoint: pt, containerPoint: pt, originalEvent: new MouseEvent("mousemove") });
    expect(events[0]).toMatchObject({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
    expect(events[1]).toMatchObject({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
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

describe("LeafletAdapter — marker widgets", () => {
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

  it("mounts an anchored card (divIcon shell) with the card DOM injected", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    a.setWidgets([{ id: "v1", anchor: { lon: 10, lat: 10 }, border: "#111",
      child: { dir: "v", items: [
        { kind: "glyph", svg: "<svg></svg>" },
        { kind: "text", value: "NN", editable: true, control: "input" },
        { kind: "coord" },
      ] } }]);
    const card = el.querySelector(".draw-adapter-widget .draw-adapter-widget-card") as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.querySelector("input")).not.toBeNull();
    a.destroy();
    expect(el.querySelector(".draw-adapter-widget")).toBeNull(); // torn down
  });

  it("routes a card tap to onPointer as a widget hit; the container mousedown guard ignores it", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const events: PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    a.setWidgets([{ id: "v1", anchor: { lon: 10, lat: 10 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] } }]);
    const card = el.querySelector(".draw-adapter-widget .draw-adapter-widget-card") as HTMLElement;
    // a real container mousedown originating on the card must NOT produce a map "down"
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(events).toHaveLength(0);
    // the card's own pointer handler emits the widget hit (tap = down → up → click)
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    card.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(events.some((e) => e.hit?.overlay === "widget")).toBe(true);
    a.destroy();
  });

  it("fires onWidgetEdit per keystroke", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const edits: { id: string; value: string }[] = [];
    a.onWidgetEdit((e) => edits.push(e));
    a.setWidgets([{ id: "v1", anchor: { lon: 10, lat: 10 },
      child: { dir: "h", items: [{ kind: "text", value: "", editable: true }] } }]);
    const input = el.querySelector(".draw-adapter-widget input") as HTMLInputElement;
    input.value = "Z";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edits).toEqual([{ id: "v1", value: "Z" }]);
    a.destroy();
  });

  it("a DOM click on the card does NOT fire a no-hit map click (no select→deselect)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const events: PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    a.setWidgets([{ id: "v1", anchor: { lon: 10, lat: 10 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] } }]);
    const card = el.querySelector(".draw-adapter-widget .draw-adapter-widget-card") as HTMLElement;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(events.filter((e) => e.type === "click")).toHaveLength(0); // Leaflet's map click is suppressed
    a.destroy();
  });
});

describe("LeafletAdapter — camera + overlay + contextmenu (0.3.0)", () => {
  let map: L.Map;
  let el: HTMLElement;
  beforeEach(() => {
    el = sizedContainer();
    map = L.map(el, { center: [10, 10], zoom: 4, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
  });
  afterEach(() => { try { map.remove(); } catch { /* ignore */ } document.body.innerHTML = ""; });

  it("getBounds/getZoom/getContainer + fitBounds + setOverlayVisible (pane toggle)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    expect(a.getBounds()).toHaveLength(4);
    expect(a.getZoom()).toBe(4);
    expect(a.getContainer()).toBe(el);
    a.fitBounds([5, 40, 10, 45]); // no throw
    a.setOverlayVisible("handles", false);
    expect(map.getPane("dap-handles")!.style.display).toBe("none");
    a.setOverlayVisible("handles", true);
    expect(map.getPane("dap-handles")!.style.display).toBe("");
    a.destroy();
  });

  it("right-click fires a contextmenu event", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const events: PointerEvent[] = [];
    a.onPointer((e) => events.push(e));
    map.fire("contextmenu", { latlng: L.latLng(10, 10), originalEvent: new MouseEvent("contextmenu") });
    expect(events.some((e) => e.type === "contextmenu")).toBe(true);
    a.destroy();
  });
});

describe("LeafletAdapter — text label hit (call-out is clickable when hittable)", () => {
  let map: L.Map;
  let el: HTMLElement;
  beforeEach(() => {
    el = sizedContainer();
    map = L.map(el, { center: [10, 10], zoom: 4, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
  });
  afterEach(() => { try { map.remove(); } catch { /* ignore */ } document.body.innerHTML = ""; });

  const labelFC = {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [10, 10] },
      properties: { featureId: "cb1", text: "CB", textBackground: "#fff", textBorder: "#111" } }],
  };

  it("a hittable text overlay ⇒ interactive label; pointing at it surfaces the feature hit", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["label"]) });
    await a.ready();
    a.setOverlay("label", labelFC);
    const labelEl = el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement;
    expect(labelEl).not.toBeNull();
    expect(labelEl.classList.contains("leaflet-interactive")).toBe(true);
    let moveHit: PointerEvent["hit"];
    a.onPointer((e) => { if (e.type === "move") moveHit = e.hit; });
    const at = map.latLngToContainerPoint([10, 10]); // the label's anchor pixel
    map.fire("mousemove", { latlng: L.latLng(10, 10), layerPoint: at, containerPoint: at, originalEvent: new MouseEvent("mousemove") });
    expect(moveHit?.overlay).toBe("label");
    expect(moveHit?.props["featureId"]).toBe("cb1");
    a.destroy();
  });

  it("a text overlay NOT in hitOverlays stays non-interactive (pass-through)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles"]) });
    await a.ready();
    a.setOverlay("label", labelFC);
    const labelEl = el.querySelector(".leaflet-dap-label-pane .leaflet-marker-icon") as HTMLElement;
    expect(labelEl.classList.contains("leaflet-interactive")).toBe(false);
    a.destroy();
  });
});

describe("LeafletAdapter — setActiveTool (consumer-driven highlight)", () => {
  let map: L.Map; let el: HTMLElement;
  beforeEach(() => { el = sizedContainer(); map = L.map(el, { center: [10, 10], zoom: 4 }); });
  afterEach(() => { try { map.remove(); } catch { /* ignore */ } document.body.innerHTML = ""; });

  it("highlights the bar button by id and clears with null", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "cb", title: "CB", svg: "<svg/>", onClick: () => {} }], { lock: false, snapshot: "none" });
    const cb = bar.querySelector('button[data-tool="cb"]') as HTMLElement;
    a.setActiveTool("cb");
    expect(cb.classList.contains("active")).toBe(true);
    expect(cb.style.background).toBe("rgb(219, 234, 254)"); // #dbeafe
    a.setActiveTool(null);
    expect(bar.querySelector("button.active")).toBeNull();
    a.destroy();
  });
});

describe("LeafletAdapter — setProjection / viewArea / highlightArea", () => {
  let map: L.Map; let el: HTMLElement;
  beforeEach(() => { el = sizedContainer(); map = L.map(el, { center: [10, 10], zoom: 4 }); });
  afterEach(() => { try { map.remove(); } catch { /* ignore */ } document.body.innerHTML = ""; });

  it("setProjection: 'mercator' is silent; a non-mercator spec warns once", () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    a.setProjection("mercator");
    expect(warn).not.toHaveBeenCalled();
    a.setProjection({ kind: "proj4", code: "EPSG:3995", def: "+proj=stere" });
    a.setProjection({ kind: "proj4", code: "EPSG:3995", def: "+proj=stere" });
    expect(warn).toHaveBeenCalledTimes(1); // warn-once
    warn.mockRestore();
    a.destroy();
  });

  it("viewArea unwraps an antimeridian bbox into one [[s,w],[n,e]] span", () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    const fit = vi.spyOn(map, "fitBounds");
    a.viewArea([110, -10, -110, 72], { padding: 16 }); // area M
    expect(fit).toHaveBeenCalledOnce();
    const [bounds] = fit.mock.calls[0]!;
    expect(bounds).toEqual([[-10, 110], [72, 250]]); // [[s,w],[n,e]] with east −110 → 250
    a.destroy();
  });

  it("highlightArea draws a non-interactive frame in a dedicated pane; null clears it", () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    a.highlightArea([-90, 0, 30, 90], { color: "#f00", width: 2 });
    const pane = map.getPane("dap-highlight")!;
    expect(pane.style.zIndex).toBe("350");
    expect(pane.style.pointerEvents).toBe("none");
    expect(pane.querySelector("path")).toBeTruthy(); // the polygon rendered
    a.highlightArea(null);
    expect(pane.querySelector("path")).toBeFalsy(); // removed
    a.destroy();
  });
});
