// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { WidgetLayer } from "../src/widget.js";
import type { WidgetHost, WidgetMount } from "../src/widget.js";
import type { LatLng, MarkerWidget, PointerEvent } from "../src/index.js";

/** Records mounts (as plain divs) + emitted pointer events; `unprojectClient` is the
 *  identity `(x,y) ⇒ { lon:x, lat:y }` so coordinates are easy to assert. */
class FakeHost implements WidgetHost {
  mounts: { el: HTMLElement; anchor: LatLng; removed: boolean }[] = [];
  emits: PointerEvent[] = [];
  createMount(anchor: LatLng): WidgetMount {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const m = { el, anchor, removed: false };
    this.mounts.push(m);
    return {
      el,
      setAnchor: (a) => { m.anchor = a; },
      remove: () => { m.removed = true; el.remove(); },
    };
  }
  unprojectClient(cx: number, cy: number): LatLng { return { lat: cy, lon: cx }; }
  emit(ev: PointerEvent): void { this.emits.push(ev); }
  focusCalls = 0;
  focus(): void { this.focusCalls++; }
}

/** Dispatch a (mouse-backed) pointer event — jsdom has no `PointerEvent` ctor, but a
 *  `MouseEvent` with a pointer type triggers `pointerX` listeners and carries clientX/Y. */
function pointer(el: Element, type: string, x = 0, y = 0, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init }));
}

const cardEl = (host: FakeHost, i = 0): HTMLElement =>
  host.mounts[i]!.el.querySelector(".draw-adapter-widget-card") as HTMLElement;

const VOLCANO: MarkerWidget = {
  id: "v1",
  anchor: { lon: 3, lat: 46 },
  origin: "bottom",
  border: "#1f2328",
  radius: "small",
  padding: "small",
  font: { color: "#1f2328", size: 13 },
  child: { dir: "v", align: "center", gap: 1, items: [
    { kind: "glyph", svg: "<svg id='g'></svg>", size: 24 },
    { kind: "text", value: "ETNA", editable: true, control: "input", autofocus: true },
    { kind: "coord" },
  ] },
};

describe("WidgetLayer — builds the card tree", () => {
  it("renders glyph + editable input + coord, framed, with the origin transform", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([VOLCANO]);

    const mount = host.mounts[0]!;
    expect(mount.el.classList.contains("draw-adapter-widget")).toBe(true);
    expect(mount.el.style.pointerEvents).toBe("none"); // only the card body is interactive

    const card = cardEl(host);
    // frame
    expect(card.style.border).toContain("1px solid");
    expect(card.style.padding).toBe("3px 5px"); // padding "small"
    expect(card.style.transform).toContain("-50"); // origin "bottom" ⇒ translate(-50%, -100%)
    expect(card.style.transform).toContain("-100");
    // tree
    expect(card.querySelector("span > svg")?.id).toBe("g");
    const input = card.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("ETNA");
    expect(card.querySelector('[data-wtag="coord"]')?.textContent).toBe("46.00°N 3.00°E");
  });

  it("a widget with no bg/border renders just the glyph — no frame, no padding", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{
      id: "g1", anchor: { lon: 0, lat: 0 },
      child: { dir: "v", items: [{ kind: "glyph", svg: "<svg></svg>", size: 20 }] },
    }]);
    const card = cardEl(host);
    expect(card.style.background).toBe("transparent");
    expect(card.style.border).toBe(""); // no frame border
    expect(card.style.padding).toBe("0px"); // unframed ⇒ no inner padding
  });

  it("static (non-editable) text renders a <span>, not an <input>", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{
      id: "s1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", value: "NN" }] },
    }]);
    const card = cardEl(host);
    expect(card.querySelector("input")).toBeNull();
    expect(card.querySelector('[data-wtag="text:label"]')?.textContent).toBe("NN");
  });

  it("auto-sizes the editable input — an empty input gets an explicit (≈1 char) centered width, not the browser default", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{
      id: "e1", anchor: { lon: 0, lat: 0 },
      child: { dir: "v", align: "center", items: [{ kind: "text", value: "", editable: true }] },
    }]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    expect(input.style.width).toMatch(/px$/); // a width is set (not left at the ~20ch default)
    expect(input.style.textAlign).toBe("center");
  });
});

