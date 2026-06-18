// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { clearSpriteCache, measureWidget, rasterizeWidget } from "../src/index.js";
import type { MarkerWidget } from "../src/index.js";

// jsdom does no layout (`offsetWidth` ⇒ 0) and has no real canvas, so the rasterizer degrades
// gracefully here: `measureWidget` returns a zero size and `rasterizeWidget` returns null. These
// tests cover the engine-agnostic behaviour that does NOT need a render — the static DOM build (every
// leaf kind), the per-id cache, and the headless degradation. Pixel fidelity is verified in a browser.

const LABEL: MarkerWidget = {
  id: "s1", anchor: { lon: 2, lat: 1 },
  child: { dir: "v", items: [{ kind: "text", value: "FL340" }] },
};

/** One of every node kind (incl. controls that must flatten + gauge/dial that must be omitted). */
const KITCHEN_SINK: MarkerWidget = {
  id: "ks", anchor: { lon: 0, lat: 0 }, bg: "#fff", border: "#1f2328", radius: "small", padding: "small",
  font: { color: "#111", size: 12 },
  child: {
    dir: "v", gap: 2, items: [
      { kind: "glyph", svg: "<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>", size: 16 },
      { kind: "text", value: "LABEL", uppercase: true },
      { kind: "text", value: "x", editable: true, control: "input" },
      { kind: "text", value: "CB", control: "picker", options: [{ value: "CB", label: "Cumulonimbus" }, "CI"] },
      { kind: "coord" },
      { kind: "gauge", min: 0, max: 100, cursors: [{ name: "a", value: 50 }] },
      { kind: "dial", name: "d", min: 0, max: 100, value: 50 },
      // An L-shaped sub-frame (per-side border).
      { dir: "h", border: { left: "#000", bottom: "#000" }, items: [{ kind: "text", value: "L" }] },
    ],
  },
};

afterEach(() => clearSpriteCache()); // module-level cache: isolate the tests

describe("sprite — measureWidget", () => {
  it("returns a numeric CSS size and never throws across every node kind", () => {
    expect(() => measureWidget(KITCHEN_SINK)).not.toThrow();
    const size = measureWidget(KITCHEN_SINK);
    expect(typeof size.width).toBe("number");
    expect(typeof size.height).toBe("number");
  });

  it("caches per id (re-measures only on a content change)", () => {
    const a = measureWidget(LABEL);
    const b = measureWidget(LABEL); // same content + id ⇒ cached (same object)
    expect(b).toBe(a);
    const changed: MarkerWidget = { ...LABEL, child: { dir: "v", items: [{ kind: "text", value: "FL390" }] } };
    const c = measureWidget(changed); // same id, new content ⇒ re-measured (fresh object)
    expect(c).not.toBe(a);
  });

  it("clearSpriteCache(id) forces a re-measure", () => {
    const a = measureWidget(LABEL);
    clearSpriteCache(LABEL.id);
    const b = measureWidget(LABEL);
    expect(b).not.toBe(a);
  });
});

describe("sprite — rasterizeWidget", () => {
  it("degrades to null in a headless DOM (no layout / no canvas), without throwing", async () => {
    await expect(rasterizeWidget(LABEL)).resolves.toBeNull();
  });
});
