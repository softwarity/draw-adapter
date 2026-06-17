// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { WidgetLayer, boxShapeLayout, inlineStatic, resolveBoxShape, snapshotWithWidgets } from "../src/widget.js";
import type { WidgetHost, WidgetMount } from "../src/widget.js";
import type { LatLng, MarkerWidget, PointerEvent, WidgetEdit, WidgetRange, WidgetStack } from "../src/index.js";

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

  it("border width is a preset (small/medium/large); default medium = 1px (unchanged)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const card = (bw?: "small" | "medium" | "large"): string => {
      layer.setWidgets([{ id: "b", anchor: { lon: 0, lat: 0 }, border: "#1f2328",
        ...(bw ? { borderWidth: bw } : {}),
        child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>", size: 20 }] } }]);
      return cardEl(host).style.border;
    };
    expect(card()).toContain("1px solid");     // default ⇒ medium ⇒ 1px (former look)
    expect(card("small")).toContain("0.5px solid");
    expect(card("medium")).toContain("1px solid");
    expect(card("large")).toContain("2px solid");
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

  it("padding is decoupled from the frame: a BARE card (no bg/border) with `padding` still spaces its content", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{
      id: "b1", anchor: { lon: 0, lat: 0 }, padding: "large",
      buttons: [{ event: "add", place: "right" }], // edge button that would otherwise sit on the content
      child: { dir: "v", items: [{ kind: "glyph", svg: "<svg></svg>", size: 20 }] },
    }]);
    const card = cardEl(host);
    expect(card.style.padding).toBe("10px 13px"); // padding "large" applied…
    expect(card.style.background).toBe("transparent"); // …while staying visually bare
    expect(card.style.border).toBe("");
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

  it("a static text leaf honours \\n (white-space: pre-line), like the picker", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "t", anchor: { lon: 0, lat: 0 },
      child: { dir: "v", items: [{ kind: "text", value: "H\n460" }] } }]);
    const label = cardEl(host).querySelector('[data-wtag="text:label"]') as HTMLElement;
    expect(label.style.whiteSpace).toBe("pre-line");
    expect(label.style.textAlign).toBe("center"); // a short line (H) sits centred under the FL
    expect(label.textContent).toBe("H\n460"); // both lines kept (not collapsed to one)
  });

  it("font.lineHeight sets the card's line-height (default 1.2)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([{ id: "l", anchor: { lon: 0, lat: 0 }, child: { dir: "v", items: [{ kind: "text", value: "X" }] } }]);
    expect(cardEl(host).style.lineHeight).toBe("1.2");
    layer.setWidgets([{ id: "l", anchor: { lon: 0, lat: 0 }, font: { lineHeight: 1 }, child: { dir: "v", items: [{ kind: "text", value: "X" }] } }]);
    expect(cardEl(host).style.lineHeight).toBe("1");
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

describe("snapshot compositing (DOM pipeline)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("inlineStatic swaps an editable input for a static span carrying its value (labels kept)", () => {
    const src = document.createElement("div");
    const input = document.createElement("input"); input.value = "ETNA";
    const label = document.createElement("span"); label.textContent = "FL120";
    src.append(input, label);
    document.body.appendChild(src);
    const clone = src.cloneNode(true) as HTMLElement;
    inlineStatic(src, clone);
    expect(clone.querySelector("input")).toBeNull(); // input → static span
    expect(clone.textContent).toContain("ETNA");     // value preserved
    expect(clone.textContent).toContain("FL120");    // sibling label untouched
  });

  it("snapshotWithWidgets returns the base blob unchanged when there are no cards", async () => {
    const base = new Blob(["base"], { type: "image/png" });
    const mapCanvas = { toBlob: (cb: (b: Blob) => void) => cb(base) } as unknown as HTMLCanvasElement;
    expect(await snapshotWithWidgets(mapCanvas, [], () => null, 1)).toBe(base);
  });

  it("snapshotWithWidgets degrades to the card-less base blob when compositing can't run (safe by design)", async () => {
    const base = new Blob(["base"], { type: "image/png" });
    const mapCanvas = { width: 10, height: 10, toBlob: (cb: (b: Blob) => void) => cb(base) } as unknown as HTMLCanvasElement;
    const card = document.createElement("div");
    document.body.appendChild(card);
    // jsdom's composite <canvas> has no 2D context ⇒ the pipeline returns the base blob, never throws.
    const out = await snapshotWithWidgets(mapCanvas, [{ root: card, anchor: { lon: 0, lat: 0 } }], () => [5, 5], 1);
    expect(out).toBe(base);
  });
});