describe("WidgetLayer — diff by id (in place)", () => {
  it("re-`setWidgets` reuses the SAME input element (keeps focus/caret)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([VOLCANO]);
    const input1 = cardEl(host).querySelector("input");
    layer.setWidgets([{ ...VOLCANO, anchor: { lon: 4, lat: 47 } }]); // moved + re-pushed
    const input2 = cardEl(host).querySelector("input");
    expect(input2).toBe(input1); // not recreated
    expect(host.mounts).toHaveLength(1); // same card, not a new mount
  });

  it("an external value change is reflected; an equal round-trip keeps the typed value", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([VOLCANO]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    input.value = "ETN"; // user typed
    layer.setWidgets([VOLCANO]); // consumer re-pushes the OLD value "ETNA"…
    expect(input.value).toBe("ETNA"); // external value wins on a real change
    input.value = "ETNA-X";
    layer.setWidgets([{ ...VOLCANO, child: { ...VOLCANO.child, items: [
      VOLCANO.child.items[0]!, { kind: "text", value: "ETNA-X", editable: true }, VOLCANO.child.items[2]!,
    ] } }]);
    expect(input.value).toBe("ETNA-X"); // equal ⇒ untouched (no caret jump)
  });

  it("removes a card whose id is dropped from the set", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([VOLCANO, { ...VOLCANO, id: "v2", anchor: { lon: 1, lat: 1 } }]);
    expect(host.mounts).toHaveLength(2);
    layer.setWidgets([VOLCANO]);
    expect(host.mounts[1]!.removed).toBe(true);
  });

  it("toggling editable replaces the node (label ⇄ input)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const make = (editable: boolean): MarkerWidget => ({
      id: "t", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", value: "X", editable }] },
    });
    layer.setWidgets([make(false)]);
    expect(cardEl(host).querySelector("input")).toBeNull();
    layer.setWidgets([make(true)]);
    expect(cardEl(host).querySelector("input")).not.toBeNull();
    layer.setWidgets([make(false)]);
    expect(cardEl(host).querySelector("input")).toBeNull();
  });
});

describe("WidgetLayer — coord formatting", () => {
  it("uses the default decimal format, then honours setCoordFormat live", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([VOLCANO]);
    const coord = cardEl(host).querySelector('[data-wtag="coord"]') as HTMLElement;
    expect(coord.textContent).toBe("46.00°N 3.00°E");
    layer.setCoordFormat((ll) => `${ll.lon},${ll.lat}`);
    expect(coord.textContent).toBe("3,46"); // re-rendered in place
  });

  it("re-formats coord when the anchor moves", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setCoordFormat((ll) => `${ll.lon},${ll.lat}`);
    layer.setWidgets([VOLCANO]);
    expect((cardEl(host).querySelector('[data-wtag="coord"]') as HTMLElement).textContent).toBe("3,46");
    layer.setWidgets([{ ...VOLCANO, anchor: { lon: 9, lat: 8 } }]);
    expect((cardEl(host).querySelector('[data-wtag="coord"]') as HTMLElement).textContent).toBe("9,8");
  });
});

describe("WidgetLayer — pointer routing", () => {
  it("a tap on the card emits down → up → click with the widget hit + unprojected coord", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([VOLCANO]);
    const card = cardEl(host);
    pointer(card, "pointerdown", 10, 20);
    pointer(card, "pointerup", 10, 20);
    expect(host.emits.map((e) => e.type)).toEqual(["down", "up", "click"]);
    expect(host.emits[0]).toMatchObject({ lngLat: { lat: 20, lon: 10 }, hit: { overlay: "widget", props: { id: "v1" } } });
  });

  it("a drag emits down → move → up (no click) and carries live coords", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([VOLCANO]);
    const card = cardEl(host);
    pointer(card, "pointerdown", 10, 20);
    pointer(card, "pointermove", 50, 60);
    pointer(card, "pointerup", 50, 60);
    expect(host.emits.map((e) => e.type)).toEqual(["down", "move", "up"]);
    expect(host.emits[1]).toMatchObject({ type: "move", lngLat: { lat: 60, lon: 50 } });
  });

  it("a press on the editable input edits — it does NOT emit a pointer/drag", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([VOLCANO]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    pointer(input, "pointerdown", 5, 5);
    expect(host.emits).toHaveLength(0);
  });

  it("forwards modifier keys on the emitted events", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([VOLCANO]);
    pointer(cardEl(host), "pointerdown", 1, 1, { metaKey: true, shiftKey: true });
    expect(host.emits[0]).toMatchObject({ ctrlKey: false, metaKey: true, shiftKey: true, altKey: false });
  });
});

