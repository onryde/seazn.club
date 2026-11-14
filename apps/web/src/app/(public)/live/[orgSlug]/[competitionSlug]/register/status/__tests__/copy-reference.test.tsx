// CopyReference (B4 T15, spec §5.1 item 2): one press puts the cart reference on the clipboard; the button reads "Copied" for a
// moment, then offers the copy again. No jsdom: driven through the shared node-env hook harness, the clipboard stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { COPIED_MS, CopyReference } from "../copy-reference";

const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() };

beforeEach(() => {
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const REF = "SZ-AB2C-DE3F";
const mount = () => renderIsland(CopyReference, { reference: REF });
type Island = ReturnType<typeof mount>;

const press = async (island: Island) => {
  const button = island.tree().find((e) => e.type === "button")!;
  await (propsOf(button).onClick as () => Promise<void>)();
};
const buttonText = (island: Island) => {
  const tree = island.tree();
  const button = tree.find((e) => e.type === "button")!;
  // The visible label is the sizer's inner span (the outer one only carries the widest word as data for the ghost).
  return walk(propsOf(button).children as never)
    .filter((e) => e.type === "span" && typeof propsOf(e).children === "string")
    .map((e) => propsOf(e).children as string)
    .join("");
};
const liveRegion = (island: Island) => {
  const region = island.tree().find((e) => propsOf(e).role === "status")!;
  return String(propsOf(region).children ?? "");
};

describe("CopyReference", () => {
  it("before any press: offers 'Copy reference' and announces nothing (the empty case)", () => {
    const island = mount();
    expect(buttonText(island)).toBe("Copy reference");
    expect(liveRegion(island)).toBe("");
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("a press copies the exact reference, reads 'Copied' and announces it", async () => {
    const island = mount();
    await press(island);
    expect(clipboard.writeText.mock.calls).toEqual([[REF]]);
    expect(buttonText(island)).toBe("Copied");
    expect(liveRegion(island)).toBe("Copied");
  });

  // B4 design review: "Copied" reached a screen reader twice, once from the live region and once as the button's new name. It is now
  // announced once, by the live region; the button's accessible name stays what pressing it does ("Copy reference"), while its
  // visible label still reads "Copied" for the moment.
  it("'Copied' reaches assistive tech exactly once: the live region says it, the button's name stays 'Copy reference'", async () => {
    const island = mount();
    const nameOf = () => propsOf(island.tree().find((e) => e.type === "button")!)["aria-label"];
    expect(nameOf(), "before the press").toBe("Copy reference");
    await press(island);
    expect(buttonText(island), "premise: the visible label reads Copied").toBe("Copied");
    expect(nameOf(), "after the press, the name is unchanged").toBe("Copy reference");
    // What a screen reader is handed: each element's accessible name (aria-label, else its own text) plus the live region's text.
    const exposed = [String(nameOf()), liveRegion(island)];
    expect(exposed.filter((text) => text === "Copied"), "announced once").toHaveLength(1);
  });

  it("offers the copy again once the moment passes, and a second press copies again", async () => {
    const island = mount();
    await press(island);
    vi.advanceTimersByTime(COPIED_MS - 1);
    expect(buttonText(island), "still 'Copied' just before the moment ends").toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(buttonText(island)).toBe("Copy reference");
    expect(liveRegion(island)).toBe("");
    await press(island);
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(buttonText(island)).toBe("Copied");
  });

  it("a refused clipboard claims nothing was copied", async () => {
    clipboard.writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const island = mount();
    await press(island);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(buttonText(island)).toBe("Copy reference");
    expect(liveRegion(island)).toBe("");
  });

  it("the button keeps the width of its longer word, so 'Copied' never moves the row", () => {
    const island = mount();
    const sizer = island.tree().find((e) => propsOf(e)["data-widest"] !== undefined)!;
    expect(propsOf(sizer)["data-widest"]).toBe("Copy reference");
  });
});
