// Capacity test 15(d) (spec §8.1, §5.7.2): the NINE consumers of `inLine` answer the same question for the same stay; the FOUR
// consumers of `reservedSql` do; the ONE outside consumer of `stayOpenSql` does. Each is driven by its REAL entry point (the
// gate, the door read, the real claim, the real sweep, `boardPhase`) for one stay in each of four states - live, served, ended,
// lapsed - and the observable each produces is compared with what the RULEBOOK says that state means (a live stay counts; a
// served, ended or lapsed one does not), never with another consumer's answer.
//
// The create allowance (consumer 6) is the one place the implementation departs from the spec's list: the board's create is
// owed iff BOTH check-ins count (`bothOnly`), and a protected player on one side alone owes it nothing, so it does not read the
// line at all. It is driven here as a consumer whose answer must NOT move with the stay's state (recorded in the build report).
//
// Single sport, deliberately: the line does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { boardAnchor } from "@/server/external-play/window";
import { ADMIT_HOLD_MS, LINE_ABANDON_AFTER_MS, LINE_RELEASE_GRACE_MS, LINE_RESERVATION, boardPhase, lineActive, ownStayInLine } from "@/server/external-play/seat-line";
import type { GateAnswer } from "@/server/external-play/seat-line";
import { claimAt, holdReservation, holdWaiting, putStay, stayRow } from "./_external-play-line";
import { DEADLINE, OPENED, SEC, claimRoom, dropWorlds, fund, seedBoard, sweepBoard, world, type Board, type World } from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const ANCHOR = boardAnchor(OPENED, 0, false);
/** Past the deadline and inside the cap: the instant every question is asked at. */
const NOW = new Date(DEADLINE.getTime() + 30 * SEC);
/** The stay arrived in time, so it is protected while it is live. */
const ARRIVED = new Date(DEADLINE.getTime() - 25 * SEC);

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

type State = "live" | "served" | "ended" | "lapsed";
const STATES: State[] = ["live", "served", "ended", "lapsed"];
/** The rulebook: only a live stay counts. A stay is over when it is served, ended, or silent past its grace. */
const COUNTS: Record<State, boolean> = { live: true, served: false, ended: false, lapsed: false };

type Kind = "waiting" | "admitted" | "other-side";
/** Put `personId`'s stay on `board` into `state`, as of NOW. A WAITING stay is in line (held); an ADMITTED one holds a reservation
 *  and was never held; the OTHER SIDE's is an open check-in that was never held. */
async function putState(w: World, board: Board, side: "home" | "away", state: State, kind: Kind): Promise<void> {
  const silentFor = kind === "waiting" ? LINE_ABANDON_AFTER_MS : LINE_RELEASE_GRACE_MS;
  const seen = state === "lapsed" ? new Date(NOW.getTime() - silentFor) : new Date(NOW.getTime() - 5 * SEC);
  await putStay({
    fixtureId: board.fixtureId,
    personId: board[side].personId,
    budgetKey: w.key,
    firstClaimAt: ARRIVED,
    seenAt: seen,
    gate: kind === "waiting" ? "held" : "passed",
    queuedAt: kind === "waiting" ? ARRIVED : null,
    // An admitted stay was admitted shortly before (inside the hold) so only `state` can end it.
    admittedAt: kind === "admitted" ? new Date(NOW.getTime() - 10 * SEC) : null,
    servedAt: state === "served" ? new Date(NOW.getTime() - 10 * SEC) : null,
    endedAt: state === "ended" ? new Date(NOW.getTime() - 10 * SEC) : null,
  });
}

const show = (a: GateAnswer): string => (a.kind === "go" ? `go:${a.decision}` : a.kind === "queued" ? `queued@${a.line.position}` : a.kind);

type Scene = { w: World; b: Board };
/** A board (with a meeting, so the sweep has a room to end) whose HOME player's stay is in `state`. */
async function scene(state: State, kind: Kind, over: { mint?: boolean } = {}): Promise<Scene> {
  const w = world();
  const b = await seedBoard();
  if (over.mint) {
    await fund(w.key, 300);
    await claimRoom(w, b, "home", ARRIVED); // the mint: a meeting exists to be torn down
  }
  await putState(w, b, kind === "other-side" ? "away" : "home", state, kind);
  return { w, b };
}

/** A probe returns what its consumer SAYS about the stay; `counted` and `not` are what the rulebook makes it say in each case. */
type Consumer = {
  n: number;
  name: string;
  callSite: string;
  kind: Kind;
  mint?: boolean;
  counted: string;
  not: string;
  probe: (s: Scene) => Promise<string>;
};

/** A fresh player arriving on the same bucket (a later, never-held stay) at NOW. */
async function arrival(s: Scene, over: Parameters<typeof claimAt>[4] = {}): Promise<string> {
  const y = await seedBoard();
  return show(await claimAt(s.w.key, y, "home", NOW, { anchor: ANCHOR, ...over }));
}