describe("WidgetLayer — editing", () => {
  it("fires onWidgetEdit on every keystroke (native input event)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: { id: string; value: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([VOLCANO]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    input.value = "ETN";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "ETNA";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edits).toEqual([{ id: "v1", value: "ETN" }, { id: "v1", value: "ETNA" }]);
  });

  it("uppercase: an editable input enters + emits its value in upper case", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: { id: string; value: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "u1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", value: "", editable: true, uppercase: true }] } }]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    expect(input.style.textTransform).toBe("uppercase");
    input.value = "etna";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("ETNA");
    expect(edits).toEqual([{ id: "u1", value: "ETNA" }]);
  });

  it("uppercase on a static label displays upper case (text-transform)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "u2", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", value: "etna", uppercase: true }] } }]);
    const label = cardEl(host).querySelector('[data-wtag="text:label"]') as HTMLElement;
    expect(label.style.textTransform).toBe("uppercase");
  });
});

describe("WidgetLayer — delete button", () => {
  const deletableInput = (extra: Partial<MarkerWidget> = {}): MarkerWidget => ({
    id: "d1", anchor: { lon: 0, lat: 0 }, deletable: true, border: "#111", ...extra,
    child: { dir: "h", items: [{ kind: "text", value: "", editable: true }] },
  });

  it("renders a bare × (no frills) only when deletable; a click fires onWidgetDelete({ id })", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const deleted: { id: string }[] = [];
    layer.onWidgetDelete((e) => deleted.push(e));
    layer.setWidgets([deletableInput()]);
    const btn = cardEl(host).querySelector(".draw-adapter-widget-del") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("×");
    expect(btn.style.background).toBe("transparent"); // no fill
    expect(btn.style.borderStyle).toBe("none"); // no border
    expect(btn.style.color).toMatch(/^(#000|rgb\(0, 0, 0\)|black)$/); // forced black
    expect(btn.style.position).toBe("absolute");
    expect(btn.style.top).toBe("2px"); // framed ⇒ inside the corner with a small inset
    expect(btn.style.transform).toBe("");
    expect(btn.style.display).toBe("flex"); // square centred box ⇒ × equidistant from top/right
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    btn.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(deleted).toEqual([{ id: "d1" }]); // emitted on the pointerup tap (the native click is ML-suppressed)
  });

  it("when unframed (no bg/border) the × is nudged up-and-right, clear of the content", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "d2", anchor: { lon: 0, lat: 0 }, deletable: true,
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] } }]);
    const btn = cardEl(host).querySelector(".draw-adapter-widget-del") as HTMLButtonElement;
    expect(btn.style.transform).toContain("translate"); // no frame padding to sit in ⇒ pushed out
  });

  it("is a separate element from the input — an input-only card is still deletable, with no drag", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const deleted: { id: string }[] = [];
    layer.onWidgetDelete((e) => deleted.push(e));
    layer.setWidgets([deletableInput()]);
    const btn = cardEl(host).querySelector(".draw-adapter-widget-del") as HTMLButtonElement;
    expect(btn.closest("input")).toBeNull(); // not swallowed by the input
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(host.emits).toHaveLength(0); // pressing × never starts a card drag/select
    btn.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 1, clientY: 1 })); // tap ⇒ delete
    expect(deleted).toEqual([{ id: "d1" }]);
    expect(host.emits).toHaveLength(0); // and no widget pointer leaked to the card/map
  });

  it("doesn't disturb the reconcile, and the button is removed when deletable turns off", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([deletableInput()]);
    expect(cardEl(host).querySelector(".draw-adapter-widget-del")).not.toBeNull();
    expect(cardEl(host).querySelector("input")).not.toBeNull(); // content coexists with the button
    layer.setWidgets([deletableInput({ deletable: false })]);
    expect(cardEl(host).querySelector(".draw-adapter-widget-del")).toBeNull();
    expect(cardEl(host).querySelector("input")).not.toBeNull(); // content intact
  });
});

