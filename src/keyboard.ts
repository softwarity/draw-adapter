/**
 * Shared keyboard plumbing for the engine adapters. A `keydown` listener scoped to the
 * map container (so only the focused map reacts, and keys typed into the host app's
 * inputs elsewhere never reach us), with editable targets skipped. The adapter forwards
 * a normalized {@link KeyEvent}; all key→action semantics stay in the consumer.
 */
import type { KeyEvent } from "./index.js";

/** True for elements where a keystroke means "typing", so map shortcuts must defer. */
function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Attach a scoped `keydown` listener to `container` that forwards normalized key events
 * (skipping editable targets); returns a teardown. The container is made click-focusable
 * (`tabindex="-1"` if it has none) so it can receive focus — a keydown then bubbles up
 * from the engine's focused canvas to this listener. Listening on the container (not
 * `window`) keeps it scoped to the focused map, which is also multi-instance safe.
 */
export function bindKeyListener(container: HTMLElement, cb: (ev: KeyEvent) => void): () => void {
  if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
  const handler = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    cb({
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
      preventDefault: () => e.preventDefault(),
    });
  };
  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}

/**
 * Return keyboard focus to the map's key-listening element after a chrome click (a toolbar button or
 * a widget-card button) left focus on `<body>` — otherwise `onKey` (Escape to cancel a draw mode you
 * just started, etc.) stays dead until the user clicks the map again. No-op while an editable element
 * is focused (a widget `<input>` must keep its focus/caret) or when `target` is already focused.
 */
export function refocusMap(target: HTMLElement | null | undefined): void {
  if (!target) return;
  const active = target.ownerDocument?.activeElement ?? null;
  if (isEditable(active) || active === target) return;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  try { target.focus({ preventScroll: true }); } catch { /* ignore (e.g. detached) */ }
}
