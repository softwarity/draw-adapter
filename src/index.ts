/**
 * `@softwarity/draw-adapter` — the shared, **generic** map adapter for the
 * @softwarity drawing libs (`sigmet-draw`, `sigwx-draw`, …).
 *
 * An adapter *grafts* a drawing onto a host-owned map (à la Terra Draw): the host
 * owns the basemap, controls, projection and zoom; the adapter only adds the
 * drawing overlays, reports pointer events in lon/lat, registers a glyph sprite
 * atlas and optionally renders a native toolbar.
 *
 * The adapter is **dumb**: it knows no domain type. It is driven by a declarative
 * {@link LayerSpec}[] manifest (provided by the consumer) and reads a fixed set of
 * **render props** off each feature, picked by the layer's {@link LayerKind}. The
 * controller in each product resolves its domain style into these props *before*
 * calling {@link MapAdapter.setOverlay} — so styling is entirely data-driven and
 * the three engine adapters (MapLibre / OpenLayers / Leaflet) render identically.
 *
 * ### Feature render-prop contract (read by the adapters, baked by the controller)
 *
 * | `kind`   | props read on each feature |
 * |----------|----------------------------|
 * | `fill`   | `fillColor`, `fillOpacity`, `stroke?`, `strokeWidth?`, `strokeOpacity?` |
 * | `line`   | `stroke`, `strokeWidth`, `dash?` (number[]), `strokeOpacity?` |
 * | `symbol` | `symbol` (sprite id), `size?` (×spritePx), `rotation?` (deg, cw), `symbolColor?` |
 * | `text`   | `text`, `textColor`, `textSize`, `textHalo?`, `textBackground?`, `textBorder?`, `textBoxSize?`, `textBoxRadius?`, `maxWidth?`, `rotation?` |
 * | `circle` | `role?`, `control?`, `collinear?`, `fill?`, `stroke?`, `radius?`, `strokeWidth?`, `icon?` (data-URI), `symbol?` (sprite id), `iconRotate?` (deg, cw), `symbolColor?` |
 *
 * Cross-cutting conventions:
 *  - **`role`** marks a draggable handle/guide and names what the drag targets
 *    (`"center"`, `"radius"`, `"v0"`, `"a1"`, `"lon"`, …).
 *  - **`featureId`** on hit-testable features lets a click resolve to a domain object.
 *  - **`control: true`** styles a control handle distinctly (left to the controller's props).
 *  - **`collinear: true`** marks a redundant vertex (greyed by the controller's props).
 *  - rotation (`rotation`/`iconRotate`) is **degrees, clockwise**, identical on all engines.
 */
import type { FeatureCollection } from "geojson";
import type { TextBoxSize, TextBoxRadius } from "./textbox.js";

export type { FeatureCollection } from "geojson";

/** A geographic position in decimal degrees (lon/lat, GeoJSON-aligned). */
export interface LatLng {
  /** Latitude in decimal degrees, south negative. Range [-90, 90]. */
  lat: number;
  /** Longitude in decimal degrees, west negative. Range [-180, 180]. */
  lon: number;
}

/** A geographic bounding box, `[west, south, east, north]` in decimal degrees. */
export type LngLatBounds = [number, number, number, number];

/** How a layer is rendered. The overlay's source shares the layer `id`. */
export type LayerKind = "fill" | "line" | "symbol" | "text" | "circle";

/** One overlay layer in the manifest. Order = bottom → top (z-order). */
export interface LayerSpec {
  id: string;
  kind: LayerKind;
}

/** A glyph atlas: sprite id → inline SVG markup. Registered before first render. */
export type SymbolSprites = Record<string, string>;

