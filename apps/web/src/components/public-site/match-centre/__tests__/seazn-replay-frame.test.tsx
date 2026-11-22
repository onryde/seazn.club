// Seazn-hosted video Task 25: the replay host's player on the match page — an <iframe> at the player's 16:9, its address set on the
// element after hydration (never in the server markup: the embed URL carries a token), loaded ONCE per mount. The host checks the
// token when the frame loads and never again (plan B8), so a later answer's fresh token must not touch a playing frame (a new `src`
// restarts it); and an address whose token has already passed must not be loaded at all — the frame asks the island for a fresh read
// first (carry 3: the FIRST part too, not only a picked one), and loads the next address it is given whatever its expiry, so a
// viewer's wrong clock cannot leave the frame asking for ever.
//
// The rules are the brief's, typed here. The loader (`createEmbedLoad`) is driven with a fake element and a fake clock; the component
// through the hook harness, with the frame's ref pointed at a fake element, so its effect is the one under test; the browser's DOM
// is the e2e's (seazn-hosted.spec.ts).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { SeaznReplayFrame, createEmbedLoad } from "../seazn-replay-frame";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const HOUR = 3_600_000;
const url = (name: string) => `https://embed.fake.invalid/embed/1/${name}?token=${"a".repeat(64)}&expires=1`;
const iso = (ms: number) => new Date(ms).toISOString();

/** A frame element whose every `src` write is recorded. */
function fakeFrame() {
  const writes: string[] = [];
  const frame = {} as { src: string };
  Object.defineProperty(frame, "src", { get: () => writes.at(-1) ?? "", set: (v: string) => { writes.push(v); } });
  return { frame, writes };
}

describe("the frame's markup (server render)", () => {
  const out = renderToStaticMarkup(<SeaznReplayFrame src={url("v1")} expiresAt={iso(NOW + HOUR)} title="Part 2" onStale={() => {}} />);

  it("one iframe, named, with the player's permissions and full screen, at the player's 16:9 box", () => {
    expect([...out.matchAll(/<iframe\b/g)], "one iframe").toHaveLength(1);
    expect(out).toMatch(/<iframe\b[^>]*\btitle="Part 2"/);
    expect(out).toMatch(/<iframe\b[^>]*\ballow="autoplay; fullscreen; picture-in-picture"/);
    expect(out).toMatch(/<iframe\b[^>]*\ballowfullscreen=""/i);
    expect(out).toMatch(/data-testid="seazn-replay-frame-box"[^>]*class="[^"]*\baspect-video\b[^"]*\bmin-h-\[200px\][^"]*"/);
    expect(out, "no <video>: the host's player is the frame").not.toMatch(/<video\b/);
  });

  it("SECURITY: `ph-no-capture` on the frame AND its box, and the address (its token) is nowhere in the markup", () => {
    expect(out).toMatch(/<iframe\b[^>]*class="[^"]*\bph-no-capture\b/);
    expect(out).toMatch(/data-testid="seazn-replay-frame-box"[^>]*class="[^"]*\bph-no-capture\b/);
    expect(out, "no src attribute at all").not.toMatch(/\ssrc=/);
    expect(out).not.toContain("token=");
    expect(out).not.toContain("embed.fake.invalid");
  });
});

