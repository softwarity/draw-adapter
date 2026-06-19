/**
 * **Read-only sprite rasterizer** — engine-agnostic. Turns a {@link MarkerWidget} whose
 * `static` flag is set into a bitmap that the engine adapters place as a **native icon**
 * (MapLibre `addImage`, OpenLayers `Icon`, Leaflet `<img>`), so a non-selected cartouche
 * gets the rich `WidgetBox` layout without N live DOM cards to reposition each frame.
 *
 * Strategy: **measure in the DOM, paint on a canvas.** We build the box-layout tree as a
 * real (off-screen) DOM subtree — so the browser's own flex/text layout positions every
 * node (one layout logic, shared with the live card) — then read each node's measured
 * geometry back and **repaint** it onto a 2D canvas (`fillText` / rounded-rect frames /
 * `drawImage` for glyph SVGs). No `foreignObject` is involved, so the canvas stays
 * origin-clean and is readable as `ImageData` / `toDataURL` / a WebGL texture on **every**
 * browser (incl. Safari/WebKit, where a `foreignObject` render would taint it).
 *
 * The DOM subtree is measured **inside the engine's own container** (off-screen) so it
 * inherits the exact same font/line-height cascade as a real mounted card → pixel parity.
 *
 * The result is cached per `id` and only re-rasterized when the layout hash or the
 * device-pixel-ratio changes — never on pan/zoom.
 */
import type { LatLng, MarkerWidget, WidgetCoord, WidgetGlyph, WidgetNode, WidgetText } from "./index.js";
import { boxBorderWidth, boxPadding, boxRadius } from "./textbox.js";
import { applyBoxFrame, resolveBoxShape, boxShapeLayout, type ShapeLayout } from "./widget.js";
import { colorizeSprite, svgToDataUrl } from "./symbols.js";
import { defaultCoordFormat } from "./coerce.js";

/** Rendered size of a sprite, in **CSS px** (for placement / anchoring / collision). */
export interface WidgetSize {
  width: number;
  height: number;
}

/** Options shared by {@link measureWidget} / {@link rasterizeWidget}. */
export interface SpriteOptions {
  /** Device pixels per CSS px the bitmap is rendered at. Default `window.devicePixelRatio` (≥1). */
  dpr?: number;
  /** Formatter for `coord` leaves (mirrors {@link MapAdapter.setCoordFormat}). Default decimal lat/lon. */
  coordFmt?: (ll: LatLng) => string;
  /** Element to measure the off-screen tree inside, so it inherits the same CSS cascade (font,
   *  line-height) as a real card. Pass the engine map container; defaults to `document.body`. */
  container?: HTMLElement;
}

/** A rasterized sprite: a device-pixel canvas plus its CSS-px size and the dpr it was drawn at. */
export interface SpriteResult {
  /** Canvas at device resolution (`width = round(cssWidth × dpr)`); origin-clean, so it can be read
   *  back (`getContext("2d").getImageData` / `toDataURL`) or uploaded as a texture on any browser. */
  canvas: HTMLCanvasElement;
  /** CSS-px width (icon display size). */
  width: number;
  /** CSS-px height. */
  height: number;
  /** The device-pixel-ratio this canvas was rendered at. */
  dpr: number;
}

interface CacheEntry {
  hash: string;
  size: WidgetSize;
  sprite?: SpriteResult;
}

/** Per-`id` cache: size + (lazily) the rasterized bitmap. Keyed by the widget id so re-rasters only
 *  happen on a content/dpr change (req. "re-raster only on change", never per frame/pan/zoom). */
const cache = new Map<string, CacheEntry>();

/** Drop cached sprite(s). Pass an `id` to evict one, or omit to clear all (engine `destroy`). */
export function clearSpriteCache(id?: string): void {
  if (id == null) cache.clear();
  else cache.delete(id);
}

