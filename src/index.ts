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
 * | `text`   | `text`, `textColor`, `textSize`, `textHalo?`, `textBackground?`, `textBorder?`, `textBorderWidth?` (`small`/`medium`/`large`, default `medium`≈1.4px), `textBoxSize?`, `textBoxRadius?`, `maxWidth?`, `rotation?` |
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

/**
 * A live map projection. `"mercator"` and `"globe"` are the MapLibre built-ins; the
 * `{ kind: "proj4" }` form names an arbitrary CRS by its SRS `code` plus the proj4 `def`
 * string registering it (e.g. polar stereographic for the WAFS polar charts).
 *
 * **Only the OpenLayers adapter actually reprojects.** MapLibre stays on `mercator`/`globe`
 * (a `proj4` spec is a no-op + one console warning); Leaflet is lat/lng-native (any
 * non-`"mercator"` spec is a no-op + one warning). See {@link MapAdapter.setProjection}.
 */
export type ProjectionSpec =
  | "mercator"
  | "globe"
  /** `code` = the SRS id to register/select (e.g. `"EPSG:3995"`); `def` = its proj4 definition string. */
  | { kind: "proj4"; code: string; def: string };

/** Style of the {@link MapAdapter.highlightArea} frame. Defaults: thin grey dashed, no fill. */
export interface HighlightStyle {
  /** Stroke colour. Default `"#666"`. */
  color?: string;
  /** Stroke width in px. Default `1`. */
  width?: number;
  /** Dash pattern. Default `[6, 4]`. (On MapLibre the units are line-widths, per the engine.) */
  dash?: number[];
  /** Fill colour; omit ⇒ no fill (outline only). */
  fill?: string;
}

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

/** One choice in a `"picker"` control — a bare string (text = its own value), or a value with a
 *  display `label` and/or a `svg` glyph, plus an optional `title` used as the **tooltip** for that
 *  choice (in the flower/grid and on the trigger) — e.g. a terse glyph value `"CI"` showing `"Cirrus"`
 *  on hover. **No `title` ⇒ no tooltip** (no fallback to the `label`/`value`). */
export type WidgetPickerOption = string | { value: string; label?: string; svg?: string; title?: string };

/** A text leaf — a static label, an inline `<input>` (when `editable`), or a `"picker"` control
 *  for choosing among `options`. */