describe("createEmbedLoad — when the frame's address is set", () => {
  const loader = (now = NOW) => {
    const f = fakeFrame();
    const onStale = vi.fn();
    return { ...f, onStale, load: createEmbedLoad(f.frame, { onStale, now: () => now }) };
  };

  it("EMPTY CASE FIRST: nothing offered, nothing loaded and nothing asked", () => {
    const l = loader();
    expect(l.writes).toEqual([]);
    expect(l.onStale).not.toHaveBeenCalled();
  });

  it("a fresh address loads once; a later answer's fresh token does NOT touch the frame (the host checked the token at load: a new src would restart it)", () => {
    const l = loader();
    l.load.offer(url("v1"), iso(NOW + HOUR));
    l.load.offer(url("v1-refreshed"), iso(NOW + 2 * HOUR));
    l.load.offer(url("v1-again"), iso(NOW + 3 * HOUR));
    expect(l.writes).toEqual([url("v1")]);
    expect(l.onStale).not.toHaveBeenCalled();
  });

  it("carry 3: an address whose token has PASSED is not loaded — the frame asks for a fresh read once, and loads the fresh address it is then given", () => {
    const l = loader();
    l.load.offer(url("old"), iso(NOW - 1));
    expect(l.writes, "the lapsed address never reaches the frame").toEqual([]);
    expect(l.onStale).toHaveBeenCalledTimes(1);
    l.load.offer(url("old"), iso(NOW - 1));
    expect(l.onStale, "the same address again (a re-render) asks nothing more and loads nothing").toHaveBeenCalledTimes(1);
    expect(l.writes).toEqual([]);
    l.load.offer(url("fresh"), iso(NOW + HOUR));
    expect(l.writes).toEqual([url("fresh")]);
    expect(l.onStale).toHaveBeenCalledTimes(1);
  });

  it("the edge, to the ms: a token expiring AT now has passed; one a ms later has not", () => {
    const at = loader();
    at.load.offer(url("edge"), iso(NOW));
    expect([at.writes, at.onStale.mock.calls.length]).toEqual([[], 1]);
    const before = loader();
    before.load.offer(url("edge"), iso(NOW + 1));
    expect([before.writes, before.onStale.mock.calls.length]).toEqual([[url("edge")], 0]);
  });

  it("a viewer's clock that is wrong (every token reads as passed): it asks ONCE, then loads the next address whatever its expiry — never asks for ever", () => {
    const l = loader(NOW + 10 * HOUR);
    l.load.offer(url("a"), iso(NOW + HOUR));
    l.load.offer(url("b"), iso(NOW + HOUR + 30_000));
    l.load.offer(url("c"), iso(NOW + HOUR + 60_000));
    expect(l.onStale).toHaveBeenCalledTimes(1);
    expect(l.writes).toEqual([url("b")]);
  });

  it("an expiry that is not a date is read as passed (asked once), never as fresh for ever", () => {
    const l = loader();
    l.load.offer(url("x"), "not a date");
    expect([l.writes, l.onStale.mock.calls.length]).toEqual([[], 1]);
  });
});

describe("the component's wiring (the hook harness, the frame's ref on a fake element)", () => {
  /** Mounts the frame, then points its ref at a fake element and re-renders with `next`: the effect is the one under test. */
  function mount(first: { src: string; expiresAt: string }) {
    const onStale = vi.fn();
    const props = { ...first, title: "Replay", onStale };
    const island = renderIsland(SeaznReplayFrame, props);
    const iframe = island.tree().find((el) => el.type === "iframe");
    expect(iframe, "PREMISE: the frame renders an iframe").toBeDefined();
    const ref = (iframe!.props as { ref?: { current: unknown } }).ref;
    expect(ref, "PREMISE: the iframe carries a ref").toBeDefined();
    const f = fakeFrame();
    ref!.current = f.frame;
    return { island, onStale, writes: f.writes, props };
  }

  it("a fresh address offered after the element exists is loaded; the next answer's refreshed one is not", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const m = mount({ src: url("first"), expiresAt: iso(NOW + HOUR) });
      m.island.rerender({ ...m.props, src: url("v1"), expiresAt: iso(NOW + HOUR) });
      m.island.rerender({ ...m.props, src: url("v1-refreshed"), expiresAt: iso(NOW + 2 * HOUR) });
      expect(m.writes).toEqual([url("v1")]);
      expect(m.onStale).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lapsed address asks the island through the onStale it came with, once, and the fresh one that follows loads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const m = mount({ src: url("first"), expiresAt: iso(NOW + HOUR) });
      const later = vi.fn();
      m.island.rerender({ ...m.props, onStale: later, src: url("old"), expiresAt: iso(NOW - 60_000) });
      expect(later, "the callback the lapsed address came with").toHaveBeenCalledTimes(1);
      expect(m.onStale, "never the mount's").not.toHaveBeenCalled();
      expect(m.writes).toEqual([]);
      m.island.rerender({ ...m.props, onStale: later, src: url("fresh"), expiresAt: iso(NOW + HOUR) });
      expect(m.writes).toEqual([url("fresh")]);
    } finally {
      vi.useRealTimers();
    }
  });
});
