// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyToolbarLayout, populateToolbar, setToolbarActive } from "../src/toolbar.js";
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
    const svg = btns[0]!.querySelector("svg")!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("aria-hidden")).toBe("true"); // glyph decorative; the button carries the name
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

  it("fires onClick but does NOT set a sticky `.active` (highlight is consumer-driven now)", () => {
    const el = document.createElement("div");
    const items = mkItems();
    populateToolbar(el, items);
    const [circleBtn, , clearBtn] = [...el.querySelectorAll("button")] as HTMLButtonElement[];
    circleBtn!.click();
    expect(items[0]!.onClick).toHaveBeenCalledOnce();
    expect(circleBtn!.classList.contains("active")).toBe(false); // no auto-highlight on click
    clearBtn!.click();
    expect(items[2]!.onClick).toHaveBeenCalledOnce();
    expect(el.querySelector("button.active")).toBeNull();
  });
});

describe("populateToolbar — submenus (flyout)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("the submenu chrome CSS interpolates the shared tokens to their original values (no drift)", () => {
    populateToolbar(document.createElement("div"), [{ id: "a", title: "A", children: [{ id: "b", title: "B", onClick() {} }] }]);
    const css = document.getElementById("draw-adapter-toolbar-style")!.textContent!;
    expect(css).toContain(".dap-submenu{position:fixed;display:none;flex-direction:column;background:#fff;");
    expect(css).toContain("border:1px solid rgba(0,0,0,.15);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.3)");
    expect(css).toContain("width:30px;height:30px");
    expect(css).toContain(".dap-submenu button:hover{background:#f4f4f4}");
  });

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
    // open (hover) + pick the second child ⇒ its onClick fires, parent adopts its ICON (highlight is
    // consumer-driven, so the trigger does NOT auto-gain `.active`)
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    menu().querySelector<HTMLButtonElement>('button[data-tool="two"]')!.click();
    expect(item.children![1]!.onClick).toHaveBeenCalledOnce();
    expect(trigger.dataset["tool"]).toBe("two");
    expect(trigger.innerHTML).toContain('data-k="two"');
    expect(trigger.classList.contains("active")).toBe(false); // icon mirror ✓, but no auto-highlight
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

