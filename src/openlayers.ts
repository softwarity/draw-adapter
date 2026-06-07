/**
 * OpenLayers adapter — grafts onto a host-owned `ol/Map`. Per-overlay style
 * functions read the same feature render-props as the MapLibre adapter, so the
 * engines render identically. Glyphs use `ol/style/Icon` (sprite or data-URI);
 * text boxes use OL's native `backgroundFill`/`backgroundStroke`.
 *
 * The manifest (`layers`) and the hit-testable set (`hitOverlays`) are supplied
 * by the consumer; this adapter knows no domain type.
 */
// NB: VALUE imports from `ol/*` MUST end in `.js`. `ol` ships ESM with NO package
// `exports` map (`type: "module"`), so under Node ESM a bare `"ol/Map"` resolves
// to the *directory* and throws ERR_UNSUPPORTED_DIR_IMPORT. tsc does not rewrite
// specifiers; bundlers hide this, Node does not. `import type` is erased, so the
// type-only `ol/*` imports below need no `.js`.
import type { FeatureCollection } from "geojson";
import type { FeatureLike } from "ol/Feature";
import type { EventsKey } from "ol/events";
import { getHeight, getWidth } from "ol/extent.js";
import GeoJSON from "ol/format/GeoJSON.js";
import DragPan from "ol/interaction/DragPan.js";
import DoubleClickZoom from "ol/interaction/DoubleClickZoom.js";
import type BaseLayer from "ol/layer/Base";
import VectorLayer from "ol/layer/Vector.js";
import OlMap from "ol/Map.js";
import { unByKey } from "ol/Observable.js";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import VectorSource from "ol/source/Vector.js";
import TileLayer from "ol/layer/Tile.js";
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from "ol/style.js";
import type { StyleLike } from "ol/style/Style";
import View from "ol/View.js";

import type {
  AdapterOptions,
  Hit,
  LatLng,
  LayerKind,
  MapAdapter,
  PointerEvent,
  SnapshotOptions,
  SymbolSprites,
  ToolbarItem,
  ToolbarOptions,
  TooltipStyle,
} from "./index.js";
import { cursorForHit } from "./index.js";
import { num, str, rgba, deg2rad, wrapLabel } from "./coerce.js";
import { colorizeSprite, svgToDataUrl, SPRITE_PX } from "./symbols.js";
import { populateToolbar } from "./toolbar.js";
import { deliverSnapshot, shutterFlash, snapshotToolbarItem } from "./snapshot.js";
import { applyTooltipStyle } from "./tooltip.js";

/** True when a hit is something the user grabs to drag (any handle/guide carrying
 *  a `role`). Construction guides (no role) and plain fills are not draggable. */
function isDraggableHit(hit: Hit): boolean {
  return hit.props["role"] != null;
}

/** Batteries-included host map (headless hosts pass their own `map` instead). */
export function createOpenLayersMap(opts: { container: HTMLElement | string; center: [number, number]; zoom: number }): OlMap {
  return new OlMap({
    target: opts.container,
    layers: [new TileLayer({ source: new OSM() })],
    view: new View({ center: fromLonLat(opts.center), zoom: opts.zoom }),
  });
}

export class OpenLayersAdapter implements MapAdapter {
  /** OpenLayers composites onto `<canvas>` layers → snapshot is supported. */
  protected readonly snapshotSupported = true;
  private readonly map: OlMap;
  private readonly opts: Required<Omit<AdapterOptions, "hitOverlays">> & Pick<AdapterOptions, "hitOverlays">;
  private readonly kindOf: Map<string, LayerKind>;
  /** overlay id → manifest z-index (higher = drawn on top), for hit priority. */
  private readonly zOf: Map<string, number>;
  private readonly sources = new Map<string, VectorSource>();
  private readonly layers = new Map<string, VectorLayer>();
  private readonly layerOverlay = new Map<unknown, string>();
  private readonly format = new GeoJSON();
  private readonly iconCache = new Map<string, Icon>();
  private sprites: Record<string, string> = {}; // sprite id → raw SVG (re-tinted per feature)
  private dragPan: DragPan | undefined;
  private dblClickZoom: DoubleClickZoom | undefined;
  private readyPromise: Promise<void> | undefined;
  private tooltipStyle: TooltipStyle | undefined;
  private olKeys: EventsKey[] = [];
  private domPointerUp: ((e: globalThis.PointerEvent) => void) | undefined;
  private viewportPointerDown: ((e: globalThis.PointerEvent) => void) | undefined;
  private toolbarEl: HTMLElement | undefined;
  private tooltipEl: HTMLElement | undefined;
  private dragging = false;