describe("box frame shapes (boxShape)", () => {
  it("resolveBoxShape: rect/absent ⇒ null; presets ⇒ polygons; custom passes through; <3 pts ⇒ null", () => {
    expect(resolveBoxShape(undefined)).toBeNull();
    expect(resolveBoxShape("rect")).toBeNull();
    expect(resolveBoxShape("bogus" as never)).toBeNull();
    expect(resolveBoxShape("pentagon-up")).toHaveLength(5);
    expect(resolveBoxShape("pentagon-down")).toHaveLength(5);
    const custom = [[0, 0], [1, 0], [0.5, 1.2]];
    expect(resolveBoxShape(custom)).toBe(custom);
    expect(resolveBoxShape([[0, 0], [1, 1]])).toBeNull(); // degenerate
  });

  it("boxShapeLayout: a custom point OUTSIDE [0,1] reserves overshoot, scales, leaves room for the stroke", () => {
    const lay = boxShapeLayout([[0, 0], [0.5, -0.45], [1, 0], [1, 1], [0, 1]], 100, 40, 1); // W=100 H=40 bw=1 ⇒ inset=1.5
    expect(lay.over.t).toBeCloseTo(18); // 0.45 × 40 reserved above
    expect(lay.over.b).toBe(0);
    expect(lay.svgW).toBeCloseTo(103); // 100 + 2×1.5
    expect(lay.svgH).toBeCloseTo(61);  // 18 + 40 + 2×1.5
    expect(lay.points.split(" ")).toHaveLength(5);
    expect(lay.points.split(" ")[1]).toBe("51.50,1.50"); // the apex: centred X, at the top
  });

  it("boxShapeLayout: the presets keep their point INSIDE [0,1] (no overshoot — it carries a text line)", () => {
    const up = boxShapeLayout(resolveBoxShape("pentagon-up")!, 100, 40, 0); // bw=0 ⇒ inset=1
    expect(up.over).toEqual({ t: 0, r: 0, b: 0, l: 0 });
    expect(up.points.split(" ")).toHaveLength(5);
    expect(up.points.split(" ")[1]).toBe("51.00,1.00"); // apex [0.5,0] = top-centre (in the hat)
    const down = boxShapeLayout(resolveBoxShape("pentagon-down")!, 80, 20, 0);
    expect(down.over).toEqual({ t: 0, r: 0, b: 0, l: 0 });
    expect(down.points.split(" ")[3]).toBe("41.00,21.00"); // apex [0.5,1] = bottom-centre
  });

  it("a non-rect card draws an SVG frame (bg=fill, border=stroke) and steps the CSS box aside", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "h", anchor: { lon: 0, lat: 0 },
      bg: "#fff", border: "#1f2328", borderWidth: "large", boxShape: "pentagon-up",
      child: { dir: "h", items: [{ kind: "text", value: "TROPO" }] } }]);
    const card = cardEl(host);
    const svg = card.querySelector(".draw-adapter-widget-shape") as SVGSVGElement;
    expect(svg).not.toBeNull();
    const poly = svg.querySelector("polygon")!;
    expect(poly.getAttribute("points")!.split(" ")).toHaveLength(5);
    expect(poly.getAttribute("fill")).toBe("#fff");
    expect(poly.getAttribute("stroke")).toBe("#1f2328");
    expect(poly.getAttribute("stroke-width")).toBe("2"); // borderWidth "large"
    expect(card.style.background).toBe("transparent"); // CSS box stepped aside
    expect(card.style.border).toBe("");
    expect(svg.style.pointerEvents).toBe("none"); // drag still lands on the card body
  });

  it("rect/absent ⇒ no SVG frame, the CSS box is unchanged (no regression)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([{ id: "r", anchor: { lon: 0, lat: 0 }, bg: "#fff", border: "#1f2328",
      child: { dir: "h", items: [{ kind: "text", value: "X" }] } }]);
    expect(cardEl(host).querySelector(".draw-adapter-widget-shape")).toBeNull();
    expect(cardEl(host).style.border).toContain("1px solid");
    // switching a card to a shape and back removes the SVG
    layer.setWidgets([{ id: "r", anchor: { lon: 0, lat: 0 }, bg: "#fff", border: "#1f2328", boxShape: "pentagon-down",
      child: { dir: "h", items: [{ kind: "text", value: "X" }] } }]);
    expect(cardEl(host).querySelector(".draw-adapter-widget-shape")).not.toBeNull();
    layer.setWidgets([{ id: "r", anchor: { lon: 0, lat: 0 }, bg: "#fff", border: "#1f2328",
      child: { dir: "h", items: [{ kind: "text", value: "X" }] } }]);
    expect(cardEl(host).querySelector(".draw-adapter-widget-shape")).toBeNull();
    expect(cardEl(host).style.border).toContain("1px solid"); // CSS box restored
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
    child: { dir: "h", items: [{ kind: "text", control: "picker", name: "coverage", value, options: ["ISOL", "OCNL", "FRQ"] }] },
  });
  const cel = (host: FakeHost): HTMLElement => cardEl(host).querySelector('[data-wtag="text:picker"]') as HTMLElement;
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
      child: { dir: "h", items: [{ kind: "text", control: "picker", value: "a",
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

describe("WidgetLayer — picker flower / grid modes", () => {
  // Close any popup left open + clear mounts between tests (popups live in <body>).
  afterEach(() => {
    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    document.body.innerHTML = "";
  });

  type Mode = "carousel" | "flower" | "grid";
  const opts = (n: number): string[] => Array.from({ length: n }, (_, i) => `o${i}`);
  const picker = (n: number, mode?: Mode, options?: NonNullable<MarkerWidget["child"]>): MarkerWidget => {
    const list = options ?? opts(n);
    return {
      id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{
        kind: "text", control: "picker", name: "sym",
        value: (typeof list[0] === "string" ? list[0] : (list[0] as { value: string }).value),
        options: list as never, ...(mode ? { mode } : {}),
      }] },
    };
  };
  const cel = (host: FakeHost): HTMLElement => cardEl(host).querySelector('[data-wtag="text:picker"]') as HTMLElement;
  const tap = (el: Element, shift = false): void => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5, shiftKey: shift }));
  };
  const flower = (): HTMLElement | null => document.querySelector(".dap-picker-flower");
  const grid = (): HTMLElement | null => document.querySelector(".dap-picker-grid");

  it("auto: ≤5 options stays a carousel (cycles in place, no popup)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(5)]);
    tap(cel(host));
    expect(flower()).toBeNull();
    expect(grid()).toBeNull();
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "o1" }]); // cycled to next, in place
  });

  it("auto: 6–10 options ⇒ a flower; tapping opens N petals; picking one emits + closes", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(7)]);
    tap(cel(host)); // opens (no edit yet)
    expect(edits).toHaveLength(0);
    expect(flower()).not.toBeNull();
    const petals = flower()!.querySelectorAll(".dap-picker-petal");
    expect(petals).toHaveLength(7);
    petals[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "o3" }]);
    expect(flower()).toBeNull(); // collapsed after the pick
    expect(cel(host).textContent).toBe("o3"); // centre adopts the pick
  });

  it("auto: >10 options ⇒ a grid; picking a cell emits + closes", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(12)]);
    tap(cel(host));
    expect(flower()).toBeNull();
    expect(grid()).not.toBeNull();
    const cells = grid()!.querySelectorAll("button");
    expect(cells).toHaveLength(12);
    cells[9]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "o9" }]);
    expect(grid()).toBeNull();
  });

  it("forced mode:flower keeps a flower even for few options (2 petals)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(2, "flower")]);
    tap(cel(host));
    expect(flower()).not.toBeNull();
    expect(flower()!.querySelectorAll(".dap-picker-petal")).toHaveLength(2);
  });

  it("forced mode:grid is a grid even for few options", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(3, "grid")]);
    tap(cel(host));
    expect(grid()).not.toBeNull();
    expect(grid()!.querySelectorAll("button")).toHaveLength(3);
  });

  it("forced mode:flower beyond 10 degrades to a grid", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(11, "flower")]);
    tap(cel(host));
    expect(flower()).toBeNull();
    expect(grid()).not.toBeNull();
  });

  it("re-tapping the centre toggles the flower shut", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(7)]);
    tap(cel(host));
    expect(flower()).not.toBeNull();
    tap(cel(host)); // re-tap ⇒ close
    expect(flower()).toBeNull();
  });

  it("a press outside the popup closes it", () => {
    const host = new FakeHost();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    new WidgetLayer(host).setWidgets([picker(7)]);
    tap(cel(host));
    expect(flower()).not.toBeNull();
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(flower()).toBeNull();
  });

  it("petals render glyph options (svg)", () => {
    const host = new FakeHost();
    const glyphs = [
      { value: "a", svg: "<svg id='PA'></svg>" }, { value: "b", svg: "<svg id='PB'></svg>" },
      { value: "c", svg: "<svg id='PC'></svg>" }, { value: "d", svg: "<svg id='PD'></svg>" },
      { value: "e", svg: "<svg id='PE'></svg>" }, { value: "f", svg: "<svg id='PF'></svg>" },
    ];
    new WidgetLayer(host).setWidgets([picker(6, "flower", glyphs as never)]);
    tap(cel(host));
    expect(flower()!.querySelector("svg")?.id).toBe("PA");
  });

  it("the flower carries the picker's accent color (petals inherit it via currentColor)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "o0", color: "#e8731a",
        options: opts(7) }] } }]);
    tap(cel(host));
    expect(flower()!.style.color).toBe("rgb(232, 115, 26)"); // accent on the container ⇒ inherited by petals
  });

  it("the grid carries the picker's accent color", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "o0", color: "#e8731a",
        options: opts(12) }] } }]);
    tap(cel(host));
    expect(grid()!.style.color).toBe("rgb(232, 115, 26)");
  });

  const key = (k: string): boolean =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("arrow keys browse the choices (highlight moves); the event is swallowed so the map can't pan", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(7)]); // value o0 ⇒ starts on index 0
    tap(cel(host));
    const petals = [...flower()!.querySelectorAll(".dap-picker-petal")];
    expect(petals[0]!.classList.contains("dap-focus")).toBe(true); // starts on the current value
    const consumed = key("ArrowRight");
    expect(consumed).toBe(false); // preventDefault ⇒ the map's native pan never runs
    expect(petals[0]!.classList.contains("dap-focus")).toBe(false);
    expect(petals[1]!.classList.contains("dap-focus")).toBe(true);
    key("ArrowLeft"); key("ArrowLeft"); // 1 → 0 → wraps to 6
    expect(petals[6]!.classList.contains("dap-focus")).toBe(true);
  });

  it("Enter picks the highlighted choice (emits + closes); Escape just closes", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(7)]);
    tap(cel(host));
    key("ArrowRight"); key("ArrowRight"); // highlight index 2 (o2)
    key("Enter");
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "o2" }]);
    expect(flower()).toBeNull(); // closed
    // reopen, Escape ⇒ closes without emitting
    tap(cel(host));
    expect(flower()).not.toBeNull();
    key("Escape");
    expect(flower()).toBeNull();
    expect(edits).toHaveLength(1);
  });

  it("arrow keys also drive the grid", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(12)]);
    tap(cel(host));
    key("ArrowDown"); // index 1
    key("Enter");
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "o1" }]);
    expect(grid()).toBeNull();
  });

  it("an option's `title` is its tooltip in the flower; a bare option has none", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "CI",
        options: [{ value: "CI", title: "Cirrus" }, { value: "CB", title: "Cumulonimbus" }, "X3", "X4", "X5", "X6"] }] } }]);
    tap(cel(host));
    const petals = [...flower()!.querySelectorAll<HTMLElement>(".dap-picker-petal")];
    expect(petals[0]!.title).toBe("Cirrus");
    expect(petals[1]!.title).toBe("Cumulonimbus");
    expect(petals[2]!.title).toBe(""); // no title ⇒ no tooltip (no label/value fallback)
  });

  it("the trigger's tooltip follows the current option's title (empty when it has none)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "CI",
        options: [{ value: "CI", title: "Cirrus" }, { value: "CB", title: "Cumulonimbus" }] }] } }]);
    expect(cel(host).title).toBe("Cirrus");
    layer.setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "ISOL", options: ["ISOL", "OCNL"] }] } }]);
    expect(cel(host).title).toBe(""); // plain options ⇒ no tooltip
  });

  it("auto-mode thresholds: 5 ⇒ carousel · 6 ⇒ flower · 10 ⇒ flower · 11 ⇒ grid", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const openKind = (n: number): string => {
      layer.setWidgets([picker(n)]);
      tap(cel(host));
      const k = flower() ? "flower" : grid() ? "grid" : "carousel";
      document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); // close before the next
      return k;
    };
    expect(openKind(5)).toBe("carousel"); // ≤ LINEAR_MAX ⇒ cycles in place, no popup
    expect(openKind(6)).toBe("flower");
    expect(openKind(10)).toBe("flower"); // = FLOWER_MAX
    expect(openKind(11)).toBe("grid");   // > FLOWER_MAX
  });

  it("places the flower on the trigger's centre and the grid just below it", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const rect = { left: 100, top: 50, right: 120, bottom: 70, width: 20, height: 20, x: 100, y: 50, toJSON() {} };
    layer.setWidgets([picker(7)]);
    let t = cel(host);
    Object.defineProperty(t, "getBoundingClientRect", { configurable: true, value: () => rect });
    tap(t); // flower ⇒ centred on the trigger centre (110, 60)
    expect(flower()!.style.left).toBe("110px");
    expect(flower()!.style.top).toBe("60px");
    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    layer.setWidgets([picker(12)]);
    t = cel(host);
    Object.defineProperty(t, "getBoundingClientRect", { configurable: true, value: () => rect });
    tap(t); // grid ⇒ just below the trigger (left, bottom + 4)
    expect(grid()!.style.left).toBe("100px");
    expect(grid()!.style.top).toBe("74px");
  });

  it("a11y: a flower-mode trigger has aria-haspopup=menu and ArrowDown opens it from the keyboard", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([picker(7)]); // ≥6 ⇒ flower
    const t = cel(host);
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(flower()).not.toBeNull(); // opened from the keyboard
  });

  it("dragging the card FROM an open picker trigger closes the popup as the drag starts", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([picker(7)]);
    const t = cel(host);
    tap(t); // open the flower
    expect(flower()).not.toBeNull();
    // press the trigger and move past the threshold ⇒ a card drag begins ⇒ the popup collapses
    t.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    t.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    expect(flower()).toBeNull(); // no orphan popup left on the card
    expect(host.emits.map((e) => e.type)).toContain("move"); // the card drag proceeded
    t.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
  });

  it("a drag on a flower-mode picker moves the card and does NOT open a popup", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([picker(7)]);
    const c = cel(host);
    c.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    c.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    c.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    expect(host.emits.map((e) => e.type)).toEqual(["down", "move", "up"]); // card drag
    expect(flower()).toBeNull(); // a drag never opens the flower
    expect(edits).toHaveLength(0);
  });
});

