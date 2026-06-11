/**
 * Build a tool toolbar inside an engine-provided container (MapLibre `ctrl-group`
 * / OpenLayers `ol-control` / a plain Leaflet div), so buttons inherit the
 * engine's native control look. Placement/flow via {@link ToolbarOptions}.
 *
 * An item with `children` becomes a **submenu**: clicking its button opens a flyout
 * of the child buttons, positioned *into the map* based on the toolbar edge.
 */
import type { ToolbarItem, ToolbarOptions } from "./index.js";

const STYLE_ID = "draw-adapter-toolbar-style";
const TOOLBAR_CLASS = "draw-adapter-toolbar";

/** Neutral placeholder icon used when a {@link ToolbarItem} provides no `svg`. */
const FALLBACK_ICON =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>`;

/** Toolbar edge → the side a submenu flyout opens toward (always into the map). */
const SUBMENU_SIDE: Record<string, "down" | "up" | "right" | "left"> = {
  top: "down",
  bottom: "up",
  left: "right",
  right: "left",
};

function ensureToolbarStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `.${TOOLBAR_CLASS} button svg{display:block;margin:auto}` +
    `.${TOOLBAR_CLASS} button{color:#24292f}` +
    `.${TOOLBAR_CLASS} button:disabled{opacity:.28;filter:grayscale(1);cursor:not-allowed}` +
    // Submenu: the trigger is a plain bar button (no wrapper → native first/last-child
    // styling intact). The flyout is appended to <body> and `position:fixed`, JS-placed
    // next to the trigger via getBoundingClientRect — so it's never clipped (Leaflet's
    // `overflow:hidden`) nor mis-anchored by a transformed toolbar (centred positions).
    `.dap-submenu{position:fixed;display:none;flex-direction:column;background:#fff;` +
    `border:1px solid rgba(0,0,0,.15);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3);overflow:hidden;z-index:1000}` +
    `.dap-submenu.open{display:flex}` +
    `.dap-submenu button{color:#24292f;background:#fff;border:0;width:30px;height:30px;cursor:pointer;padding:0}` +
    `.dap-submenu button svg{display:block;margin:auto}` +
    `.dap-submenu button:hover{background:#f4f4f4}` +
    `.dap-submenu button:disabled{opacity:.28;filter:grayscale(1);cursor:not-allowed}`;
  document.head.appendChild(style);
}

export function applyToolbarLayout(el: HTMLElement, opts?: ToolbarOptions): void {
  const pad = opts?.padding ?? "10px";
  const side = (s: "top" | "right" | "bottom" | "left"): string =>
    typeof pad === "string" ? pad : (pad[s] ?? "10px");
  const pos = opts?.position ?? "top-left";
  const [edge, sec] = pos.split("-");
  const horizontal = edge === "top" || edge === "bottom";
  el.style.position = "absolute";
  el.style.zIndex = "3";
  el.style.top = el.style.bottom = el.style.left = el.style.right = "auto";
  el.style.transform = "none";
  if (edge === "top") el.style.top = side("top");
  else if (edge === "bottom") el.style.bottom = side("bottom");
  else if (edge === "left") el.style.left = side("left");
  else el.style.right = side("right");
  if (horizontal) {
    if (sec === "left") el.style.left = side("left");
    else if (sec === "right") el.style.right = side("right");
    else (el.style.left = "50%"), (el.style.transform = "translateX(-50%)");
  } else {
    if (sec === "top") el.style.top = side("top");
    else if (sec === "bottom") el.style.bottom = side("bottom");
    else (el.style.top = "50%"), (el.style.transform = "translateY(-50%)");
  }
  el.style.display = "flex";
  el.style.flexWrap = "nowrap";
  el.style.flexDirection = horizontal ? "row" : "column"; // flow is defined by the edge
  el.style.gap = opts?.gap ?? "";
  if (opts?.className) el.classList.add(...opts.className.split(/\s+/).filter(Boolean));
}

