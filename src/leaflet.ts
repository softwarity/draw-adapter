/**
 * Leaflet adapter — grafts onto a host-owned `L.Map`. Leaflet is lat/lng-native
 * (no reprojection). Reads the same feature render-props as the MapLibre /
 * OpenLayers adapters so all three render identically.
 *
 * Per-overlay z-order uses one Leaflet **pane** per {@link LayerSpec} (increasing
 * `zIndex`); rotatable handle/symbol glyphs use `L.divIcon` + a CSS
 * `transform: rotate()` (Leaflet markers don't rotate natively). Hit-testing is
 * per-feature (`mouseover`/`mouseout` track the hovered hit) since Leaflet has no
 * `queryRenderedFeatures`. The drag-vs-pan conflict is solved exactly like the
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
  Hit,
  KeyEvent,
  LatLng,
  LayerKind,
  MapAdapter,
  PointerEvent,
  SymbolSprites,
  ToolbarItem,
  ToolbarOptions,
  TooltipStyle,
} from "./index.js";
import { cursorForHit } from "./index.js";
import { num, str, rgba } from "./coerce.js";
import { colorizeSprite } from "./symbols.js";
import { populateToolbar } from "./toolbar.js";
import { snapshotToolbarItem } from "./snapshot.js";
import { lockToolbarItem } from "./lock.js";
import { bindKeyListener } from "./keyboard.js";
import { applyTooltipStyle } from "./tooltip.js";

/** Why Leaflet can't snapshot yet — shown both as the thrown error and the
 *  disabled toolbar button's tooltip. */
const LEAFLET_SNAPSHOT_UNSUPPORTED =
  "snapshot() is not supported on the Leaflet adapter yet (no native exportable " +
  "canvas: tiles are <img>, overlays are SVG/DOM). Planned via a DOM-snapshot approach.";

