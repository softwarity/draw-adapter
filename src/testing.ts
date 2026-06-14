/**
 * `FakeAdapter` — an in-memory {@link MapAdapter} for unit-testing a controller
 * without a real map. It records overlays and replays pointer events. Both
 * `sigmet-draw` and `sigwx-draw` build their `controller.test.ts` on top of it.
 */
import type { FeatureCollection, Feature } from "geojson";

import type { HighlightStyle, KeyEvent, LatLng, LngLatBounds, MapAdapter, MarkerWidget, PointerEvent, ProjectionSpec, SnapshotOptions, SymbolSprites, ToolbarItem, ToolbarOptions, TooltipStyle, WidgetEdit } from "./index.js";
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
  blurCb?: () => void;
  viewCb?: () => void;
  widgets: MarkerWidget[] = [];
  widgetEditCb?: (e: WidgetEdit) => void;
  widgetDeleteCb?: (e: { id: string }) => void;
  widgetActionCb?: (e: { id: string; event: string }) => void;
  coordFormat?: (ll: LatLng) => string;
  overlayVisible: Record<string, boolean> = {};
  fittedBounds?: LngLatBounds;
  container?: HTMLElement;

  constructor(private centre: LatLng = { lat: 0, lon: 0 }) {}

  ready(): Promise<void> { return Promise.resolve(); }
  registerSymbols(_: SymbolSprites): Promise<void> { return Promise.resolve(); }
  setOverlay(id: string, d: FeatureCollection): void { this.overlays[id] = d; }
  setOverlayVisible(id: string, visible: boolean): void { this.overlayVisible[id] = visible; }
  snapshot(_?: SnapshotOptions): Promise<Blob> { return Promise.resolve(new Blob([], { type: "image/png" })); }
  setTooltip(text: string | null, at: LatLng, style?: TooltipStyle): void {
    this.tooltip = style ? { text, at, style } : { text, at };
  }
  addToolbar(_items: ToolbarItem[], _options?: ToolbarOptions): HTMLElement {
    return (globalThis.document?.createElement("div") ?? ({} as HTMLElement));
  }
  /** Last `setActiveTool` argument (records the consumer-driven active-tool calls). */
  activeTool: string | null = null;
  setActiveTool(id: string | null): void { this.activeTool = id; }
  getCenter(): LatLng { return this.centre; }
  getViewSpan(): number { return 10; }
  getBounds(): LngLatBounds { return [-1, -1, 1, 1]; }
  getZoom(): number { return 5; }
  getContainer(): HTMLElement { return (this.container ??= globalThis.document?.createElement("div") ?? ({} as HTMLElement)); }
  fitBounds(bbox: LngLatBounds): void { this.fittedBounds = bbox; }
  /** Last `setProjection` argument. */
  projection: ProjectionSpec = "mercator";
  setProjection(projection: ProjectionSpec): void { this.projection = projection; }
  /** Last `viewArea` request (extent + opts). */
  viewedArea: { extent: LngLatBounds; opts?: { padding?: number; duration?: number } } | undefined;
  viewArea(extent: LngLatBounds, opts?: { padding?: number; duration?: number }): void {
    this.viewedArea = opts ? { extent, opts } : { extent };
  }
  /** Last `highlightArea` extent (`null` once cleared) + its style. */
  highlightedArea: LngLatBounds | null = null;
  highlightStyle: HighlightStyle | undefined;
  highlightArea(extent: LngLatBounds | null, style?: HighlightStyle): void {
    this.highlightedArea = extent;
    this.highlightStyle = style;
  }
  project(_: LatLng): [number, number] { return [0, 0]; }
  unproject(_: [number, number]): LatLng { return { lat: 0, lon: 0 }; }
  onViewChange(cb: () => void): void { this.viewCb = cb; }
  setPanEnabled(enabled: boolean): void { this.panEnabled = enabled; }
  setDoubleClickZoom(enabled: boolean): void { this.doubleClickZoom = enabled; }
  setInteractive(enabled: boolean): void { this.interactive = enabled; }
  setCursor(cursor: string): void { this.cursor = cursor; }
  onPointer(cb: (e: PointerEvent) => void): void { this.cb = cb; }
  onKey(cb: (e: KeyEvent) => void): void { this.keyCb = cb; }
  onBlur(cb: () => void): void { this.blurCb = cb; }
  setWidgets(widgets: MarkerWidget[]): void { this.widgets = widgets; }
  onWidgetEdit(cb: (e: WidgetEdit) => void): void { this.widgetEditCb = cb; }
  onWidgetDelete(cb: (e: { id: string }) => void): void { this.widgetDeleteCb = cb; }
  onWidgetAction(cb: (e: { id: string; event: string }) => void): void { this.widgetActionCb = cb; }
  setCoordFormat(fn: (ll: LatLng) => string): void { this.coordFormat = fn; }
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
  /** Simulate the window losing focus ⇒ fires the `onBlur` callback. */
  blur(): void {
    this.blurCb?.();
  }
  /** Simulate a change in an editable widget control ⇒ fires `onWidgetEdit({ id, name?, value })`
   *  (a keystroke in an input, or a picker choice when `name` is given). */
  editWidget(id: string, value: string, name?: string): void {
    this.widgetEditCb?.({ id, value, ...(name != null ? { name } : {}) });
  }
  /** Simulate dragging a gauge/dial cursor `name` to `value` ⇒ fires
   *  `onWidgetEdit({ id, name, value: String(value) })` (the value is emitted as a string). */
  dragGauge(id: string, name: string, value: number): void {
    this.widgetEditCb?.({ id, name, value: String(value) });
  }
  /** Simulate a click on a widget's delete button ⇒ fires `onWidgetDelete({ id })`. */
  deleteWidget(id: string): void {
    this.widgetDeleteCb?.({ id });
  }
  /** Simulate a click on a widget action button ⇒ fires `onWidgetAction({ id, event })`. */
  actionWidget(id: string, event: string): void {
    this.widgetActionCb?.({ id, event });
  }
  /** Find a declared widget by `id` (the full set last passed to `setWidgets`). */
  widget(id: string): MarkerWidget | undefined {
    return this.widgets.find((w) => w.id === id);
  }
  /** Surface a card click through `onPointer` as a `{ overlay: "widget", props: { id } }` hit
   *  (the same shape the engine adapters emit) — sugar over `send("click", …, "widget", { id })`. */
  clickWidget(id: string, lat = 0, lon = 0): void {
    this.send("click", lat, lon, "widget", { id });
  }
}