export interface PointerEvent {
  /** `"contextmenu"` is a right-click (the browser menu is suppressed) — e.g. finish a polygon
   *  or delete a vertex. The consumer decides the action. */
  type: "down" | "move" | "up" | "click" | "dblclick" | "contextmenu";
  lngLat: LatLng;
  /**
   * Modifier-key state at the event. On a `move` these reflect the **current** state
   * (handy for a modifier-gated drag, e.g. Ctrl held to translate rigidly). Treat
   * `ctrlKey || metaKey` as "the modifier" (Ctrl on PC/Linux, ⌘ on Mac), like the snapshot
   * button. All four are optional and default to `false`.
   */
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** The overlay hit + that feature's prop bag (`role`, `featureId`, …). */
  hit?: Hit;
}

/**
 * A normalized keydown forwarded by {@link MapAdapter.onKey}. The adapter is a dumb
 * transport: it reports the raw key/modifiers (skipping editable targets) and lets the
 * consumer decide the action — e.g. `Delete`/`Backspace` ⇒ remove the selection. No
 * domain semantics live in the adapter.
 */
export interface KeyEvent {
  /** `KeyboardEvent.key` — e.g. `"Backspace"`, `"Delete"`, `"Escape"`, `"a"`. */
  key: string;
  /** `KeyboardEvent.code` — physical key, e.g. `"Backspace"`, `"KeyA"`. */
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Prevent the browser default (e.g. `Backspace` navigating back). */
  preventDefault: () => void;
}

/** A hit returned by an adapter's internal hit-test. */
export interface Hit {
  overlay: string;
  props: Record<string, unknown>;
}

// ── Marker widgets (anchored, inline-editable DOM cards) ──────────────────────
//
// A generic, domain-free **anchored card** primitive: a small DOM card pinned at a
// `lon/lat`, built from a tiny box-layout tree (vbox/hbox + glyph / text(+`input`) /
// coord). Unlike the rendered render-prop features, a widget is a real DOM element on
// the map container — so it can host a real `<input>` for free-text entry (caret,
// selection, IME, paste, mobile keyboard). The consumer composes the tree and reads
// the values back; the adapter owns placement + the editing control.

/** Which point of a card pins to its `anchor`. Named anchors or a 0..1 fractional point. */
export type WidgetOrigin =
  | "center" | "top" | "bottom" | "left" | "right"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | { x: number; y: number };

/** A glyph leaf — inline SVG (uses `currentColor`, so `color` tints it). */
export interface WidgetGlyph {
  kind: "glyph";
  /** Inline SVG markup. */
  svg: string;
  /** Box size in px (width = height). */
  size?: number;
  /** Glyph colour (resolves `currentColor`); else inherits the cascade. */
  color?: string;
}

/** A text leaf — a static label, or (when `editable`) an inline editing control. */
export interface WidgetText {
  kind: "text";
  value: string;
  /** Omit/`false` ⇒ a static `<span>` label; `true` ⇒ an editable control. */
  editable?: boolean;
  /**
   * The editing control when `editable`. Only `"input"` is implemented now; the field
   * is the **extension point** for future `"gauge"` / `"dial"` / `"carousel"` (not in
   * this lib yet). Defaults to `"input"` when `editable` and omitted.
   */
  control?: "input";
  placeholder?: string;
  /** Focus the control when it **first appears** (not on every re-render). */
  autofocus?: boolean;
  /** Force UPPERCASE: an editable input **enters and emits** its value in upper case
   *  (caret preserved); a static label is displayed upper case. */
  uppercase?: boolean;
  /** Text colour; else inherits the nearest ancestor box / `font`. */
  color?: string;
  /** Font size px; else inherits. */
  size?: number;
}

/** A coordinate leaf — the container's `anchor`, formatted (see {@link MapAdapter.setCoordFormat});
 *  read-only and **live** (re-rendered whenever the anchor changes). */
export interface WidgetCoord {
  kind: "coord";
  color?: string;
  size?: number;
}

/** A layout box (vbox/hbox). Carries no frame; **may** set `color`/`size` that cascade
 *  to descendant text/coord (plain CSS inheritance). */
