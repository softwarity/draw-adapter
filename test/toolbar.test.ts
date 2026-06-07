// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

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

describe("applyToolbarLayout — orientation & flow", () => {
  it("horizontal edge ⇒ row", () => expect(layout("top").flexDirection).toBe("row"));
  it("vertical edge ⇒ column", () => expect(layout("left").flexDirection).toBe("column"));
  it("explicit orientation overrides", () => {
    const el = document.createElement("div");
    applyToolbarLayout(el, { position: "top", orientation: "vertical" });
    expect(el.style.flexDirection).toBe("column");
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
