/**
 * Build a tool toolbar inside an engine-provided container (MapLibre `ctrl-group`
 * / OpenLayers `ol-control` / a plain Leaflet div), so buttons inherit the
 * engine's native control look. Placement/flow via {@link ToolbarOptions}.
 *
 * An item with `children` becomes a **submenu**: clicking its button opens a flyout
 * of the child buttons, positioned *into the map* based on the toolbar edge.
 */
import type { ToolbarItem, ToolbarOptions } from "./index.js";
import { CHROME_SURFACE, CHROME_BORDER, CHROME_SHADOW, CHROME_HOVER, CHROME_INK, CHROME_BTN_PX } from "./chrome.js";

const STYLE_ID = "draw-adapter-toolbar-style";
const TOOLBAR_CLASS = "draw-adapter-toolbar";
/** Engine-stable hook class added to every toolbar container (so shared CSS + `setToolbarActive`
 *  target one selector across MapLibre/OpenLayers/Leaflet). */
const SHARED_CLASS = "dap-toolbar";
/** Default highlight for the active tool button (the former per-engine `#dbeafe`). */
const DEFAULT_ACTIVE_BG = "#dbeafe";

/** Per-container registry: maps every item id (incl. submenu descendants) to its **bar** button, plus
 *  the consumer's `activeStyle`. Lets {@link setToolbarActive} drive the highlight by id. */
const toolbarReg = new WeakMap<HTMLElement, { byId: Map<string, HTMLButtonElement>; activeStyle: ToolbarOptions["activeStyle"] }>();

/** Inline props {@link setToolbarActive} writes for the active state (cleared on deactivate). */
function applyActiveStyle(btn: HTMLElement, s: ToolbarOptions["activeStyle"]): void {
  btn.style.background = s?.background ?? DEFAULT_ACTIVE_BG;
  if (s?.color) btn.style.color = s.color;
  if (s?.outline) btn.style.outline = s.outline;
  if (s?.boxShadow) btn.style.boxShadow = s.boxShadow;
}
function clearActiveStyle(btn: HTMLElement): void {
  btn.style.background = ""; btn.style.color = ""; btn.style.outline = ""; btn.style.boxShadow = "";
}

/**
 * Set (or clear) the **active** tool highlight on a toolbar built by {@link populateToolbar}.
 * Consumer-driven: `id` = a `ToolbarItem` id → its bar button (a submenu/toggle descendant id marks
 * its parent bar trigger); `null` → clear. One active at a time; idempotent. The highlight is applied
 * inline (default `#dbeafe`, overridable via `ToolbarOptions.activeStyle`) so it wins uniformly on all
 * three engines regardless of their own button CSS. No-op if `el` isn't a known toolbar.
 */
export function setToolbarActive(el: HTMLElement, id: string | null): void {
  const reg = toolbarReg.get(el);
  el.querySelectorAll<HTMLElement>("button.active").forEach((b) => { b.classList.remove("active"); clearActiveStyle(b); });
  if (id == null) return;
  const btn = reg?.byId.get(id);
  if (!btn) return;
  btn.classList.add("active");
  applyActiveStyle(btn, reg?.activeStyle);
}

/** Collect an item's id + all its (recursive) submenu descendant ids — all map to the same bar button. */
function collectIds(item: ToolbarItem, acc: string[]): void {
  acc.push(item.id);
  for (const c of item.children ?? []) collectIds(c, acc);
}