describe("WidgetLayer — picker is bold (interactive affordance)", () => {
  const trig = (host: FakeHost): HTMLElement => cardEl(host).querySelector('[data-wtag="text:picker"]') as HTMLElement;

  it("a picker value renders bold (so it reads as interactive), no extra width vs the value", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const t = trig(host);
    expect(t.style.fontWeight).toBe("bold");
    expect(t.textContent).toBe("ISOL"); // just the value — no affordance glyph mixed into the text
  });

  it("the accent colour is the consumer's call — a picker honours node.color (e.g. orange)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "ISOL", color: "#e8731a", options: ["ISOL", "OCNL"] }] } }]);
    expect(trig(host).style.color).toBe("rgb(232, 115, 26)");
  });

  it("a11y: the trigger is a keyboard-operable button (role/tabindex/aria); Enter cycles in carousel mode", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const t = trig(host);
    expect(t.getAttribute("role")).toBe("button");
    expect(t.tabIndex).toBe(0);
    expect(t.getAttribute("aria-haspopup")).toBe("false"); // ≤5 ⇒ carousel, not a popup
    expect(t.getAttribute("aria-label")).toBe("sym: ISOL");
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(edits).toEqual([{ id: "p1", name: "sym", value: "OCNL" }]); // cycled via keyboard
  });

  it("a11y: a glyph option's title feeds the aria-label", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "CI",
        options: [{ value: "CI", svg: "<svg/>", title: "Cirrus" }] }] } }]);
    expect(trig(host).getAttribute("aria-label")).toBe("sym: Cirrus");
  });

  it("a static text item is NOT bold", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "s", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", value: "FL120" }] } }]);
    const label = cardEl(host).querySelector('[data-wtag="text:label"]') as HTMLElement;
    expect(label.style.fontWeight).toBe("");
  });

  it("a GLYPH trigger gets a defined px box from node.size (not the svg's intrinsic size)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "x", size: 20,
        options: [{ value: "x", svg: "<svg viewBox='-28 -28 55 55'></svg>" }] }] } }]);
    const t = trig(host);
    expect(t.style.width).toBe("20px");
    expect(t.style.height).toBe("20px");
    expect(t.style.fontSize).toBe(""); // glyph ⇒ sized by the box, not fontSize
  });

  it("a GLYPH trigger with no size falls back to a sober default box (≤ 24px)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "x",
        options: [{ value: "x", svg: "<svg viewBox='0 0 128 128'></svg>" }] }] } }]);
    const t = trig(host);
    expect(parseInt(t.style.width, 10)).toBeLessThanOrEqual(24);
    expect(t.style.width).toBe(t.style.height);
  });

  it("a TEXT picker keeps fontSize sizing (no fixed box)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "p1", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "sym", value: "ISOL", size: 20,
        options: ["ISOL", "OCNL"] }] } }]);
    const t = trig(host);
    expect(t.style.fontSize).toBe("20px");
    expect(t.style.width).toBe(""); // text ⇒ auto width, no fixed box
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
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "cov", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const c = cardEl(host).querySelector('[data-wtag="text:picker"]') as HTMLElement;
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
      child: { dir: "h", items: [{ kind: "text", control: "picker", name: "coverage", value: "ISOL", options: ["ISOL", "OCNL", "FRQ"] }] } }]);
    const c = cardEl(host).querySelector('[data-wtag="text:picker"]') as HTMLElement;
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
      child: { dir: "h", items: [{ kind: "text", control: "picker", value: "A", options: ["A", "B"] }] } }]);
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

  it("a11y: a knob is a slider (role + aria-value*) and arrow keys step the value", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "g", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 100, step: 10, length: 100, cursors: [{ name: "lo", value: 50, label: "L" }] }] } }]);
    const knob = cardEl(host).querySelector(".draw-adapter-widget-knob") as HTMLElement;
    expect(knob.getAttribute("role")).toBe("slider");
    expect(knob.tabIndex).toBe(0);
    expect(knob.getAttribute("aria-valuemin")).toBe("0");
    expect(knob.getAttribute("aria-valuemax")).toBe("100");
    expect(knob.getAttribute("aria-valuenow")).toBe("50");
    expect(knob.getAttribute("aria-label")).toBe("L");
    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(edits.at(-1)).toEqual({ id: "g", name: "lo", value: "60" }); // +step, emitted
    expect(knob.getAttribute("aria-valuenow")).toBe("60");
  });
});

