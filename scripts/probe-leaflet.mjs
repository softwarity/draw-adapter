// Headless DOM probe: mount the LeafletAdapter in jsdom, push a handles overlay,
// and report what actually lands in the DOM (panes, z-index, vector/marker counts).
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body><div id="map"></div></body>`, { pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
for (const k of ["Image", "HTMLElement", "SVGElement", "Element", "Node", "MouseEvent", "Event", "getComputedStyle", "DOMParser"]) {
  globalThis[k] = window[k];
}

// Give the map container a real size (jsdom reports 0).
const el = window.document.getElementById("map");
Object.defineProperties(el, {
  clientWidth: { value: 800 }, clientHeight: { value: 600 },
  offsetWidth: { value: 800 }, offsetHeight: { value: 600 },
});
el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });

const L = await import("leaflet");
const { LeafletAdapter } = await import("../dist/leaflet.js");

const map = L.map(el, { center: [10, 10], zoom: 4, fadeAnimation: false, zoomAnimation: false });

const LAYERS = [
  { id: "area", kind: "fill" },
  { id: "guide", kind: "line" },
  { id: "handles", kind: "circle" },
  { id: "label", kind: "text" },
];
const adapter = new LeafletAdapter({ map, layers: LAYERS, hitOverlays: new Set(["handles", "area"]) });
await adapter.ready();

adapter.setOverlay("handles", {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { role: "v0", fill: "#ffffff", stroke: "#58a6ff", radius: 7, strokeWidth: 2 } },
    { type: "Feature", geometry: { type: "Point", coordinates: [11, 11] }, properties: { role: "move", move: true, fill: "#fff", stroke: "#58a6ff", radius: 5, strokeWidth: 2, icon: "data:image/svg+xml,<svg/>" } },
  ],
});
adapter.setOverlay("area", {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[9, 9], [12, 9], [12, 12], [9, 12], [9, 9]]] }, properties: { fillColor: "#f0883e", fillOpacity: 0.35, stroke: "#f0883e", strokeWidth: 2 } }],
});

const container = map.getContainer();
const panes = [...container.querySelectorAll(".leaflet-pane")].map((p) => ({
  cls: p.className.replace("leaflet-pane ", ""),
  z: p.style.zIndex || "(none)",
  svgs: p.querySelectorAll("svg").length,
  paths: p.querySelectorAll("path").length,
  circles: p.querySelectorAll("circle").length,
  markers: p.querySelectorAll(".leaflet-marker-icon").length,
}));
console.log("PANES:");
for (const p of panes) console.log(" ", JSON.stringify(p));
console.log("total <path>:", container.querySelectorAll("path").length);
console.log("total <circle>:", container.querySelectorAll("circle").length);
console.log("total markers:", container.querySelectorAll(".leaflet-marker-icon").length);