describe("WidgetLayer — action buttons", () => {
  it("renders a button per place; a click fires onWidgetAction({ id, event })", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([{ id: "w1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] },
      buttons: [{ event: "draw-again", place: ["right", "bottom"], bordered: true, svg: "<svg id='plus'></svg>" }] }]);
    const btns = cardEl(host).querySelectorAll(".draw-adapter-widget-btn");
    expect(btns.length).toBe(2); // right + bottom
    const b0 = btns[0] as HTMLElement;
    b0.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    b0.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(actions).toEqual([{ id: "w1", event: "draw-again" }]); // emitted on the pointerup tap
  });

  it("unions place groups (deduped): left-corners + top-corners ⇒ 3 corners", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "w2", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] },
      buttons: [{ event: "x", place: ["left-corners", "top-corners"] }] }]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(3);
  });

  it("a press never starts a card drag, and a press-drag past the threshold emits no action", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([{ id: "w3", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] },
      buttons: [{ event: "x", place: "right" }] }]);
    const btn = cardEl(host).querySelector(".draw-adapter-widget-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(host.emits).toHaveLength(0); // no card drag
    btn.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 })); // moved > 3 px
    expect(actions).toHaveLength(0); // press-drag ⇒ no action (only a tap fires)
  });
});

describe("WidgetLayer — action buttons are gated by what you pass (deselect)", () => {
  it("removes the action buttons when the `buttons` prop is dropped", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const w = (withButtons: boolean): MarkerWidget => ({
      id: "w", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] },
      ...(withButtons ? { buttons: [{ event: "x", place: "right" }] } : {}),
    });
    layer.setWidgets([w(true)]);  // "selected" → buttons shown
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(1);
    layer.setWidgets([w(false)]); // "deselected" → no buttons passed
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(0);
    // same for the delete button
    layer.setWidgets([{ ...w(false), deletable: true }]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-del").length).toBe(1);
    layer.setWidgets([w(false)]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-del").length).toBe(0);
  });
});

describe("WidgetLayer — carousel control", () => {
  const carousel = (value: string): MarkerWidget => ({
    id: "c1", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "text", control: "carousel", name: "coverage", value, options: ["ISOL", "OCNL", "FRQ"] }] },
  });
  const cel = (host: FakeHost): HTMLElement => cardEl(host).querySelector('[data-wtag="text:carousel"]') as HTMLElement;
  const tap = (el: Element, shift = false): void => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5, shiftKey: shift }));
  };

  it("renders the current option and cycles forward on click, emitting { id, name, value }", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: { id: string; name?: string; value: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([carousel("ISOL")]);
    expect(cel(host).textContent).toBe("ISOL");
    tap(cel(host));
    expect(edits).toEqual([{ id: "c1", name: "coverage", value: "OCNL" }]);
    expect(cel(host).textContent).toBe("OCNL"); // optimistic display
  });

  it("shift-click cycles backward and wraps (ISOL → FRQ)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: { id: string; name?: string; value: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([carousel("ISOL")]);
    tap(cel(host), true);
    expect(edits.at(-1)).toEqual({ id: "c1", name: "coverage", value: "FRQ" });
  });

  it("supports glyph options (svg)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "g", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "carousel", value: "a",
        options: [{ value: "a", svg: "<svg id='A'></svg>" }, { value: "b", svg: "<svg id='B'></svg>" }] }] } }]);
    expect(cel(host).querySelector("svg")?.id).toBe("A");
  });

  it("an external value change re-renders; a press never starts a card drag", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([carousel("ISOL")]);
    layer.setWidgets([carousel("FRQ")]);
    expect(cel(host).textContent).toBe("FRQ");
    cel(host).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(host.emits).toHaveLength(0);
  });
});