export interface WidgetText {
  kind: "text";
  /** The current value. For a picker it's the selected option's `value`. */
  value: string;
  /** Omit/`false` ⇒ a static `<span>` label; `true` ⇒ an editable `<input>`. */
  editable?: boolean;
  /**
   * The control to render. `"input"` (default when `editable`) is a text field. `"picker"` lets the
   * user choose among `options`, emitting the new `value` via {@link MapAdapter.onWidgetEdit}; how it
   * presents the choices is set by `mode`. (`"gauge"`/`"dial"` are reserved.)
   */
  control?: "input" | "picker";
  /**
   * How a `"picker"` presents its `options` — each mode degrades to the next when there are too many
   * choices to stay usable (thresholds: ≤5 carousel, ≤10 flower, beyond ⇒ grid):
   * - `"carousel"` (default) — **carousel** for ≤5 options (click = next, shift-click = previous, with
   *   a slide effect); a **flower** for 6–10; a **grid** beyond.
   * - `"flower"` — a **radial petal menu** (click the centre to fan the petals out; pick one and it
   *   becomes the centre; re-click the centre to re-open); a **grid** beyond 10.
   * - `"grid"` — a **grid popover**, always.
   */
  mode?: "carousel" | "flower" | "grid";
  /** The choices for a `"picker"` control. */
  options?: WidgetPickerOption[];
  /** Identifies this control in the `onWidgetEdit` payload — set it when a card has more than one
   *  editable control (input + several pickers), so the consumer knows which one changed. */
  name?: string;
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

/** One draggable cursor of a {@link WidgetGauge}. `value` is in the control's units; `label` is
 *  PRE-FORMATTED by the consumer (the control never formats). */
export interface WidgetCursor {
  /** Identifies the cursor in {@link MapAdapter.onWidgetEdit} (`{ id, name, value }`). */
  name: string;
  /** Current value, in the control's units. */
  value: number;
  /** Display label beside the knob (consumer-formatted, e.g. `"FL400"` / `"XXX"`); omit ⇒ none. */
  label?: string;
}

/** One range (= one layer) on the shared axis of a {@link WidgetGauge} in multi-range mode.
 *  Ranges can overlap freely; only base ≤ top within a single range is enforced. */
export interface WidgetRange {
  /** Identifier used for z-order tie-break (the `active` range is rendered on top). */
  id?: string;
  /** Lower bound cursor (`name` is what {@link MapAdapter.onWidgetEdit} receives). */
  base: WidgetCursor;
  /** Upper bound cursor. */
  top: WidgetCursor;
  /** Knob and label colour. Must be distinct per range so overlaps read as a blend. */
  color: string;
  /** Band fill colour. Defaults to `color`. Pass `""` for a transparent, borderless band —
   *  knobs and labels remain visible in `color`, and the band stays grab-draggable. */
  fill?: string;
}

/** A linear slider value-editor — vertical by default (the SIGWX FL gauge). Two exclusive modes:
 *
 * - **cursors** (default): 1–3 cursors that **cannot cross** (array order is the invariant). Dragging
 *   a knob streams {@link MapAdapter.onWidgetEdit} (`{ id, name: cursor.name, value }`) per move.
 * - **ranges**: N independent `[base, top]` intervals on ONE shared axis. Intervals can overlap freely;
 *   only `base ≤ top` within each interval is enforced. Drag a knob to move one bound; drag the band
 *   (between the two knobs) to translate both bounds together (width preserved, clamped in [min, max]).
 *
 * `cursors` and `ranges` are **mutually exclusive**. */
export interface WidgetGauge {
  kind: "gauge";
  min: number;
  max: number;
  /** Mode mono-cursor (1..3, non-crossing). Mutually exclusive with `ranges`. */
  cursors?: WidgetCursor[];
  /** Mode multi-range (N overlapping bands on one axis). Mutually exclusive with `cursors`. */
  ranges?: WidgetRange[];
  /** `id` (or array index) of the active range: rendered on top when knobs coincide, and drawn with
   *  slightly stronger opacity. Only meaningful in `ranges` mode. */
  active?: number | string;
  /** Allow dragging one notch PAST a bound (the consumer's off-chart "XXX"): the emitted value is
   *  then `min - step` / `max + step`. Default `false` (hard clamp). */
  beyond?: { below?: boolean; above?: boolean };
  /** Drag granularity in value units (e.g. `10` for flight levels). Default: continuous. */
  step?: number;
  /** Track length in px. Default `120`. */
  length?: number;
  /** Default `"vertical"` (max at the top). */
  orientation?: "vertical" | "horizontal";
  /** Track/knob ink; else inherits the cascade. */
  color?: string;
  /** Cursor-label colour. Default `"black"`; pass `""` to inherit the cascade. */
  labelColor?: string;
  /** A 1px four-direction halo behind the cursor labels (legibility over the map). Default `"white"`;
   *  pass `""` for none. */
  labelHalo?: string;
  /** Cursor-knob fill; default ⇒ the cascade ink (the control's main colour). */
  knobFill?: string;
  /** Cursor-knob border colour (1.5px). Default `"white"`; pass `""` for none. */
  knobStroke?: string;
  /** Whether adding a new range is allowed. Default `false` (opt-in). The lib sets it `true`
   *  on gauges that support hover-add, and omits it (or passes `false`) when adds are not
   *  allowed (e.g. layer count at `repeat.max`, or gauge type that never supports add). */
  canAdd?: boolean;
}

/** A radial dial value-editor (the jet speed control): one cursor swept from `min` to `max`. Angle
 *  convention (FIXED — y-down screen degrees, 0° = east, clockwise): `min` at 150° (down-left), the
 *  `sweep` runs OVER THE TOP to `max` (default 240° ⇒ `max` at 30°, gap at the bottom, a car
 *  speedometer). `angle(v) = 150 + (v-min)/(max-min) × sweep` (mod 360). Streams `onWidgetEdit` per
 *  move. */
export interface WidgetDial {
  kind: "dial";
  /** Identifies the dial in {@link MapAdapter.onWidgetEdit}. */
  name: string;
  min: number;
  max: number;
  value: number;
  /** Pre-formatted centre label (e.g. `"220KT"`); omit ⇒ none. */
  label?: string;
  /** Drag granularity in value units. Default: continuous. */
  step?: number;
  /** Sweep in degrees. Default `240`. */
  sweep?: number;
  /** Radius in px. Default `52`. */
  radius?: number;
  /** Arc/knob ink; else inherits the cascade. */
  color?: string;
  /** Label colour. Default `"black"`; pass `""` to inherit the cascade. */
  labelColor?: string;
  /** A 1px four-direction halo behind the label (legibility over the map). Default `"white"`; pass
   *  `""` for none. */
  labelHalo?: string;
  /** Knob fill; default ⇒ the cascade ink (the control's main colour). */
  knobFill?: string;
  /** Knob border colour (1.5px). Default `"white"`; pass `""` for none. */
  knobStroke?: string;
}

/** Per-side border colours for a {@link WidgetBox}. A side left `undefined` draws **no edge** there
 *  — so two boxes can omit their shared edge and compose a continuous non-rectangular outline (an L).
 *  All present sides share the same `borderWidth` preset. */
export interface WidgetBoxBorder {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

/** A layout box (vbox/hbox). May set `color`/`size` that cascade to descendant text/coord (plain CSS
 *  inheritance), and — optionally — its **own frame** (`bg`/`border`/`borderWidth`/`radius`/`padding`,
 *  same presets as {@link MarkerWidget}) to outline or fill a sub-column. The frame reserves its
 *  border + padding **in the flow** (siblings shift); `bg` is painted behind the box's children.
 *  All omitted ⇒ no frame (behaviour unchanged). */
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
  /** Box fill, painted behind its children; omit ⇒ transparent. */
  bg?: string;
  /** Border colour. A `string` borders all four sides; a {@link WidgetBoxBorder} object borders only
   *  the named sides (an absent side draws no edge → compose L-shapes). Omit ⇒ no border. */
  border?: string | WidgetBoxBorder;
  /** Border width preset (reuses {@link TextBoxSize}), applied to every drawn side. Default `"medium"`
   *  (1px) when `border` is set. */
  borderWidth?: TextBoxSize;
  /** Corner radius preset (reuses {@link TextBoxRadius}). Default `"none"`. */
  radius?: TextBoxRadius;
  /** Inner padding preset (reuses {@link TextBoxSize}). Omit ⇒ no padding. */
  padding?: TextBoxSize;
  items: WidgetNode[];
}

export type WidgetNode = WidgetBox | WidgetGlyph | WidgetText | WidgetCoord | WidgetGauge | WidgetDial;

/** Where a widget action button sits — a single edge/corner point, or a **group** that expands to
 *  a set of points. Pass an **array** to combine groups; the points are unioned (deduped). E.g.
 *  `["left-corners","top-corners"]` ⇒ 3 corners (top-left, top-right, bottom-left).
 *
 *  `"axis-top"` / `"axis-bottom"` place the button on the **gauge track's cross-axis centre** (the
 *  knob centre x on a vertical gauge) at the track's top/bottom end — label-width-robust. Only
 *  meaningful when the card contains a vertical {@link WidgetGauge}; ignored otherwise. */
export type WidgetButtonPlace =
  | "top" | "bottom" | "left" | "right"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "edges" | "h-edges" | "v-edges"
  | "corners" | "top-corners" | "bottom-corners" | "left-corners" | "right-corners"
  | "axis-top" | "axis-bottom";

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
  /** Native tooltip (the `title` attribute) shown on hover. */
  title?: string;
  /** Extra px pushing the button **outward** from its placement point (default `0`). For
   *  `"axis-top"` / `"axis-bottom"` the button centre sits `gap` px clear of the track end —
   *  large enough that a maxed-out band's knob never reaches it. Also honoured for normal edge/
   *  corner placements: `"top"` + `gap:6` lifts the centre 6 px above the card's top edge. */
  gap?: number;
}

