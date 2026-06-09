import { describe, expect, it } from "vitest";

import { boxPadding, boxRadius } from "../src/textbox.js";

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
});
