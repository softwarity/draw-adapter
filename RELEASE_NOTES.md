# Release Notes

## 0.2.9

---

## 0.2.8

- **Add:** per-feature **label box** controls on `text` features — `textBoxSize`
  (`small`/`medium`/`large`, default `medium`) for padding and `textBoxRadius`
  (`none`(default)/`small`/`medium`/`round`) for corners, on top of `textBackground` /
  `textBorder`. The box is drawn **only** when a fill and/or border is set, and **rotates
  with the text**. New exported types `TextBoxSize` / `TextBoxRadius`.
- **Fix/Add (MapLibre):** the label box is now a **per-feature** 9-slice image built on
  demand (`styleimagemissing`) from the feature's `textBackground`/`textBorder`/
  `textBoxSize`/`textBoxRadius` — so MapLibre finally honours per-feature box **colours**,
  padding and **corner radius** (it previously drew one fixed white/black box).
- **Limitation:** OpenLayers honours `textBoxSize` and the colours but **not**
  `textBoxRadius` — its native text background is a rectangle (no corner radius).

---

## 0.2.7

- **Add:** `MapAdapter.onKey(cb)` — forwards a normalized `KeyEvent` on keydown while the map is focused (scoped to the container, multi-instance safe; editable targets skipped). Raw transport — the consumer maps keys to actions (e.g. Delete/Backspace ⇒ remove selection). Implemented on all 3 engines + `FakeAdapter` (`.key()` helper); `bindKeyListener` exported.
- **Add:** toolbar **submenus** — a `ToolbarItem` with `children: ToolbarItem[]` becomes a flyout that opens on **hover** (desktop) and click (touch), *into the map* based on the toolbar edge (top ⇒ below · bottom ⇒ above · left ⇒ right · right ⇒ left). Two modes: **click** (parent = fixed category; a child runs its `onClick`) and **toggle** (`toggle: true`, a split button — the parent mirrors the selected child, becomes the active tool, and a parent click re-runs it). An outside press closes the flyout. `ToolbarItem.onClick` is now optional.
- **Add:** built-in **"lock map"** toggle at the end of the bar (default on; `ToolbarOptions.lock: false` hides it) — freezes pan/zoom/rotate on all 3 engines so the map can't move while drawing. New `MapAdapter.setInteractive(enabled)`: while locked it **wins** over the controller's transient `setPanEnabled`/`setDoubleClickZoom` (remembered and re-applied on unlock). New `ToolbarItem.standalone` (a utility button whose click doesn't change the active tool selection — also set on the snapshot button now).
- **Breaking:** removed `ToolbarOptions.orientation` — the bar's flow is now **derived from `position`** (top/bottom edge ⇒ horizontal row, left/right edge ⇒ vertical column), and the submenu flyout follows it (column vs row). Consumers must drop any `orientation` they passed.
- **Fix:** OpenLayers toolbar now renders as a solid white bar with plain buttons (OL's default `.ol-control` buttons were blue/translucent, so the bar looked like loose buttons).

---

## 0.2.6

- **Fix:** double-click editing (insert a shape vertex / split a break point) now works on **OpenLayers and Leaflet** — previously only MapLibre did. The capture-phase press handler that stops the map pan on a draggable hit was also suppressing the engine's *synthesized* `dblclick`, so it never reached the controller. OpenLayers now listens to the **native** viewport `dblclick` (its handles are canvas, so it fires reliably); Leaflet **detects the double-click manually** from press timing + position (its handle markers are recreated on every re-render, so the two clicks land on different DOM nodes and no native `dblclick` is emitted at all).
- **Add:** MapLibre **call-out boxes** — a 9-slice `icon-text-fit` background box drawn behind any label that carries `textBackground`, for parity with the native `backgroundFill` boxes on OpenLayers/Leaflet.
- **Change:** call-out box padding increased on OpenLayers and Leaflet; sprite glyphs in Leaflet `divIcon`s now scale to (and centre within) the icon box instead of sitting at their intrinsic size; Leaflet multi-line labels honour `\n` (`white-space: pre-line`).

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
