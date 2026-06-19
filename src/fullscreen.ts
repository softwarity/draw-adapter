/**
 * The toolbar "fullscreen" toggle — requests / exits the browser **Fullscreen API** on the map
 * container, so the map fills the screen. Engine-agnostic (every adapter passes its container +
 * its resize), a `standalone` utility button (it never changes the active tool); its icon + tooltip
 * flip with state and **sync to `fullscreenchange`** so an Esc-exit (or OS gesture) repaints too.
 */
import type { ToolbarItem } from "./index.js";

const FS_BASE =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
/** Four corners pointing **out** — shown when NOT fullscreen (click ⇒ enter). */
const FS_ENTER = `${FS_BASE}<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
/** Four corners pointing **in** — shown while fullscreen (click ⇒ exit). */
const FS_EXIT = `${FS_BASE}<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`;

/** Old-WebKit-prefixed Fullscreen API members (Safari < 16.4), accessed defensively. */
interface FsDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface FsElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}

/** The element currently in fullscreen (unprefixed, then WebKit fallback), or `null`. */
function fullscreenEl(): Element | null {
  return document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement ?? null;
}

/**
 * Build the "fullscreen" toolbar item, or `null` when `show === false` (or the Fullscreen API is
 * unavailable — a dead button would be worse than none). Clicking it toggles fullscreen on the map
 * container; `onChange` lets the adapter resize its map once the viewport changed. Default-shown.
 */
export function fullscreenToolbarItem(
  show: boolean | undefined,
  getContainer: () => HTMLElement,
  onChange?: () => void,
): ToolbarItem | null {
  if (show === false) return null;
  if (typeof document === "undefined" || !document.fullscreenEnabled) return null; // unsupported ⇒ no button
  let btn: HTMLButtonElement | undefined;
  const paint = (): void => {
    if (!btn) return;
    const on = !!fullscreenEl();
    btn.innerHTML = on ? FS_EXIT : FS_ENTER;
    btn.title = on ? "Exit fullscreen" : "Fullscreen";
    btn.classList.toggle("active", on);
  };
  return {
    id: "fullscreen",
    title: "Fullscreen",
    svg: FS_ENTER,
    standalone: true, // toggling fullscreen must not deselect the active drawing tool
    onClick: () => {
      if (fullscreenEl()) {
        (document.exitFullscreen ?? (document as FsDocument).webkitExitFullscreen)?.call(document);
      } else {
        const el = getContainer() as FsElement;
        (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      }
      // The icon repaint + map resize happen on `fullscreenchange` below (covers Esc / OS exit too).
    },
    onRender: (b) => {
      btn = b;
      paint();
      // Sync on every fullscreen transition; self-remove once the toolbar is torn down (button
      // detached) so the document listeners never leak (mirrors the toolbar's outside-press guard).
      const sync = (): void => {
        if (!b.isConnected) {
          document.removeEventListener("fullscreenchange", sync);
          document.removeEventListener("webkitfullscreenchange", sync);
          return;
        }
        paint();
        onChange?.();
      };
      document.addEventListener("fullscreenchange", sync);
      document.addEventListener("webkitfullscreenchange", sync);
    },
  };
}