/** Neutral placeholder icon used when a {@link ToolbarItem} provides no `svg`. */
const FALLBACK_ICON =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>`;

/** The four directions a flyout can open toward (relative to its trigger). */
type Side = "down" | "up" | "right" | "left";

/** Toolbar edge → the side the **first** submenu flyout opens toward (always into the map). */
const SUBMENU_SIDE: Record<string, Side> = {
  top: "down",
  bottom: "up",
  left: "right",
  right: "left",
};

/**
 * Direction for the **next** nesting level: it flips the axis so menus zig-zag (a vertical
 * column spawns rows, a horizontal row spawns columns). With a top bar that's the requested
 * `toolbar (h) → submenu (v) → sub-submenu (h) → …` — and it keeps alternating to any depth.
 */
const ALTERNATE: Record<Side, Side> = { down: "right", up: "right", right: "down", left: "down" };

function ensureToolbarStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `.${TOOLBAR_CLASS} button svg{display:block;margin:auto}` +
    `.${TOOLBAR_CLASS} button{color:${CHROME_INK}}` +
    `.${TOOLBAR_CLASS} button:disabled{opacity:.28;filter:grayscale(1);cursor:not-allowed}` +
    // A mouse click leaves the button focused; drop the focus ring then (it reads as "selected"),
    // but KEEP it for keyboard focus (`:focus-visible`) for accessibility. The active-tool highlight
    // is the `.active` class, applied by `setToolbarActive` (consumer-driven), not by focus.
    `.${SHARED_CLASS} button:focus:not(:focus-visible){outline:none}` +
    // Submenu: the trigger is a plain bar button (no wrapper → native first/last-child
    // styling intact). The flyout is appended to <body> and `position:fixed`, JS-placed
    // next to the trigger via getBoundingClientRect — so it's never clipped (Leaflet's
    // `overflow:hidden`) nor mis-anchored by a transformed toolbar (centred positions).
    `.dap-submenu{position:fixed;display:none;flex-direction:column;background:${CHROME_SURFACE};` +
    `border:${CHROME_BORDER};border-radius:4px;box-shadow:${CHROME_SHADOW};overflow:hidden;z-index:1000}` +
    `.dap-submenu.open{display:flex}` +
    `.dap-submenu button{position:relative;color:${CHROME_INK};background:${CHROME_SURFACE};border:0;width:${CHROME_BTN_PX}px;height:${CHROME_BTN_PX}px;cursor:pointer;padding:0}` +
    `.dap-submenu button svg{display:block;margin:auto}` +
    `.dap-submenu button:hover{background:${CHROME_HOVER}}` +
    `.dap-submenu button:disabled{opacity:.28;filter:grayscale(1);cursor:not-allowed}` +
    // A nested-submenu trigger (a submenu sitting *inside* a flyout) shows a little chevron
    // pointing the way its own flyout opens — set per-trigger via a `dap-sub-<side>` class.
    `.dap-submenu .dap-submenu-trigger::after{content:"";position:absolute;width:0;height:0;opacity:.5}` +
    `.dap-submenu .dap-sub-right::after{right:2px;top:50%;transform:translateY(-50%);border:3px solid transparent;border-left-color:currentColor}` +
    `.dap-submenu .dap-sub-left::after{left:2px;top:50%;transform:translateY(-50%);border:3px solid transparent;border-right-color:currentColor}` +
    `.dap-submenu .dap-sub-down::after{bottom:2px;left:50%;transform:translateX(-50%);border:3px solid transparent;border-top-color:currentColor}` +
    `.dap-submenu .dap-sub-up::after{top:2px;left:50%;transform:translateX(-50%);border:3px solid transparent;border-bottom-color:currentColor}`;
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
  button.firstElementChild?.setAttribute("aria-hidden", "true"); // the button carries the accessible name; the glyph is decorative
  if (item.disabled) button.disabled = true;
  return button;
}

export function populateToolbar(el: HTMLElement, items: ToolbarItem[], options?: ToolbarOptions, refocus?: () => void): void {
  el.classList.add(TOOLBAR_CLASS, SHARED_CLASS);
  ensureToolbarStyle();
  applyToolbarLayout(el, options);

  const order = options?.tools;
  const shown = order
    ? order.map((id) => items.find((it) => it.id === id)).filter((it): it is ToolbarItem => it != null)
    : items;

  const side = SUBMENU_SIDE[(options?.position ?? "top-left").split("-")[0]!] ?? "down";

  // Flyouts (at every nesting depth) live in <body>, not in `el`, so we track them all here
  // for hierarchical open/close and for teardown.
  const menus: HTMLElement[] = [];
  // Open `node` (and its ancestors) while collapsing every *other* branch — so a cascade
  // shows exactly one path. Ancestors are placed first (a nested flyout anchors to its
  // trigger, which lives inside the parent flyout, so the parent must be positioned already).
  const openOnly = (node: SubmenuNode): void => {
    const chain: SubmenuNode[] = [];
    for (let n: SubmenuNode | undefined = node; n; n = n.parent) chain.unshift(n); // root → leaf
    const keep = new Set(chain.map((n) => n.menu));
    for (const m of menus) if (!keep.has(m)) m.classList.remove("open");
    for (const n of chain) {
      if (!n.menu.isConnected && typeof document !== "undefined") document.body.appendChild(n.menu);
      n.menu.classList.add("open");
    }
    for (const n of chain) n.place();
  };
  const ctx: MenuCtx = {
    registerMenu: (m) => menus.push(m),
    closeAll: () => { for (const m of menus) m.classList.remove("open"); },
    openOnly,
    ...(refocus ? { refocus } : {}),
  };

  // Index every id (incl. submenu descendants) → its bar button, so `setToolbarActive(id)` can
  // highlight the right bar element (a child id marks its parent trigger).
  const byId = new Map<string, HTMLButtonElement>();
  for (const item of shown) {
    const barBtn = item.children?.length
      ? buildSubmenu(item, side, ctx).trigger
      : buildButton(item, ctx.closeAll, refocus);
    el.appendChild(barBtn);
    const ids: string[] = [];
    collectIds(item, ids);
    for (const id of ids) byId.set(id, barBtn);
  }
  toolbarReg.set(el, { byId, activeStyle: options?.activeStyle });

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
      ctx.closeAll();
    };
    document.addEventListener("pointerdown", onDocDown, true);
  }
}

/** A leaf (non-submenu) tool button, fully wired. The active highlight is **not** set here — it's
 *  consumer-driven via {@link setToolbarActive} (so a click never leaves a sticky `.active`). */
function buildButton(
  item: ToolbarItem,
  closeSubmenus: () => void,
  refocus?: () => void,
): HTMLButtonElement {
  const button = createButton(item);
  if (!item.disabled) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      closeSubmenus();
      item.onClick?.(e); // pass the MouseEvent so handlers can read modifier keys
      refocus?.(); // the click left focus on <body> — give it back to the map so onKey/Escape works
    });
  }
  item.onRender?.(button); // live DOM wiring (e.g. snapshot icon swap on modifier key)
  return button;
}

/** A node in the submenu cascade: its trigger button, its flyout, and its tree links. */
interface SubmenuNode {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  parent?: SubmenuNode | undefined;
  children: SubmenuNode[];
  closeTimer?: ReturnType<typeof setTimeout> | undefined;
  /** (Re)position the flyout next to its trigger. */
  place(): void;
}

/** Shared services a submenu needs from the toolbar that owns it. */
interface MenuCtx {
  /** Track a flyout for outside-close + teardown. */
  registerMenu(menu: HTMLElement): void;
  /** Collapse the whole cascade (every depth). */
  closeAll(): void;
  /** Open this branch, collapsing the others. */
  openOnly(node: SubmenuNode): void;
  refocus?: () => void;
}

/**
 * Build a submenu (recursively). A submenu is a trigger button + a flyout of child buttons;
 * a child that itself has `children` becomes a **nested submenu** whose flyout opens on the
 * *flipped* axis ({@link ALTERNATE}), so menus zig-zag — `bar (h) → v → h → …` to any depth.
 *
 * Each flyout is appended to `<body>` and `position:fixed`, JS-placed next to its trigger via
 * `getBoundingClientRect` — never clipped (Leaflet's `overflow:hidden`) and correctly anchored
 * even when the bar is transformed (centred positions). Opens on **hover** (desktop) and
 * **click** (touch). Two modes (apply at each level independently):
 *
 * - **click** (default): the parent is a fixed category opener with **no action of its own**
 *   unless you give it `onClick`; only its leaves act.
 * - **toggle** (`toggle: true`, a split button): the parent shows the **selected** child's icon
 *   (first child initially) and becomes the active tool; picking a child runs it and makes the
 *   parent adopt it; clicking the (open) parent re-runs the selected child.
 *
 * `parent`/`top` thread the cascade together (`top` is the bar trigger to highlight as active).
 * Returns this node; the caller puts `node.trigger` in the bar (or in the parent's flyout).
 */
function buildSubmenu(
  item: ToolbarItem,
  side: Side,
  ctx: MenuCtx,
  parent?: SubmenuNode,
  top?: HTMLButtonElement,
): SubmenuNode {
  const isToggle = item.toggle === true;
  const items = item.children ?? [];
  const sideways = side === "left" || side === "right"; // opening sideways ⇒ row flyout

  const trigger = createButton(item);
  trigger.classList.add("dap-submenu-trigger");
  trigger.setAttribute("aria-haspopup", "true");

  const menu = document.createElement("div");
  menu.className = `dap-submenu dap-submenu-${side}`;
  // A flyout opening up/down is a vertical column; one opening left/right is a horizontal row.
  menu.style.flexDirection = sideways ? "row" : "column";
  ctx.registerMenu(menu);

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

  const node: SubmenuNode = { trigger, menu, parent, children: [], place };
  const barBtn = top ?? trigger; // the bar trigger that wears the "active" highlight

  // Toggle mode: the trigger mirrors the currently-selected child (first one initially).
  let selected: ToolbarItem | undefined = items[0];
  const reflect = (): void => {
    if (!isToggle || !selected) return;
    trigger.innerHTML = selected.svg ?? FALLBACK_ICON;
    trigger.title = selected.title;
    trigger.dataset["tool"] = selected.id;
  };
  reflect();

  for (const child of items) {
    if (child.children?.length) {
      // A nested submenu: its flyout opens on the flipped axis. The chevron on the trigger
      // hints at that direction.
      const childSide = ALTERNATE[side];
      const sub = buildSubmenu(child, childSide, ctx, node, barBtn);
      sub.trigger.classList.add(`dap-sub-${childSide}`);
      node.children.push(sub);
      menu.appendChild(sub.trigger);
    } else {
      const cb = createButton(child);
      if (!child.disabled) {
        cb.addEventListener("click", (e) => {
          e.preventDefault();
          child.onClick?.(e);
          if (isToggle) { selected = child; reflect(); } // parent adopts the pick's icon (highlight is consumer-driven)
          ctx.closeAll(); // pick a leaf ⇒ collapse the whole cascade
          ctx.refocus?.();
        });
      }
      child.onRender?.(cb);
      menu.appendChild(cb);
    }
  }

  // Hover with a small close delay so crossing the gap into the (or a nested) flyout doesn't
  // close it. Entering a flyout cancels the pending close of itself AND its ancestors, so a
  // deep cascade survives the gaps between levels.
  const cancelClose = (): void => { if (node.closeTimer) { clearTimeout(node.closeTimer); node.closeTimer = undefined; } };
  const cancelChainClose = (): void => { for (let n: SubmenuNode | undefined = node; n; n = n.parent) { if (n.closeTimer) { clearTimeout(n.closeTimer); n.closeTimer = undefined; } } };
  const closeSelfAndChildren = (n: SubmenuNode): void => { n.menu.classList.remove("open"); for (const c of n.children) closeSelfAndChildren(c); };
  const scheduleClose = (): void => { cancelClose(); node.closeTimer = setTimeout(() => closeSelfAndChildren(node), 150); };
  trigger.addEventListener("mouseenter", () => { cancelChainClose(); ctx.openOnly(node); });
  trigger.addEventListener("mouseleave", scheduleClose);
  menu.addEventListener("mouseenter", cancelChainClose);
  menu.addEventListener("mouseleave", scheduleClose);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    cancelChainClose();
    if (!menu.classList.contains("open")) { ctx.openOnly(node); return; } // closed (touch) ⇒ just open
    // Already open (hovered): a click runs the parent action.
    if (isToggle) selected?.onClick?.(e);
    else item.onClick?.(e); // click-mode parent: only acts if given an onClick
    ctx.refocus?.();
  });

  item.onRender?.(trigger);
  return node;
}
