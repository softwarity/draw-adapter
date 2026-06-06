# Release Notes

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
