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
import type { FeatureCollection } from "geojson";
// maplibre-gl v5 ships a UMD/CJS `main` with NO `module`/`exports` field and no
// default export, so `import { Map } from "maplibre-gl"` throws under Node ESM
// ("Named export 'Map' not found"). Import the namespace and resolve the ctor at
// runtime (handles both the CJS-interop default and a future ESM named export).
// `import type` is erased, so the type alias stays a clean named type import.
import type { Map as MapLibreMap, MapOptions } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";

type MapLibreMapCtor = new (options: MapOptions) => MapLibreMap;
const MaplibreMap: MapLibreMapCtor = ((ns: { Map?: MapLibreMapCtor; default?: { Map: MapLibreMapCtor } }) =>
  ns.Map ?? ns.default!.Map)(maplibregl as never);

import type {
  AdapterOptions,
  Hit,
  LatLng,
  MapAdapter,
  PointerEvent,
  SnapshotOptions,
  SymbolSprites,
  ToolbarItem,
  ToolbarOptions,
  TooltipStyle,
} from "./index.js";
import { cursorForHit, EMPTY_FC } from "./index.js";
import { colorizeSprite, loadSpriteImage, SPRITE_PX } from "./symbols.js";
import { populateToolbar } from "./toolbar.js";
import { deliverSnapshot, shutterFlash, snapshotToolbarItem } from "./snapshot.js";
import { applyTooltipStyle } from "./tooltip.js";