function currentDpr(opt?: number): number {
  if (opt && opt > 0) return opt;
  return (typeof window !== "undefined" && window.devicePixelRatio) || 1;
}

// ── content hashing (re-raster only on change) ────────────────────────────────

/** True if the subtree contains a live `coord` leaf (its text depends on the anchor). */
function hasCoord(node: WidgetNode): boolean {
  if (!("kind" in node)) return node.items.some(hasCoord);
  return node.kind === "coord";
}

/** Stable hash of everything that affects the rasterized pixels. The `child` tree + card frame +
 *  font are JSON-stable; a `coord` leaf additionally folds in the formatted anchor (so moving the
 *  underlying point re-rasters, while a pan/zoom — which never changes the anchor — does not). */
function widgetHash(w: MarkerWidget, coordFmt: (ll: LatLng) => string): string {
  const frame = {
    child: w.child,
    bg: w.bg,
    border: w.border,
    borderWidth: w.borderWidth,
    radius: w.radius,
    padding: w.padding,
    boxShape: w.boxShape,
    font: w.font,
  };
  let h = JSON.stringify(frame);
  if (hasCoord(w.child)) h += "|coord:" + coordFmt(w.anchor);
  return h;
}

// ── building the static DOM (the read-only form of the box tree) ──────────────

/** Apply the card-level frame to the sprite root — mirrors `Card.update`'s root styling so a
 *  `static` widget lays out identically to its live DOM card (same bg/border/radius/padding/font).
 *  This draws the plain **rect** frame; a non-rect `boxShape` (pentagon / custom polygon) is handled
 *  in {@link rasterizeWidget} (via {@link shapedLayout} + {@link paintShapeFrame}), which strips this
 *  rect frame and paints the contour instead — see {@link Card.applyShape} for the live-card twin. */
function applyCardFrame(s: CSSStyleDeclaration, w: MarkerWidget): void {
  const framed = !!(w.bg || w.border);
  s.position = "relative";
  s.display = "inline-block";
  s.boxSizing = "border-box";
  s.whiteSpace = "nowrap";
  s.background = w.bg ?? "transparent";
  s.border = w.border ? `${boxBorderWidth(w.borderWidth)}px solid ${w.border}` : "";
  s.borderRadius = `${boxRadius(w.radius)}px`;
  if (framed || w.padding != null) {
    const [pv, ph] = boxPadding(w.padding);
    s.padding = `${pv}px ${ph}px`;
  } else {
    s.padding = "0";
  }
  s.color = w.font?.color ?? "";
  s.fontSize = w.font?.size != null ? `${w.font.size}px` : "";
  s.fontFamily = w.font?.family ?? "";
  s.lineHeight = w.font?.lineHeight != null ? String(w.font.lineHeight) : "1.2";
}

/** Replicate `setGlyph`: inject the inline SVG and force the inner node to fill the glyph box. */
function setGlyphHtml(el: HTMLElement, svg: string): void {
  el.innerHTML = svg;
  const inner = el.firstElementChild as HTMLElement | null;
  if (inner) { inner.style.width = "100%"; inner.style.height = "100%"; inner.style.display = "block"; }
}

/** The label text a `"picker"` shows for its current value (the option's `label`, else its value). */
function pickerText(node: WidgetText): string {
  const sel = (node.options ?? []).find((o) => (typeof o === "string" ? o : o.value) === node.value);
  if (sel == null) return node.value;
  return typeof sel === "string" ? sel : (sel.label ?? sel.value);
}

/**
 * Build the **read-only** DOM form of one node — same layout CSS as the live card (so it measures
 * identically), but every interactive control is flattened to a static span:
 *  - editable `input` → a span showing its value,
 *  - `"picker"` → a span showing the current option's label (+ its glyph if any),
 *  - `gauge`/`dial` → omitted (a read-only sprite has no editing controls; see {@link MarkerWidget.static}).
 */
