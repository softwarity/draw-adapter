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

/** Border width preset (px) for the **widget card**, keyed by size — `"medium"` is the classic 1px
 *  hairline (the default). */
const BORDER_WIDTH: Record<TextBoxSize, number> = {
  small: 0.5,
  medium: 1,
  large: 2,
};
/** Border width preset (px) for the **overlay text box** (call-out label liseré) — a heavier scale
 *  than the card; `"medium"` (1.4px) is the default that preserves the former MapLibre look. */
const TEXT_BORDER_WIDTH: Record<TextBoxSize, number> = {
  small: 0.8,
  medium: 1.4,
  large: 2.2,
};

/** Resolve `textBoxSize` (default `"medium"`) to `[vertical, horizontal]` px padding. */
export function boxPadding(size: unknown): [number, number] {
  return PADDING[size as TextBoxSize] ?? PADDING.medium;
}
/** Resolve a widget-card border-width preset (default `"medium"` ⇒ 1px) to a px width. */
export function boxBorderWidth(size: unknown): number {
  return BORDER_WIDTH[size as TextBoxSize] ?? BORDER_WIDTH.medium;
}
/** Resolve an overlay text-box border-width preset (default `"medium"` ⇒ 1.4px) to a px width. */
export function textBoxBorderWidth(size: unknown): number {
  return TEXT_BORDER_WIDTH[size as TextBoxSize] ?? TEXT_BORDER_WIDTH.medium;
}
/** Resolve `textBoxRadius` (default `"none"`) to a corner radius in px. */
export function boxRadius(radius: unknown): number {
  const r = RADIUS[radius as TextBoxRadius];
  return r === undefined ? RADIUS.none : r;
}
