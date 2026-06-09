// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { lockToolbarItem } from "../src/lock.js";
import { FakeAdapter } from "../src/testing.js";

describe("lockToolbarItem", () => {
  it("is null when lock is disabled", () => {
    expect(lockToolbarItem(false, vi.fn())).toBeNull();
  });

  it("builds a standalone lock button; click toggles setInteractive + icon/title", () => {
    const setInteractive = vi.fn();
    const item = lockToolbarItem(true, setInteractive)!;
    expect(item.id).toBe("lock");
    expect(item.standalone).toBe(true);
    // render onto a real button (as populateToolbar would)
    const btn = document.createElement("button");
    btn.innerHTML = item.svg!;
    item.onRender!(btn);
    expect(btn.title).toBe("Lock map");
    expect(btn.innerHTML).toContain("M7 11V7a5 5 0 0 1 9.9-1"); // open padlock

    item.onClick!(); // lock
    expect(setInteractive).toHaveBeenLastCalledWith(false);
    expect(btn.title).toBe("Unlock map");
    expect(btn.innerHTML).toContain("M7 11V7a5 5 0 0 1 10 0v4"); // closed padlock
    expect(btn.classList.contains("active")).toBe(true);

    item.onClick!(); // unlock
    expect(setInteractive).toHaveBeenLastCalledWith(true);
    expect(btn.title).toBe("Lock map");
    expect(btn.classList.contains("active")).toBe(false);
  });
});

describe("FakeAdapter.setInteractive", () => {
  it("tracks the interactive flag", () => {
    const a = new FakeAdapter();
    expect(a.interactive).toBe(true);
    a.setInteractive(false);
    expect(a.interactive).toBe(false);
  });
});
