/**
 * Leaflet adapter — grafts onto a host-owned `L.Map`. Leaflet is lat/lng-native
 * (no reprojection). Reads the same feature render-props as the MapLibre /
 * OpenLayers adapters so all three render identically.
 *
 * Per-overlay z-order uses one Leaflet **pane** per {@link LayerSpec} (increasing
 * `zIndex`); rotatable handle/symbol glyphs use `L.divIcon` + a CSS
 * `transform: rotate()` (Leaflet markers don't rotate natively). Leaflet has no
 * `queryRenderedFeatures`, so hit-testing is done GEOMETRICALLY at pointer time
 * ({@link LeafletAdapter.hitAt}): each rendered feature is projected to container
 * pixels and the topmost one within a ~5px tolerance wins — parity with the MapLibre
 * (5px query box) / OpenLayers (`hitTolerance:5`) adapters, and independent of any
 * prior hover so a freshly drawn/re-rendered feature is immediately selectable.
 * The drag-vs-pan conflict is solved exactly like the
 * OpenLayers adapter: a capture-phase `pointerdown` on the container
 * `stopPropagation()`s draggable presses so Leaflet's own drag never starts a pan.
 *
 * The manifest (`layers`) and the hit-testable set (`hitOverlays`) are supplied
 * by the consumer; this adapter knows no domain type.
 */
import type { FeatureCollection, Feature } from "geojson";
import * as L from "leaflet";

import type {
  AdapterOptions,
  HighlightStyle,
  Hit,
  KeyEvent,
  LatLng,
  LayerKind,
  LngLatBounds,
  MapAdapter,
  MarkerWidget,
  PointerEvent,
  ProjectionSpec,
  SymbolSprites,
  ToolbarItem,
  ToolbarOptions,
  TooltipStyle,
  WidgetEdit,
} from "./index.js";
import { cursorForHit } from "./index.js";
import { densifyBboxRing, unwrapEast, warnOnce } from "./geo.js";
import { WidgetLayer } from "./widget.js";
import { num, str, rgba } from "./coerce.js";
import { boxPadding, boxRadius, textBoxBorderWidth } from "./textbox.js";
import { colorizeSprite } from "./symbols.js";
import { resolveAdapterOptions, type ResolvedAdapterOptions } from "./options.js";
import { populateToolbar, setToolbarActive } from "./toolbar.js";
import { snapshotToolbarItem } from "./snapshot.js";
import { lockToolbarItem } from "./lock.js";
import { bindKeyListener, refocusMap } from "./keyboard.js";
import { modifiers } from "./modifiers.js";
import { applyTooltipStyle } from "./tooltip.js";

/** Why Leaflet can't snapshot yet — shown both as the thrown error and the
 *  disabled toolbar button's tooltip. */
const LEAFLET_SNAPSHOT_UNSUPPORTED =
  "snapshot() is not supported on the Leaflet adapter yet (no native exportable " +
  "canvas: tiles are <img>, overlays are SVG/DOM). Planned via a DOM-snapshot approach.";

function isDraggableHit(hit: Hit): boolean {
  return hit.props["role"] != null;
}

/** Pixel hit-tolerance for {@link LeafletAdapter.hitAt} — same 5px as MapLibre's query box
 *  pad and OpenLayers' `hitTolerance`, so a thin 1–2px line is just as easy to grab on all three. */
const HIT_TOL = 5;

const LF_PANE_STYLE_ID = "draw-adapter-leaflet-pane-style";

/** Let our overlay panes' interactive elements show the container cursor (the one
 *  the adapter sets via setCursor), instead of Leaflet's `.leaflet-interactive`
 *  `cursor` rule. Injected once. */