/** Create a plain `<button>` for an item (icon/title/disabled), no click wiring. */
function createButton(item: ToolbarItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["tool"] = item.id;
  button.title = item.title;
  button.setAttribute("aria-label", item.title);
  button.innerHTML = item.svg ?? FALLBACK_ICON;
  if (item.disabled) button.disabled = true;
  return button;
}

export function populateToolbar(el: HTMLElement, items: ToolbarItem[], options?: ToolbarOptions, refocus?: () => void): void {
  el.classList.add(TOOLBAR_CLASS);
  ensureToolbarStyle();
  applyToolbarLayout(el, options);

  const order = options?.tools;
  const shown = order
    ? order.map((id) => items.find((it) => it.id === id)).filter((it): it is ToolbarItem => it != null)
    : items;

  const side = SUBMENU_SIDE[(options?.position ?? "top-left").split("-")[0]!] ?? "down";

  // Flyouts live in <body> (not in `el`), so we track them here for close/cleanup.
  const menus: HTMLElement[] = [];
  const closeSubmenus = (): void => { for (const m of menus) m.classList.remove("open"); };
  const setActive = (btn: HTMLButtonElement): void => {
    el.querySelectorAll("button.active").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  };

  for (const item of shown) {
    if (item.children?.length) {
      const { trigger, menu } = buildSubmenu(item, side, closeSubmenus, setActive, refocus);
      el.appendChild(trigger);
      menus.push(menu);
    } else {
      el.appendChild(buildButton(item, el, setActive, closeSubmenus, refocus));
    }
  }

  // Close any open flyout on a press outside the toolbar AND outside the flyouts (e.g. on
  // the map). One capture-phase listener for the toolbar's life; once `el` is detached
  // (adapter teardown) it removes the body flyouts and itself.
  if (menus.length && typeof document !== "undefined") {
    const onDocDown = (e: Event): void => {
      if (!el.isConnected) {
        document.removeEventListener("pointerdown", onDocDown, true);
        for (const m of menus) m.remove();
        return;
      }
      const t = e.target;
      if (t instanceof Node && (el.contains(t) || menus.some((m) => m.contains(t)))) return;
      closeSubmenus();
    };
    document.addEventListener("pointerdown", onDocDown, true);
  }
}

/** A leaf (non-submenu) tool button, fully wired. */
function buildButton(
  item: ToolbarItem,
  el: HTMLElement,
  setActive: (btn: HTMLButtonElement) => void,
  closeSubmenus: () => void,
  refocus?: () => void,
): HTMLButtonElement {
  const button = createButton(item);
  if (!item.disabled) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      closeSubmenus();
      item.onClick?.(e); // pass the MouseEvent so handlers can read modifier keys
      if (item.toggle) setActive(button);
      else if (!item.standalone) el.querySelectorAll("button.active").forEach((b) => b.classList.remove("active"));
      refocus?.(); // the click left focus on <body> — give it back to the map so onKey/Escape works
    });
  }
  item.onRender?.(button); // live DOM wiring (e.g. snapshot icon swap on modifier key)
  return button;
}

/**
 * A submenu: a trigger button (a plain bar button) + a flyout of child buttons. The
 * flyout is appended to `<body>` and `position:fixed`, JS-placed next to the trigger via
 * `getBoundingClientRect` — so it's never clipped (Leaflet's `overflow:hidden`) and is
 * correctly anchored even when the bar is transformed (centred positions). Opens on
 * **hover** (desktop) and **click** (touch). Two modes:
 *
 * - **click** (default): the parent is a fixed category opener with **no action of its
 *   own** unless you give it `onClick`; only the children act.
 * - **toggle** (`toggle: true`, a split button): the parent shows the **selected** child's
 *   icon (first child initially) and becomes the active tool; picking a child runs it and
 *   makes the parent adopt it; clicking the (open) parent re-runs the selected child.
 *
 * Returns the `trigger` (goes in the bar) and the `menu` (tracked by the caller).
 */