describe("WidgetLayer — button tooltips", () => {
  it("action buttons and the delete × render a native `title`", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "t", anchor: { lon: 0, lat: 0 },
      deletable: { title: "Supprimer" },
      buttons: [{ event: "add", place: "right", title: "Ajouter une zone" }],
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] } }]);
    const card = cardEl(host);
    expect((card.querySelector(".draw-adapter-widget-btn") as HTMLElement).title).toBe("Ajouter une zone");
    expect((card.querySelector(".draw-adapter-widget-del") as HTMLElement).title).toBe("Supprimer");
  });
});

describe("WidgetLayer — carousel is also a drag handle", () => {
  it("a drag on the carousel forwards down/move/up (moves the card) and does NOT cycle", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: unknown[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "c", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "carousel", name: "cov", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const c = cardEl(host).querySelector('[data-wtag="text:carousel"]') as HTMLElement;
    c.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    c.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    c.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    expect(host.emits.map((e) => e.type)).toEqual(["down", "move", "up"]); // forwarded ⇒ card drag
    expect(host.emits[0]?.hit?.overlay).toBe("widget");
    expect(edits).toHaveLength(0); // a drag never cycles
  });
});

describe("WidgetLayer — carousel tap selects the card", () => {
  it("a tap emits the card's down/up/click (widget hit) AND cycles", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: unknown[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "c1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "carousel", name: "coverage", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const c = cardEl(host).querySelector('[data-wtag="text:carousel"]') as HTMLElement;
    c.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    c.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(host.emits.map((e) => e.type)).toEqual(["down", "up", "click"]); // selects the card
    expect(host.emits.every((e) => e.hit?.overlay === "widget" && (e.hit.props as { id: string }).id === "c1")).toBe(true);
    expect(edits).toHaveLength(1); // and cycles
  });
});

describe("WidgetLayer — editable input keeps keys + caret to itself", () => {
  const inputCard = (): MarkerWidget => ({
    id: "i", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "text", value: "AB", editable: true }] },
  });

  it("forces user-select:text (so a click positions the caret despite the card's user-select:none)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([inputCard()]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    expect(input.style.userSelect).toBe("text");
  });

  it("stops keydown/keyup from bubbling to the map (arrows move the caret, not the map)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([inputCard()]);
    const input = cardEl(host).querySelector("input") as HTMLInputElement;
    let bubbled = false;
    const onDoc = (): void => { bubbled = true; };
    document.addEventListener("keydown", onDoc);
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
    expect(bubbled).toBe(false);
  });
});

describe("WidgetLayer — focus returns to the map after a card button", () => {
  it("an action button, the delete ×, and a carousel tap each call host.focus()", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([{ id: "f", anchor: { lon: 0, lat: 0 }, deletable: true,
      buttons: [{ event: "draw-again", place: "right" }],
      child: { dir: "h", items: [{ kind: "text", control: "carousel", value: "A", options: ["A", "B"] }] } }]);
    const card = cardEl(host);
    const tap = (el: Element): void => {
      el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 4, clientY: 4 }));
      el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 4, clientY: 4 }));
    };
    tap(card.querySelector(".draw-adapter-widget-btn") as HTMLElement);  // action button
    tap(card.querySelector(".draw-adapter-widget-ctrl") as HTMLElement); // carousel
    tap(card.querySelector(".draw-adapter-widget-del") as HTMLElement);  // delete ×
    expect(host.focusCalls).toBe(3);
  });
});

