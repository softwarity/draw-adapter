/**
 * PNG snapshot helpers shared by the engine adapters.
 *
 * `snapshot()` itself is engine-specific (it must capture inside the engine's own
 * render frame), but the toolbar wiring — preset→scale mapping, the camera button,
 * the browser download — is identical everywhere and lives here so the three
 * adapters stay thin.
 */
import type { SnapshotLevel, SnapshotOptions, ToolbarItem } from "./index.js";

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
 * Build the snapshot toolbar item for an adapter, or `null` when the preset is
 * `"none"`. When the engine supports capture the button downloads a PNG on click;
 * otherwise it is rendered DISABLED with the unavailability message as its tooltip.
 * Called by each adapter's `addToolbar` (it owns `snapshot`/`snapshotSupported`).
 */
export function snapshotToolbarItem(
  level: SnapshotLevel,
  cap: { supported: boolean; reason?: string; snapshot: (opts?: SnapshotOptions) => Promise<Blob> },
): ToolbarItem | null {
  if (level === "none") return null;
  const scale = snapshotScale(level);
  return {
    id: "snapshot",
    label: "📷",
    svg: SNAPSHOT_ICON_SVG,
    title: cap.supported ? "Capture map" : (cap.reason ?? "Snapshot is not supported on this engine"),
    ...(cap.supported ? {} : { disabled: true }),
    onClick: cap.supported
      ? () => { cap.snapshot({ scale }).then((b) => downloadPng(b)).catch(() => { /* capture failed → no download */ }); }
      : () => { /* disabled: no-op */ },
  };
}
