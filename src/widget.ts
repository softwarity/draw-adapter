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
} from "./index.js";
import { boxBorderWidth, boxPadding, boxRadius } from "./textbox.js";
import { modifiers } from "./modifiers.js";

/** A handle to one engine-anchored card mount. The card DOM lives inside `el`. */
export interface WidgetMount {
  /** The engine-anchored element (its top-left tracks the anchor); the card is appended here. */
  readonly el: HTMLElement;
  /** Move the mount to a new anchor. */
  setAnchor(anchor: LatLng): void;
  /** Detach the mount from the map. */
  remove(): void;
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

/** Default `coord` formatter — a compact decimal lat/long. Consumers override via
 *  {@link MapAdapter.setCoordFormat} (e.g. sigwx supplies its own `formatLatLng`). */
export function defaultCoordFormat(ll: LatLng): string {
  const lat = `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}`;
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

/** Each place value → the set of `[fx, fy]` fractional points it covers on the card box. */
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
};

/** Expand a `place` (a value or an array of groups) into a deduped list of `[fx, fy]` points. */
function expandPlaces(place: WidgetButton["place"]): [number, number][] {
  const list: WidgetButtonPlace[] = Array.isArray(place) ? place : place != null ? [place] : ["right"];
  const seen = new Set<string>();
  const pts: [number, number][] = [];
  for (const p of list) {
    for (const [fx, fy] of PLACE_POINTS[p] ?? PLACE_POINTS.right) {
      const k = `${fx},${fy}`;
      if (!seen.has(k)) { seen.add(k); pts.push([fx!, fy!]); }
    }
  }
  return pts;
}

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

/** One action button (bare glyph, or a small bordered circle), straddling its edge/corner point. */
function makeActionButton(b: WidgetButton, fx: number, fy: number, card: Card): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "draw-adapter-widget-btn";
  el.setAttribute("aria-label", b.title ?? b.event);
  if (b.title) el.title = b.title; // native tooltip on hover
  const s = el.style;
  s.position = "absolute";
  s.left = `${(fx * 100).toFixed(4)}%`;
  s.top = `${(fy * 100).toFixed(4)}%`;
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
    `.dap-picker-flower{position:fixed;z-index:1000;width:0;height:0;pointer-events:none;color:#24292f}` +
    `.dap-picker-petal{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;` +
    `display:flex;align-items:center;justify-content:center;background:#fff;color:inherit;font-weight:bold;` +
    `border:1px solid rgba(0,0,0,.15);` +
    `border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;padding:0;pointer-events:auto;` +
    `transition:transform 160ms cubic-bezier(.2,.8,.3,1.2),opacity 160ms ease}` +
    `.dap-picker-petal svg{display:block;width:18px;height:18px}` +
    `.dap-picker-petal:hover{background:#f4f4f4}` +
    // The grid popover is a solid box (like a toolbar flyout), JS-placed next to the control.
    `.dap-picker-grid{position:fixed;z-index:1000;display:grid;gap:2px;padding:4px;background:#fff;` +
    `border:1px solid rgba(0,0,0,.15);border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3);color:#24292f}` +
    `.dap-picker-grid button{width:30px;height:30px;display:flex;align-items:center;justify-content:center;` +
    `background:#fff;color:inherit;border:0;border-radius:4px;cursor:pointer;padding:0;font:inherit;font-weight:bold}` +
    `.dap-picker-grid button svg{display:block;width:18px;height:18px}` +
    `.dap-picker-grid button:hover{background:#f4f4f4}` +
    // Highlight markers — the current value and the keyboard-focused choice. Both the ring AND a light
    // background tint use the accent (`currentColor`): an accent ring over an accent-into-white fill
    // (neutral-grey background fallback where `color-mix` is unsupported). Focus = a thicker ring than
    // the current marker so they're distinguishable when they differ.
    `.dap-picker-petal.dap-current,.dap-picker-grid button.dap-current{` +
    `background:rgba(0,0,0,.06);background:color-mix(in srgb,currentColor 16%,#fff);outline:1px solid currentColor}` +
    `.dap-picker-petal.dap-focus{` +
    `background:rgba(0,0,0,.06);background:color-mix(in srgb,currentColor 16%,#fff);box-shadow:0 0 0 2px currentColor,0 2px 8px rgba(0,0,0,.3)}` +
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
  const prev = g.cursors[index - 1];
  const next = g.cursors[index + 1];
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

interface GaugeKnob { dot: HTMLElement; label: HTMLElement; }
interface GaugeState { trackHalo: HTMLElement; track: HTMLElement; knobs: GaugeKnob[]; gauge: WidgetGauge; dragging: number | null; live: number[]; }
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
  gaugeState.set(root, { trackHalo, track, knobs: [], gauge: { kind: "gauge", min: 0, max: 1, cursors: [] }, dragging: null, live: [] });
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
  const len = g.length ?? GAUGE_LEN;
  const horizontal = g.orientation === "horizontal";
  const maxChars = g.cursors.reduce((m, c) => Math.max(m, (c.label ?? "").length), 0);
  const rs = root.style;
  if (horizontal) { rs.width = `${len + KNOB}px`; rs.height = `${KNOB + (maxChars ? 14 : 0)}px`; }
  else { rs.height = `${len + KNOB}px`; rs.width = maxChars ? `calc(${KNOB + 4}px + ${maxChars}ch)` : `${KNOB}px`; }
  while (st.knobs.length < g.cursors.length) addKnob(root, st, card);
  while (st.knobs.length > g.cursors.length) { const k = st.knobs.pop()!; k.dot.remove(); k.label.remove(); }
  // keep the dragged cursor under the pointer; take the others from the model
  st.live = g.cursors.map((c, i) => (st.dragging === i ? (st.live[i] ?? c.value) : c.value));
  for (let i = 0; i < g.cursors.length; i++) {
    const k = st.knobs[i]!;
    k.label.textContent = g.cursors[i]!.label ?? "";
    applyLabelStyle(k.label, g.labelColor, g.labelHalo);
    k.dot.style.background = g.knobFill ?? "currentColor";
    const gStroke = g.knobStroke ?? "white"; // default white border; pass "" for none
    k.dot.style.border = gStroke ? `1.5px solid ${gStroke}` : "none";
    if (st.dragging !== i) placeKnob(k, gaugeAlong(valueFraction(st.live[i]!, g.min, g.max), len, horizontal), horizontal);
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
    card.emitEdit(String(v), g.cursors[index]?.name);
  });
  const end = (e: globalThis.PointerEvent): void => {
    const st = gaugeState.get(root); if (!st || st.dragging !== index) return;
    st.dragging = null;
    try { dot.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  dot.addEventListener("pointerup", end);
  dot.addEventListener("pointercancel", end);
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
  return root;
}

function updateDial(root: HTMLElement, d: WidgetDial, _card: Card): void {
  const st = dialState.get(root)!;
  st.dial = d;
  if (d.color) root.style.color = d.color;
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
  /** The SVG frame for a non-rect `boxShape` (lazily created); absent for the plain CSS box. */
  private shapeSvg: SVGSVGElement | undefined;
  private dragging = false;
  private downX = 0;
  private downY = 0;

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

  /** Reconcile this card's DOM to `w` in place (never recreate — preserves input focus). */
  update(w: MarkerWidget): void {
    this.id = w.id;
    this.anchor = w.anchor;
    const [ox, oy] = originXY(w.origin);
    const s = this.root.style;
    s.transform = `translate(${(-ox * 100).toFixed(4)}%, ${(-oy * 100).toFixed(4)}%)`;
    this.root.dataset["ox"] = `${ox}`; // remembered for the snapshot compositing offset
    this.root.dataset["oy"] = `${oy}`;
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
   *  `buttons` config changes (siblings of `content`, so the reconcile never touches them). */
  private ensureActionButtons(buttons: WidgetButton[] | undefined): void {
    const sig = JSON.stringify(buttons ?? []);
    if (sig === this.actionSig) return;
    this.actionSig = sig;
    for (const b of this.actionBtns) b.remove();
    this.actionBtns = [];
    for (const button of buttons ?? []) {
      for (const [fx, fy] of expandPlaces(button.place)) {
        const el = makeActionButton(button, fx, fy, this);
        this.root.appendChild(el);
        this.actionBtns.push(el);
      }
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

  constructor(private readonly host: WidgetHost) {}

  setWidgets(widgets: MarkerWidget[]): void {
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
      card.update(w);
    }
    for (const [id, card] of this.cards) {
      if (seen.has(id)) continue;
      card.mount.remove();
      this.cards.delete(id);
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
  "border", "border-radius", "padding", "margin",
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
function inlineStatic(src: HTMLElement, clone: HTMLElement): void {
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
