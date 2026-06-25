/**
 * MapLibre GL v5 adapter — grafts onto a host-owned `maplibregl.Map`.
 *
 * Builds one source + renderer per {@link LayerSpec} entry, data-driven from the
 * feature render-props (see the contract in `index.ts`). Dashed lines use a
 * parallel filtered sub-layer (MapLibre can't data-drive `line-dasharray`);
 * scallops/barbs are real geometry, so they render identically to OpenLayers.
 *
 * The manifest (`layers`) and the hit-testable set (`hitOverlays`) are supplied
 * by the consumer; this adapter knows no domain type.
 */
import type { Feature, FeatureCollection } from "geojson";
// maplibre-gl v5 ships a UMD/CJS `main` with NO `module`/`exports` field and no
// default export, so `import { Map } from "maplibre-gl"` throws under Node ESM
// ("Named export 'Map' not found"). Import the namespace and resolve the ctor at
// runtime (handles both the CJS-interop default and a future ESM named export).
// `import type` is erased, so the type alias stays a clean named type import.
import type { Map as MapLibreMap, MapOptions, Marker as MlMarker, MarkerOptions } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";

type MapLibreMapCtor = new (options: MapOptions) => MapLibreMap;
const MaplibreMap: MapLibreMapCtor = ((ns: { Map?: MapLibreMapCtor; default?: { Map: MapLibreMapCtor } }) =>
  ns.Map ?? ns.default!.Map)(maplibregl as never);

type MlMarkerCtor = new (options?: MarkerOptions) => MlMarker;
const MaplibreMarker: MlMarkerCtor = ((ns: { Marker?: MlMarkerCtor; default?: { Marker: MlMarkerCtor } }) =>
  ns.Marker ?? ns.default!.Marker)(maplibregl as never);

import type {
  AdapterOptions,
  HighlightStyle,
  Hit,
  KeyEvent,
  LatLng,
  LngLatBounds,
  MapAdapter,
  MarkerWidget,
  PointerEvent,
  ProjectionSpec,
  SnapshotOptions,
  SymbolSprites,
  ToolbarItem,
  ToolbarOptions,
  TooltipStyle,
  WidgetEdit,
} from "./index.js";
import { cursorForHit, defaultCoordFormat, EMPTY_FC } from "./index.js";
import { complementRings, densifyBboxRing, unwrapEast, warnOnce } from "./geo.js";
import { OutsideMask, maskRect } from "./mask.js";
import { WidgetLayer, snapshotWithWidgets } from "./widget.js";
import { rasterizeWidget, clearSpriteCache, type SpriteResult } from "./sprite.js";
import { colorizeSprite, loadSpriteImage } from "./symbols.js";
import { resolveAdapterOptions, type ResolvedAdapterOptions } from "./options.js";
import { boxPadding, boxRadius, textBoxBorderWidth } from "./textbox.js";
import { populateToolbar, setToolbarActive } from "./toolbar.js";
import { deliverSnapshot, shutterFlash, snapshotToolbarItem } from "./snapshot.js";
import { lockToolbarItem } from "./lock.js";
import { fullscreenToolbarItem } from "./fullscreen.js";
import { bindKeyListener, refocusMap } from "./keyboard.js";
import { modifiers } from "./modifiers.js";
import { applyTooltipStyle } from "./tooltip.js";

type MlHandler = (e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number }; originalEvent?: MouseEvent }) => void;
interface PointerHandlers {
  mousedown: MlHandler;
  mousemove: MlHandler;
  mouseup: MlHandler;
  click: MlHandler;
  dblclick: MlHandler;
  contextmenu: MlHandler;
}

export type Projection = "mercator" | "globe";

/** Source + layer ids for the {@link MapLibreAdapter.highlightArea} frame (internal, `__dap` prefix). */
const HL_SOURCE = "__dap-highlight";
const HL_FILL = "__dap-highlight-fill";
const HL_LINE = "__dap-highlight-line";
/** Source + fill layer for the native `dimOutside` complement (a multi-polygon of plain rectangles
 *  tiling everything but the area) — a real GL layer, so it follows pan/zoom for free. The blur
 *  (`blurOutside`) is a DOM overlay ({@link OutsideMask}) instead, since a GL fill cannot blur. */
const HL_DIM_SOURCE = "__dap-highlight-dim";
const HL_DIM = "__dap-highlight-dim";

/** Source + symbol layer for `static` marker-widget sprites (read-only cartouches rendered as native
 *  icons). The layer is mapped to the {@link WSPRITE_HIT_OVERLAY} overlay for hit-testing, so a sprite
 *  surfaces the SAME hit as a canvas call-out (drag = reposition, tap = select). */
const WSPRITE_SOURCE = "__dap-widget-sprites";
const WSPRITE_LAYER = "__dap-widget-sprites";
/** Overlay a sprite hit resolves against — reuses the call-out overlay so the consumer's existing
 *  call-out interaction handles it with no new code (see {@link MarkerWidget.static}). */
const WSPRITE_HIT_OVERLAY = "text-boxes";