function ensurePaneCursorStyle(): void {
  if (typeof document === "undefined" || document.getElementById(LF_PANE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = LF_PANE_STYLE_ID;
  style.textContent =
    ".draw-adapter-pane .leaflet-interactive," +
    ".draw-adapter-pane .leaflet-marker-icon{cursor:inherit}";
  document.head.appendChild(style);
}

const LF_TOOLBAR_STYLE_ID = "draw-adapter-leaflet-toolbar-style";

/** Give the Leaflet toolbar a visible, native-ish look. Unlike MapLibre/OpenLayers,
 *  Leaflet provides no `ctrl-group`/`ol-control` box CSS for our buttons. Injected once. */
function ensureLeafletToolbarStyle(): void {
  if (typeof document === "undefined" || document.getElementById(LF_TOOLBAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = LF_TOOLBAR_STYLE_ID;
  style.textContent =
    ".draw-adapter-leaflet-toolbar{background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.4)}" +
    ".draw-adapter-leaflet-toolbar button{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;background:#fff;cursor:pointer;padding:0}" +
    ".draw-adapter-leaflet-toolbar button:hover{background:#f4f4f4}";
  document.head.appendChild(style);
}

/** Batteries-included host map (headless hosts pass their own `map` instead). */
export function createLeafletMap(opts: { container: HTMLElement | string; center: [number, number]; zoom: number }): L.Map {
  const map = L.map(opts.container).setView([opts.center[1], opts.center[0]], opts.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  return map;
}

export class LeafletAdapter implements MapAdapter {
  /** Leaflet has no single exportable canvas (tiles are <img>, overlays SVG/DOM). */
  protected readonly snapshotSupported = false;
  private readonly map: L.Map;
  private readonly opts: ResolvedAdapterOptions;
  private readonly kindOf: Map<string, LayerKind>;
  private readonly groups = new Map<string, L.GeoJSON>();
  private readonly paneNames: string[] = [];
  private sprites: Record<string, string> = {};
  private readyPromise: Promise<void> | undefined;
  private dragging = false;
  private locked = false;
  private panOn = true;
  private dblOn = true;
  private tooltipStyle: TooltipStyle | undefined;
  private tooltipEl: HTMLElement | undefined;
  private toolbarEl: HTMLElement | undefined;
  private cb: ((ev: PointerEvent) => void) | undefined;
  private domDown: ((e: Event) => void) | undefined;
  private domUp: ((e: MouseEvent) => void) | undefined;
  private windowBlur: (() => void) | undefined;
  private blurListener: (() => void) | undefined;
  /** Hit captured at `down`, reused for that press's `click` (atomic press — see onPointer). */
  private pressHit: Hit | undefined;
  private keyCleanup: (() => void) | undefined;
  private lastDownT = 0;
  private lastDownX = 0;
  private lastDownY = 0;
  /** After a (manually-detected) double-click, Leaflet still fires a trailing `click` for that 2nd
   *  press. Unlike MapLibre/OL — where `dblclick` is the LAST event of the gesture — that stray click
   *  would land AFTER the consumer's commit→select (e.g. finishing a drawn front), carrying an empty
   *  hit and deselecting it. This flag swallows exactly that one click. */
  private suppressClick = false;
  /** Whether the pointer moved past a small threshold since the press started. Leaflet fires a native
   *  `click` after a drag (the map didn't pan, so it doesn't suppress it) — but MapLibre/OL only emit
   *  a click for a STATIONARY press (`!moved`). Without this, finishing a drag-drawn shape (the
   *  consumer commits+selects on `up`) is immediately undone by the trailing empty-hit click. */
  private moved = false;
  private viewHandler: (() => void) | undefined;
  private widgets: WidgetLayer | undefined;
  /** The non-interactive {@link highlightArea} frame + whether its dedicated pane exists. */
  private highlightPoly: L.Polygon | undefined;
  private highlightPaneReady = false;

  constructor(opts: { map: L.Map } & AdapterOptions) {
    this.map = opts.map;
    this.opts = resolveAdapterOptions(opts);
    this.kindOf = new Map(opts.layers.map((l) => [l.id, l.kind]));
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      ensurePaneCursorStyle();
      this.opts.layers.forEach((spec, i) => {
        const paneName = `dap-${spec.id}`;
        const pane = this.map.createPane(paneName);
        pane.style.zIndex = String(400 + i * 10);
        // Mark our panes so their interactive elements inherit the container
        // cursor we set (else Leaflet's `.leaflet-interactive{cursor}` wins and
        // the move/grab cursor never shows over a handle).
        pane.classList.add("draw-adapter-pane");
        this.paneNames.push(paneName);
        const group = L.geoJSON(undefined, {
          pane: paneName,
          style: (f) => this.styleFor(spec.kind, f),
          pointToLayer: (f, latlng) => this.pointLayer(spec.kind, spec.id, f, latlng, paneName),
        });
        group.addTo(this.map);
        this.groups.set(spec.id, group);
      });
      this.readyPromise = Promise.resolve();
    }
    return this.readyPromise;
  }

  registerSymbols(sprites: SymbolSprites): Promise<void> {
    for (const [id, svg] of Object.entries(sprites)) this.sprites[id] = svg;
    // Re-render symbol/circle overlays so new sprites take effect.
    for (const [id, kind] of this.kindOf) {
      if (kind !== "symbol" && kind !== "circle") continue;
      const g = this.groups.get(id);
      if (g) {
        const data = (g.toGeoJSON() as FeatureCollection);
        this.setOverlay(id, data);
      }
    }
    return Promise.resolve();
  }

  setOverlay(id: string, data: FeatureCollection): void {
    const group = this.groups.get(id);
    if (!group) return;
    // No stale-hover hazard: hits are resolved geometrically from the live layers at pointer time
    // (see hitAt), not from a cached mouseover. Recreating the DOM here can't strand a hit.
    group.clearLayers();
    if (data.features.length) group.addData(data);
  }

  setOverlayVisible(id: string, visible: boolean): void {
    const pane = this.map.getPane(`dap-${id}`);
    if (pane) pane.style.display = visible ? "" : "none";
  }

  /** Not supported yet — see {@link LEAFLET_SNAPSHOT_UNSUPPORTED}. (async ⇒ rejects.) */
  async snapshot(): Promise<Blob> {
    throw new Error(LEAFLET_SNAPSHOT_UNSUPPORTED);
  }

  setTooltip(text: string | null, at: LatLng, style?: TooltipStyle): void {
    if (style) this.tooltipStyle = style;
    if (text == null) {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
      return;
    }
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement("div");
      this.tooltipEl.className = "draw-adapter-tooltip";
      if (this.tooltipStyle) applyTooltipStyle(this.tooltipEl, this.tooltipStyle);
      this.tooltipEl.style.zIndex = "1000"; // above Leaflet panes/controls
      this.map.getContainer().appendChild(this.tooltipEl);
    } else if (style) {
      applyTooltipStyle(this.tooltipEl, style);
    }
    const p = this.map.latLngToContainerPoint([at.lat, at.lon]);
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${p.x}px`;
    this.tooltipEl.style.top = `${p.y}px`;
  }

  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement {
    if (this.toolbarEl) return this.toolbarEl;
    ensureLeafletToolbarStyle();
    const el = document.createElement("div");
    el.className = "leaflet-bar draw-adapter-toolbar draw-adapter-leaflet-toolbar";
    const snap = snapshotToolbarItem(options?.snapshot, {
      supported: this.snapshotSupported,
      reason: LEAFLET_SNAPSHOT_UNSUPPORTED,
      snapshot: () => this.snapshot(),
    });
    const lock = lockToolbarItem(options?.lock, (on) => this.setInteractive(on));
    const chrome = [snap, lock].filter((x): x is ToolbarItem => x != null);
    populateToolbar(el, [...items, ...chrome], options, () => refocusMap(this.map.getContainer()));
    // Leaflet panes climb to z-index ~700 and its controls to ~1000, so the
    // generic toolbar's z-index:3 (set by applyToolbarLayout) would hide the bar
    // UNDER the tiles. Lift it above everything Leaflet stacks.
    el.style.zIndex = "1000";
    this.map.getContainer().appendChild(el);
    // Keep map interactions from firing through the toolbar.
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    this.toolbarEl = el;
    return el;
  }

  setActiveTool(id: string | null): void {
    if (this.toolbarEl) setToolbarActive(this.toolbarEl, id);
  }

  getCenter(): LatLng {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  getViewSpan(): number {
    const b = this.map.getBounds();
    return Math.max(Math.abs(b.getEast() - b.getWest()), Math.abs(b.getNorth() - b.getSouth())) || 10;
  }

  getBounds(): LngLatBounds {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  getZoom(): number {
    return this.map.getZoom();
  }

  getContainer(): HTMLElement {
    return this.map.getContainer();
  }

  fitBounds(bbox: LngLatBounds, opts?: { padding?: number }): void {
    const p = opts?.padding ?? 0;
    this.map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [p, p] });
  }

  setProjection(projection: ProjectionSpec): void {
    if (projection === "mercator") return; // Leaflet is Web-Mercator native — nothing to do
    warnOnce("draw-adapter (Leaflet): only Web Mercator is supported; the projection request was ignored. Use the OpenLayers adapter to reproject.");
  }

  viewArea(extent: LngLatBounds, opts?: { padding?: number; duration?: number }): void {
    const [w, s, e0, n] = extent;
    const e = unwrapEast(w, e0); // antimeridian-crossing bbox ⇒ one continuous span
    const p = opts?.padding ?? 0;
    this.map.fitBounds([[s, w], [n, e]], {
      padding: [p, p],
      ...(opts?.duration != null ? { duration: opts.duration } : {}),
    });
  }

  highlightArea(extent: LngLatBounds | null, style?: HighlightStyle): void {
    if (!extent) {
      if (this.highlightPoly) { this.highlightPoly.remove(); this.highlightPoly = undefined; }
      return;
    }
    const ring = densifyBboxRing(extent, 64).map(([lon, lat]) => [lat, lon] as [number, number]);
    const opts: L.PolylineOptions = {
      pane: this.ensureHighlightPane(),
      interactive: false,
      color: style?.color ?? "#666",
      weight: style?.width ?? 1,
      dashArray: (style?.dash ?? [6, 4]).join(","),
      ...(style?.fill ? { fill: true, fillColor: style.fill, fillOpacity: 1 } : { fill: false }),
    };
    if (this.highlightPoly) {
      this.highlightPoly.setLatLngs(ring);
      this.highlightPoly.setStyle(opts);
    } else {
      this.highlightPoly = L.polygon(ring, opts).addTo(this.map);
    }
  }

  /** A dedicated pane for the frame, ABOVE the tiles and BELOW the drawing overlay panes
   *  (which start at zIndex 400); pointer-events off so it never intercepts clicks. */
  private ensureHighlightPane(): string {
    const name = "dap-highlight";
    if (!this.highlightPaneReady) {
      const pane = this.map.createPane(name);
      pane.style.zIndex = "350";
      pane.style.pointerEvents = "none";
      this.highlightPaneReady = true;
    }
    return name;
  }

  project(p: LatLng): [number, number] | null {
    const pt = this.map.latLngToContainerPoint([p.lat, p.lon]);
    return [pt.x, pt.y];
  }

  unproject(px: [number, number]): LatLng | null {
    const ll = this.map.containerPointToLatLng(L.point(px[0], px[1]));
    return { lat: ll.lat, lon: ll.lng };
  }

  onViewChange(cb: () => void): void {
    if (this.viewHandler) this.map.off("moveend zoomend", this.viewHandler); // single slot — drop the previous so a re-call never leaks
    this.viewHandler = cb;
    this.map.on("moveend zoomend", cb);
  }

  setPanEnabled(enabled: boolean): void {
    this.panOn = enabled;
    if (this.locked) return;
    if (enabled) this.map.dragging.enable();
    else this.map.dragging.disable();
  }

  setDoubleClickZoom(enabled: boolean): void {
    this.dblOn = enabled;
    if (this.locked) return;
    if (enabled) this.map.doubleClickZoom.enable();
    else this.map.doubleClickZoom.disable();
  }

  setInteractive(enabled: boolean): void {
    this.locked = !enabled;
    const m = this.map;
    const extras = [m.scrollWheelZoom, m.boxZoom, m.keyboard, m.touchZoom];
    if (this.locked) {
      m.dragging.disable(); m.doubleClickZoom.disable();
      for (const h of extras) h?.disable();
    } else {
      for (const h of extras) h?.enable();
      this.panOn ? m.dragging.enable() : m.dragging.disable();      // restore the controller's request
      this.dblOn ? m.doubleClickZoom.enable() : m.doubleClickZoom.disable();
    }
  }

  setCursor(cursor: string): void {
    this.map.getContainer().style.cursor = cursor;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    if (this.cb) return;
    this.cb = cb;
    const container = this.map.getContainer();

    // Capture-phase **mousedown** (NOT pointerdown): Leaflet's pan Draggable is
    // wired to `mousedown` (`START = 'mousedown'`), so we must intercept the same
    // event — stop it before it bubbles to the map pane so a draggable press never
    // starts a pan (mirrors the OpenLayers DragPan capture fix). Plain presses are
    // left alone so Leaflet still emits its click.
    const onDown = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.(".draw-adapter-widget")) return; // card owns it
      const ll = this.map.mouseEventToLatLng(e);
      const hit = this.hitAt(this.map.mouseEventToContainerPoint(e)); // geometric, ~5px tol — no hover needed
      // MANUAL double-click detection. Leaflet renders handles as DOM markers that are recreated
      // on every re-render, so the two clicks of a double-click land on DIFFERENT nodes and the
      // browser never fires a native "dblclick" (unlike OL's canvas, where it does). The
      // capture-phase mousedown DOES fire reliably, so detect the dbl from press timing + position.
      const now = Date.now();
      if (now - this.lastDownT < 400 && Math.abs(e.clientX - this.lastDownX) < 6 && Math.abs(e.clientY - this.lastDownY) < 6) {
        this.lastDownT = 0; // consume (so a triple-click isn't two dbls)
        this.suppressClick = true; // Leaflet will still fire a `click` for this 2nd press — swallow it
        // A dblclick ON a feature makes the consumer re-render (e.g. insert a vertex), which detaches
        // this mousedown's `e.target` from the DOM. If the event then reached Leaflet's _handleDOMEvent,
        // its preventOutline(e.target) would walk parentNode → null → "tabIndex of null" crash. Keep
        // Leaflet off this press whenever there's a hit (also stops a pan start). No hit ⇒ leave it so
        // Leaflet's own double-click zoom still works on the empty map.
        if (hit) L.DomEvent.stopPropagation(e as unknown as Event);
        cb({ type: "dblclick", lngLat: { lat: ll.lat, lon: ll.lng }, ...modifiers(e), ...(hit ? { hit } : {}) });
        return;
      }
      this.lastDownT = now;
      this.lastDownX = e.clientX;
      this.lastDownY = e.clientY;
      this.suppressClick = false; // a fresh single press ⇒ its click is legitimate (select/deselect)
      this.moved = false;         // track drag distance from here to gate the trailing click
      this.dragging = true;
      this.pressHit = hit; // remembered for this press's click
      if (hit && isDraggableHit(hit)) L.DomEvent.stopPropagation(e as unknown as Event);
      cb({ type: "down", lngLat: { lat: ll.lat, lon: ll.lng }, ...modifiers(e), ...(hit ? { hit } : {}) });
    };
    const onUp = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.(".draw-adapter-widget")) return; // card's own up
      this.dragging = false;
      const ll = this.map.mouseEventToLatLng(e); // real lon/lat from the release point (#2)
      cb({ type: "up", lngLat: { lat: ll.lat, lon: ll.lng }, ...modifiers(e) });
    };
    container.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp);
    this.domDown = onDown as (e: Event) => void;
    this.domUp = onUp;
    if (typeof window !== "undefined") {
      // Leaving the window mid-press loses the `up`; purge press state so the first click back
      // (the focusing click) starts clean instead of inheriting a stale drag/hit/dbl-click timer.
      this.windowBlur = () => { this.dragging = false; this.pressHit = undefined; this.lastDownT = 0; this.suppressClick = false; this.moved = false; };
      window.addEventListener("blur", this.windowBlur);
    }

    this.map.on("mousemove", (evt: L.LeafletMouseEvent) => {
      const ll = evt.latlng;
      const mods = modifiers(evt.originalEvent);
      // Recover a swallowed `up`: a move with NO button held means the press already ended
      // (e.g. the mouseup was eaten by a window-focusing gesture). Finalise so nothing sticks.
      if (this.dragging && evt.originalEvent.buttons === 0) {
        this.dragging = false;
        this.pressHit = undefined;
        cb({ type: "up", lngLat: { lat: ll.lat, lon: ll.lng }, ...mods });
      }
      if (this.dragging) {
        const oe = evt.originalEvent;
        if (Math.abs(oe.clientX - this.lastDownX) > 3 || Math.abs(oe.clientY - this.lastDownY) > 3) this.moved = true;
        cb({ type: "move", lngLat: { lat: ll.lat, lon: ll.lng }, ...mods });
        return;
      }
      const hit = this.hitAt(evt.containerPoint); // hover affordance/cursor — recomputed geometrically
      this.setCursor(cursorForHit(hit));
      cb({ type: "move", lngLat: { lat: ll.lat, lon: ll.lng }, ...mods, ...(hit ? { hit } : {}) });
    });
    this.map.on("click", (evt: L.LeafletMouseEvent) => {
      // Swallow the stray click Leaflet fires right after a double-click (see suppressClick) — else it
      // would deselect what the consumer just selected on dblclick (e.g. a freshly drawn front).
      if (this.suppressClick) { this.suppressClick = false; return; }
      // A drag gesture (e.g. drawing a shape by dragging) finalises on `up`; Leaflet still fires a
      // native `click` afterwards, which would carry an empty hit and deselect what was just drawn.
      // MapLibre/OL only emit a click for a stationary press — match that by gating on `moved`.
      if (this.moved) { this.moved = false; return; }
      // Atomic press: reuse the hit resolved at `down` (geometrically). Re-testing here would be
      // harmless now, but keeping one hit per press guarantees down/click agree on the same target.
      const hit = this.pressHit;
      cb({ type: "click", lngLat: { lat: evt.latlng.lat, lon: evt.latlng.lng }, ...modifiers(evt.originalEvent), ...(hit ? { hit } : {}) });
    });
    this.map.on("contextmenu", (evt: L.LeafletMouseEvent) => {
      L.DomEvent.preventDefault(evt.originalEvent); // suppress the browser menu
      const hit = this.hitAt(evt.containerPoint);
      cb({ type: "contextmenu", lngLat: { lat: evt.latlng.lat, lon: evt.latlng.lng }, ...modifiers(evt.originalEvent), ...(hit ? { hit } : {}) });
    });
    // (dblclick is handled by the native capture listener above — Leaflet's own map dblclick
    // is suppressed on draggable hits by our mousedown stopPropagation.)
  }

  onKey(cb: (ev: KeyEvent) => void): void {
    if (this.keyCleanup) return;
    this.keyCleanup = bindKeyListener(this.map.getContainer(), cb);
  }

  onBlur(cb: () => void): void {
    if (this.blurListener || typeof window === "undefined") return;
    this.blurListener = cb;
    window.addEventListener("blur", cb);
  }

  private widgetLayer(): WidgetLayer {
    if (!this.widgets) {
      const map = this.map;
      this.widgets = new WidgetLayer({
        createMount: (anchor) => {
          // Empty divIcon = a positioning SHELL. We inject the card DOM into its element
          // ONCE and only ever `setLatLng` to move it — never `setIcon` (that would rebuild
          // the DOM and drop the input's focus/caret). `className` overrides the default
          // `leaflet-div-icon` so there's no stock white box; `iconSize: null` ⇒ size to content.
          const icon = L.divIcon({
            className: "draw-adapter-widget",
            html: "",
            iconSize: null as unknown as L.PointTuple,
            iconAnchor: [0, 0], // top-left at the latlng; the `origin` shift is a CSS transform
          });
          const marker = L.marker([anchor.lat, anchor.lon], { icon, interactive: false, keyboard: false }).addTo(map);
          const el = marker.getElement() as HTMLElement;
          // The card lives INSIDE the Leaflet container, so its DOM click/mousedown bubble up
          // and Leaflet synthesizes a (no-hit) map `click` — which makes the consumer deselect
          // right after selecting. Stop those at the card; it emits its own widget click via
          // Pointer Events. (MapLibre is canvas-isolated and OL Overlays use stopEvent, so only
          // Leaflet needs this.)
          L.DomEvent.disableClickPropagation(el);
          L.DomEvent.disableScrollPropagation(el);
          return {
            el,
            setAnchor: (a) => { marker.setLatLng([a.lat, a.lon]); },
            remove: () => { marker.remove(); },
            setZIndex: (z) => {
              if (z > 0 && el.parentElement) {
                // DOM reordering: satellite cards move to the end of the pane so they render
                // above the main card. Called in ascending-depth order by WidgetLayer.
                el.parentElement.appendChild(el);
                // Lone-dial satellite cards (icing/turbulence gauges) set root.pointerEvents
                // to "none" so the dial hole is click-through — correct on MapLibre (hits the
                // canvas below) but wrong on Leaflet (hits hittable SVG text-box labels →
                // false re-selection). Force root back to auto after update() may have set none.
                const root = el.querySelector<HTMLElement>(".draw-adapter-widget-card");
                if (root) root.style.pointerEvents = "auto";
              }
            },
          };
        },
        unprojectClient: (cx, cy) => {
          const r = map.getContainer().getBoundingClientRect();
          const ll = map.containerPointToLatLng(L.point(cx - r.left, cy - r.top));
          return { lat: ll.lat, lon: ll.lng };
        },
        emit: (ev) => this.cb?.(ev),
        focus: () => refocusMap(this.map.getContainer()),
      });
    }
    return this.widgets;
  }

  setWidgets(widgets: MarkerWidget[]): void { this.widgetLayer().setWidgets(widgets); }
  onWidgetEdit(cb: (e: WidgetEdit) => void): void { this.widgetLayer().onWidgetEdit(cb); }
  onWidgetDelete(cb: (e: { id: string }) => void): void { this.widgetLayer().onWidgetDelete(cb); }
  onWidgetAction(cb: (e: { id: string; event: string }) => void): void { this.widgetLayer().onWidgetAction(cb); }
  setCoordFormat(fn: (ll: LatLng) => string): void { this.widgetLayer().setCoordFormat(fn); }

  destroy(): void {
    for (const g of this.groups.values()) {
      g.clearLayers();
      this.map.removeLayer(g);
    }
    this.groups.clear();
    if (this.highlightPoly) { this.highlightPoly.remove(); this.highlightPoly = undefined; }
    this.map.getPane("dap-highlight")?.remove();
    this.highlightPaneReady = false;
    for (const name of this.paneNames) this.map.getPane(name)?.remove();
    this.paneNames.length = 0;
    if (this.domDown) this.map.getContainer().removeEventListener("mousedown", this.domDown as EventListener, true);
    if (this.domUp) document.removeEventListener("mouseup", this.domUp);
    if (this.windowBlur && typeof window !== "undefined") window.removeEventListener("blur", this.windowBlur);
    if (this.blurListener && typeof window !== "undefined") window.removeEventListener("blur", this.blurListener);
    this.domDown = this.domUp = this.windowBlur = this.blurListener = undefined;
    this.pressHit = undefined;
    this.suppressClick = false;
    this.moved = false;
    this.keyCleanup?.();
    this.keyCleanup = undefined;
    if (this.viewHandler) this.map.off("moveend zoomend", this.viewHandler);
    this.map.off("mousemove");
    this.map.off("click");
    this.map.off("contextmenu");
    this.map.off("dblclick");
    this.cb = undefined;
    this.viewHandler = undefined;
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.widgets?.destroy();
    this.widgets = undefined;
    this.readyPromise = undefined;
    this.setCursor("");
    if (this.locked) this.setInteractive(true); // unlock the host map on teardown
    this.locked = false;
    this.panOn = this.dblOn = true;
    this.map.dragging.enable();
    this.map.doubleClickZoom.enable(); // re-enable in case we were torn down mid-draw
  }

  // ── Hit tracking ───────────────────────────────────────────────────────────
  /**
   * Resolve the feature under a container-pixel point GEOMETRICALLY, with a ~5px tolerance
   * ({@link HIT_TOL}) — Leaflet's stand-in for `queryRenderedFeatures`. Scans every hittable
   * overlay's live layers (skipping hidden panes + overlays excluded by `hitOverlays`), measures
   * the screen-space distance from the point to each feature's surface (0 = inside/on it), and
   * returns the TOPMOST (highest manifest z, then nearest) feature within tolerance. Independent
   * of any prior hover, so a freshly drawn/re-rendered feature is hittable with no mouse move.
   */
  private hitAt(pt: L.Point | undefined): Hit | undefined {
    if (!pt) return undefined;
    const hittable = this.opts.hitOverlays;
    const cRect = this.map.getContainer().getBoundingClientRect();
    let best: Hit | undefined;
    let bestZ = -1;
    let bestDist = Infinity;
    // `opts.layers` order = pane z-order (400 + i*10), so the manifest index IS the z.
    this.opts.layers.forEach((spec, z) => {
      if (!(hittable?.has(spec.id) ?? true)) return; // overlay opted out of hit-testing
      const pane = this.map.getPane(`dap-${spec.id}`);
      if (pane && pane.style.display === "none") return; // hidden ⇒ pass-through
      const group = this.groups.get(spec.id);
      if (!group) return;
      group.eachLayer((layer) => {
        const d = this.surfaceDist(layer, pt, cRect);
        if (d == null || d > HIT_TOL) return;
        if (z > bestZ || (z === bestZ && d < bestDist)) {
          const props = ((layer as L.Layer & { feature?: Feature }).feature?.properties ?? {}) as Record<string, unknown>;
          best = { overlay: spec.id, props };
          bestZ = z;
          bestDist = d;
        }
      });
    });
    return best;
  }

  /** Screen-space distance (px) from `pt` to a rendered layer's surface — `0` when inside/on it,
   *  `null` when the layer carries no hittable geometry. Mirrors the geometry kinds Leaflet renders:
   *  polygon (inside-or-edge), polyline (nearest segment), circle (centre±radius), marker (its DOM
   *  box, so glyph/symbol/text-call-out sizes are honoured), and groups (nearest child). */
  private surfaceDist(layer: L.Layer, pt: L.Point, cRect: DOMRect): number | null {
    const map = this.map;
    // Polygon extends Polyline in Leaflet — test it FIRST (inside test + edge distance).
    if (layer instanceof L.Polygon) {
      const rings = normalizeLatLngs(layer.getLatLngs()).map((r) => r.map((ll) => map.latLngToContainerPoint(ll)));
      return pointInRings(pt, rings) ? 0 : minSegDist(pt, rings, true);
    }
    if (layer instanceof L.Polyline) {
      const lines = normalizeLatLngs(layer.getLatLngs()).map((r) => r.map((ll) => map.latLngToContainerPoint(ll)));
      return minSegDist(pt, lines, false);
    }
    if (layer instanceof L.CircleMarker) {
      const rad = layer.getRadius();
      if (rad <= 0) return null; // invisible placeholder (e.g. symbol with no sprite) ⇒ not hittable
      return Math.max(0, pt.distanceTo(map.latLngToContainerPoint(layer.getLatLng())) - rad);
    }
    if (layer instanceof L.Marker) {
      const el = layer.getElement();
      // The visible glyph/text is the marker's inner box (the icon element can be 0×0, e.g. text).
      const box = (el?.firstElementChild as HTMLElement | null) ?? el;
      const r = box?.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) {
        return pt.distanceTo(map.latLngToContainerPoint(layer.getLatLng())); // size-less ⇒ point distance
      }
      const dx = Math.max(r.left - cRect.left - pt.x, 0, pt.x - (r.right - cRect.left));
      const dy = Math.max(r.top - cRect.top - pt.y, 0, pt.y - (r.bottom - cRect.top));
      return Math.hypot(dx, dy);
    }
    if (layer instanceof L.LayerGroup) {
      // circle kind = featureGroup(dot + glyph) — nearest of its children.
      let min: number | null = null;
      layer.eachLayer((c) => {
        const d = this.surfaceDist(c, pt, cRect);
        if (d != null && (min == null || d < min)) min = d;
      });
      return min;
    }
    return null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  private styleFor(kind: LayerKind, f?: Feature): L.PathOptions {
    const p = (f?.properties ?? {}) as Record<string, unknown>;
    switch (kind) {
      case "fill":
        return {
          fillColor: str(p["fillColor"], "#888"),
          fillOpacity: num(p["fillOpacity"], 0.2),
          color: str(p["stroke"], "#888"),
          weight: p["stroke"] ? num(p["strokeWidth"], 1) : 0,
          opacity: num(p["strokeOpacity"], 1),
        };
      case "line": {
        const dash = p["dash"] as number[] | undefined;
        const isPolygon = f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";
        return {
          color: str(p["stroke"], "#333"),
          weight: num(p["strokeWidth"], 2),
          opacity: num(p["strokeOpacity"], 1),
          lineCap: dash ? "butt" : "round",
          lineJoin: "round",
          ...(dash ? { dashArray: dash.join(",") } : {}),
          ...(isPolygon ? { fill: true, fillColor: str(p["fillColor"]) || str(p["stroke"], "#333"), fillOpacity: 1 } : { fill: false }),
        };
      }
      default:
        return {};
    }
  }

  private pointLayer(kind: LayerKind, overlay: string, f: Feature, latlng: L.LatLng, pane: string): L.Layer {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const hittable = this.opts.hitOverlays?.has(overlay) ?? true;
    switch (kind) {
      case "circle": {
        const dot = L.circleMarker(latlng, {
          pane,
          radius: num(p["radius"], 5),
          fillColor: str(p["fill"], "#ffffff"),
          fillOpacity: 1,
          color: str(p["stroke"], "#58a6ff"),
          weight: num(p["strokeWidth"], 2),
        });
        const icon = this.glyphHtml(p, num(p["iconRotate"], num(p["rotation"], 0)));
        if (!icon) return dot;
        const marker = L.marker(latlng, { pane, icon, interactive: true });
        // featureGroup (NOT layerGroup): it propagates child mouseover/out to the
        // group, where bindFeature listens — so glyph handles (move/transform/resize)
        // are hovered, hit, draggable AND drive the cursor, just like plain vertices.
        return L.featureGroup([dot, marker], { pane });
      }
      case "symbol": {
        const icon = this.glyphHtml(p, num(p["rotation"], 0));
        return icon ? L.marker(latlng, { pane, icon }) : L.circleMarker(latlng, { pane, radius: 0, opacity: 0, fillOpacity: 0 });
      }
      case "text":
        // Interactive only when the text overlay is hittable — then its label box (call-out) is
        // clickable (mouseover sets `this.hovered`, like any feature). Non-hittable text stays
        // pass-through so it never eats clicks meant for the shape/handles beneath it.
        // `bubblingMouseEvents: true` is REQUIRED: a Leaflet marker defaults to false, so an
        // interactive text marker would SWALLOW the click instead of letting it reach `map.on("click")`
        // (no hit surfaced). With bubbling on, the click reaches the map handler ⇒ select works.
        return L.marker(latlng, { pane, icon: this.textIcon(p), interactive: hittable, bubblingMouseEvents: true });
      default:
        // fill/line never reach pointToLayer (no point geometry); render nothing.
        return L.circleMarker(latlng, { pane, radius: 0, opacity: 0, fillOpacity: 0 });
    }
  }

  /** Build a rotatable glyph divIcon from a feature's `icon` (data-URI) or `symbol`
   *  (sprite, tinted by `symbolColor`). Returns undefined when neither is present. */
  private glyphHtml(p: Record<string, unknown>, rotateDeg: number): L.DivIcon | undefined {
    const px = this.opts.spritePx * num(p["size"], 1);
    const iconUri = str(p["icon"]);
    let inner: string | undefined;
    if (iconUri) {
      inner = `<img src="${iconUri}" width="${px}" height="${px}" style="display:block"/>`;
    } else {
      const sprite = str(p["symbol"]);
      const svg = sprite ? this.sprites[sprite] : undefined;
      // Force the sprite SVG to FILL (and thus centre in) the px-sized div — its intrinsic
      // width/height would otherwise sit top-left and ignore `size`. CSS width wins over the attr.
      if (svg) inner = colorizeSprite(svg, str(p["symbolColor"]) || this.opts.defaultSymbolColor).replace("<svg", '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block"');
    }
    if (!inner) return undefined;
    const html = `<div style="width:${px}px;height:${px}px;transform:rotate(${rotateDeg}deg);transform-origin:center">${inner}</div>`;
    return L.divIcon({ html, className: "draw-adapter-glyph", iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
  }

  private textIcon(p: Record<string, unknown>): L.DivIcon {
    const size = num(p["textSize"], 13);
    const color = str(p["textColor"], "#111");
    const halo = str(p["textHalo"], "#fff");
    const bg = str(p["textBackground"]);
    const border = str(p["textBorder"]);
    const [pv, ph] = boxPadding(p["textBoxSize"]);
    const radius = boxRadius(p["textBoxRadius"]);
    const maxWidth = num(p["maxWidth"], 0);
    const rot = num(p["rotation"], 0);
    // Let CSS do the wrapping (this is HTML — no canvas maths needed). The trick is
    // `width:max-content` + `max-width`: the box sizes to its longest line but is
    // capped at `maxWidth`px. `pre-line` HONOURS the content's `\n` line breaks AND still
    // wraps at that width. (Without `max-content` the 0×0 marker would force a wrap at every word.)
    const css = [
      "display:inline-block",
      "white-space:pre-line",
      "width:max-content",
      maxWidth > 0 ? `max-width:${maxWidth}px` : "",
      "text-align:center",
      "line-height:1.2",
      `font:${size}px sans-serif`,
      `color:${color}`,
      `text-shadow:-1px -1px 0 ${halo},1px -1px 0 ${halo},-1px 1px 0 ${halo},1px 1px 0 ${halo}`,
      bg ? `background:${rgba(bg, 1)}` : "",
      border ? `border:${textBoxBorderWidth(p["textBorderWidth"])}px solid ${border}` : "",
      bg || border ? `padding:${pv}px ${ph}px;border-radius:${radius}px` : "",
      // Centre the label on its anchor (like MapLibre's centred text-anchor).
      `transform:translate(-50%,-50%)${rot ? ` rotate(${rot}deg)` : ""}`,
      "transform-origin:center",
    ].filter(Boolean).join(";");
    const html = `<div style="${css}">${escapeHtml(str(p["text"]))}</div>`;
    // iconSize [0,0] ⇒ the marker's top-left sits on the anchor; the inner div's
    // translate(-50%,-50%) then centres it there. Non-interactive so it never eats
    // pointer events meant for the shape/handles beneath it.
    return L.divIcon({ html, className: "draw-adapter-text", iconSize: [0, 0] });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

// ── Geometric hit-test helpers (pure, pixel-space) ────────────────────────────

/** Flatten Leaflet's `getLatLngs()` (flat for a simple polyline, nested for multi/rings/holes)
 *  into a uniform list of LatLng arrays — one per line or ring. */
function normalizeLatLngs(latlngs: unknown): L.LatLng[][] {
  if (!Array.isArray(latlngs) || latlngs.length === 0) return [];
  if (latlngs[0] instanceof L.LatLng) return [latlngs as L.LatLng[]];
  const out: L.LatLng[][] = [];
  for (const sub of latlngs) out.push(...normalizeLatLngs(sub));
  return out;
}

/** Distance (px) from point `p` to segment `a→b`. */
function distToSeg(p: L.Point, a: L.Point, b: L.Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Min distance (px) from `p` to a set of lines/rings. `closed` adds the last→first edge (polygons). */
function minSegDist(p: L.Point, lines: L.Point[][], closed: boolean): number {
  let min = Infinity;
  for (const line of lines) {
    const n = line.length;
    if (n === 0) continue;
    if (n === 1) { min = Math.min(min, Math.hypot(p.x - line[0]!.x, p.y - line[0]!.y)); continue; }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) min = Math.min(min, distToSeg(p, line[i]!, line[(i + 1) % n]!));
  }
  return min;
}

/** Even-odd point-in-polygon over all rings combined (honours holes). */
function pointInRings(p: L.Point, rings: L.Point[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}