describe("WidgetLayer — coincident cursors (Ask 3)", () => {
  const KNOB = 11;
  const CURSOR_LABEL_H = 16;

  const jetGauge = (cursors: { name: string; value: number; label?: string }[]): MarkerWidget => ({
    id: "j", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 600, length: 120, cursors }] },
  });

  const dots = (host: FakeHost): HTMLElement[] =>
    Array.from(cardEl(host).querySelectorAll(".draw-adapter-widget-gauge .draw-adapter-widget-knob")) as HTMLElement[];

  const labels = (host: FakeHost): HTMLElement[] =>
    Array.from(cardEl(host).querySelectorAll(".draw-adapter-widget-gauge span")) as HTMLElement[];

  it("two distinct cursors far apart: dot and label positions are unchanged (no spread)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "fl", value: 300, label: "FL300" },
      { name: "top", value: 500, label: "500" },
    ])]);
    const d = dots(host);
    // value 300 → along = (1 - 300/600) * 120 = 60; value 500 → along = (1 - 500/600) * 120 = 20
    expect(parseFloat(d[0]!.style.top)).toBeCloseTo(60, 0);
    expect(parseFloat(d[1]!.style.top)).toBeCloseTo(20, 0);
    // labels: center = along + KNOB/2
    const lb = labels(host);
    expect(parseFloat(lb[0]!.style.top)).toBeCloseTo(60 + KNOB / 2, 0);
    expect(parseFloat(lb[1]!.style.top)).toBeCloseTo(20 + KNOB / 2, 0);
  });

  it("two coincident cursors (fl = top = max): dots are at the SAME position (no visual split)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "fl", value: 600, label: "FL600" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const d = dots(host);
    // Both at value 600 → along = 0 → top:0px each (no fan-out)
    expect(d[0]!.style.top).toBe("0px");
    expect(d[1]!.style.top).toBe("0px");
  });

  it("two coincident cursors (fl = top = max): lower-indexed cursor has higher z-index", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "fl", value: 600, label: "FL600" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const d = dots(host);
    expect(parseInt(d[0]!.style.zIndex)).toBeGreaterThan(parseInt(d[1]!.style.zIndex || "0"));
  });

  it("three cursors: middle cursor (fl, index 1) has the highest z-index", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "base", value: 300, label: "300" },
      { name: "fl", value: 450, label: "FL450" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const d = dots(host);
    const zBase = parseInt(d[0]!.style.zIndex || "0");
    const zFl   = parseInt(d[1]!.style.zIndex || "0");
    const zTop  = parseInt(d[2]!.style.zIndex || "0");
    expect(zFl).toBeGreaterThan(zBase);
    expect(zFl).toBeGreaterThan(zTop);
  });

  it("two coincident cursors (fl = top = max): top-most label visible, duplicate hidden", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "fl", value: 600, label: "FL600" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const lb = labels(host);
    // fl (index 0, higher z) is visible; top (index 1, lower z) is hidden — same value
    expect(lb[0]!.style.visibility).not.toBe("hidden");
    expect(lb[1]!.style.visibility).toBe("hidden");
  });

  it("cursors with distinct values: all labels visible (no suppression)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "base", value: 0, label: "0" },
      { name: "fl", value: 300, label: "FL300" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const lb = labels(host);
    expect(lb[0]!.style.visibility).not.toBe("hidden");
    expect(lb[1]!.style.visibility).not.toBe("hidden");
    expect(lb[2]!.style.visibility).not.toBe("hidden");
  });

  it("three cursors fl=top coincident: fl label visible, top label hidden, base label visible", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "base", value: 560, label: "560" },
      { name: "fl", value: 600, label: "FL600" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const lb = labels(host);
    expect(lb[0]!.style.visibility).not.toBe("hidden"); // base 560 — distinct value
    expect(lb[1]!.style.visibility).not.toBe("hidden"); // fl 600 — highest z, visible
    expect(lb[2]!.style.visibility).toBe("hidden");     // top 600 — same value as fl, hidden
  });

  it("label text content is preserved correctly when coincident", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([jetGauge([
      { name: "fl", value: 600, label: "FL600" },
      { name: "top", value: 600, label: "600" },
    ])]);
    const lb = labels(host);
    expect(lb[0]!.textContent).toBe("FL600");
    expect(lb[1]!.textContent).toBe("600");
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

  it("a11y: the knob is a slider (role + aria-value*) and arrow keys step the value", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([{ id: "d", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "dial", name: "spd", min: 0, max: 100, value: 50, step: 5 }] } }]);
    const knob = cardEl(host).querySelector("circle.draw-adapter-widget-knob") as Element;
    expect(knob.getAttribute("role")).toBe("slider");
    expect(knob.getAttribute("tabindex")).toBe("0");
    expect(knob.getAttribute("aria-valuemin")).toBe("0");
    expect(knob.getAttribute("aria-valuemax")).toBe("100");
    expect(knob.getAttribute("aria-valuenow")).toBe("50");
    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(edits.at(-1)).toEqual({ id: "d", name: "spd", value: "55" }); // +step, emitted
    expect(knob.getAttribute("aria-valuenow")).toBe("55");
  });
});

