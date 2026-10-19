// PR #990 review, I1: the room HOLDS the Lichess outcome it was landed with, for the page's life - and the screen it is
// held for changes under it (a poll, a seat answer). A `linked` landing is the hazard the review found: the room kept
// it and drew "Lichess account linked." above a LATER "Your Lichess link was revoked" card. The sequence, through the
// REAL shell, the real transport (use-room), the real reducer and screen decision; faked only at the HTTP edge.
//
// What the shell hands the screen (`Screen`'s `lichessFlash`) is what the card paints (room-lichess-flash.test.tsx paints
// every card with it), so this asserts on the hand-over at every step of a sequence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));

import { RoomShell, Screen } from "../room-shell";
import { IDLE_POLL_MS } from "../use-room";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
let tick = 0;
const GAME: RoomGame = {
  gameId: "g1",
  moves: [],
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lastMove: null,
  turn: "white",
  whiteMs: 600_000,
  blackMs: 600_000,
  clockAsOf: null,
  clockRunning: false,
  drawOfferBy: null,
  over: false,
};
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  tick += 1;
  return {
    fixtureId: "f1",
    serverNow: new Date(T0 + tick).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
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
    ...over,
  };
}
/** The viewer's own seat frozen on a game - seam A, "your Lichess link was revoked". */
const revoked = () => snap({ game: GAME, frozen: "you", canAct: false });
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data, requestId: "r" }), { status: 200 });

let seatAnswers: (() => unknown)[] = [];
let getAnswer: () => RoomSnapshot = () => snap();

