// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyToolbarLayout, populateToolbar } from "../src/toolbar.js";
import type { ToolbarItem, ToolbarOptions } from "../src/index.js";

const layout = (position: ToolbarOptions["position"]): CSSStyleDeclaration => {
  const el = document.createElement("div");
  applyToolbarLayout(el, position ? { position } : undefined);
  return el.style;
};

describe("applyToolbarLayout — anchored edges for the 12 positions", () => {
  it("top-left", () => { const s = layout("top-left"); expect(s.top).toBe("10px"); expect(s.left).toBe("10px"); });
  it("top-right", () => { const s = layout("top-right"); expect(s.top).toBe("10px"); expect(s.right).toBe("10px"); });
  it("top (centred)", () => { const s = layout("top"); expect(s.top).toBe("10px"); expect(s.left).toBe("50%"); expect(s.transform).toContain("translateX"); });
  it("bottom-left", () => { const s = layout("bottom-left"); expect(s.bottom).toBe("10px"); expect(s.left).toBe("10px"); });
  it("bottom-right", () => { const s = layout("bottom-right"); expect(s.bottom).toBe("10px"); expect(s.right).toBe("10px"); });
  it("bottom (centred)", () => { const s = layout("bottom"); expect(s.bottom).toBe("10px"); expect(s.left).toBe("50%"); });
  it("left-top", () => { const s = layout("left-top"); expect(s.left).toBe("10px"); expect(s.top).toBe("10px"); });
  it("left-bottom", () => { const s = layout("left-bottom"); expect(s.left).toBe("10px"); expect(s.bottom).toBe("10px"); });
  it("left (centred)", () => { const s = layout("left"); expect(s.left).toBe("10px"); expect(s.top).toBe("50%"); expect(s.transform).toContain("translateY"); });
  it("right-top", () => { const s = layout("right-top"); expect(s.right).toBe("10px"); expect(s.top).toBe("10px"); });
  it("right-bottom", () => { const s = layout("right-bottom"); expect(s.right).toBe("10px"); expect(s.bottom).toBe("10px"); });
  it("right (centred)", () => { const s = layout("right"); expect(s.right).toBe("10px"); expect(s.top).toBe("50%"); });
  it("defaults to top-left", () => { const s = layout(undefined); expect(s.top).toBe("10px"); expect(s.left).toBe("10px"); });
});

describe("applyToolbarLayout — flow derived from the edge", () => {
  it("horizontal edge (top/bottom) ⇒ row", () => {
    expect(layout("top").flexDirection).toBe("row");
    expect(layout("bottom-right").flexDirection).toBe("row");
  });
  it("vertical edge (left/right) ⇒ column", () => {
    expect(layout("left").flexDirection).toBe("column");
    expect(layout("right-top").flexDirection).toBe("column");
  });
  it("per-side padding object", () => {
    const el = document.createElement("div");
    applyToolbarLayout(el, { position: "top-left", padding: { top: "4px", left: "8px" } });
    expect(el.style.top).toBe("4px");
    expect(el.style.left).toBe("8px");
  });
  it("custom class is added", () => {
    const el = document.createElement("div");
    applyToolbarLayout(el, { className: "foo bar" });
    expect(el.classList.contains("foo")).toBe(true);
    expect(el.classList.contains("bar")).toBe(true);
  });
});

const mkItems = (): ToolbarItem[] => [
  { id: "circle", title: "Circle", svg: "<svg></svg>", toggle: true, onClick: vi.fn() },
  { id: "polygon", title: "Polygon", svg: "<svg></svg>", toggle: true, onClick: vi.fn() },
  { id: "clear", title: "Clear", svg: "<svg></svg>", onClick: vi.fn() },
];

describe("populateToolbar", () => {
  it("renders a button per item with its svg + aria-label", () => {
    const el = document.createElement("div");
    const items = mkItems();
    populateToolbar(el, items);
    const btns = el.querySelectorAll("button");
    expect(btns).toHaveLength(3);
    expect(btns[0]!.innerHTML).toBe("<svg></svg>");
    expect(btns[0]!.dataset["tool"]).toBe("circle");
    expect(btns[0]!.getAttribute("aria-label")).toBe("Circle");
  });

  it("falls back to a placeholder icon when an item has no svg", () => {
    const el = document.createElement("div");
    populateToolbar(el, [{ id: "x", title: "X", onClick: vi.fn() }]);
    expect(el.querySelector("button svg")).not.toBeNull();
  });

  it("honours the `tools` order/subset", () => {
    const el = document.createElement("div");
    populateToolbar(el, mkItems(), { tools: ["polygon", "circle"] });
    const ids = [...el.querySelectorAll("button")].map((b) => (b as HTMLButtonElement).dataset["tool"]);
    expect(ids).toEqual(["polygon", "circle"]);
  });

  it("fires onClick and toggles the active class for toggle tools", () => {
    const el = document.createElement("div");
    const items = mkItems();
    populateToolbar(el, items);
    const [circleBtn, , clearBtn] = [...el.querySelectorAll("button")] as HTMLButtonElement[];
    circleBtn!.click();
    expect(items[0]!.onClick).toHaveBeenCalledOnce();
    expect(circleBtn!.classList.contains("active")).toBe(true);
    // A non-toggle tool clears the active state.
    clearBtn!.click();
    expect(items[2]!.onClick).toHaveBeenCalledOnce();
    expect(el.querySelector("button.active")).toBeNull();
  });
});

