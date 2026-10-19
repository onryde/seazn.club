// Owner staging test, 2026-10-19 (the silent Lichess link): once the room has READ `?lichess=<code>` it takes the
// parameter out of the address bar (`history.replaceState`, never a navigation), so a reload does not show a stale
// outcome - and it KEEPS `t=`, the personal link being the room's only way in. The outcome itself stays in the shell's
// state for the page's life: the strip must not take the sentence off the card it was read for.
//
// Driven through the REAL RoomShell (effects run under the hook harness) against a window whose `replaceState`
// really rewrites the location, as a browser does. The painted card is room-lichess-flash.test.tsx's.
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

/** A window whose history rewrites its own location, like a browser's. */
function stubWindow(href: string) {
  const loc = new URL(href, "https://seazn.test");
  const replaceState = vi.fn((_state: unknown, _title: string, next: string) => {
    const u = new URL(next, "https://seazn.test");
    loc.pathname = u.pathname;
    loc.search = u.search;
    loc.hash = u.hash;
  });
  const win = {
    location: loc,
    history: { state: { __NA: true }, replaceState },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vi.stubGlobal("window", win);
  return { replaceState, loc };
}
const urlNow = (loc: URL) => `${loc.pathname}${loc.search}${loc.hash}`;

beforeEach(() => {
  // The room's polls never answer here: only the strip is under test.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const screenProps = (island: { tree: () => ReturnType<typeof walk> }) => {
  const screen = walk(island.tree()).find((e) => e.type === Screen);
  return propsOf(screen!);
};

describe("the room takes ?lichess= out of the address bar once it has read it", () => {
  it("drops lichess=, keeps t= byte for byte, replaces (never pushes) and keeps the history state", () => {
    const { replaceState, loc } = stubWindow(`${SELF}&lichess=already_linked`);
    renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "already_linked" });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ __NA: true }, "", SELF);
    expect(urlNow(loc), "the address bar: the personal link, nothing else").toBe(SELF);
    expect(new URL(urlNow(loc), "https://seazn.test").searchParams.get("t"), "t= survives").toBe(TOKEN);
  });

  it("the empty case: a URL with no lichess= is left alone (no replaceState at all)", () => {
    const { replaceState, loc } = stubWindow(SELF);
    renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF });
    expect(replaceState).not.toHaveBeenCalled();
    expect(urlNow(loc)).toBe(SELF);
  });

  it("an unknown or hand-typed value is stripped too - and the card shows nothing for it", () => {
    const { replaceState, loc } = stubWindow(`${SELF}&lichess=made-up`);
    const island = renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "made-up" as never });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(urlNow(loc)).toBe(SELF);
    expect(screenProps(island).lichessFlash, "the shell hands the card none").toBeNull();
  });

  it("the outcome is kept after the strip: the shell hands the card the code it read, even when the page re-renders without it", () => {
    stubWindow(`${SELF}&lichess=already_linked`);
    const island = renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "already_linked" });
    expect(screenProps(island).lichessFlash).toBe("already_linked");
    // The stripped URL re-reads the server page (a refresh): the new render carries no param, the card keeps its words.
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF });
    expect(screenProps(island).lichessFlash).toBe("already_linked");
  });

  it("the pair: with no outcome read, the card gets none", () => {
    stubWindow(SELF);
    const island = renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF });
    expect(screenProps(island).lichessFlash).toBeNull();
  });

  it("runs once per page: a re-render does not touch the history again", () => {
    const { replaceState } = stubWindow(`${SELF}&lichess=linked`);
    const island = renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "linked" });
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "linked" });
    island.rerender({ initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "linked" });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("with no window at all (a node render driving the shell) the strip is a no-op, never a throw", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    expect(typeof window).toBe("undefined");
    expect(() => renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "already_linked" })).not.toThrow();
  });

  it("the re-link the card offers never carries the stale outcome: selfPath is the personal link alone", () => {
    stubWindow(`${SELF}&lichess=already_linked`);
    const island = renderIsland(RoomShell, { initial: snap(), token: TOKEN, selfPath: SELF, lichessFlash: "already_linked" });
    const relinkHref = String(screenProps(island).relinkHref);
    expect(new URL(relinkHref, "https://seazn.test").searchParams.get("next")).toBe(SELF);
    expect(relinkHref).not.toContain("lichess%3D");
  });
});
