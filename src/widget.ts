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
  WidgetEdit,
  WidgetNode,
  WidgetOrigin,
} from "./index.js";
import { boxPadding, boxRadius } from "./textbox.js";
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
  if (node.kind === "text") return node.editable ? `text:${node.control ?? "input"}` : "text:label";
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

/** One action button (bare glyph, or a small bordered circle), straddling its edge/corner point. */
function makeActionButton(b: WidgetButton, fx: number, fy: number, card: Card): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "draw-adapter-widget-btn";
  el.setAttribute("aria-label", b.event);
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
  el.addEventListener("pointerdown", (e) => { e.stopPropagation(); }); // never start a drag
  el.addEventListener("click", (e) => { e.stopPropagation(); card.emitAction(b.event); });
  return el;
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
    s.border = w.border ? `1px solid ${w.border}` : ""; // "" clears it (no frame border)
    s.borderRadius = `${boxRadius(w.radius)}px`;
    if (framed) {
      const [pv, ph] = boxPadding(w.padding);
      s.padding = `${pv}px ${ph}px`;
    } else {
      s.padding = "0";
    }
    s.color = w.font?.color ?? "";
    s.fontSize = w.font?.size != null ? `${w.font.size}px` : "";
    s.fontFamily = w.font?.family ?? "";
    this.coordEls.length = 0;
    reconcile(this.content, [w.child], this);
    this.ensureDeleteButton(!!w.deletable, framed);
    this.ensureActionButtons(w.buttons);
  }

  emitAction(event: string): void {
    this.getActionCb()?.({ id: this.id, event });
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
  private ensureDeleteButton(on: boolean, framed: boolean): void {
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
      b.addEventListener("pointerdown", (e) => { e.stopPropagation(); }); // never start a drag
      b.addEventListener("click", (e) => { e.stopPropagation(); this.getDeleteCb()?.({ id: this.id }); });
      this.root.appendChild(b);
      this.delBtn = b;
    } else if (!on && this.delBtn) {
      this.delBtn.remove();
      this.delBtn = undefined;
    }
    if (this.delBtn) {
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

  emitEdit(value: string): void {
    this.getEditCb()?.({ id: this.id, value });
  }

  private wirePointer(): void {
    const root = this.root;
    root.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement | null;
      // editing or the delete button handle their own press — don't start a drag/select
      if (t?.closest("input, textarea, select, [contenteditable], .draw-adapter-widget-del, .draw-adapter-widget-btn")) return;
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
  } else if (node.editable) {
    const input = document.createElement("input");
    input.type = "text";
    const s = input.style;
    s.font = "inherit"; s.color = "inherit"; s.background = "transparent";
    s.border = "none"; s.outline = "none"; s.padding = "0"; s.margin = "0";
    s.minWidth = "0"; s.boxSizing = "content-box"; s.textAlign = "center";
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
      card.emitEdit(input.value);
      autosize(input);
    });
    input.addEventListener("pointerdown", (e) => { e.stopPropagation(); }); // edit, don't drag/pan
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
  // text
  if (node.editable) {
    const input = el as HTMLInputElement;
    input.placeholder = node.placeholder ?? "";
    input.dataset["uppercase"] = node.uppercase ? "1" : "";
    input.style.textTransform = node.uppercase ? "uppercase" : "";
    const val = node.uppercase ? node.value.toUpperCase() : node.value;
    if (input.value !== val) input.value = val; // don't clobber the caret on round-trip
    input.style.color = node.color ?? "inherit";
    input.style.fontSize = node.size != null ? `${node.size}px` : "";
    autosize(input);
  } else {
    el.textContent = node.value;
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
