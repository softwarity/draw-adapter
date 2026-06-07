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

/** Default camera icon for the snapshot toolbar button (inherits `currentColor`). */
export const SNAPSHOT_ICON_SVG =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>` +
  `<circle cx="12" cy="13" r="4"/></svg>`;

/** Clipboard icon — shown on the snapshot button when the clipboard delivery is active. */
export const SNAPSHOT_CLIPBOARD_ICON =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>` +
  `<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;

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
  config: "none" | false | null | { quality?: SnapshotQuality; onClick?: SnapshotDelivery } | undefined,
  cap: { supported: boolean; reason?: string; snapshot: (opts?: SnapshotOptions) => Promise<Blob> },
): ToolbarItem | null {
  if (config === null || config === false || config === "none") return null; // undefined ⇒ defaults
  const cfg = typeof config === "object" ? config : {};
  const scale = snapshotScale(cfg.quality ?? "native");
  const primary: SnapshotDelivery = cfg.onClick ?? "download";
  const secondary: SnapshotDelivery = primary === "download" ? "clipboard" : "download";
  return {
    id: "snapshot",
    label: "📷",
    svg: DELIVERY_ICON[primary],
    title: cap.supported
      ? deliveryTitle(primary, secondary)
      : (cap.reason ?? "Snapshot is not supported on this engine"),
    ...(cap.supported ? {} : { disabled: true }),
    onClick: cap.supported
      ? (e?: MouseEvent) => {
          const target: SnapshotDelivery = e?.ctrlKey || e?.metaKey ? secondary : primary;
          cap.snapshot({ scale, target }).catch(() => { /* capture/deliver failed */ });
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
