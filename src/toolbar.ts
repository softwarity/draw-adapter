/**
 * Build a tool toolbar inside an engine-provided container (MapLibre `ctrl-group`
 * / OpenLayers `ol-control` / a plain Leaflet div), so buttons inherit the
 * engine's native control look. Placement/flow via {@link ToolbarOptions}.
 */
import type { ToolbarItem, ToolbarOptions } from "./index.js";

const STYLE_ID = "draw-adapter-toolbar-style";
const TOOLBAR_CLASS = "draw-adapter-toolbar";

function ensureToolbarStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `.${TOOLBAR_CLASS} button svg{display:block;margin:auto}` +
    `.${TOOLBAR_CLASS} button{color:#24292f}` +
    `.${TOOLBAR_CLASS} button:disabled{opacity:.28;filter:grayscale(1);cursor:not-allowed}`;
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
  const vertical = opts?.orientation === "vertical" || (opts?.orientation == null && !horizontal);
  el.style.flexDirection = vertical ? "column" : "row";
  el.style.gap = opts?.gap ?? "";
  if (opts?.className) el.classList.add(...opts.className.split(/\s+/).filter(Boolean));
}

export function populateToolbar(el: HTMLElement, items: ToolbarItem[], options?: ToolbarOptions): void {
  el.classList.add(TOOLBAR_CLASS);
  ensureToolbarStyle();
  applyToolbarLayout(el, options);

  const order = options?.tools;
  const shown = order
    ? order.map((id) => items.find((it) => it.id === id)).filter((it): it is ToolbarItem => it != null)
    : items;

  const setActive = (btn: HTMLButtonElement) => {
    el.querySelectorAll("button.active").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  };

  for (const item of shown) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["tool"] = item.id;
    button.title = item.title;
    button.setAttribute("aria-label", item.title);
    if (item.svg) button.innerHTML = item.svg;
    else button.textContent = item.label;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      item.onClick();
      if (item.toggle) setActive(button);
      else el.querySelectorAll("button.active").forEach((b) => b.classList.remove("active"));
    });
    el.appendChild(button);
  }
}
