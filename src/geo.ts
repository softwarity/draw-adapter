/**
 * Pure geographic helpers shared by the engine adapters for {@link MapAdapter.viewArea}
 * and {@link MapAdapter.highlightArea}: dateline-aware bbox handling and edge densification
 * (so a framed area follows a non-Mercator projection's curvature). No engine imports — unit
 * testable in isolation.
 */
import type { LngLatBounds } from "./index.js";

/**
 * Return `east` unwrapped relative to `west` so the span `west → east` is monotonically
 * increasing. A bbox whose `east <= west` is read as **crossing the antimeridian** (e.g.
 * `west = 110`, `east = -110` ⇒ `250`), giving one continuous span instead of the long way
 * round the globe.
 */
export function unwrapEast(west: number, east: number): number {
  return east <= west ? east + 360 : east;
}

/** Linear interpolation. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A **closed** lon/lat ring tracing the bbox perimeter with `perEdge` samples per edge
 * (dateline-aware via {@link unwrapEast} — longitudes may exceed 180). Densifying the edges
 * lets a reprojection bend them: under a polar-stereographic view the straight geographic
 * edges become curves once each sample is transformed. Used both to fit the camera
 * ({@link MapAdapter.viewArea}) and to draw the frame ({@link MapAdapter.highlightArea}).
 */
export function densifyBboxRing(extent: LngLatBounds, perEdge = 32): [number, number][] {
  const [w, s, e0, n] = extent;
  const e = unwrapEast(w, e0);
  const segs = Math.max(1, Math.floor(perEdge));
  const pts: [number, number][] = [];
  for (let i = 0; i < segs; i++) pts.push([lerp(w, e, i / segs), s]); // bottom  W→E
  for (let i = 0; i < segs; i++) pts.push([e, lerp(s, n, i / segs)]); // right   S→N
  for (let i = 0; i < segs; i++) pts.push([lerp(e, w, i / segs), n]); // top     E→W
  for (let i = 0; i < segs; i++) pts.push([w, lerp(n, s, i / segs)]); // left    N→S
  pts.push([w, s]); // close the ring
  return pts;
}

/** Normalise a longitude into `[-180, 180)`. */
function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Rectangle rings (closed, lon/lat) that together tile **everything EXCEPT** `extent` — the input for
 * `highlightArea`'s native `dimOutside`. Drawn as a single multi-polygon fill, they dim the area's
 * surroundings and follow the map for free.
 *
 * Why a handful of plain rectangles rather than one world-ring-with-a-hole: a polygon hole needs the
 * right winding for OpenLayers' *non-zero* fill (Leaflet's even-odd and MapLibre's ear-clipping don't
 * care), and a complement that wraps the globe is necessarily ≥360° wide — and such an antimeridian-
 * spanning, self-surrounding polygon makes MapLibre's tiler (geojson-vt) mangle it (everything dims).
 * Instead we cut the complement into **axis-aligned rectangles, each wholly inside one world**
 * (`[-180, 180]`), split at the antimeridian. No holes (no winding/fill-rule trap), no world-spanning
 * or dateline-crossing polygon — identical and robust on all three engines. Latitude is clamped to the
 * Mercator range.
 */
export function complementRings(extent: LngLatBounds): [number, number][][] {
  const LAT = 85;
  const [w0, s0, e0, n0] = extent;
  const w = normLon(w0);
  const e = normLon(e0);
  const s = Math.max(-LAT, Math.min(LAT, s0));
  const n = Math.max(-LAT, Math.min(LAT, n0));
  const rect = (a: number, b: number, c: number, d: number): [number, number][] =>
    [[a, c], [b, c], [b, d], [a, d], [a, c]];
  const rings: [number, number][][] = [];
  if (e >= w) {
    // Area does NOT cross the antimeridian: dim left of it, right of it, and the strips above/below it.
    if (w > -180) rings.push(rect(-180, w, -LAT, LAT));
    if (e < 180) rings.push(rect(e, 180, -LAT, LAT));
    if (s > -LAT) rings.push(rect(w, e, -LAT, s));
    if (n < LAT) rings.push(rect(w, e, n, LAT));
  } else {
    // Area crosses the antimeridian (occupies [w,180] ∪ [-180,e]): dim the gap between its two halves,
    // plus the strips above/below each half — every rect stays within one world.
    rings.push(rect(e, w, -LAT, LAT));
    if (s > -LAT) { rings.push(rect(w, 180, -LAT, s)); rings.push(rect(-180, e, -LAT, s)); }
    if (n < LAT) { rings.push(rect(w, 180, n, LAT)); rings.push(rect(-180, e, n, LAT)); }
  }
  return rings;
}

/** Remember which messages were already logged, so a repeated no-op spec warns only once. */
const warned = new Set<string>();

/** `console.warn(msg)` at most once per distinct message (per process). */
export function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  if (typeof console !== "undefined") console.warn(msg);
}