  constructor(opts: { map: OlMap } & AdapterOptions) {
    this.map = opts.map;
    this.opts = {
      layers: opts.layers,
      spritePx: opts.spritePx ?? SPRITE_PX,
      defaultSymbolColor: opts.defaultSymbolColor ?? "#000000",
      ...(opts.hitOverlays ? { hitOverlays: opts.hitOverlays } : {}),
    };
    this.kindOf = new Map(opts.layers.map((l) => [l.id, l.kind]));
    this.zOf = new Map(opts.layers.map((l, i) => [l.id, i]));
  }

  registerSymbols(sprites: SymbolSprites): Promise<void> {
    for (const [id, svg] of Object.entries(sprites)) {
      this.sprites[id] = svg; // keep the raw SVG; colour is baked on demand
      for (const key of [...this.iconCache.keys()]) if (key.startsWith(`${id}|`)) this.iconCache.delete(key);
    }
    for (const [id, kind] of this.kindOf) if (kind === "symbol" || kind === "circle") this.layers.get(id)?.changed();
    return Promise.resolve();
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      for (const spec of this.opts.layers) {
        const source = new VectorSource();
        this.sources.set(spec.id, source);
        const layer = new VectorLayer({ source, style: this.styleFor(spec.kind) });
        this.layers.set(spec.id, layer);
        this.layerOverlay.set(layer, spec.id);
        this.map.addLayer(layer);
      }
      const interactions = this.map.getInteractions().getArray();
      this.dragPan = interactions.find((i): i is DragPan => i instanceof DragPan);
      this.dblClickZoom = interactions.find((i): i is DoubleClickZoom => i instanceof DoubleClickZoom);
      this.readyPromise = Promise.resolve();
    }
    return this.readyPromise;
  }

  setOverlay(id: string, data: FeatureCollection): void {
    const source = this.sources.get(id);
    if (!source) return;
    source.clear();
    if (data.features.length) {
      source.addFeatures(this.format.readFeatures(data, { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }));
    }
  }

  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement {
    if (this.toolbarEl) return this.toolbarEl;
    const el = document.createElement("div");
    el.className = "ol-control draw-adapter-toolbar";
    const snap = snapshotToolbarItem(options?.snapshot, {
      supported: this.snapshotSupported,
      snapshot: (o) => this.snapshot(o),
      flash: () => shutterFlash(this.map.getViewport()),
    });
    populateToolbar(el, snap ? [...items, snap] : items, options);
    this.map.getTargetElement()?.appendChild(el);
    this.toolbarEl = el;
    return el;
  }

  /** Capture the map as PNG, then apply `opts.target` (download/clipboard/none). The
   *  capture promise is handed to `deliverSnapshot` *pending* so a clipboard write fires
   *  synchronously within the click (gesture-safe). */
  snapshot(opts?: SnapshotOptions): Promise<Blob> {
    return deliverSnapshot(this.capture(opts), opts);
  }

  /**
   * Compose every visible layer canvas onto one target canvas inside a
   * `rendercomplete` frame (OpenLayers' official "export map" pattern). `scale`
   * defaults to the device-pixel-ratio (OL already renders at that density);
   * the target canvas is `getSize() × scale` and each layer's CSS transform is
   * pre-multiplied by `scale`, so `low` stays at CSS resolution and `medium`/`high`
   * supersample (best-effort).
   */
  private capture(opts?: SnapshotOptions): Promise<Blob> {
    const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const targetScale = opts?.scale ?? ratio;
    const size = this.map.getSize();
    if (!size) return Promise.reject(new Error("snapshot failed: map has no size"));
    // Hide the requested overlays (editing chrome) so they aren't composited; restored
    // after (the compositing into the target canvas is synchronous).
    const restore = opts?.hideOverlays?.length ? this.hideOverlays(opts.hideOverlays) : undefined;
    return new Promise<Blob>((resolve, reject) => {
      const settle = (run: () => void): void => { try { run(); } finally { restore?.(); } };
      this.map.once("rendercomplete", () => settle(() => {
        try {
          const out = document.createElement("canvas");
          out.width = Math.max(1, Math.round(size[0]! * targetScale));
          out.height = Math.max(1, Math.round(size[1]! * targetScale));
          const ctx = out.getContext("2d");
          if (!ctx) return reject(new Error("snapshot failed"));
          const viewport = this.map.getViewport();
          const canvases = viewport.querySelectorAll<HTMLCanvasElement>(".ol-layer canvas, canvas.ol-layer");
          canvases.forEach((canvas) => {
            if (canvas.width === 0) return;
            const parent = canvas.parentNode as HTMLElement | null;
            const opacity = parent?.style.opacity ?? canvas.style.opacity;
            ctx.globalAlpha = opacity === "" || opacity == null ? 1 : Number(opacity);
            // The layer canvas (device px) carries a CSS `matrix(...)` mapping it to
            // CSS px. Pre-multiply by `targetScale` to land in the target's pixels.
            const m = /^matrix\(([^)]+)\)$/.exec(canvas.style.transform);
            const t = m ? m[1]!.split(",").map(Number) : [1, 0, 0, 1, 0, 0];
            ctx.setTransform(
              targetScale * t[0]!, targetScale * t[1]!,
              targetScale * t[2]!, targetScale * t[3]!,
              targetScale * t[4]!, targetScale * t[5]!,
            );
            ctx.drawImage(canvas, 0, 0);
          });
          ctx.globalAlpha = 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          out.toBlob((b) => (b ? resolve(b) : reject(new Error("snapshot failed"))), "image/png");
        } catch (e) {
          reject(e instanceof Error ? e : new Error("snapshot failed"));
        }
      }));
      this.map.renderSync();
    });
  }

  /** Hide the given overlay ids' layers; returns a function that restores their
   *  visibility. Used to drop editing chrome from a snapshot. */
  private hideOverlays(overlayIds: string[]): () => void {
    const hidden: VectorLayer[] = [];
    for (const id of overlayIds) {
      const layer = this.layers.get(id);
      if (layer && layer.getVisible()) {
        layer.setVisible(false);
        hidden.push(layer);
      }
    }
    return () => { for (const l of hidden) l.setVisible(true); };
  }

  getCenter(): LatLng {
    const c = this.map.getView().getCenter();
    if (!c) return { lat: 0, lon: 0 };
    const [lon, lat] = toLonLat(c);
    return { lat: lat!, lon: lon! };
  }

  getViewSpan(): number {
    const size = this.map.getSize();
    if (!size) return 10;
    const extent = transformExtent(this.map.getView().calculateExtent(size), "EPSG:3857", "EPSG:4326");
    return Math.max(getWidth(extent), getHeight(extent)) || 10;
  }

  project(p: LatLng): [number, number] | null {
    const px = this.map.getPixelFromCoordinate(fromLonLat([p.lon, p.lat]));
    return px ? [px[0]!, px[1]!] : null;
  }

  unproject(px: [number, number]): LatLng | null {
    const coord = this.map.getCoordinateFromPixel(px);
    if (!coord) return null;
    const [lon, lat] = toLonLat(coord);
    return { lat: lat!, lon: lon! };
  }

  onViewChange(cb: () => void): void {
    this.olKeys.push(this.map.on("moveend", cb));
  }

  setPanEnabled(enabled: boolean): void {
    this.dragPan?.setActive(enabled);
  }

  setDoubleClickZoom(enabled: boolean): void {
    this.dblClickZoom?.setActive(enabled);
  }

  setCursor(cursor: string): void {
    const el = this.map.getTargetElement();
    if (el) el.style.cursor = cursor;
  }

  setTooltip(t: string | null, at: LatLng, style?: TooltipStyle): void {
    if (style) this.tooltipStyle = style;
    if (t == null) {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
      return;
    }
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement("div");
      this.tooltipEl.className = "draw-adapter-tooltip";
      if (this.tooltipStyle) applyTooltipStyle(this.tooltipEl, this.tooltipStyle);
      this.map.getTargetElement()?.appendChild(this.tooltipEl);
    } else if (style) {
      applyTooltipStyle(this.tooltipEl, style);
    }
    const px = this.map.getPixelFromCoordinate(fromLonLat([at.lon, at.lat]));
    if (!px) return;
    this.tooltipEl.textContent = t;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${px[0]}px`;
    this.tooltipEl.style.top = `${px[1]}px`;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    if (this.domPointerUp) return;
    // `pointerdown` in the CAPTURE phase: run before OpenLayers' own DragPan (the
    // viewport listener registered before us). When the press lands on a draggable
    // hit, `stopPropagation()` keeps DragPan from starting a pan — disabling it in
    // the callback is too late. NB: only stop draggable `down`s; letting plain
    // clicks through preserves OL's `singleclick` (e.g. "change symbol" on click).
    this.viewportPointerDown = (e: globalThis.PointerEvent) => {
      const coord = this.map.getEventCoordinate(e);
      if (!coord) return;
      this.dragging = true;
      const [lon, lat] = toLonLat(coord);
      const hit = this.hitAt(this.map.getEventPixel(e));
      if (hit && isDraggableHit(hit)) e.stopPropagation();
      cb({ type: "down", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
    };
    // "up" must fire even when pointerup lands off the canvas (no coordinate), so a
    // drag (and its delete-on-release) always completes.
    this.domPointerUp = (): void => {
      this.dragging = false;
      cb({ type: "up", lngLat: { lat: 0, lon: 0 } });
    };
    this.map.getViewport().addEventListener("pointerdown", this.viewportPointerDown, true);
    document.addEventListener("pointerup", this.domPointerUp);

    this.olKeys.push(
      this.map.on("pointermove", (evt) => {
        const [lon, lat] = toLonLat(evt.coordinate);
        if (this.dragging) {
          cb({ type: "move", lngLat: { lat: lat!, lon: lon! } });
          return;
        }
        const hit = this.hitAt(evt.pixel);
        this.setCursor(cursorForHit(hit));
        cb({ type: "move", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
      this.map.on("singleclick", (evt) => {
        const hit = this.hitAt(evt.pixel);
        const [lon, lat] = toLonLat(evt.coordinate);
        cb({ type: "click", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
      this.map.on("dblclick", (evt) => {
        const hit = this.hitAt(evt.pixel);
        const [lon, lat] = toLonLat(evt.coordinate);
        cb({ type: "dblclick", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
    );
  }

  destroy(): void {
    this.layerOverlay.forEach((_, layer) => this.map.removeLayer(layer as BaseLayer));
    this.layerOverlay.clear();
    this.layers.clear();
    this.sources.clear();
    this.iconCache.clear();
    unByKey(this.olKeys);
    this.olKeys = [];
    if (this.viewportPointerDown) {
      this.map.getViewport().removeEventListener("pointerdown", this.viewportPointerDown, true);
      this.viewportPointerDown = undefined;
    }
    if (this.domPointerUp) {
      document.removeEventListener("pointerup", this.domPointerUp);
      this.domPointerUp = undefined;
    }
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.readyPromise = undefined;
    this.dragPan?.setActive(true);
    this.dblClickZoom?.setActive(true); // re-enable in case we were torn down mid-draw
    this.setCursor("");
  }

  private hitAt(pixel: number[]): Hit | undefined {
    const hittable = this.opts.hitOverlays;
    // `forEachFeatureAtPixel` with a `hitTolerance` resolves the tolerance ring by
    // DISTANCE, so a nearby lower layer can be reported before a handle on top. For
    // parity with MapLibre (top-of-stack wins), collect every candidate and keep the
    // one whose overlay sits highest in the manifest (largest z-index).
    let best: Hit | undefined;
    let bestZ = -1;
    this.map.forEachFeatureAtPixel(
      pixel,
      (feature: FeatureLike, layer: unknown) => {
        const overlay = this.layerOverlay.get(layer);
        if (!overlay || !(hittable?.has(overlay) ?? true)) return false;
        const z = this.zOf.get(overlay) ?? -1;
        if (z > bestZ) {
          const props = { ...feature.getProperties() };
          delete props["geometry"];
          best = { overlay, props };
          bestZ = z;
        }
        return false; // keep scanning all candidates at this pixel
      },
      { hitTolerance: 5 },
    );
    return best;
  }

  private icon(spriteId: string, size: number, color: string, rotation: number): Icon | undefined {
    const svg = this.sprites[spriteId];
    if (!svg) return undefined;
    const key = `${spriteId}|${color}|${size}|${rotation}`;
    let icon = this.iconCache.get(key);
    if (!icon) {
      icon = new Icon({ src: svgToDataUrl(colorizeSprite(svg, color)), scale: size, rotation: deg2rad(rotation) });
      this.iconCache.set(key, icon);
    }
    return icon;
  }

  private dataIcon(src: string, size: number, rotation: number): Icon {
    const key = `data:${src}|${size}|${rotation}`;
    let icon = this.iconCache.get(key);
    if (!icon) {
      icon = new Icon({ src, scale: size, rotation: deg2rad(rotation) });
      this.iconCache.set(key, icon);
    }
    return icon;
  }

  private styleFor(kind: LayerKind): StyleLike {
    const def = this.opts.defaultSymbolColor;
    switch (kind) {
      case "fill":
        return (f: FeatureLike): Style => {
          const fill = new Fill({ color: rgba(str(f.get("fillColor"), "#888"), num(f.get("fillOpacity"), 0.2)) });
          const stroke = f.get("stroke")
            ? new Stroke({ color: rgba(str(f.get("stroke")), num(f.get("strokeOpacity"), 1)), width: num(f.get("strokeWidth"), 1) })
            : undefined;
          return new Style(stroke ? { fill, stroke } : { fill });
        };
      case "line":
        return (f: FeatureLike): Style => {
          const stroke = str(f.get("stroke"), "#333");
          const width = num(f.get("strokeWidth"), 2);
          const dash = f.get("dash") as number[] | undefined;
          const color = rgba(stroke, num(f.get("strokeOpacity"), 1));
          const st = new Stroke({ color, width, ...(dash ? { lineDash: dash } : {}), lineCap: dash ? "butt" : "round", lineJoin: "round" });
          // Filled polygons (e.g. wind-barb saw teeth) living in a line source.
          if (f.getGeometry?.()?.getType() === "Polygon") {
            return new Style({ stroke: st, fill: new Fill({ color: str(f.get("fillColor")) || stroke }) });
          }
          return new Style({ stroke: st });
        };
      case "symbol":
        return (f: FeatureLike): Style => {
          const icon = this.icon(str(f.get("symbol")), num(f.get("size"), 1), str(f.get("symbolColor")) || def, num(f.get("rotation"), 0));
          return icon ? new Style({ image: icon }) : new Style({});
        };
      case "text":
        return (f: FeatureLike): Style => {
          const size = num(f.get("textSize"), 13);
          const bg = str(f.get("textBackground"));
          const border = str(f.get("textBorder"));
          return new Style({
            text: new Text({
              text: wrapLabel(str(f.get("text")), num(f.get("maxWidth"), 0), size),
              font: `${size}px sans-serif`,
              rotation: deg2rad(num(f.get("rotation"), 0)),
              rotateWithView: false,
              fill: new Fill({ color: str(f.get("textColor"), "#111") }),
              stroke: new Stroke({ color: str(f.get("textHalo"), "#fff"), width: 3 }),
              ...(bg ? { backgroundFill: new Fill({ color: bg }), padding: [3, 5, 3, 5] as [number, number, number, number] } : {}),
              ...(border ? { backgroundStroke: new Stroke({ color: border, width: 1 }) } : {}),
            }),
          });
        };
      case "circle":
        return (f: FeatureLike): Style | Style[] => {
          const dot = new Style({
            image: new CircleStyle({
              radius: num(f.get("radius"), 5),
              fill: new Fill({ color: str(f.get("fill"), "#ffffff") }),
              stroke: new Stroke({ color: str(f.get("stroke"), "#58a6ff"), width: num(f.get("strokeWidth"), 2) }),
            }),
          });
          const rot = num(f.get("iconRotate"), num(f.get("rotation"), 0));
          const iconUri = str(f.get("icon"));
          if (iconUri) return [dot, new Style({ image: this.dataIcon(iconUri, num(f.get("size"), 1), rot) })];
          const sprite = str(f.get("symbol"));
          if (sprite) {
            const icon = this.icon(sprite, num(f.get("size"), 1), str(f.get("symbolColor")) || def, rot);
            if (icon) return [dot, new Style({ image: icon })];
          }
          return dot;
        };
    }
  }
}