function buildNode(node: WidgetNode, anchor: LatLng, coordFmt: (ll: LatLng) => string): HTMLElement | null {
  // WidgetBox (no `kind`)
  if (!("kind" in node)) {
    const el = document.createElement("div");
    const s = el.style;
    s.display = "flex";
    s.flexDirection = node.dir === "v" ? "column" : "row";
    s.alignItems = node.align === "start" ? "flex-start" : node.align === "end" ? "flex-end" : "center";
    s.gap = `${node.gap ?? 0}px`;
    if (node.color != null) s.color = node.color;
    if (node.size != null) s.fontSize = `${node.size}px`;
    applyBoxFrame(s, node);
    for (const item of node.items) {
      const child = buildNode(item, anchor, coordFmt);
      if (child) el.appendChild(child);
    }
    return el;
  }
  if (node.kind === "glyph") {
    const g = node as WidgetGlyph;
    const el = document.createElement("span");
    el.style.display = "inline-flex";
    setGlyphHtml(el, g.svg);
    const px = g.size != null ? `${g.size}px` : "";
    el.style.width = px;
    el.style.height = px;
    if (g.color != null) el.style.color = g.color;
    return el;
  }
  if (node.kind === "coord") {
    const c = node as WidgetCoord;
    const el = document.createElement("span");
    if (c.color != null) el.style.color = c.color;
    if (c.size != null) el.style.fontSize = `${c.size}px`;
    el.textContent = coordFmt(anchor);
    return el;
  }
  // gauge / dial — editing controls; a read-only sprite shows none.
  if (node.kind === "gauge" || node.kind === "dial") return null;
  // text (static label, flattened input, or flattened picker)
  const t = node as WidgetText;
  const el = document.createElement("span");
  const s = el.style;
  s.whiteSpace = "pre-line";
  s.textAlign = "center";
  if (t.uppercase) s.textTransform = "uppercase";
  if (t.color != null) s.color = t.color;
  if (t.size != null) s.fontSize = `${t.size}px`;
  el.textContent = t.control === "picker" ? pickerText(t) : t.value;
  return el;
}

/** Build the full sprite root for `w` (card frame + read-only box tree). */
function buildStaticTree(w: MarkerWidget, coordFmt: (ll: LatLng) => string): HTMLElement {
  const root = document.createElement("div");
  applyCardFrame(root.style, w);
  const content = document.createElement("div");
  content.style.display = "inline-block";
  const child = buildNode(w.child, w.anchor, coordFmt);
  if (child) content.appendChild(child);
  root.appendChild(content);
  return root;
}

/** Mount `root` off-screen inside `container` so it lays out with the same CSS cascade as a card. */
function mountOffscreen(root: HTMLElement, container: HTMLElement): void {
  root.style.position = "absolute";
  root.style.left = "-99999px";
  root.style.top = "0";
  root.style.transform = "none";
  root.style.pointerEvents = "none";
  container.appendChild(root);
}

// ── painting the measured tree onto a canvas ──────────────────────────────────

/** A loaded glyph image keyed by its colorized SVG markup (deduplicated across identical glyphs). */
type GlyphImages = Map<string, HTMLImageElement>;

/** The colorized SVG markup for a glyph element (its inline `<svg>` with `currentColor` resolved to
 *  the element's computed colour), or `null` if it has no SVG child. */
function glyphMarkup(el: HTMLElement): string | null {
  const svg = el.querySelector(":scope > svg");
  if (!svg) return null;
  const color = getComputedStyle(el).color || "#000";
  return colorizeSprite(svg.outerHTML, color);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // a bad glyph just paints nothing
    img.src = src;
  });
}

