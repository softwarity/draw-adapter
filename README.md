# @softwarity/draw-adapter

[![npm](https://img.shields.io/npm/v/@softwarity/draw-adapter.svg)](https://www.npmjs.com/package/@softwarity/draw-adapter)
[![CI](https://github.com/softwarity/draw-adapter/actions/workflows/main.yml/badge.svg)](https://github.com/softwarity/draw-adapter/actions/workflows/main.yml)
[![license](https://img.shields.io/npm/l/@softwarity/draw-adapter.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/@softwarity/draw-adapter.svg)](./dist/index.d.ts)

Headless, **generic** map adapter for the @softwarity drawing libs
(`sigmet-draw`, `sigwx-draw`, …). It *grafts* a drawing onto a host-owned map
(à la Terra Draw): the host owns the basemap, controls, projection and zoom; the
adapter only adds the drawing overlays, reports pointer events in lon/lat,
registers a glyph sprite atlas and optionally renders a native toolbar.

One set of engine implementations — **MapLibre GL**, **OpenLayers**, **Leaflet** —
shared by every product. The adapter knows **no domain type**: it is driven by a
declarative `LayerSpec[]` manifest and reads a fixed set of *render props* off each
feature. Each product's controller resolves its domain style into those props

> **Why this exists.** Two drawing libs (`sigmet-draw`, `sigwx-draw`) each shipped
> their own MapLibre + OpenLayers adapters — 4 near-twin implementations, soon 6
> with Leaflet, where every fix had to be re-applied everywhere. This package is
> the single, canonical map layer they both graft onto.

## Used by

| Library | What it draws | Repo · demo |
|---------|---------------|-------------|
| [`@softwarity/sigmet-draw`](https://github.com/softwarity/sigmet-draw) | SIGMET/AIRMET geometries ↔ ICAO TAC | [repo](https://github.com/softwarity/sigmet-draw) · [demo](https://softwarity.github.io/sigmet-draw/) |
| [`@softwarity/sigwx-draw`](https://github.com/softwarity/sigwx-draw) | SIGWX significant-weather charts | [repo](https://github.com/softwarity/sigwx-draw) · [demo](https://softwarity.github.io/sigwx-draw/) |

## Engine support

| Capability | MapLibre GL | OpenLayers | Leaflet |
|------------|:----------:|:----------:|:-------:|
| fill / line / circle / symbol / text | ✅ | ✅ | ✅ |
| data-driven props (identical render) | ✅ | ✅ | ✅ |
| rotatable handle glyphs (`icon` / `symbol` + `iconRotate`) | ✅¹ | ✅ | ✅ |
| native text box (`textBackground`/`textBorder`) | halo only | ✅ | ✅ |
| `project`/`unproject`/`onViewChange`/`getViewSpan` | ✅ | ✅ | ✅ |
| drag-vs-pan guard | n/a² | ✅ (capture-phase) | ✅ (capture-phase) |
| keyboard `onKey` (focused-map keydown) | ✅ | ✅ | ✅ |
| lock map (`setInteractive` / toolbar lock button) | ✅ | ✅ | ✅ |
| PNG `snapshot()` (basemap + overlays) | ✅ | ✅ | ❌³ |
| peer dependency | `maplibre-gl >=5` | `ol >=9` | `leaflet >=1.9` |

¹ data-URI icons are materialized lazily via `styleimagemissing`; sprites are tinted per `symbolColor`.
² MapLibre's `dragPan` is toggled directly by the controller, no capture-phase hack needed.
³ Leaflet has no single exportable canvas (tiles are `<img>`, overlays SVG/DOM); `snapshot()` rejects and the toolbar button is shown **disabled**. A DOM-snapshot approach is planned.
*before* `setOverlay`, so styling is entirely **data-driven** and the three engines
render identically.

## Install

```bash
npm i @softwarity/draw-adapter
# plus the engine(s) you use (optional peer deps):
npm i maplibre-gl        # or: ol  | leaflet
```

Sub-path exports keep the engines isolated — importing `./openlayers` never pulls
in MapLibre or Leaflet:

```ts
import type { MapAdapter, LayerSpec } from "@softwarity/draw-adapter";
import { MapLibreAdapter, createMapLibreMap } from "@softwarity/draw-adapter/maplibre";
import { OpenLayersAdapter } from "@softwarity/draw-adapter/openlayers";
import { LeafletAdapter } from "@softwarity/draw-adapter/leaflet";
import { FakeAdapter } from "@softwarity/draw-adapter/testing"; // unit tests
```

## Usage

```ts
const LAYERS: LayerSpec[] = [
  { id: "area",    kind: "fill" },
  { id: "guide",   kind: "line" },
  { id: "symbols", kind: "symbol" },
  { id: "label",   kind: "text" },
  { id: "handles", kind: "circle" },
];
const HIT = new Set(["handles", "guide", "area"]);

const map = createMapLibreMap({ container: "map", center: [2.3, 48.8], zoom: 5 });
const adapter = new MapLibreAdapter({ map, layers: LAYERS, hitOverlays: HIT });

await adapter.ready();
adapter.onPointer((ev) => { /* controller orchestrates here */ });

// push a FeatureCollection whose features already carry their render props:
adapter.setOverlay("area", {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: poly, properties: { fillColor: "#58a6ff", fillOpacity: 0.2 } }],
});
```

All three adapters take the same options: `{ map, layers, hitOverlays?, spritePx?, defaultSymbolColor? }`.

## Feature render-prop contract

The adapter reads only these props, picked by the layer's `kind`. **Bake them on
the features** in your controller (resolving your domain style) — there is no
`setStyle(DomainStyle)`.

| `kind`   | props read on each feature |
|----------|----------------------------|
| `fill`   | `fillColor`, `fillOpacity`, `stroke?`, `strokeWidth?`, `strokeOpacity?` |
| `line`   | `stroke`, `strokeWidth`, `dash?` (`number[]`), `strokeOpacity?` |
| `symbol` | `symbol` (sprite id), `size?` (×spritePx), `rotation?` (deg, cw), `symbolColor?` |
| `text`   | `text`, `textColor`, `textSize`, `textHalo?`, `textBackground?`, `textBorder?`, `maxWidth?`, `rotation?` |
| `circle` | `role?`, `control?`, `collinear?`, `fill?`, `stroke?`, `radius?`, `strokeWidth?`, `icon?` (data-URI), `symbol?` (sprite id), `iconRotate?` (deg, cw), `symbolColor?` |

Cross-cutting conventions:

- **`role`** — present on any draggable handle/guide; names what the drag targets
  (`"center"`, `"radius"`, `"v0"`, `"lon"`, …). Drives `cursorForHit` and the
  drag-vs-pan guard.
- **`featureId`** — on hit-testable features, so a click resolves to a domain object.
- **`control: true`** / **`collinear: true`** — style hints you bake into the
  other props (the adapter does not special-case them beyond the cursor).
- **rotation** (`rotation` / `iconRotate`) is **degrees, clockwise**, identical on
  all three engines.

### Notes per engine

- A `line` overlay may also contain `Polygon` features (e.g. wind-barb saw teeth):
  they are filled with `fillColor` (falling back to `stroke`).
- A `fill` overlay draws an outline only when a feature carries `stroke`.
- Rotatable handle glyphs (`icon` data-URI **or** `symbol` sprite) render over the
  dot on a `circle` overlay. On MapLibre, data-URIs are materialized lazily via
  `styleimagemissing`; sprites are tinted per `symbolColor`.
- Text boxes (`textBackground`/`textBorder`) are native on OpenLayers/Leaflet;
  MapLibre renders haloed text only (no native box).

## Sprites

Provide an atlas of inline SVGs (stroke/fill using the `currentColor` token, which
the adapters re-tint per `symbolColor`):

```ts
await adapter.registerSymbols({ MOD: "<svg …>currentColor…</svg>" });
```

The default atlas and default ink stay in **your** product (they are domain). The
lib exports the plumbing: `colorizeSprite`, `svgToDataUrl`, `loadSpriteImage`,
`SPRITE_PX`.

## Local development against the sibling libs

`sigmet-draw` / `sigwx-draw` resolve this package via **TypeScript `paths`** (config
only — no link/copy scripts). Each repo's `tsconfig` points the bare specifier at the
sibling `dist`, with the published npm package as a fallback:

```jsonc
// sigmet-draw/tsconfig.json
"paths": {
  "@softwarity/draw-adapter":            ["../draw-adapter/dist/index", "./node_modules/@softwarity/draw-adapter/dist/index"],
  "@softwarity/draw-adapter/maplibre":   ["../draw-adapter/dist/maplibre", "./node_modules/@softwarity/draw-adapter/dist/maplibre"]
  // …same for /openlayers /leaflet
}
```

So a build compiles against the **local** `dist` if the sibling is present, else the
published version. Just build the lib at least once (`npm run build`); `npm run
build:watch` (`tsc -w`) gives instant rebuilds, which the consumer's dev server picks up.

> **Single engine copy matters.** A demo that bundles a consumer from a path *outside its
> own `node_modules`* can duplicate the engine peer (especially **Leaflet** / **OpenLayers**),
> and two copies break cross-instance checks (Leaflet won't draw the other copy's paths →
> handles vanish; OpenLayers' `instanceof DragPan` fails → handle-drag pans the map). The
> demos force `leaflet`/`ol`/`maplibre-gl` to resolve from their own `node_modules` via
> `tsconfig` `paths`, so each engine collapses to a single copy.

### Packaging / Node ESM

The published output is real Node ESM and is verified per sub-path in CI
(`npm run test:esm`). Two things bundlers silently paper over but Node does not,
both handled here: `ol/*` value imports end in `.js` (ol ships no `exports` map),
and `maplibre-gl` (CJS-only) is imported as a namespace with a runtime ctor
resolve rather than `import { Map }`. The peer-free entry (`.`) never imports an
engine, so optional peer deps stay optional.

## Toolbar

`addToolbar(items, options?)` renders a toolbar inside the engine's native control box
and returns the element. You supply the **items**; the adapter owns the **rendering,
placement and click wiring** (it knows no action — each item's `onClick` is yours).

```ts
adapter.addToolbar(
  [{ id: "circle", title: "Circle", svg: "<svg…>", toggle: true, onClick: () => draw.circle() }],
  { position: "top-left" }, // 12 anchors (flow derived from the edge) + padding / gap / className / tools / clear / lock / snapshot
);
```

A `ToolbarItem` is `{ id, title, svg?, toggle?, standalone?, disabled?, onClick?, children?, onRender? }`
(a missing `svg` falls back to a neutral icon; `toggle` keeps the button `active`;
`standalone` marks a utility button whose click doesn't change the tool selection).

### Built-in buttons

The adapter appends its own **chrome** buttons at the end of the bar (they're
`standalone`, so clicking them never deselects your active tool):

- **Lock map** — a padlock toggle that freezes pan/zoom/rotate so the map can't move
  while drawing (default on; `lock: false` hides it). It's `setInteractive(false)`
  under the hood, and the lock **wins** over the controller's transient `setPanEnabled`
  until you unlock.
- **Snapshot** — the PNG capture button (see [Snapshots](#snapshots-png)).

### Submenus (flyouts)

Give an item `children: ToolbarItem[]` and its button becomes a **flyout**. It opens on
**hover** (desktop) and on click (touch / when closed), **into the map** — derived from the
toolbar edge (`top ⇒ below`, `bottom ⇒ above`, `left ⇒ right`, `right ⇒ left`) so it's never
clipped. An outside press closes it. There are two modes:

**Click** (default) — the parent is a fixed category; picking a child runs its `onClick`,
and a click on the (open) parent runs the parent's own optional `onClick`:

```ts
{ id: "shapes", title: "Shapes", svg: SHAPES_ICON, children: [
  { id: "rect",   title: "Rectangle", svg: RECT_ICON,   onClick: () => draw.rect() },
  { id: "circle", title: "Circle",    svg: CIRCLE_ICON, onClick: () => draw.circle() },
]}
```

**Toggle** (`toggle: true`, a split button) — the parent mirrors the **selected** child
(the first one initially) and becomes the active tool; picking a child runs it and makes the
parent adopt its icon; clicking the (open) parent re-runs the selected child:

```ts
{ id: "text", title: "Text", toggle: true, children: [
  { id: "label", title: "Label", svg: LABEL_ICON, onClick: () => draw.label() },
  { id: "box",   title: "Box",   svg: BOX_ICON,   onClick: () => draw.box() },
]}
```

## Snapshots (PNG)

Capture the current map — basemap **and** overlays — as a PNG `Blob`. The capture
always returns the Blob; `target` optionally **delivers** it too:

```ts
const blob = await adapter.snapshot();                          // just the Blob ("as on screen")
await adapter.snapshot({ scale: 3 });                           // supersample (best-effort)
await adapter.snapshot({ target: "download", filename: "x.png" }); // capture + download the file
await adapter.snapshot({ target: "clipboard" });               // capture + copy to clipboard
await adapter.snapshot({ hideOverlays: ["handles", "edge"] }); // clean drawing, no editing chrome
```

- Always resolves to an `image/png` Blob. `scale` is the output **pixel-ratio**
  (device px per CSS px); it defaults to `window.devicePixelRatio`.
- `target` (`"blob"` default · `"download"` · `"clipboard"`) is what `snapshot()`
  does with the PNG — the Blob is returned in every case.
- `hideOverlays` lists overlay ids to hide **just for this capture** (e.g. editing
  handles/guides) and restore after — so the snapshot shows the clean drawing without
  the construction chrome. (Toolbar: `snapshot: { hideOverlays: [...] }`.)
- Capture happens **inside the engine's render frame**, so the host map needs **no
  special flag** (in particular, no `preserveDrawingBuffer` on the MapLibre/WebGL map).
- **Leaflet is not supported yet** — `snapshot()` rejects (tiles are `<img>` and
  overlays are SVG/DOM, so there is no single exportable canvas). A DOM-snapshot
  approach is planned.
- `scale > 1` (`medium`/`high`) is **supersampling, best-effort**: it re-scales the
  captured composition, which enlarges but does not add real map detail.
- **Clipboard** uses the async Clipboard API — it needs a **secure context**
  (HTTPS/localhost), a user gesture, and only `image/png` is broadly supported.

### Toolbar button — one button, two deliveries

`addToolbar` adds a single camera button. It always offers **both** deliveries: a
plain click runs `onClick` (default `"download"`); a **modifier-click** (Ctrl on
PC/Linux, ⌘ on Mac) runs the other one.

```ts
adapter.addToolbar(tools);                            // defaults: click → download, ⌘/Ctrl-click → copy
adapter.addToolbar(tools, { snapshot: { quality: "high", onClick: "clipboard" } }); // swapped
adapter.addToolbar(tools, { snapshot: "none" });     // hide it (also: null / false)
```

The `snapshot` option:

- **omitted / `undefined`** ⇒ button with **defaults** (`quality: "native"`, `onClick: "download"`),
- **`null` / `false` / `"none"`** ⇒ no button,
- **`{ quality?, onClick? }`** ⇒ configured button.

| `quality` | output pixel-ratio | notes |
|--------|--------------------|-------|
| `low` | `1` | CSS-pixel resolution |
| `native` *(default)* | `window.devicePixelRatio` | capture as on screen |
| `medium` / `high` | `2` / `3` | supersample (best-effort) |

`onClick` (`"download"` | `"clipboard"`) just picks which delivery is on the plain
click; the other is always one modifier-click away. The button's tooltip is **fixed
per mode** and spells both out — e.g. *"Snapshot: click to file — ⌘+click to
clipboard"* (or, in clipboard mode, *"…click to clipboard — ⌘+click to file"*). While
you hover, holding the modifier **live-swaps the icon** (not the tooltip) to preview
which delivery a click will trigger. (The key listeners exist only for the hover's
duration, so there is no global event churn.)

A successful capture plays a brief **curtain shutter** over the map — two translucent
blades close to the centre and reopen (the map stays faintly visible). It's visual
feedback that doubles as the *"copied"* confirmation for the otherwise-silent clipboard
delivery. Turn it off with `snapshot: { shutter: false }` (default `true`). It honours
`prefers-reduced-motion` (degrades to a single quick dim) and is exported as
`shutterFlash(container, { durationMs? })` for manual use.

The button icon is a camera; the two deliveries differ only by the **lens** — filled
for download, an empty ring for clipboard — and the hover preview swaps between them.

On the **Leaflet** adapter the button is rendered **disabled**, with the
unavailability message as its tooltip. Exported helpers: `snapshotScale(quality)`
(preset→ratio), `downloadPng(blob, name?)`, `copyPng(blob)`, `shutterFlash(el)`.

## Keyboard (`onKey`)

`onKey(cb)` forwards a normalized `KeyEvent` on **keydown while the map is focused**.
It is a **raw transport** — the adapter has **no** domain semantics; the *consumer*
maps keys to actions. The canonical example: `Delete`/`Backspace` ⇒ remove the
selected shape.

```ts
adapter.onKey((e) => {
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    controller.deleteSelected(); // domain action lives in the consumer
  }
});
```

The `KeyEvent` carries `key`, `code`, `ctrl`, `meta`, `shift`, `alt`, and
`preventDefault()` — the last forwards to the native event (e.g. to stop `Backspace`
from navigating back).

- **Scoping / focus.** The listener is attached to the **map container** (not
  `window`), so only the *focused* map reacts — this is multi-instance safe. The
  container is made click-focusable (`tabindex="-1"` if it has none); a keydown then
  bubbles up from the engine's focused canvas. The map gets focus naturally when the
  user clicks/draws on it.
- **Editable-target filtering.** Keydowns whose target is an `input` / `textarea` /
  `select` / `contenteditable` are skipped, so typing into the host app's form fields
  never triggers a map shortcut — the key benefit of centralizing this here.
- **Lifecycle.** The listener is removed in `destroy()`.

All three engines implement it — listening on the MapLibre `getContainer()`,
OpenLayers `getViewport()`, Leaflet `getContainer()`. The exported helper
`bindKeyListener(container, cb)` does the same for manual use and returns a teardown
function. `FakeAdapter` (`./testing`) supports it too, with a `.key("Backspace",
{ meta: true })` replay helper for unit tests.

## API surface

`MapAdapter` — `ready`, `registerSymbols`, `setOverlay`, `snapshot`, `setTooltip`,
`addToolbar`, `getCenter`, `getViewSpan`, `project`, `unproject`, `onViewChange`,
`setPanEnabled`, `setDoubleClickZoom`, `setInteractive`, `setCursor`, `onPointer`,
`onKey`, `destroy`.
`onKey` is documented above; `bindKeyListener(container, cb)` is exported for manual use.

A product simply never calls the methods it doesn't need (sigmet ignores
`project`/`unproject`/`onViewChange`/`registerSymbols`).

## License

MIT
