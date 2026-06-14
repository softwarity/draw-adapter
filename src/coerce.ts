/** Small prop coercions + colour/geometry helpers shared by the engine adapters. */
import type { LatLng } from "./index.js";

/** Default `coord` formatter — a compact decimal lat/long. Consumers override via
 *  {@link MapAdapter.setCoordFormat} (e.g. sigwx supplies its own `formatLatLng`). Lives here (a leaf)
 *  rather than in `widget.ts` so `index.ts` can re-export it without an index↔widget import cycle. */
export function defaultCoordFormat(ll: LatLng): string {
  const lat = `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}`;
}

/** Read a numeric prop, falling back to `d` when absent/not a number. */
export function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Read a string prop, falling back to `""` (or `d`) when absent/not a string. */
export function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

/** Read a boolean prop (truthy === true). */
export function bool(v: unknown): boolean {
  return v === true;
}

/** Degrees → radians (icon rotation is degrees, clockwise, on every engine). */
export function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Convert a hex colour (`#rgb` / `#rrggbb`) + opacity to `rgba(…)` (OpenLayers
 * and canvas have no separate fill-opacity). Non-hex colour forms (named, rgb,
 * rgba, hsl…) are returned unchanged.
 */
export function rgba(color: string, opacity: number): string {
  const c = color.trim();
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  let r: number;
  let g: number;
  let b: number;
  if (m6) {
    r = parseInt(m6[1]!, 16);
    g = parseInt(m6[2]!, 16);
    b = parseInt(m6[3]!, 16);
  } else if (m3) {
    r = parseInt(m3[1]! + m3[1]!, 16);
    g = parseInt(m3[2]! + m3[2]!, 16);
    b = parseInt(m3[3]! + m3[3]!, 16);
  } else {
    return color;
  }
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Word-wrap `text` so each line fits `maxPx` at `fontPx` (OpenLayers/canvas have
 * no native max-width). Inserts `\n` between lines. `maxPx <= 0` ⇒ no wrapping.
 * Falls back gracefully (no measuring) when no 2D canvas context is available.
 */
let wrapCtx: CanvasRenderingContext2D | null | undefined;
export function wrapLabel(text: string, maxPx: number, fontPx: number): string {
  if (!text || maxPx <= 0) return text;
  if (wrapCtx === undefined) {
    wrapCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!wrapCtx) return text;
  wrapCtx.font = `${fontPx}px sans-serif`;
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (cur && wrapCtx.measureText(trial).width > maxPx) {
      lines.push(cur);
      cur = word;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}