function isDraggableHit(hit: Hit): boolean {
  return hit.props["role"] != null;
}

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
    ".draw-adapter-leaflet-toolbar button:hover{background:#f4f4f4}" +
    ".draw-adapter-leaflet-toolbar button.active{background:#dbeafe}";
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
  private readonly opts: Required<Omit<AdapterOptions, "hitOverlays">> & Pick<AdapterOptions, "hitOverlays">;
  private readonly kindOf: Map<string, LayerKind>;
  private readonly groups = new Map<string, L.GeoJSON>();
  private readonly paneNames: string[] = [];
  private sprites: Record<string, string> = {};
  private readyPromise: Promise<void> | undefined;
  private hovered: Hit | undefined;
  private dragging = false;
  private locked = false;
  private panOn = true;
  private dblOn = true;
  private tooltipStyle: TooltipStyle | undefined;
  private tooltipEl: HTMLElement | undefined;
  private toolbarEl: HTMLElement | undefined;
  private cb: ((ev: PointerEvent) => void) | undefined;
  private domDown: ((e: Event) => void) | undefined;
  private domUp: (() => void) | undefined;
  private keyCleanup: (() => void) | undefined;
  private lastDownT = 0;
  private lastDownX = 0;
  private lastDownY = 0;
  private viewHandler: (() => void) | undefined;

  constructor(opts: { map: L.Map } & AdapterOptions) {
    this.map = opts.map;
    this.opts = {
      layers: opts.layers,
      spritePx: opts.spritePx ?? 32,
      defaultSymbolColor: opts.defaultSymbolColor ?? "#000000",
      ...(opts.hitOverlays ? { hitOverlays: opts.hitOverlays } : {}),
    };
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
          pointToLayer: (f, latlng) => this.pointLayer(spec.kind, f, latlng, paneName),
          onEachFeature: (f, layer) => this.bindFeature(spec.id, f, layer),
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
    group.clearLayers();
    if (data.features.length) group.addData(data);
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
    populateToolbar(el, [...items, ...chrome], options);
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

  getCenter(): LatLng {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  getViewSpan(): number {
    const b = this.map.getBounds();
    return Math.max(Math.abs(b.getEast() - b.getWest()), Math.abs(b.getNorth() - b.getSouth())) || 10;
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
      const ll = this.map.mouseEventToLatLng(e);
      const hit = this.hovered;
      // MANUAL double-click detection. Leaflet renders handles as DOM markers that are recreated
      // on every re-render, so the two clicks of a double-click land on DIFFERENT nodes and the
      // browser never fires a native "dblclick" (unlike OL's canvas, where it does). The
      // capture-phase mousedown DOES fire reliably, so detect the dbl from press timing + position.
      const now = Date.now();
      if (now - this.lastDownT < 400 && Math.abs(e.clientX - this.lastDownX) < 6 && Math.abs(e.clientY - this.lastDownY) < 6) {
        this.lastDownT = 0; // consume (so a triple-click isn't two dbls)
        if (hit && isDraggableHit(hit)) L.DomEvent.stopPropagation(e as unknown as Event);
        cb({ type: "dblclick", lngLat: { lat: ll.lat, lon: ll.lng }, ...(hit ? { hit } : {}) });
        return;
      }
      this.lastDownT = now;
      this.lastDownX = e.clientX;
      this.lastDownY = e.clientY;
      this.dragging = true;
      if (hit && isDraggableHit(hit)) L.DomEvent.stopPropagation(e as unknown as Event);
      cb({ type: "down", lngLat: { lat: ll.lat, lon: ll.lng }, ...(hit ? { hit } : {}) });
    };
    const onUp = (): void => {
      this.dragging = false;
      cb({ type: "up", lngLat: { lat: 0, lon: 0 } });
    };
    container.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp);
    this.domDown = onDown as (e: Event) => void;
    this.domUp = onUp;

    this.map.on("mousemove", (evt: L.LeafletMouseEvent) => {
      const ll = evt.latlng;
      if (this.dragging) {
        cb({ type: "move", lngLat: { lat: ll.lat, lon: ll.lng } });
        return;
      }
      const hit = this.hovered;
      this.setCursor(cursorForHit(hit));
      cb({ type: "move", lngLat: { lat: ll.lat, lon: ll.lng }, ...(hit ? { hit } : {}) });
    });
    this.map.on("click", (evt: L.LeafletMouseEvent) => {
      const hit = this.hovered;
      cb({ type: "click", lngLat: { lat: evt.latlng.lat, lon: evt.latlng.lng }, ...(hit ? { hit } : {}) });
    });
    // (dblclick is handled by the native capture listener above — Leaflet's own map dblclick
    // is suppressed on draggable hits by our mousedown stopPropagation.)
  }

  onKey(cb: (ev: KeyEvent) => void): void {
    if (this.keyCleanup) return;
    this.keyCleanup = bindKeyListener(this.map.getContainer(), cb);
  }

  destroy(): void {
    for (const g of this.groups.values()) {
      g.clearLayers();
      this.map.removeLayer(g);
    }
    this.groups.clear();
    for (const name of this.paneNames) this.map.getPane(name)?.remove();
    this.paneNames.length = 0;
    if (this.domDown) this.map.getContainer().removeEventListener("mousedown", this.domDown as EventListener, true);
    if (this.domUp) document.removeEventListener("mouseup", this.domUp);
    this.domDown = this.domUp = undefined;
    this.keyCleanup?.();
    this.keyCleanup = undefined;
    if (this.viewHandler) this.map.off("moveend zoomend", this.viewHandler);
    this.map.off("mousemove");
    this.map.off("click");
    this.map.off("dblclick");
    this.cb = undefined;
    this.viewHandler = undefined;
    this.hovered = undefined;
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.readyPromise = undefined;
    this.setCursor("");
    if (this.locked) this.setInteractive(true); // unlock the host map on teardown
    this.locked = false;
    this.panOn = this.dblOn = true;
    this.map.dragging.enable();
    this.map.doubleClickZoom.enable(); // re-enable in case we were torn down mid-draw
  }

  // ── Hit tracking ───────────────────────────────────────────────────────────
  private bindFeature(overlay: string, f: Feature, layer: L.Layer): void {
    const hittable = this.opts.hitOverlays?.has(overlay) ?? true;
    if (!hittable) return;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    layer.on("mouseover", () => { this.hovered = { overlay, props }; });
    layer.on("mouseout", () => { if (this.hovered?.props === props) this.hovered = undefined; });
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

  private pointLayer(kind: LayerKind, f: Feature, latlng: L.LatLng, pane: string): L.Layer {
    const p = (f.properties ?? {}) as Record<string, unknown>;
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
        return L.marker(latlng, { pane, icon: this.textIcon(p), interactive: false });
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
      border ? `border:1px solid ${border}` : "",
      bg || border ? "padding:6px 8px;border-radius:3px" : "",
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
