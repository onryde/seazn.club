// Owner staging test, 2026-10-19 (the silent Lichess link): once the room has READ `?lichess=<code>` it takes the
// parameter out of the address bar (`history.replaceState`, never a navigation), so a reload does not show a stale
// outcome - and it KEEPS `t=`, the personal link being the room's only way in. The outcome itself stays in the shell's
// state for the page's life: the strip must not take the sentence off the card it was read for.
//
// Driven through the REAL RoomShell (effects run under the hook harness) against a window whose `replaceState`
// really rewrites the location, as a browser does - and which models what Next's app router does to it (below).
// The painted card is room-lichess-flash.test.tsx's; what only a real browser can prove (the router's own URL state
// surviving a `router.refresh()`) is match-room.spec.ts's.
//
// PR #990 review, M2 - the strip must be Next-router-safe. Read from node_modules/next/dist/client/components/app-router.js
// (this repo's Next, 16.3): the router patches `window.history.replaceState` in a MOUNT EFFECT of its own, and the patched
// function (1) passes straight through, router NOT told, any call whose state carries Next's `__NA` marker, and
// (2) for any other call copies Next's internal state onto it and dispatches ACTION_RESTORE with the new URL - which is how
// `canonicalUrl` (and so `useSearchParams`, and the URL a later `router.refresh()` re-stamps) learns it. So the strip
// passes `null` state, never `window.history.state` (it carries `__NA`), and it runs AFTER that patch exists: React runs a
// child's mount effect before its parent's, so on the first hydration the room's effect runs BEFORE the router's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));

import { RoomShell, Screen } from "../room-shell";
import type { RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const ROOM = "/shared/org/comp/div/fixtures/f1/play";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload-with_chars.sig";
const SELF = `${ROOM}?t=${encodeURIComponent(TOKEN)}`;

function snap(): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/shared/org/comp/div/fixtures/f1", standings: "/shared/org/comp/div" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Ada Okonkwo", checkedIn: false },
    opponent: { colour: "black", name: "Bo Lind", checkedIn: false },
    cameraPolicy: "off",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: false,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
  };
}

/** A window whose history rewrites its own location, like a browser's - plus the one thing of Next's the strip depends
 *  on: the app router's patch of `replaceState`, installed by `installRouterPatch()` (in the app that is the router's own
 *  mount effect, which runs AFTER a child's on the first hydration). `restores` is what the router was told. */
function stubWindow(href: string, opts: { routerPatchedFirst?: boolean } = {}) {
  const loc = new URL(href, "https://seazn.test");
  const NEXT_TREE = { tree: ["", {}], renderedSearch: "" };
  const nativeCalls: { state: unknown; url: string }[] = [];
  const patchedCalls: { state: unknown; url: string }[] = [];
  const restores: string[] = [];
  const history: { state: unknown; replaceState: (state: unknown, title: string, next: string) => void } = {
    state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: NEXT_TREE },
    replaceState: (state, _title, next) => {
      nativeCalls.push({ state, url: next });
      const u = new URL(next, "https://seazn.test");
      loc.pathname = u.pathname;
      loc.search = u.search;
      loc.hash = u.hash;
      history.state = state;
    },
  };
  const native = history.replaceState;
  const installRouterPatch = () => {
    history.replaceState = (state, title, next) => {
      patchedCalls.push({ state, url: next });
      const marker = state as { __NA?: boolean; _N?: boolean } | null;
      // Next: "Avoid a loop when Next.js internals trigger pushState/replaceState" - the router is NOT told.
      if (marker?.__NA || marker?._N) return native(state, title, next);
      // Otherwise: carry the router's internal state over, tell the router (ACTION_RESTORE), then write.
      const carried = { ...(state as object | null), __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: NEXT_TREE };
      if (next) restores.push(next);
      return native(carried, title, next);
    };
  };
  if (opts.routerPatchedFirst) installRouterPatch();
  const win = { location: loc, history, localStorage: { getItem: () => null, setItem: () => {} } };
  vi.stubGlobal("window", win);
  return { loc, nativeCalls, patchedCalls, restores, installRouterPatch, history };
}
const urlNow = (loc: URL) => `${loc.pathname}${loc.search}${loc.hash}`;
/** The timer the strip waits on (a task after the commit's passive effects): let it fire. */
const flushTimers = () => vi.advanceTimersByTime(0);

beforeEach(() => {
  vi.useFakeTimers();
  // The room's polls never answer here: only the strip is under test.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const screenProps = (island: { tree: () => ReturnType<typeof walk> }) => {
  const screen = walk(island.tree()).find((e) => e.type === Screen);
  return propsOf(screen!);
};
/** A refused grant is card 8 at once (P10): the screen the outcome stands on, with no seat call needed. */
const mount = (props: Record<string, unknown> = {}) =>
  renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, grantRefused: true, ...props } as never);

