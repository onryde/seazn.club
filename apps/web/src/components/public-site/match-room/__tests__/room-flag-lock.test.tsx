// T17B fix 2, D13 (owner request) — at the mover's flag the room locks. Measured live (x0JKlePc): White's clock read
// 0:00.0 for seven minutes while the room still offered the board and Resign / Offer draw, on a game Lichess had not
// yet ended. From the instant the side to move's clock reaches zero (and the game is not over) the board takes no
// move, every game action is disabled, and the room says why: confirming with Lichess, or — on a held board — the
// organiser confirming it. The result, when it lands, replaces all of it.
//
// Driven through the REAL Screen and its real hook (renderIsland runs useState/useEffect; fake timers move the
// clock). Expected instants come from the snapshot's own clock (V454: each clock is as at `clockAsOf`), never from
// the code under test.
//
// Single sport, deliberately: online play exists only for boardgame chess (supportsOnlinePlay).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));

import { Screen } from "../room-shell";
import { RoomControls, RoomControlsView } from "../controls";
import { FlagNotice } from "../room-cards";
import { HeldSeam } from "../room-seams";
import { GameOver } from "../game-over";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import { moverFlagAt, OPTIMISTIC_CLOCK_MAX_MS } from "../clock-math";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-14T16:50:00.000Z");
const WHITE_LEFT = 5_000;

/** White to move, its clock as at T0 — so it reaches zero at T0 + WHITE_LEFT on the server's clock. */
const LIVE: RoomGame = {
  gameId: "g1",
  moves: ["e2e4", "e7e5"],
  fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  lastMove: ["e7", "e5"],
  turn: "white",
  whiteMs: WHITE_LEFT,
  blackMs: 240_000,
  clockAsOf: new Date(T0).toISOString(),
  clockRunning: true,
  drawOfferBy: null,
  over: false,
};

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 0 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: true },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "off",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: LIVE,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
    ...over,
  };
}

const noop = async () => null;
type Kind = "live" | "held" | "over";
function props(state: RoomState, kind: Kind): Parameters<typeof Screen>[0] {
  return {
    screen: { kind } as never,
    state,
    room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never,
    camera: { status: "off", stream: null, enable: () => {} } as never,
    busy: false,
    tryAgain: () => {},
    relinkHref: "/x",
    locale: "en",
    t: ((k: string) => k) as never,
    plural: ((k: string) => k) as never,
  };
}
/** A snapshot the room received at T0 (skew 0: the server's clock is the test's). */
const stateOf = (s: RoomSnapshot) => initialRoomState(s, Date.parse(s.serverNow));

