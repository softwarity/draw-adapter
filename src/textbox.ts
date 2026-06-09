/**
 * Call-out label box presets — shared px values so the box around a label looks the same
 * on all three engines. OpenLayers/Leaflet draw it natively; MapLibre bakes it into a
 * lazily-materialized 9-slice image. A box is drawn **only** when a `text` feature carries
 * `textBackground` and/or `textBorder`; `textBoxSize`/`textBoxRadius` only tune it.
 */

/** Inner padding preset for the label box. */
export type TextBoxSize = "small" | "medium" | "large";
/** Corner radius preset for the label box (`round` ⇒ strongly rounded). */
export type TextBoxRadius = "none" | "small" | "medium" | "round";

/** Padding inside the box, `[vertical, horizontal]` px — keyed by `textBoxSize`. */
const PADDING: Record<TextBoxSize, [number, number]> = {
  small: [3, 5],
  medium: [6, 8],
  large: [10, 13],
};
/** Corner radius px — keyed by `textBoxRadius`. */
const RADIUS: Record<TextBoxRadius, number> = {
  none: 0,
  small: 3,
  medium: 6,
  round: 14,
};

/** Resolve `textBoxSize` (default `"medium"`) to `[vertical, horizontal]` px padding. */
export function boxPadding(size: unknown): [number, number] {
  return PADDING[size as TextBoxSize] ?? PADDING.medium;
}
/** Resolve `textBoxRadius` (default `"none"`) to a corner radius in px. */
export function boxRadius(radius: unknown): number {
  const r = RADIUS[radius as TextBoxRadius];
  return r === undefined ? RADIUS.none : r;
}
