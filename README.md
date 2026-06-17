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
*before* `setOverlay`, so styling is entirely **data-driven** and the three engines
render identically.

> **Why this exists.** `sigmet-draw` and `sigwx-draw` used to each ship their own
> MapLibre + OpenLayers adapters — near-twin implementations where every fix had to be
> re-applied in each. This package replaces all of that: **all three engines (MapLibre,
> OpenLayers, Leaflet) are implemented here, once** — a single, canonical map layer both
> products graft onto.

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
| label box (`textBackground`/`textBorder` + `textBoxSize`/`textBoxRadius`) | ✅⁴ | ✅ (no radius) | ✅ |
| `project`/`unproject`/`onViewChange`/`getViewSpan` | ✅ | ✅ | ✅ |
| drag-vs-pan guard | n/a² | ✅ (capture-phase) | ✅ (capture-phase) |
| keyboard `onKey` (focused-map keydown) | ✅ | ✅ | ✅ |
| lock map (`setInteractive` / toolbar lock button) | ✅ | ✅ | ✅ |
| PNG `snapshot()` (basemap + overlays + widget cards⁵) | ✅ | ✅ | ❌³ |
| anchored **marker widgets** (`setWidgets` — editable cards) | ✅ | ✅ | ✅ |
| camera read/drive + container (`getBounds`/`getZoom`/`fitBounds`/`getContainer`) | ✅ | ✅ | ✅ |
| area framing (`viewArea`, dateline-aware) · dashed frame (`highlightArea`) | ✅ | ✅ | ✅ |
| live **reprojection** (`setProjection({kind:"proj4"})`) | ❌⁷ | ✅ | ❌⁷ |
| overlay visibility (`setOverlayVisible`) · right-click (`contextmenu`) · window-blur (`onBlur`) | ✅ | ✅ | ✅ |
| touch: tap-to-select & edit widgets | ✅ | ✅ | ✅ |
| touch: freehand **drawing** (drag to draw) | ❌⁶ | ✅ | ❌⁶ |
| peer dependency | `maplibre-gl >=5` | `ol >=9` (+ `proj4 >=2.8`, optional⁷) | `leaflet >=1.9` |