const IN_LINE: Consumer[] = [
  {
    n: 1,
    name: "the gate's waitingAhead count (and the position shown)",
    callSite: "seat-line.ts readStanding -> gateClaim",
    kind: "waiting",
    counted: "queued@3",
    not: "queued@2",
    probe: async (s) => {
      await holdWaiting(s.w.key, new Date(ARRIVED.getTime() - 5 * SEC), new Date(NOW.getTime() - SEC)); // a second live waiter, always
      await fund(s.w.key, 0);
      return arrival(s);
    },
  },
  {
    n: 2,
    name: "the gate's idle test (the key-wide waiting count)",
    callSite: "seat-line.ts readStanding -> gateClaim",
    kind: "waiting",
    counted: "queued@1",
    not: "go:idle",
    probe: async (s) => {
      // An EARLIER arrival than the stay: it has nobody ahead, so only the key-wide count can stop it going.
      const y = await seedBoard();
      await putStay({ fixtureId: y.fixtureId, personId: y.home.personId, budgetKey: s.w.key, firstClaimAt: new Date(ARRIVED.getTime() - 15 * SEC), seenAt: new Date(NOW.getTime() - 5 * SEC), gate: "passed" });
      await fund(s.w.key, 0);
      return show(await claimAt(s.w.key, y, "home", NOW, { anchor: ANCHOR }));
    },
  },
  {
    n: 3,
    name: "the door: is the caller's own stay in line",
    callSite: "seat-line.ts ownStayInLine <- room.ts claimRoomSeat",
    kind: "waiting",
    counted: "true",
    not: "false",
    probe: async (s) => String(await ownStayInLine({ fixtureId: s.b.fixtureId, personId: s.b.home.personId, at: NOW })),
  },
  {
    n: 4,
    name: "seat admission past the deadline",
    callSite: "preflight.ts seatPlayer -> boardPhase",
    kind: "waiting",
    counted: "not-window_closed",
    not: "window_closed",
    probe: async (s) => {
      await fund(s.w.key, 300);
      const got = await claimRoom(s.w, s.b, "home", NOW);
      return got.seat && !got.seat.seated && got.seat.reason === "window_closed" ? "window_closed" : "not-window_closed";
    },
  },
  {
    n: 5,
    name: "noShow's skip",
    callSite: "sweep.ts noShow -> boardPhase",
    kind: "waiting",
    mint: true,
    counted: "skipped",
    not: "judged",
    probe: async (s) => ((await sweepBoard(s.b, NOW)).report.noShows === 0 ? "skipped" : "judged"),
  },
  {
    n: 6,
    name: "the create's allowance (bothOnly: it does not read the line)",
    callSite: "create-game.ts / sweep.ts boardPhase({ bothOnly: true })",
    kind: "waiting",
    counted: "closed",
    not: "closed",
    probe: async (s) => boardPhase(NOW, { fixtureId: s.b.fixtureId, anchor: ANCHOR }, { personId: null, facts: { own: false, both: false }, bothOnly: true }),
  },
  {
    n: 7,
    name: "the room's phase, per viewer",
    callSite: "room.ts viewerPhase -> boardPhase",
    kind: "waiting",
    counted: "open",
    not: "closed",
    probe: async (s) => {
      await fund(s.w.key, 300);
      return (await claimRoom(s.w, s.b, "home", NOW)).snapshot.phase;
    },
  },
  {
    n: 8,
    name: "teardown (meetingIsDone)",
    callSite: "sweep.ts meetingIsDone -> boardPhase",
    kind: "waiting",
    mint: true,
    counted: "kept",
    not: "ended",
    probe: async (s) => {
      // Two passes: the first may judge the board, the next tears its room down.
      const first = await sweepBoard(s.b, NOW);
      const second = await sweepBoard(s.b, new Date(NOW.getTime() + SEC));
      return first.ended.length + second.ended.length === 0 ? "kept" : "ended";
    },
  },
  {
    n: 9,
    name: "the optional yield (the line is active in the bucket)",
    callSite: "seat-line.ts lineActive <- preflight.ts",
    kind: "waiting",
    counted: "true",
    not: "false",
    probe: async (s) => String(await lineActive({ budgetKey: s.w.key, at: NOW })),
  },
];

const RESERVED: Consumer[] = [
  {
    n: 1,
    name: "the pool in the gate (tokens - reserved)",
    callSite: "seat-line.ts readStanding -> gateClaim",
    kind: "admitted",
    counted: "queued@1",
    not: "go:admit",
    probe: async (s) => {
      await holdReservation(s.w.key, new Date(NOW.getTime() - 5 * SEC)); // a second admitted stay keeps the line non-idle
      await fund(s.w.key, 2 * L); // exactly two reservations: the pool is zero if this stay holds one, L if it does not
      return arrival(s);
    },
  },
  {
    n: 2,
    name: "the gate's idle test (no live admitted stay)",
    callSite: "seat-line.ts readStanding -> gateClaim",
    kind: "admitted",
    counted: "queued@1",
    not: "go:idle",
    probe: async (s) => {
      await fund(s.w.key, 0);
      return arrival(s);
    },
  },
  {
    n: 3,
    name: "the gate's own-row test (an admitted live stay goes)",
    callSite: "seat-line.ts readStanding.mineAdmitted -> gateClaim",
    kind: "admitted",
    counted: "go:admitted",
    not: "go:idle",
    probe: async (s) => {
      await fund(s.w.key, 0);
      return show(await claimAt(s.w.key, s.b, "home", NOW, { anchor: ANCHOR }));
    },
  },
  {
    n: 4,
    name: "the optional yield (a live admitted stay, never held)",
    callSite: "seat-line.ts lineActive <- preflight.ts",
    kind: "admitted",
    counted: "true",
    not: "false",
    probe: async (s) => String(await lineActive({ budgetKey: s.w.key, at: NOW })),
  },
];