describe("WidgetLayer — dial is a ring: its centre lets clicks through", () => {
  const dialOf = (radius?: number): MarkerWidget => ({ id: "dr", anchor: { lon: 0, lat: 0 },
    child: { dir: "h", items: [{ kind: "dial", name: "spd", min: 0, max: 100, value: 50, ...(radius ? { radius } : {}) }] } });

  it("the box (incl. the central hole) opts out of pointer events; the knob opts back in", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([dialOf()]);
    const dial = cardEl(host).querySelector(".draw-adapter-widget-dial") as HTMLElement;
    expect(dial.style.pointerEvents).toBe("none"); // a pointerdown in the centre falls through to the map below
    const knob = dial.querySelector("circle.draw-adapter-widget-knob") as SVGCircleElement;
    expect(knob.style.pointerEvents).toBe("auto");  // the ring's knob stays interactive
  });

  it("a lone-dial satellite card opts the WHOLE card out (inherits down to the box/svg)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([dialOf()]);
    const card = cardEl(host);
    // The break-point speed satellite is a bare ring centred on its anchor: the card itself (not just
    // the dial box) must let a centre press through, since `pointer-events` inherits down the tree.
    expect(card.style.pointerEvents).toBe("none");
  });

  it("a dial sharing a card with another control keeps the card interactive", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([{ id: "mix", anchor: { lon: 0, lat: 0 }, bg: "#fff",
      child: { dir: "v", items: [{ kind: "text", text: "JET" }, { kind: "dial", name: "spd", min: 0, max: 100, value: 50 }] } }]);
    expect(cardEl(host).style.pointerEvents).toBe("auto"); // not a lone dial ⇒ the card body stays a hit target
  });

  it("a transparent ring hit-area (pointer-events: stroke) captures only the couronne band", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([dialOf()]);
    const svg = cardEl(host).querySelector(".draw-adapter-widget-dial svg") as SVGElement;
    const hit = svg.lastElementChild as SVGCircleElement; // kept last so the visible glow/arc stay children[0]/[1]
    expect(hit.tagName.toLowerCase()).toBe("circle");
    expect(hit.getAttribute("stroke")).toBe("transparent");
    expect(hit.style.pointerEvents).toBe("stroke"); // only the stroke band hits; the hole stays transparent
  });

  it("the transparent hole tracks the dial radius (a bigger dial ⇒ a bigger hole)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const hole = (): number => {
      const hit = cardEl(host).querySelector(".draw-adapter-widget-dial svg circle:last-of-type") as SVGCircleElement;
      return Number(hit.getAttribute("r")) - Number(hit.getAttribute("stroke-width")) / 2; // inner radius of the band
    };
    layer.setWidgets([dialOf(40)]);
    const small = hole();
    layer.setWidgets([dialOf(80)]);
    expect(hole()).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0); // there IS a real hole even on the smaller dial
  });

  it("a drag on the ring band sets the value (the whole couronne stays interactive)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([dialOf()]);
    const hit = cardEl(host).querySelector(".draw-adapter-widget-dial svg circle:last-of-type") as SVGCircleElement;
    hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    hit.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 0 }));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[edits.length - 1]).toMatchObject({ id: "dr", name: "spd" });
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

// ── stack widget ──────────────────────────────────────────────────────────────

const STACK_W = (node: WidgetStack): MarkerWidget => ({
  id: "s1", anchor: { lon: 0, lat: 0 },
  child: { dir: "v", items: [node] },
});

const makeStack = (placement: "pinned" | "inline" = "inline", overrides: Partial<WidgetStack> = {}): WidgetStack => ({
  kind: "stack",
  editorPlacement: placement,
  min: 1,
  max: 4,
  items: [
    { id: "L1", preview: "Layer 1", body: { kind: "text", value: "Body 1" }, active: false, disabled: false },
    { id: "L2", preview: "Layer 2", body: { kind: "text", value: "Body 2" }, active: true,  disabled: true  },
    { id: "L3", preview: "Layer 3", body: { kind: "text", value: "Body 3" }, active: false, disabled: false },
  ],
  ...overrides,
});