const ORIGIN_ANCHORS = new Set(["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]);
/** A named {@link MarkerWidget.origin} maps 1:1 to a MapLibre `icon-anchor` (data-driven, well
 *  supported). A fractional `{x,y}` origin falls back to `center` — `icon-offset` is NOT reliably
 *  data-driven across maplibre-gl v5, so we avoid it; fractional origins are rare for read-only
 *  call-outs (OpenLayers/Leaflet honour them exactly via their `anchor` fraction). */
function spriteAnchor(o: MarkerWidget["origin"]): string {
  return typeof o === "string" && ORIGIN_ANCHORS.has(o) ? o : "center";
}

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

/** Batteries-included host map (headless hosts pass their own `map` instead). */
export function createMapLibreMap(opts: {
  container: HTMLElement | string;
  center: [number, number];
  zoom: number;
  projection?: Projection;
}): MapLibreMap {
  const map = new MaplibreMap({ container: opts.container, style: OSM_STYLE, center: opts.center, zoom: opts.zoom });
  if (opts.projection === "globe") map.on("load", () => map.setProjection({ type: "globe" }));
  return map;
}

/** Trace a rounded-rectangle path (arcTo, clamped radius) on a 2D context. */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class MapLibreAdapter implements MapAdapter {
  /** MapLibre exposes the WebGL canvas → snapshot is supported. */
  protected readonly snapshotSupported = true;
  private readonly map: MapLibreMap;
  private readonly opts: ResolvedAdapterOptions;
  private readonly overlayIds: string[];
  private readyPromise: Promise<void> | undefined;
  /** rendered MapLibre layer id → overlay id (for hit-testing). */
  private readonly renderedToOverlay = new Map<string, string>();
  private readonly builtLayers: string[] = [];
  private pointerHandlers: PointerHandlers | undefined;
  private keyCleanup: (() => void) | undefined;
  private windowUp: ((e: MouseEvent) => void) | undefined;
  private windowBlur: (() => void) | undefined;
  private blurListener: (() => void) | undefined;
  /** Press state captured at `down`, used to emit a `click` ourselves on release — MapLibre's
   *  native `click` can be swallowed by the OS on the first click after re-focusing the window. */
  private pressHit: Hit | undefined;
  private pressX = 0;
  private pressY = 0;
  private pressDown = false;
  private justSynthClick = false;
  private viewHandler: (() => void) | undefined;
  // viewArea "sticky" framing: the last request, re-applied (instantly) whenever the container resizes.
  private lastFit: { extent: LngLatBounds; opts?: { padding?: number; duration?: number } } | undefined;
  private resizeObs: ResizeObserver | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  // highlightArea "outside" effects: blur is a DOM overlay re-synced on `move`; dim is a native layer.
  private outsideMask: OutsideMask | undefined;
  private maskMove: (() => void) | undefined;
  private maskExtent: LngLatBounds | null = null;
  private maskStyle: HighlightStyle | undefined;
  private toolbarEl: HTMLElement | undefined;
  private tooltipEl: HTMLElement | undefined;
  private tooltipStyle: TooltipStyle | undefined;
  private dragging = false;
  /** Map-lock state: `locked` freezes all nav and wins over the controller's transient
   *  pan/dbl toggles (remembered in `panOn`/`dblOn`, re-applied on unlock). */
  private locked = false;
  private panOn = true;
  private dblOn = true;
  /** Raw sprite SVGs (`currentColor`), re-tinted per feature into `symbol|colour` images. */
  private spriteSvgs: Record<string, string> = {};
  /** EVERY image id we added to the host map (bare ids, `id|colour` tints, `data:`
   *  icons), so `destroy()` removes them all — not just the bare sprite ids. */
  private readonly addedImages = new Set<string>();
  /** Image ids currently being rasterized (deduplicates `styleimagemissing`). */
  private readonly pendingImages = new Set<string>();
  private imgMissing: ((e: { id: string }) => void) | undefined;
  private widgets: WidgetLayer | undefined;
  private pointerCb: ((ev: PointerEvent) => void) | undefined;
  /** Coord formatter, mirrored from {@link setCoordFormat} so sprite rasterization formats `coord`
   *  leaves the same way the live cards do. */
  private coordFmt: (ll: LatLng) => string = defaultCoordFormat;
  /** Whether the `static`-widget sprite source/layer have been added (lazy; only if used). */
  private spriteLayerBuilt = false;
  /** Image ids baked for sprite icons (`__dap-wsprite|<id>`), removed on `destroy`. */
  private readonly spriteImageIds = new Set<string>();
  /** Last rasterized sprite per widget id — skip re-uploading the texture when unchanged (req:
   *  re-raster only on content/dpr change, never per frame/pan/zoom). */
  private readonly lastSpriteRef = new Map<string, SpriteResult>();
  /** Monotonic token so a superseded async sprite update never clobbers a newer `setWidgets`. */
  private spriteToken = 0;

  constructor(opts: { map: MapLibreMap } & AdapterOptions) {
    this.map = opts.map;
    this.opts = resolveAdapterOptions(opts);
    this.overlayIds = opts.layers.map((l) => l.id);
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        const go = () => {
          this.addOverlays();
          resolve();
        };
        if (this.map.isStyleLoaded()) go();
        else this.map.once("load", go);
      });
    }
    return this.readyPromise;
  }

  async registerSymbols(sprites: SymbolSprites): Promise<void> {
    this.bindImageMissing();
    await Promise.all(
      Object.entries(sprites).map(async ([id, svg]) => {
        this.spriteSvgs[id] = svg; // keep raw; colour baked on demand into `id|colour`
        if (this.map.hasImage(id)) this.map.removeImage(id);
        const img = await loadSpriteImage(colorizeSprite(svg, this.opts.defaultSymbolColor), this.opts.spritePx);
        if (!this.map.hasImage(id)) {
          this.map.addImage(id, img);
          this.addedImages.add(id);
        }
      }),
    );
  }

  /**
   * Lazily materialize any image id the renderer asks for and we don't have yet:
   *  - `data:…` → rasterize the data-URI directly (per-feature handle icons),
   *  - `sprite|colour` → re-tint the raw sprite to that hue (symbol features).
   */
  private bindImageMissing(): void {
    if (this.imgMissing) return;
    this.imgMissing = (e: { id: string }): void => {
      const id = e.id;
      if (!id || this.map.hasImage(id) || this.pendingImages.has(id)) return;
      if (id.startsWith("__box|")) { this.materializeCalloutBox(id); return; } // label box (sync canvas)
      let src: string | undefined;
      if (id.startsWith("data:")) {
        src = id;
      } else {
        const sep = id.indexOf("|");
        if (sep < 0) return;
        const svg = this.spriteSvgs[id.slice(0, sep)];
        if (svg) src = colorizeSprite(svg, id.slice(sep + 1));
      }
      if (!src) return;
      this.pendingImages.add(id);
      loadSpriteImage(src, this.opts.spritePx)
        .then((img) => { if (!this.map.hasImage(id)) { this.map.addImage(id, img); this.addedImages.add(id); } })
        .catch(() => { /* a bad colour/uri just renders nothing */ })
        .finally(() => this.pendingImages.delete(id));
    };
    this.map.on("styleimagemissing", this.imgMissing);
  }

  /**
   * `icon-image` expression for a `text` layer: a per-feature label-box id
   * `__box|<bg>|<border>|<size>|<radius>|<borderWidth>` when the feature carries a `textBackground`
   * and/or `textBorder`, else `""` (no box). Materialized lazily by
   * {@link materializeCalloutBox} via `styleimagemissing`.
   */
  private calloutImageExpr(): unknown {
    return [
      "case",
      ["any",
        ["to-boolean", ["coalesce", ["get", "textBackground"], false]],
        ["to-boolean", ["coalesce", ["get", "textBorder"], false]]],
      ["concat", "__box|",
        ["coalesce", ["get", "textBackground"], ""], "|",
        ["coalesce", ["get", "textBorder"], ""], "|",
        ["coalesce", ["get", "textBoxSize"], "medium"], "|",
        ["coalesce", ["get", "textBoxRadius"], "none"], "|",
        ["coalesce", ["get", "textBorderWidth"], "medium"]],
      "",
    ];
  }

  /**
   * Draw a label box (rounded rect: `textBackground` fill, `textBorder` stroke,
   * `textBoxRadius` corners) onto a 2× canvas and register it as a **9-slice** image —
   * the padding (`textBoxSize`) + border + corners are baked into the fixed frame, so
   * `icon-text-fit` stretches only the centre to the text. This is what lets MapLibre vary
   * the box per feature (`icon-text-fit-padding` itself is layer-wide). Synchronous.
   */
  private materializeCalloutBox(id: string): void {
    if (typeof document === "undefined") return;
    const [, bg, border, size, radius, borderWidth] = id.split("|");
    const [pv, ph] = boxPadding(size);
    const R = boxRadius(radius);
    const bw = border ? textBoxBorderWidth(borderWidth) : 0; // border width (css px), preset (default 1.4)
    const insetX = Math.max(ph + bw, R, 2);
    const insetY = Math.max(pv + bw, R, 2);
    const Scss = 2 * Math.max(insetX, insetY) + 8; // square; +middle so there's a stretch band
    const px = 2;
    const cnv = document.createElement("canvas");
    cnv.width = cnv.height = Math.round(Scss * px);
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    ctx.scale(px, px);
    roundRectPath(ctx, bw / 2, bw / 2, Scss - bw, Scss - bw, R);
    if (bg) { ctx.fillStyle = bg; ctx.fill(); }
    if (bw) { ctx.lineWidth = bw; ctx.strokeStyle = border!; ctx.stroke(); }
    const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
    const cx = Math.round(insetX * px), cy = Math.round(insetY * px);
    const dx = cnv.width - cx, dy = cnv.height - cy;
    if (this.map.hasImage(id)) return;
    this.map.addImage(id, img as unknown as ImageData, { content: [cx, cy, dx, dy], stretchX: [[cx, dx]], stretchY: [[cy, dy]], pixelRatio: px } as never);
    this.addedImages.add(id);
  }

  setOverlay(id: string, data: FeatureCollection): void {
    (this.map.getSource(id) as { setData?: (d: FeatureCollection) => void } | undefined)?.setData?.(data);
    // `line-dasharray` is NOT data-driven, so push the per-feature dash pattern
    // (baked on the line features) onto the dash sub-layer's paint property.
    const dashId = `${id}__dash`;
    if (this.map.getLayer(dashId)) {
      const dash = data.features.find((f) => Array.isArray(f.properties?.["dash"]))?.properties?.["dash"] as number[] | undefined;
      if (dash && dash.length >= 2 && dash.every((n) => n > 0)) this.map.setPaintProperty(dashId, "line-dasharray", dash);
    }
  }

  setOverlayVisible(id: string, visible: boolean): void {
    const v = visible ? "visible" : "none";
    for (const lid of this.builtLayers) {
      if (!this.map.getLayer(lid)) continue;
      if (this.renderedToOverlay.get(lid) === id || lid === id || lid.startsWith(`${id}__`)) {
        this.map.setLayoutProperty(lid, "visibility", v);
      }
    }
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
      this.map.getContainer().appendChild(this.tooltipEl);
    } else if (style) {
      applyTooltipStyle(this.tooltipEl, style);
    }
    const p = this.map.project([at.lon, at.lat]);
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${p.x}px`;
    this.tooltipEl.style.top = `${p.y}px`;
  }

  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement {
    if (this.toolbarEl) return this.toolbarEl;
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group draw-adapter-toolbar";
    const snap = snapshotToolbarItem(options?.snapshot, {
      supported: this.snapshotSupported,
      snapshot: (o) => this.snapshot(o),
      flash: () => shutterFlash(this.map.getContainer()),
    });
    const full = fullscreenToolbarItem(options?.fullscreen, () => this.map.getContainer(), () => this.reframe());
    const lock = lockToolbarItem(options?.lock, (on) => this.setInteractive(on));
    const chrome = [snap, full, lock].filter((x): x is ToolbarItem => x != null);
    populateToolbar(el, [...items, ...chrome], options, () => refocusMap(this.map.getContainer()));
    this.map.getContainer().appendChild(el);
    this.toolbarEl = el;
    return el;
  }

  setActiveTool(id: string | null): void {
    if (this.toolbarEl) setToolbarActive(this.toolbarEl, id);
  }

  /** Capture the map as PNG, then apply `opts.target` (download/clipboard/none). The
   *  capture promise is handed to `deliverSnapshot` *pending* so a clipboard write fires
   *  synchronously within the click (gesture-safe). */
  snapshot(opts?: SnapshotOptions): Promise<Blob> {
    return deliverSnapshot(this.capture(opts), opts);
  }

  /**
   * Capture the GL canvas inside a render frame (no `preserveDrawingBuffer`
   * needed): listen for the next `render`, then read the canvas. `scale` defaults
   * to the current device-pixel-ratio (the canvas is already at that density);
   * a different `scale` re-draws the composition onto a resized canvas — a downscale
   * (`low`) is clean, an upscale (`medium`/`high`) is a best-effort enlargement.
   */
  private capture(opts?: SnapshotOptions): Promise<Blob> {
    const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const targetScale = opts?.scale ?? ratio;
    // Hide the requested overlays (editing chrome) just for this frame; restored once
    // the blob has been read off the GL canvas.
    const restore = opts?.hideOverlays?.length ? this.hideOverlays(opts.hideOverlays) : undefined;
    return new Promise<Blob>((resolve, reject) => {
      this.map.once("render", () => {
        const src = this.map.getCanvas();
        const cards = this.widgets?.snapshotCards() ?? [];
        const fail = (): void => { restore?.(); reject(new Error("snapshot failed")); };
        const done = (b: Blob | null): void => { restore?.(); b ? resolve(b) : reject(new Error("snapshot failed")); };
        const finish = (b: Blob): void => { restore?.(); resolve(b); };
        // Fast path: native scale and no widget cards ⇒ export the GL canvas directly.
        if (Math.abs(targetScale - ratio) < 1e-3 && !cards.length) {
          src.toBlob(done, "image/png");
          return;
        }
        // Copy the GL canvas onto a 2D canvas at the target resolution (a WebGL canvas has no
        // 2D context, so we need this to rescale and/or composite the widget cards). `src.width`
        // is device px (= css×ratio).
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round((src.width / ratio) * targetScale));
        out.height = Math.max(1, Math.round((src.height / ratio) * targetScale));
        const ctx = out.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(src, 0, 0, out.width, out.height);
        snapshotWithWidgets(out, cards, (ll) => this.project(ll), targetScale).then(finish, fail);
      });
      this.map.triggerRepaint();
    });
  }

  /** Hide every built layer belonging to the given overlay ids; returns a function that
   *  restores their previous `visibility`. Used to drop editing chrome from a snapshot. */
  private hideOverlays(overlayIds: string[]): () => void {
    const wanted = new Set(overlayIds);
    const saved: Array<[string, string | undefined]> = [];
    for (const [layerId, overlay] of this.renderedToOverlay) {
      if (!wanted.has(overlay) || !this.map.getLayer(layerId)) continue;
      const prev = this.map.getLayoutProperty(layerId, "visibility") as string | undefined;
      this.map.setLayoutProperty(layerId, "visibility", "none");
      saved.push([layerId, prev]);
    }
    return () => {
      for (const [id, prev] of saved) {
        if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", prev ?? "visible");
      }
    };
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
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: opts?.padding ?? 0 });
  }

  setProjection(projection: ProjectionSpec): void {
    if (projection === "mercator") { this.map.setProjection({ type: "mercator" }); return; }
    if (projection === "globe") { this.map.setProjection({ type: "globe" }); return; }
    // MapLibre has no arbitrary-CRS support (as of v5) — stay Mercator, warn once.
    warnOnce("draw-adapter (MapLibre): a custom proj4 projection is not supported; staying in Web Mercator. Use the OpenLayers adapter to reproject.");
  }

  viewArea(extent: LngLatBounds | null, opts?: { padding?: number; duration?: number }): void {
    if (!extent) { this.lastFit = undefined; this.detachResizeObserver(); return; } // release sticky framing
    this.lastFit = opts ? { extent, opts } : { extent };
    this.attachResizeObserver();
    this.applyFit(extent, opts);
  }

  /** The actual camera fit (dateline-aware); split out so {@link reframe} can re-run it on resize. */
  private applyFit(extent: LngLatBounds, opts?: { padding?: number; duration?: number }): void {
    const [w, s, e0, n] = extent;
    const e = unwrapEast(w, e0); // antimeridian-crossing bbox ⇒ one continuous span
    this.map.fitBounds([[w, s], [e, n]], {
      padding: opts?.padding ?? 0,
      ...(opts?.duration != null ? { duration: opts.duration } : {}),
    });
  }

  /** Resize the map to its container, then (if a {@link viewArea} is sticky) re-fit it instantly so the
   *  area stays framed to its extent + padding rather than just stretching to the new aspect ratio.
   *  Without a sticky framing this is just `map.resize()` — the previous fullscreen behaviour. */
  private reframe(): void {
    this.map.resize();
    if (this.lastFit) this.applyFit(this.lastFit.extent, { ...this.lastFit.opts, duration: 0 });
  }

  /** Observe the container so window / panel / fullscreen resizes re-frame a sticky area (debounced).
   *  Attached only while a framing is sticky (so without `viewArea` nothing new happens on resize). */
  private attachResizeObserver(): void {
    if (this.resizeObs || typeof ResizeObserver === "undefined") return;
    this.resizeObs = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.reframe(), 100); // coalesce a drag-resize burst
    });
    this.resizeObs.observe(this.map.getContainer());
  }

  private detachResizeObserver(): void {
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = undefined; }
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
  }

  highlightArea(extent: LngLatBounds | null, style?: HighlightStyle): void {
    if (!extent) {
      for (const id of [HL_FILL, HL_LINE]) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(HL_SOURCE)) this.map.removeSource(HL_SOURCE);
      this.applyOutsideEffects(null);
      return;
    }
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [densifyBboxRing(extent, 64)] } }],
    };
    const src = this.map.getSource(HL_SOURCE) as { setData?: (d: FeatureCollection) => void } | undefined;
    if (src?.setData) {
      src.setData(data);
    } else {
      // Insert BELOW the first drawing overlay (so: above basemap, below overlays).
      const beforeId = this.builtLayers.find((id) => this.map.getLayer(id));
      this.map.addSource(HL_SOURCE, { type: "geojson", data } as never);
      this.map.addLayer({ id: HL_FILL, type: "fill", source: HL_SOURCE, paint: { "fill-color": "#000", "fill-opacity": 0 } } as never, beforeId);
      this.map.addLayer({ id: HL_LINE, type: "line", source: HL_SOURCE, layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": "#666", "line-width": 1, "line-dasharray": [2, 2] } } as never, beforeId);
    }
    // (Re)apply the style every call (it may change between calls).
    if (this.map.getLayer(HL_LINE)) {
      this.map.setPaintProperty(HL_LINE, "line-color", style?.color ?? "#666");
      this.map.setPaintProperty(HL_LINE, "line-width", style?.width ?? 1);
      this.map.setPaintProperty(HL_LINE, "line-dasharray", style?.dash ?? [2, 2]);
    }
    if (this.map.getLayer(HL_FILL)) {
      this.map.setPaintProperty(HL_FILL, "fill-color", style?.fill ?? "#000");
      this.map.setPaintProperty(HL_FILL, "fill-opacity", style?.fill ? 1 : 0);
    }
    this.applyOutsideEffects(extent, style);
  }

  /**
   * Apply the "outside the area" effects of {@link HighlightStyle}: the native `dimOutside` (a GL
   * complement fill that follows the map) and the DOM `blurOutside` ({@link OutsideMask}, re-synced on
   * `move`). Called with `null` to tear both down. Absent options ⇒ no-op (current behaviour unchanged).
   */
  private applyOutsideEffects(extent: LngLatBounds | null, style?: HighlightStyle): void {
    this.maskExtent = extent;
    this.maskStyle = style;
    // DIM — native complement fill (rectangles tiling everything but the area); follows pan/zoom free.
    const dim = extent ? style?.dimOutside : undefined;
    if (dim) {
      const data: FeatureCollection = {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: complementRings(extent!).map((r) => [r]) } }],
      };
      const src = this.map.getSource(HL_DIM_SOURCE) as { setData?: (d: FeatureCollection) => void } | undefined;
      if (src?.setData) src.setData(data);
      else {
        // Above the frame/overlays (no beforeId) so the surroundings dim over everything below.
        this.map.addSource(HL_DIM_SOURCE, { type: "geojson", data } as never);
        this.map.addLayer({ id: HL_DIM, type: "fill", source: HL_DIM_SOURCE, paint: { "fill-color": dim, "fill-opacity": 1 } } as never);
      }
      if (this.map.getLayer(HL_DIM)) this.map.setPaintProperty(HL_DIM, "fill-color", dim);
    } else {
      if (this.map.getLayer(HL_DIM)) this.map.removeLayer(HL_DIM);
      if (this.map.getSource(HL_DIM_SOURCE)) this.map.removeSource(HL_DIM_SOURCE);
    }
    // BLUR — DOM overlay; NOT a layer, so re-place its clip on every view change.
    const blur = extent ? style?.blurOutside : undefined;
    if (blur && blur > 0) {
      // Canvas container (not the outer one): the control-container is a later sibling, so it keeps
      // painting above the blur ⇒ map controls stay crisp; only the canvas + markers around blur.
      this.outsideMask ??= new OutsideMask(this.map.getCanvasContainer(), "2");
      this.syncOutsideBlur();
      if (!this.maskMove) { this.maskMove = () => this.syncOutsideBlur(); this.map.on("move", this.maskMove); }
    } else {
      this.outsideMask?.hide();
      if (this.maskMove) { this.map.off("move", this.maskMove); this.maskMove = undefined; }
    }
  }

  /** Re-place the {@link OutsideMask} clip from the current view (the `move` callback for `blurOutside`). */
  private syncOutsideBlur(): void {
    const blur = this.maskExtent ? this.maskStyle?.blurOutside : undefined;
    if (!this.maskExtent || !blur || blur <= 0) return;
    const r = maskRect(this.maskExtent, (p) => this.project(p));
    if (r) this.outsideMask?.show(r, blur);
  }

  project(p: LatLng): [number, number] | null {
    const pt = this.map.project([p.lon, p.lat]);
    return [pt.x, pt.y];
  }

  unproject(px: [number, number]): LatLng | null {
    const c = this.map.unproject(px);
    return { lat: c.lat, lon: c.lng };
  }

  onViewChange(cb: () => void): void {
    if (this.viewHandler) this.map.off("moveend", this.viewHandler); // single slot — drop the previous so a re-call never leaks
    this.viewHandler = cb;
    this.map.on("moveend", cb);
  }

  setPanEnabled(enabled: boolean): void {
    this.panOn = enabled;
    if (this.locked) return; // lock wins; remembered for unlock
    if (enabled) this.map.dragPan.enable();
    else this.map.dragPan.disable();
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
    if (this.locked) {
      m.dragPan.disable(); m.scrollZoom.disable(); m.doubleClickZoom.disable();
      m.boxZoom.disable(); m.keyboard.disable(); m.dragRotate.disable(); m.touchZoomRotate.disable();
    } else {
      m.scrollZoom.enable(); m.boxZoom.enable(); m.keyboard.enable();
      m.dragRotate.enable(); m.touchZoomRotate.enable();
      this.panOn ? m.dragPan.enable() : m.dragPan.disable();      // restore the controller's request
      this.dblOn ? m.doubleClickZoom.enable() : m.doubleClickZoom.disable();
    }
  }

  setCursor(cursor: string): void {
    this.map.getCanvas().style.cursor = cursor;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    this.pointerCb = cb; // also feeds the widget layer's synthetic card events
    if (this.pointerHandlers) return;
    const emit =
      (type: PointerEvent["type"]): MlHandler =>
      (e) => {
        if (type === "down") this.dragging = true;
        // Recover a swallowed `up`: a move with NO button held means the press already ended
        // (e.g. the mouseup was eaten by a window-focusing gesture). Finalise so nothing sticks.
        if (type === "move" && this.dragging && e.originalEvent?.buttons === 0) {
          this.dragging = false;
          this.pressHit = undefined;
          this.pressDown = false;
          cb({ type: "up", lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent) });
        }
        const needHit = !(type === "move" && this.dragging);
        const hit = needHit ? this.hitAt(e.point) : undefined;
        if (type === "down") {
          this.pressHit = hit;
          this.pressX = e.point.x;
          this.pressY = e.point.y;
          this.pressDown = true;
          this.justSynthClick = false;
        }
        if (type === "move" && !this.dragging) this.setCursor(cursorForHit(hit));
        cb({ type, lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent), ...(hit ? { hit } : {}) });
      };
    // Emit `click` ourselves from the release (a `down`+`up` at one spot), reusing the `down` hit,
    // rather than MapLibre's native `click` — which the OS can swallow on the first click after
    // re-focusing the window, leaving the consumer's selection de-confirmed (select→deselect).
    const onUp: MlHandler = (e) => {
      this.dragging = false;
      const moved = !this.pressDown
        || Math.abs(e.point.x - this.pressX) > 3
        || Math.abs(e.point.y - this.pressY) > 3;
      cb({ type: "up", lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent) });
      if (this.pressDown && !moved) {
        cb({ type: "click", lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent), ...(this.pressHit ? { hit: this.pressHit } : {}) });
        this.justSynthClick = true;
      }
      this.pressDown = false;
    };
    // Touch fallback: a tap fires MapLibre's native `click` but NO `mouseup`, so the release-
    // synthesized click above never fires. Emit from the native click, deduped against the mouse
    // path (where `mouseup` already synthesized one) via the `justSynthClick` flag.
    const onNativeClick: MlHandler = (e) => {
      if (this.justSynthClick) { this.justSynthClick = false; return; }
      const hit = this.hitAt(e.point);
      cb({ type: "click", lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent), ...(hit ? { hit } : {}) });
    };
    const onContext: MlHandler = (e) => {
      (e as { preventDefault?: () => void }).preventDefault?.(); // suppress the browser menu
      const hit = this.hitAt(e.point);
      cb({ type: "contextmenu", lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...modifiers(e.originalEvent), ...(hit ? { hit } : {}) });
    };
    const handlers: PointerHandlers = {
      mousedown: emit("down"),
      mousemove: emit("move"),
      mouseup: onUp,
      click: onNativeClick,
      dblclick: emit("dblclick"),
      contextmenu: onContext,
    };
    this.map.on("mousedown", handlers.mousedown);
    this.map.on("mousemove", handlers.mousemove);
    this.map.on("mouseup", handlers.mouseup);
    this.map.on("click", handlers.click);
    this.map.on("dblclick", handlers.dblclick);
    this.map.on("contextmenu", handlers.contextmenu);
    this.pointerHandlers = handlers;
    if (typeof window !== "undefined") {
      const windowUp = (e: MouseEvent): void => {
        if (!this.dragging) return;
        this.dragging = false;
        this.pressDown = false;
        cb({ type: "up", lngLat: { lat: 0, lon: 0 }, ...modifiers(e) });
      };
      window.addEventListener("mouseup", windowUp);
      this.windowUp = windowUp;
      // Leaving the window mid-press loses the `up`; purge press state so the first click back
      // (the focusing click) starts clean instead of inheriting a stale drag/hit.
      const windowBlur = (): void => { this.dragging = false; this.pressHit = undefined; this.pressDown = false; };
      window.addEventListener("blur", windowBlur);
      this.windowBlur = windowBlur;
    }
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
          const el = document.createElement("div");
          const marker = new MaplibreMarker({ element: el, anchor: "top-left" })
            .setLngLat([anchor.lon, anchor.lat])
            .addTo(map);
          return {
            el,
            setAnchor: (a) => { marker.setLngLat([a.lon, a.lat]); },
            remove: () => { marker.remove(); },
            setZIndex: (z) => { if (el.parentElement) el.parentElement.style.zIndex = z > 0 ? String(z) : ""; },
          };
        },
        unprojectClient: (cx, cy) => {
          const r = map.getContainer().getBoundingClientRect();
          const c = map.unproject([cx - r.left, cy - r.top]);
          return { lat: c.lat, lon: c.lng };
        },
        emit: (ev) => this.pointerCb?.(ev),
        focus: () => refocusMap(this.map.getContainer()),
      });
    }
    return this.widgets;
  }

  setWidgets(widgets: MarkerWidget[]): void {
    // Split read-only `static` widgets (native sprite icons) from live DOM cards: each path diffs by
    // id, so toggling `static` moves a widget cleanly from one to the other.
    const dom: MarkerWidget[] = [];
    const sprites: MarkerWidget[] = [];
    for (const w of widgets) (w.static ? sprites : dom).push(w);
    this.widgetLayer().setWidgets(dom);
    this.updateSprites(sprites);
  }
  onWidgetEdit(cb: (e: WidgetEdit) => void): void { this.widgetLayer().onWidgetEdit(cb); }
  onWidgetDelete(cb: (e: { id: string }) => void): void { this.widgetLayer().onWidgetDelete(cb); }
  onWidgetAction(cb: (e: { id: string; event: string }) => void): void { this.widgetLayer().onWidgetAction(cb); }
  setCoordFormat(fn: (ll: LatLng) => string): void { this.coordFmt = fn; this.widgetLayer().setCoordFormat(fn); }

  /** Add the sprite source + symbol layer once (lazy: only when a `static` widget appears). The layer
   *  is mapped to {@link WSPRITE_HIT_OVERLAY} so its features hit-test like canvas call-outs. */
  private ensureSpriteLayer(): void {
    if (this.spriteLayerBuilt) return;
    if (!this.map.getSource(WSPRITE_SOURCE)) this.map.addSource(WSPRITE_SOURCE, { type: "geojson", data: EMPTY_FC } as never);
    this.map.addLayer({
      id: WSPRITE_LAYER,
      type: "symbol",
      source: WSPRITE_SOURCE,
      layout: {
        "icon-image": ["coalesce", ["get", "icon"], ""],
        "icon-size": 1, // image is baked at pixelRatio=dpr ⇒ 1 ⇒ its CSS WxH, screen-fixed at any zoom
        "icon-anchor": ["coalesce", ["get", "iconAnchor"], "center"],
        "icon-allow-overlap": true,    // collision is the consumer's placement pass, not MapLibre's
        "icon-ignore-placement": true,
      },
    } as never);
    this.track(WSPRITE_LAYER, WSPRITE_HIT_OVERLAY);
    this.spriteLayerBuilt = true;
  }

  /**
   * Rasterize each `static` widget to a native icon and push them as point features (props
   * `{ featureId, labelId }`) into the sprite layer. Async (glyph rasterization) and token-guarded so
   * a newer call wins; the image texture is only (re)uploaded when the sprite actually changed.
   */
  private updateSprites(widgets: MarkerWidget[]): void {
    if (!widgets.length && !this.lastSpriteRef.size && !this.spriteLayerBuilt) return; // never used → no-op
    const token = ++this.spriteToken;
    const run = async (): Promise<void> => {
      const container = this.map.getContainer();
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const features: Feature[] = [];
      const seen = new Set<string>();
      for (const w of widgets) {
        seen.add(w.id);
        const res = await rasterizeWidget(w, { dpr, coordFmt: this.coordFmt, container });
        if (token !== this.spriteToken) return; // superseded mid-flight
        if (!res) continue;
        const imgId = `__dap-wsprite|${w.id}`;
        if (this.lastSpriteRef.get(w.id) !== res || !this.map.hasImage(imgId)) {
          const ctx = res.canvas.getContext("2d");
          const data = ctx?.getImageData(0, 0, res.canvas.width, res.canvas.height);
          if (data) {
            if (this.map.hasImage(imgId)) this.map.removeImage(imgId); // re-add to refresh pixels/pixelRatio
            this.map.addImage(imgId, data as unknown as ImageData, { pixelRatio: res.dpr } as never);
            this.spriteImageIds.add(imgId);
            this.lastSpriteRef.set(w.id, res);
          }
        }
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [w.anchor.lon, w.anchor.lat] },
          properties: {
            featureId: w.id,
            labelId: w.labelId ?? "l",
            icon: imgId,
            iconAnchor: spriteAnchor(w.origin),
          },
        });
      }
      if (token !== this.spriteToken) return;
      // Drop images + cache for widgets that are gone.
      for (const id of Array.from(this.lastSpriteRef.keys())) {
        if (seen.has(id)) continue;
        this.lastSpriteRef.delete(id);
        clearSpriteCache(id);
        const im = `__dap-wsprite|${id}`;
        if (this.map.hasImage(im)) this.map.removeImage(im);
        this.spriteImageIds.delete(im);
      }
      this.ensureSpriteLayer();
      (this.map.getSource(WSPRITE_SOURCE) as { setData?: (d: FeatureCollection) => void } | undefined)
        ?.setData?.({ type: "FeatureCollection", features });
    };
    void run().catch(() => { /* a failed rasterization just leaves the prior sprites in place */ });
  }

  destroy(): void {
    const h = this.pointerHandlers;
    if (h) {
      this.map.off("mousedown", h.mousedown);
      this.map.off("mousemove", h.mousemove);
      this.map.off("mouseup", h.mouseup);
      this.map.off("click", h.click);
      this.map.off("dblclick", h.dblclick);
      this.map.off("contextmenu", h.contextmenu);
      this.pointerHandlers = undefined;
    }
    if (this.windowUp && typeof window !== "undefined") {
      window.removeEventListener("mouseup", this.windowUp);
      this.windowUp = undefined;
    }
    if (this.windowBlur && typeof window !== "undefined") {
      window.removeEventListener("blur", this.windowBlur);
      this.windowBlur = undefined;
    }
    if (this.blurListener && typeof window !== "undefined") {
      window.removeEventListener("blur", this.blurListener);
      this.blurListener = undefined;
    }
    this.pressHit = undefined;
    this.keyCleanup?.();
    this.keyCleanup = undefined;
    if (this.viewHandler) {
      this.map.off("moveend", this.viewHandler);
      this.viewHandler = undefined;
    }
    if (this.imgMissing) {
      this.map.off("styleimagemissing", this.imgMissing);
      this.imgMissing = undefined;
    }
    this.detachResizeObserver();
    this.lastFit = undefined;
    if (this.maskMove) { this.map.off("move", this.maskMove); this.maskMove = undefined; }
    this.outsideMask?.hide();
    this.outsideMask = undefined;
    for (const id of [HL_FILL, HL_LINE, HL_DIM]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of [HL_SOURCE, HL_DIM_SOURCE]) if (this.map.getSource(id)) this.map.removeSource(id);
    for (const id of this.builtLayers) if (this.map.getLayer(id)) this.map.removeLayer(id);
    this.builtLayers.length = 0;
    this.renderedToOverlay.clear();
    // Remove EVERY image we baked into the host map (bare ids, colour tints, data icons, sprites).
    for (const id of this.addedImages) if (this.map.hasImage(id)) this.map.removeImage(id);
    this.addedImages.clear();
    for (const id of this.spriteImageIds) if (this.map.hasImage(id)) this.map.removeImage(id);
    this.spriteImageIds.clear();
    for (const id of this.lastSpriteRef.keys()) clearSpriteCache(id);
    this.lastSpriteRef.clear();
    this.spriteLayerBuilt = false;
    this.spriteSvgs = {};
    if (this.map.getSource(WSPRITE_SOURCE)) this.map.removeSource(WSPRITE_SOURCE);
    for (const id of this.overlayIds) if (this.map.getSource(id)) this.map.removeSource(id);
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.widgets?.destroy();
    this.widgets = undefined;
    this.pointerCb = undefined;
    this.readyPromise = undefined;
    this.setCursor("");
    if (this.locked) this.setInteractive(true); // unlock the host map on teardown
    this.locked = false;
    this.panOn = this.dblOn = true;
    this.map.dragPan.enable();
    this.map.doubleClickZoom.enable(); // re-enable in case we were torn down mid-draw
  }

  private hitAt(point: { x: number; y: number }): Hit | undefined {
    const layers = this.builtLayers.filter((id) => this.map.getLayer(id));
    const pad = 5; // pad into a small box so thin lines are easy to hit
    const box: [[number, number], [number, number]] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ];
    const hittable = this.opts.hitOverlays;
    for (const found of this.map.queryRenderedFeatures(box, { layers })) {
      const overlay = this.renderedToOverlay.get(found.layer.id);
      if (overlay && (hittable?.has(overlay) ?? true)) {
        return { overlay, props: (found.properties ?? {}) as Record<string, unknown> };
      }
    }
    return undefined;
  }

  private track(layerId: string, overlay: string): void {
    this.builtLayers.push(layerId);
    this.renderedToOverlay.set(layerId, overlay);
  }

  private iconImageExpr(): unknown {
    return [
      "case",
      ["has", "icon"], ["get", "icon"],
      ["has", "symbol"], ["concat", ["get", "symbol"], "|", ["coalesce", ["get", "symbolColor"], this.opts.defaultSymbolColor]],
      "",
    ];
  }

  private addOverlays(): void {
    for (const id of this.overlayIds) {
      if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: EMPTY_FC });
    }
    for (const spec of this.opts.layers) {
      switch (spec.kind) {
        case "fill":
          this.map.addLayer({
            id: spec.id,
            type: "fill",
            source: spec.id,
            paint: {
              "fill-color": ["coalesce", ["get", "fillColor"], "#888"],
              "fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.2],
            },
          });
          this.track(spec.id, spec.id);
          // Optional outline for fills that carry a `stroke`.
          this.map.addLayer({
            id: `${spec.id}__stroke`,
            type: "line",
            source: spec.id,
            filter: ["has", "stroke"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "stroke"], "#333"],
              "line-width": ["coalesce", ["get", "strokeWidth"], 1],
              "line-opacity": ["coalesce", ["get", "strokeOpacity"], 1],
            },
          });
          this.track(`${spec.id}__stroke`, spec.id);
          break;
        case "line": {
          // Filled polygons living in a line source (e.g. wind-barb saw teeth).
          this.map.addLayer({
            id: `${spec.id}__fill`,
            type: "fill",
            source: spec.id,
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-color": ["coalesce", ["get", "fillColor"], ["get", "stroke"], "#333"] },
          });
          this.track(`${spec.id}__fill`, spec.id);
          this.map.addLayer({
            id: spec.id,
            type: "line",
            source: spec.id,
            filter: ["!", ["has", "dash"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "stroke"], "#333"],
              "line-width": ["coalesce", ["get", "strokeWidth"], 2],
              "line-opacity": ["coalesce", ["get", "strokeOpacity"], 1],
            },
          });
          this.track(spec.id, spec.id);
          const dashId = `${spec.id}__dash`;
          this.map.addLayer({
            id: dashId,
            type: "line",
            source: spec.id,
            filter: ["has", "dash"],
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "stroke"], "#333"],
              "line-width": ["coalesce", ["get", "strokeWidth"], 2],
              "line-dasharray": [2, 1.5],
              "line-opacity": ["coalesce", ["get", "strokeOpacity"], 1],
            },
          });
          this.track(dashId, spec.id);
          break;
        }
        case "symbol":
          this.bindImageMissing();
          this.map.addLayer({
            id: spec.id,
            type: "symbol",
            source: spec.id,
            layout: {
              "icon-image": this.iconImageExpr() as never,
              "icon-size": ["coalesce", ["get", "size"], 1],
              "icon-rotate": ["coalesce", ["get", "rotation"], 0],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
          this.track(spec.id, spec.id);
          break;
        case "text":
          this.bindImageMissing(); // label boxes are materialized lazily per (bg|border|size|radius)
          this.map.addLayer({
            id: spec.id,
            type: "symbol",
            source: spec.id,
            layout: {
              // Frame labels carrying a `textBackground`/`textBorder` with a per-feature box
              // image (padding/border/radius baked in), stretched to fit the text. The box
              // rotates with the text (`icon-rotate` = `rotation`).
              "icon-image": this.calloutImageExpr() as never,
              "icon-text-fit": "both",
              "icon-rotate": ["coalesce", ["get", "rotation"], 0],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "text-field": ["coalesce", ["get", "text"], ""],
              "text-size": ["coalesce", ["get", "textSize"], 13],
              "text-anchor": "center",
              "text-rotate": ["coalesce", ["get", "rotation"], 0],
              // `text-max-width` is in EMS, but `maxWidth` is in PIXELS (to match the
              // OL/Leaflet wrap). Convert: ems = px / fontPx. (Default 130px/13 = 10em.)
              "text-max-width": ["/", ["coalesce", ["get", "maxWidth"], 130], ["coalesce", ["get", "textSize"], 13]],
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "text-color": ["coalesce", ["get", "textColor"], "#111"],
              "text-halo-color": ["coalesce", ["get", "textHalo"], "#fff"],
              "text-halo-width": 2.5,
            },
          });
          this.track(spec.id, spec.id);
          break;
        case "circle": {
          this.bindImageMissing();
          this.map.addLayer({
            id: spec.id,
            type: "circle",
            source: spec.id,
            paint: {
              "circle-radius": ["coalesce", ["get", "radius"], 5],
              "circle-color": ["coalesce", ["get", "fill"], "#ffffff"],
              "circle-stroke-color": ["coalesce", ["get", "stroke"], "#58a6ff"],
              "circle-stroke-width": ["coalesce", ["get", "strokeWidth"], 2],
            },
          });
          this.track(spec.id, spec.id);
          // Rotatable handle icon drawn over the dot (move/transform/resize, …).
          const iconId = `${spec.id}__icon`;
          this.map.addLayer({
            id: iconId,
            type: "symbol",
            source: spec.id,
            filter: ["any", ["has", "icon"], ["has", "symbol"]],
            layout: {
              "icon-image": this.iconImageExpr() as never,
              "icon-size": ["coalesce", ["get", "size"], 1],
              "icon-rotate": ["coalesce", ["get", "iconRotate"], ["get", "rotation"], 0],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
          this.track(iconId, spec.id);
          break;
        }
      }
    }
  }
}