beforeEach(() => {
  vi.useFakeTimers();
  tick = 0;
  seatAnswers = [];
  getAnswer = () => snap();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST" && url.startsWith("/api/v1/fixtures/f1/external-play/room?")) {
        const thunk = seatAnswers.shift();
        if (thunk === undefined) return new Promise<Response>(() => {});
        return ok(thunk());
      }
      if (init.method === "GET") return ok(getAnswer());
      return new Response("{}", { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
type Island = { tree: () => ReturnType<typeof walk> };
const screenEl = (island: Island) => walk(island.tree()).find((e) => e.type === Screen)!;
const kindOf = (island: Island) => (propsOf(screenEl(island)).screen as { kind: string }).kind;
const flashOf = (island: Island) => propsOf(screenEl(island)).lichessFlash;
const claim = (island: Island) => (propsOf(screenEl(island)).room as { claim: () => Promise<unknown> }).claim();
const needsLink = () => ({ snapshot: snap(), seat: { seated: false, reason: "lichess_link_required", participant: null } });
const seated = () => ({ snapshot: snap({ creation: { state: "creating" } }), seat: { seated: true, participant: null } });
/** A seated answer that leaves the room waiting for the opponent: still the check-in screen, with the seat taken. */
const seatedWaiting = () => ({ snapshot: snap(), seat: { seated: true, participant: null } });
const windowClosed = () => ({ snapshot: snap(), seat: { seated: false, reason: "window_closed", participant: null } });
const mount = (lichessFlash?: string) =>
  renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x", lichessFlash: lichessFlash as never });

describe("a linked landing is never held: nothing stale to show over a LATER revoke", () => {
  it("landed on ?lichess=linked, a poll later turns the seat into a revoked link: the revoked card gets NO outcome", async () => {
    const island = mount("linked");
    expect(kindOf(island)).toBe("checkin");
    expect(flashOf(island), "the check-in never carried it").toBeNull();

    getAnswer = revoked;
    await settle(IDLE_POLL_MS);
    expect(kindOf(island), "the premise: the poll really did land on seam A").toBe("revoked");
    expect(flashOf(island), "no 'Lichess account linked.' above 'Your Lichess link was revoked'").toBeNull();
    island.unmount();
  });

  it("the same for card 8: a linked landing, then the seat answers 're-consent required': the re-link card gets NO outcome", async () => {
    const island = mount("linked");
    seatAnswers = [needsLink];
    await claim(island);
    await settle();
    expect(kindOf(island)).toBe("relink");
    expect(flashOf(island)).toBeNull();
    island.unmount();
  });
});

describe("a failure is held until the card it was read for, and is gone once the screen leaves the cards", () => {
  it("held through the check-in: the seat call answers 'link required' and card 8 gets the outcome (a player who was never linked)", async () => {
    const island = mount("already_linked");
    expect(kindOf(island)).toBe("checkin");
    expect(flashOf(island), "not drawn on the check-in - the hand-over is for the cards - but still HELD").toBeNull();
    seatAnswers = [needsLink];
    await claim(island);
    await settle();
    expect(kindOf(island)).toBe("relink");
    expect(flashOf(island)).toBe("already_linked");
    island.unmount();
  });

  it("card 8, then the seat is taken (the link now stands): the outcome is gone - and a LATER revoke on the same page does not get it back", async () => {
    const island = mount("already_linked");
    seatAnswers = [needsLink, seated];
    await claim(island);
    await settle();
    expect(kindOf(island)).toBe("relink");
    expect(flashOf(island)).toBe("already_linked");

    await claim(island);
    await settle();
    expect(kindOf(island), "the premise: off the cards").toBe("creating");
    expect(flashOf(island)).toBeNull();

    getAnswer = revoked;
    await settle(IDLE_POLL_MS);
    expect(kindOf(island), "the premise: seam A, later, on the same page").toBe("revoked");
    expect(flashOf(island), "a later card is a new event: the old sentence does not belong to it").toBeNull();
    island.unmount();
  });

  it("card to card (re-link -> revoked) is the same occasion: the failure the player just met is still the thing to say", async () => {
    const island = mount("already_linked");
    seatAnswers = [needsLink];
    await claim(island);
    await settle();
    expect(flashOf(island)).toBe("already_linked");

    getAnswer = revoked;
    await settle(IDLE_POLL_MS);
    expect(kindOf(island)).toBe("revoked");
    expect(flashOf(island)).toBe("already_linked");
    island.unmount();
  });

  it("a revoked card on first paint is a card: the outcome is drawn there at once", async () => {
    const island = renderIsland(RoomShell, { initial: revoked(), token: "tok", selfPath: "/x", lichessFlash: "already_linked" as never });
    expect(kindOf(island)).toBe("revoked");
    expect(flashOf(island)).toBe("already_linked");
    island.unmount();
  });

  it("the pair: with no outcome landed, no screen of the sequence carries one", async () => {
    const island = mount();
    seatAnswers = [needsLink];
    await claim(island);
    await settle();
    expect(kindOf(island)).toBe("relink");
    expect(flashOf(island)).toBeNull();
    island.unmount();
  });
});

// PR #990 re-review, N1: a failure landed and NEVER seen on a card (the player's link worked all along - seated, creating,
// live, held, over) must not wait for a LATER revoke card and show up there as if it were fresh. It is spent the moment the
// room shows the link works; but not by the screens that merely come BEFORE the card (a closed window, the check-in).
describe("an unseen failure is spent once the room shows the link works (re-review N1)", () => {
  // Snapshots are built inside the test (a function each): their serverNow must come AFTER the beforeEach reset of the clock
  // tick, or the later poll's snapshot would look older than the first and be dropped as stale.
  const OVER = { ...GAME, over: true };
  // `laterCard: false` - a game that is over never goes back to a card (room-screen: a written result or an over game outranks
  // seam A and card 8), so there is no later card to hand the outcome to; the case proves the premise and the empty hand-over,
  // and the unit sweep (room-held-flash.test.ts) pins `over` as a settled screen.
  type Case = { name: string; initial: () => RoomSnapshot; kind: string; laterCard?: boolean; drive?: (island: Island) => Promise<void> };
  const CASES: Case[] = [
    { name: "creating", initial: () => snap({ creation: { state: "creating" } }), kind: "creating" },
    { name: "live", initial: () => snap({ game: GAME, canAct: true }), kind: "live" },
    { name: "held", initial: () => snap({ game: GAME, canAct: false }), kind: "held" },
    { name: "over", initial: () => snap({ game: OVER }), kind: "over", laterCard: false },
    {
      name: "a seated answer (the seat is taken, the screen is still the check-in)",
      initial: () => snap(),
      kind: "checkin",
      drive: async (island) => {
        seatAnswers = [seatedWaiting];
        await claim(island);
        await settle();
      },
    },
  ];

  it("landed with already_linked, never on a card: the room settles, then a LATER revoke card gets NO outcome - on every settled screen", async () => {
    let swept = 0;
    let later = 0;
    for (const c of CASES) {
      seatAnswers = [];
      getAnswer = () => snap();
      const island = renderIsland(RoomShell, { initial: c.initial(), token: "tok", selfPath: "/x", lichessFlash: "already_linked" as never });
      await c.drive?.(island);
      expect(kindOf(island), `${c.name}: the premise - the screen the room settled on`).toBe(c.kind);
      expect(flashOf(island), `${c.name}: nothing to say on it`).toBeNull();

      if (c.laterCard !== false) {
        getAnswer = revoked;
        await settle(IDLE_POLL_MS);
        expect(kindOf(island), `${c.name}: the premise - a revoke card, later, on the same page`).toBe("revoked");
        expect(flashOf(island), `${c.name}: an old failure is not fresh news on it`).toBeNull();
        later++;
      }
      island.unmount();
      swept++;
    }
    expect(swept, "anti-vacuity: every settled case").toBe(CASES.length);
    expect(later, "anti-vacuity: every case that can reach a later card did").toBe(CASES.length - 1);
  });

  it("the pair: a screen that only comes BEFORE the card (a closed window) does not spend it - the link card that follows still says it", async () => {
    const island = mount("already_linked");
    seatAnswers = [windowClosed, needsLink];
    await claim(island);
    await settle();
    expect(kindOf(island), "the premise: before the card").toBe("closed");
    expect(flashOf(island)).toBeNull();
    await claim(island);
    await settle();
    expect(kindOf(island)).toBe("relink");
    expect(flashOf(island), "held through it: the card says what the player met").toBe("already_linked");
    island.unmount();
  });
});
