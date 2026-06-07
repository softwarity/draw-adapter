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

To test changes in `sigmet-draw` / `sigwx-draw` **without publishing to npm**,
copy the build straight into their `node_modules`:

```bash
npm run build:link          # build + copy into ../sigmet-draw and ../sigwx-draw
# or, after a manual build:
npm run link:siblings
# custom targets:
node scripts/link-into-siblings.mjs ../sigmet-draw ../some-other-lib
```

It copies only `package.json` + `dist/` (the published `files` allow-list),
preserving the sub-path exports — exactly what `npm install` would ship. Re-run
after each build. When ready, publish normally (`npm publish`) and let the
consumers pin the version.

> **Heads-up — don't `npm install` in the siblings before the lib is published.**
> While `@softwarity/draw-adapter` is unpublished, a sibling that lists it in
> `dependencies` will `404` on `npm install` (and an `overrides`/`file:` shim is
> refused as it conflicts with a direct dependency). So: install everything else
> first, then keep the lib in place via `build:link` — don't run a full
> `npm install` until the package is on npm.

> **Single engine copy matters.** When an app bundles a consumer from a path
> *outside its own `node_modules`*, the engine peer (especially **Leaflet** and
> **OpenLayers**) can get duplicated — and two copies break cross-instance checks
> (Leaflet's renderer won't draw the other copy's paths → handles vanish;
> OpenLayers' `instanceof DragPan` fails → handle-drag pans the map). Resolve the
> consumer **and** this lib from the app's own `node_modules` so the engine
> collapses to one copy. (`sigmet-draw/demo` does this via its `setup:local` script.)

### Packaging / Node ESM

The published output is real Node ESM and is verified per sub-path in CI
(`npm run test:esm`). Two things bundlers silently paper over but Node does not,
both handled here: `ol/*` value imports end in `.js` (ol ships no `exports` map),
and `maplibre-gl` (CJS-only) is imported as a namespace with a runtime ctor
resolve rather than `import { Map }`. The peer-free entry (`.`) never imports an
engine, so optional peer deps stay optional.

## Snapshots (PNG)

Capture the current map — basemap **and** overlays — as a PNG `Blob`:

```ts
const blob = await adapter.snapshot();           // "as on screen" (devicePixelRatio)
const hi   = await adapter.snapshot({ scale: 3 }); // supersample (best-effort)
```

- Always resolves to an `image/png` Blob. `scale` is the output **pixel-ratio**
  (device px per CSS px); it defaults to `window.devicePixelRatio`.
- Capture happens **inside the engine's render frame**, so the host map needs **no
  special flag** (in particular, no `preserveDrawingBuffer` on the MapLibre/WebGL map).
- **Leaflet is not supported yet** — `snapshot()` rejects (tiles are `<img>` and
  overlays are SVG/DOM, so there is no single exportable canvas). A DOM-snapshot
  approach is planned.
- `scale > 1` (`medium`/`high`) is **supersampling, best-effort**: it re-scales the
  captured composition, which enlarges but does not add real map detail.

### Toolbar button

Pass a `snapshot` preset to `addToolbar` and the adapter adds a camera button that
downloads `map.png` on click — no wiring needed on your side:

```ts
adapter.addToolbar(tools, { snapshot: "native" }); // default; "none" disables it
```

| preset | output pixel-ratio | notes |
|--------|--------------------|-------|
| `none` | — | no button |
| `low` | `1` | CSS-pixel resolution |
| `native` *(default)* | `window.devicePixelRatio` | capture as on screen |
| `medium` / `high` | `2` / `3` | supersample (best-effort) |

On the **Leaflet** adapter the button is rendered **disabled**, with the
unavailability message as its tooltip. The preset→scale mapping is the exported
pure function `snapshotScale(level)`; `downloadPng(blob, name?)` triggers the
browser download.

## API surface

`MapAdapter` — `ready`, `registerSymbols`, `setOverlay`, `snapshot`, `setTooltip`,
`addToolbar`, `getCenter`, `getViewSpan`, `project`, `unproject`, `onViewChange`,
`setPanEnabled`, `setDoubleClickZoom`, `setCursor`, `onPointer`, `destroy`.

A product simply never calls the methods it doesn't need (sigmet ignores
`project`/`unproject`/`onViewChange`/`registerSymbols`).

## License

MIT
