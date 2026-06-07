# Release Notes

## 0.2.6

---

## 0.2.5

- **Fix:** clipboard copy now works — the write is issued synchronously within the click (the capture promise is fed to `ClipboardItem`), instead of after the capture `await` where Safari/Chrome silently reject it (lost user gesture).
- Snapshot tooltip is now fixed per mode (e.g. *"Snapshot: click to file — ⌘+click to clipboard"*).

---

## 0.2.4

- `snapshot()` gains `hideOverlays?: string[]` — overlay ids to hide **only for the
  capture** (e.g. editing handles/guides), restored after, so the snapshot shows the
  clean drawing without the construction chrome. Also on the toolbar config
  (`snapshot: { hideOverlays: [...] }`).
- Removed the `basemap` snapshot option: hiding only the tiles can't be done cleanly in
  a generic, domain-free way (the host map's basemap vs. domain layers like FIR are
  indistinguishable, and the GL canvas isn't guaranteed transparent).

---

## 0.2.3

Adds a **curtain shutter effect** as capture feedback, plus clearer icons.

- A successful snapshot from the toolbar plays a brief shutter animation over the map —
  two translucent blades close to the centre and reopen (the map stays faintly visible) —
  visual confirmation that doubles as the *"copied"* feedback for the otherwise-silent
  clipboard delivery. Opt out with `snapshot: { shutter: false }` (default `true`).
- Honours `prefers-reduced-motion` (degrades to a single quick dim); the overlay is
  `pointer-events:none` and self-removes. The flash plays **only on success**.
- The snapshot button icon is a camera; the two deliveries differ only by the **lens** —
  filled for download (`SNAPSHOT_ICON_SVG`), an empty ring for clipboard
  (`SNAPSHOT_CLIPBOARD_ICON`) — and the hover preview swaps between them.
- New export `shutterFlash(container, { durationMs? })` for manual use.

---

## 0.2.2

Tidies the snapshot **toolbar option** — single object form, clearer naming.

- `ToolbarOptions.snapshot` is now `"none" | false | null | { quality?, onClick? }`
  (no more bare-preset string form). **`undefined` ⇒ defaults** (a button); any
  explicit falsy value (`null` / `false` / `"none"`) **hides** it.
- Renamed the size field `state` → **`quality`**, and the type `SnapshotLevel` →
  **`SnapshotQuality`** (`"native" | "low" | "medium" | "high"` — `"none"` moved out
  to the option's union, where it belongs).
- The toolbar button **live-previews the delivery while hovered**: holding the modifier
  key swaps its icon to the alternate action (the tooltip is fixed — see 0.2.5). Key
  listeners are scoped to the hover only (no global churn). New `ToolbarItem.onRender`
  hook + exported `SNAPSHOT_CLIPBOARD_ICON`.

---

## 0.2.1

Snapshot can now **download or copy to clipboard** — additive, non-breaking.

- `snapshot()` gains `target` (`"blob"` default · `"download"` · `"clipboard"`) and
  `filename`: it captures, optionally **delivers** the PNG, and always returns the Blob.
- Toolbar: one camera button now offers **both** deliveries. `ToolbarOptions.snapshot`
  accepts `{ state, onClick }` — `onClick` (`"download"` | `"clipboard"`, default
  `"download"`) is the plain-click delivery; the **other** runs on a modifier-click
  (Ctrl on PC/Linux, ⌘ on Mac). The string form (`snapshot: "high"`) still works.
- Clipboard uses the async Clipboard API (needs a secure context — HTTPS/localhost;
  the click is the required user gesture).
- New export `copyPng(blob)`; new `SnapshotTarget` / `SnapshotDelivery` types;
  `ToolbarItem.onClick` now receives the `MouseEvent` (for modifier keys).

---

## 0.2.0

Adds **PNG map snapshots** (basemap + overlays) — additive, non-breaking.

- `MapAdapter.snapshot(opts?: SnapshotOptions): Promise<Blob>` — always resolves to
  an `image/png` Blob. `scale` (output pixel-ratio) defaults to
  `window.devicePixelRatio`, i.e. captures "as on screen".
- **MapLibre** and **OpenLayers** are supported. Capture happens *inside the engine's
  render frame*, so the host map needs **no special flag** (no `preserveDrawingBuffer`).
- **Leaflet is not supported yet**: `snapshot()` rejects (tiles are `<img>`, overlays
  are SVG/DOM — no single exportable canvas). A DOM-snapshot approach is planned.
- Toolbar: new `ToolbarOptions.snapshot` preset — `"none" | "low" | "native" | "medium"
  | "high"` (default `"native"`). When set, `addToolbar` adds a camera button wired to
  download a PNG; on Leaflet the button is shown but **disabled** (the reason is its
  tooltip). Preset → output pixel-ratio via the exported `snapshotScale()`:
  `low → 1`, `native → devicePixelRatio`, `medium → 2`, `high → 3`. `medium`/`high`
  are supersampling — best-effort (a re-scale, not extra map detail).
- New exports: `snapshotScale`, `downloadPng`, `SNAPSHOT_ICON_SVG`, and the
  `SnapshotOptions` / `SnapshotLevel` types. `ToolbarItem` gains an optional `disabled`.

---

## 0.1.0

First release. Extracts the generic, data-driven map adapter from `sigwx-draw`
(the v2 design) into a standalone package shared by every @softwarity drawing lib.

- Generic `MapAdapter` interface — zero domain types; driven by a declarative
  `LayerSpec[]` manifest and a fixed feature render-prop contract.
- Three engine adapters: **MapLibre GL**, **OpenLayers**, **Leaflet** (new),
  rendering identically from the same baked feature props.
- Shared utilities: sprite atlas (`colorizeSprite`/`svgToDataUrl`/`loadSpriteImage`),
  toolbar (`populateToolbar`/`applyToolbarLayout`), tooltip (`applyTooltipStyle`),
  prop coercions (`rgba`/`num`/`str`/`deg2rad`/`wrapLabel`), `cursorForHit`.
- `FakeAdapter` (`./testing`) for unit-testing controllers without a map.
- Sub-path exports (`.`, `./maplibre`, `./openlayers`, `./leaflet`, `./testing`)
  with optional peer deps, so a consumer only pulls the engine(s) it uses.
- Carefully ported fixes: OpenLayers DragPan capture-phase guard + top-of-stack
  hit-testing; MapLibre lazy sprite/`data:` icon materialization + full teardown;
  homogeneous clockwise-degree icon rotation across all three engines.

---