/** Frame outline of a card. `"rect"` (default) is the plain CSS box. The others draw an **SVG** frame
 *  (so the border follows the contour) from a **normalized polygon** — `[0,0]` = top-left, `[1,1]` =
 *  bottom-right of the content+padding box; points outside `[0,1]` form a cap/point and the card grows
 *  to reserve the room. `"pentagon-up"`/`"pentagon-down"` are "house" shapes (point up/down, e.g. the
 *  tropopause label). Pass your own `number[][]` for a custom outline. */
export type BoxShape = "rect" | "pentagon-up" | "pentagon-down" | number[][];

/**
 * Attach a satellite card to a measured edge of another card (the "main" card) so the two
 * touch flush, regardless of either card's measured size.
 *
 * `side` governs **only the perpendicular (edge-clearing) axis**; the **cross axis** keeps
 * using the satellite's own `anchor` + `origin` (so FL-pinned positions are untouched):
 * - `"right"` → satellite's LEFT edge at main's RIGHT edge + `gap`.  Cross = own anchor/origin.
 * - `"left"`  → satellite's RIGHT edge at main's LEFT edge − `gap`. Cross = own anchor/origin.
 * - `"top"`   → satellite's BOTTOM edge at main's TOP edge − `gap`.  Cross = own anchor/origin.
 * - `"bottom"`→ satellite's TOP edge at main's BOTTOM edge + `gap`.  Cross = own anchor/origin.
 *
 * If `id` is not currently rendered, the satellite falls back to its own `anchor`/`origin`.
 */
