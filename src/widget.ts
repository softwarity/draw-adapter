/**
 * Shared, **engine-agnostic** implementation of the anchored marker-widget primitive
 * (see {@link MarkerWidget}). One implementation serves all three engines: the card is a
 * DOM element that each engine **anchors at a lon/lat** via its native overlay primitive
 * (MapLibre `Marker`, OpenLayers `Overlay`, Leaflet `divIcon` marker) — which gives
 * per-frame tracking + correct zoom animation for free. This module owns everything else:
 * building the card from the box-layout tree, **reconciling it in place** (so a focused
 * input keeps focus/caret across re-`setWidgets`), the editable `<input>` control, the
 * live `coord` line, and routing card clicks/drags into the adapter's `onPointer` stream
 * as a `{ overlay: "widget", props: { id } }` hit.
 *
 * Each engine provides a small {@link WidgetHost} (mount / unproject / emit); the rest is here.
 */
import type {
  LatLng,
  MarkerWidget,
  PointerEvent,
  WidgetBox,
  WidgetButton,
  WidgetButtonPlace,
  WidgetDial,
  WidgetEdit,
  WidgetGauge,
  WidgetNode,
  WidgetOrigin,
  WidgetPickerOption,
  WidgetRange,
} from "./index.js";
import { boxBorderWidth, boxPadding, boxRadius } from "./textbox.js";
import { defaultCoordFormat } from "./coerce.js";
import { CHROME_SURFACE, CHROME_BORDER, CHROME_SHADOW, CHROME_HOVER, CHROME_INK, CHROME_BTN_PX, CHROME_GLYPH_PX } from "./chrome.js";
import { modifiers } from "./modifiers.js";

/** A handle to one engine-anchored card mount. The card DOM lives inside `el`. */
export interface WidgetMount {
  /** The engine-anchored element (its top-left tracks the anchor); the card is appended here. */
  readonly el: HTMLElement;
  /** Move the mount to a new anchor. */
  setAnchor(anchor: LatLng): void;
  /** Detach the mount from the map. */
  remove(): void;
  /** Set the CSS z-index of the engine overlay so this mount stacks above (z>0) or at default (z=0). */
  setZIndex(z: number): void;
}

/** What each engine adapter supplies so the shared layer can place + wire cards. */
export interface WidgetHost {
  /** Create an engine-anchored mount whose top-left tracks `anchor`. */
  createMount(anchor: LatLng): WidgetMount;
  /** Client (viewport) px → lon/lat, via the engine's container + `unproject`. */
  unprojectClient(clientX: number, clientY: number): LatLng | null;
  /** Emit a synthetic pointer event into the adapter's `onPointer` stream. */
  emit(ev: PointerEvent): void;
  /** Return keyboard focus to the map (its key-listening element) after a card button took it —
   *  so `onKey`/Escape keeps working. No-op while an editable field is focused. */
  focus(): void;
}

/** `origin` → the [x, y] fraction (0..1) of the card that pins to the anchor. */
const ORIGIN: Record<string, [number, number]> = {
  center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5],
  "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1],
};
function originXY(o: WidgetOrigin | undefined): [number, number] {
  if (!o) return [0.5, 0.5];
  if (typeof o === "object") return [o.x, o.y];
  return ORIGIN[o] ?? [0.5, 0.5];
}
function alignValue(a: WidgetBox["align"]): string {
  return a === "start" ? "flex-start" : a === "end" ? "flex-end" : "center";
}

/**
 * Apply a {@link WidgetBox}'s optional frame (`bg`/`border`/`borderWidth`/`radius`/`padding`) — the
 * same presets as the root card, so a sub-column can outline/fill itself. Border + padding sit in the
 * content box, so they reserve room in the flex flow (siblings shift); `bg` paints behind the children.
 * Every property is (re)written each update — boxes are reconciled in place, so unset fields must be
 * cleared, not left stale. `border` as an object draws only the named sides (an absent side = no edge),
 * letting two boxes drop their shared edge to compose a continuous L-shaped outline.
 */
function applyBoxFrame(s: CSSStyleDeclaration, box: WidgetBox): void {
  s.background = box.bg ?? "transparent";
  // Reset all border declarations first (in-place reconcile would otherwise keep a previous frame).
  s.border = s.borderTop = s.borderRight = s.borderBottom = s.borderLeft = "";
  if (box.border) {
    const edge = `${boxBorderWidth(box.borderWidth)}px solid `;
    if (typeof box.border === "string") {
      s.border = edge + box.border;
    } else {
      if (box.border.top) s.borderTop = edge + box.border.top;
      if (box.border.right) s.borderRight = edge + box.border.right;
      if (box.border.bottom) s.borderBottom = edge + box.border.bottom;
      if (box.border.left) s.borderLeft = edge + box.border.left;
    }
  }
  s.borderRadius = `${boxRadius(box.radius)}px`;
  // Pad when framed (default `medium`) or when `padding` is given explicitly; else none — mirrors the
  // root card so an unframed box stays unpadded by default (`boxPadding(undefined)` is `medium`, not 0).
  if (box.bg || box.border || box.padding != null) {
    const [pv, ph] = boxPadding(box.padding);
    s.padding = `${pv}px ${ph}px`;
  } else {
    s.padding = "0";
  }
}

/** Dataset key tagging a DOM node's render kind, so reconciliation can reuse vs replace. */
const KIND = "wtag";
function nodeTag(node: WidgetNode): string {
  if (!("kind" in node)) return "box"; // a WidgetBox carries no `kind`
  if (node.kind === "text") {
    if (node.control === "picker") return "text:picker";
    return node.editable ? "text:input" : "text:label";
  }
  return node.kind;
}

/** Last SVG markup written into a glyph element (skip re-parsing identical SVG). */
const glyphSvg = new WeakMap<HTMLElement, string>();
function setGlyph(el: HTMLElement, svg: string): void {
  if (glyphSvg.get(el) === svg) return;
  glyphSvg.set(el, svg);
  el.innerHTML = svg;
  const inner = el.firstElementChild as HTMLElement | null;
  if (inner) { inner.style.width = "100%"; inner.style.height = "100%"; inner.style.display = "block"; }
}

/** A reusable offscreen span for auto-sizing editable inputs to their content. */
let measureSpan: HTMLSpanElement | undefined;
function autosize(input: HTMLInputElement): void {
  try {
    if (!measureSpan) {
      measureSpan = document.createElement("span");
      const s = measureSpan.style;
      s.position = "absolute"; s.left = "-9999px"; s.top = "-9999px";
      s.visibility = "hidden"; s.whiteSpace = "pre"; s.pointerEvents = "none";
      document.body?.appendChild(measureSpan);
    }
    const cs = getComputedStyle(input);
    const m = measureSpan.style;
    m.fontFamily = cs.fontFamily; m.fontSize = cs.fontSize; m.fontWeight = cs.fontWeight;
    m.fontStyle = cs.fontStyle; m.letterSpacing = cs.letterSpacing;
    measureSpan.textContent = input.value || input.placeholder || "";
    let w = measureSpan.getBoundingClientRect().width;
    if (!w) {
      // empty (no value, no placeholder) — floor at ~1 character so the field shows as a
      // caret-width box that grows with typing, not the browser's default ~20ch width.
      measureSpan.textContent = "0";
      w = measureSpan.getBoundingClientRect().width;
    }
    input.style.width = `${Math.ceil(w) + 2}px`; // +2 px = caret breathing room
  } catch {
    /* no layout engine (e.g. jsdom) — leave the input at its default width */
  }
}

// ── one card ──────────────────────────────────────────────────────────────────

// ── action buttons (edge/corner, domain-free) ────────────────────────────────

/** Each place value → the set of `[fx, fy]` fractional points it covers on the card box.
 *  `"axis-top"` / `"axis-bottom"` are handled separately in `ensureActionButtons` via DOM
 *  measurement; they only appear here to satisfy the `Record<WidgetButtonPlace, …>` type. */
const PLACE_POINTS: Record<WidgetButtonPlace, [number, number][]> = {
  top: [[0.5, 0]], bottom: [[0.5, 1]], left: [[0, 0.5]], right: [[1, 0.5]],
  "top-left": [[0, 0]], "top-right": [[1, 0]], "bottom-left": [[0, 1]], "bottom-right": [[1, 1]],
  edges: [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]],
  "h-edges": [[0.5, 0], [0.5, 1]],
  "v-edges": [[0, 0.5], [1, 0.5]],
  corners: [[0, 0], [1, 0], [0, 1], [1, 1]],
  "top-corners": [[0, 0], [1, 0]],
  "bottom-corners": [[0, 1], [1, 1]],
  "left-corners": [[0, 0], [0, 1]],
  "right-corners": [[1, 0], [1, 1]],
  "axis-top": [[0.5, 0]],   // placeholder — actual position set by repositionAxisButtons()
  "axis-bottom": [[0.5, 1]], // placeholder
};



/**
 * Wire a chrome button (delete `×` / action) to emit on a **local pointerup tap** rather than the
 * native `click`. MapLibre's `Marker` (the widget mount) cancels `mousedown` on its element, which
 * makes the browser **suppress the synthesized `click`** for the whole gesture — so a real mouse
 * click on a card button never fired its `click` listener (jsdom/`dispatchEvent` doesn't reproduce
 * this, only trusted input). Pointer-event based, so it's immune on all 3 engines: `pointerdown`
 * arms + captures, a `pointerup` within ~3 px fires. The (possibly-suppressed) native `click` and
 * the compat `mousedown` are stop-propagated as guards so neither leaks to the card/map.
 */
function wireTapButton(el: HTMLElement, onTap: (e: globalThis.PointerEvent) => void): void {
  let armed = false;
  let downX = 0;
  let downY = 0;
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); // never start a card drag
    armed = true;
    downX = e.clientX;
    downY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  el.addEventListener("pointerup", (e) => {
    e.stopPropagation();
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!armed) return;
    armed = false;
    if (Math.abs(e.clientX - downX) <= 3 && Math.abs(e.clientY - downY) <= 3) onTap(e);
  });
  el.addEventListener("pointercancel", () => { armed = false; });
  el.addEventListener("click", (e) => { e.stopPropagation(); }); // guard only — emit happens on pointerup
  el.addEventListener("mousedown", (e) => { e.stopPropagation(); }); // keep the compat event off the Marker
}

/** One action button (bare glyph, or a small bordered circle), straddling its edge/corner point.
 *  For `"axis-top"` / `"axis-bottom"` the initial `left`/`top` are placeholders — they are
 *  overwritten by `repositionAxisButtons()` after the card is laid out. */
function makeActionButton(b: WidgetButton, fx: number, fy: number, card: Card): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "draw-adapter-widget-btn";
  el.setAttribute("aria-label", b.title ?? b.event);
  if (b.title) el.title = b.title; // native tooltip on hover
  const s = el.style;
  s.position = "absolute";
  // Apply optional outward gap: shift the reference point away from the box edge.
  const gap = b.gap ?? 0;
  const xGap = gap && (fx === 0 ? -gap : fx === 1 ? gap : 0);
  const yGap = gap && (fy === 0 ? -gap : fy === 1 ? gap : 0);
  s.left = xGap ? `calc(${(fx * 100).toFixed(4)}% + ${xGap}px)` : `${(fx * 100).toFixed(4)}%`;
  s.top  = yGap ? `calc(${(fy * 100).toFixed(4)}% + ${yGap}px)` : `${(fy * 100).toFixed(4)}%`;
  s.transform = "translate(-50%, -50%)"; // straddle the edge/corner point
  s.zIndex = "1";
  s.boxSizing = "border-box";
  s.display = "flex";
  s.alignItems = "center";
  s.justifyContent = "center";
  s.width = "18px";
  s.height = "18px";
  s.margin = "0";
  s.lineHeight = "1";
  s.cursor = "pointer";
  s.userSelect = "none";
  s.color = "#000";
  s.setProperty("appearance", "none");
  s.setProperty("-webkit-appearance", "none");
  if (b.bordered) {
    s.borderRadius = "50%";
    s.border = "1px solid #1f2328";
    s.background = "#fff";
    s.padding = "3px";
  } else {
    s.border = "none";
    s.background = "transparent";
    s.padding = "0";
  }
  if (b.svg) {
    el.innerHTML = b.svg;
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) { inner.style.width = "100%"; inner.style.height = "100%"; inner.style.display = "block"; }
  } else {
    el.textContent = "•";
  }
  wireTapButton(el, () => card.emitAction(b.event));
  return el;
}

// ── picker control (choose among options; presentation degrades with option count) ──
//
// One control, three presentations chosen from the `mode` and the number of options:
//  · carousel — ≤ LINEAR_MAX: click = next, shift-click = previous, with a slide effect (in place).
//  · flower   — ≤ FLOWER_MAX: a radial petal menu fanned around the control (click to open, pick a
//               petal ⇒ it becomes the centre, re-click the centre to re-open).
//  · grid     — beyond: a grid popover next to the control.
// The flower/grid popups live in <body> (`position:fixed`, JS-placed) so they're never clipped and
// sit above the map; an outside press closes them. Picking emits the new value via `card.emitEdit`.

type PickerMode = "carousel" | "flower" | "grid";
const LINEAR_MAX = 5;   // ≤ this many options ⇒ a linear carousel
const FLOWER_MAX = 10;  // ≤ this many options ⇒ a radial flower; beyond ⇒ a grid
const PICKER_GLYPH_PX = 22; // default trigger glyph box (px) when `size` is unset — never the svg's intrinsic size

const pickerState = new WeakMap<HTMLElement, { options: WidgetPickerOption[]; value: string; name: string | undefined; mode: PickerMode; color: string | undefined }>();

function optValue(o: WidgetPickerOption): string {
  return typeof o === "string" ? o : o.value;
}
function optLabel(o: WidgetPickerOption): string {
  return typeof o === "string" ? o : (o.label ?? o.value);
}
/** Tooltip text for an option — its explicit `title`, or `""` (⇒ no tooltip) when there is none. */
function optTitle(o: WidgetPickerOption): string {
  return typeof o !== "string" && o.title ? o.title : "";
}

/** The presentation a picker resolves to for `n` options under `mode` (each mode degrades to grid). */
function pickerLayout(mode: PickerMode, n: number): "carousel" | "flower" | "grid" {
  if (mode === "grid") return "grid";
  if (mode === "flower") return n > FLOWER_MAX ? "grid" : "flower";
  return n <= LINEAR_MAX ? "carousel" : n <= FLOWER_MAX ? "flower" : "grid"; // "carousel" (auto)
}

