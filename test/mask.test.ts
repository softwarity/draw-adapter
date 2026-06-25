import { describe, expect, it } from "vitest";

import { OutsideMask, maskRect } from "../src/mask.js";
import type { LatLng, LngLatBounds } from "../src/index.js";

/** A trivial projection for tests: lon→x, lat→y. */
const proj = ({ lon, lat }: LatLng): [number, number] => [lon, lat];

describe("mask — maskRect", () => {
  it("returns the axis-aligned bbox of the projected corners", () => {
    const ext: LngLatBounds = [-90, 0, 30, 90];
    const r = maskRect(ext, proj);
    expect(r).toEqual({ x1: -90, y1: 0, x2: 30, y2: 90 });
  });

  it("is dateline-aware (uses the unwrapped east edge)", () => {
    const ext: LngLatBounds = [110, -10, -110, 72]; // area M ⇒ east unwraps to 250
    const r = maskRect(ext, proj);
    expect(r?.x1).toBe(110);
    expect(r?.x2).toBe(250);
  });

  it("returns null when fewer than two corners project", () => {
    const ext: LngLatBounds = [-90, 0, 30, 90];
    expect(maskRect(ext, () => null)).toBeNull();
    let n = 0;
    expect(maskRect(ext, () => (n++ === 0 ? [1, 2] : null))).toBeNull(); // only 1 corner
  });
});

describe("mask — OutsideMask", () => {
  it("creates one non-interactive overlay on show and clips to the rect complement", () => {
    const container = document.createElement("div");
    const mask = new OutsideMask(container);
    mask.show({ x1: 10, y1: 20, x2: 110, y2: 220 }, 3);

    expect(container.children).toHaveLength(1);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe("draw-adapter-blur-outside");
    expect(el.style.position).toBe("absolute");
    expect(el.style.pointerEvents).toBe("none");
    // even-odd polygon carrying the area rect coordinates ⇒ only the OUTSIDE is clipped/blurred
    expect(el.style.clipPath).toContain("evenodd");
    expect(el.style.clipPath).toContain("10px 20px");
    expect(el.style.clipPath).toContain("110px 220px");
    // blur radius applied
    expect(el.style.backdropFilter).toBe("blur(3px)");
    expect(el.style.zIndex).toBe("2"); // default
  });

  it("honours a per-engine z-index (e.g. Leaflet above its panes)", () => {
    const container = document.createElement("div");
    new OutsideMask(container, "650").show({ x1: 0, y1: 0, x2: 10, y2: 10 }, 1);
    expect((container.firstElementChild as HTMLElement).style.zIndex).toBe("650");
  });

  it("is idempotent — re-show reuses the same element and re-clips", () => {
    const container = document.createElement("div");
    const mask = new OutsideMask(container);
    mask.show({ x1: 0, y1: 0, x2: 50, y2: 50 }, 2);
    const first = container.firstElementChild;
    mask.show({ x1: 5, y1: 5, x2: 60, y2: 60 }, 4);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(first); // same node
    expect((first as HTMLElement).style.clipPath).toContain("60px 60px");
  });

  it("hide removes the overlay and is a no-op when absent", () => {
    const container = document.createElement("div");
    const mask = new OutsideMask(container);
    expect(() => mask.hide()).not.toThrow(); // before any show
    mask.show({ x1: 0, y1: 0, x2: 10, y2: 10 }, 1);
    mask.hide();
    expect(container.children).toHaveLength(0);
    expect(() => mask.hide()).not.toThrow(); // double hide
  });
});
