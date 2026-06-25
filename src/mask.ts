/**
 * The DOM overlay behind `highlightArea`'s **`blurOutside`**. A map `fill` cannot blur a region, so the
 * blur is a non-interactive `<div>` over the map (`backdrop-filter: blur(Npx)`) clipped to the
 * COMPLEMENT of the area's screen rectangle — the surroundings blur, the inside stays crisp. Unlike the
 * native frame / `dimOutside` (geo layers that follow pan/zoom for free), this is NOT a map layer, so
 * the adapter must re-place its clip on every view change (its callers wire the engine's move event).
 * Engine-agnostic: fed a container, the area's screen rect, and a blur radius.
 */
import type { LatLng, LngLatBounds } from "./index.js";
import { unwrapEast } from "./geo.js";

/** A rectangle in container pixels. */
export interface ScreenRect { x1: number; y1: number; x2: number; y2: number; }

/**
 * The area's screen rectangle = the axis-aligned bounds of its projected corners (dateline-aware via
 * {@link unwrapEast}; under a rotated map this is the bbox of the rotated area, which is what a
 * rectangular clip uses). `null` when the corners cannot be projected.
 */
export function maskRect(extent: LngLatBounds, project: (p: LatLng) => [number, number] | null): ScreenRect | null {
  const [w, s, e0, n] = extent;
  const e = unwrapEast(w, e0);
  const pts = ([[w, n], [e, n], [e, s], [w, s]] as [number, number][])
    .map(([lon, lat]) => project({ lon, lat }))
    .filter((p): p is [number, number] => !!p);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/**
 * A reusable blur overlay, clipped to the complement of a screen rect, parented to the map container.
 *
 * `zIndex` must place the overlay **above the map imagery** but ideally below the chrome you want to keep
 * crisp — and that value is engine-specific, so each adapter passes its own: the map layer sits at very
 * different stacking levels (Leaflet's tile pane is z 200, so "2" would hide the blur *behind* the
 * tiles). The area interior is never blurred regardless (the clip leaves a hole there), so the cartouche
 * to highlight — which sits in the area — stays crisp whatever the z-index.
 */
export class OutsideMask {
  private el: HTMLDivElement | undefined;
  constructor(private readonly container: HTMLElement, private readonly zIndex = "2") {}

  /** Blur the OUTSIDE of `rect` by `blur` px. Idempotent — creates the `<div>` once, then re-clips. */
  show(rect: ScreenRect, blur: number): void {
    let el = this.el;
    if (!el) {
      el = document.createElement("div");
      el.className = "draw-adapter-blur-outside";
      const s = el.style;
      s.position = "absolute"; s.top = "0"; s.left = "0"; s.right = "0"; s.bottom = "0";
      s.pointerEvents = "none"; // never intercept clicks
      s.zIndex = this.zIndex; // engine-specific: above the map imagery (see class doc)
      this.container.appendChild(el);
      this.el = el;
    }
    const f = `blur(${blur}px)`;
    el.style.backdropFilter = f;
    el.style.setProperty("-webkit-backdrop-filter", f); // Safari
    // Even-odd polygon: the whole container MINUS the area rect ⇒ only the OUTSIDE is blurred.
    const { x1, y1, x2, y2 } = rect;
    el.style.clipPath =
      `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ` +
      `${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
  }

  /** Remove the overlay (no-op if absent). */
  hide(): void {
    if (this.el) { this.el.remove(); this.el = undefined; }
  }
}