/** Paint an option into an element — a glyph if it carries `svg`, else its `label`/value text. */
function renderOption(el: HTMLElement, o: WidgetPickerOption | undefined): void {
  if (o == null) { el.textContent = ""; return; }
  if (typeof o !== "string" && o.svg) {
    el.innerHTML = o.svg;
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) { inner.style.width = "100%"; inner.style.height = "100%"; inner.style.display = "block"; }
  } else {
    el.textContent = optLabel(o);
  }
}

/** A quick directional slide + fade as the value swaps (next ⇒ from the right, prev ⇒ from the left). */
function animateCarousel(el: HTMLElement, dir: number): void {
  try {
    const s = el.style;
    s.transition = "none";
    s.transform = `translateX(${dir * 8}px)`;
    s.opacity = "0.25";
    void el.offsetWidth; // force a reflow so the transition below actually runs
    s.transition = "transform 140ms ease, opacity 140ms ease";
    s.transform = "translateX(0)";
    s.opacity = "1";
  } catch { /* no layout engine (jsdom) */ }
}

/** Sync a picker element to the model — re-paints the value only when it changed, so it never
 *  clobbers an in-flight cycle animation. `color` is the accent the flower/grid inherit too. */
function updatePicker(el: HTMLElement, options: WidgetPickerOption[], value: string, name: string | undefined, mode: PickerMode, color: string | undefined, size: number | undefined): void {
  const opt = options.find((o) => optValue(o) === value) ?? options[0];
  el.title = opt ? optTitle(opt) : ""; // the trigger's tooltip follows the current value
  // a11y: announce the control + its current value, and whether it opens a menu (flower/grid).
  el.setAttribute("aria-haspopup", pickerLayout(mode, options.length) === "carousel" ? "false" : "menu");
  const cur = opt ? (optTitle(opt) || optLabel(opt)) : "";
  el.setAttribute("aria-label", name ? (cur ? `${name}: ${cur}` : name) : cur);
  // Size the trigger box. A GLYPH option needs a DEFINED px box — the inline svg is `width:100%`, so
  // without a box it falls back to its intrinsic size (e.g. 128px). A TEXT option uses `fontSize`.
  if (opt && typeof opt !== "string" && opt.svg) {
    const px = size != null ? size : PICKER_GLYPH_PX;
    el.style.width = `${px}px`;
    el.style.height = `${px}px`;
    el.style.fontSize = "";
  } else {
    el.style.width = "";
    el.style.height = "";
    el.style.fontSize = size != null ? `${size}px` : "";
  }
  const st = pickerState.get(el);
  if (!st) {
    pickerState.set(el, { options, value, name, mode, color });
    renderOption(el, opt);
    return;
  }
  st.options = options;
  st.name = name;
  st.mode = mode;
  st.color = color;
  if (st.value !== value) {
    st.value = value;
    renderOption(el, opt);
  }
}

/** Advance a (carousel-mode) picker by `dir` (+1 next, −1 previous), paint + animate, emit. */
function cyclePicker(el: HTMLElement, dir: number, card: Card): void {
  const st = pickerState.get(el);
  if (!st || st.options.length === 0) return;
  const cur = st.options.findIndex((o) => optValue(o) === st.value);
  const next = ((cur < 0 ? 0 : cur) + dir + st.options.length) % st.options.length;
  const opt = st.options[next]!;
  st.value = optValue(opt);
  renderOption(el, opt);
  el.title = optTitle(opt);
  animateCarousel(el, dir);
  card.emitEdit(st.value, st.name);
}

// ── flower / grid popups ───────────────────────────────────────────────────────

const PICKER_STYLE_ID = "draw-adapter-picker-style";
function ensurePickerStyle(): void {
  if (typeof document === "undefined" || document.getElementById(PICKER_STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = PICKER_STYLE_ID;
  st.textContent =
    // The flower container is a zero-size anchor point centred on the control; petals are absolutely
    // placed around it. It lets clicks through (pointer-events:none) so a press between petals reaches
    // the map and closes the flower; each petal re-enables capture.
    // Clickable choices mirror the trigger: BOLD + the picker's accent ink (`color`, e.g. orange),
    // carried on the popup container and inherited via `currentColor` (so glyphs tint too). The
    // container falls back to the neutral ink when no accent is set; the white pill/box keeps them
    // readable over the map.
    `.dap-picker-flower{position:fixed;z-index:1000;width:0;height:0;pointer-events:none;color:${CHROME_INK}}` +
    `.dap-picker-petal{position:absolute;left:0;top:0;width:${CHROME_BTN_PX}px;height:${CHROME_BTN_PX}px;margin:${-CHROME_BTN_PX / 2}px 0 0 ${-CHROME_BTN_PX / 2}px;` +
    `display:flex;align-items:center;justify-content:center;background:${CHROME_SURFACE};color:inherit;font-weight:bold;` +
    `border:${CHROME_BORDER};` +
    `border-radius:50%;box-shadow:${CHROME_SHADOW};cursor:pointer;padding:0;pointer-events:auto;` +
    `transition:transform 160ms cubic-bezier(.2,.8,.3,1.2),opacity 160ms ease}` +
    `.dap-picker-petal svg{display:block;width:${CHROME_GLYPH_PX}px;height:${CHROME_GLYPH_PX}px}` +
    `.dap-picker-petal:hover{background:${CHROME_HOVER}}` +
    // The grid popover is a solid box (like a toolbar flyout), JS-placed next to the control.
    `.dap-picker-grid{position:fixed;z-index:1000;display:grid;gap:2px;padding:4px;background:${CHROME_SURFACE};` +
    `border:${CHROME_BORDER};border-radius:6px;box-shadow:${CHROME_SHADOW};color:${CHROME_INK}}` +
    `.dap-picker-grid button{width:${CHROME_BTN_PX}px;height:${CHROME_BTN_PX}px;display:flex;align-items:center;justify-content:center;` +
    `background:${CHROME_SURFACE};color:inherit;border:0;border-radius:4px;cursor:pointer;padding:0;font:inherit;font-weight:bold}` +
    `.dap-picker-grid button svg{display:block;width:${CHROME_GLYPH_PX}px;height:${CHROME_GLYPH_PX}px}` +
    `.dap-picker-grid button:hover{background:${CHROME_HOVER}}` +
    // Highlight markers — the current value and the keyboard-focused choice. Both the ring AND a light
    // background tint use the accent (`currentColor`): an accent ring over an accent-into-white fill
    // (neutral-grey background fallback where `color-mix` is unsupported). Focus = a thicker ring than
    // the current marker so they're distinguishable when they differ.
    `.dap-picker-petal.dap-current,.dap-picker-grid button.dap-current{` +
    `background:rgba(0,0,0,.06);background:color-mix(in srgb,currentColor 16%,#fff);outline:1px solid currentColor}` +
    `.dap-picker-petal.dap-focus{` +
    `background:rgba(0,0,0,.06);background:color-mix(in srgb,currentColor 16%,#fff);box-shadow:0 0 0 2px currentColor,${CHROME_SHADOW}}` +
    `.dap-picker-grid button.dap-focus{` +
    `background:rgba(0,0,0,.06);background:color-mix(in srgb,currentColor 16%,#fff);box-shadow:0 0 0 2px currentColor}`;
  document.head.appendChild(st);
}

/** The single open popup (only one picker is ever open). Closing detaches it + its listeners. */
let openPopup: { el: HTMLElement; trigger: HTMLElement; onDocDown: (e: Event) => void; onKey: (e: KeyboardEvent) => void } | undefined;
function closePicker(): void {
  if (!openPopup) return;
  document.removeEventListener("pointerdown", openPopup.onDocDown, true);
  document.removeEventListener("keydown", openPopup.onKey, true);
  openPopup.el.remove();
  openPopup = undefined;
}
/** Is a popup currently open for this exact control? (so re-tapping the centre toggles it shut). */
function popupOpenFor(trigger: HTMLElement): boolean {
  return openPopup?.trigger === trigger;
}

/** Commit a choice: update the centre, emit, and collapse the popup. */
function choosePicker(trigger: HTMLElement, card: Card, value: string): void {
  const st = pickerState.get(trigger);
  if (!st) return;
  st.value = value;
  const opt = st.options.find((o) => optValue(o) === value);
  renderOption(trigger, opt);
  if (opt) trigger.title = optTitle(opt);
  closePicker();
  card.emitEdit(value, st.name);
}

/**
 * Place a fixed popup `el` and wire its two global listeners: a "press outside ⇒ close", and a
 * **keyboard navigation** one. While open, the arrow keys browse `items` (highlighting one), Enter /
 * Space pick the highlighted choice, Escape closes — all captured on `document` (so they fire before
 * the map's native pan-on-arrow handler) and swallowed, so the value browsing never moves the map.
 */
function mountPopup(el: HTMLElement, trigger: HTMLElement, items: { el: HTMLElement; value: string }[], current: number, card: Card): void {
  closePicker();
  if (typeof document === "undefined") return;
  document.body.appendChild(el);
  let idx = current >= 0 ? current : 0;
  const focus = (i: number): void => {
    if (!items.length) return;
    items[idx]?.el.classList.remove("dap-focus");
    idx = (i + items.length) % items.length;
    items[idx]?.el.classList.add("dap-focus");
  };
  focus(idx); // start on the current value
  const onDocDown = (e: Event): void => {
    const t = e.target;
    if (!trigger.isConnected) { closePicker(); return; }
    if (t instanceof Node && (el.contains(t) || trigger.contains(t))) return;
    closePicker();
  };
  const onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown") focus(idx + 1);
    else if (k === "ArrowLeft" || k === "ArrowUp") focus(idx - 1);
    else if (k === "Enter" || k === " " || k === "Spacebar") { if (items[idx]) choosePicker(trigger, card, items[idx]!.value); }
    else if (k === "Escape") closePicker();
    else return; // not a navigation key — let the app/map have it
    e.preventDefault();
    e.stopPropagation(); // don't let it reach the map (pan) or the consumer's onKey
  };
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  openPopup = { el, trigger, onDocDown, onKey };
}

/** Open the **flower**: petals fanned on a circle around the control, animating out from the centre. */
function openFlower(trigger: HTMLElement, card: Card): void {
  const st = pickerState.get(trigger);
  if (!st) return;
  ensurePickerStyle();
  const flower = document.createElement("div");
  flower.className = "dap-picker-flower";
  if (st.color) flower.style.color = st.color; // accent the petals (bold + this ink), inherited below
  const n = st.options.length;
  // Radius: large enough that N petals (≈34px pitch) don't overlap, with a sensible floor.
  const radius = Math.max(40, Math.round((n * 34) / (2 * Math.PI)));
  const items: { el: HTMLElement; value: string }[] = [];
  let current = -1;
  st.options.forEach((o, i) => {
    const petal = document.createElement("button");
    petal.type = "button";
    petal.className = "dap-picker-petal";
    petal.title = optTitle(o);
    if (optValue(o) === st.value) { petal.classList.add("dap-current"); current = i; } // selected ⇒ tinted bg + black ring
    renderOption(petal, o);
    const ang = -Math.PI / 2 + (i / n) * 2 * Math.PI; // start at the top, clockwise
    const dx = Math.round(Math.cos(ang) * radius);
    const dy = Math.round(Math.sin(ang) * radius);
    petal.style.transform = "translate(0,0) scale(.3)"; // start collapsed at the centre
    petal.style.opacity = "0";
    petal.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    petal.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); choosePicker(trigger, card, optValue(o)); });
    flower.appendChild(petal);
    items.push({ el: petal, value: optValue(o) });
    // Fan out on the next frame so the transition runs.
    const fan = (): void => { petal.style.transform = `translate(${dx}px,${dy}px) scale(1)`; petal.style.opacity = "1"; };
    try { requestAnimationFrame(fan); } catch { fan(); }
  });
  mountPopup(flower, trigger, items, current, card);
  placeAtCenter(flower, trigger);
}

/** Open the **grid**: a wrap-grid popover of all options, placed below the control. */
function openGrid(trigger: HTMLElement, card: Card): void {
  const st = pickerState.get(trigger);
  if (!st) return;
  ensurePickerStyle();
  const grid = document.createElement("div");
  grid.className = "dap-picker-grid";
  if (st.color) grid.style.color = st.color; // accent the cells (bold + this ink), inherited below
  const cols = Math.min(6, Math.ceil(Math.sqrt(st.options.length)));
  grid.style.gridTemplateColumns = `repeat(${cols}, 30px)`;
  const items: { el: HTMLElement; value: string }[] = [];
  let current = -1;
  st.options.forEach((o, i) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.title = optTitle(o);
    if (optValue(o) === st.value) { cell.classList.add("dap-current"); current = i; }
    renderOption(cell, o);
    cell.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    cell.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); choosePicker(trigger, card, optValue(o)); });
    grid.appendChild(cell);
    items.push({ el: cell, value: optValue(o) });
  });
  mountPopup(grid, trigger, items, current, card);
  placeBelow(grid, trigger);
}

/** Centre a (zero-size) popup on the control's centre. */
function placeAtCenter(el: HTMLElement, trigger: HTMLElement): void {
  if (typeof window === "undefined") return;
  const t = trigger.getBoundingClientRect();
  el.style.left = `${t.left + t.width / 2}px`;
  el.style.top = `${t.top + t.height / 2}px`;
}
/** Place a popup just below the control, left-aligned (viewport coords). */
function placeBelow(el: HTMLElement, trigger: HTMLElement): void {
  if (typeof window === "undefined") return;
  const t = trigger.getBoundingClientRect();
  el.style.left = `${t.left}px`;
  el.style.top = `${t.bottom + 4}px`;
}

/** Tap behaviour for a picker, dispatched by its resolved layout: a carousel cycles in place; a
 *  flower/grid toggles its popup open (re-tapping the centre closes it). */
function tapPicker(el: HTMLElement, card: Card, shift: boolean): void {
  const st = pickerState.get(el);
  const layout = st ? pickerLayout(st.mode, st.options.length) : "carousel";
  if (layout === "carousel") { cyclePicker(el, shift ? -1 : 1, card); return; }
  if (popupOpenFor(el)) { closePicker(); return; }
  if (layout === "flower") openFlower(el, card);
  else openGrid(el, card);
}