export interface WidgetBox {
  /** `"v"` ⇒ column, `"h"` ⇒ row. */
  dir: "v" | "h";
  /** Cross-axis alignment. Default `"center"`. */
  align?: "start" | "center" | "end";
  /** px between children. Default `0`. */
  gap?: number;
  /** Text colour for this subtree — inherited by descendant text/coord. */
  color?: string;
  /** Font size px for this subtree — inherited likewise. */
  size?: number;
  items: WidgetNode[];
}

export type WidgetNode = WidgetBox | WidgetGlyph | WidgetText | WidgetCoord;

/** Where a widget action button sits — a single edge/corner point, or a **group** that expands to
 *  a set of points. Pass an **array** to combine groups; the points are unioned (deduped). E.g.
 *  `["left-corners","top-corners"]` ⇒ 3 corners (top-left, top-right, bottom-left). */
export type WidgetButtonPlace =
  | "top" | "bottom" | "left" | "right"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "edges" | "h-edges" | "v-edges"
  | "corners" | "top-corners" | "bottom-corners" | "left-corners" | "right-corners";

/** A small action button rendered straddling the card's edge/corner(s). **Domain-free**: it just
 *  carries the `event` string echoed back via {@link MapAdapter.onWidgetAction} — the consumer
 *  decides what it does (e.g. "draw another area attached to this panel"). */
export interface WidgetButton {
  /** The action id, echoed back on click as `{ id, event }`. */
  event: string;
  /** Where to place it (one point/group, or an array unioned across groups). Default `"right"`. */
  place?: WidgetButtonPlace | WidgetButtonPlace[];
  /** Inline SVG glyph (e.g. a `+` or a pen); a small neutral dot if omitted. */
  svg?: string;
  /** Draw it as a small **bordered** circle (default `false` ⇒ just the glyph). */
  bordered?: boolean;
}

/** An anchored marker widget (a DOM card). Positions + frames only; layout lives in the
 *  single root {@link WidgetBox}. `padding`/`radius` reuse the label-box presets so widgets
 *  and label boxes look consistent. */
export interface MarkerWidget {
  /** The consumer's feature id; echoed back on every widget/pointer event. */
  id: string;
  anchor: LatLng;
  /** Which point of the card pins to `anchor`. Default `"center"`. */
  origin?: WidgetOrigin;
  /** Card fill; omit ⇒ transparent. */
  bg?: string;
  /** Border colour; omit ⇒ no border (width fixed, 1px, like the label box). */
  border?: string;
  /** Corner radius preset (reuses {@link TextBoxRadius}). Default `"none"`. */
  radius?: TextBoxRadius;
  /** Inner padding preset (reuses {@link TextBoxSize}), applied when framed. Default `"medium"`. */
  padding?: TextBoxSize;
  /** Root text style; cascades to ALL descendants (a box or item may override its subtree). */
  font?: { color?: string; size?: number; family?: string };
  /** Show a small **delete** button in the card's top-right corner. Clicking it fires
   *  {@link MapAdapter.onWidgetDelete} with this `id` — the lib does NOT remove the card,
   *  the consumer drops the `id` from its next `setWidgets`. */
  deletable?: boolean;
  /** Action buttons on the card's edges/corners (a `+`, a pen, …). Each fires
   *  {@link MapAdapter.onWidgetAction} with its `event`. The lib stays domain-free. */
  buttons?: WidgetButton[];
  /** Exactly one root box. */
  child: WidgetBox;
}

/** Payload of {@link MapAdapter.onWidgetEdit} — fired per keystroke in an editable input. */
export interface WidgetEdit {
  id: string;
  value: string;
}

/** Generic floating-tooltip style (supplied by the consumer; not a domain type). */
export interface TooltipStyle {
  background: string;
  color: string;
  fontSize: number;
  padding: string;
  borderRadius: string;
  maxWidth: string;
}

export type ToolbarPosition =
  | "top" | "top-left" | "top-right"
  | "bottom" | "bottom-left" | "bottom-right"
  | "left" | "left-top" | "left-bottom"
  | "right" | "right-top" | "right-bottom";

export type ToolbarPadding =
  | string
  | { top?: string; right?: string; bottom?: string; left?: string };