/** Pre-load every glyph image in the tree (rasterization is async) so the paint pass is synchronous. */
async function preloadGlyphs(root: HTMLElement): Promise<GlyphImages> {
  const wanted = new Set<string>();
  const collect = (el: Element): void => {
    const m = glyphMarkup(el as HTMLElement);
    if (m) wanted.add(m);
    for (const c of Array.from(el.children)) collect(c);
  };
  collect(root);
  const out: GlyphImages = new Map();
  await Promise.all(
    [...wanted].map(async (svg) => {
      const img = await loadImage(svgToDataUrl(svg));
      if (img) out.set(svg, img);
    }),
  );
  return out;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof (ctx as { roundRect?: unknown }).roundRect === "function") {
    ctx.beginPath();
    (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, rad);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function isPaintable(color: string): boolean {
  if (!color) return false;
  const c = color.replace(/\s+/g, "");
  // Computed styles normalize "transparent" / an unset bg to `rgba(0,0,0,0)`.
  return c !== "transparent" && c !== "rgba(0,0,0,0)";
}

/** Paint an element's background + border frame (rounded; per-side aware for L-shapes). */
function paintDecoration(ctx: CanvasRenderingContext2D, cs: CSSStyleDeclaration, x: number, y: number, w: number, h: number): void {
  const radius = parseFloat(cs.borderTopLeftRadius) || 0;
  const bg = cs.backgroundColor;
  if (isPaintable(bg)) {
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = bg;
    ctx.fill();
  }
  const sides = [
    { wdt: parseFloat(cs.borderTopWidth) || 0, col: cs.borderTopColor, a: [x, y], b: [x + w, y] },
    { wdt: parseFloat(cs.borderRightWidth) || 0, col: cs.borderRightColor, a: [x + w, y], b: [x + w, y + h] },
    { wdt: parseFloat(cs.borderBottomWidth) || 0, col: cs.borderBottomColor, a: [x + w, y + h], b: [x, y + h] },
    { wdt: parseFloat(cs.borderLeftWidth) || 0, col: cs.borderLeftColor, a: [x, y + h], b: [x, y] },
  ] as const;
  const drawn = sides.filter((sd) => sd.wdt > 0 && isPaintable(sd.col));
  if (!drawn.length) return;
  // Uniform border (all four sides equal) ⇒ one rounded stroke (honours radius); else per-side
  // straight strokes (L-shapes set per-side colours and radius `none`).
  const uniform = drawn.length === 4 && drawn.every((sd) => sd.wdt === drawn[0]!.wdt && sd.col === drawn[0]!.col);
  if (uniform) {
    const bw = drawn[0]!.wdt;
    roundRectPath(ctx, x + bw / 2, y + bw / 2, w - bw, h - bw, Math.max(0, radius - bw / 2));
    ctx.strokeStyle = drawn[0]!.col;
    ctx.lineWidth = bw;
    ctx.stroke();
    return;
  }
  for (const sd of drawn) {
    // Inset the edge by half its width so the stroke sits inside the border-box (like CSS).
    const ix = sd.a[0] === x + w ? -sd.wdt / 2 : sd.a[0] === x ? sd.wdt / 2 : 0;
    const iy = sd.a[1] === y + h ? -sd.wdt / 2 : sd.a[1] === y ? sd.wdt / 2 : 0;
    ctx.beginPath();
    ctx.moveTo(sd.a[0] + ix, sd.a[1] + iy);
    ctx.lineTo(sd.b[0] + ix, sd.b[1] + iy);
    ctx.strokeStyle = sd.col;
    ctx.lineWidth = sd.wdt;
    ctx.stroke();
  }
}

/** Paint a text leaf, line by line, at its measured positions (so wrapping/`\n` match the DOM). */
function paintText(ctx: CanvasRenderingContext2D, el: HTMLElement, cs: CSSStyleDeclaration, ox: number, oy: number): void {
  const raw = el.textContent ?? "";
  if (!raw) return;
  const transform = cs.textTransform;
  const text = transform === "uppercase" ? raw.toUpperCase() : transform === "lowercase" ? raw.toLowerCase() : raw;
  ctx.font = cs.font && cs.font !== "" ? cs.font : `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const lines = text.split("\n");
  // Per-line client rects from a Range over the text — exact laid-out positions (centred, wrapped…).
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects());
  if (rects.length === lines.length) {
    for (let i = 0; i < lines.length; i++) {
      const r = rects[i]!;
      ctx.fillText(lines[i]!, r.left - ox, r.top - oy + r.height / 2);
    }
    return;
  }
  // Fallback (unexpected wrap mismatch): centre the whole text in the element box.
  const er = el.getBoundingClientRect();
  ctx.textAlign = "center";
  ctx.fillText(text, er.left - ox + er.width / 2, er.top - oy + er.height / 2);
}

/** Recursively paint one element (decoration, then glyph / text / children). */
function paintEl(ctx: CanvasRenderingContext2D, el: HTMLElement, ox: number, oy: number, glyphs: GlyphImages): void {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const x = r.left - ox;
  const y = r.top - oy;
  paintDecoration(ctx, cs, x, y, r.width, r.height);
  const markup = glyphMarkup(el);
  if (markup != null) {
    const img = glyphs.get(markup);
    if (img) ctx.drawImage(img, x, y, r.width, r.height);
    return;
  }
  const kids = Array.from(el.children).filter((c) => c.nodeType === 1) as HTMLElement[];
  if (!kids.length) {
    paintText(ctx, el, cs, ox, oy);
    return;
  }
  for (const k of kids) paintEl(ctx, k, ox, oy, glyphs);
}

// ── non-rect boxShape (pentagon / custom polygon) — mirror the DOM card's `applyShape` on canvas ──

/**
 * Lay out a non-rect {@link MarkerWidget.boxShape} for the sprite, exactly like the live DOM card's
 * `applyShape`: strip the CSS frame off `root`, move padding onto the content, measure the content box,
 * and reuse {@link boxShapeLayout} for the SAME contour. Returns `null` for a plain rect (`root`
 * untouched) or an unmeasurable content box. The off-screen `root` MUST already be mounted.
 */
function shapedLayout(root: HTMLElement, w: MarkerWidget): { content: HTMLElement; cr: DOMRect; lay: ShapeLayout; bw: number } | null {
  const poly = resolveBoxShape(w.boxShape);
  const content = root.firstElementChild as HTMLElement | null;
  if (!poly || !content) return null;
  // The frame becomes the painted polygon, so the CSS box steps aside and the padding moves onto the
  // content — identical to `applyShape`, so the measured content box (and thus the contour) matches.
  const rs = root.style; rs.background = "transparent"; rs.border = ""; rs.borderRadius = "0"; rs.padding = "0";
  const [pv, ph] = boxPadding(w.padding);
  content.style.padding = `${pv}px ${ph}px`;
  const cr = content.getBoundingClientRect();
  if (!cr.width || !cr.height) return null;
  const bw = w.border ? boxBorderWidth(w.borderWidth) : 0;
  return { content, cr, bw, lay: boxShapeLayout(poly, cr.width, cr.height, bw) };
}

/** Paint a {@link boxShapeLayout} contour onto the sprite canvas (fill = card `bg`, stroke = card
 *  `border`) — the same polygon the DOM card draws as an SVG, behind the content. */
function paintShapeFrame(ctx: CanvasRenderingContext2D, lay: ShapeLayout, w: MarkerWidget, bw: number): void {
  const pts = lay.points.split(" ").map((s) => s.split(",").map(Number));
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0]!, pts[0]![1]!);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0]!, pts[i]![1]!);
  ctx.closePath();
  if (w.bg) { ctx.fillStyle = w.bg; ctx.fill(); }
  if (w.border && bw > 0) { ctx.strokeStyle = w.border; ctx.lineWidth = bw; ctx.lineJoin = "round"; ctx.stroke(); }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Measure the rendered size of a `static` widget — **CSS px** — without painting it. Used by the
 * consumer's call-out placement pass so a sprite collides with its exact box (no estimate). Cheap
 * and cached per `id`; in a headless DOM (jsdom, `getBoundingClientRect` ⇒ 0) it returns a zero size.
 */
export function measureWidget(w: MarkerWidget, opts?: SpriteOptions): WidgetSize {
  const coordFmt = opts?.coordFmt ?? defaultCoordFormat;
  const hash = widgetHash(w, coordFmt);
  const hit = cache.get(w.id);
  if (hit && hit.hash === hash) return hit.size;
  const container = opts?.container ?? (typeof document !== "undefined" ? document.body : undefined);
  if (!container) return { width: 0, height: 0 };
  const root = buildStaticTree(w, coordFmt);
  mountOffscreen(root, container);
  const shaped = shapedLayout(root, w); // non-rect boxShape ⇒ size = the contour bbox (incl. overshoot)
  const size: WidgetSize = shaped
    ? { width: shaped.lay.svgW, height: shaped.lay.svgH }
    : { width: root.offsetWidth, height: root.offsetHeight };
  root.remove();
  cache.set(w.id, { hash, size }); // a stale sprite (if any) is dropped — size changed ⇒ re-raster needed
  return size;
}

/**
 * Rasterize a `static` widget to a device-pixel canvas (cached per `id`; re-rendered only when the
 * layout hash or `dpr` changes). Returns `null` when there is no DOM (SSR) or the measured size is
 * empty (headless test env). The canvas is origin-clean — `getImageData` / `toDataURL` / texture
 * upload all work on every browser.
 */
export async function rasterizeWidget(w: MarkerWidget, opts?: SpriteOptions): Promise<SpriteResult | null> {
  if (typeof document === "undefined") return null;
  const coordFmt = opts?.coordFmt ?? defaultCoordFormat;
  const dpr = currentDpr(opts?.dpr);
  const hash = widgetHash(w, coordFmt);
  const hit = cache.get(w.id);
  if (hit?.sprite && hit.hash === hash && hit.sprite.dpr === dpr) return hit.sprite;

  const container = opts?.container ?? document.body;
  const root = buildStaticTree(w, coordFmt);
  mountOffscreen(root, container);
  const shaped = shapedLayout(root, w); // non-rect boxShape ⇒ paint a polygon frame instead of the CSS box
  const glyphs = await preloadGlyphs(root);

  /** Make a `cssW × cssH` device-px canvas + a dpr-scaled 2D context (null if 2D is unavailable). */
  const make = (cssW: number, cssH: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    (ctx as { textRendering?: string }).textRendering = "optimizeLegibility"; // not in older TS DOM libs
    return { canvas, ctx };
  };

  let sprite: SpriteResult | null = null;
  if (shaped) {
    // Non-rect boxShape: the canvas is the contour bbox (INCLUDING the overshoot past the content box).
    // Paint the polygon frame behind, then the content at the contour's [0,1] content-box origin
    // (`inset + overshoot`) — pixel-shape-identical to the live DOM card's `applyShape`.
    const { content, cr, lay, bw } = shaped;
    const c = make(lay.svgW, lay.svgH);
    if (c) {
      paintShapeFrame(c.ctx, lay, w, bw);
      paintEl(c.ctx, content, cr.left - (lay.inset + lay.over.l), cr.top - (lay.inset + lay.over.t), glyphs);
      sprite = { canvas: c.canvas, width: lay.svgW, height: lay.svgH, dpr };
    }
  } else if (root.offsetWidth && root.offsetHeight) {
    const origin = root.getBoundingClientRect();
    const c = make(root.offsetWidth, root.offsetHeight);
    if (c) {
      paintEl(c.ctx, root, origin.left, origin.top, glyphs);
      sprite = { canvas: c.canvas, width: root.offsetWidth, height: root.offsetHeight, dpr };
    }
  }
  root.remove();
  if (sprite) cache.set(w.id, { hash, size: { width: sprite.width, height: sprite.height }, sprite });
  return sprite;
}