/** Wire a picker as **both** a control and a drag handle: a clean **tap** acts on it (cycle, or open
 *  the flower/grid); a **drag** (press + move past ~3 px) forwards the gesture to the card so the
 *  whole card moves — so the control area no longer blocks dragging. */
function wirePicker(el: HTMLElement, card: Card): void {
  let downEvt: globalThis.PointerEvent | null = null;
  let dragging = false;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downEvt = e;
    dragging = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  el.addEventListener("pointermove", (e) => {
    if (!downEvt) return;
    if (!dragging && (Math.abs(e.clientX - downEvt.clientX) > 3 || Math.abs(e.clientY - downEvt.clientY) > 3)) {
      dragging = true;
      card.forwardDrag("down", downEvt); // begin the card drag at the original press point
    }
    if (dragging) card.forwardDrag("move", e);
  });
  const finish = (e: globalThis.PointerEvent, tap: boolean): void => {
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (dragging) card.forwardDrag("up", e);     // a drag moved the card
    else if (tap && downEvt) { card.tapSelect(e); tapPicker(el, card, e.shiftKey); card.focusHost(); } // a tap selects + acts
    dragging = false;
    downEvt = null;
  };
  el.addEventListener("pointerup", (e) => finish(e, true));
  el.addEventListener("pointercancel", (e) => finish(e, false)); // a cancelled gesture is never a tap
  el.addEventListener("click", (e) => { e.stopPropagation(); }); // guard — never leak to map
  el.addEventListener("mousedown", (e) => { e.stopPropagation(); }); // keep the compat event off the Marker
}

// ── gauge / dial value-editors (shared DOM, one impl across the 3 engines) ─────

const SVGNS = "http://www.w3.org/2000/svg";
const KNOB = 11;            // knob diameter (px)
// Both editors share a visual language: a THIN, well-marked central GUIDE line all along, plus a
// WIDE faint glow marking the SELECTED part — the span between the gauge cursors, or the dial arc
// from its start up to the value.
const GUIDE_W = 2;
const GUIDE_OPACITY = "0.9";
const SELECT_W = 9;
const SELECT_OPACITY = "0.4";
const GAUGE_MARGIN = 12; // px the gauge guide line extends past the outer cursors
const CURSOR_LABEL_H = 16; // min px between cursor label centers to prevent text overlap
const GAUGE_LEN = 120;      // default gauge track length
const DIAL_R = 52;          // default dial radius
const DIAL_SWEEP = 240;     // default dial sweep (deg)
const DIAL_MIN_ANGLE = 150; // min sits down-left; the sweep runs over the top to max (speedometer)
const DIAL_LABEL_GAP = 16;  // the dial label sits this far OUTSIDE the radius, at the knob's angle
const RING_HIT_W = KNOB + SELECT_W; // px width of the invisible ring hit-area (covers the knob + halo band)

/** A press on a value-editor must never start a card drag / map pan / leak a native click. */
function preventCardDrag(el: HTMLElement): void {
  el.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
  el.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  el.addEventListener("click", (e) => { e.stopPropagation(); });
}

function snapStep(v: number, step: number | undefined): number {
  return step && step > 0 ? Math.round(v / step) * step : v;
}
/** Reachable `[lo, hi]` for a gauge incl. the optional one-step `beyond` notches. */
export function gaugeBounds(g: WidgetGauge): { lo: number; hi: number } {
  const s = g.step ?? 0;
  return { lo: g.min - (g.beyond?.below ? s : 0), hi: g.max + (g.beyond?.above ? s : 0) };
}
/** Snap + clamp a dragged cursor: inside the bounds, and never past its neighbours (no crossing). */
export function clampCursor(raw: number, index: number, g: WidgetGauge): number {
  const { lo, hi } = gaugeBounds(g);
  let v = snapStep(Math.min(hi, Math.max(lo, raw)), g.step);
  const cursors = g.cursors ?? [];
  const prev = cursors[index - 1];
  const next = cursors[index + 1];
  if (prev) v = Math.max(v, prev.value);
  if (next) v = Math.min(v, next.value);
  return v;
}
function valueFraction(value: number, min: number, max: number): number {
  return max === min ? 0 : (value - min) / (max - min);
}
/** Dial angle (deg) for a value, per the FIXED convention. */
export function dialAngle(value: number, d: WidgetDial): number {
  return DIAL_MIN_ANGLE + valueFraction(value, d.min, d.max) * (d.sweep ?? DIAL_SWEEP);
}
/** Map a pointer angle (deg, screen convention) to a dial value — a drag into the bottom gap clamps
 *  to the nearer end. */
export function dialValueFromAngle(angleDeg: number, d: WidgetDial): number {
  const sweep = d.sweep ?? DIAL_SWEEP;
  let rel = (angleDeg - DIAL_MIN_ANGLE) % 360;
  if (rel < 0) rel += 360;
  if (rel > sweep) rel = rel < (sweep + 360) / 2 ? sweep : 0; // bottom gap ⇒ snap to nearer end
  return snapStep(d.min + (rel / sweep) * (d.max - d.min), d.step);
}
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
/** SVG arc path on the dial ring from `fromDeg` to `toDeg` (clockwise). Empty for a ~0 sweep, so a
 *  zero-length "selected" arc draws nothing (no round-cap blob at the start). */
function dialArcPath(R: number, ar: number, fromDeg: number, toDeg: number): string {
  const sweep = (((toDeg - fromDeg) % 360) + 360) % 360;
  if (sweep < 0.5) return "";
  const [x0, y0] = polar(R, R, ar, fromDeg);
  const [x1, y1] = polar(R, R, ar, toDeg);
  return `M ${x0} ${y0} A ${ar} ${ar} 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

const RANGE_BAND_W = KNOB + 4; // colored band width (px), centred on the axis
const FLING_SHOW_DX   = 8;   // px: lateral dx to detect direction and reveal the trash icon
const FLING_COMMIT_DX = 50;  // px: commit threshold on pointerup (trash is positioned to match)
// Minimal trash-bin icon (SVG)
const TRASH_BIN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4h6v2"/></svg>`;

interface GaugeKnob { dot: HTMLElement; label: HTMLElement; }
interface RangeDomState {
  halo: HTMLElement;
  base: GaugeKnob;
  top: GaugeKnob;
  live: { base: number; top: number };
  dragging: "base" | "top" | "band" | null;
  bandDownAlong: number;   // along-axis (Y for vertical) screen position at band drag start
  liveBandBase: number;    // base value captured at band drag start
  liveBandTop: number;     // top value captured at band drag start
  haloOpacity: string;     // opacity set by last updateGaugeRanges (snap-back restore)
  bandDownX: number;       // clientX at band pointerdown (horizontal fling detection)
  bandDownY: number;       // clientY at band pointerdown
  bandGesture: "pending" | "vertical" | "fling"; // gesture direction resolved on first significant move
}
interface GaugeState {
  trackHalo: HTMLElement;
  track: HTMLElement;
  knobs: GaugeKnob[];
  gauge: WidgetGauge;
  dragging: number | null;
  live: number[];
  rangeStates: RangeDomState[];
  hoverAddEl: HTMLElement | null;
  hoverAddWired: boolean;
}
const gaugeState = new WeakMap<HTMLElement, GaugeState>();

function createGauge(): HTMLElement {
  const root = document.createElement("div");
  root.className = "draw-adapter-widget-gauge";
  const rs = root.style;
  rs.position = "relative"; rs.display = "inline-block"; rs.flex = "0 0 auto"; rs.touchAction = "none";
  preventCardDrag(root);
  const trackHalo = document.createElement("div"); // WIDE faint glow ⇒ the selected span
  trackHalo.style.position = "absolute"; trackHalo.style.borderRadius = `${SELECT_W / 2}px`;
  trackHalo.style.background = "currentColor"; trackHalo.style.opacity = SELECT_OPACITY;
  const track = document.createElement("div"); // THIN central guide line (extends a bit past the cursors)
  track.style.position = "absolute"; track.style.borderRadius = `${GUIDE_W / 2}px`;
  track.style.background = "currentColor"; track.style.opacity = GUIDE_OPACITY;
  root.append(trackHalo, track); // wide glow behind, thin guide on top
  gaugeState.set(root, { trackHalo, track, knobs: [], gauge: { kind: "gauge", min: 0, max: 1, cursors: [] }, dragging: null, live: [], rangeStates: [], hoverAddEl: null, hoverAddWired: false });
  return root;
}

/** Distance of a fraction along the track from its start (vertical: max ⇒ top). */
function gaugeAlong(frac: number, len: number, horizontal: boolean): number {
  return horizontal ? frac * len : (1 - frac) * len;
}
function placeKnob(k: GaugeKnob, along: number, horizontal: boolean): void {
  const s = k.dot.style;
  if (horizontal) { s.left = `${along}px`; s.top = "0"; } else { s.top = `${along}px`; s.left = "0"; }
  const ls = k.label.style;
  if (horizontal) { ls.left = `${along + KNOB / 2}px`; ls.top = `${KNOB + 1}px`; ls.transform = "translateX(-50%)"; }
  else { ls.top = `${along + KNOB / 2}px`; ls.left = `${KNOB + 4}px`; ls.transform = "translateY(-50%)"; }
}
function placeLabelCenter(k: GaugeKnob, center: number, horizontal: boolean): void {
  const ls = k.label.style;
  if (horizontal) { ls.left = `${center}px`; ls.top = `${KNOB + 1}px`; ls.transform = "translateX(-50%)"; }
  else { ls.top = `${center}px`; ls.left = `${KNOB + 4}px`; ls.transform = "translateY(-50%)"; }
}
/** Spread positions so no adjacent pair (in sorted order) is closer than minGap; clamps to [0, max]. */
function spreadAlongs(naturals: number[], minGap: number, max: number): number[] {
  const n = naturals.length;
  if (n <= 1) return [...naturals];
  const order = [...naturals.keys()].sort((a, b) => naturals[a]! - naturals[b]!);
  const out = [...naturals];
  for (let k = 1; k < n; k++) {
    const prev = order[k - 1]!, cur = order[k]!;
    if (out[cur]! < out[prev]! + minGap) out[cur] = out[prev]! + minGap;
  }
  for (const i of order) out[i] = Math.min(out[i]!, max);
  for (let k = n - 2; k >= 0; k--) {
    const prev = order[k]!, cur = order[k + 1]!;
    if (out[prev]! > out[cur]! - minGap) out[prev] = Math.max(0, out[cur]! - minGap);
  }
  return out;
}
/** Position an absolute bar of thickness `barW` from `lo`→`hi` along the track (px, along-space). */
function placeBar(el: HTMLElement, lo: number, hi: number, barW: number, horizontal: boolean): void {
  const s = el.style;
  const length = Math.max(0, hi - lo);
  if (horizontal) { s.left = `${KNOB / 2 + lo}px`; s.top = `${(KNOB - barW) / 2}px`; s.width = `${length}px`; s.height = `${barW}px`; }
  else { s.top = `${KNOB / 2 + lo}px`; s.left = `${(KNOB - barW) / 2}px`; s.height = `${length}px`; s.width = `${barW}px`; }
}

/** Draw the gauge guide: a THIN central line hugging the cursors (extended a bit past them, never
 *  min→max) + a WIDE faint glow on the SELECTED span between the first & last cursor. */
function placeGaugeGuide(st: GaugeState, len: number, horizontal: boolean): void {
  const g = st.gauge, n = st.live.length;
  if (n === 0) { st.track.style.display = "none"; st.trackHalo.style.display = "none"; return; }
  st.track.style.display = "block";
  st.trackHalo.style.display = "block";
  const a0 = gaugeAlong(valueFraction(st.live[0]!, g.min, g.max), len, horizontal);
  const aN = gaugeAlong(valueFraction(st.live[n - 1]!, g.min, g.max), len, horizontal);
  const lo = Math.min(a0, aN), hi = Math.max(a0, aN);
  const gLo = Math.max(0, lo - GAUGE_MARGIN), gHi = Math.min(len, hi + GAUGE_MARGIN);
  placeBar(st.track, gLo, gHi, GUIDE_W, horizontal); // thin guide: cursors ± margin
  // selected glow: the span between first & last cursor (≥2), or the WHOLE visible guide for one cursor
  if (n >= 2) placeBar(st.trackHalo, lo, hi, SELECT_W, horizontal);
  else placeBar(st.trackHalo, gLo, gHi, SELECT_W, horizontal);
}

function updateGauge(root: HTMLElement, g: WidgetGauge, card: Card): void {
  const st = gaugeState.get(root)!;
  st.gauge = g;
  if (g.color) root.style.color = g.color;

  if (g.ranges?.length) {
    // tear down any cursor-mode knobs left over from a possible mode switch
    for (const k of st.knobs) { k.dot.remove(); k.label.remove(); }
    st.knobs = []; st.dragging = null;
    st.trackHalo.style.display = "none";
    updateGaugeRanges(root, g, card);
    return;
  }

  // cursor mode — tear down range DOM when switching from ranges to cursors
  if (st.rangeStates.length) {
    for (const rng of st.rangeStates) {
      rng.halo.remove();
      rng.base.dot.remove(); rng.base.label.remove();
      rng.top.dot.remove(); rng.top.label.remove();
    }
    st.rangeStates = [];
    st.trackHalo.style.display = "block";
    if (st.hoverAddEl) st.hoverAddEl.style.visibility = "hidden";
  }

  const cursors = g.cursors ?? [];
  const len = g.length ?? GAUGE_LEN;
  const horizontal = g.orientation === "horizontal";
  const maxChars = cursors.reduce((m, c) => Math.max(m, (c.label ?? "").length), 0);
  const rs = root.style;
  if (horizontal) { rs.width = `${len + KNOB}px`; rs.height = `${KNOB + (maxChars ? 14 : 0)}px`; }
  else { rs.height = `${len + KNOB}px`; rs.width = maxChars ? `calc(${KNOB + 4}px + ${maxChars}ch)` : `${KNOB}px`; }
  while (st.knobs.length < cursors.length) addKnob(root, st, card);
  while (st.knobs.length > cursors.length) { const k = st.knobs.pop()!; k.dot.remove(); k.label.remove(); }
  // keep the dragged cursor under the pointer; take the others from the model
  st.live = cursors.map((c, i) => (st.dragging === i ? (st.live[i] ?? c.value) : c.value));
  // Pre-compute natural along positions then fan coincident dots / spread overlapping labels.
  const naturalAlongs = st.live.map((v) => gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal));
  const labelCenters = spreadAlongs(naturalAlongs.map((a) => a + KNOB / 2), CURSOR_LABEL_H, len + KNOB / 2);
  for (let i = 0; i < cursors.length; i++) {
    const k = st.knobs[i]!;
    k.label.textContent = cursors[i]!.label ?? "";
    applyLabelStyle(k.label, g.labelColor, g.labelHalo);
    k.dot.style.background = g.knobFill ?? "currentColor";
    const gStroke = g.knobStroke ?? "white"; // default white border; pass "" for none
    k.dot.style.border = gStroke ? `1.5px solid ${gStroke}` : "none";
    k.dot.setAttribute("aria-valuemin", String(g.min));
    k.dot.setAttribute("aria-valuemax", String(g.max));
    k.dot.setAttribute("aria-valuenow", String(st.live[i]!));
    k.dot.setAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
    const clabel = cursors[i]!.label || cursors[i]!.name;
    if (clabel) k.dot.setAttribute("aria-label", clabel);
    if (st.dragging !== i) { placeKnob(k, naturalAlongs[i]!, horizontal); placeLabelCenter(k, labelCenters[i]!, horizontal); }
  }
  // Central cursor (middle index) gets highest z-index so it stays grabable when coincident.
  // For N=2 the formula ties — break it so lower index wins (lo can be dragged down at ceiling).
  const n = cursors.length;
  const zValues: number[] = [];
  for (let i = 0; i < n; i++) {
    const z = n > 1 ? (n === 2 ? n - i : n + 1 - Math.abs(2 * i - (n - 1))) : 0;
    st.knobs[i]!.dot.style.zIndex = z > 0 ? String(z) : "";
    zValues.push(z);
  }
  // When two cursors share the same value, hide the label of the one underneath — it's redundant.
  for (let i = 0; i < n; i++) {
    const dominated = zValues.some((zj, j) => j !== i && st.live[j] === st.live[i] && zj > zValues[i]!);
    st.knobs[i]!.label.style.visibility = dominated ? "hidden" : "";
  }
  placeGaugeGuide(st, len, horizontal);
}