describe("WidgetLayer — gauge control", () => {
  const gaugeCard = (cursors: { name: string; value: number; label?: string }[]): MarkerWidget => ({
    id: "g", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, length: 100, cursors }] },
  });

  it("renders one knob per cursor positioned by value (max at top); guide hugs the cursors", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([gaugeCard([{ name: "lo", value: 25, label: "L" }, { name: "hi", value: 75, label: "H" }])]);
    const card = cardEl(host);
    const knobs = card.querySelectorAll(".draw-adapter-widget-knob");
    expect(knobs).toHaveLength(2);
    expect((knobs[0] as HTMLElement).style.top).toBe("75px"); // value 25 ⇒ (1-.25)*100
    expect((knobs[1] as HTMLElement).style.top).toBe("25px"); // value 75 ⇒ (1-.75)*100
    const gauge = card.querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    expect((gauge.children[0] as HTMLElement).style.display).not.toBe("none"); // 2 cursors ⇒ selected-span glow shown
    expect(parseFloat((gauge.children[1] as HTMLElement).style.height)).toBeLessThan(100); // guide hugs the cursors, not full len
  });

  it("reconciles the cursor count in place (2 → 1 → 3), same gauge element", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([gaugeCard([{ name: "a", value: 10 }, { name: "b", value: 90 }])]);
    const g1 = cardEl(host).querySelector(".draw-adapter-widget-gauge");
    layer.setWidgets([gaugeCard([{ name: "a", value: 10 }])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(1);
    layer.setWidgets([gaugeCard([{ name: "a", value: 10 }, { name: "b", value: 50 }, { name: "c", value: 90 }])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(3);
    expect(cardEl(host).querySelector(".draw-adapter-widget-gauge")).toBe(g1); // not recreated
  });

  it("a press on a knob never starts a card drag", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([gaugeCard([{ name: "a", value: 50 }])]);
    const knob = cardEl(host).querySelector(".draw-adapter-widget-knob") as HTMLElement;
    knob.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(host.emits).toHaveLength(0);
  });
});

describe("WidgetLayer — dial control", () => {
  it("renders an SVG arc + knob + centre label", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "d", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "dial", name: "spd", min: 0, max: 100, value: 50, label: "50KT" }] } }]);
    const dial = cardEl(host).querySelector(".draw-adapter-widget-dial") as HTMLElement;
    expect(dial.querySelector("svg path")).not.toBeNull();
    expect(dial.querySelector("svg circle.draw-adapter-widget-knob")).not.toBeNull();
    expect(dial.querySelector("span")?.textContent).toBe("50KT");
  });

  it("a press on the dial knob never starts a card drag", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "d2", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "dial", name: "spd", min: 0, max: 100, value: 50 }] } }]);
    const knob = cardEl(host).querySelector(".draw-adapter-widget-dial .draw-adapter-widget-knob") as Element;
    knob.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(host.emits).toHaveLength(0);
  });
});

describe("WidgetLayer — dial label follows the knob; gauge/dial label & knob styling", () => {
  const dialCard = (value: number, extra: Record<string, unknown> = {}): MarkerWidget => ({
    id: "d", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "dial", name: "s", min: 0, max: 100, value, label: "X", ...extra }] },
  });

  it("the dial label is positioned at the knob's angle (px, not centred) and moves with the value", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([dialCard(0)]);
    const label = cardEl(host).querySelector(".draw-adapter-widget-dial span") as HTMLElement;
    const at0 = label.style.left;
    expect(at0).toMatch(/px$/);   // angle-positioned, not "50%"
    expect(at0).not.toBe("50%");
    layer.setWidgets([dialCard(100)]);
    expect(label.style.left).not.toBe(at0); // followed the knob round the ring
  });

  it("dial labelColor/labelHalo + knobFill/knobStroke apply; bare dial is unchanged", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([dialCard(50, { color: "purple", labelColor: "black", labelHalo: "white", knobFill: "red", knobStroke: "blue" })]);
    const dial = cardEl(host).querySelector(".draw-adapter-widget-dial") as HTMLElement;
    expect(dial.style.color).toBe("purple");
    const knob = dial.querySelector("circle.draw-adapter-widget-knob") as Element;
    expect(knob.getAttribute("fill")).toBe("red");
    expect(knob.getAttribute("stroke")).toBe("blue");
    const label = dial.querySelector("span") as HTMLElement;
    expect(label.style.color).toBe("black");
    expect(label.style.textShadow).toContain("white");
  });

  it("gauge labelColor/labelHalo + knobFill/knobStroke apply", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "g", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, color: "purple", labelColor: "black", labelHalo: "white",
        knobFill: "red", knobStroke: "blue", cursors: [{ name: "a", value: 50, label: "L" }] }] } }]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    expect(gauge.style.color).toBe("purple");
    const knob = gauge.querySelector(".draw-adapter-widget-knob") as HTMLElement;
    expect(knob.style.background).toBe("red");
    expect(knob.style.border).toContain("blue");
    const label = gauge.querySelector("span") as HTMLElement;
    expect(label.style.color).toBe("black");
    expect(label.style.textShadow).toContain("white");
  });
});