export interface WidgetAnchorTo {
  /** Id of the sibling card (the "main" card) to attach to. */
  id: string;
  /** Which measured edge of the main card this satellite butts against. */
  side: "top" | "bottom" | "left" | "right";
  /** Gap in px between the two touching edges. Default `0` (flush). */
  gap?: number;
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
  /**
   * Attach this card to a measured edge of another card (its "main" card). The perpendicular
   * axis snaps flush to the named edge (+ `gap`); the cross axis uses this card's own
   * `anchor`/`origin`. See {@link WidgetAnchorTo}. Falls back to own anchor when the target
   * card is absent.
   */
  anchorTo?: WidgetAnchorTo;
  /** Card fill; omit ⇒ transparent. */
  bg?: string;
  /** Border colour; omit ⇒ no border. Its **width** is set by `borderWidth` (preset). */
  border?: string;
  /** Border width preset (reuses {@link TextBoxSize}: `small`/`medium`/`large`), applied when
   *  `border` is set. Default `"medium"` (1px, the classic hairline) — so omitting it keeps the
   *  former look. */
  borderWidth?: TextBoxSize;
  /** Corner radius preset (reuses {@link TextBoxRadius}). Default `"none"`. (Ignored for a non-`rect`
   *  `boxShape`, whose corners come from its polygon.) */
  radius?: TextBoxRadius;
  /** Frame outline (see {@link BoxShape}). Omit/`"rect"` ⇒ the plain CSS box (unchanged). A non-rect
   *  shape draws an SVG frame following the contour (`fill` = `bg`, `stroke` = `border` at
   *  `borderWidth`) and the card grows to reserve any cap/point overshoot; `padding`/`font`/`origin`/
   *  drag/buttons are unaffected. */
  boxShape?: BoxShape;
  /** Inner padding preset (reuses {@link TextBoxSize}). Decoupled from the frame: a **framed** card
   *  is padded (default `"medium"`); a **bare** card (no `bg`/`border`) is padded only when `padding`
   *  is given explicitly — so a call-out can space its content (e.g. keep edge buttons off the text)
   *  without forcing a frame. Absent + unframed ⇒ no padding. */
  padding?: TextBoxSize;
  /** Root text style; cascades to ALL descendants (a box or item may override its subtree).
   *  `lineHeight` is unitless (scales with font-size); default `1.2` — lower it (≈1) to tighten
   *  multi-line labels. */
  font?: { color?: string; size?: number; family?: string; lineHeight?: number };
  /** Show a small **delete** button in the card's top-right corner. Clicking it fires
   *  {@link MapAdapter.onWidgetDelete} with this `id` — the lib does NOT remove the card,
   *  the consumer drops the `id` from its next `setWidgets`. Pass `{ title }` for a native
   *  tooltip on the `×`. */
  deletable?: boolean | { title?: string };
  /** Action buttons on the card's edges/corners (a `+`, a pen, …). Each fires
   *  {@link MapAdapter.onWidgetAction} with its `event`. The lib stays domain-free. */
  buttons?: WidgetButton[];
  /** Exactly one root box. */
  child: WidgetBox;
}