describe("WidgetLayer — stack widget", () => {
  it("renders a .dap-stack container with a preview strip", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack())]);
    const stack = cardEl(host).querySelector(".dap-stack") as HTMLElement;
    expect(stack).not.toBeNull();
    const strip = stack.querySelector(".dap-stack-strip") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.querySelectorAll(".dap-stack-item").length).toBe(3);
  });

  it("inline mode: active item shows body, others show preview", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([STACK_W(makeStack("inline"))]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    expect(items.length).toBe(3);
    // L1 and L3 show preview
    expect((items[0]!.querySelector(".dap-stack-item-preview") as HTMLElement).style.display).not.toBe("none");
    expect((items[0]!.querySelector(".dap-stack-item-body") as HTMLElement).style.display).toBe("none");
    // L2 (active) shows body
    expect((items[1]!.querySelector(".dap-stack-item-preview") as HTMLElement).style.display).toBe("none");
    expect((items[1]!.querySelector(".dap-stack-item-body") as HTMLElement).style.display).not.toBe("none");
    expect(items[1]!.querySelector(".dap-stack-item-body")?.textContent).toContain("Body 2");
  });

  it("pinned mode: editor appears above the strip with active body", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([STACK_W(makeStack("pinned"))]);
    const stack = cardEl(host).querySelector(".dap-stack") as HTMLElement;
    const editor = stack.querySelector(".dap-stack-editor") as HTMLElement;
    expect(editor).not.toBeNull();
    expect(editor.querySelector(".dap-stack-editor-body")?.textContent).toContain("Body 2");
    // Editor precedes the strip in DOM
    expect(stack.children[0]).toBe(editor);
    expect(stack.children[1]).toHaveProperty("className", "dap-stack-strip");
    // Active twin in strip
    const twin = stack.querySelector(".dap-stack-twin");
    expect(twin).not.toBeNull();
  });

  it("pinned mode: twin item in strip shows preview with twin class", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([STACK_W(makeStack("pinned"))]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    expect(items[0]!.classList.contains("dap-stack-clickable")).toBe(true);
    expect(items[1]!.classList.contains("dap-stack-twin")).toBe(true);
    expect(items[1]!.classList.contains("dap-stack-clickable")).toBe(false);
    expect(items[2]!.classList.contains("dap-stack-clickable")).toBe(true);
  });

  it("string preview renders as textContent", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([STACK_W(makeStack("inline"))]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    expect(items[0]!.querySelector(".dap-stack-item-preview")?.textContent).toBe("Layer 1");
  });

  it("WidgetNode preview is reconciled", () => {
    const host = new FakeHost();
    const node = makeStack("inline");
    node.items[0] = { ...node.items[0]!, preview: { kind: "text", value: "FL050" } };
    new WidgetLayer(host).setWidgets([STACK_W(node)]);
    const preview = cardEl(host)
      .querySelectorAll(".dap-stack-item")[0]!
      .querySelector(".dap-stack-item-preview") as HTMLElement;
    expect(preview.textContent).toContain("FL050");
  });

  it("add button appears when count < max; absent when count >= max", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack("inline", { max: 4 }))]);
    expect(cardEl(host).querySelector(".dap-stack-add-btn")).not.toBeNull();
    // At max
    const four = makeStack("inline", { max: 3 });
    layer.setWidgets([STACK_W(four)]);
    expect(cardEl(host).querySelector(".dap-stack-add-btn")).toBeNull();
  });

  it("remove button appears when count > min; absent when count <= min", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack("inline", { min: 1 }))]);
    expect(cardEl(host).querySelector(".dap-stack-remove-btn")).not.toBeNull();
    // At min
    layer.setWidgets([STACK_W(makeStack("inline", { min: 3 }))]);
    expect(cardEl(host).querySelector(".dap-stack-remove-btn")).toBeNull();
  });

  it("clicking a clickable preview item emits selectLayer:<id>", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([STACK_W(makeStack("inline"))]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    // L1 is clickable
    pointer(items[0]!, "pointerdown");
    pointer(items[0]!, "pointerup");
    expect(actions.length).toBe(1);
    expect(actions[0]!.event).toBe("selectLayer:L1");
    expect(actions[0]!.id).toBe("s1");
  });

  it("clicking the twin / disabled item does NOT emit selectLayer", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([STACK_W(makeStack("inline"))]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    // L2 is active+disabled → not clickable
    pointer(items[1]!, "pointerdown");
    pointer(items[1]!, "pointerup");
    expect(actions.length).toBe(0);
  });

  it("+ button emits addLayer", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([STACK_W(makeStack("inline", { max: 4 }))]);
    const btn = cardEl(host).querySelector(".dap-stack-add-btn") as HTMLElement;
    pointer(btn, "pointerdown");
    pointer(btn, "pointerup");
    expect(actions.length).toBe(1);
    expect(actions[0]!.event).toBe("addLayer");
  });

  it("× button emits removeLayer:<activeId>", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([STACK_W(makeStack("inline", { min: 1 }))]);
    const btn = cardEl(host).querySelector(".dap-stack-remove-btn") as HTMLElement;
    pointer(btn, "pointerdown");
    pointer(btn, "pointerup");
    expect(actions.length).toBe(1);
    expect(actions[0]!.event).toBe("removeLayer:L2");
  });

  it("reconciles in place when active item changes", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack("inline"))]);
    // Switch active to L3
    const updated = makeStack("inline");
    updated.items[1] = { ...updated.items[1]!, active: false, disabled: false };
    updated.items[2] = { ...updated.items[2]!, active: true, disabled: true };
    layer.setWidgets([STACK_W(updated)]);
    const items = cardEl(host).querySelectorAll(".dap-stack-item");
    // L3 (idx 2) now shows body
    expect((items[2]!.querySelector(".dap-stack-item-body") as HTMLElement).style.display).not.toBe("none");
    expect(items[2]!.querySelector(".dap-stack-item-body")?.textContent).toContain("Body 3");
  });

  it("switching editorPlacement from inline to pinned adds the editor element", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack("inline"))]);
    expect(cardEl(host).querySelector(".dap-stack-editor")).toBeNull();
    layer.setWidgets([STACK_W(makeStack("pinned"))]);
    expect(cardEl(host).querySelector(".dap-stack-editor")).not.toBeNull();
  });

  it("switching from pinned back to inline removes the editor element", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([STACK_W(makeStack("pinned"))]);
    expect(cardEl(host).querySelector(".dap-stack-editor")).not.toBeNull();
    layer.setWidgets([STACK_W(makeStack("inline"))]);
    expect(cardEl(host).querySelector(".dap-stack-editor")).toBeNull();
  });
});

// ── multi-range gauge ────────────────────────────────────────────────────────

const mkRange = (id: string, color: string, bv: number, tv: number, bl?: string, tl?: string): WidgetRange => ({
  id, color,
  base: { name: `layers.${id}.baseFL`, value: bv, ...(bl ? { label: bl } : {}) },
  top:  { name: `layers.${id}.topFL`,  value: tv, ...(tl ? { label: tl } : {}) },
});

const rangeGaugeCard = (ranges: WidgetRange[], active?: number | string): MarkerWidget => ({
  id: "rg", anchor: { lon: 0, lat: 0 },
  child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 450, step: 10, length: 100, ranges, ...(active !== undefined ? { active } : {}) }] },
});

