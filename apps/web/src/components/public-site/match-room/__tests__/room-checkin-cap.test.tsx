// Final review M-3, the SCREEN: an admitted, protected player past the deadline was shown "Check-in closes in 0:00 / at 14:10"
// behind the camera permission prompt, and could reasonably close the tab. The countdown must run to where THIS viewer's check-in
// really closes (the board's cap, spec §5.7.8). The static render is the pre-mount frame (no time of day is ever server-rendered),
// so this MOUNTS the real `Screen` under the island harness with fake timers and reads the props it hands the check-in card.
//
// Expected values come from the window's own constants (LINE_DEADLINE_GRACE_MS), never from the function under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { LINE_DEADLINE_GRACE_MS } from "@/server/external-play/window";
import { formatTimeOfDay } from "../room-time";
import { Screen } from "../room-shell";
import { initialRoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import type { RoomSnapshot } from "../room-snapshot";

const DEADLINE = Date.parse("2026-10-16T19:14:00.000Z");
const MIN = 60_000;
const GRACE_MIN = LINE_DEADLINE_GRACE_MS / MIN;
const face = (minutes: number) => `${minutes}:00`;

function snap(over: Partial<RoomSnapshot>): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(DEADLINE).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(DEADLINE - 10 * MIN).toISOString(),
    opensAt: new Date(DEADLINE - 20 * MIN).toISOString(),
    deadline: new Date(DEADLINE).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "required",
    opponentCamera: null,
    ownParticipantId: "p-own",
    frozen: null,
    canAct: true,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    realtime: null,
    heldUntil: null,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Mount the real Screen on a snapshot, the page's clock at `clockAt`, and read what the check-in card is handed. */
async function mounted(s: RoomSnapshot, clockAt: number, laterMs = 0) {
  vi.setSystemTime(clockAt);
  const state = initialRoomState(s, clockAt);
  const noop = async () => null;
  const island = renderIsland(Screen, {
    screen: roomScreen(state),
    state,
    room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false },
    camera: { status: "idle", stream: null, enable: () => {} },
    presence: null,
    busy: false,
    tryAgain: () => {},
    relinkHref: "/x",
    locale: "en",
    t: ((k: string) => k) as never,
    plural: ((k: string) => k) as never,
  } as never);
  await vi.advanceTimersByTimeAsync(1 + laterMs);
  const card = walk(island.tree()).find((e) => propsOf(e).closesIn !== undefined && propsOf(e).closesAt !== undefined);
  expect(card, "the check-in card is on the screen").toBeDefined();
  const props = propsOf(card!);
  island.unmount();
  return { closesIn: props.closesIn as string | null, closesAt: props.closesAt as string | null };
}

describe("the check-in card's countdown runs to where THIS viewer's check-in closes (final review M-3, N-1)", () => {
  it("nothing held (heldUntil null): the deadline, counting down (the unchanged case)", async () => {
    const got = await mounted(snap({ serverNow: new Date(DEADLINE - 3 * MIN).toISOString() }), DEADLINE - 3 * MIN);
    expect(got.closesIn).toBe(face(3));
    expect(got.closesAt).toBe(formatTimeOfDay(new Date(DEADLINE).toISOString(), "en"));
  });

  it("held by the admit hold (the server's instant is 30 s out, well before the cap): the countdown is to THAT instant - not 0:00 and not the cap", async () => {
    const heldUntil = DEADLINE + MIN + 30_000;
    const got = await mounted(snap({ serverNow: new Date(DEADLINE + MIN).toISOString(), heldUntil: new Date(heldUntil).toISOString() }), DEADLINE + MIN);
    expect(got.closesIn, "30 seconds left").toBe("0:30");
    expect(got.closesIn).not.toBe(face(0));
    expect(got.closesIn, "the wrong answer: the cap's minutes").not.toBe(face(GRACE_MIN - 1));
    expect(got.closesAt, "and the time of day is the held instant's").toBe(formatTimeOfDay(new Date(heldUntil).toISOString(), "en"));
    expect(got.closesAt).not.toBe(formatTimeOfDay(new Date(DEADLINE).toISOString(), "en"));
  });

  it("held by the cap (a waiting or counted player): the countdown is to the cap, derived from the grace", async () => {
    const cap = DEADLINE + LINE_DEADLINE_GRACE_MS;
    const got = await mounted(snap({ serverNow: new Date(DEADLINE + MIN).toISOString(), heldUntil: new Date(cap).toISOString() }), DEADLINE + MIN);
    expect(GRACE_MIN, "premise: the grace is longer than the minute past the deadline").toBeGreaterThan(1);
    expect(got.closesIn, "the grace less the minute already used").toBe(face(GRACE_MIN - 1));
    expect(got.closesAt).toBe(formatTimeOfDay(new Date(cap).toISOString(), "en"));
  });

  it("the pair: a page composed a second BEFORE the deadline and not yet refreshed past it keeps the deadline (0:00) - it has been told nothing is held", async () => {
    const got = await mounted(snap({ serverNow: new Date(DEADLINE - 1_000).toISOString() }), DEADLINE - 1_000, 30_000);
    expect(got.closesIn, "the page's clock is 29 s past the deadline; the server never said this viewer was held").toBe(face(0));
    expect(got.closesAt).toBe(formatTimeOfDay(new Date(DEADLINE).toISOString(), "en"));
  });
});
