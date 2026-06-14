import { describe, expect, it } from "vitest";

import { boxBorderWidth, boxPadding, boxRadius, textBoxBorderWidth } from "../src/textbox.js";

describe("textbox presets", () => {
  it("boxPadding maps the size preset to [vertical, horizontal] px (default medium)", () => {
    expect(boxPadding("small")).toEqual([3, 5]);
    expect(boxPadding("medium")).toEqual([6, 8]);
    expect(boxPadding("large")).toEqual([10, 13]);
    expect(boxPadding(undefined)).toEqual([6, 8]); // default
    expect(boxPadding("bogus")).toEqual([6, 8]); // unknown ⇒ default
  });

  it("boxRadius maps the radius preset to px (default none = 0)", () => {
    expect(boxRadius("none")).toBe(0);
    expect(boxRadius("small")).toBe(3);
    expect(boxRadius("medium")).toBe(6);
    expect(boxRadius("round")).toBe(14);
    expect(boxRadius(undefined)).toBe(0); // default
    expect(boxRadius("bogus")).toBe(0); // unknown ⇒ default
  });

  it("boxBorderWidth (widget card) maps the preset to px (default medium = 1px)", () => {
    expect(boxBorderWidth("small")).toBe(0.5);
    expect(boxBorderWidth("medium")).toBe(1);
    expect(boxBorderWidth("large")).toBe(2);
    expect(boxBorderWidth(undefined)).toBe(1); // default = medium (former 1px look)
    expect(boxBorderWidth("bogus")).toBe(1); // unknown ⇒ default
  });

  it("textBoxBorderWidth (overlay label box) — heavier scale, default medium = 1.4px", () => {
    expect(textBoxBorderWidth("small")).toBe(0.8);
    expect(textBoxBorderWidth("medium")).toBe(1.4);
    expect(textBoxBorderWidth("large")).toBe(2.2);
    expect(textBoxBorderWidth(undefined)).toBe(1.4); // default = medium (former MapLibre 1.4px look)
    expect(textBoxBorderWidth("bogus")).toBe(1.4); // unknown ⇒ default
  });
});
