/**
 * `FakeAdapter` — an in-memory {@link MapAdapter} for unit-testing a controller
 * without a real map. It records overlays and replays pointer events. Both
 * `sigmet-draw` and `sigwx-draw` build their `controller.test.ts` on top of it.
 */
import type { FeatureCollection, Feature } from "geojson";

import type { KeyEvent, LatLng, MapAdapter, PointerEvent, SnapshotOptions, SymbolSprites, ToolbarItem, TooltipStyle } from "./index.js";
import { modifiers } from "./modifiers.js";

export class FakeAdapter implements MapAdapter {
  snapshotSupported = true;
  overlays: Record<string, FeatureCollection> = {};
  tooltip: { text: string | null; at: LatLng; style?: TooltipStyle } | undefined;
  cursor = "";
  panEnabled = true;
  doubleClickZoom = true;
  interactive = true;
  cb?: (e: PointerEvent) => void;
  keyCb?: (e: KeyEvent) => void;
  viewCb?: () => void;

  constructor(private centre: LatLng = { lat: 0, lon: 0 }) {}

  ready(): Promise<void> { return Promise.resolve(); }
  registerSymbols(_: SymbolSprites): Promise<void> { return Promise.resolve(); }
  setOverlay(id: string, d: FeatureCollection): void { this.overlays[id] = d; }
  snapshot(_?: SnapshotOptions): Promise<Blob> { return Promise.resolve(new Blob([], { type: "image/png" })); }
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
  setInteractive(enabled: boolean): void { this.interactive = enabled; }
  setCursor(cursor: string): void { this.cursor = cursor; }
  onPointer(cb: (e: PointerEvent) => void): void { this.cb = cb; }
  onKey(cb: (e: KeyEvent) => void): void { this.keyCb = cb; }
  destroy(): void {}

  // ── test helpers ────────────────────────────────────────────────────────────
  /** Replay a pointer event, optionally over an overlay hit and with held modifiers
   *  (default all false) — e.g. `send("move", 1, 2, undefined, undefined, { ctrlKey: true })`
   *  to test a modifier-gated drag. */
  send(
    type: PointerEvent["type"],
    lat: number,
    lon: number,
    overlay?: string,
    props?: Record<string, unknown>,
    mods?: Partial<Pick<PointerEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">>,
  ): void {
    const hit = overlay ? { overlay, props: props ?? {} } : undefined;
    this.cb?.({ type, lngLat: { lat, lon }, ...modifiers(mods), ...(hit ? { hit } : {}) });
  }
  /** Find a pushed feature in `overlay` by its `role` prop. */
  feature(overlay: string, role: string): Feature | undefined {
    return (this.overlays[overlay]?.features ?? []).find((f) => f.properties?.["role"] === role);
  }
  /** Replay a key event (e.g. `key("Backspace", { meta: true })`). */
  key(key: string, mods?: Partial<Pick<KeyEvent, "ctrl" | "meta" | "shift" | "alt">>): void {
    this.keyCb?.({ key, code: key, ctrl: false, meta: false, shift: false, alt: false, preventDefault() {}, ...mods });
  }
}