export interface ToolbarOptions {
  /** Where the bar sits (anchor). Its flow (row vs column) is **derived** from this: a
   *  top/bottom edge ⇒ horizontal row, a left/right edge ⇒ vertical column. */
  position?: ToolbarPosition;
  padding?: ToolbarPadding;
  gap?: string;
  className?: string;
  /** Tool ids to show (and their order); defaults to all passed. */
  tools?: string[];
  /** Include the "clear all" button (default true). */
  clear?: boolean;
  /**
   * Add a "capture map" (PNG) button. **Omitted/`undefined` ⇒ shown with defaults**
   * (`quality: "native"`, `onClick: "download"`). Pass `{ quality?, onClick? }` to
   * configure it, or `null` / `false` / `"none"` to **hide** it.
   *
   * The button always offers **both** deliveries: `onClick` (default `"download"`)
   * is wired to a plain click, the **other** one to a modifier-click (Ctrl on
   * PC/Linux, ⌘ on Mac). `shutter` (default `true`) plays the capture effect;
   * `hideOverlays` lists overlay ids to hide for the capture (editing handles/guides).
   * On the Leaflet adapter the button is shown but DISABLED.
   */
  snapshot?: "none" | false | null | { quality?: SnapshotQuality; onClick?: SnapshotDelivery; shutter?: boolean; hideOverlays?: string[] };
  /** Add a "lock map" toggle at the **end** of the bar — freezes pan/zoom/rotate so the
   *  map can't move while drawing. Default `true`; set `false` to hide it. */
  lock?: boolean;
}

/** Snapshot output size: a pixel-ratio preset (see `snapshotScale`). */
export type SnapshotQuality = "native" | "low" | "medium" | "high";

/** What `snapshot()` does with the captured PNG. `"blob"` ⇒ just return it. */
export type SnapshotTarget = "blob" | "download" | "clipboard";

/** A delivery a toolbar click can be wired to (the side-effecting subset). */
export type SnapshotDelivery = "download" | "clipboard";

export interface SnapshotOptions {
  /** Pixel-ratio of the output (device px per CSS px). Default =
   *  `window.devicePixelRatio` (render "as on screen"). >1 = supersampling
   *  (re-render at higher DPI, best-effort). */
  scale?: number;
  /** What to do with the PNG: just return the `"blob"` (default), `"download"` a
   *  file, or copy to the `"clipboard"`. The Blob is returned in every case. */
  target?: SnapshotTarget;
  /** Filename for `target: "download"`. Default `"map.png"`. */
  filename?: string;
  /** Overlay ids to hide **only for this capture** (e.g. editing handles/guides), then
   *  restore — so the snapshot shows the clean drawing without the construction chrome. */
  hideOverlays?: string[];
}

export interface ToolbarItem {
  id: string;
  title: string;
  /** Inline SVG for the button. A neutral placeholder icon is used when omitted. */
  svg?: string;
  toggle?: boolean;
  /** When true, clicking this button does NOT change the toolbar's active selection —
   *  for utility buttons (snapshot / lock) that aren't drawing tools. */
  standalone?: boolean;
  /** Render the button disabled (no click wiring); used for the Leaflet snapshot button. */
  disabled?: boolean;
  /** The click handler. Receives the `MouseEvent` so it can read modifier keys
   *  (e.g. the snapshot button uses Ctrl/⌘-click for its alternate delivery). Optional
   *  for a submenu parent, whose click just toggles its flyout. */
  onClick?: (e?: MouseEvent) => void;
  /**
   * Child items shown in a **flyout** that opens on click. The flyout opens *into the
   * map* based on the toolbar's edge (top ⇒ below, bottom ⇒ above, left ⇒ right,
   * right ⇒ left); picking a child fires its `onClick` and closes the flyout.
   */
  children?: ToolbarItem[];
  /** Called once with the created `<button>` for live DOM wiring (e.g. the snapshot
   *  button swaps its icon while a modifier key is held over it). */
  onRender?: (button: HTMLButtonElement) => void;
}

