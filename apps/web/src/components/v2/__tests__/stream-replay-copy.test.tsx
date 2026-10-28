// "Copy link" on the fixture panel's replay row (YouTube Connect T12): the one piece of state the pure panel body cannot hold - "Link copied"
// for a moment. `apps/web` vitest is `environment: "node"`, so the clipboard and the clock are stand-ins: a recorded `writeText` and fake
// timers. The expected strings are the dictionary's (read by key); the expected URL is the one the test hands in, never read back.
//
// Sequence, not just the feature: a second copy inside the window, a refused clipboard, and another URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { messages } from "@/lib/messages";
import { REPLAY_COPIED_MS, ReplayCopyButton } from "../stream-replay-copy";

const COPY = messages["stream.replay.copy"] as string;
const COPIED = messages["stream.replay.copied"] as string;
const URL_A = "https://www.youtube.com/watch?v=abc123";
const URL_B = "https://www.youtube.com/watch?v=zzz999";

const button = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((e) => propsOf(e)["data-testid"] === "stream-replay-copy");
  if (!el) throw new Error("no Copy link button in the tree");
  return el;
};

function mount(url: string) {
  const island = renderIsland(ReplayCopyButton, { url });
  const label = () => textOf(button(island.tree())).trim();
  const press = async () => {
    (propsOf(button(island.tree())).onClick as () => void)();
    await vi.advanceTimersByTimeAsync(0); // the clipboard promise settles, then the state sets
  };
  return { island, label, press };
}

describe("the replay row's Copy link", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("premise: the two states read differently, and the window is a real wait", () => {
    expect(COPY).not.toBe(COPIED);
    expect(REPLAY_COPIED_MS).toBeGreaterThan(0);
  });

  it("copies exactly the link it was given, says so for the window, then goes back to 'Copy link'", async () => {
    const p = mount(URL_A);
    expect(p.label()).toBe(COPY);
    await p.press();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(URL_A);
    expect(p.label()).toBe(COPIED);
    await vi.advanceTimersByTimeAsync(REPLAY_COPIED_MS - 1);
    expect(p.label(), "still confirmed one tick before the window ends").toBe(COPIED);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.label(), "back to the action once the window ends").toBe(COPY);
  });

  it("a second copy inside the window restarts it (the first timer does not cut the second short)", async () => {
    const p = mount(URL_A);
    await p.press();
    await vi.advanceTimersByTimeAsync(REPLAY_COPIED_MS - 500);
    await p.press();
    expect(writeText).toHaveBeenCalledTimes(2);
    // 900ms after the second press is past the FIRST press's window (1000 + 900 > 1500) but inside the second's.
    await vi.advanceTimersByTimeAsync(900);
    expect(p.label(), "the first press's timer was cleared").toBe(COPIED);
    await vi.advanceTimersByTimeAsync(REPLAY_COPIED_MS);
    expect(p.label()).toBe(COPY);
  });

  it("a clipboard the browser refuses is never reported as copied", async () => {
    writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
    const p = mount(URL_A);
    await p.press();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(p.label(), "nothing was copied, so nothing is claimed").toBe(COPY);
    // The positive pair: the next press, on a clipboard that accepts, does confirm.
    await p.press();
    expect(p.label()).toBe(COPIED);
  });

  it("copies the link of ITS row - another URL, another copy", async () => {
    const p = mount(URL_B);
    await p.press();
    expect(writeText).toHaveBeenCalledWith(URL_B);
    expect(writeText).not.toHaveBeenCalledWith(URL_A);
  });
});