/** Payload of {@link MapAdapter.onWidgetEdit} — fired per keystroke in an editable input, and on
 *  each change of a `"picker"` control. */
export interface WidgetEdit {
  id: string;
  /** The control's `name`, if it has one — disambiguates which control changed (a card can hold
   *  several editable controls). */
  name?: string;
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
  /** Appearance of the **active** tool button (driven by {@link MapAdapter.setActiveTool}). Defaults
   *  to `{ background: "#dbeafe" }`; any field you set overrides it. Same result on all 3 engines. */
  activeStyle?: { background?: string; color?: string; outline?: string; boxShadow?: string };
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

  /** Highlight the **active** tool button — **consumer-driven** (the click no longer sets it). Pass a
   *  `ToolbarItem` id to mark its bar button active (a submenu/toggle child marks its parent bar
   *  trigger); pass `null` to clear. One button active at a time; idempotent; no toolbar ⇒ no-op. */
  setActiveTool(id: string | null): void;

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
   * For a fixed chart area (dateline-aware, projection-aware) prefer {@link viewArea}.
   */
  fitBounds(bbox: LngLatBounds, opts?: { padding?: number }): void;

  /**
   * Switch the live map projection. Idempotent and safe to call before or after data load;
   * the current center is preserved as best it can (normally a {@link viewArea} call follows).
   *
   * **Only OpenLayers reprojects.** On OpenLayers a `{ kind: "proj4" }` spec registers the CRS
   * (proj4 must be installed — it is an optional peer dependency) and rebuilds the view + re-reads
   * the overlays into it, so handles/overlays stay aligned with the basemap. MapLibre handles
   * `"mercator"`/`"globe"` natively and ignores `proj4` (stays Mercator, warns once); Leaflet is
   * lat/lng-native and ignores any non-`"mercator"` spec (warns once).
   */
  setProjection(projection: ProjectionSpec): void;

  /**
   * Frame the camera to a lon/lat bbox `[west, south, east, north]`. Unlike {@link fitBounds} this
   * is **antimeridian-aware** — an extent whose `west > east` (e.g. `110°E → -110°W`) is treated as
   * crossing the dateline and framed as one span, not the whole globe — and **projection-aware**
   * (under a non-Mercator OpenLayers view it fits the projected, possibly-curved area). Use it to
   * frame a fixed chart area; the host otherwise owns the camera.
   */
  viewArea(extent: LngLatBounds, opts?: { padding?: number; duration?: number }): void;

  /**
   * Outline an area with a **non-interactive** dashed frame, in a dedicated overlay drawn ABOVE the
   * basemap and BELOW the drawing overlays. `null` clears it. The frame is a **densified geographic
   * polygon**, so under a non-Mercator OpenLayers view its edges curve to follow the projection
   * (it is not a screen-space rectangle). It never intercepts pointer events.
   */
  highlightArea(extent: LngLatBounds | null, style?: HighlightStyle): void;

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
export { defaultCoordFormat } from "./coerce.js";
export { rgba, deg2rad, num, str, bool, wrapLabel } from "./coerce.js";
export type { TextBoxSize, TextBoxRadius } from "./textbox.js";