describe("populateToolbar — nested submenus (sub-sub-menu, alternating direction)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  // A bar → submenu → sub-submenu tree. Leaf `deep` lives two levels down.
  const nested = (leafClick = vi.fn()): { item: ToolbarItem; leafClick: ReturnType<typeof vi.fn> } => ({
    leafClick,
    item: {
      id: "root", title: "Root", svg: "<svg/>",
      children: [
        { id: "leaf1", title: "Leaf 1", svg: "<svg/>", onClick: vi.fn() },
        {
          id: "branch", title: "Branch", svg: "<svg/>",
          children: [
            { id: "deep", title: "Deep", svg: "<svg/>", onClick: leafClick },
            { id: "deep2", title: "Deep 2", svg: "<svg/>", onClick: vi.fn() },
          ],
        },
      ],
    },
  });
  // All flyouts (every depth) share the `.dap-submenu` class; identify them by their `-side` class.
  const menuBySide = (side: string): HTMLElement | null => document.querySelector(`.dap-submenu-${side}`);

  it("a child with its own children becomes a nested submenu trigger inside the flyout", () => {
    const el = document.createElement("div");
    populateToolbar(el, [nested().item]);
    el.querySelector<HTMLButtonElement>('button[data-tool="root"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const firstFlyout = menuBySide("down")!; // top bar ⇒ first submenu opens "down" (a column)
    const branchTrigger = firstFlyout.querySelector<HTMLButtonElement>('button[data-tool="branch"]')!;
    expect(branchTrigger.classList.contains("dap-submenu-trigger")).toBe(true);
    expect(branchTrigger.getAttribute("aria-haspopup")).toBe("true");
    expect(branchTrigger.classList.contains("dap-sub-right")).toBe(true); // its chevron points the way it opens
  });

  it("the sub-submenu opens on the flipped axis: bar(row) → submenu(column,down) → sub(row,right)", () => {
    const el = document.createElement("div");
    populateToolbar(el, [nested().item], { position: "top-left" });
    el.querySelector<HTMLButtonElement>('button[data-tool="root"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const firstFlyout = menuBySide("down")!;
    expect(firstFlyout.style.flexDirection).toBe("column"); // vertical
    firstFlyout.querySelector<HTMLButtonElement>('button[data-tool="branch"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const subFlyout = menuBySide("right")!;
    expect(subFlyout).not.toBeNull();
    expect(subFlyout.classList.contains("open")).toBe(true);
    expect(subFlyout.style.flexDirection).toBe("row"); // horizontal — flipped from its parent
  });

  it("opening a sibling branch collapses the other; ancestors stay open", () => {
    const el = document.createElement("div");
    const item: ToolbarItem = {
      id: "root", title: "Root", svg: "<svg/>",
      children: [
        { id: "a", title: "A", children: [{ id: "a1", title: "A1", onClick: vi.fn() }] },
        { id: "b", title: "B", children: [{ id: "b1", title: "B1", onClick: vi.fn() }] },
      ],
    };
    populateToolbar(el, [item]);
    el.querySelector<HTMLButtonElement>('button[data-tool="root"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const first = menuBySide("down")!;
    first.querySelector<HTMLButtonElement>('button[data-tool="a"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const aMenu = [...document.querySelectorAll<HTMLElement>(".dap-submenu-right")].find((m) => m.querySelector('[data-tool="a1"]'))!;
    expect(aMenu.classList.contains("open")).toBe(true);
    // hover the sibling B ⇒ A's flyout closes, but the first-level flyout (their ancestor) stays open
    first.querySelector<HTMLButtonElement>('button[data-tool="b"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const bMenu = [...document.querySelectorAll<HTMLElement>(".dap-submenu-right")].find((m) => m.querySelector('[data-tool="b1"]'))!;
    expect(aMenu.classList.contains("open")).toBe(false);
    expect(bMenu.classList.contains("open")).toBe(true);
    expect(first.classList.contains("open")).toBe(true);
  });

  it("picking a deep leaf fires its onClick and collapses the whole cascade", () => {
    const el = document.createElement("div");
    const { item, leafClick } = nested();
    populateToolbar(el, [item]);
    el.querySelector<HTMLButtonElement>('button[data-tool="root"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    menuBySide("down")!.querySelector<HTMLButtonElement>('button[data-tool="branch"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const sub = menuBySide("right")!;
    sub.querySelector<HTMLButtonElement>('button[data-tool="deep"]')!.click();
    expect(leafClick).toHaveBeenCalledOnce();
    // every flyout collapsed
    expect([...document.querySelectorAll(".dap-submenu.open")]).toHaveLength(0);
  });

  it("moving across the gap from a sub-trigger into the sub-flyout keeps the whole chain open", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    populateToolbar(el, [nested().item]);
    el.querySelector<HTMLButtonElement>('button[data-tool="root"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const first = menuBySide("down")!;
    const branchTrigger = first.querySelector<HTMLButtonElement>('button[data-tool="branch"]')!;
    branchTrigger.dispatchEvent(new MouseEvent("mouseenter"));
    const sub = menuBySide("right")!;
    // leave the first flyout entirely (cross the gap toward the sub-flyout)
    first.dispatchEvent(new MouseEvent("mouseleave"));
    branchTrigger.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(50);
    sub.dispatchEvent(new MouseEvent("mouseenter")); // reached the sub-flyout in time
    vi.advanceTimersByTime(300);
    expect(first.classList.contains("open")).toBe(true); // ancestor not closed
    expect(sub.classList.contains("open")).toBe(true);
    vi.useRealTimers();
  });

  it("arbitrary depth keeps alternating (h → v → h → v)", () => {
    const el = document.createElement("div");
    const item: ToolbarItem = {
      id: "l0", title: "L0", children: [
        { id: "l1", title: "L1", children: [
          { id: "l2", title: "L2", children: [
            { id: "l3", title: "L3", onClick: vi.fn() },
          ] },
        ] },
      ],
    };
    populateToolbar(el, [item]);
    el.querySelector<HTMLButtonElement>('button[data-tool="l0"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    menuBySide("down")!.querySelector<HTMLButtonElement>('button[data-tool="l1"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    menuBySide("right")!.querySelector<HTMLButtonElement>('button[data-tool="l2"]')!.dispatchEvent(new MouseEvent("mouseenter"));
    const deepest = menuBySide("down"); // level 3 flips back to "down"
    // two flyouts now carry the "down" side class (level 1 and level 3); the deepest is open
    expect([...document.querySelectorAll(".dap-submenu-down.open")].length).toBeGreaterThanOrEqual(2);
    expect(deepest).not.toBeNull();
  });
});

describe("setToolbarActive — consumer-driven active-tool highlight", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const items: ToolbarItem[] = [
    { id: "circle", title: "Circle", svg: "<svg/>", onClick: vi.fn() },
    { id: "shapes", title: "Shapes", svg: "<svg/>", children: [
      { id: "rect", title: "Rect", svg: "<svg/>", onClick: vi.fn() },
      { id: "poly", title: "Poly", svg: "<svg/>", onClick: vi.fn() },
    ] },
  ];
  const barBtn = (el: HTMLElement, tool: string): HTMLButtonElement | null =>
    [...el.querySelectorAll("button")].find((b) => (b as HTMLButtonElement).dataset["tool"] === tool) as HTMLButtonElement ?? null;

  it("highlights a leaf tool by id (class + default #dbeafe background), and clears with null", () => {
    const el = document.createElement("div");
    populateToolbar(el, items);
    setToolbarActive(el, "circle");
    const b = barBtn(el, "circle")!;
    expect(b.classList.contains("active")).toBe(true);
    expect(b.style.background).toBe("rgb(219, 234, 254)"); // #dbeafe, applied inline ⇒ wins on every engine
    setToolbarActive(el, null);
    expect(el.querySelector("button.active")).toBeNull();
    expect(b.style.background).toBe(""); // inline highlight removed
  });

  it("only one button is active at a time", () => {
    const el = document.createElement("div");
    populateToolbar(el, items);
    setToolbarActive(el, "circle");
    setToolbarActive(el, "shapes");
    expect(el.querySelectorAll("button.active")).toHaveLength(1);
    expect(barBtn(el, "circle")!.classList.contains("active")).toBe(false);
  });

  it("a submenu child id highlights its parent BAR trigger", () => {
    const el = document.createElement("div");
    populateToolbar(el, items);
    setToolbarActive(el, "poly"); // a child of the "shapes" submenu
    const trigger = el.querySelector<HTMLButtonElement>("button.dap-submenu-trigger")!;
    expect(trigger.classList.contains("active")).toBe(true); // the bar trigger, not a flyout button
  });

  it("ToolbarOptions.activeStyle overrides the default appearance", () => {
    const el = document.createElement("div");
    populateToolbar(el, items, { activeStyle: { background: "#ffedd5", outline: "2px solid #e8731a" } });
    setToolbarActive(el, "circle");
    const b = barBtn(el, "circle")!;
    expect(b.style.background).toBe("rgb(255, 237, 213)"); // #ffedd5
    expect(b.style.outline).toBe("2px solid #e8731a");
  });

  it("a click does NOT set active (it's consumer-driven)", () => {
    const el = document.createElement("div");
    populateToolbar(el, items);
    barBtn(el, "circle")!.click();
    expect(el.querySelector("button.active")).toBeNull();
  });

  it("the container carries the engine-stable `dap-toolbar` hook class", () => {
    const el = document.createElement("div");
    populateToolbar(el, items);
    expect(el.classList.contains("dap-toolbar")).toBe(true);
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
