// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";

import { snapshotScale, downloadPng, copyPng } from "../src/index.js";
import { snapshotToolbarItem, deliverSnapshot, SNAPSHOT_ICON_SVG } from "../src/snapshot.js";
import { populateToolbar } from "../src/toolbar.js";
import { LeafletAdapter } from "../src/leaflet.js";
import { FakeAdapter } from "../src/testing.js";
import type { LayerSpec, SnapshotLevel } from "../src/index.js";

describe("snapshotScale — preset → output pixel-ratio", () => {
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
  it("none falls back to native (button is built only for non-none)", () =>
    expect(snapshotScale("none")).toBe((typeof window !== "undefined" && window.devicePixelRatio) || 1));
});

describe("snapshotToolbarItem — one button, two deliveries (plain vs modifier-click)", () => {
  const cap = (supported: boolean, snapshot = vi.fn().mockResolvedValue(new Blob())) =>
    ({ supported, ...(supported ? {} : { reason: "nope" }), snapshot });

  it("returns null for the `none` preset (no button)", () => {
    expect(snapshotToolbarItem("none", cap(true))).toBeNull();
    expect(snapshotToolbarItem({ state: "none", onClick: "clipboard" }, cap(true))).toBeNull();
  });

  it("supported ⇒ enabled camera button; plain click delivers the `onClick` target", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem("high", cap(true, snapshot))!; // default onClick = "download"
    expect(item.id).toBe("snapshot");
    expect(item.svg).toBe(SNAPSHOT_ICON_SVG);
    expect(item.disabled).toBeUndefined();
    expect(item.title).toContain("Download map");
    expect(item.title).toContain("click to copy");
    item.onClick(); // no event ⇒ primary
    expect(snapshot).toHaveBeenCalledWith({ scale: 3, target: "download" });
  });

  it("a modifier-click (ctrl OR meta) delivers the OTHER target", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem("low", cap(true, snapshot))!; // primary download, secondary clipboard
    item.onClick({ ctrlKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "clipboard" });
    item.onClick({ metaKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "clipboard" });
    item.onClick(); // plain ⇒ back to primary
    expect(snapshot).toHaveBeenLastCalledWith({ scale: 1, target: "download" });
  });

  it("onClick: 'clipboard' swaps the roles (plain = copy, modifier = download)", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem({ state: "native", onClick: "clipboard" }, cap(true, snapshot))!;
    expect(item.title).toContain("Copy map to clipboard");
    expect(item.title).toContain("click to download");
    item.onClick();
    expect(snapshot).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "clipboard" });
    item.onClick({ metaKey: true } as MouseEvent);
    expect(snapshot).toHaveBeenLastCalledWith({ scale: snapshotScale("native"), target: "download" });
  });

  it("unsupported ⇒ a DISABLED button whose title is the reason, click is a no-op", () => {
    const snapshot = vi.fn();
    const item = snapshotToolbarItem("native", cap(false, snapshot))!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("nope");
    item.onClick();
    expect(snapshot).not.toHaveBeenCalled();
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
    populateToolbar(el, [{ id: "snapshot", title: "nope", label: "📷", disabled: true, onClick }]);
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
    const bar = a.addToolbar([{ id: "circle", title: "Circle", label: "○", onClick: vi.fn() }]);
    const btn = snapBtn(bar)!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("not supported on the Leaflet adapter");
    a.destroy();
  });

  it("omits the snapshot button when snapshot: 'none'", async () => {
    const a = new LeafletAdapter({ map, layers: LAYERS });
    await a.ready();
    const bar = a.addToolbar([{ id: "circle", title: "Circle", label: "○", onClick: vi.fn() }], { snapshot: "none" });
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
