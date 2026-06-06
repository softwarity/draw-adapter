/** Apply a {@link TooltipStyle} to the floating tooltip element (shared by adapters). */
import type { TooltipStyle } from "./index.js";

export function applyTooltipStyle(el: HTMLElement, t: TooltipStyle): void {
  Object.assign(el.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: "4",
    transform: "translate(12px, 12px)",
    maxWidth: t.maxWidth,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    background: t.background,
    color: t.color,
    fontSize: `${t.fontSize}px`,
    lineHeight: "1.35",
    padding: t.padding,
    borderRadius: t.borderRadius,
  } satisfies Partial<CSSStyleDeclaration>);
}