function addKnob(root: HTMLElement, st: GaugeState, card: Card): void {
  const dot = document.createElement("div");
  dot.className = "draw-adapter-widget-knob";
  const ds = dot.style;
  ds.position = "absolute"; ds.width = ds.height = `${KNOB}px`; ds.boxSizing = "border-box";
  ds.borderRadius = "50%"; ds.background = "currentColor"; ds.cursor = "pointer"; ds.touchAction = "none";
  const label = document.createElement("span");
  const ls = label.style; ls.position = "absolute"; ls.whiteSpace = "nowrap"; ls.pointerEvents = "none";
  const index = st.knobs.length;
  st.knobs.push({ dot, label });
  root.append(dot, label);
  wireKnobDrag(root, dot, index, card);
  // a11y: a focusable slider; arrows step the value by `step` (or 1% of the range), clamped like a drag.
  dot.setAttribute("role", "slider");
  dot.tabIndex = 0;
  dot.addEventListener("keydown", (e) => {
    const s = gaugeState.get(root); if (!s) return;
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const g = s.gauge, len = g.length ?? GAUGE_LEN, horizontal = g.orientation === "horizontal";
    const step = g.step ?? (g.max - g.min) / 100;
    const cur = s.live[index] ?? (g.cursors ?? [])[index]?.value ?? g.min;
    const v = clampCursor(cur + dir * step, index, g);
    s.live[index] = v;
    placeKnob(s.knobs[index]!, gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal), horizontal);
    placeGaugeGuide(s, len, horizontal);
    dot.setAttribute("aria-valuenow", String(v));
    card.emitEdit(String(v), (g.cursors ?? [])[index]?.name);
  });
}