/** Options every engine adapter accepts. The manifest + hit set are consumer-owned. */
export interface AdapterOptions {
  /** The overlay manifest (bottom → top). One source + renderer per entry. */
  layers: LayerSpec[];
  /** Overlays a pointer hit may resolve against. Omit ⇒ every overlay is hittable. */
  hitOverlays?: Set<string>;
  /** Sprite pixel size (icon-size 1 ⇒ this many px). Default {@link SPRITE_PX}. */
  spritePx?: number;
  /** Ink used for symbol/icon features that carry no `symbolColor`. Default `#000000`. */
  defaultSymbolColor?: string;
}

/**
 * The generic map adapter. All three engines implement the full surface; a product
 * simply never calls the methods it does not need (e.g. sigmet ignores `project` /
 * `unproject` / `onViewChange` / `registerSymbols`).
 */
export interface MapAdapter {
  /** Resolves once the adapter has attached its overlays to the host map. */
  ready(): Promise<void>;

  /** Register (or replace) the glyph sprite atlas used by symbol/icon features. */
  registerSymbols(sprites: SymbolSprites): Promise<void>;

  /** Push a FeatureCollection (already styled via props) into overlay `id`. */
  setOverlay(id: string, data: FeatureCollection): void;

  /** Show/hide an overlay layer **without dropping its data** (toggle reference layers, masks,
   *  guides). Cheaper and lossless vs. pushing an empty FeatureCollection. */
  setOverlayVisible(id: string, visible: boolean): void;

  /**
   * Capture the current map (basemap + overlays) as a PNG {@link Blob}. Captures
   * inside the engine's render frame, so the host map needs no special flag (no
   * `preserveDrawingBuffer`). Always resolves to an `image/png` Blob.
   *
   * Not supported on the Leaflet adapter yet (it rejects): tiles are `<img>` and
   * overlays are SVG/DOM, with no single exportable canvas.
   */
  snapshot(opts?: SnapshotOptions): Promise<Blob>;

  /** Floating tooltip at `at` (lon/lat); hidden when `text` is null. Optional
   *  generic style supplied by the consumer (the lib has no domain style). */
  setTooltip(text: string | null, at: LatLng, style?: TooltipStyle): void;

  /** Native toolbar (shared DOM); returns the container for live mutation. */
  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement;

  getCenter(): LatLng;
  /** Rough lon/lat span of the current view, for sizing dropped default geometry. */
  getViewSpan(): number;
  /** Current visible bounds `[west, south, east, north]` (lon/lat). */
  getBounds(): LngLatBounds;
  /** Current zoom level (engine-native scale). */
  getZoom(): number;
  /** The host map's DOM container element — to attach a panel, measure, position UI, etc. */
  getContainer(): HTMLElement;
  /**
   * Frame the host camera to `bbox` (optional `padding` in px). **Drives the host map** — the
   * host normally owns the camera, so use sparingly (it's the one legit case: cadrer son dessin).
   */
  fitBounds(bbox: LngLatBounds, opts?: { padding?: number }): void;

  /** lon/lat → screen pixels (for the call-out placement pass). null if off-view. */
  project(p: LatLng): [number, number] | null;
  /** screen pixels → lon/lat. */
  unproject(px: [number, number]): LatLng | null;
  /** Notify on pan/zoom end, so the label placement pass can re-run. */
  onViewChange(cb: () => void): void;

  setPanEnabled(enabled: boolean): void;
  /** Toggle the host map's double-click-zoom (disabled while drawing a path). */
  setDoubleClickZoom(enabled: boolean): void;
  /**
   * Lock / unlock **all** map navigation (pan + zoom + rotate + scroll + keyboard +
   * touch) — e.g. the toolbar "lock map" button. `false` freezes the map; while locked
   * it **wins** over the transient `setPanEnabled`/`setDoubleClickZoom` the controller
   * toggles during a draw (those are remembered and re-applied on unlock).
   */
  setInteractive(enabled: boolean): void;
  /** Set the map cursor (`"crosshair"` while drawing; `""` resets it). */
  setCursor(cursor: string): void;