type MlHandler = (e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => void;
interface PointerHandlers {
  mousedown: MlHandler;
  mousemove: MlHandler;
  mouseup: MlHandler;
  click: MlHandler;
  dblclick: MlHandler;
}

export type Projection = "mercator" | "globe";

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

export class MapLibreAdapter implements MapAdapter {
  /** MapLibre exposes the WebGL canvas → snapshot is supported. */
  protected readonly snapshotSupported = true;
  private readonly map: MapLibreMap;
  private readonly opts: Required<Omit<AdapterOptions, "hitOverlays">> & Pick<AdapterOptions, "hitOverlays">;
  private readonly overlayIds: string[];
  private readyPromise: Promise<void> | undefined;
  /** rendered MapLibre layer id → overlay id (for hit-testing). */
  private readonly renderedToOverlay = new Map<string, string>();
  private readonly builtLayers: string[] = [];
  private pointerHandlers: PointerHandlers | undefined;
  private windowUp: ((e: MouseEvent) => void) | undefined;
  private viewHandler: (() => void) | undefined;
  private toolbarEl: HTMLElement | undefined;
  private tooltipEl: HTMLElement | undefined;
  private tooltipStyle: TooltipStyle | undefined;
  private dragging = false;
  /** Raw sprite SVGs (`currentColor`), re-tinted per feature into `symbol|colour` images. */
  private spriteSvgs: Record<string, string> = {};
  /** EVERY image id we added to the host map (bare ids, `id|colour` tints, `data:`
   *  icons), so `destroy()` removes them all — not just the bare sprite ids. */
  private readonly addedImages = new Set<string>();
  /** Image ids currently being rasterized (deduplicates `styleimagemissing`). */
  private readonly pendingImages = new Set<string>();
  private imgMissing: ((e: { id: string }) => void) | undefined;

  constructor(opts: { map: MapLibreMap } & AdapterOptions) {
    this.map = opts.map;
    this.opts = {
      layers: opts.layers,
      spritePx: opts.spritePx ?? SPRITE_PX,
      defaultSymbolColor: opts.defaultSymbolColor ?? "#000000",
      ...(opts.hitOverlays ? { hitOverlays: opts.hitOverlays } : {}),
    };
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
    populateToolbar(el, snap ? [...items, snap] : items, options);
    this.map.getContainer().appendChild(el);
    this.toolbarEl = el;
    return el;
  }

  /** Capture the map as PNG, then apply `opts.target` (download/clipboard/none). */
  snapshot(opts?: SnapshotOptions): Promise<Blob> {
    return this.capture(opts).then((b) => deliverSnapshot(b, opts));
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
    // `basemap: false` ⇒ hide every layer that isn't ours so the GL canvas keeps only
    // our overlays on a transparent background; restored once the blob is read.
    const restore = opts?.basemap === false ? this.hideBasemap() : undefined;
    return new Promise<Blob>((resolve, reject) => {
      this.map.once("render", () => {
        const src = this.map.getCanvas();
        const fail = (): void => { restore?.(); reject(new Error("snapshot failed")); };
        const done = (b: Blob | null): void => { restore?.(); b ? resolve(b) : reject(new Error("snapshot failed")); };
        // Native: the canvas is already at `ratio` px/CSS-px — export it directly.
        if (Math.abs(targetScale - ratio) < 1e-3) {
          src.toBlob(done, "image/png");
          return;
        }
        // Re-scale to the requested pixel-ratio. `src.width` is device px (= css×ratio).
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round((src.width / ratio) * targetScale));
        out.height = Math.max(1, Math.round((src.height / ratio) * targetScale));
        const ctx = out.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(src, 0, 0, out.width, out.height);
        out.toBlob(done, "image/png");
      });
      this.map.triggerRepaint();
    });
  }

  /** Hide every style layer that isn't one of ours (basemap, background, …); returns a
   *  function that restores their previous `visibility`. Used for basemap-less snapshots. */
  private hideBasemap(): () => void {
    const ours = new Set(this.builtLayers);
    const saved: Array<[string, string | undefined]> = [];
    for (const layer of this.map.getStyle().layers ?? []) {
      if (ours.has(layer.id)) continue;
      const prev = this.map.getLayoutProperty(layer.id, "visibility") as string | undefined;
      this.map.setLayoutProperty(layer.id, "visibility", "none");
      saved.push([layer.id, prev]);
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

  project(p: LatLng): [number, number] | null {
    const pt = this.map.project([p.lon, p.lat]);
    return [pt.x, pt.y];
  }

  unproject(px: [number, number]): LatLng | null {
    const c = this.map.unproject(px);
    return { lat: c.lat, lon: c.lng };
  }

  onViewChange(cb: () => void): void {
    this.viewHandler = cb;
    this.map.on("moveend", cb);
  }

  setPanEnabled(enabled: boolean): void {
    if (enabled) this.map.dragPan.enable();
    else this.map.dragPan.disable();
  }

  setDoubleClickZoom(enabled: boolean): void {
    if (enabled) this.map.doubleClickZoom.enable();
    else this.map.doubleClickZoom.disable();
  }

  setCursor(cursor: string): void {
    this.map.getCanvas().style.cursor = cursor;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    if (this.pointerHandlers) return;
    const emit =
      (type: PointerEvent["type"]): MlHandler =>
      (e) => {
        if (type === "down") this.dragging = true;
        else if (type === "up") this.dragging = false;
        const needHit = type !== "up" && !(type === "move" && this.dragging);
        const hit = needHit ? this.hitAt(e.point) : undefined;
        if (type === "move" && !this.dragging) this.setCursor(cursorForHit(hit));
        cb({ type, lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...(hit ? { hit } : {}) });
      };
    const handlers: PointerHandlers = {
      mousedown: emit("down"),
      mousemove: emit("move"),
      mouseup: emit("up"),
      click: emit("click"),
      dblclick: emit("dblclick"),
    };
    this.map.on("mousedown", handlers.mousedown);
    this.map.on("mousemove", handlers.mousemove);
    this.map.on("mouseup", handlers.mouseup);
    this.map.on("click", handlers.click);
    this.map.on("dblclick", handlers.dblclick);
    this.pointerHandlers = handlers;
    if (typeof window !== "undefined") {
      const windowUp = (): void => {
        if (!this.dragging) return;
        this.dragging = false;
        cb({ type: "up", lngLat: { lat: 0, lon: 0 } });
      };
      window.addEventListener("mouseup", windowUp);
      this.windowUp = windowUp;
    }
  }

  destroy(): void {
    const h = this.pointerHandlers;
    if (h) {
      this.map.off("mousedown", h.mousedown);
      this.map.off("mousemove", h.mousemove);
      this.map.off("mouseup", h.mouseup);
      this.map.off("click", h.click);
      this.map.off("dblclick", h.dblclick);
      this.pointerHandlers = undefined;
    }
    if (this.windowUp && typeof window !== "undefined") {
      window.removeEventListener("mouseup", this.windowUp);
      this.windowUp = undefined;
    }
    if (this.viewHandler) {
      this.map.off("moveend", this.viewHandler);
      this.viewHandler = undefined;
    }
    if (this.imgMissing) {
      this.map.off("styleimagemissing", this.imgMissing);
      this.imgMissing = undefined;
    }
    for (const id of this.builtLayers) if (this.map.getLayer(id)) this.map.removeLayer(id);
    this.builtLayers.length = 0;
    this.renderedToOverlay.clear();
    // Remove EVERY image we baked into the host map (bare ids, colour tints, data icons).
    for (const id of this.addedImages) if (this.map.hasImage(id)) this.map.removeImage(id);
    this.addedImages.clear();
    this.spriteSvgs = {};
    for (const id of this.overlayIds) if (this.map.getSource(id)) this.map.removeSource(id);
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.readyPromise = undefined;
    this.setCursor("");
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
          this.map.addLayer({
            id: spec.id,
            type: "symbol",
            source: spec.id,
            layout: {
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
