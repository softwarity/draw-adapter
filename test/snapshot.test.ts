// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";

import { snapshotScale, downloadPng, copyPng, shutterFlash } from "../src/index.js";
import { snapshotToolbarItem, deliverSnapshot, SNAPSHOT_ICON_SVG } from "../src/snapshot.js";
import { populateToolbar } from "../src/toolbar.js";
import { LeafletAdapter } from "../src/leaflet.js";
import { FakeAdapter } from "../src/testing.js";
import type { LayerSpec } from "../src/index.js";

describe("snapshotScale — quality → output pixel-ratio", () => {
  it("low → 1", () => expect(snapshotScale("low")).toBe(1));
  it("medium → 2", () => expect(snapshotScale("medium")).toBe(2));
  it("high → 3", () => expect(snapshotScale("high")).toBe(3));
  it("native → devicePixelRatio (1 in jsdom)", () => {
    expect(snapshotScale("native")).toBe((typeof window !== "undefined" && window.devicePixelRatio) || 1);
  });
  it("native honours an overridden devicePixelRatio", () => {
    const prev = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2.5, configurable: true });
    expect(snapshotScale("native")).toBe(2.5);
    Object.defineProperty(window, "devicePixelRatio", { value: prev, configurable: true });
  });
});

describe("snapshotToolbarItem — one button, two deliveries (plain vs modifier-click)", () => {
  const cap = (supported: boolean, snapshot = vi.fn().mockResolvedValue(new Blob())) =>
    ({ supported, ...(supported ? {} : { reason: "nope" }), snapshot });

  it("hides the button for any explicit off value (`null`/`false`/`\"none\"`)", () => {
    expect(snapshotToolbarItem("none", cap(true))).toBeNull();
    expect(snapshotToolbarItem(null, cap(true))).toBeNull();
    expect(snapshotToolbarItem(false, cap(true))).toBeNull();
  });

  it("`undefined` ⇒ a button with defaults (native quality, download)", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem(undefined, cap(true, snapshot))!;
    expect(item).not.toBeNull();
    expect(item.title).toMatch(/^Snapshot: click to file/);
    item.onClick();
    expect(snapshot).toHaveBeenCalledWith({ scale: snapshotScale("native"), target: "download" });
  });

  it("supported ⇒ enabled camera button; plain click delivers the `onClick` target", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem({ quality: "high" }, cap(true, snapshot))!; // default onClick = "download"
    expect(item.id).toBe("snapshot");
    expect(item.svg).toBe(SNAPSHOT_ICON_SVG);
    expect(item.disabled).toBeUndefined();
    expect(item.title).toMatch(/^Snapshot: click to file/); // primary = download
    expect(item.title).toContain("+click to clipboard");    // secondary spelled out, fixed
    item.onClick(); // no event ⇒ primary
    expect(snapshot).toHaveBeenCalledWith({ scale: 3, target: "download" });
  });

  it("a modifier-click (ctrl OR meta) delivers the OTHER target", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem({ quality: "low" }, cap(true, snapshot))!; // primary download, secondary clipboard
    item.onClick({ ctrlKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "clipboard" });
    item.onClick({ metaKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "clipboard" });
    item.onClick(); // plain ⇒ back to primary
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "download" });
  });

  it("onClick: 'clipboard' swaps the roles (plain = copy, modifier = download)", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem({ quality: "native", onClick: "clipboard" }, cap(true, snapshot))!;
    expect(item.title).toMatch(/^Snapshot: click to clipboard/); // primary = clipboard
    expect(item.title).toContain("+click to file");              // secondary spelled out, fixed
    item.onClick();
    expect(snapshot).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "clipboard" });
    item.onClick({ metaKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "download" });
  });

  it("unsupported ⇒ a DISABLED button whose title is the reason, click is a no-op", () => {
    const snapshot = vi.fn();
    const item = snapshotToolbarItem({ quality: "native" }, cap(false, snapshot))!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("nope");
    item.onClick();
    expect(snapshot).not.toHaveBeenCalled();
    expect(item.onRender).toBeUndefined(); // no live preview wiring for a disabled button
  });

  it("plays the shutter flash on a successful capture, but not on failure", async () => {
    const flash = vi.fn();
    snapshotToolbarItem({ quality: "native" }, { supported: true, snapshot: vi.fn().mockResolvedValue(new Blob()), flash })!.onClick();
    await vi.waitFor(() => expect(flash).toHaveBeenCalledOnce());

    const flash2 = vi.fn();
    snapshotToolbarItem({ quality: "native" }, { supported: true, snapshot: vi.fn().mockRejectedValue(new Error("x")), flash: flash2 })!.onClick();
    await new Promise((r) => setTimeout(r));
    expect(flash2).not.toHaveBeenCalled();
  });

  it("passes hideOverlays through to snapshot() (and omits it when empty/absent)", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    snapshotToolbarItem({ quality: "native", hideOverlays: ["handles", "edge"] }, { supported: true, snapshot })!.onClick();
    expect(snapshot).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "download", hideOverlays: ["handles", "edge"] });

    const snapshot2 = vi.fn().mockResolvedValue(new Blob());
    snapshotToolbarItem({ quality: "native", hideOverlays: [] }, { supported: true, snapshot: snapshot2 })!.onClick();
    expect(snapshot2).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "download" }); // empty ⇒ omitted
  });

  it("shutter:false suppresses the flash even on a successful capture", async () => {
    const flash = vi.fn();
    snapshotToolbarItem({ quality: "native", shutter: false }, { supported: true, snapshot: vi.fn().mockResolvedValue(new Blob()), flash })!.onClick();
    await new Promise((r) => setTimeout(r));
    expect(flash).not.toHaveBeenCalled();
  });

  it("hovering + holding a modifier swaps the ICON only; the tooltip stays fixed", () => {
    const item = snapshotToolbarItem({ quality: "native" }, cap(true))!; // primary download
    const btn = document.createElement("button");
    btn.title = item.title; // populateToolbar would set this; it must never change after
    item.onRender!(btn);
    // Both icons are the camera; the lens fill is the difference (download = filled,
    // clipboard = empty ring). Read the <circle> fill straight off the DOM.
    const isDownload = () => btn.querySelector("circle")?.getAttribute("fill") === "currentColor";
    const isClipboard = () => !btn.querySelector("circle")?.getAttribute("fill");
    const fixedTitle = item.title;

    btn.dispatchEvent(new MouseEvent("mouseenter")); // plain hover ⇒ primary (download) icon
    expect(isDownload()).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true })); // icon ⇒ alternate
    expect(isClipboard()).toBe(true);
    expect(btn.title).toBe(fixedTitle); // tooltip unchanged

    window.dispatchEvent(new KeyboardEvent("keyup")); // released ⇒ primary icon again
    expect(isDownload()).toBe(true);
    expect(btn.title).toBe(fixedTitle);

    btn.dispatchEvent(new MouseEvent("mouseleave")); // unhook key listeners
    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true }));
    expect(isDownload()).toBe(true); // no longer reacts after leave
  });
});

