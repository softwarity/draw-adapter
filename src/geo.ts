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

/** Remember which messages were already logged, so a repeated no-op spec warns only once. */
const warned = new Set<string>();

/** `console.warn(msg)` at most once per distinct message (per process). */
export function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  if (typeof console !== "undefined") console.warn(msg);
}