describe("the room takes ?lichess= out of the address bar once it has read it - through the router's own door", () => {
  it("drops lichess=, keeps t= byte for byte, replaces (never pushes); the router is told the clean URL and keeps its own state", () => {
    const w = stubWindow(`${SELF}&lichess=already_linked`);
    mount({ lichessFlash: "already_linked" });
    w.installRouterPatch(); // the router's mount effect: after the room's, in the same commit
    flushTimers();
    expect(urlNow(w.loc), "the address bar: the personal link, nothing else").toBe(SELF);
    expect(new URL(urlNow(w.loc), "https://seazn.test").searchParams.get("t"), "t= survives").toBe(TOKEN);
    expect(w.restores, "the router was told: its canonical URL loses lichess= too").toEqual([SELF]);
    expect(w.patchedCalls).toHaveLength(1);
    expect(w.nativeCalls, "and the browser's own history was written exactly once").toHaveLength(1);
    expect((w.history.state as { __NA?: boolean }).__NA, "Next's own marker is carried over by the router, not by us").toBe(true);
  });

  it("the call carries NO state of ours: Next's __NA marker would make its patched replaceState skip the router", () => {
    const w = stubWindow(`${SELF}&lichess=already_linked`);
    mount({ lichessFlash: "already_linked" });
    w.installRouterPatch();
    flushTimers();
    expect(w.patchedCalls[0]!.state).toBeNull();
    // The witness that this is what matters: the entry's own state, handed back as the old strip did, tells nobody.
    const w2 = stubWindow(`${SELF}&lichess=already_linked`, { routerPatchedFirst: true });
    w2.history.replaceState(w2.history.state, "", SELF);
    expect(w2.restores, "an __NA state is invisible to the router").toEqual([]);
  });

  it("first-hydration ordering: the room's effect runs BEFORE the router has patched replaceState - the strip waits for the patch", () => {
    const w = stubWindow(`${SELF}&lichess=already_linked`);
    mount({ lichessFlash: "already_linked" });
    // Right after the mount effects: the room has read the param, the router has not patched yet. Nothing may be written
    // through the browser's native replaceState now - the router would never hear of it.
    expect(w.nativeCalls, "no write before the router can hear it").toHaveLength(0);
    expect(urlNow(w.loc), "the address is untouched until then").toBe(`${SELF}&lichess=already_linked`);
    w.installRouterPatch();
    flushTimers();
    expect(w.restores).toEqual([SELF]);
  });

  it("a room mounted after the router is patched (a client navigation) strips the same way", () => {
    const w = stubWindow(`${SELF}&lichess=already_linked`, { routerPatchedFirst: true });
    mount({ lichessFlash: "already_linked" });
    flushTimers();
    expect(urlNow(w.loc)).toBe(SELF);
    expect(w.restores).toEqual([SELF]);
  });

  it("the empty case: a URL with no lichess= is left alone (no replaceState at all, however long we wait)", () => {
    const w = stubWindow(SELF, { routerPatchedFirst: true });
    mount();
    flushTimers();
    vi.advanceTimersByTime(60_000);
    expect(w.patchedCalls).toHaveLength(0);
    expect(w.nativeCalls).toHaveLength(0);
    expect(urlNow(w.loc)).toBe(SELF);
  });

  it("an unknown or hand-typed value is stripped too - and the card shows nothing for it", () => {
    const w = stubWindow(`${SELF}&lichess=made-up`, { routerPatchedFirst: true });
    const island = mount({ lichessFlash: "made-up" });
    flushTimers();
    expect(w.restores).toEqual([SELF]);
    expect(urlNow(w.loc)).toBe(SELF);
    expect(screenProps(island).lichessFlash, "the shell hands the card none").toBeNull();
  });

  it("the outcome is kept after the strip: the shell hands the card the code it read, even when the page re-renders without it", () => {
    stubWindow(`${SELF}&lichess=already_linked`, { routerPatchedFirst: true });
    const island = mount({ lichessFlash: "already_linked" });
    flushTimers();
    expect(screenProps(island).lichessFlash).toBe("already_linked");
    // A later server re-read (router.refresh) renders the page without the param: the card keeps its words.
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF, grantRefused: true });
    expect(screenProps(island).lichessFlash).toBe("already_linked");
  });

  it("the pair: with no outcome read, the card gets none", () => {
    stubWindow(SELF, { routerPatchedFirst: true });
    const island = mount();
    expect(screenProps(island).lichessFlash).toBeNull();
  });

  it("runs once per page: a re-render does not touch the history again", () => {
    const w = stubWindow(`${SELF}&lichess=linked`, { routerPatchedFirst: true });
    const island = mount({ lichessFlash: "linked" });
    flushTimers();
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF, grantRefused: true, lichessFlash: "linked" });
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF, grantRefused: true, lichessFlash: "linked" });
    flushTimers();
    expect(w.patchedCalls).toHaveLength(1);
  });

  it("a room that goes away before the router's turn never writes the address (the timer is the effect's to clear)", () => {
    const w = stubWindow(`${SELF}&lichess=already_linked`, { routerPatchedFirst: true });
    const island = mount({ lichessFlash: "already_linked" });
    island.unmount();
    flushTimers();
    expect(w.patchedCalls).toHaveLength(0);
    expect(w.nativeCalls).toHaveLength(0);
  });

  it("with no window at all (a node render driving the shell) the strip is a no-op, never a throw", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    expect(typeof window).toBe("undefined");
    expect(() => mount({ lichessFlash: "already_linked" })).not.toThrow();
    expect(() => flushTimers()).not.toThrow();
  });

  it("the re-link the card offers never carries the stale outcome: selfPath is the personal link alone", () => {
    stubWindow(`${SELF}&lichess=already_linked`, { routerPatchedFirst: true });
    const island = mount({ lichessFlash: "already_linked" });
    flushTimers();
    const relinkHref = String(screenProps(island).relinkHref);
    expect(new URL(relinkHref, "https://seazn.test").searchParams.get("next")).toBe(SELF);
    expect(relinkHref).not.toContain("lichess%3D");
  });
});
