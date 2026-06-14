import { describe, expect, it } from "vitest";

import { densifyBboxRing, unwrapEast, warnOnce } from "../src/geo.js";
import type { LngLatBounds } from "../src/index.js";

describe("geo — unwrapEast (antimeridian)", () => {
  it("leaves a normal bbox (east > west) unchanged", () => {
    expect(unwrapEast(-90, 30)).toBe(30);
    expect(unwrapEast(0, 180)).toBe(180);
  });

  it("unwraps a dateline-crossing bbox (east <= west) by +360", () => {
    expect(unwrapEast(110, -110)).toBe(250); // WAFS area M
    expect(unwrapEast(170, -170)).toBe(190);
  });

  it("treats east === west as a full wrap (+360), not a zero span", () => {
    expect(unwrapEast(50, 50)).toBe(410);
  });
});

describe("geo — densifyBboxRing", () => {
  const ext: LngLatBounds = [-90, 0, 30, 90];

  it("returns a closed ring with 4*perEdge + 1 points", () => {
    const ring = densifyBboxRing(ext, 8);
    expect(ring).toHaveLength(4 * 8 + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
  });

  it("stays within the bbox corners (normal case)", () => {
    const ring = densifyBboxRing(ext, 16);
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThanOrEqual(-90);
      expect(lon).toBeLessThanOrEqual(30);
      expect(lat).toBeGreaterThanOrEqual(0);
      expect(lat).toBeLessThanOrEqual(90);
    }
  });

  it("samples each edge, not just the corners", () => {
    const ring = densifyBboxRing(ext, 4);
    // bottom edge points sit at lat=s with lon strictly between the corners
    const interiorBottom = ring.filter(([lon, lat]) => lat === 0 && lon > -90 && lon < 30);
    expect(interiorBottom.length).toBeGreaterThan(0);
  });

  it("emits unwrapped longitudes (>180) for a dateline-crossing bbox", () => {
    const ring = densifyBboxRing([110, -10, -110, 72], 16); // area M
    const maxLon = Math.max(...ring.map(([lon]) => lon));
    expect(maxLon).toBeGreaterThan(180); // continuous span, not split
    expect(maxLon).toBeCloseTo(250, 5);
  });

  it("clamps perEdge to at least 1 segment", () => {
    const ring = densifyBboxRing(ext, 0);
    expect(ring.length).toBe(4 * 1 + 1);
  });
});

describe("geo — warnOnce", () => {
  it("logs a given message at most once", () => {
    const calls: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => { calls.push(String(m)); };
    try {
      warnOnce("geo-test-unique-message-α");
      warnOnce("geo-test-unique-message-α");
      warnOnce("geo-test-unique-message-β");
    } finally {
      console.warn = orig;
    }
    expect(calls.filter((m) => m === "geo-test-unique-message-α")).toHaveLength(1);
    expect(calls).toContain("geo-test-unique-message-β");
  });
});
