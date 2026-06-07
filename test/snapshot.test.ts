// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as L from "leaflet";

import { snapshotScale, downloadPng } from "../src/index.js";
import { snapshotToolbarItem, SNAPSHOT_ICON_SVG } from "../src/snapshot.js";
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

describe("snapshotToolbarItem", () => {
  const cap = (supported: boolean, snapshot = vi.fn().mockResolvedValue(new Blob())) =>
    ({ supported, ...(supported ? {} : { reason: "nope" }), snapshot });

  it("returns null for the `none` preset (no button)", () =>
    expect(snapshotToolbarItem("none", cap(true))).toBeNull());

  it("supported ⇒ an enabled camera button calling snapshot({scale}) on click", () => {
    const snapshot = vi.fn().mockResolvedValue(new Blob());
    const item = snapshotToolbarItem("high", cap(true, snapshot))!;
    expect(item.id).toBe("snapshot");
    expect(item.svg).toBe(SNAPSHOT_ICON_SVG);
    expect(item.title).toBe("Capture map");
    expect(item.disabled).toBeUndefined();
    item.onClick();
    expect(snapshot).toHaveBeenCalledWith({ scale: 3 });
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
