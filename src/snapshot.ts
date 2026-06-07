/**
 * PNG snapshot helpers shared by the engine adapters.
 *
 * `snapshot()` itself is engine-specific (it must capture inside the engine's own
 * render frame), but the toolbar wiring — preset→scale mapping, the camera button,
 * the browser download — is identical everywhere and lives here so the three
 * adapters stay thin.
 */
import type { SnapshotDelivery, SnapshotQuality, SnapshotOptions, ToolbarItem } from "./index.js";

/**
 * Map a snapshot quality preset to an output pixel-ratio (device px per CSS px).
 *  - `low`    → 1 (CSS-pixel resolution),
 *  - `native` → `window.devicePixelRatio` (capture "as on screen"; 1 if undefined),
 *  - `medium` → 2, `high` → 3 (supersampling; best-effort, see README).
 */
export function snapshotScale(quality: SnapshotQuality): number {
  switch (quality) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "native":
    default:
      return (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  }
}

// Both snapshot icons are the same camera glyph (Feather-style, `currentColor`); the
// only difference is the lens: FILLED for download, an empty ring for clipboard.

/** Snapshot **download** icon — camera with a **filled** lens. */
export const SNAPSHOT_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>` +
  `<circle cx="12" cy="13" r="4" fill="currentColor"/></svg>`;

/** Snapshot **clipboard** icon — same camera with an **empty** (ring-only) lens. */
export const SNAPSHOT_CLIPBOARD_ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>` +
  `<circle cx="12" cy="13" r="4"/></svg>`;

/** Download a Blob as a file in the browser (object-URL + a transient `<a download>`). */
export function downloadPng(blob: Blob, filename = "map.png"): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Copy a PNG Blob to the system clipboard via the async Clipboard API. Needs a
 * **secure context** (HTTPS/localhost) and a **user gesture** (a click) — the
 * toolbar button provides the latter. Rejects when the browser/context can't
 * write an image to the clipboard.
 */
export async function copyPng(blob: Blob): Promise<void> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Clipboard image write is unavailable (needs a secure context and a supporting browser).");
  }
  await clip.write([new ClipboardItem({ "image/png": blob })]);
}

/** Apply a {@link SnapshotOptions.target} to a captured PNG (download / clipboard /
 *  none) and return the Blob unchanged — the shared delivery used by every adapter's
 *  `snapshot()` so capture and side-effects stay in one place. */
export async function deliverSnapshot(blob: Blob, opts?: SnapshotOptions): Promise<Blob> {
  switch (opts?.target) {
    case "download":
      downloadPng(blob, opts.filename);
      break;
    case "clipboard":
      await copyPng(blob);
      break;
    // "blob" / undefined → just return it
  }
  return blob;
}

const SHUTTER_STYLE_ID = "draw-adapter-shutter-style";

