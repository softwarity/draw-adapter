/**
 * Sprite utilities shared by the engine adapters. A *sprite* is an inline SVG
 * whose stroke/fill use the `currentColor` token so the adapters can re-tint one
 * sprite per feature (`symbolColor`) via {@link colorizeSprite}.
 *
 * The default atlas (`DEFAULT_SPRITES`) and default ink stay in each product (they
 * are domain) — the lib only provides the plumbing.
 */
import type { SymbolSprites } from "./index.js";

export type { SymbolSprites };

/** Sprite pixel size the adapters rasterize/draw at (icon-size 1 ⇒ this many px). */
export const SPRITE_PX = 32;

/** Default ink for a sprite when the feature sets no `symbolColor` (shared by all adapters). */
export const DEFAULT_SYMBOL_COLOR = "#000000";

/** Bake a concrete colour into a sprite (replaces the `currentColor` token). */
export function colorizeSprite(svg: string, color: string): string {
  return svg.split("currentColor").join(color);
}

/** Encode an SVG string as a `data:image/svg+xml` URL. */
export function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.trim());
}

/**
 * Rasterize an SVG sprite (or any image `src`, incl. a `data:` URI) into an
 * `HTMLImageElement` — for MapLibre `addImage`.
 */
export function loadSpriteImage(svg: string, px = SPRITE_PX): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(px, px);
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e instanceof Error ? e : new Error("sprite load failed"));
    img.src = svg.startsWith("data:") ? svg : svgToDataUrl(svg);
  });
}