describe("shutterFlash", () => {
  it("overlays a self-removing curtain shutter (two blades) and injects its style once", () => {
    const c = document.createElement("div");
    document.body.appendChild(c);
    shutterFlash(c);
    const wrap = c.querySelector(".draw-adapter-shutter");
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelectorAll("i")).toHaveLength(2); // top + bottom blade
    expect(document.getElementById("draw-adapter-shutter-style")).not.toBeNull();
    wrap!.querySelector("i.b")!.dispatchEvent(new Event("animationend")); // both end together
    expect(c.querySelector(".draw-adapter-shutter")).toBeNull();
    c.remove();
  });
});

describe("deliverSnapshot — routes a captured Blob by target", () => {
  it("'blob'/undefined ⇒ returns the Blob, no side effect", async () => {
    const blob = new Blob([], { type: "image/png" });
    expect(await deliverSnapshot(blob)).toBe(blob);
    expect(await deliverSnapshot(blob, { target: "blob" })).toBe(blob);
  });

  it("'clipboard' ⇒ writes via the Clipboard API and returns the Blob", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class { constructor(public items: unknown) {} });
    vi.stubGlobal("navigator", { clipboard: { write } });
    const blob = new Blob([], { type: "image/png" });
    expect(await deliverSnapshot(blob, { target: "clipboard" })).toBe(blob);
    expect(write).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("'clipboard' issues the write SYNCHRONOUSLY, before the capture resolves (gesture-safe)", () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class { constructor(public items: unknown) {} });
    vi.stubGlobal("navigator", { clipboard: { write } });
    let resolveCapture!: (b: Blob) => void;
    const capture = new Promise<Blob>((r) => { resolveCapture = r; });
    deliverSnapshot(capture, { target: "clipboard" }); // capture still pending
    expect(write).toHaveBeenCalledOnce();               // …yet write() already fired
    resolveCapture(new Blob([], { type: "image/png" }));
    vi.unstubAllGlobals();
  });

  it("'download' ⇒ triggers a download and returns the Blob", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() } as never);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const blob = new Blob([], { type: "image/png" });
    expect(await deliverSnapshot(blob, { target: "download", filename: "x.png" })).toBe(blob);
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("copyPng", () => {
  it("writes a PNG ClipboardItem via the async Clipboard API", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class { constructor(public items: unknown) {} });
    vi.stubGlobal("navigator", { clipboard: { write } });
    await copyPng(new Blob([], { type: "image/png" }));
    expect(write).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("rejects when image clipboard write is unavailable (no secure context / support)", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", {});
    await expect(copyPng(new Blob([], { type: "image/png" }))).rejects.toThrow(/Clipboard image write is unavailable/);
    vi.unstubAllGlobals();
  });
});