describe("WidgetLayer — gauge/dial styling defaults", () => {
  const bareGauge = (extra: Record<string, unknown> = {}): MarkerWidget => ({
    id: "g", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, cursors: [{ name: "a", value: 50, label: "L" }], ...extra }] },
  });

  it("default: knobs main-colour fill + white stroke, labels black + white halo", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([bareGauge()]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const knob = gauge.querySelector(".draw-adapter-widget-knob") as HTMLElement;
    expect(knob.style.background).toMatch(/currentcolor/i); // the control's main colour
    expect(knob.style.border).toContain("white");           // default white stroke
    const label = gauge.querySelector("span") as HTMLElement;
    expect(label.style.color).toBe("black");                // default black
    expect(label.style.textShadow).toContain("white");      // default white halo
  });

  it('`""` opts out — no knob border, no halo, label inherits the cascade', () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([bareGauge({ labelColor: "", labelHalo: "", knobStroke: "" })]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    expect((gauge.querySelector(".draw-adapter-widget-knob") as HTMLElement).style.borderStyle).toBe("none");
    const label = gauge.querySelector("span") as HTMLElement;
    expect(label.style.color).toBe("");      // inherit
    expect(label.style.textShadow).toBe("");  // no halo
  });
});

describe("WidgetLayer — guide track/arc glow", () => {
  it("the gauge has a thin marked guide + a wider, fainter glow on the selected span only", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "g", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, length: 100, cursors: [{ name: "a", value: 30 }, { name: "b", value: 70 }] }] } }]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const glow = gauge.children[0] as HTMLElement;  // selected-span glow
    const guide = gauge.children[1] as HTMLElement; // thin central guide
    expect(Number(glow.style.opacity)).toBeLessThan(Number(guide.style.opacity)); // glow fainter, guide marked
    expect(parseFloat(glow.style.width)).toBeGreaterThan(parseFloat(guide.style.width)); // glow wider (vertical ⇒ width)
    expect(parseFloat(glow.style.height)).toBeLessThan(parseFloat(guide.style.height)); // glow = span only; guide extends past
    expect(glow.style.background).toMatch(/currentcolor/i);
  });

  it("the dial has a thin marked guide arc + a wider faint glow from the start to the value", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "d", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "dial", name: "s", min: 0, max: 100, value: 50 }] } }]);
    const svg = cardEl(host).querySelector(".draw-adapter-widget-dial svg") as SVGElement;
    const glow = svg.children[0] as SVGElement; // select arc (start → value)
    const arc = svg.children[1] as SVGElement;  // full guide arc
    expect(Number((glow as unknown as SVGPathElement).style.opacity)).toBeLessThan(Number((arc as unknown as SVGPathElement).style.opacity));
    expect(Number(glow.getAttribute("stroke-width"))).toBeGreaterThan(Number(arc.getAttribute("stroke-width")));
    expect(glow.getAttribute("d")).not.toBe(arc.getAttribute("d")); // select (start→value) ≠ the full sweep
    expect(glow.getAttribute("d")).toMatch(/^M /); // a real arc was drawn
  });
});

describe("WidgetLayer — gauge/dial selected-zone edges", () => {
  it("a single-cursor gauge glows over the WHOLE visible guide line", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "g1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, length: 100, cursors: [{ name: "a", value: 50 }] }] } }]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const glow = gauge.children[0] as HTMLElement;
    const guide = gauge.children[1] as HTMLElement;
    expect(glow.style.display).not.toBe("none");        // shown for one cursor too
    expect(glow.style.height).toBe(guide.style.height); // covers the whole visible guide
    expect(glow.style.top).toBe(guide.style.top);
  });

  it("the dial select arc is empty at the min value (no round-cap blob)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "dm", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "dial", name: "s", min: 0, max: 100, value: 0 }] } }]);
    const svg = cardEl(host).querySelector(".draw-adapter-widget-dial svg") as SVGElement;
    expect(svg.children[0].getAttribute("d")).toBe(""); // nothing selected at min
  });
});