  onPointer(cb: (ev: PointerEvent) => void): void;

  /** Notify on keydown while the map (its container) is focused; editable targets
   *  (`input`/`textarea`/`select`/contenteditable) are skipped. The consumer maps keys
   *  to actions (e.g. `Delete`/`Backspace` ⇒ remove selection). Raw transport, no
   *  domain semantics. */
  onKey(cb: (ev: KeyEvent) => void): void;

  /** Notify when the map's **window loses focus** (e.g. the user switches to another window or
   *  app). The adapter is domain-free and never changes selection itself — this is the signal so
   *  the consumer can drop a transient UI state, typically **deselect** the active element (so a
   *  marker stops looking editable once you've left the window). */
  onBlur(cb: () => void): void;

  /**
   * Declarative anchored marker widgets (DOM cards). Mirrors {@link setOverlay}'s
   * contract: pass the **full current set** each render; the adapter **diffs by `id`**
   * (create / update / remove). A card is updated **in place** — a focused input keeps
   * its focus and caret across re-`setWidgets`, so it's safe to re-push every render.
   */
  setWidgets(widgets: MarkerWidget[]): void;

  /** Notify on every keystroke in an editable widget input (`{ id, value }`). */
  onWidgetEdit(cb: (e: WidgetEdit) => void): void;

  /** Notify when the user clicks a widget's delete button (`MarkerWidget.deletable: true`).
   *  The adapter does NOT remove the card — the consumer drops the `id` from its next
   *  `setWidgets` (it owns the data). */
  onWidgetDelete(cb: (e: { id: string }) => void): void;

  /** Notify when a widget **action button** is clicked: `{ id, event }`, where `event` is the
   *  button's declared id (e.g. `"draw-again"`). Domain-free — the consumer maps it to an action. */
  onWidgetAction(cb: (e: { id: string; event: string }) => void): void;

  /** Override the formatter used by `coord` items. Default: a decimal `lat/long`. */
  setCoordFormat(fn: (ll: LatLng) => string): void;

  /** Detach everything this adapter added; MUST NOT destroy the host map. Idempotent. */
  destroy(): void;
}

/**
 * Cursor to show when hovering a hit (used by the engine adapters on hover-move).
 * An explicit per-feature **`cursor`** prop wins — the controller bakes the precise
 * cursor it wants (`ew-resize`, `ns-resize`, `move`, …), keeping the lib domain-free.
 * Otherwise a sensible default:
 *  - a whole-shape **move** handle (`move: true`) → `"move"`,
 *  - any other draggable handle/guide (`role` present, or `control: true`) → `"grab"`,
 *  - any other hit → `"pointer"`,
 *  - no hit → `""` (reset).
 */
export function cursorForHit(hit?: Hit): string {
  if (!hit) return "";
  const p = hit.props;
  if (typeof p["cursor"] === "string" && p["cursor"]) return p["cursor"];
  if (p["move"] === true) return "move";
  if (p["role"] != null || p["control"] === true) return "grab";
  return "pointer";
}

/** An empty FeatureCollection (shared, never mutated). */
export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

export {
  SPRITE_PX,
  colorizeSprite,
  svgToDataUrl,
  loadSpriteImage,
} from "./symbols.js";

export { populateToolbar, applyToolbarLayout } from "./toolbar.js";
export { bindKeyListener } from "./keyboard.js";
export { snapshotScale, downloadPng, copyPng, shutterFlash, SNAPSHOT_ICON_SVG, SNAPSHOT_CLIPBOARD_ICON } from "./snapshot.js";
export { applyTooltipStyle } from "./tooltip.js";
export { defaultCoordFormat } from "./widget.js";
export { rgba, deg2rad, num, str, bool, wrapLabel } from "./coerce.js";
export type { TextBoxSize, TextBoxRadius } from "./textbox.js";