function buildSubmenu(
  item: ToolbarItem,
  side: string,
  closeSubmenus: () => void,
  setActive: (btn: HTMLButtonElement) => void,
  refocus?: () => void,
): { trigger: HTMLButtonElement; menu: HTMLElement } {
  const isToggle = item.toggle === true;
  const children = item.children ?? [];
  const sideways = side === "left" || side === "right"; // vertical toolbar ⇒ row flyout

  const trigger = createButton(item);
  trigger.classList.add("dap-submenu-trigger");
  trigger.setAttribute("aria-haspopup", "true");

  const menu = document.createElement("div");
  menu.className = `dap-submenu dap-submenu-${side}`;
  // The flyout follows the bar's orientation: a horizontal bar (top/bottom) opens a
  // vertical column; a vertical bar (left/right) opens a horizontal row.
  menu.style.flexDirection = sideways ? "row" : "column";

  // Toggle mode: the trigger mirrors the currently-selected child (first one initially).
  let selected: ToolbarItem | undefined = children[0];
  const reflect = (): void => {
    if (!isToggle || !selected) return;
    trigger.innerHTML = selected.svg ?? FALLBACK_ICON;
    trigger.title = selected.title;
    trigger.dataset["tool"] = selected.id;
  };
  reflect();

  for (const child of children) {
    const cb = createButton(child);
    if (!child.disabled) {
      cb.addEventListener("click", (e) => {
        e.preventDefault();
        child.onClick?.(e);
        if (isToggle) { selected = child; reflect(); setActive(trigger); } // parent adopts the pick
        closeSubmenus(); // pick one ⇒ collapse
        refocus?.();
      });
    }
    child.onRender?.(cb);
    menu.appendChild(cb);
  }

  // Place the fixed flyout next to the **trigger button** with a uniform gap (viewport
  // coords). Anchoring to the trigger (not the bar) keeps the gap tight whatever padding
  // the engine's control box adds; for `up`/`left` we offset by the flyout's measured
  // size so all four sides get the same gap. (Reads offsetW/H ⇒ the menu is `display:flex`
  // by the time this runs.)
  const place = (): void => {
    if (typeof window === "undefined") return;
    const t = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const gap = 4;
    const s = menu.style;
    s.right = s.bottom = "auto";
    if (side === "up") { s.left = `${t.left}px`; s.top = `${t.top - gap - mh}px`; }
    else if (side === "right") { s.left = `${t.right + gap}px`; s.top = `${t.top}px`; }
    else if (side === "left") { s.left = `${t.left - gap - mw}px`; s.top = `${t.top}px`; }
    else { s.left = `${t.left}px`; s.top = `${t.bottom + gap}px`; } // "down"
  };
  const open = (): void => {
    closeSubmenus();
    if (!menu.isConnected && typeof document !== "undefined") document.body.appendChild(menu);
    menu.classList.add("open");
    place();
  };

  // Hover with a small close delay so moving across the gap into the flyout doesn't close
  // it (the flyout's own mouseenter cancels the pending close).
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = (): void => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; } };
  const scheduleClose = (): void => { cancelClose(); closeTimer = setTimeout(() => menu.classList.remove("open"), 150); };
  trigger.addEventListener("mouseenter", () => { cancelClose(); open(); });
  trigger.addEventListener("mouseleave", scheduleClose);
  menu.addEventListener("mouseenter", cancelClose);
  menu.addEventListener("mouseleave", scheduleClose);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    cancelClose();
    if (!menu.classList.contains("open")) { open(); return; } // closed (touch) ⇒ just open
    // Already open (hovered): a click runs the parent action.
    if (isToggle) { selected?.onClick?.(e); setActive(trigger); }
    else item.onClick?.(e); // click-mode parent: only acts if given an onClick
    refocus?.();
  });

  item.onRender?.(trigger);
  return { trigger, menu };
}