function ensureShutterStyle(): void {
  if (typeof document === "undefined" || document.getElementById(SHUTTER_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = SHUTTER_STYLE_ID;
  // Two semi-transparent blades (top + bottom, 50% each) slide in to meet at the centre
  // then retract — a simple curtain shutter. Translucent so the map stays faintly visible;
  // 50% height each ⇒ they meet exactly with no double-dark overlap line.
  s.textContent =
    `.draw-adapter-shutter{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1000}` +
    `.draw-adapter-shutter>i{position:absolute;left:0;right:0;height:50%;background:rgba(0,0,0,.55)}` +
    `.draw-adapter-shutter>i.t{top:0;transform:translateY(-100%);animation:dap-shutter-t var(--dap-shutter,600ms) ease-in-out forwards}` +
    `.draw-adapter-shutter>i.b{bottom:0;transform:translateY(100%);animation:dap-shutter-b var(--dap-shutter,600ms) ease-in-out forwards}` +
    `.draw-adapter-shutter.blink{background:rgba(0,0,0,.55);animation:dap-shutter-blink var(--dap-shutter,200ms) ease-out forwards}` +
    `@keyframes dap-shutter-t{0%{transform:translateY(-100%)}45%,55%{transform:translateY(0)}100%{transform:translateY(-100%)}}` +
    `@keyframes dap-shutter-b{0%{transform:translateY(100%)}45%,55%{transform:translateY(0)}100%{transform:translateY(100%)}}` +
    `@keyframes dap-shutter-blink{0%{opacity:0}45%{opacity:1}100%{opacity:0}}`;
  document.head.appendChild(s);
}

/**
 * Play a brief curtain shutter over `container` — two translucent blades close to the
 * centre and reopen (the map stays faintly visible). Visual feedback for a capture
 * (handy for the otherwise-silent clipboard copy). Honours `prefers-reduced-motion`
 * (degrades to a single quick dim). The overlay is `pointer-events:none` and
 * self-removes. `container` must be a positioned element (the engine map containers are).
 */
export function shutterFlash(container: HTMLElement, opts?: { durationMs?: number }): void {
  if (typeof document === "undefined") return;
  ensureShutterStyle();
  const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const wrap = document.createElement("div");
  wrap.className = reduce ? "draw-adapter-shutter blink" : "draw-adapter-shutter";
  if (opts?.durationMs) wrap.style.setProperty("--dap-shutter", `${opts.durationMs}ms`);
  const remove = (): void => wrap.remove();
  let animated: HTMLElement = wrap; // reduced-motion ⇒ the wrapper itself dims
  if (!reduce) {
    const top = document.createElement("i"); top.className = "t";
    const bot = document.createElement("i"); bot.className = "b";
    wrap.append(top, bot);
    animated = bot; // both blades share the animation → they end together
  }
  animated.addEventListener("animationend", remove, { once: true });
  container.appendChild(wrap);
  // Fallback removal if `animationend` never fires (detached node / no animation support).
  setTimeout(remove, (opts?.durationMs ?? 600) + 120);
}

/** Label of the modifier key the snapshot button uses for its alternate delivery
 *  (⌘ on Mac, Ctrl elsewhere). */
function modifierLabel(): string {
  const nav: { userAgentData?: { platform?: string }; platform?: string; userAgent?: string } =
    typeof navigator !== "undefined" ? navigator : {};
  const plat = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac/i.test(plat) ? "⌘" : "Ctrl";
}

const DELIVERY_VERB: Record<SnapshotDelivery, string> = { download: "Download map", clipboard: "Copy map to clipboard" };
const DELIVERY_SHORT: Record<SnapshotDelivery, string> = { download: "download", clipboard: "copy" };
const DELIVERY_ICON: Record<SnapshotDelivery, string> = { download: SNAPSHOT_ICON_SVG, clipboard: SNAPSHOT_CLIPBOARD_ICON };

/** Tooltip for "`active` on a plain click, `other` on a modifier-click". */
function deliveryTitle(active: SnapshotDelivery, other: SnapshotDelivery): string {
  return `${DELIVERY_VERB[active]} — ${modifierLabel()}-click to ${DELIVERY_SHORT[other]}`;
}

/**
 * Build the snapshot toolbar item for an adapter, or `null` when the button is
 * hidden. **`undefined` ⇒ defaults** (a button); `null` / `false` / `"none"` ⇒ no
 * button; an object configures it.
 *
 * The button always offers **both** deliveries: the `onClick` delivery on a plain
 * click, the other one on a modifier-click ({@link modifierLabel}). Each click calls
 * the adapter's own `snapshot({ scale, target })` (which captures *and* delivers).
 * On an unsupported engine the button is rendered DISABLED with `reason` as tooltip.
 * Called by each adapter's `addToolbar` (it owns `snapshot`/`snapshotSupported`).
 */
export function snapshotToolbarItem(
  config: "none" | false | null | { quality?: SnapshotQuality; onClick?: SnapshotDelivery; shutter?: boolean; hideOverlays?: string[] } | undefined,
  cap: { supported: boolean; reason?: string; snapshot: (opts?: SnapshotOptions) => Promise<Blob>; flash?: () => void },
): ToolbarItem | null {
  if (config === null || config === false || config === "none") return null; // undefined ⇒ defaults
  const cfg = typeof config === "object" ? config : {};
  const scale = snapshotScale(cfg.quality ?? "native");
  const primary: SnapshotDelivery = cfg.onClick ?? "download";
  const secondary: SnapshotDelivery = primary === "download" ? "clipboard" : "download";
  const shutter = cfg.shutter !== false; // default ON
  const hideOverlays = cfg.hideOverlays;
  return {
    id: "snapshot",
    svg: DELIVERY_ICON[primary],
    title: cap.supported
      ? deliveryTitle(primary, secondary)
      : (cap.reason ?? "Snapshot is not supported on this engine"),
    ...(cap.supported ? {} : { disabled: true }),
    onClick: cap.supported
      ? (e?: MouseEvent) => {
          const target: SnapshotDelivery = e?.ctrlKey || e?.metaKey ? secondary : primary;
          const opts: SnapshotOptions = { scale, target };
          if (hideOverlays?.length) opts.hideOverlays = hideOverlays;
          // Flash only on success → it doubles as the "captured / copied" confirmation.
          cap.snapshot(opts).then(() => { if (shutter) cap.flash?.(); }).catch(() => { /* failed */ });
        }
      : () => { /* disabled: no-op */ },
    // While the button is hovered, mirror the held modifier in the icon + tooltip so
    // the user sees which delivery a click will trigger. Key listeners live ONLY for
    // the duration of the hover (added on enter, removed on leave) — no global churn.
    ...(cap.supported ? { onRender: (btn: HTMLButtonElement) => bindModifierPreview(btn, primary, secondary) } : {}),
  };
}

/** Swap a snapshot button's icon/tooltip to the alternate delivery while a modifier
 *  key is held over it. Listeners are scoped to the hover (self-cleaning). */
function bindModifierPreview(btn: HTMLButtonElement, primary: SnapshotDelivery, secondary: SnapshotDelivery): void {
  if (typeof window === "undefined") return;
  let mod = false;
  const paint = (m: boolean): void => {
    const [active, other] = m ? [secondary, primary] : [primary, secondary];
    btn.innerHTML = DELIVERY_ICON[active];
    btn.title = deliveryTitle(active, other);
  };
  const onKey = (e: KeyboardEvent): void => {
    const m = e.ctrlKey || e.metaKey;
    if (m !== mod) { mod = m; paint(m); }
  };
  btn.addEventListener("mouseenter", (e) => {
    mod = e.ctrlKey || e.metaKey;
    paint(mod);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  });
  btn.addEventListener("mouseleave", () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    if (mod) { mod = false; paint(false); }
  });
}