function wireKnobDrag(root: HTMLElement, dot: HTMLElement, index: number, card: Card): void {
  dot.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    const st = gaugeState.get(root); if (!st) return;
    st.dragging = index;
    try { dot.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  dot.addEventListener("pointermove", (e) => {
    const st = gaugeState.get(root); if (!st || st.dragging !== index) return;
    const g = st.gauge, len = g.length ?? GAUGE_LEN, horizontal = g.orientation === "horizontal";
    // Map against the CONTAINER (fixed size), NOT the guide line: the guide now resizes to hug the
    // cursors, so reading its rect would feed back into the value and make the drag jitter. The track
    // area is inset by KNOB/2 at each end and spans `len`.
    const rect = root.getBoundingClientRect();
    const frac = horizontal
      ? (e.clientX - rect.left - KNOB / 2) / len
      : 1 - (e.clientY - rect.top - KNOB / 2) / len;
    const v = clampCursor(g.min + frac * (g.max - g.min), index, g);
    st.live[index] = v;
    placeKnob(st.knobs[index]!, gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal), horizontal);
    placeGaugeGuide(st, len, horizontal);
    card.emitEdit(String(v), (g.cursors ?? [])[index]?.name);
  });
  const end = (e: globalThis.PointerEvent): void => {
    const st = gaugeState.get(root); if (!st || st.dragging !== index) return;
    st.dragging = null;
    try { dot.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  dot.addEventListener("pointerup", end);
  dot.addEventListener("pointercancel", end);
}

// ── multi-range gauge ────────────────────────────────────────────────────────

function createRangeDom(root: HTMLElement, idx: number, st: GaugeState, card: Card): RangeDomState {
  const halo = document.createElement("div");
  halo.style.position = "absolute";
  halo.style.borderRadius = `${RANGE_BAND_W / 2}px`;
  halo.style.cursor = "grab";
  halo.style.touchAction = "none";
  root.appendChild(halo);

  const makeKnob = (): GaugeKnob => {
    const dot = document.createElement("div");
    dot.className = "draw-adapter-widget-knob";
    const ds = dot.style;
    ds.position = "absolute"; ds.width = ds.height = `${KNOB}px`; ds.boxSizing = "border-box";
    ds.borderRadius = "50%"; ds.cursor = "pointer"; ds.touchAction = "none";
    ds.border = "1.5px solid white";
    dot.setAttribute("role", "slider"); dot.tabIndex = 0;
    const label = document.createElement("span");
    const ls = label.style;
    ls.position = "absolute"; ls.whiteSpace = "nowrap"; ls.pointerEvents = "none";
    root.append(dot, label);
    return { dot, label };
  };
  const base = makeKnob();
  const top = makeKnob();

  const rng: RangeDomState = { halo, base, top, live: { base: 0, top: 0 }, dragging: null, bandDownAlong: 0, liveBandBase: 0, liveBandTop: 0, haloOpacity: "0.30", bandDownX: 0, bandDownY: 0, bandGesture: "pending" };
  wireRangeKnobDrag(root, base.dot, "base", idx, st, card);
  wireRangeKnobDrag(root, top.dot, "top", idx, st, card);
  wireRangeBandDrag(root, halo, idx, st, card);
  return rng;
}

function wireRangeKnobDrag(root: HTMLElement, dot: HTMLElement, which: "base" | "top", idx: number, st: GaugeState, card: Card): void {
  dot.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    const rng = st.rangeStates[idx]; if (!rng) return;
    rng.dragging = which;
    try { dot.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
    // emit on pointerdown so the consumer can identify which range was touched
    const range = st.gauge.ranges?.[idx]; if (!range) return;
    card.emitEdit(String(rng.live[which]), (which === "base" ? range.base : range.top).name);
  });
  dot.addEventListener("pointermove", (e) => {
    const rng = st.rangeStates[idx]; if (!rng || rng.dragging !== which) return;
    const g = st.gauge;
    const range = g.ranges?.[idx]; if (!range) return;
    const len = g.length ?? GAUGE_LEN;
    const horizontal = g.orientation === "horizontal";
    const rect = root.getBoundingClientRect();
    const frac = horizontal
      ? (e.clientX - rect.left - KNOB / 2) / len
      : 1 - (e.clientY - rect.top - KNOB / 2) / len;
    const { lo, hi } = gaugeBounds(g);
    let v = snapStep(Math.min(hi, Math.max(lo, g.min + frac * (g.max - g.min))), g.step);
    if (which === "base") v = Math.min(v, rng.live.top);
    else                  v = Math.max(v, rng.live.base);
    rng.live[which] = v;
    placeKnob(rng[which], gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal), horizontal);
    const bA = gaugeAlong(valueFraction(rng.live.base, g.min, g.max), len, horizontal);
    const tA = gaugeAlong(valueFraction(rng.live.top,  g.min, g.max), len, horizontal);
    placeBar(rng.halo, Math.min(bA, tA), Math.max(bA, tA), RANGE_BAND_W, horizontal);
    dot.setAttribute("aria-valuenow", String(v));
    card.emitEdit(String(v), (which === "base" ? range.base : range.top).name);
  });
  const end = (e: globalThis.PointerEvent): void => {
    const rng = st.rangeStates[idx]; if (!rng || rng.dragging !== which) return;
    rng.dragging = null;
    try { dot.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  dot.addEventListener("pointerup", end);
  dot.addEventListener("pointercancel", end);
  dot.addEventListener("keydown", (e) => {
    const rng = st.rangeStates[idx]; if (!rng) return;
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const g = st.gauge;
    const range = g.ranges?.[idx]; if (!range) return;
    const len = g.length ?? GAUGE_LEN;
    const horizontal = g.orientation === "horizontal";
    const step = g.step ?? (g.max - g.min) / 100;
    const { lo, hi } = gaugeBounds(g);
    let v = snapStep(Math.min(hi, Math.max(lo, rng.live[which] + dir * step)), g.step);
    if (which === "base") v = Math.min(v, rng.live.top);
    else                  v = Math.max(v, rng.live.base);
    rng.live[which] = v;
    placeKnob(rng[which], gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal), horizontal);
    dot.setAttribute("aria-valuenow", String(v));
    card.emitEdit(String(v), (which === "base" ? range.base : range.top).name);
  });
}

function wireRangeBandDrag(root: HTMLElement, halo: HTMLElement, idx: number, st: GaugeState, card: Card): void {
  // Trash icon: one element per range, lazily appended to card.root, reused across drags.
  let trashEl: HTMLElement | null = null;

  const getOrCreateTrash = (): HTMLElement => {
    if (!trashEl) {
      const el = document.createElement("div");
      el.className = "draw-adapter-range-trash";
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = TRASH_BIN_SVG;
      const s = el.style;
      s.position = "absolute";
      s.width = s.height = "36px";
      s.borderRadius = "50%";
      s.display = "none";
      s.alignItems = "center";
      s.justifyContent = "center";
      s.pointerEvents = "none";
      s.top = "50%";
      s.transform = "translateY(-50%)";
      s.boxSizing = "border-box";
      s.transition = "background 0.1s, color 0.1s, border-color 0.1s";
      card.root.appendChild(el);
      trashEl = el;
    }
    return trashEl;
  };

  const showTrash = (_dir: 1 | -1, armed: boolean): void => {
    const el = getOrCreateTrash();
    const s = el.style;
    // Always on the right side of the card (direction-independent — simpler and sufficient)
    s.right = ""; s.left = "calc(100% + 6px)";
    if (armed) {
      s.background = "rgba(192,0,0,0.85)"; s.color = "white";
      s.border = "2px solid #c00";
    } else {
      s.background = "rgba(192,0,0,0.12)"; s.color = "#c00";
      s.border = "2px solid rgba(192,0,0,0.4)";
    }
    s.display = "flex";
  };

  const hideTrash = (): void => {
    if (trashEl) trashEl.style.display = "none";
  };

  halo.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    const rng = st.rangeStates[idx]; if (!rng) return;
    const g = st.gauge;
    const horizontal = g.orientation === "horizontal";
    const rect = root.getBoundingClientRect();
    rng.dragging = "band";
    rng.bandDownAlong = horizontal ? (e.clientX - rect.left) : (e.clientY - rect.top);
    rng.bandDownX = e.clientX;
    rng.bandDownY = e.clientY;
    rng.bandGesture = "pending";
    rng.liveBandBase = rng.live.base;
    rng.liveBandTop  = rng.live.top;
    try { halo.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
    const range = g.ranges?.[idx]; if (!range) return;
    card.emitEdit(String(rng.live.base), range.base.name);
  });

  halo.addEventListener("pointermove", (e) => {
    const rng = st.rangeStates[idx]; if (!rng || rng.dragging !== "band") return;
    const g = st.gauge;
    const range = g.ranges?.[idx]; if (!range) return;
    const horizontal = g.orientation === "horizontal";

    // Lateral-drag / trash-icon path: vertical gauges only
    if (!horizontal && rng.bandGesture !== "vertical") {
      const dx = e.clientX - rng.bandDownX;
      const dy = e.clientY - rng.bandDownY;
      const adx = Math.abs(dx), ady = Math.abs(dy);

      if (rng.bandGesture === "pending") {
        const canDelete = (g.ranges?.length ?? 0) > 1; // no trash when only one range remains
        if (adx > FLING_SHOW_DX && adx > ady && canDelete) {
          rng.bandGesture = "fling";
        } else if (ady > 3) {
          rng.bandGesture = "vertical";
        } else {
          return; // direction undecided — wait
        }
      }

      if (rng.bandGesture === "fling") {
        const dir: 1 | -1 = dx > 0 ? 1 : -1;
        const armed = adx >= FLING_COMMIT_DX;
        showTrash(dir, armed);
        // Band follows cursor; dims when armed
        halo.style.transform = `translateX(${dx}px)`;
        halo.style.opacity = armed ? "0.25" : rng.haloOpacity;
        halo.style.background = range.fill ?? range.color;
        return;
      }
    }

    // Vertical (along-axis) band drag — unchanged
    const len = g.length ?? GAUGE_LEN;
    const rect = root.getBoundingClientRect();
    const currentAlong = horizontal ? (e.clientX - rect.left) : (e.clientY - rect.top);
    const deltaAlong = currentAlong - rng.bandDownAlong;
    const deltaVal = horizontal
      ? deltaAlong / len * (g.max - g.min)
      : -deltaAlong / len * (g.max - g.min);
    const width = rng.liveBandTop - rng.liveBandBase;
    let newBase = rng.liveBandBase + deltaVal;
    let newTop  = rng.liveBandTop  + deltaVal;
    const { lo, hi } = gaugeBounds(g);
    if (newBase < lo) { newBase = lo; newTop = lo + width; }
    if (newTop  > hi) { newTop  = hi; newBase = hi - width; }
    newBase = snapStep(newBase, g.step);
    newTop  = snapStep(newTop,  g.step);
    rng.live.base = newBase;
    rng.live.top  = newTop;
    const bA = gaugeAlong(valueFraction(newBase, g.min, g.max), len, horizontal);
    const tA = gaugeAlong(valueFraction(newTop,  g.min, g.max), len, horizontal);
    placeKnob(rng.base, bA, horizontal);
    placeKnob(rng.top,  tA, horizontal);
    placeBar(rng.halo, Math.min(bA, tA), Math.max(bA, tA), RANGE_BAND_W, horizontal);
    rng.base.dot.setAttribute("aria-valuenow", String(newBase));
    rng.top.dot.setAttribute("aria-valuenow", String(newTop));
    card.emitEdit(String(newBase), range.base.name);
    card.emitEdit(String(newTop),  range.top.name);
  });

  const end = (e: globalThis.PointerEvent): void => {
    const rng = st.rangeStates[idx]; if (!rng || rng.dragging !== "band") return;
    const g = st.gauge;
    const gesture = rng.bandGesture;
    rng.dragging = null;
    rng.bandGesture = "pending";
    try { halo.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    if (gesture === "fling") {
      const dx = e.clientX - rng.bandDownX;
      if (Math.abs(dx) >= FLING_COMMIT_DX) {
        // User dragged onto the trash zone — emit removeRange
        const range = g.ranges?.[idx];
        const rangeId = range?.id != null ? `:${range.id}` : "";
        card.emitAction(`removeRange:${idx}${rangeId}`);
      }
      // Always snap the band back regardless of commit
      halo.style.transform = "";
      halo.style.opacity = rng.haloOpacity;
      halo.style.background = g.ranges?.[idx]?.fill ?? g.ranges?.[idx]?.color ?? "";
    }
    hideTrash();
  };
  halo.addEventListener("pointerup", end);
  halo.addEventListener("pointercancel", end);
}

const HOVER_ADD_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`;

/** Wire the transient hover-"+" affordance on the gauge root (ranges mode only). Called once;
 *  subsequent calls are no-ops. The listener uses `st.gauge` (always current) to decide
 *  whether to show and where to place the `+`. */
function ensureGaugeHoverAdd(root: HTMLElement, st: GaugeState, card: Card): void {
  if (st.hoverAddWired) return;
  st.hoverAddWired = true;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Add layer here");
  const s = btn.style;
  s.position = "absolute";
  s.width = "18px"; s.height = "18px";
  s.borderRadius = "50%";
  s.border = "1px solid #1f2328";
  s.background = "#fff";
  s.padding = "3px";
  s.display = "flex"; s.alignItems = "center"; s.justifyContent = "center";
  s.transform = "translate(-50%, -50%)";
  s.cursor = "pointer";
  s.boxSizing = "border-box";
  s.userSelect = "none";
  s.color = "#000";
  s.zIndex = "200";
  s.visibility = "hidden";
  s.setProperty("appearance", "none");
  s.setProperty("-webkit-appearance", "none");
  btn.innerHTML = HOVER_ADD_SVG;
  const inner = btn.firstElementChild as HTMLElement | null;
  if (inner) { inner.style.width = "100%"; inner.style.height = "100%"; inner.style.display = "block"; }
  root.appendChild(btn);
  st.hoverAddEl = btn;

  // Value label shown alongside the "+" (same style as knob labels)
  const lbl = document.createElement("span");
  const ls = lbl.style;
  ls.position = "absolute";
  ls.whiteSpace = "nowrap";
  ls.pointerEvents = "none";
  ls.visibility = "hidden";
  ls.zIndex = "200";
  applyLabelStyle(lbl, undefined, undefined); // black text, white halo
  root.appendChild(lbl);

  let hoverVal: number | null = null;

  const hide = (): void => {
    btn.style.visibility = "hidden";
    lbl.style.visibility = "hidden";
    hoverVal = null;
  };

  wireTapButton(btn, () => {
    if (hoverVal == null) return;
    card.emitAction(`addLayerAt:${hoverVal}`);
    hide();
  });

  root.addEventListener("pointermove", (e) => {
    const g = st.gauge;
    if (!g.ranges?.length || !g.canAdd) { hide(); return; }
    if (st.rangeStates.some((rng) => rng.dragging !== null)) { hide(); return; }
    const len = g.length ?? GAUGE_LEN;
    const horizontal = g.orientation === "horizontal";
    const rect = root.getBoundingClientRect();
    const frac = horizontal
      ? (e.clientX - rect.left - KNOB / 2) / len
      : 1 - (e.clientY - rect.top - KNOB / 2) / len;
    const raw = g.min + frac * (g.max - g.min);
    const v = snapStep(Math.min(g.max, Math.max(g.min, raw)), g.step);
    if (v >= g.max) { hide(); return; }
    const inOccupied = g.ranges.some((r) => v >= Math.min(r.base.value, r.top.value) && v <= Math.max(r.base.value, r.top.value));
    if (inOccupied) { hide(); return; }
    const along = gaugeAlong(valueFraction(v, g.min, g.max), len, horizontal);
    hoverVal = v;
    lbl.textContent = String(v);
    if (horizontal) {
      btn.style.left = `${KNOB / 2 + along}px`; btn.style.top = `${KNOB / 2}px`;
      ls.left = `${KNOB / 2 + along}px`; ls.top = `${KNOB + 1}px`; ls.transform = "translateX(-50%)";
    } else {
      btn.style.top  = `${KNOB / 2 + along}px`; btn.style.left = `${KNOB / 2}px`;
      ls.top = `${KNOB / 2 + along}px`; ls.left = `${KNOB + 4}px`; ls.transform = "translateY(-50%)";
    }
    btn.style.visibility = "visible";
    lbl.style.visibility = "visible";
  });

  root.addEventListener("pointerleave", hide);
}

function updateGaugeRanges(root: HTMLElement, g: WidgetGauge, card: Card): void {
  const st = gaugeState.get(root)!;
  const ranges = g.ranges!;
  const n = ranges.length;
  const len = g.length ?? GAUGE_LEN;
  const horizontal = g.orientation === "horizontal";

  // size the root
  const maxChars = ranges.reduce((m, r) => Math.max(m, (r.base.label ?? "").length, (r.top.label ?? "").length), 0);
  const rs = root.style;
  if (horizontal) { rs.width = `${len + KNOB}px`; rs.height = `${KNOB + (maxChars ? 14 : 0)}px`; }
  else { rs.height = `${len + KNOB}px`; rs.width = maxChars ? `calc(${KNOB + 4}px + ${maxChars}ch)` : `${KNOB}px`; }

  // grow / shrink range DOM to match
  while (st.rangeStates.length < n) st.rangeStates.push(createRangeDom(root, st.rangeStates.length, st, card));
  while (st.rangeStates.length > n) {
    const rng = st.rangeStates.pop()!;
    rng.halo.remove();
    rng.base.dot.remove(); rng.base.label.remove();
    rng.top.dot.remove();  rng.top.label.remove();
  }

  // draw the full-length axis guide (not cursor-hugging — spans whole [min,max])
  st.track.style.display = "block";
  placeBar(st.track, 0, len, GUIDE_W, horizontal);

  for (let i = 0; i < n; i++) {
    const range = ranges[i]!;
    const rng = st.rangeStates[i]!;
    const isActive = g.active === range.id || g.active === i;

    // z-order: active range on top; within each group halos behind knobs behind labels
    const zHalo  = isActive ? n + 5     : i;
    const zKnob  = isActive ? n * 2 + 15 : n + 5 + i;
    const zLabel = zKnob + 1;

    // update live values (don't clobber an in-progress drag)
    if (rng.dragging !== "base") rng.live.base = range.base.value;
    if (rng.dragging !== "top")  rng.live.top  = range.top.value;
    if (rng.dragging === null) { rng.liveBandBase = range.base.value; rng.liveBandTop = range.top.value; }

    const bA = gaugeAlong(valueFraction(rng.live.base, g.min, g.max), len, horizontal);
    const tA = gaugeAlong(valueFraction(rng.live.top,  g.min, g.max), len, horizontal);

    // halo (coloured band)
    rng.halo.style.background = range.fill ?? range.color;
    rng.halo.style.opacity = isActive ? "0.45" : "0.30";
    rng.haloOpacity = rng.halo.style.opacity;
    rng.halo.style.zIndex = String(zHalo);
    placeBar(rng.halo, Math.min(bA, tA), Math.max(bA, tA), RANGE_BAND_W, horizontal);

    // knobs
    const rStroke = g.knobStroke ?? "white";
    rng.base.dot.style.background = range.color;
    rng.base.dot.style.border = rStroke ? `1.5px solid ${rStroke}` : "none";
    rng.base.dot.style.zIndex = String(zKnob);
    rng.top.dot.style.background = range.color;
    rng.top.dot.style.border = rStroke ? `1.5px solid ${rStroke}` : "none";
    rng.top.dot.style.zIndex = String(zKnob);
    if (rng.dragging !== "base" && rng.dragging !== "band") placeKnob(rng.base, bA, horizontal);
    if (rng.dragging !== "top"  && rng.dragging !== "band") placeKnob(rng.top,  tA, horizontal);

    // labels
    rng.base.label.textContent = range.base.label ?? "";
    rng.top.label.textContent  = range.top.label  ?? "";
    applyLabelStyle(rng.base.label, range.color, "white");
    applyLabelStyle(rng.top.label,  range.color, "white");
    rng.base.label.style.zIndex = String(zLabel);
    rng.top.label.style.zIndex  = String(zLabel);

    // a11y
    for (const [dot, cursor, val] of [
      [rng.base.dot, range.base, rng.live.base],
      [rng.top.dot,  range.top,  rng.live.top],
    ] as [HTMLElement, WidgetRange["base"], number][]) {
      dot.setAttribute("aria-valuemin", String(g.min));
      dot.setAttribute("aria-valuemax", String(g.max));
      dot.setAttribute("aria-valuenow", String(val));
      dot.setAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
      const lbl = cursor.label || cursor.name;
      if (lbl) dot.setAttribute("aria-label", lbl);
    }
  }
  ensureGaugeHoverAdd(root, st, card);
}

interface DialState { svg: SVGSVGElement; hit: SVGCircleElement; arcHalo: SVGPathElement; arc: SVGPathElement; knob: SVGCircleElement; label: HTMLElement; dial: WidgetDial; dragging: boolean; live: number; }
const dialState = new WeakMap<HTMLElement, DialState>();

/** Does this card's content reduce to a single dial? (A dial alone, or wrapped in layout boxes that
 *  hold nothing else.) Such a card is the break-point speed satellite — a bare ring whose centre must
 *  let clicks through, so the card opts out of pointer events. */
function isLoneDial(node: WidgetNode): boolean {
  if ("kind" in node) return node.kind === "dial";
  return node.items.length === 1 && isLoneDial(node.items[0]!);
}

function createDial(card: Card): HTMLElement {
  const root = document.createElement("div");
  root.className = "draw-adapter-widget-dial";
  const rs = root.style; rs.position = "relative"; rs.display = "inline-block"; rs.flex = "0 0 auto"; rs.touchAction = "none";
  // The dial is a RING: its box (incl. the central hole + the corners) is transparent to pointer
  // events, so a pointerdown in the centre falls through to whatever sits beneath (a map handle/
  // feature rendered AT the same point). Only the ring band + knob below re-enable capture.
  rs.pointerEvents = "none";
  preventCardDrag(root);
  const svg = document.createElementNS(SVGNS, "svg");
  svg.style.display = "block"; svg.style.overflow = "visible";
  const arcHalo = document.createElementNS(SVGNS, "path");
  arcHalo.setAttribute("fill", "none"); arcHalo.setAttribute("stroke", "currentColor"); arcHalo.setAttribute("stroke-linecap", "round");
  arcHalo.style.opacity = SELECT_OPACITY;
  const arc = document.createElementNS(SVGNS, "path");
  arc.setAttribute("fill", "none"); arc.setAttribute("stroke", "currentColor"); arc.setAttribute("stroke-linecap", "round");
  arc.style.opacity = GUIDE_OPACITY;
  const knob = document.createElementNS(SVGNS, "circle");
  knob.setAttribute("fill", "currentColor"); knob.classList.add("draw-adapter-widget-knob");
  knob.style.cursor = "pointer"; knob.style.setProperty("touch-action", "none");
  knob.style.setProperty("pointer-events", "auto"); // the root opts out; the knob opts back in
  // Invisible ANNULUS hit-area: `pointer-events: stroke` captures only the stroke band (the couronne),
  // leaving the central hole transparent. Sized in updateDial; kept LAST so it grabs the whole ring,
  // and so the visible glow/arc stay svg.children[0]/[1].
  const hit = document.createElementNS(SVGNS, "circle");
  hit.setAttribute("fill", "none"); hit.setAttribute("stroke", "transparent");
  hit.style.setProperty("pointer-events", "stroke"); hit.style.cursor = "pointer"; hit.style.setProperty("touch-action", "none");
  svg.append(arcHalo, arc, knob, hit); // glow behind the arc; transparent ring hit-area on top
  const label = document.createElement("span");
  const ls = label.style; ls.position = "absolute"; ls.transform = "translate(-50%,-50%)"; // left/top set per-angle in updateDial
  ls.pointerEvents = "none"; ls.whiteSpace = "nowrap"; ls.textAlign = "center";
  root.append(svg, label);
  dialState.set(root, { svg, hit, arcHalo, arc, knob, label, dial: { kind: "dial", name: "", min: 0, max: 1, value: 0 }, dragging: false, live: 0 });
  wireDialDrag(root, knob, card);
  wireDialDrag(root, hit, card); // a press anywhere on the ring band grabs the dial, just like the knob
  // a11y: a focusable slider; arrows step the value by `step` (or 1% of the range), clamped to [min,max].
  knob.setAttribute("role", "slider");
  knob.setAttribute("tabindex", "0");
  knob.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    const st = dialState.get(root); if (!st) return;
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    const d = st.dial, R = d.radius ?? DIAL_R, ar = R - KNOB / 2;
    const step = d.step ?? (d.max - d.min) / 100;
    const v = Math.max(d.min, Math.min(d.max, st.live + dir * step));
    st.live = v;
    const ang = dialAngle(v, d);
    const [kx, ky] = polar(R, R, ar, ang);
    knob.setAttribute("cx", String(kx)); knob.setAttribute("cy", String(ky));
    st.arcHalo.setAttribute("d", dialArcPath(R, ar, DIAL_MIN_ANGLE, ang));
    placeDialLabel(st, R, ang);
    knob.setAttribute("aria-valuenow", String(v));
    card.emitEdit(String(v), d.name);
  });
  return root;
}

function updateDial(root: HTMLElement, d: WidgetDial, _card: Card): void {
  const st = dialState.get(root)!;
  st.dial = d;
  if (d.color) root.style.color = d.color;
  st.knob.setAttribute("aria-valuemin", String(d.min));
  st.knob.setAttribute("aria-valuemax", String(d.max));
  st.knob.setAttribute("aria-valuenow", String(st.dragging ? st.live : d.value));
  if (d.name) st.knob.setAttribute("aria-label", d.name);
  const R = d.radius ?? DIAL_R;
  const ar = R - KNOB / 2; // arc radius leaves room for the knob
  const size = 2 * R;
  st.svg.setAttribute("width", String(size));
  st.svg.setAttribute("height", String(size));
  st.svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  st.arc.setAttribute("stroke-width", String(GUIDE_W));
  st.arcHalo.setAttribute("stroke-width", String(SELECT_W));
  st.knob.setAttribute("r", String(KNOB / 2));
  // Ring hit-area centred on the knob's travel circle: its band covers the couronne, its hole (radius
  // `ar - RING_HIT_W/2`) stays transparent and shrinks/grows with the dial.
  st.hit.setAttribute("cx", String(R)); st.hit.setAttribute("cy", String(R));
  st.hit.setAttribute("r", String(ar)); st.hit.setAttribute("stroke-width", String(RING_HIT_W));
  root.style.width = `${size}px`; root.style.height = `${size}px`;
  const sweep = d.sweep ?? DIAL_SWEEP;
  st.arc.setAttribute("d", dialArcPath(R, ar, DIAL_MIN_ANGLE, DIAL_MIN_ANGLE + sweep)); // thin guide, full sweep
  if (!st.dragging) st.live = d.value;
  const ang = dialAngle(st.live, d);
  st.arcHalo.setAttribute("d", dialArcPath(R, ar, DIAL_MIN_ANGLE, ang)); // wide glow: start → value (selected)
  const [kx, ky] = polar(R, R, ar, ang);
  st.knob.setAttribute("cx", String(kx));
  st.knob.setAttribute("cy", String(ky));
  st.knob.setAttribute("fill", d.knobFill ?? "currentColor");
  const dStroke = d.knobStroke ?? "white"; // default white border; pass "" for none
  if (dStroke) { st.knob.setAttribute("stroke", dStroke); st.knob.setAttribute("stroke-width", "1.5"); }
  else { st.knob.removeAttribute("stroke"); st.knob.setAttribute("stroke-width", "0"); }
  st.label.textContent = d.label ?? "";
  applyLabelStyle(st.label, d.labelColor, d.labelHalo);
  placeDialLabel(st, R, ang); // follow the knob, just outside the ring (speedometer readout)
}

/** Optional per-control label colour + a 1px four-direction halo (legibility over the map). */
function applyLabelStyle(el: HTMLElement, color: string | undefined, halo: string | undefined): void {
  el.style.color = color ?? "black"; // default black; pass "" to inherit the cascade
  const h = halo ?? "white";         // default white halo; pass "" for none
  el.style.textShadow = h ? `-1px -1px 0 ${h},1px -1px 0 ${h},-1px 1px 0 ${h},1px 1px 0 ${h}` : "";
}

/** Place the dial label at the knob's current angle, just OUTSIDE the ring; it never rotates, so the
 *  text stays upright/readable as the knob sweeps. */
function placeDialLabel(st: DialState, R: number, angleDeg: number): void {
  const [lx, ly] = polar(R, R, R + DIAL_LABEL_GAP, angleDeg);
  st.label.style.left = `${lx}px`;
  st.label.style.top = `${ly}px`;
}

/** Wire the value-drag onto a grab target (the knob, or the transparent ring hit-area): press to grab,
 *  move to set the value from the pointer's angle. Geometry is read from state, so it is target-agnostic. */
function wireDialDrag(root: HTMLElement, target: SVGCircleElement, card: Card): void {
  target.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    const st = dialState.get(root); if (!st) return;
    st.dragging = true;
    try { target.setPointerCapture((e as globalThis.PointerEvent).pointerId); } catch { /* jsdom / unsupported */ }
  });
  target.addEventListener("pointermove", (e) => {
    const st = dialState.get(root); if (!st || !st.dragging) return;
    const ev = e as globalThis.PointerEvent;
    const d = st.dial, R = d.radius ?? DIAL_R, ar = R - KNOB / 2;
    const rect = root.getBoundingClientRect();
    const deg = (Math.atan2(ev.clientY - (rect.top + R), ev.clientX - (rect.left + R)) * 180) / Math.PI;
    const v = dialValueFromAngle(deg, d);
    st.live = v;
    const ang = dialAngle(v, d);
    const [kx, ky] = polar(R, R, ar, ang);
    st.knob.setAttribute("cx", String(kx)); st.knob.setAttribute("cy", String(ky));
    st.arcHalo.setAttribute("d", dialArcPath(R, ar, DIAL_MIN_ANGLE, ang)); // glow grows/shrinks with the value
    placeDialLabel(st, R, ang); // the label follows the knob during the drag
    card.emitEdit(String(v), d.name);
  });
  const end = (e: Event): void => {
    const st = dialState.get(root); if (!st) return;
    st.dragging = false;
    try { target.releasePointerCapture((e as globalThis.PointerEvent).pointerId); } catch { /* ignore */ }
  };
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

// ── card frame shapes (non-rectangular SVG outlines) ──────────────────────────
// Normalized polygons: [0,0] = top-left, [1,1] = bottom-right of the content+padding box. The presets
// keep their point INSIDE [0,1] (so it carries a text line — a "H" in the hat). A *custom* polygon may
// put points outside [0,1] to form a hollow cap/point; the card then grows to reserve that overshoot.
const BOX_SHAPES: Record<string, number[][]> = {
  rect: [[0, 0], [1, 0], [1, 1], [0, 1]],
  "pentagon-up": [[0, 0.4], [0.5, 0], [1, 0.4], [1, 1], [0, 1]],
  "pentagon-down": [[0, 0], [1, 0], [1, 0.6], [0.5, 1], [0, 0.6]],
};
/** Resolve a `boxShape` to its normalized polygon, or `null` for the plain rectangle (the CSS box). */
export function resolveBoxShape(shape: MarkerWidget["boxShape"]): number[][] | null {
  if (shape == null || shape === "rect") return null;
  if (typeof shape === "string") return BOX_SHAPES[shape] ?? null; // unknown preset ⇒ plain box
  return shape.length >= 3 ? shape : null; // a custom outline needs ≥ 3 points
}

export interface ShapeLayout { over: { t: number; r: number; b: number; l: number }; svgW: number; svgH: number; inset: number; points: string; }
/** Geometry for a shaped frame from the measured content+padding box `W×H` and border width `bw`:
 *  the overshoot margins (px) that grow the card, the svg size, and the polygon `points` string.
 *  Pure (DOM-free) so it's unit-testable. */
export function boxShapeLayout(points: number[][], W: number, H: number, bw: number): ShapeLayout {
  let minX = 0, minY = 0, maxX = 1, maxY = 1; // always include the [0,1] content box
  for (const pt of points) {
    const x = pt[0]!, y = pt[1]!;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const l = Math.max(0, -minX) * W, r = Math.max(0, maxX - 1) * W;
  const t = Math.max(0, -minY) * H, b = Math.max(0, maxY - 1) * H;
  const inset = bw / 2 + 1; // breathing room so the stroke isn't clipped at the svg edge
  const svgW = l + W + r + 2 * inset, svgH = t + H + b + 2 * inset;
  const pts = points.map((pt) => `${(inset + l + pt[0]! * W).toFixed(2)},${(inset + t + pt[1]! * H).toFixed(2)}`).join(" ");
  return { over: { t, r, b, l }, svgW, svgH, inset, points: pts };
}

class Card {
  readonly mount: WidgetMount;
  id = "";
  anchor: LatLng = { lat: 0, lon: 0 };
  coordFmt: (ll: LatLng) => string;
  /** The framed card element (origin transform + bg/border/radius/padding/font live here). */
  readonly root: HTMLElement;
  /** Inner wrapper holding the reconciled box tree — kept separate from `root` so the optional
   *  delete button (a sibling) is never seen/removed by the positional reconcile. */
  private readonly content: HTMLElement;
  private readonly host: WidgetHost;
  private readonly getEditCb: () => ((e: WidgetEdit) => void) | undefined;
  private readonly getDeleteCb: () => ((e: { id: string }) => void) | undefined;
  private readonly getActionCb: () => ((e: { id: string; event: string }) => void) | undefined;
  private readonly coordEls: HTMLElement[] = [];
  private delBtn: HTMLButtonElement | undefined;
  private actionBtns: HTMLElement[] = [];
  private actionSig = "";
  private axisButtons: Array<{ el: HTMLElement; place: "axis-top" | "axis-bottom"; gap: number }> = [];
  /** The SVG frame for a non-rect `boxShape` (lazily created); absent for the plain CSS box. */
  private shapeSvg: SVGSVGElement | undefined;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  /** Cached origin fractions (set by update, read by refreshTransform + anchorTo positioning). */
  private ox = 0.5;
  private oy = 0.5;
  /** Extra pixel offset applied by anchorTo repositioning (added after the %-based origin transform). */
  private anchorExtraX = 0;
  private anchorExtraY = 0;

  constructor(
    mount: WidgetMount,
    host: WidgetHost,
    getEditCb: () => ((e: WidgetEdit) => void) | undefined,
    getDeleteCb: () => ((e: { id: string }) => void) | undefined,
    getActionCb: () => ((e: { id: string; event: string }) => void) | undefined,
    coordFmt: (ll: LatLng) => string,
  ) {
    this.mount = mount;
    this.host = host;
    this.getEditCb = getEditCb;
    this.getDeleteCb = getDeleteCb;
    this.getActionCb = getActionCb;
    this.coordFmt = coordFmt;
    mount.el.style.pointerEvents = "none"; // only the visible card body (root) is interactive
    this.root = document.createElement("div");
    this.root.className = "draw-adapter-widget-card";
    const s = this.root.style;
    s.position = "relative"; // positioning context for the corner delete button
    s.display = "inline-block";
    s.boxSizing = "border-box";
    s.pointerEvents = "auto";
    s.whiteSpace = "nowrap";
    s.userSelect = "none";
    s.cursor = "default";
    // Pin the line-height so multi-line text (carousel, labels) is homogeneous across engines —
    // MapLibre's container otherwise leaks a 20px line-height into the card. Unitless ⇒ scales
    // with font-size, deterministic (≈ `normal` but consistent everywhere).
    s.lineHeight = "1.2";
    this.content = document.createElement("div");
    this.content.style.display = "inline-block";
    this.root.appendChild(this.content);
    mount.el.appendChild(this.root);
    this.wirePointer();
  }

  /** Compose and apply the card's CSS transform: %-based origin + optional px anchorTo offset. */
  private refreshTransform(): void {
    let t = `translate(${(-this.ox * 100).toFixed(4)}%, ${(-this.oy * 100).toFixed(4)}%)`;
    if (this.anchorExtraX !== 0 || this.anchorExtraY !== 0) {
      t += ` translate(${this.anchorExtraX.toFixed(2)}px, ${this.anchorExtraY.toFixed(2)}px)`;
    }
    this.root.style.transform = t;
  }

  /**
   * Apply an extra pixel offset on top of the %-based origin transform (used by anchorTo
   * repositioning). Call with `(0, 0)` to remove the extra and restore the base position.
   */
  setAnchorExtra(dx: number, dy: number): void {
    this.anchorExtraX = dx;
    this.anchorExtraY = dy;
    this.refreshTransform();
  }

  /** Reconcile this card's DOM to `w` in place (never recreate — preserves input focus). */
  update(w: MarkerWidget): void {
    this.id = w.id;
    this.anchor = w.anchor;
    [this.ox, this.oy] = originXY(w.origin);
    // Reset extra offset: repositionAnchoredCards() will recompute it after all cards are updated.
    this.anchorExtraX = 0;
    this.anchorExtraY = 0;
    this.root.dataset["ox"] = `${this.ox}`; // remembered for the snapshot compositing offset
    this.root.dataset["oy"] = `${this.oy}`;
    this.refreshTransform();
    const s = this.root.style;
    const framed = !!(w.bg || w.border);
    s.background = w.bg ?? "transparent";
    s.border = w.border ? `${boxBorderWidth(w.borderWidth)}px solid ${w.border}` : ""; // "" clears it (no frame border)
    s.borderRadius = `${boxRadius(w.radius)}px`;
    // Padding is decoupled from the frame: apply it when the card is framed (default `medium`) OR an
    // explicit `padding` is given — so a BARE call-out (no bg/border) can still space its content
    // (e.g. to keep edge buttons off the text/glyph). Absent + unframed ⇒ 0 (unchanged). Note:
    // `boxPadding(undefined)` is `medium`, not 0 — hence the guard, so bare cards aren't padded by default.
    if (framed || w.padding != null) {
      const [pv, ph] = boxPadding(w.padding);
      s.padding = `${pv}px ${ph}px`;
    } else {
      s.padding = "0";
    }
    s.color = w.font?.color ?? "";
    s.fontSize = w.font?.size != null ? `${w.font.size}px` : "";
    s.fontFamily = w.font?.family ?? "";
    s.lineHeight = w.font?.lineHeight != null ? String(w.font.lineHeight) : "1.2"; // unitless; default 1.2
    // A lone-dial card (the break-point speed satellite, centred ON its anchor) is a RING: opt the
    // WHOLE card out of pointer events — `pointer-events` inherits, so the content/box/svg all go
    // transparent and a press in the dial's hole falls through to the handle/map beneath. Only the
    // dial's ring band + knob re-enable capture. A dial sharing a card with other controls keeps the
    // card interactive (its centre then just hits the card body, as before).
    s.pointerEvents = isLoneDial(w.child) ? "none" : "auto";
    this.coordEls.length = 0;
    reconcile(this.content, [w.child], this);
    this.applyShape(w); // a non-rect boxShape draws an SVG frame and reserves its overshoot
    const del = w.deletable;
    this.ensureDeleteButton(!!del, framed, typeof del === "object" ? del.title : undefined);
    this.ensureActionButtons(w.buttons);
    this.repositionAxisButtons(); // re-measure after layout changes (e.g. content or label width)
  }

  /**
   * Draw a non-rect {@link BoxShape} as an SVG frame behind the content (so the border follows the
   * contour, which a CSS border + clip-path can't). The CSS box steps aside (transparent/no border);
   * padding moves onto the content; the content's measured size feeds {@link boxShapeLayout}, whose
   * overshoot becomes content **margins** so the inline-block card grows to reserve the cap/point. The
   * SVG is `pointer-events:none`, so drag/clicks still land on the card body. For `"rect"`/absent the
   * SVG is removed and the content reset — the CSS box (set in `update`) is left intact.
   */
  private applyShape(w: MarkerWidget): void {
    const poly = resolveBoxShape(w.boxShape);
    const cs = this.content.style;
    if (!poly) {
      if (this.shapeSvg) { this.shapeSvg.remove(); this.shapeSvg = undefined; }
      cs.padding = ""; cs.margin = ""; cs.position = "";
      return;
    }
    const rs = this.root.style;
    rs.background = "transparent"; rs.border = ""; rs.borderRadius = "0"; rs.padding = "0"; rs.overflow = "visible";
    const [pv, ph] = boxPadding(w.padding);
    cs.padding = `${pv}px ${ph}px`;
    cs.position = "relative"; // paint above the SVG
    cs.margin = "0"; // reset before measuring the content+padding box
    const rect = this.content.getBoundingClientRect();
    const bw = w.border ? boxBorderWidth(w.borderWidth) : 0;
    const lay = boxShapeLayout(poly, rect.width, rect.height, bw);
    cs.margin = `${lay.over.t}px ${lay.over.r}px ${lay.over.b}px ${lay.over.l}px`; // reserve overshoot ⇒ card grows
    let svg = this.shapeSvg;
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("class", "draw-adapter-widget-shape");
      const ss = svg.style; ss.position = "absolute"; ss.pointerEvents = "none"; ss.overflow = "visible";
      svg.appendChild(document.createElementNS(SVGNS, "polygon"));
      this.root.insertBefore(svg, this.root.firstChild); // behind the content
      this.shapeSvg = svg;
    }
    svg.setAttribute("width", String(lay.svgW));
    svg.setAttribute("height", String(lay.svgH));
    svg.setAttribute("viewBox", `0 0 ${lay.svgW} ${lay.svgH}`);
    svg.style.left = `${-lay.inset}px`;
    svg.style.top = `${-lay.inset}px`;
    const p = svg.firstElementChild as SVGPolygonElement;
    p.setAttribute("points", lay.points);
    p.setAttribute("fill", w.bg ?? "none");
    if (w.border) { p.setAttribute("stroke", w.border); p.setAttribute("stroke-width", String(bw)); p.setAttribute("stroke-linejoin", "round"); }
    else { p.setAttribute("stroke", "none"); p.removeAttribute("stroke-width"); }
  }

  emitAction(event: string): void {
    this.getActionCb()?.({ id: this.id, event });
    this.host.focus(); // the button took focus off the map — give it back so onKey/Escape works
  }

  /** Return keyboard focus to the map after a card control handled a tap (for module-level wiring). */
  focusHost(): void {
    this.host.focus();
  }

  /** Drive the card's drag pipeline from a control acting as a drag handle (the carousel/picker). */
  forwardDrag(type: PointerEvent["type"], e: globalThis.PointerEvent): void {
    if (type === "down") closePicker(); // a card drag starts (even from the picker trigger) ⇒ collapse any open popup
    this.send(type, e);
  }

  /** Emit the card's no-move tap (down → up → click, the widget hit) so the consumer **selects**
   *  the card — used by a control (carousel) that swallows its own press but must still select. */
  tapSelect(e: globalThis.PointerEvent): void {
    this.send("down", e);
    this.send("up", e);
    this.send("click", e);
  }

  /** Build the action buttons (`+`/pen/…) on the card edges/corners. Rebuilt only when the
   *  `buttons` config changes (siblings of `content`, so the reconcile never touches them).
   *  Axis places (`"axis-top"` / `"axis-bottom"`) are tracked separately in `axisButtons` and
   *  repositioned via DOM measurement in `repositionAxisButtons()`. */
  private ensureActionButtons(buttons: WidgetButton[] | undefined): void {
    const sig = JSON.stringify(buttons ?? []);
    if (sig === this.actionSig) return;
    this.actionSig = sig;
    for (const b of this.actionBtns) b.remove();
    this.actionBtns = [];
    for (const ab of this.axisButtons) ab.el.remove();
    this.axisButtons = [];
    for (const button of buttons ?? []) {
      const places = Array.isArray(button.place) ? button.place : (button.place != null ? [button.place] : ["right"]);
      const seen = new Set<string>();
      for (const p of places) {
        if (p === "axis-top" || p === "axis-bottom") {
          if (!seen.has(p)) {
            seen.add(p);
            const [fx, fy] = PLACE_POINTS[p]![0]!;
            const el = makeActionButton(button, fx, fy, this);
            this.root.appendChild(el);
            this.actionBtns.push(el);
            this.axisButtons.push({ el, place: p, gap: button.gap ?? 0 });
          }
        } else {
          for (const [fx, fy] of PLACE_POINTS[p as WidgetButtonPlace] ?? PLACE_POINTS.right) {
            const k = `${fx},${fy}`;
            if (!seen.has(k)) {
              seen.add(k);
              const el = makeActionButton(button, fx, fy, this);
              this.root.appendChild(el);
              this.actionBtns.push(el);
            }
          }
        }
      }
    }
    this.repositionAxisButtons();
  }

  /** Reposition `"axis-top"` / `"axis-bottom"` buttons so their centre lands on the gauge track
   *  cross-axis position (KNOB/2 from the gauge element's left edge for a vertical gauge).
   *  Called after DOM layout when the gauge element's bounding rect is available.
   *  In jsdom tests `getBoundingClientRect()` returns 0 — this is a no-op (layout cannot be tested). */
  private repositionAxisButtons(): void {
    if (!this.axisButtons.length) return;
    const gaugeEl = this.root.querySelector<HTMLElement>(".draw-adapter-widget-gauge");
    if (!gaugeEl) return;
    const rootRect = this.root.getBoundingClientRect();
    const gaugeRect = gaugeEl.getBoundingClientRect();
    if (!rootRect.width || !gaugeRect.width) return; // no layout (jsdom / not yet painted)

    // Gauge axis x = gaugeRect.left − rootRect.left + KNOB/2 (centre of track/knob column)
    const axisX = gaugeRect.left - rootRect.left + KNOB / 2;
    // Track top end y (gauge top + KNOB/2) and bottom end y (gauge bottom − KNOB/2)
    const trackTopY    = gaugeRect.top    - rootRect.top    + KNOB / 2;
    const trackBottomY = gaugeRect.bottom - rootRect.top    - KNOB / 2;

    for (const ab of this.axisButtons) {
      const s = ab.el.style;
      const yPx = ab.place === "axis-top"
        ? trackTopY    - ab.gap
        : trackBottomY + ab.gap;
      s.left = `${axisX}px`;
      s.top  = `${yPx}px`;
      // transform already set to translate(-50%,-50%) by makeActionButton — no change needed
    }
  }

  /** Create/remove the corner delete button. It's a sibling of `content` (so the reconcile
   *  never touches it) and a separate element from any input (so it's always clickable —
   *  an input-only card can still be deleted). Clicking it fires the delete callback. */
  private ensureDeleteButton(on: boolean, framed: boolean, title?: string): void {
    if (on && !this.delBtn) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "draw-adapter-widget-del";
      b.setAttribute("aria-label", "Delete");
      b.textContent = "×";
      // No frills: a bare black "×", no background/border. A square flex box centres the glyph
      // so it sits equidistant from the top and right edges.
      const s = b.style;
      s.position = "absolute";
      s.zIndex = "1";
      s.boxSizing = "border-box";
      s.width = "1em";
      s.height = "1em";
      s.display = "flex";
      s.alignItems = "center";
      s.justifyContent = "center";
      s.margin = "0";
      s.padding = "0";
      s.border = "none";
      s.background = "transparent";
      s.color = "#000";
      s.font = "inherit";
      s.lineHeight = "1";
      s.cursor = "pointer";
      s.userSelect = "none";
      s.setProperty("appearance", "none");
      s.setProperty("-webkit-appearance", "none");
      wireTapButton(b, () => { this.getDeleteCb()?.({ id: this.id }); this.host.focus(); });
      this.root.appendChild(b);
      this.delBtn = b;
    } else if (!on && this.delBtn) {
      this.delBtn.remove();
      this.delBtn = undefined;
    }
    if (this.delBtn) {
      this.delBtn.title = title ?? ""; // native tooltip
      if (title) this.delBtn.setAttribute("aria-label", title);
      // Framed: a small inset INSIDE the corner (the frame padding gives it room). Unframed: there's
      // no padding to sit in, so nudge the glyph up-and-right, clear of the content.
      const s = this.delBtn.style;
      if (framed) { s.top = "2px"; s.right = "2px"; s.transform = ""; }
      else { s.top = "0"; s.right = "0"; s.transform = "translate(100%, -40%)"; }
    }
  }

  /** Re-format every `coord` line from the current anchor (used on move + format change). */
  refreshCoord(): void {
    for (const el of this.coordEls) el.textContent = this.coordFmt(this.anchor);
  }

  registerCoord(el: HTMLElement): void {
    this.coordEls.push(el);
    el.textContent = this.coordFmt(this.anchor);
  }

  emitEdit(value: string, name?: string): void {
    this.getEditCb()?.({ id: this.id, value, ...(name != null && name !== "" ? { name } : {}) });
  }

  private wirePointer(): void {
    const root = this.root;
    root.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement | null;
      // editing or the delete button handle their own press — don't start a drag/select
      if (t?.closest("input, textarea, select, [contenteditable], .draw-adapter-widget-del, .draw-adapter-widget-btn, .draw-adapter-widget-ctrl, .draw-adapter-widget-gauge, .draw-adapter-widget-dial")) return;
      e.preventDefault();   // no text selection while dragging the card
      e.stopPropagation();  // don't let the map navigate (bubble phase)
      this.dragging = true;
      this.downX = e.clientX;
      this.downY = e.clientY;
      try { root.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
      this.send("down", e);
    });
    root.addEventListener("pointermove", (e) => {
      if (this.dragging) this.send("move", e);
    });
    const end = (e: globalThis.PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      try { root.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.send("up", e);
      const moved = Math.abs(e.clientX - this.downX) > 3 || Math.abs(e.clientY - this.downY) > 3;
      if (!moved) this.send("click", e); // a tap (no drag) also surfaces a click, like a map feature
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
  }

  private send(type: PointerEvent["type"], e: globalThis.PointerEvent): void {
    const ll = this.host.unprojectClient(e.clientX, e.clientY) ?? this.anchor;
    this.host.emit({ type, lngLat: ll, ...modifiers(e), hit: { overlay: "widget", props: { id: this.id } } });
  }
}

// ── DOM build + reconciliation (positional, by node kind) ─────────────────────

function reconcile(parent: HTMLElement, nodes: WidgetNode[], card: Card): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    let dom = parent.children[i] as HTMLElement | undefined;
    if (!dom || dom.dataset?.[KIND] !== nodeTag(node)) {
      const fresh = createNode(node, card);
      if (dom) parent.replaceChild(fresh, dom);
      else parent.appendChild(fresh);
      dom = fresh;
    }
    updateNode(dom, node, card);
  }
  while (parent.children.length > nodes.length) parent.removeChild(parent.lastElementChild!);
}

function createNode(node: WidgetNode, card: Card): HTMLElement {
  let el: HTMLElement;
  if (!("kind" in node)) {
    el = document.createElement("div");
    el.style.display = "flex";
  } else if (node.kind === "glyph") {
    el = document.createElement("span");
    el.style.display = "inline-flex";
  } else if (node.kind === "coord") {
    el = document.createElement("span");
  } else if (node.kind === "gauge") {
    el = createGauge();
  } else if (node.kind === "dial") {
    el = createDial(card);
  } else if (node.control === "picker") {
    const span = document.createElement("span");
    span.className = "draw-adapter-widget-ctrl";
    const s = span.style;
    s.display = "inline-block";
    s.cursor = "pointer";
    s.userSelect = "none";
    s.willChange = "transform, opacity";
    s.whiteSpace = "pre-line"; // honour `\n` in option text (multi-line); no effect on single-line
    s.textAlign = "center";
    // Affordance: a picker is BOLD so it reads as interactive (vs a static label), without adding any
    // width that would shift the value off the anchor. The accent colour (e.g. orange) is the
    // consumer's call — set per node via `color`, like the gauge/dial controls.
    s.fontWeight = "bold";
    // a11y: a focusable button so it's keyboard-operable. Enter/Space/Down act (cycle or open the
    // flower/grid); Up cycles back. When a popup is open, its own capture-phase nav handles the keys
    // first (stopPropagation), so this never double-fires.
    span.setAttribute("role", "button");
    span.tabIndex = 0;
    span.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "Enter" || k === " " || k === "Spacebar" || k === "ArrowDown") { e.preventDefault(); e.stopPropagation(); tapPicker(span, card, false); }
      else if (k === "ArrowUp") { e.preventDefault(); e.stopPropagation(); tapPicker(span, card, true); }
    });
    // tap ⇒ act (cycle, or open the flower/grid); drag ⇒ move the whole card (it's a drag handle too).
    wirePicker(span, card);
    el = span;
  } else if (node.editable) {
    const input = document.createElement("input");
    input.type = "text";
    const s = input.style;
    s.font = "inherit"; s.color = "inherit"; s.background = "transparent";
    s.border = "none"; s.outline = "none"; s.padding = "0"; s.margin = "0";
    s.minWidth = "0"; s.boxSizing = "content-box"; s.textAlign = "center";
    // The card sets `user-select: none` (so dragging it never selects text); it cascades into the
    // input and breaks caret placement / text selection — force it back on so a click drops the
    // caret under the cursor and you can select within the field.
    s.userSelect = "text";
    s.setProperty("-webkit-user-select", "text");
    input.addEventListener("input", () => {
      if (input.dataset["uppercase"] === "1") {
        const a = input.selectionStart;
        const b = input.selectionEnd;
        const up = input.value.toUpperCase();
        if (up !== input.value) {
          input.value = up;
          if (a != null && b != null) { try { input.setSelectionRange(a, b); } catch { /* ignore */ } }
        }
      }
      card.emitEdit(input.value, input.dataset["name"] || undefined);
      autosize(input);
    });
    input.addEventListener("pointerdown", (e) => { e.stopPropagation(); }); // edit, don't drag/pan
    // MapLibre's Marker cancels `mousedown` on the mount, which would steal the input's focus —
    // stop the compat event here so click-to-focus / caret placement keep working.
    input.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    // Keep keystrokes in the field: arrows / Home / End / Backspace… otherwise bubble to the engine's
    // keyboard handler and pan-or-zoom the map instead of moving the caret. The `input` event (and
    // thus `onWidgetEdit`) still fires, so editing is unaffected.
    input.addEventListener("keydown", (e) => { e.stopPropagation(); });
    input.addEventListener("keyup", (e) => { e.stopPropagation(); });
    if (node.autofocus) queueMicrotask(() => { try { input.focus(); } catch { /* ignore */ } });
    el = input;
  } else {
    el = document.createElement("span");
  }
  el.dataset[KIND] = nodeTag(node);
  return el;
}

function updateNode(el: HTMLElement, node: WidgetNode, card: Card): void {
  if (!("kind" in node)) {
    const s = el.style;
    s.flexDirection = node.dir === "v" ? "column" : "row";
    s.alignItems = alignValue(node.align);
    s.gap = `${node.gap ?? 0}px`;
    s.color = node.color ?? "";
    s.fontSize = node.size != null ? `${node.size}px` : "";
    applyBoxFrame(s, node); // optional bg/border/borderWidth/radius/padding (same presets as the card)
    reconcile(el, node.items, card);
    return;
  }
  if (node.kind === "glyph") {
    setGlyph(el, node.svg);
    const px = node.size != null ? `${node.size}px` : "";
    el.style.width = px;
    el.style.height = px;
    el.style.color = node.color ?? "";
    return;
  }
  if (node.kind === "coord") {
    el.style.color = node.color ?? "";
    el.style.fontSize = node.size != null ? `${node.size}px` : "";
    card.registerCoord(el);
    return;
  }
  if (node.kind === "gauge") { updateGauge(el, node, card); return; }
  if (node.kind === "dial") { updateDial(el, node, card); return; }
  // text
  if (node.control === "picker") {
    updatePicker(el, node.options ?? [], node.value, node.name, node.mode ?? "carousel", node.color, node.size);
    el.style.color = node.color ?? "";
    return;
  }
  if (node.editable) {
    const input = el as HTMLInputElement;
    input.placeholder = node.placeholder ?? "";
    input.dataset["name"] = node.name ?? "";
    input.dataset["uppercase"] = node.uppercase ? "1" : "";
    input.style.textTransform = node.uppercase ? "uppercase" : "";
    const val = node.uppercase ? node.value.toUpperCase() : node.value;
    if (input.value !== val) input.value = val; // don't clobber the caret on round-trip
    input.style.color = node.color ?? "inherit";
    input.style.fontSize = node.size != null ? `${node.size}px` : "";
    autosize(input);
  } else {
    el.textContent = node.value;
    el.style.whiteSpace = "pre-line"; // honour `\n` in a static label (like the picker), not one line
    el.style.textAlign = "center"; // centre multi-line labels so a short line (H/L) sits under the FL
    el.style.textTransform = node.uppercase ? "uppercase" : "";
    el.style.color = node.color ?? "";
    el.style.fontSize = node.size != null ? `${node.size}px` : "";
  }
}

// ── the layer (diff by id, like setOverlay) ───────────────────────────────────

export class WidgetLayer {
  private readonly cards = new Map<string, Card>();
  private editCb: ((e: WidgetEdit) => void) | undefined;
  private deleteCb: ((e: { id: string }) => void) | undefined;
  private actionCb: ((e: { id: string; event: string }) => void) | undefined;
  private coordFmt: (ll: LatLng) => string = defaultCoordFormat;
  private currentWidgets: MarkerWidget[] = [];
  private resizeObserver: ResizeObserver | undefined;

  constructor(private readonly host: WidgetHost) {}

  setWidgets(widgets: MarkerWidget[]): void {
    this.currentWidgets = widgets;
    const seen = new Set<string>();
    for (const w of widgets) {
      seen.add(w.id);
      let card = this.cards.get(w.id);
      if (!card) {
        const mount = this.host.createMount(w.anchor);
        mount.el.classList.add("draw-adapter-widget"); // tag for the engines' pointerdown guard
        card = new Card(mount, this.host, () => this.editCb, () => this.deleteCb, () => this.actionCb, this.coordFmt);
        this.cards.set(w.id, card);
      } else {
        card.mount.setAnchor(w.anchor);
      }
      card.update(w); // resets anchorExtra to 0 and applies base %-transform
    }
    for (const [id, card] of this.cards) {
      if (seen.has(id)) continue;
      card.mount.remove();
      this.cards.delete(id);
    }
    this.repositionAnchoredCards();
    this.updateResizeObserver();
  }

  /**
   * Re-position all satellite cards that declare `anchorTo`: compute the px offset that puts
   * their perpendicular edge flush against their target's measured edge (+ gap), then apply it
   * as an extra CSS translation on top of the %-based origin transform.
   *
   * Called after the full setWidgets update loop, and from the ResizeObserver when a reference
   * card's size changes. In jsdom (getBoundingClientRect returns zero), this is a safe no-op.
   */
  private repositionAnchoredCards(): void {
    // Two-pass: first reset all satellites' extras so getBoundingClientRect reflects base-only
    // transforms (needed on ResizeObserver re-runs where the previous extra is already applied).
    for (const w of this.currentWidgets) {
      if (w.anchorTo) this.cards.get(w.id)?.setAnchorExtra(0, 0);
    }
    // Second pass: measure and set the corrective offset for each satellite.
    for (const w of this.currentWidgets) {
      if (!w.anchorTo) continue;
      const satellite = this.cards.get(w.id);
      const main = this.cards.get(w.anchorTo.id);
      if (!satellite || !main) continue; // target absent → fallback to own anchor/origin
      const mainRect = main.root.getBoundingClientRect();
      const satRect  = satellite.root.getBoundingClientRect();
      if (!mainRect.width && !mainRect.height) continue; // no layout engine (jsdom)
      const gap = w.anchorTo.gap ?? 0;
      let dx = 0;
      let dy = 0;
      const mainCX = (mainRect.left + mainRect.right)  / 2;
      const mainCY = (mainRect.top  + mainRect.bottom) / 2;
      const satCX  = (satRect.left  + satRect.right)   / 2;
      const satCY  = (satRect.top   + satRect.bottom)  / 2;
      switch (w.anchorTo.side) {
        case "right":  dx = mainRect.right  + gap - satRect.left;   dy = mainCY - satCY; break;
        case "left":   dx = mainRect.left   - gap - satRect.right;  dy = mainCY - satCY; break;
        case "top":    dy = mainRect.top    - gap - satRect.bottom; dx = mainCX - satCX; break;
        case "bottom": dy = mainRect.bottom + gap - satRect.top;    dx = mainCX - satCX; break;
      }
      satellite.setAnchorExtra(dx, dy);
    }
    // Third pass: z-order — a satellite card must render above its target on every engine.
    // Compute anchorTo depth (0 = root, 1 = direct satellite, 2 = satellite-of-satellite…) by
    // repeated relaxation so any chain depth is handled without needing topological pre-sorting.
    const depth = new Map<string, number>();
    for (const w of this.currentWidgets) depth.set(w.id, 0);
    for (let i = 0; i < this.currentWidgets.length; i++) {
      for (const w of this.currentWidgets) {
        if (w.anchorTo) {
          const pd = depth.get(w.anchorTo.id) ?? 0;
          if ((depth.get(w.id) ?? 0) <= pd) depth.set(w.id, pd + 1);
        }
      }
    }
    // Sort ascending so DOM-reorder engines (Leaflet) produce the correct element order:
    // depth-0 elements stay, depth-1 are appended after them, depth-2 after depth-1, etc.
    const byDepth = [...this.currentWidgets].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));
    for (const w of byDepth) {
      this.cards.get(w.id)?.mount.setZIndex(depth.get(w.id) ?? 0);
    }
  }

  /** Watch reference cards with a ResizeObserver so satellites re-snap when the main card's
   *  content changes its size (e.g. a new label line appears). */
  private updateResizeObserver(): void {
    this.resizeObserver?.disconnect();
    const refIds = new Set<string>();
    for (const w of this.currentWidgets) if (w.anchorTo) refIds.add(w.anchorTo.id);
    if (!refIds.size || typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => this.repositionAnchoredCards());
    for (const id of refIds) {
      const card = this.cards.get(id);
      if (card) this.resizeObserver.observe(card.root);
    }
  }

  onWidgetEdit(cb: (e: WidgetEdit) => void): void {
    this.editCb = cb;
  }

  onWidgetDelete(cb: (e: { id: string }) => void): void {
    this.deleteCb = cb;
  }

  onWidgetAction(cb: (e: { id: string; event: string }) => void): void {
    this.actionCb = cb;
  }

  setCoordFormat(fn: (ll: LatLng) => string): void {
    this.coordFmt = fn;
    for (const card of this.cards.values()) {
      card.coordFmt = fn;
      card.refreshCoord();
    }
  }

  /** The live card roots + their anchors — for the snapshot pass to composite a static copy. */
  snapshotCards(): { root: HTMLElement; anchor: LatLng }[] {
    return [...this.cards.values()].map((c) => ({ root: c.root, anchor: c.anchor }));
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    for (const card of this.cards.values()) card.mount.remove();
    this.cards.clear();
  }
}

// ── snapshot compositing (static card → bitmap, with a safe fallback) ──────────

/** Computed-style props copied inline onto the card clone — the SVG `foreignObject`
 *  sandbox sees no external/inherited CSS, so the styles must be self-contained. */
const SNAPSHOT_STYLE_PROPS = [
  "font", "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "color", "background", "background-color", "background-image",
  // Per-side borders, NOT just the `border` shorthand: `getComputedStyle().border` is "" when the four
  // sides differ, so a WidgetBox per-side frame (the L-shape) would vanish from the export otherwise.
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding", "margin",
  "display", "flex-direction", "align-items", "justify-content", "gap",
  "width", "height", "box-sizing", "white-space", "text-align", "line-height", "opacity",
];

function parseFraction(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function copyComputedStyle(src: HTMLElement, clone: HTMLElement): void {
  const cs = getComputedStyle(src);
  let css = "";
  for (const p of SNAPSHOT_STYLE_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) css += `${p}:${v};`;
  }
  clone.setAttribute("style", css);
}

/** Inline computed styles across the clone, and swap each editable `<input>` for a static
 *  `<span>` carrying its current value (the "non-selected" look wanted in the export). */
export function inlineStatic(src: HTMLElement, clone: HTMLElement): void {
  copyComputedStyle(src, clone);
  const sk = src.children;
  const ck = clone.children;
  for (let i = 0; i < ck.length; i++) inlineStatic(sk[i] as HTMLElement, ck[i] as HTMLElement);
  if (clone.tagName === "INPUT") {
    const span = document.createElement("span");
    span.textContent = (src as HTMLInputElement).value || "";
    span.setAttribute("style", `${clone.getAttribute("style") ?? ""};white-space:pre;display:inline-block`);
    clone.replaceWith(span);
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // degrade: skip this one card, keep the rest
    img.src = url;
  });
}

/** Rasterize a card's STATIC form (inputs → spans) to an `<img>` via SVG `foreignObject`. */
async function rasterizeCard(root: HTMLElement, w: number, h: number): Promise<HTMLImageElement | null> {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".draw-adapter-widget-del, .draw-adapter-widget-btn").forEach((e) => e.remove()); // chrome, not content
  inlineStatic(root, clone);
  clone.style.transform = "none"; // placed via drawImage; the origin shift isn't baked in
  clone.style.margin = "0";
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${xml}</foreignObject></svg>`;
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("snapshot failed"))), "image/png");
  });
}