describe("WidgetLayer — multi-range gauge", () => {
  it("renders N colored bands and 2N knobs on a single shared axis", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([
      mkRange("0", "#d00", 50, 250, "FL050", "FL250"),
      mkRange("1", "#00d", 200, 400, "FL200", "FL400"),
    ])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const knobs = gauge.querySelectorAll(".draw-adapter-widget-knob");
    expect(knobs).toHaveLength(4); // 2 ranges × 2 knobs each
  });

  it("positions knobs by value (max at top, vertical), full-length axis guide", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("0", "#d00", 0, 450)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const knobs = gauge.querySelectorAll(".draw-adapter-widget-knob");
    // base=0 → top of knob at (1-0/450)*100 = 100; top=450 → 0
    expect(parseFloat((knobs[0] as HTMLElement).style.top)).toBeCloseTo(100); // base at bottom
    expect(parseFloat((knobs[1] as HTMLElement).style.top)).toBeCloseTo(0);   // top at top

    // axis guide spans the full length (not cursor-hugging)
    const track = gauge.children[1] as HTMLElement; // track is second child (trackHalo is first but hidden)
    expect(track.style.display).not.toBe("none");
    expect(parseFloat(track.style.height)).toBeCloseTo(100); // full length
  });

  it("trackHalo (cursor-mode glow) is hidden in range mode", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const trackHalo = gauge.children[0] as HTMLElement;
    expect(trackHalo.style.display).toBe("none");
  });

  it("each knob has role=slider + aria-value* attributes", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300, "FL100", "FL300")])]);
    const knobs = cardEl(host).querySelectorAll(".draw-adapter-widget-knob");
    const base = knobs[0] as HTMLElement;
    const top  = knobs[1] as HTMLElement;
    expect(base.getAttribute("role")).toBe("slider");
    expect(base.getAttribute("aria-valuemin")).toBe("0");
    expect(base.getAttribute("aria-valuemax")).toBe("450");
    expect(base.getAttribute("aria-valuenow")).toBe("100");
    expect(base.getAttribute("aria-label")).toBe("FL100");
    expect(top.getAttribute("aria-valuenow")).toBe("300");
    expect(top.getAttribute("aria-label")).toBe("FL300");
  });

  it("a pointerdown on a knob emits onWidgetEdit and does not start a card drag", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const knob = cardEl(host).querySelector(".draw-adapter-widget-knob") as HTMLElement;
    pointer(knob, "pointerdown", 5, 5);
    expect(host.emits).toHaveLength(0); // no card drag
    expect(edits).toHaveLength(1);
    expect(edits[0]!.name).toBe("layers.0.baseFL");
  });

  it("dragging base knob emits onWidgetEdit with the correct list-scoped name", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 50, 300)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const baseKnob = gauge.querySelectorAll(".draw-adapter-widget-knob")[0] as HTMLElement;
    pointer(baseKnob, "pointerdown", 5, 5);
    pointer(baseKnob, "pointermove", 5, 80); // move toward bottom (lower FL value)
    expect(edits.at(-1)!.name).toBe("layers.0.baseFL");
    expect(edits.at(-1)!.id).toBe("rg");
  });

  it("within-range clamping: base cannot exceed top during drag", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const baseKnob = gauge.querySelectorAll(".draw-adapter-widget-knob")[0] as HTMLElement;
    // drag base far above top (toward y=0 = max)
    pointer(baseKnob, "pointerdown", 5, 5);
    pointer(baseKnob, "pointermove", 5, 0);
    const emittedBase = parseFloat(edits.at(-1)!.value);
    expect(emittedBase).toBeLessThanOrEqual(300); // clamped to ≤ top value
  });

  it("band drag (pointerdown on halo) emits both base and top names per move", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    // halo is the first div after the track/trackHalo, with style.cursor=grab
    const halo = Array.from(gauge.children).find(
      (el) => (el as HTMLElement).style.cursor === "grab",
    ) as HTMLElement;
    expect(halo).toBeTruthy();
    pointer(halo, "pointerdown", 5, 50); // start band drag
    pointer(halo, "pointermove", 5, 40); // move up (toward higher FL)
    const names = edits.map((e) => e.name);
    expect(names).toContain("layers.0.baseFL");
    expect(names).toContain("layers.0.topFL");
  });

  it("band drag preserves width and clamps to [min, max]", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    // range spans 200 FL units (100→300), total axis 450
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halo = Array.from(gauge.children).find((el) => (el as HTMLElement).style.cursor === "grab") as HTMLElement;
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5, 200); // drag far downward (toward min)
    const lastBase = parseFloat(edits.find((e) => e.name === "layers.0.baseFL" && edits.indexOf(e) === edits.map(x => x.name).lastIndexOf("layers.0.baseFL"))?.value ?? "0");
    const lastTop  = parseFloat(edits.find((e) => e.name === "layers.0.topFL"  && edits.indexOf(e) === edits.map(x => x.name).lastIndexOf("layers.0.topFL"))?.value ?? "0");
    expect(lastBase).toBeGreaterThanOrEqual(0);   // clamped to min
    expect(lastTop - lastBase).toBeCloseTo(200, 0); // width preserved
  });

  it("active range is rendered on top (z-index > non-active range)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([
      mkRange("0", "#d00", 50, 250),
      mkRange("1", "#00d", 200, 400),
    ], "1")]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halos = Array.from(gauge.children).filter((el) => (el as HTMLElement).style.cursor === "grab") as HTMLElement[];
    expect(halos).toHaveLength(2);
    const z0 = parseInt(halos[0]!.style.zIndex);
    const z1 = parseInt(halos[1]!.style.zIndex);
    expect(z1).toBeGreaterThan(z0); // range "1" is active → higher z
  });

  it("reconciles range count in-place without recreating the gauge element (2 → 1 → 3)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 50, 250), mkRange("1", "#00d", 200, 400)])]);
    const gaugeEl = cardEl(host).querySelector(".draw-adapter-widget-gauge");
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(4);
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 50, 250)])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(2);
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 50, 250), mkRange("1", "#00d", 100, 300), mkRange("2", "#0d0", 200, 400)])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(6);
    expect(cardEl(host).querySelector(".draw-adapter-widget-gauge")).toBe(gaugeEl); // same element
  });

  it("switching from ranges to cursors removes range DOM and shows cursor knobs", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(2);
    // switch to cursor mode
    layer.setWidgets([{ id: "rg", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 450, length: 100, cursors: [{ name: "c", value: 200 }] }] } }]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-knob")).toHaveLength(1);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halo = Array.from(gauge.children).find((el) => (el as HTMLElement).style.cursor === "grab");
    expect(halo).toBeUndefined(); // no band halos left
  });

  it("arrow-key on a range knob steps the value and emits onWidgetEdit", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const knob = cardEl(host).querySelector(".draw-adapter-widget-knob") as HTMLElement;
    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(edits.at(-1)!.name).toBe("layers.0.baseFL");
    expect(parseFloat(edits.at(-1)!.value)).toBeLessThan(100); // stepped down
  });
});

// ── Ask 1: axis-aligned action buttons ────────────────────────────────────────

const rangeGaugeWithButton = (place: string | string[], gap = 0): MarkerWidget => ({
  id: "rg2", anchor: { lon: 0, lat: 0 },
  child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 450, step: 10, length: 100, ranges: [mkRange("0", "#d00", 100, 300)] }] },
  buttons: [{ event: "addLayer", place: place as never, ...(gap ? { gap } : {}) }],
});

describe("WidgetLayer — axis-top / axis-bottom buttons (Ask 1)", () => {
  it("axis-top creates exactly one action button", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeWithButton("axis-top")]);
    const btns = cardEl(host).querySelectorAll(".draw-adapter-widget-btn");
    expect(btns.length).toBe(1);
  });

  it("axis-bottom creates exactly one action button", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeWithButton("axis-bottom")]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(1);
  });

  it("tapping an axis-top button emits the button's event", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeWithButton("axis-top")]);
    const btn = cardEl(host).querySelector(".draw-adapter-widget-btn") as HTMLElement;
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    btn.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(actions).toEqual([{ id: "rg2", event: "addLayer" }]);
  });

  it("axis-top + axis-bottom as an array creates two buttons", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeWithButton(["axis-top", "axis-bottom"])]);
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(2);
  });

  it("no regression: normal top/bottom buttons still work", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([{ id: "nb", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "glyph", svg: "<svg></svg>" }] },
      buttons: [{ event: "do-it", place: ["top", "bottom"] }] }]);
    const btns = cardEl(host).querySelectorAll(".draw-adapter-widget-btn");
    expect(btns.length).toBe(2); // top + bottom
    const b = btns[0] as HTMLElement;
    b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
    b.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(actions[0]!.event).toBe("do-it");
  });

  it("mixed axis + normal place on same button creates correct button count", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeWithButton(["axis-top", "bottom-right"])]);
    // axis-top → 1 button; bottom-right → 1 button; total = 2
    expect(cardEl(host).querySelectorAll(".draw-adapter-widget-btn").length).toBe(2);
  });
});

// ── Ask 2: drag-to-trash gesture to delete a range ───────────────────────────
//
// Constants (mirror widget.ts):
//   FLING_SHOW_DX   =  8 px  — lateral dx that reveals the trash icon
//   FLING_COMMIT_DX = 50 px  — dx at which pointerup commits the delete

const FLING_SHOW_DX   = 8;
const FLING_COMMIT_DX = 50;

