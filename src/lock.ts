/**
 * The toolbar "lock map" button — toggles the adapter's {@link MapAdapter.setInteractive}
 * so the map can't pan/zoom/rotate while drawing. A `standalone` utility button (it
 * never changes the active tool selection); its padlock icon + tooltip flip with state.
 */
import type { ToolbarItem } from "./index.js";

const PADLOCK_BASE =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>`;
/** Closed padlock — shown when the map is locked. */
const LOCK_CLOSED = `${PADLOCK_BASE}<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
/** Open padlock — shown when the map is unlocked. */
const LOCK_OPEN = `${PADLOCK_BASE}<path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

/**
 * Build the "lock map" toolbar item, or `null` when `show === false`. Clicking it
 * toggles a private locked state, calls `setInteractive(!locked)`, and re-paints its
 * icon/tooltip. The adapter wires `setInteractive` to its engine; this helper owns only
 * the button's presentation + toggle.
 */
export function lockToolbarItem(
  show: boolean | undefined,
  setInteractive: (enabled: boolean) => void,
): ToolbarItem | null {
  if (show === false) return null;
  let btn: HTMLButtonElement | undefined;
  let locked = false;
  const paint = (): void => {
    if (!btn) return;
    btn.innerHTML = locked ? LOCK_CLOSED : LOCK_OPEN;
    btn.title = locked ? "Unlock map" : "Lock map";
    btn.classList.toggle("active", locked);
  };
  return {
    id: "lock",
    title: "Lock map",
    svg: LOCK_OPEN,
    standalone: true, // locking must not deselect the active drawing tool
    onClick: () => {
      locked = !locked;
      setInteractive(!locked);
      paint();
    },
    onRender: (b) => { btn = b; paint(); },
  };
}