/**
 * Composite the marker cards onto a captured map canvas and return a PNG Blob. Cards are
 * drawn in their **static** form (each editable input becomes a span showing its value).
 *
 * **Safe by design.** The card-less blob is produced from `mapCanvas` *before* any
 * `foreignObject` is drawn, on a separate compositing canvas. If compositing or its encoding
 * fails — most notably a `foreignObject`-**tainted** canvas (Safety/WebKit security), where
 * `toBlob` throws — we return that clean base blob. So enabling widgets can never turn a
 * working snapshot into a failure; worst case the cards are simply absent from the PNG.
 *
 * `mapCanvas` = the rendered map at output resolution, with NO widgets drawn on it;
 * `project` maps lon/lat → CSS px; `scale` = output px per CSS px.
 */
export async function snapshotWithWidgets(
  mapCanvas: HTMLCanvasElement,
  cards: { root: HTMLElement; anchor: LatLng }[],
  project: (ll: LatLng) => [number, number] | null,
  scale: number,
): Promise<Blob> {
  const base = await canvasToBlob(mapCanvas);
  if (!cards.length) return base;
  try {
    const composite = document.createElement("canvas");
    composite.width = mapCanvas.width;
    composite.height = mapCanvas.height;
    const ctx = composite.getContext("2d");
    if (!ctx) return base;
    ctx.drawImage(mapCanvas, 0, 0);
    for (const { root, anchor } of cards) {
      const px = project(anchor);
      if (!px) continue;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      if (!w || !h) continue;
      const img = await rasterizeCard(root, w, h);
      if (!img) continue;
      const ox = parseFraction(root.dataset["ox"], 0.5);
      const oy = parseFraction(root.dataset["oy"], 0.5);
      ctx.drawImage(img, (px[0] - ox * w) * scale, (px[1] - oy * h) * scale, w * scale, h * scale);
    }
    return await canvasToBlob(composite);
  } catch {
    return base; // degrade to the card-less snapshot rather than failing
  }
}
