import { describe, expect, it } from "vitest";

import { num, str, bool, deg2rad, rgba, wrapLabel } from "../src/coerce.js";

describe("num", () => {
  it("returns the number when finite", () => expect(num(3.5, 1)).toBe(3.5));
  it("falls back for non-numbers", () => {
    expect(num(undefined, 7)).toBe(7);
    expect(num("4", 7)).toBe(7);
    expect(num(null, 7)).toBe(7);
  });
  it("falls back for NaN/Infinity", () => {
    expect(num(NaN, 2)).toBe(2);
    expect(num(Infinity, 2)).toBe(2);
  });
});

describe("str", () => {
  it("returns the string", () => expect(str("hi")).toBe("hi"));
  it("falls back to '' (or provided default)", () => {
    expect(str(undefined)).toBe("");
    expect(str(5, "x")).toBe("x");
  });
});

describe("bool", () => {
  it("is true only for true", () => {
    expect(bool(true)).toBe(true);
    expect(bool(1)).toBe(false);
    expect(bool("true")).toBe(false);
    expect(bool(undefined)).toBe(false);
  });
});

describe("deg2rad", () => {
  it("converts degrees to radians", () => {
    expect(deg2rad(0)).toBe(0);
    expect(deg2rad(180)).toBeCloseTo(Math.PI, 10);
    expect(deg2rad(90)).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe("rgba", () => {
  it("expands #rgb", () => expect(rgba("#f80", 0.5)).toBe("rgba(255, 136, 0, 0.5)"));
  it("expands #rrggbb", () => expect(rgba("#58a6ff", 1)).toBe("rgba(88, 166, 255, 1)"));
  it("trims then parses", () => expect(rgba("  #000000 ", 0.2)).toBe("rgba(0, 0, 0, 0.2)"));
  it("passes non-hex through unchanged", () => {
    expect(rgba("red", 0.3)).toBe("red");
    expect(rgba("rgb(1,2,3)", 0.3)).toBe("rgb(1,2,3)");
    expect(rgba("#abcd", 0.3)).toBe("#abcd"); // 4-digit not supported → passthrough
  });
});

describe("wrapLabel", () => {
  it("returns text unchanged when maxPx <= 0", () => expect(wrapLabel("a b c", 0, 12)).toBe("a b c"));
  it("returns text unchanged when empty", () => expect(wrapLabel("", 100, 12)).toBe(""));
  it("wraps into multiple lines past the width (jsdom canvas measures ~0 → no-op, but never throws)", () => {
    // jsdom has no real 2D metrics; the helper must degrade gracefully, not throw.
    expect(() => wrapLabel("alpha beta gamma delta", 20, 12)).not.toThrow();
  });
});