¹ data-URI icons are materialized lazily via `styleimagemissing`; sprites are tinted per `symbolColor`.
² MapLibre's `dragPan` is toggled directly by the controller, no capture-phase hack needed.
³ Leaflet has no single exportable canvas (tiles are `<img>`, overlays SVG/DOM); `snapshot()` rejects and the toolbar button is shown **disabled**. A DOM-snapshot approach is planned.
⁴ MapLibre fakes the box with a per-feature 9-slice image (built on demand via `styleimagemissing`), so it honours `textBackground`/`textBorder`/`textBoxSize`/`textBoxRadius` per feature. OpenLayers uses its native text background — same, **except** `textBoxRadius` (its box is a rectangle).
⁵ The PNG composites the [marker widgets](#marker-widgets) in their static form (inputs → their value) on MapLibre/OpenLayers, with a **safe fallback** to a card-less snapshot if the `foreignObject` rasterization taints the canvas (e.g. Safari). Leaflet snapshot is unsupported, so its widgets aren't captured yet.
⁶ MapLibre/Leaflet pointer handlers are mouse-based: a finger **tap** still selects (a deduped native-click fallback) and **widgets are touch-capable** (Pointer Events), but **dragging to draw** a shape doesn't fire. OpenLayers uses Pointer Events, so freehand drawing works there; full touch on ML/Leaflet (unify on Pointer Events) is a planned chantier.
⁷ Only OpenLayers reprojects (needs the optional `proj4` peer). MapLibre stays Mercator/globe and Leaflet stays lat/lng-native — a `{kind:"proj4"}` spec there is a no-op (one console warning). `viewArea`/`highlightArea` still work in Mercator on all three.

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
| `text`   | `text`, `textColor`, `textSize`, `textHalo?`, `textBackground?`, `textBorder?`, `textBorderWidth?`, `textBoxSize?`, `textBoxRadius?`, `maxWidth?`, `rotation?` |
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
- A **label box** is drawn behind a `text` feature **only** when it carries
  `textBackground` (fill) and/or `textBorder` (outline). `textBoxSize`
  (`small`/`medium`/`large`, default `medium`) tunes its padding, `textBorderWidth`
  (`small`/`medium`/`large`, default `medium` ≈ 1.4px) the **border width**, and `textBoxRadius`
  (`none`(default)/`small`/`medium`/`round`) its corners; the box rotates with the text.
  Leaflet (CSS) and MapLibre (a per-feature 9-slice image) honour all of them; OpenLayers
  honours them too **except** `textBoxRadius` (its native text background is a rectangle).

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
(a missing `svg` falls back to a neutral icon; `toggle` makes a split-button that mirrors its picked
child's icon; `standalone` marks a utility button).

### Active-tool highlight (consumer-driven)

The bar **doesn't** highlight a tool on click. The consumer drives it: call `adapter.setActiveTool(id)`
when a tool's mode starts and `adapter.setActiveTool(null)` when it ends (commit / Escape / cancel) —
so utility buttons (clear / snapshot) never stay lit and the highlight tracks your drawing lifecycle.
`id` is a `ToolbarItem` id (a submenu/toggle child highlights its parent **bar trigger**); one tool is
active at a time. Identical on all three engines. Style it via `ToolbarOptions.activeStyle`
(`{ background?, color?, outline?, boxShadow? }`, default `{ background: "#dbeafe" }`):

```ts
adapter.addToolbar(tools, { activeStyle: { background: "#ffedd5", outline: "2px solid #e8731a" } });
adapter.setActiveTool("cb");   // CB button lit
adapter.setActiveTool(null);   // cleared
```

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

**Nested** — a child can itself have `children`, becoming a **sub-submenu**. Each level opens on
the **flipped axis**, so the menus zig-zag (with a top/bottom bar: `bar (horizontal) → submenu
(vertical) → sub-submenu (horizontal) → …`); a nested trigger shows a chevron pointing the way
its flyout opens. Hover-bridging, click/touch open, sibling auto-collapse and outside-press close
all work at every depth — picking any leaf collapses the whole cascade. Nesting is unlimited in
code, but **two levels deep** is the practical UX limit:

```ts
{ id: "shapes", title: "Shapes", svg: SHAPES_ICON, children: [
  { id: "rect",   title: "Rectangle", svg: RECT_ICON, onClick: () => draw.rect() },
  { id: "curves", title: "Curves", svg: CURVES_ICON, children: [   // ← sub-submenu
    { id: "bezier", title: "Bézier", svg: BEZIER_ICON, onClick: () => draw.bezier() },
    { id: "arc",    title: "Arc",    svg: ARC_ICON,    onClick: () => draw.arc() },
  ]},
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
- **Marker widgets** are composited into the PNG in their static (non-editable) form
  on MapLibre/OpenLayers — see [Marker widgets](#marker-widgets). The card-less blob is
  produced first, so if the DOM→bitmap step taints the canvas (e.g. Safari) the snapshot
  **degrades** to the card-less image rather than failing.
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

## Marker widgets

Anchored, inline-editable **DOM cards** pinned at a `lon/lat` — a generic, domain-free
primitive for things like a named tropical-cyclone / volcano / spot marker whose name the
forecaster types **in place** while the lon/lat auto-fills from the marker's position.
(This needs a real `<input>` — caret, selection, IME, paste, mobile keyboard — which the
rendered `text` features can't provide; only the adapter can place DOM on the map.)

```ts
adapter.setWidgets([{
  id: "v1", anchor: { lon: 3, lat: 46 }, origin: "bottom",
  border: "#1f2328", radius: "small", padding: "small", font: { color: "#1f2328", size: 13 },
  child: { dir: "v", align: "center", gap: 1, items: [
    { kind: "glyph", svg: "<svg>…</svg>", size: 24 },
    { kind: "text", value: "ETNA", editable: true, control: "input", autofocus: true },
    { kind: "coord" },
  ] },
}]);
adapter.onWidgetEdit(e => updateName(e.id, e.value));            // { id, value } per keystroke
adapter.setCoordFormat(({ lon, lat }) => formatLatLng(lat, lon)); // formats the `coord` line
```

- **`setWidgets(widgets)`** is declarative and **diffed by `id`** (like `setOverlay`): pass the
  full current set each render. Cards are created / updated **in place** / removed — a focused
  input **keeps its focus and caret** across re-`setWidgets`, so it's safe to re-push every render.
- **Container** (`MarkerWidget`) only *positions* (`anchor` + `origin` — which point of the card
  pins to the anchor, named or a `{x,y}` fraction) and *frames* (`bg`, `border`, `borderWidth`,
  `radius`, `padding`, `font`). It holds exactly one root **box**; `radius`/`padding`/`borderWidth`
  reuse the label-box presets so widgets and label boxes look consistent. **`boxShape`** turns the
  rectangular frame into a contour-following **SVG** outline — `"pentagon-up"`/`"pentagon-down"`
  ("house" shapes) or a custom normalized `number[][]` polygon (points outside `[0,1]` form a
  cap/point and the card grows to reserve it); `"rect"`/absent is the plain CSS box. `font.lineHeight`
  (unitless, default `1.2`) tightens multi-line labels.
- **Boxes** (`{ dir: "v"|"h", align?, gap?, color?, size?, items }`) do layout (vbox/hbox) and may
  set `color`/`size` that **cascade** to descendant text/coord (plain CSS inheritance).
- **Items:** `glyph` (inline SVG, `currentColor`-tintable) · `text` (a static label; an inline
  `<input>` when `editable` — auto-grows, `uppercase` enters/emits upper case; or a
  `control: "picker"` for choosing among `options`, see below) · `coord` (the anchor, formatted by
  `setCoordFormat`, **live**).
- **Selection / move reuse the pointer model:** a click or drag on the card surfaces through
  `onPointer` as a hit `{ overlay: "widget", props: { id } }` (with the real lon/lat), so your
  existing select / drag-to-move logic works unchanged. The card **never** drives map pan/zoom;
  while an input is focused, presses inside it edit (no select/drag/pan).
- **One implementation, all three engines:** the card rides each engine's native anchored-overlay
  primitive (MapLibre `Marker` / OpenLayers `Overlay` / Leaflet `divIcon`), so it tracks per-frame
  through pan/zoom and stays screen-upright. It's wired with Pointer Events, so touch works.
- **Delete:** `deletable: true` (or `{ title }` for a tooltip) shows a bare `×` in the card's **top-right corner**; clicking it
  fires `onWidgetDelete({ id })` — the lib doesn't remove the card, the consumer drops the `id`
  from its next `setWidgets`. It's a **separate element** from the input (so an input-only card
  stays deletable) and isn't drawn into snapshots.
- **Action buttons:** `buttons: [{ event, place?, svg?, bordered?, title?, gap? }]` renders small
  buttons (a `+`, a pen, …) straddling the card's edges/corners; clicking one fires
  `onWidgetAction({ id, event })`.
  `place` is an enum or an array (unioned & deduped):
  - Edge/corner keywords: `top`/`bottom`/`left`/`right` · `top-left`/`top-right`/`bottom-left`/`bottom-right`
    · `edges`/`h-edges`/`v-edges` · `corners`/`top-corners`/`bottom-corners`/`left-corners`/`right-corners`
  - **`"axis-top"` / `"axis-bottom"`** — centres the button on the **gauge track axis** (not the card
    midpoint) and places it at the track's top or bottom end. Robust to label-column width. Intended
    for `+` buttons above/below a vertical `ranges` gauge.
  - **`gap?: number`** (px, default `0`) — pushes the button outward from its reference point. Use
    with `axis-top`/`axis-bottom` to lift the button clear of a maxed-out knob.

  Domain-free: you name the `event` and decide what it does. `FakeAdapter.actionWidget`.
- **Deselect on window blur:** wire `adapter.onBlur(() => deselect())` if you want a marker to stop
  looking editable once the user switches to another window/app. The lib is domain-free — it emits
  the focus-lost **signal**, the consumer owns the selection and decides whether to drop it.
- **Picker control:** a `text` item with `control: "picker"` + `options` lets the user choose a value,
  emitting it via `onWidgetEdit({ id, name, value })`. The presentation is set by `mode` and
  **degrades with the option count** so the control stays usable:
  - `mode: "carousel"` *(default)* — **carousel** for ≤5 options (**click** = next, **shift-click** =
    previous, slide effect, cycles in place); a **flower** for 6–10; a **grid** beyond 10.
  - `mode: "flower"` — a **radial petal menu**: a tap fans the petals out around the control, picking a
    petal makes it the centre and closes the flower (re-tap the centre to re-open); a **grid** beyond 10.
  - `mode: "grid"` — a **grid popover**, always.

  The flower/grid popups are appended to `<body>` (`position:fixed`, JS-placed), so they're never
  clipped and sit above the map; a press outside closes them, and a press *between* petals falls through
  to the map. A **tap also selects the card** and a **press-drag** moves it (the control doubles as a
  drag handle) — it never blocks selecting/dragging. Options are text **or** glyphs —
  `options: ["ISOL","OCNL","FRQ"]` or `[{ value:"a", svg:"<svg…>" }, …]`. Give each control a **`name`**
  so a card with several editable controls knows which one changed. A picker renders **bold** so it
  reads as interactive (vs a static label) without adding width that would shift the value off the
  anchor; give it an **accent `color`** (like the gauge/dial controls) so all editable elements share
  one cue. Each option may carry a **`title`** (its tooltip in the flower/grid + on the trigger; no
  `title` ⇒ no tooltip). An open flower/grid is **keyboard-navigable** — arrows browse, Enter/Space
  picks, Escape closes (the keys never pan the map) — and **closes** when you start dragging the card.
- **Gauge / dial value-editors:** two **node kinds** (not text controls) for on-map value editing.

  **Cursor mode** (default): `{ kind: "gauge", min, max, cursors: [{ name, value, label? }] }` is a
  linear slider: **1–3 cursors that can't cross**, `step` snapping, an optional one-notch `beyond`
  (off-chart "XXX" ⇒ emits `min - step` / `max + step`), a filled span + per-cursor labels.
  When two cursors reach the same value, the central one (middle by index) stays on top and is
  draggable; the duplicate label is hidden (redundant).

  **Multi-range mode**: `{ kind: "gauge", min, max, ranges: [...] }` renders **N independent
  `[base, top]` intervals on ONE shared axis**. Intended for multicouche SIGWX/TEMSI (one FL gauge
  per cloud layer → N ranges per gauge). Each range carries its own `color` for knobs and labels;
  ranges overlap freely — the blend of semi-transparencies signals the common zone. Within a range,
  `base ≤ top` is enforced; between ranges, no clamping. Dragging a knob emits
  `onWidgetEdit({ id, name, value })` per move; dragging the **band** (between the two knobs)
  translates both bounds together (width preserved). The `active` field (range `id` or index) puts
  that range on top (z-index) for tie-break when knobs coincide.
  **Band fill** (`fill?: string`): by default the coloured band uses `color`. Set `fill: ""` for a
  **transparent, borderless band** (CAT turbulence convention) — knobs and labels remain visible.
  Set `fill` to any CSS colour to paint the band differently from `color`. The `knobStroke` gauge
  field controls the knob border colour in ranges mode (default white, `""` → no border).
  **Drag-to-trash (vertical gauges only):** a predominantly horizontal drag (`|dx| > 8 px`,
  `|dx| > |dy|`) on a band reveals a trash icon to the right of the card; releasing past 50 px fires
  `onWidgetAction({ id, event: "removeRange:${idx}:${rangeId}" })`. Releasing before the threshold
  snaps the band back — no event. Disabled when only one range remains.
  **Hover-add** (`canAdd?: boolean`, default `false`): when `canAdd: true`, hovering an **empty span**
  of the axis (a gap between or around bands) shows a transient `+` glyph on the track axis with the
  snapped FL value beside it. Clicking fires
  `onWidgetAction({ id, event: "addLayerAt:<v>" })`. The `+` is suppressed while dragging a knob or
  band, when the cursor is over an occupied band or at `g.max`, and whenever `canAdd` is falsy. Set
  `canAdd: false` (or omit) on gauges that never support add (CB wafs, …); set it `true` on TEMSI
  multicouche gauges, and clear it back to `false` once the layer count reaches `repeat.max`.

  ```ts
  adapter.setWidgets([{
    id: "temsi-layers", anchor: { lon: 10, lat: 48 },
    child: { dir: "v", items: [{
      kind: "gauge", min: 0, max: 450, step: 10, length: 120,
      active: 1,   // render range 1 on top
      ranges: [
        { id: "0", color: "#d1242f",
          base: { name: "layers.0.baseFL", value: 50,  label: "FL050" },
          top:  { name: "layers.0.topFL",  value: 250, label: "FL250" } },
        { id: "1", color: "#0969da",
          base: { name: "layers.1.baseFL", value: 200, label: "FL200" },
          top:  { name: "layers.1.topFL",  value: 400, label: "FL400" } },
      ],
    }] },
  }]);
  adapter.onWidgetEdit(({ id, name, value }) => {
    // name is list-scoped: "layers.0.baseFL", "layers.1.topFL", …
    controller.updateLayer(id, name, Number(value));
  });
  ```

  `{ kind: "dial", name, min, max, value }` is a radial sweep (jet speed; speedometer angle) whose
  **label is a readout that follows the knob** outside the ring (never rotated). It is a **true ring:
  its centre is transparent to pointer events**, so a handle/feature drawn *at* the dial's centre stays
  clickable underneath (a press in the hole falls through); the whole couronne (ring band + knob) grabs
  the value. Dragging streams `onWidgetEdit({ id, name, value })` per move (Pointer Events, never drags the card).
  `length`/`orientation` (gauge), `sweep`/`radius` (dial), and `color` / `labelColor` / `labelHalo` /
  `knobFill` / `knobStroke` style them. The guide is a **thin, well-marked central line** with a
  **wider faint glow on the *selected* part** — the gauge span between cursors (whole line for a
  single cursor; extended a bit past the cursors, never min→max) and the dial arc from its start to
  the value. **Map-ready defaults**: black labels + white halo, knobs in the main colour + white
  border; pass `""` to opt a piece out. **A11y**: knobs are `role="slider"` (`aria-valuemin/max/now`)
  and **arrow keys** step the value by `step` (or 1% of the range); the picker trigger is a focusable
  button (Enter/Space/↓ act, ↑ cycles back).
- `control` is the extension point: **`"input"` and `"picker"` are implemented** (`"gauge"` /
  `"dial"` are their own `WidgetNode` kinds — see above). `FakeAdapter` (`./testing`) records the set
  and adds `.editWidget(id, value, name?)` / `.dragGauge(id, name, value)` / `.deleteWidget(id)` /
  `.actionWidget(id, event)` / `.clickWidget(id)`.

## Camera, container & overlay visibility

Read the view, drive it (sparingly), reach the DOM, and toggle layers — all on the three
engines + `FakeAdapter`:

```ts
adapter.getBounds();        // [west, south, east, north] (lon/lat)
adapter.getZoom();          // engine-native zoom
adapter.getContainer();     // the host map's DOM element (attach a panel, measure…)
adapter.fitBounds([w, s, e, n], { padding: 24 }); // frame the drawing — DRIVES the host camera, use sparingly
adapter.setOverlayVisible("guide", false);        // hide a layer without dropping its data (lossless)
```

(`getCenter()` and `getViewSpan()` — a rough lon/lat span for sizing dropped geometry — are also there.)

**Right-click** surfaces through `onPointer` as `type: "contextmenu"` (the browser menu is
suppressed), carrying the hit + lon/lat — e.g. finish a polygon / delete a vertex. **`onBlur(cb)`**
fires when the map's window loses focus, so the consumer can drop transient UI state (e.g. deselect
— see [Marker widgets](#marker-widgets)).

## Projection & area framing

Frame the camera onto a **fixed chart area** (dateline-aware), optionally switch the live
**projection**, and outline the area with a dashed frame:

```ts
// Switch the live projection. Only OpenLayers actually reprojects.
adapter.setProjection({                      // a polar-stereographic CRS (WAFS polar charts)
  kind: "proj4", code: "EPSG:3995",
  def: "+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
});
adapter.viewArea([-90, 0, 30, 90]);          // frame a lon/lat bbox; padding/duration optional
adapter.viewArea([110, -10, -110, 72]);      // antimeridian-crossing bbox (west > east) → one span
adapter.highlightArea([110, -10, -110, 72], { color: "#666", dash: [6, 4] }); // dashed frame
adapter.highlightArea(null);                 // clear the frame
adapter.setProjection("mercator");           // back to Web Mercator ("globe" is a MapLibre built-in)
```

- **`setProjection(spec)`** — `"mercator"` / `"globe"` / `{ kind: "proj4", code, def }`. **Only the
  OpenLayers adapter reprojects:** a `proj4` spec registers the CRS (needs the optional **`proj4`**
  peer dependency), rebuilds the view in it and re-reads the overlays so handles stay aligned with the
  basemap. MapLibre handles `mercator`/`globe` natively and ignores `proj4` (stays Mercator, warns
  once); Leaflet is lat/lng-native and ignores any non-`mercator` spec (warns once).
- **`viewArea(extent, { padding?, duration? })`** — like `fitBounds` but **antimeridian-aware** (a
  `west > east` bbox is framed as one span, not the whole globe) and **projection-aware** (under a
  non-Mercator OpenLayers view it fits the projected, curved area).
- **`highlightArea(extent | null, style?)`** — a **non-interactive** dashed frame in a dedicated
  overlay above the basemap and below the drawing overlays. The frame is a densified geographic
  polygon, so under a non-Mercator OpenLayers view its edges curve to follow the projection. `null`
  clears it; it never intercepts pointer events.

> `proj4` is an **optional** peer dependency — install it only to use a `{ kind: "proj4" }` projection
> on the OpenLayers adapter (`npm i proj4`). It is never imported otherwise, so Mercator-only and
> MapLibre/Leaflet consumers don't need it.

## API surface

`MapAdapter` — `ready`, `registerSymbols`, `setOverlay`, `setOverlayVisible`, `snapshot`,
`setTooltip`, `addToolbar`, `setActiveTool`, `getCenter`, `getViewSpan`, `getBounds`, `getZoom`, `getContainer`,
`fitBounds`, `setProjection`, `viewArea`, `highlightArea`, `project`, `unproject`, `onViewChange`, `setPanEnabled`, `setDoubleClickZoom`,
`setInteractive`, `setCursor`, `onPointer`, `onKey`, `onBlur`, `setWidgets`, `onWidgetEdit`,
`onWidgetDelete`, `onWidgetAction`, `setCoordFormat`, `destroy`.
`onKey` and marker widgets are documented above; `bindKeyListener(container, cb)` and
`defaultCoordFormat(ll)` are exported for manual use.

A product simply never calls the methods it doesn't need (sigmet ignores
`project`/`unproject`/`onViewChange`/`registerSymbols`).

## License

MIT