const OPEN_OUTSIDE: Consumer[] = [
  {
    n: 1,
    name: "the completing evaluation (the board's other side has an open stay)",
    callSite: "seat-line.ts readStanding.otherOpen -> gateClaim",
    kind: "other-side",
    counted: "completing",
    not: "not-completing",
    probe: async (s) => {
      await holdReservation(s.w.key, new Date(NOW.getTime() - 5 * SEC)); // the line is active (an admitted stay), nobody waits ahead: HOME is a candidate
      await fund(s.w.key, 4 * L);
      const got = await claimAt(s.w.key, s.b, "home", NOW, { anchor: ANCHOR });
      expect(show(got), "premise: HOME is admitted (the pool pays either reservation)").toBe("go:admit");
      return (await stayRow(s.b.fixtureId, s.b.home.personId))?.completing ? "completing" : "not-completing";
    },
  },
];

async function drive(group: string, consumers: Consumer[], expectedCount: number): Promise<void> {
  expect(consumers.length, `${group}: the consumers of the list (the number in spec §5.7.2)`).toBe(expectedCount);
  let driven = 0;
  const seen = new Set<string>();
  for (const c of consumers) {
    for (const state of STATES) {
      const s = await scene(state, c.kind, { mint: c.mint });
      const got = await c.probe(s);
      const want = COUNTS[state] ? c.counted : c.not;
      expect(got, `${group} ${c.n} (${c.name}) for a ${state} stay`).toBe(want);
      seen.add(`${c.n}:${got}`);
      driven += 1;
    }
  }
  expect(driven, `${group}: stays driven`).toBe(expectedCount * STATES.length);
  // Anti-vacuity: a consumer that answered the same thing for every state would pass both halves of the table only by accident -
  // except the create allowance, which is MEANT not to move.
  for (const c of consumers) {
    if (c.counted === c.not) continue;
    expect(seen.has(`${c.n}:${c.counted}`) && seen.has(`${c.n}:${c.not}`), `${group} ${c.n}: it answered BOTH ways across the four states`).toBe(true);
  }
}

describe.skipIf(!DB)("every consumer of the line answers the same question for the same stay (test 15(d))", () => {
  it("the NINE consumers of inLine: live counts, served / ended / lapsed do not (9 consumers x 4 states, reported)", async () => {
    await drive("inLine", IN_LINE, 9);
    expect(IN_LINE.map((c) => c.n), "numbered 1..9").toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 600_000);

  it("the create allowance does not move with the stay, and rests on BOTH check-ins counting: closed with one or none, open with both - in every state (consumer 6)", async () => {
    let checked = 0;
    for (const state of STATES) {
      const s = await scene(state, "waiting");
      const board = { fixtureId: s.b.fixtureId, anchor: ANCHOR };
      expect(await boardPhase(NOW, board, { personId: null, facts: { own: true, both: false }, bothOnly: true }), `${state}: one side counted`).toBe("closed");
      expect(await boardPhase(NOW, board, { personId: null, facts: { own: true, both: true }, bothOnly: true }), `${state}: both counted`).toBe("open");
      checked += 1;
    }
    expect(checked).toBe(STATES.length);
  }, 120_000);

  it("the FOUR consumers of reservedSql (the pool, the idle test, the own-row test, the optional yield): a live admitted stay holds its reservation, a served / ended / lapsed one does not (4 x 4)", async () => {
    await drive("reservedSql", RESERVED, 4);
  }, 300_000);

  it("the ONE outside consumer of stayOpenSql (the completing evaluation): the other side's open stay makes HOME's reservation carry the re-verify; a served / ended / lapsed one does not (1 x 4)", async () => {
    await drive("stayOpenSql", OPEN_OUTSIDE, 1);
  }, 120_000);

  it("the hold bounds an admitted stay alone: the same stay one millisecond inside ADMIT_HOLD_MS still reserves, at it does not (a boundary pair for the third lapse clause)", async () => {
    let checked = 0;
    for (const [when, ms, reserves] of [
      ["1 ms inside the hold", ADMIT_HOLD_MS - 1, true],
      ["at the hold", ADMIT_HOLD_MS, false],
    ] as const) {
      const w = world();
      const b = await seedBoard();
      const at = new Date(NOW.getTime());
      await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: w.key, firstClaimAt: ARRIVED, seenAt: new Date(at.getTime() - SEC), gate: "passed", admittedAt: new Date(at.getTime() - ms) });
      expect(await lineActive({ budgetKey: w.key, at }), when).toBe(reserves);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});