describe("populateToolbar — disabled items", () => {
  it("renders a disabled <button> with its title and no click wiring", () => {
    const el = document.createElement("div");
    const onClick = vi.fn();
    populateToolbar(el, [{ id: "snapshot", title: "nope", svg: "<svg></svg>", disabled: true, onClick }]);
    const btn = el.querySelector("button")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("nope");
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("downloadPng", () => {
  it("creates an object URL and clicks a transient <a download>", () => {
    const createURL = vi.fn(() => "blob:fake");
    const revokeURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createURL, revokeObjectURL: revokeURL } as never);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadPng(new Blob([], { type: "image/png" }), "map.png");
    expect(createURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeURL).toHaveBeenCalledWith("blob:fake");
    expect(document.querySelector("a[download]")).toBeNull(); // the <a> was removed
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("FakeAdapter snapshot", () => {
  it("is supported and resolves to a PNG Blob", async () => {
    const a = new FakeAdapter();
    expect(a.snapshotSupported).toBe(true);
    const blob = await a.snapshot();
    expect(blob.type).toBe("image/png");
  });
});

// ── Leaflet: the snapshot button is shown but DISABLED, and snapshot() rejects ──
function sizedContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  for (const [k, v] of [["clientWidth", 800], ["clientHeight", 600], ["offsetWidth", 800], ["offsetHeight", 600]] as const) {
    Object.defineProperty(el, k, { value: v, configurable: true });
  }
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
  return el;
}

const LAYERS: LayerSpec[] = [
  { id: "area", kind: "fill" },
  { id: "handles", kind: "circle" },
];

describe("LeafletAdapter — snapshot", () => {
  let map: L.Map;
  let el: HTMLElement;
  beforeEach(() => {
    el = sizedContainer();
    map = L.map(el, { center: [10, 10], zoom: 4, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
  });
  afterEach(() => {
    try { map.remove(); } catch { /* ignore */ }
    document.body.innerHTML = "";
  });

  const snapBtn = (bar: HTMLElement) => bar.querySelector<HTMLButtonElement>('button[data-tool="snapshot"]');

  it("adds a DISABLED snapshot button by default (native preset) with the reason as tooltip", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }]);
    const btn = snapBtn(bar)!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("not supported on the Leaflet adapter");
    a.destroy();
  });

  it("omits the snapshot button when snapshot: 'none'", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "circle", title: "Circle", onClick: vi.fn() }], { snapshot: "none" });
    expect(snapBtn(bar)).toBeNull();
    a.destroy();
  });

  it("snapshot() rejects (no native exportable canvas)", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    await expect(a.snapshot()).rejects.toThrow(/not supported on the Leaflet adapter/);
    a.destroy();
  });
});

// Mark the actual GL/canvas capture (MapLibre/OpenLayers) as MANUAL verification:
// jsdom has no WebGL nor real 2D compositing, so a faithful pixel snapshot cannot
// be asserted here. The toolbar wiring + supported flag are covered above; the
// MapLibre adapter's enabled snapshot button is asserted in maplibre.test.ts.
describe.skip("MapLibre/OpenLayers real capture (manual verification)", () => {
  it("captures basemap + overlays to a PNG (run in a browser)", () => { /* manual */ });
});