describe("populateToolbar — submenus (flyout)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  const withChildren = (): ToolbarItem => ({
    id: "text",
    title: "Text tools",
    svg: "<svg id='t'></svg>",
    children: [
      { id: "label", title: "Label", svg: "<svg id='l'></svg>", onClick: vi.fn() },
      { id: "box", title: "Box", svg: "<svg id='b'></svg>", onClick: vi.fn() },
    ],
  });
  // The flyout lives in <body>, appended on open. `menu()` returns the (single) one.
  const menu = (): HTMLElement => document.querySelector(".dap-submenu")!;

  it("puts a native trigger button in the bar; the flyout is created in <body> on open", () => {
    const el = document.createElement("div");
    populateToolbar(el, [withChildren()]);
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    expect(trigger.dataset["tool"]).toBe("text");
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
    expect(el.querySelector(".dap-submenu-host")).toBeNull(); // no wrapper in the bar
    expect(document.querySelector(".dap-submenu")).toBeNull(); // not until opened
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(menu().parentElement).toBe(document.body);
    expect(menu().classList.contains("open")).toBe(true);
    expect(menu().querySelectorAll("button")).toHaveLength(2);
  });

  it("opens on hovering the trigger; closes shortly after leaving", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    populateToolbar(el, [withChildren()]);
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(menu().classList.contains("open")).toBe(true);
    trigger.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(200);
    expect(menu().classList.contains("open")).toBe(false);
    vi.useRealTimers();
  });

  it("stays open while crossing from the trigger into the flyout (gap bridge)", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    populateToolbar(el, [withChildren()]);
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    trigger.dispatchEvent(new MouseEvent("mouseleave")); // entering the gap
    vi.advanceTimersByTime(50);
    menu().dispatchEvent(new MouseEvent("mouseenter")); // reached the flyout in time
    vi.advanceTimersByTime(300);
    expect(menu().classList.contains("open")).toBe(true); // not closed
    menu().dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(200);
    expect(menu().classList.contains("open")).toBe(false);
    vi.useRealTimers();
  });

  it("click-mode pure: the parent has NO action; only children act", () => {
    const el = document.createElement("div");
    populateToolbar(el, [withChildren()]); // no parent onClick
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    trigger.click(); // closed ⇒ opens
    expect(menu().classList.contains("open")).toBe(true);
    expect(() => trigger.click()).not.toThrow(); // open ⇒ no parent action, no error
  });

  it("click-mode: an optional parent onClick runs when the open parent is clicked", () => {
    const el = document.createElement("div");
    const item = { ...withChildren(), onClick: vi.fn() };
    populateToolbar(el, [item]);
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    trigger.click(); // open
    expect(item.onClick).not.toHaveBeenCalled();
    trigger.click(); // already open ⇒ parent action
    expect(item.onClick).toHaveBeenCalledOnce();
  });

  it("toggle-mode (split): parent reflects the selected child; picking adopts it; parent click re-runs it", () => {
    const el = document.createElement("div");
    const item: ToolbarItem = {
      id: "text", title: "Text", toggle: true,
      children: [
        { id: "one", title: "One", svg: "<svg data-k='one'></svg>", onClick: vi.fn() },
        { id: "two", title: "Two", svg: "<svg data-k='two'></svg>", onClick: vi.fn() },
      ],
    };
    populateToolbar(el, [item]);
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    // parent shows the FIRST child by default
    expect(trigger.dataset["tool"]).toBe("one");
    expect(trigger.innerHTML).toContain('data-k="one"');
    // open (hover) + pick the second child ⇒ its onClick fires, parent adopts it + active
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    menu().querySelector<HTMLButtonElement>('button[data-tool="two"]')!.click();
    expect(item.children![1]!.onClick).toHaveBeenCalledOnce();
    expect(trigger.dataset["tool"]).toBe("two");
    expect(trigger.innerHTML).toContain('data-k="two"');
    expect(trigger.classList.contains("active")).toBe(true);
    // clicking the (open) parent re-runs the SELECTED child's action
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    trigger.click();
    expect(item.children![1]!.onClick).toHaveBeenCalledTimes(2);
  });

  it("picking a child fires its onClick and closes the flyout", () => {
    const el = document.createElement("div");
    const item = withChildren();
    populateToolbar(el, [item]);
    el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!.click(); // open
    menu().querySelector<HTMLButtonElement>('button[data-tool="label"]')!.click();
    expect(item.children![0]!.onClick).toHaveBeenCalledOnce();
    expect(menu().classList.contains("open")).toBe(false);
  });

  it("opens toward the map — the toolbar edge picks the flyout side", () => {
    const side = (position: ToolbarOptions["position"]): string => {
      document.body.innerHTML = "";
      const el = document.createElement("div");
      populateToolbar(el, [withChildren()], position ? { position } : undefined);
      el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!.click(); // open ⇒ menu in body
      return menu().className;
    };
    expect(side("top-left")).toContain("dap-submenu-down");
    expect(side("bottom-right")).toContain("dap-submenu-up");
    expect(side("left-top")).toContain("dap-submenu-right");
    expect(side("right")).toContain("dap-submenu-left");
  });

  it("a press outside the toolbar (and outside the flyout) closes it", () => {
    const el = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(el, outside);
    populateToolbar(el, [withChildren()]);
    el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!.click(); // open
    expect(menu().classList.contains("open")).toBe(true);
    menu().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); // inside flyout ⇒ stays
    expect(menu().classList.contains("open")).toBe(true);
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); // outside ⇒ closes
    expect(menu().classList.contains("open")).toBe(false);
  });
});

describe("populateToolbar — refocus the map after an action", () => {
  it("calls the refocus callback after a button's onClick", () => {
    const el = document.createElement("div");
    const refocus = vi.fn();
    const onClick = vi.fn();
    const item: ToolbarItem = { id: "cb", title: "CB", svg: "<svg/>", onClick };
    populateToolbar(el, [item], undefined, refocus);
    (el.querySelector('button[data-tool="cb"]') as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(refocus).toHaveBeenCalledOnce();
  });
});
