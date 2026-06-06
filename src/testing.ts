/**
 * `FakeAdapter` — an in-memory {@link MapAdapter} for unit-testing a controller
 * without a real map. It records overlays and replays pointer events. Both
 * `sigmet-draw` and `sigwx-draw` build their `controller.test.ts` on top of it.
 */
import type { FeatureCollection, Feature } from "geojson";

import type { LatLng, MapAdapter, PointerEvent, SymbolSprites, ToolbarItem, TooltipStyle } from "./index.js";

export class FakeAdapter implements MapAdapter {
  overlays: Record<string, FeatureCollection> = {};
  tooltip: { text: string | null; at: LatLng; style?: TooltipStyle } | undefined;
  cursor = "";
  panEnabled = true;
  doubleClickZoom = true;
  cb?: (e: PointerEvent) => void;
  viewCb?: () => void;

  constructor(private centre: LatLng = { lat: 0, lon: 0 }) {}

  ready(): Promise<void> { return Promise.resolve(); }
  registerSymbols(_: SymbolSprites): Promise<void> { return Promise.resolve(); }
  setOverlay(id: string, d: FeatureCollection): void { this.overlays[id] = d; }
  setTooltip(text: string | null, at: LatLng, style?: TooltipStyle): void {
    this.tooltip = style ? { text, at, style } : { text, at };
  }
  addToolbar(_items: ToolbarItem[]): HTMLElement {
    return (globalThis.document?.createElement("div") ?? ({} as HTMLElement));
  }
  getCenter(): LatLng { return this.centre; }
  getViewSpan(): number { return 10; }
  project(_: LatLng): [number, number] { return [0, 0]; }
  unproject(_: [number, number]): LatLng { return { lat: 0, lon: 0 }; }
  onViewChange(cb: () => void): void { this.viewCb = cb; }
  setPanEnabled(enabled: boolean): void { this.panEnabled = enabled; }
  setDoubleClickZoom(enabled: boolean): void { this.doubleClickZoom = enabled; }
  setCursor(cursor: string): void { this.cursor = cursor; }
  onPointer(cb: (e: PointerEvent) => void): void { this.cb = cb; }
  destroy(): void {}

  // ── test helpers ────────────────────────────────────────────────────────────
  /** Replay a pointer event, optionally over an overlay hit. */
  send(
    type: PointerEvent["type"],
    lat: number,
    lon: number,
    overlay?: string,
    props?: Record<string, unknown>,
  ): void {
    const hit = overlay ? { overlay, props: props ?? {} } : undefined;
    this.cb?.({ type, lngLat: { lat, lon }, ...(hit ? { hit } : {}) });
  }
  /** Find a pushed feature in `overlay` by its `role` prop. */
  feature(overlay: string, role: string): Feature | undefined {
    return (this.overlays[overlay]?.features ?? []).find((f) => f.properties?.["role"] === role);
  }
}