type Island = ReturnType<typeof renderIsland<Parameters<typeof Screen>[0]>>;
const els = (island: Island) => [...new Set(walk(island.tree()))];
const one = (island: Island, type: unknown) => {
  const found = els(island).filter((e) => e.type === type);
  expect(type, "premise: the component exists").toBeTypeOf("function");
  expect(found.length, `one ${String((type as { name?: string }).name)}`).toBeLessThanOrEqual(1);
  return found[0] ?? null;
};
const boardMovable = (island: Island) => {
  const boards = els(island).filter((e) => propsOf(e).movable !== undefined && propsOf(e).fen !== undefined);
  expect(boards, "premise: one board").toHaveLength(1);
  return propsOf(boards[0]!).movable as boolean;
};
const locked = (island: Island) => propsOf(one(island, RoomControls)!).locked;
const flagKind = (island: Island) => {
  const n = one(island, FlagNotice);
  return n === null ? null : (propsOf(n).kind as string);
};
async function at(ms: number) {
  await vi.advanceTimersByTimeAsync(ms - (Date.now() - T0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("D13: at the mover's flag the room locks — the board, every game action — and says why", () => {
  it("live: open 1 ms before the flag; at the flag the board takes no move, the controls lock, and the room is confirming with Lichess", async () => {
    const state = stateOf(snap());
    const island = renderIsland(Screen, props(state, "live"));
    await at(WHITE_LEFT - 1);
    expect([boardMovable(island), locked(island), flagKind(island)], "above zero: the board as it was").toEqual([true, false, null]);
    await at(WHITE_LEFT);
    expect([boardMovable(island), locked(island), flagKind(island)], "at zero").toEqual([false, true, "lichess"]);
    // It stays locked as the clock sits at zero (no tick un-flags it).
    await at(WHITE_LEFT + 60_000);
    expect([boardMovable(island), locked(island), flagKind(island)]).toEqual([false, true, "lichess"]);
    island.unmount();
  });

  it("the result replaces it: the game over at Lichess — the result screen, no lock notice", async () => {
    const island = renderIsland(Screen, props(stateOf(snap()), "live"));
    await at(WHITE_LEFT + 1_000);
    expect(flagKind(island), "premise: locked").toBe("lichess");
    const over = stateOf(snap({ serverNow: new Date(T0 + WHITE_LEFT + 1_500).toISOString(), game: { ...LIVE, whiteMs: 0, over: true, clockRunning: false } }));
    island.rerender(props(over, "over"));
    await at(WHITE_LEFT + 1_600);
    expect(one(island, GameOver), "the result screen").not.toBeNull();
    expect(flagKind(island), "no lock notice over a result").toBeNull();
    island.unmount();
  });

  it("held (D11's clock_flag_unsettled, or any hold) at zero: the organiser is confirming it — never the generic held line", async () => {
    const held = stateOf(snap({ canAct: false }));
    const island = renderIsland(Screen, props(held, "held"));
    await at(WHITE_LEFT - 1);
    expect([flagKind(island), one(island, HeldSeam) !== null], "a held board above zero: the held line").toEqual([null, true]);
    await at(WHITE_LEFT);
    expect([flagKind(island), one(island, HeldSeam) !== null], "at zero").toEqual(["organiser", false]);
    island.unmount();
  });

  it("the empty cases never lock: clocks not yet running (ply < 2), the WAITING side at zero, a game already over — counted", async () => {
    const cases: [string, RoomGame][] = [
      ["clocks not running (one ply)", { ...LIVE, moves: ["e2e4"], turn: "black", clockRunning: false, whiteMs: 0, blackMs: 0 }],
      ["the waiting side (Black) at zero, White to move with time", { ...LIVE, blackMs: 0, whiteMs: 20 * 60_000 }],
      ["no clock stamp yet", { ...LIVE, clockAsOf: null, whiteMs: 0 }],
    ];
    let checked = 0;
    for (const [why, game] of cases) {
      vi.setSystemTime(T0);
      const island = renderIsland(Screen, props(stateOf(snap({ game })), "live"));
      await at(10 * 60_000);
      expect([locked(island), flagKind(island)], why).toEqual([false, null]);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("a SEQUENCE, from the WAITING player's side: the opponent's flag locks my board too; their move arrives (Lichess took it in time) — my clock, my move, unlocked", async () => {
    // Black's room: White (to move) is the one at zero — the lock is the board's, not the mover's alone (D13).
    const mine = { you: { colour: "black" as const, name: "Ada Okonkwo", checkedIn: true }, opponent: { colour: "white" as const, name: "Bo Lind", checkedIn: true } };
    const island = renderIsland(Screen, props(stateOf(snap(mine)), "live"));
    await at(WHITE_LEFT - 1);
    expect([locked(island), flagKind(island)], "premise: White still has time").toEqual([false, null]);
    await at(WHITE_LEFT + 200);
    expect([boardMovable(island), locked(island), flagKind(island)], "White's flag locks Black's room").toEqual([false, true, "lichess"]);
    const moved: RoomGame = {
      ...LIVE,
      moves: [...LIVE.moves, "g1f3"],
      turn: "black",
      whiteMs: 100,
      blackMs: 240_000,
      clockAsOf: new Date(T0 + WHITE_LEFT + 200).toISOString(),
    };
    island.rerender(props(stateOf(snap({ ...mine, serverNow: new Date(T0 + WHITE_LEFT + 200).toISOString(), game: moved })), "live"));
    await at(WHITE_LEFT + 300);
    expect([boardMovable(island), locked(island), flagKind(island)], "Black to move, 4 minutes left").toEqual([true, false, null]);
    island.unmount();
  });

  it("the room's skew moves the flag with the server's clock: a client 3 s behind locks when the SERVER reaches zero", async () => {
    // The server says it is T0 + 3 s when the client reads T0: the client's T0 + 2 s is the server's T0 + 5 s.
    const s = snap({ serverNow: new Date(T0 + 3_000).toISOString() });
    const state = initialRoomState(s, T0);
    expect(state.skewMs, "premise").toBe(3_000);
    const island = renderIsland(Screen, props(state, "live"));
    await at(WHITE_LEFT - 3_000 - 1);
    expect(locked(island)).toBe(false);
    await at(WHITE_LEFT - 3_000);
    expect(locked(island)).toBe(true);
    island.unmount();
  });
});

describe("D13: moverFlagAt — the instant the side to MOVE reaches zero, from the snapshot's own clock (V454), or none", () => {
  it("every case — counted; the two instants differ from each other's wrong answer", () => {
    const asOf = Date.parse(LIVE.clockAsOf!);
    const cases: [string, RoomGame, number | null][] = [
      ["White to move", LIVE, asOf + LIVE.whiteMs],
      ["Black to move", { ...LIVE, moves: [...LIVE.moves, "g1f3"], turn: "black" }, asOf + LIVE.blackMs],
      ["already at zero: the instant is the stamp", { ...LIVE, whiteMs: 0 }, asOf],
      // The empty cases: no clock runs toward a flag.
      ["clocks not running (ply < 2)", { ...LIVE, clockRunning: false }, null],
      ["the game over at Lichess (a result is coming, never a lock)", { ...LIVE, over: true, whiteMs: 0 }, null],
      ["no stamp yet", { ...LIVE, clockAsOf: null }, null],
    ];
    let checked = 0;
    for (const [why, g, want] of cases) {
      expect(moverFlagAt(g), why).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    expect(LIVE.whiteMs, "premise: the two sides' clocks differ").not.toBe(LIVE.blackMs);
  });
});

describe("D13: RoomControls locked — every game action disabled, in every shape the controls take (counted)", () => {
  const base = { you: "white" as const, opponentName: "Ada Okonkwo", busy: false, over: false, t: ((k: string) => k) as never, confirm: null, setConfirm: () => {} };
  const shapes: [string, { ply: number; drawOfferBy: "white" | "black" | null }][] = [
    ["mid-game", { ply: 12, drawOfferBy: null }],
    ["an incoming offer (Accept / Decline)", { ply: 12, drawOfferBy: "black" }],
    ["your own offer", { ply: 12, drawOfferBy: "white" }],
  ];
  const buttons = (node: ReturnType<typeof RoomControlsView>) => [...new Set(walk(node))].filter((e) => e.type === "button");
  it("unlocked: the actions a player may take are enabled (the positive pair)", () => {
    let enabled = 0;
    for (const [, s] of shapes) {
      for (const b of buttons(RoomControlsView({ ...base, ...s, onAct: () => {} }))) if (propsOf(b).disabled !== true) enabled += 1;
    }
    expect(enabled, "resign ×3, offer draw, decline, accept").toBe(6);
  });
  it("locked: no button is enabled, and none acts", () => {
    let checked = 0;
    const onAct = vi.fn();
    for (const [why, s] of shapes) {
      const bs = buttons(RoomControlsView({ ...base, ...s, onAct, locked: true }));
      expect(bs.length, `${why}: premise`).toBeGreaterThan(0);
      for (const b of bs) {
        expect(propsOf(b).disabled, `${why}: ${String(propsOf(b)["data-testid"])}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: buttons").toBeGreaterThanOrEqual(6);
    expect(onAct).not.toHaveBeenCalled();
  });
  it("a Resign confirm the player had open when the flag fell is closed — its Confirm cannot act at 0:00.0 (and the pair: open unlocked)", () => {
    const dialogOpen = (locked: boolean) => {
      const node = RoomControlsView({ ...base, ply: 12, drawOfferBy: null, onAct: () => {}, confirm: "resign", locked });
      const dialogs = [...new Set(walk(node))].filter((e) => propsOf(e).testId === "room-resign-confirm");
      expect(dialogs, "premise: the confirm dialog").toHaveLength(1);
      return propsOf(dialogs[0]!).open;
    };
    expect([dialogOpen(false), dialogOpen(true)]).toEqual([true, false]);
  });
});

// T17B fix 2, D24 (re-review I2) — the lock reads the SERVER's numbers (moverFlagAt), so while a move is in flight the
// face (the guess: the clock as the drop left it, plus the increment) said 0:09.6 under "Time's up — confirming with
// Lichess". The guess is the player's own clock; a move dropped in time is not a clock at zero, and the lock stands
// down while that move is out. When the answer is a refusal the guess goes, the server's number is again the one on the
// face, and the lock reapplies (and the zero report with it: use-clock-faces.test.tsx).
describe("D24: a move dropped in time and still in flight when the SERVER's clock reaches zero does not lock the room", () => {
  const DROPPED_AT = 1_000;
  /** The REAL reducer's own guess: a move dropped DROPPED_AT into White's 5 s, on a +5 division — 4 s left + 5 s = 9 s. */
  const inFlight = (action: { kind: "move"; uci: string } | { kind: "resign" } = { kind: "move", uci: "g1f3" }) =>
    roomReducer(stateOf(snap({ meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 5 } })), {
      type: "act_sent",
      action,
      at: T0 + DROPPED_AT,
    });
  /** PlayColumn's own props, the part of the live board that takes the lock (the clocks' "over" look). */
  const playColumnHeld = (island: Island) => {
    const cols = els(island).filter((e) => propsOf(e).onZero !== undefined && propsOf(e).optimistic !== undefined);
    expect(cols, "premise: one play column").toHaveLength(1);
    return propsOf(cols[0]!).held as boolean;
  };

  it("the guess is what the reducer made (premise), and past the server's zero the room is NOT locked: no notice, the controls as they were, the clocks not stopped", async () => {
    const state = inFlight();
    expect(state.optimistic, "premise: 4 s left at the drop, +5 s").toMatchObject({ ms: 9_000, ply: 3 });
    const island = renderIsland(Screen, props(state, "live"));
    await at(WHITE_LEFT + 700);
    expect(moverFlagAt(LIVE), "premise: the server's flag instant is behind us").toBe(T0 + WHITE_LEFT);
    expect(flagKind(island), "no 'Time's up' over a face reading 0:0x").toBeNull();
    expect(locked(island), "the controls are not the flag's to lock").toBe(false);
    expect(playColumnHeld(island), "the clocks are not stopped").toBe(false);
    island.unmount();
  });

  it("the answer is a REFUSAL: the guess goes, the server's number is the face again, and the lock reapplies (board, controls, notice, clocks)", async () => {
    const island = renderIsland(Screen, props(inFlight(), "live"));
    await at(WHITE_LEFT + 700);
    expect(flagKind(island), "premise: standing down while the move is out").toBeNull();
    const refused = roomReducer(inFlight(), { type: "act_answered", answer: { ok: false, reconcile: true, reason: "not_your_turn_or_over" } as never });
    expect([refused.pending, refused.optimistic], "premise: the refusal cleared both").toEqual([null, null]);
    island.rerender(props(refused, "live"));
    await at(WHITE_LEFT + 800);
    expect([boardMovable(island), locked(island), flagKind(island), playColumnHeld(island)], "locked again").toEqual([false, true, "lichess", true]);
    island.unmount();
  });

  it("the answer was a SUCCESS: pending clears, the guess still stands until the re-read puts the ply on the ledger — still no lock over the guess face; once the guess has expired (a re-read that never came) the lock applies", async () => {
    const answeredOk = roomReducer(inFlight(), { type: "act_answered", answer: { ok: true, applied: true } as never });
    expect([answeredOk.pending, answeredOk.optimistic !== null], "premise: answered, the guess is still on the face").toEqual([null, true]);
    const island = renderIsland(Screen, props(answeredOk, "live"));
    await at(WHITE_LEFT + 700);
    expect([flagKind(island), locked(island), playColumnHeld(island)], "inside the re-read's window: the guess is the face").toEqual([null, false, false]);
    // The guess's own life is OPTIMISTIC_CLOCK_MAX_MS from the drop; past it the server's number is the face (clock-math).
    await at(DROPPED_AT + OPTIMISTIC_CLOCK_MAX_MS + 1_500);
    expect([flagKind(island), locked(island)], "the guess expired: the face is the server's zero, and the lock is truthful again").toEqual(["lichess", true]);
    island.unmount();
  });

  it("only a MOVE earns the stand-down: a resign in flight at the flag is locked as ever (the pair, counted with the move)", async () => {
    let checked = 0;
    for (const [why, action, lockedAtFlag] of [
      ["a move", { kind: "move", uci: "g1f3" } as const, false],
      ["a resign", { kind: "resign" } as const, true],
    ] as const) {
      vi.setSystemTime(T0);
      const island = renderIsland(Screen, props(inFlight(action), "live"));
      await at(WHITE_LEFT + 700);
      expect([locked(island), flagKind(island) !== null], `${why} in flight at the flag`).toEqual([lockedAtFlag, lockedAtFlag]);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  // The ruling is "suppressed while a MOVE is pending", not "while a guess exists": a control with no increment leaves no
  // guess (the server adds nothing), and its move in flight at the flag is still a move dropped in time.
  it("a control with NO increment (no guess to stand on): the move in flight at the flag still does not lock; a resign there does", async () => {
    const noInc = SHIP1_TIME_CONTROLS.find((tc) => tc.incrementSeconds === 0);
    expect(noInc, "premise: the catalogue has a zero-increment control").toBeDefined();
    const base = stateOf(snap({ meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: noInc!.limitSeconds, incrementSeconds: noInc!.incrementSeconds } }));
    let checked = 0;
    for (const [why, action, lockedAtFlag] of [
      ["a move", { kind: "move", uci: "g1f3" } as const, false],
      ["a resign", { kind: "resign" } as const, true],
    ] as const) {
      vi.setSystemTime(T0);
      const state = roomReducer(base, { type: "act_sent", action, at: T0 + DROPPED_AT });
      expect(state.optimistic, `${why}: premise — no increment, no guess`).toBeNull();
      const island = renderIsland(Screen, props(state, "live"));
      await at(WHITE_LEFT + 700);
      expect([locked(island), flagKind(island) !== null], `${why} in flight at the flag (${noInc!.key})`).toEqual([lockedAtFlag, lockedAtFlag]);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the empty case: with nothing in flight the flag locks at the server's zero, as D13 has it (the stand-down is for a move out, nothing else)", async () => {
    const island = renderIsland(Screen, props(stateOf(snap()), "live"));
    await at(WHITE_LEFT + 700);
    expect([boardMovable(island), locked(island), flagKind(island)]).toEqual([false, true, "lichess"]);
    island.unmount();
  });
});