describe("WidgetLayer — range drag-to-trash gesture (Ask 2)", () => {
  const getHalo = (host: FakeHost): HTMLElement => {
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    return Array.from(gauge.children).find(
      (el) => (el as HTMLElement).style.cursor === "grab",
    ) as HTMLElement;
  };

  it("lateral drag past FLING_SHOW_DX reveals a trash icon on the card (2 ranges)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_SHOW_DX + 2, 50); // dx=10 > FLING_SHOW_DX=8
    const trash = cardEl(host).querySelector(".draw-adapter-range-trash") as HTMLElement | null;
    expect(trash).not.toBeNull();
    expect(trash!.style.display).toBe("flex"); // visible
  });

  it("trash icon is hidden before any lateral drag starts", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const trash = cardEl(host).querySelector(".draw-adapter-range-trash");
    expect(trash).toBeNull(); // not yet created (lazy)
  });

  it("trash icon is hidden again after drag ends (2 ranges)", () => {
    const host = new FakeHost();
    new WidgetLayer(host).setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_SHOW_DX + 2, 50); // reveals trash
    pointer(halo, "pointerup",   5 + FLING_SHOW_DX + 2, 50);
    const trash = cardEl(host).querySelector(".draw-adapter-range-trash") as HTMLElement;
    expect(trash.style.display).toBe("none"); // hidden after drag
  });

  it("drag past FLING_COMMIT_DX and release → emits removeRange with index (2 ranges)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_COMMIT_DX + 5, 50);
    pointer(halo, "pointerup",   5 + FLING_COMMIT_DX + 5, 50);
    expect(actions.length).toBe(1);
    expect(actions[0]!.event).toMatch(/^removeRange:0/);
    expect(actions[0]!.id).toBe("rg");
  });

  it("removeRange event encodes rangeId when present (2 ranges)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("myband", "#d00", 100, 300), mkRange("other", "#00d", 300, 400)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_COMMIT_DX + 5, 50);
    pointer(halo, "pointerup",   5 + FLING_COMMIT_DX + 5, 50);
    expect(actions[0]!.event).toBe("removeRange:0:myband");
  });

  it("second range emits removeRange:1", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([
      mkRange("a", "#d00", 50, 200),
      mkRange("b", "#00d", 200, 400),
    ])]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halos = Array.from(gauge.children).filter(
      (el) => (el as HTMLElement).style.cursor === "grab",
    ) as HTMLElement[];
    const halo1 = halos[1]!;
    pointer(halo1, "pointerdown", 5, 50);
    pointer(halo1, "pointermove", 5 + FLING_COMMIT_DX + 5, 50);
    pointer(halo1, "pointerup",   5 + FLING_COMMIT_DX + 5, 50);
    expect(actions[0]!.event).toBe("removeRange:1:b");
  });

  it("vertical drag never emits removeRange (emits onWidgetEdit only)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5, 30); // |dy|=20 > |dx|=0 → vertical
    pointer(halo, "pointerup",   5, 30);
    expect(actions.filter(a => a.event.startsWith("removeRange"))).toHaveLength(0);
    expect(edits.length).toBeGreaterThan(0);
  });

  it("lateral nudge below FLING_SHOW_DX: no trash shown, no removeRange", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_SHOW_DX - 2, 50); // dx=6 < FLING_SHOW_DX=8 → pending
    pointer(halo, "pointerup",   5 + FLING_SHOW_DX - 2, 50);
    expect(actions).toHaveLength(0);
    // trash should not even have been created
    expect(cardEl(host).querySelector(".draw-adapter-range-trash")).toBeNull();
  });

  it("trash shown but released before FLING_COMMIT_DX: snap-back, no removeRange (2 ranges)", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown",  5, 50);
    pointer(halo, "pointermove", 5 + FLING_SHOW_DX + 2, 50); // reveals trash (dx=10)
    pointer(halo, "pointerup",   5 + FLING_COMMIT_DX - 5, 50); // dx=45 < 50 → no commit
    expect(actions).toHaveLength(0);
    expect(halo.style.transform).toBe(""); // band snapped back
  });

  it("single remaining range: trash icon never shown even on lateral drag past commit", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    // Only one range → minimum reached, deletion is a no-op at lib level
    layer.setWidgets([rangeGaugeCard([mkRange("0", "#d00", 100, 300)])]);
    const halo = getHalo(host);
    pointer(halo, "pointerdown", 5, 50);
    pointer(halo, "pointermove", 5 + FLING_COMMIT_DX + 10, 50); // well past commit dx
    pointer(halo, "pointerup",   5 + FLING_COMMIT_DX + 10, 50);
    expect(actions).toHaveLength(0); // no removeRange
    expect(cardEl(host).querySelector(".draw-adapter-range-trash")).toBeNull(); // trash not created
  });

  it("two ranges: trash appears and deletion works; once one is removed, trash stays disabled", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetAction((e) => actions.push(e));
    layer.setWidgets([rangeGaugeCard([mkRange("a", "#d00", 50, 200), mkRange("b", "#00d", 200, 400)])]);
    const gauge = () => cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halos = () => Array.from(gauge().children).filter(
      (el) => (el as HTMLElement).style.cursor === "grab",
    ) as HTMLElement[];
    // First range: trash should appear (2 ranges → deletion allowed)
    const halo0 = halos()[0]!;
    pointer(halo0, "pointerdown", 5, 50);
    pointer(halo0, "pointermove", 5 + FLING_SHOW_DX + 2, 50);
    expect(cardEl(host).querySelector(".draw-adapter-range-trash")).not.toBeNull();
    expect((cardEl(host).querySelector(".draw-adapter-range-trash") as HTMLElement).style.display).toBe("flex");
    pointer(halo0, "pointerup",   5 + FLING_COMMIT_DX + 5, 50);
    expect(actions[0]!.event).toMatch(/^removeRange:0/);
    // Simulate lib removing the first range → only 1 range left
    layer.setWidgets([rangeGaugeCard([mkRange("b", "#00d", 200, 400)])]);
    const halo1 = halos()[0]!;
    pointer(halo1, "pointerdown", 5, 50);
    pointer(halo1, "pointermove", 5 + FLING_COMMIT_DX + 10, 50);
    pointer(halo1, "pointerup",   5 + FLING_COMMIT_DX + 10, 50);
    expect(actions).toHaveLength(1); // no second removeRange
  });

  it("horizontal gauge: large horizontal drag emits edit, not removeRange", () => {
    const host = new FakeHost();
    const layer = new WidgetLayer(host);
    const edits: WidgetEdit[] = [];
    const actions: { id: string; event: string }[] = [];
    layer.onWidgetEdit((e) => edits.push(e));
    layer.onWidgetAction((e) => actions.push(e));
    const hGauge: MarkerWidget = {
      id: "hg", anchor: { lon: 0, lat: 0 },
      child: { dir: "h", items: [{ kind: "gauge", min: 0, max: 450, step: 10, length: 100,
        orientation: "horizontal", ranges: [mkRange("0", "#d00", 100, 300)] }] },
    };
    layer.setWidgets([hGauge]);
    const gauge = cardEl(host).querySelector(".draw-adapter-widget-gauge") as HTMLElement;
    const halo = Array.from(gauge.children).find(
      (el) => (el as HTMLElement).style.cursor === "grab",
    ) as HTMLElement;
    pointer(halo, "pointerdown", 50, 5);
    pointer(halo, "pointermove", 50 + FLING_COMMIT_DX + 10, 5);
    pointer(halo, "pointerup",   50 + FLING_COMMIT_DX + 10, 5);
    expect(actions.filter(a => a.event.startsWith("removeRange"))).toHaveLength(0);
    expect(edits.length).toBeGreaterThan(0);
  });
});
