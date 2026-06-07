/**
 * PNG snapshot helpers shared by the engine adapters.
 *
 * `snapshot()` itself is engine-specific (it must capture inside the engine's own
 * render frame), but the toolbar wiring — preset→scale mapping, the camera button,
 * the browser download — is identical everywhere and lives here so the three
 * adapters stay thin.
 */
import type { SnapshotDelivery, SnapshotLevel, SnapshotOptions, ToolbarItem } from "./index.js";

/**
 * Map a toolbar snapshot preset to an output pixel-ratio (device px per CSS px).
 *  - `low`    → 1 (CSS-pixel resolution),
 *  - `native` → `window.devicePixelRatio` (capture "as on screen"; 1 if undefined),
 *  - `medium` → 2, `high` → 3 (supersampling; best-effort, see README),
 *  - `none`   → falls back to native (the toolbar never builds a button for it).
 */
export function snapshotScale(level: SnapshotLevel): number {
  switch (level) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "native":
    case "none":
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

/**
 * Build the snapshot toolbar item for an adapter, or `null` for `"none"`.
 *
 * The button always offers **both** deliveries: the `onClick` delivery on a plain
 * click, the other one on a modifier-click ({@link modifierLabel}). Each click calls
 * the adapter's own `snapshot({ scale, target })` (which captures *and* delivers).
 * On an unsupported engine the button is rendered DISABLED with `reason` as tooltip.
 * Called by each adapter's `addToolbar` (it owns `snapshot`/`snapshotSupported`).
 */
export function snapshotToolbarItem(
  config: SnapshotLevel | { state: SnapshotLevel; onClick?: SnapshotDelivery } | undefined,
  cap: { supported: boolean; reason?: string; snapshot: (opts?: SnapshotOptions) => Promise<Blob> },
): ToolbarItem | null {
  const state: SnapshotLevel = (typeof config === "object" ? config.state : config) ?? "native";
  if (state === "none") return null;
  const scale = snapshotScale(state);
  const primary: SnapshotDelivery = (typeof config === "object" ? config.onClick : undefined) ?? "download";
  const secondary: SnapshotDelivery = primary === "download" ? "clipboard" : "download";
  return {
    id: "snapshot",
    label: "📷",
    svg: SNAPSHOT_ICON_SVG,
    title: cap.supported
      ? `${DELIVERY_VERB[primary]} — ${modifierLabel()}-click to ${DELIVERY_SHORT[secondary]}`
      : (cap.reason ?? "Snapshot is not supported on this engine"),
    ...(cap.supported ? {} : { disabled: true }),
    onClick: cap.supported
      ? (e?: MouseEvent) => {
          const target: SnapshotDelivery = e?.ctrlKey || e?.metaKey ? secondary : primary;
          cap.snapshot({ scale, target }).catch(() => { /* capture/deliver failed */ });
        }
      : () => { /* disabled: no-op */ },
  };
}
