// fixture-row-action.test.ts — the one authority for what a run-sheet row
// offers. Pure: no DB, no DOM, no engine import.
import { describe, expect, it } from "vitest";
import {
  canEditFixtureTime,
  fixtureRowAction,
  hasAssignedScorer,
  TIMETABLE_MOVABLE_STATUS,
  type RowActionInput,
} from "../fixture-row-action";
// SERVER module, imported here on purpose: `apps/web` vitest is node-env, so a
// unit test can reach it even though the client component that consumes the
// copy below cannot (a client component importing `@/server` breaks the
// build). Same pattern as `bracket-kinds-sync.test.ts`, which pins this
// repo's other three hand-copied lists to their originals.
import { MOVABLE_STATUS } from "@/server/usecases/schedule";

const TZ = "Europe/London";
// 2026-09-03T13:00:00Z — 14:00 London, comfortably inside the day either way.
const NOW = Date.UTC(2026, 8, 3, 13, 0);
const TODAY_1500 = "2026-09-03T14:00:00.000Z";
const TOMORROW_1000 = "2026-09-04T09:00:00.000Z";

function row(over: Partial<RowActionInput> = {}): RowActionInput {
  return {
    status: "scheduled",
    scheduledAt: TODAY_1500,
    hasOfficials: true,
    canEdit: true,
    tz: TZ,
    nowMs: NOW,
    awaitingDraw: false,
    awaitsSettle: false,
    ...over,
  };
}

describe("fixtureRowAction — the enumerated table", () => {
  it("in_play beats every other consideration, scheduled today or not", () => {
    expect(fixtureRowAction(row({ status: "in_play" })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  it("a scheduled fixture TODAY with no officials asks for a scorer", () => {
    expect(fixtureRowAction(row({ hasOfficials: false })).kind).toBe("assign_scorer");
  });

  it("a scheduled fixture NOT today with no officials does not — it is not today's problem", () => {
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000, hasOfficials: false })).kind).toBe("score");
  });

  it("a scheduled fixture with officials scores, today or not", () => {
    expect(fixtureRowAction(row()).kind).toBe("score");
    expect(fixtureRowAction(row({ scheduledAt: TOMORROW_1000 })).kind).toBe("score");
  });

  it("decided and finalized both read Result", () => {
    expect(fixtureRowAction(row({ status: "decided" })).kind).toBe("result");
    expect(fixtureRowAction(row({ status: "finalized" })).kind).toBe("result");
  });

  it("a scheduled fixture with no time offers Set time, and only to an editor", () => {
    expect(fixtureRowAction(row({ scheduledAt: null })).kind).toBe("set_time");
    expect(fixtureRowAction(row({ scheduledAt: null, canEdit: false })).kind).toBe("view");
  });

  it("abandoned, forfeited and cancelled are RESULTS, not open work", () => {
    // Not in the spec's table. Without an explicit branch they fall through to
    // the default, and a cancelled match would print "Score" — inviting an
    // organiser to score a match that will never be played.
    for (const status of ["abandoned", "forfeited", "cancelled"]) {
      expect(fixtureRowAction(row({ status })).kind, status).toBe("result");
    }
  });

  it("an unknown status never crashes and never invites scoring", () => {
    expect(fixtureRowAction(row({ status: "teleported" })).kind).toBe("view");
  });
});

// W2a Task 11 (finding 25; addendum 3): a HELD bracket fixture (`needs_decision` — a level result in a knockout) is
// neither a result nor open scoring: it is owed the organiser's settle, and that is the row's one action.
describe("fixtureRowAction — a held fixture (W2a, needs_decision)", () => {
  it("offers Settle (decide) to an editor, timed or not, today or not", () => {
    let checked = 0;
    for (const scheduledAt of [TODAY_1500, TOMORROW_1000, null]) {
      for (const hasOfficials of [true, false]) {
        expect(fixtureRowAction(row({ status: "needs_decision", scheduledAt, hasOfficials })).kind, String(scheduledAt)).toBe("decide");
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("M10 (fix round 1): a recorded abandon awaiting its settle (stored `abandoned`) is held too — Settle, not a result", () => {
    expect(fixtureRowAction(row({ status: "abandoned", awaitsSettle: true })).kind).toBe("decide");
    expect(fixtureRowAction(row({ status: "abandoned", awaitsSettle: true, canEdit: false })).kind).toBe("view");
    // The positive pair: the generator's void (abandoned, nothing owed) stays a result.
    expect(fixtureRowAction(row({ status: "abandoned", awaitsSettle: false })).kind).toBe("result");
  });

  it("a viewer who cannot edit only views it — the settle is organiser-only on the server", () => {
    expect(fixtureRowAction(row({ status: "needs_decision", canEdit: false })).kind).toBe("view");
  });

  it("the positive pair: the same row DECIDED is a result, never a decide", () => {
    expect(fixtureRowAction(row({ status: "decided" })).kind).toBe("result");
  });
});

// F5 (W2 walkthrough gate 1): a TIMED bracket fixture whose entrants are still
// undrawn read "Awaiting draw" as its sub-line and offered "Score" as its
// action — a promise the fixture cannot keep, since neither side is named.
describe("fixtureRowAction — an undrawn fixture (F5)", () => {
  it("a timed, awaiting-draw fixture is VIEW, never score or assign_scorer", () => {
    expect(fixtureRowAction(row({ awaitingDraw: true })).kind).toBe("view");
    expect(fixtureRowAction(row({ awaitingDraw: true, hasOfficials: false })).kind).toBe("view");
  });

  // The POSITIVE pair: the SAME input with entrants resolved reaches the
  // ladder's ordinary rules — the awaiting-draw branch is what changed the
  // outcome above, not something else about this fixture shape.
  it("the identical fixture WITHOUT awaiting-draw reaches score/assign_scorer as before", () => {
    expect(fixtureRowAction(row({ awaitingDraw: false })).kind).toBe("score");
    expect(fixtureRowAction(row({ awaitingDraw: false, hasOfficials: false })).kind).toBe(
      "assign_scorer",
    );
  });

  // An untimed, undrawn fixture still offers `set_time` — pre-scheduling a
  // bracket round's slot ahead of the draw that fills it is an ordinary
  // organiser action, and nothing about this finding criticises it.
  it("an UNTIMED awaiting-draw fixture still offers set_time — pre-draw scheduling is unaffected", () => {
    expect(fixtureRowAction(row({ awaitingDraw: true, scheduledAt: null })).kind).toBe("set_time");
  });

  // SETTLED still wins over awaiting-draw — a decided match with a TBD-labelled
  // loser (a walkover recorded before the other semi finished) is a result,
  // not a match still waiting on its draw.
  it("a DECIDED awaiting-draw fixture is still a result, not view", () => {
    expect(fixtureRowAction(row({ awaitingDraw: true, status: "decided" })).kind).toBe("result");
  });
});

describe("fixtureRowAction — the ORDER of the ladder, not just its branches", () => {
  // _RULES.md: a test that pins a ladder must pin the ORDER too — a case whose
  // expected value differs between two candidate orderings. If the
  // "scheduled today, no officials" rule were checked BEFORE in_play, this
  // fixture would read assign_scorer instead of open_pad.
  it("in_play + today + no officials is open_pad, which only the correct order gives", () => {
    expect(fixtureRowAction(row({ status: "in_play", hasOfficials: false })).kind).toBe("open_pad");
  });

  // And the mirror: if set_time were checked FIRST, an in_play fixture whose
  // time was cleared would read set_time.
  it("in_play with no time is open_pad, not set_time", () => {
    expect(fixtureRowAction(row({ status: "in_play", scheduledAt: null })).kind).toBe("open_pad");
  });
});

describe("fixtureRowAction — 'today' is the VENUE day, and the boundary is real", () => {
  it("23:30 local on the day before is NOT today", () => {
    // 2026-09-02T22:30Z = 23:30 London on the 2nd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T22:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("score");
  });

  it("00:30 local on the day itself IS today", () => {
    // 2026-09-02T23:30Z = 00:30 London on the 3rd.
    expect(
      fixtureRowAction(row({ scheduledAt: "2026-09-02T23:30:00.000Z", hasOfficials: false })).kind,
    ).toBe("assign_scorer");
  });

  it("the same instant in a different venue zone lands on a different day", () => {
    // NOW (2026-09-03T13:00Z) is itself past midnight in Auckland (+12, no
    // DST until the 27th) — "today" there is the 4th, not the 3rd. So the
    // instant that demonstrates the contrast has to be one that crosses INTO
    // the 4th, not one that stays on the 3rd:
    // 2026-09-03T23:30Z is 11:30 on the 4th in Auckland (today, +12) but
    // 00:30 on the 4th in London (NOT today — London's today is the 3rd).
    expect(
      fixtureRowAction(
        row({ scheduledAt: "2026-09-03T23:30:00.000Z", hasOfficials: false, tz: "Pacific/Auckland" }),
      ).kind,
    ).toBe("assign_scorer");
  });
});

// Fix round 5 (owner ruling): "correct a time already set" is restored, and
// the affordance is the TIME CELL rather than a second row-level control.
// `canEditFixtureTime` is the predicate that decides whether the cell is a
// button; `fixtureRowAction` itself is deliberately unchanged, so the ORDER
// describe above and its mutants still hold.
describe("canEditFixtureTime — is the displayed time an affordance?", () => {
  const AT = "2026-09-03T14:00:00.000Z";

  // THE PIN THAT MATTERS. `moveFixture` refuses a timetable change for any
  // status but `MOVABLE_STATUS`, with a 422. If this client-side copy ever
  // drifts from the server's constant, the row starts offering an editor
  // whose Save cannot succeed — a control that 422s is a dead end, which is
  // the exact class this wave exists to remove. Asserted against the SERVER
  // module, not a second typed literal.
  it("its movable status IS the server's MOVABLE_STATUS, not a hand-typed twin", () => {
    expect(TIMETABLE_MOVABLE_STATUS).toBe(MOVABLE_STATUS);
  });

  it("a scheduled, timed fixture is editable when the viewer can edit", () => {
    expect(canEditFixtureTime({ status: "scheduled", scheduledAt: AT, canEdit: true })).toBe(true);
  });

  it("a read-only viewer never gets the affordance", () => {
    expect(canEditFixtureTime({ status: "scheduled", scheduledAt: AT, canEdit: false })).toBe(false);
  });

  it("an untimed row is not editable — it has an em-dash, and its own Set time action", () => {
    expect(canEditFixtureTime({ status: "scheduled", scheduledAt: null, canEdit: true })).toBe(false);
  });

  // Enumerated, not sampled: every status the server will refuse must be
  // refused HERE too, or the row offers a save that 422s. One lucky sample
  // ("decided") would leave the other five untested.
  it.each(["in_play", "decided", "finalized", "cancelled", "abandoned", "forfeited"])(
    "a %s fixture is never editable — moveFixture 422s it",
    (status) => {
      expect(canEditFixtureTime({ status, scheduledAt: AT, canEdit: true })).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Max-effort review, finding 8 — a DECLINED appointment counted as a scorer.
//
// `fixtures.officials` is a READ CACHE rebuilt by `refreshOfficialsCache`
// (usecases/officials.ts) with NO response filter — a declined row stays in the
// aggregate carrying `response: 'declined'`. `officials.length > 0` therefore
// reads TRUE precisely when the person invited has said no, so ladder rule 5
// stops offering "Assign scorer" on the morning it matters most. The codebase
// already knows the difference: `officials.ts:170` joins
// `and fo.response <> 'declined'`.
//
// NOT covered by the ledger, which was the review's own open question:
// `division-phase`'s `hasScorer` is resolved from `fixture_officials` via the
// same `hasAssignedScorer` rule (competition-desk.ts), so the "Needs you"
// panel cannot cover for this row.
//
// The wire shape is `unknown[]`, so this reader is TOTAL: a malformed element
// must not throw a match-day render.
describe("hasAssignedScorer — the officials cache is response-bearing", () => {
  it("no appointments at all is no scorer", () => {
    expect(hasAssignedScorer([])).toBe(false);
  });

  it("an ACCEPTED appointment is a scorer", () => {
    expect(hasAssignedScorer([{ official_id: "o1", role: "scorer", response: "accepted" }])).toBe(true);
  });

  // The witness row. A fixture with one ACCEPTED official cannot see this bug.
  it("a DECLINED appointment is NOT a scorer — the row must keep nudging", () => {
    expect(hasAssignedScorer([{ official_id: "o1", role: "scorer", response: "declined" }])).toBe(false);
  });

  it("declined alongside accepted still counts — somebody is coming", () => {
    expect(
      hasAssignedScorer([
        { official_id: "o1", response: "declined" },
        { official_id: "o2", response: "accepted" },
      ]),
    ).toBe(true);
  });

  // `response` is nullable in `fixture_officials` (invited, not yet answered).
  // Absence of a refusal is not a refusal: an unanswered invite still means
  // somebody has been asked, which is what rule 5 is testing for.
  it.each([[{ official_id: "o1" }], [{ official_id: "o1", response: null }]])(
    "an appointment with no recorded response counts (%o)",
    (row) => {
      expect(hasAssignedScorer([row])).toBe(true);
    },
  );

  it.each([[null], [undefined], ["declined"], [42]])("a malformed element (%o) never throws", (row) => {
    expect(() => hasAssignedScorer([row])).not.toThrow();
  });

  // The seam: the derived boolean must flip the LADDER's answer, not just a
  // helper's return value. A fixture scheduled TODAY whose only official
  // declined is exactly the failure scenario.
  it("a fixture scheduled today whose only official declined still offers Assign scorer", () => {
    expect(
      fixtureRowAction({
        status: "scheduled",
        scheduledAt: TODAY_1500,
        hasOfficials: hasAssignedScorer([{ official_id: "o1", role: "scorer", response: "declined" }]),
        canEdit: true,
        tz: TZ,
        nowMs: NOW,
        awaitingDraw: false,
        awaitsSettle: false,
      }),
    ).toEqual({ kind: "assign_scorer" });
    // ...and the same row with an accepted official does NOT — the pair is what
    // proves the input is consulted rather than constant.
    expect(
      fixtureRowAction({
        status: "scheduled",
        scheduledAt: TODAY_1500,
        hasOfficials: hasAssignedScorer([{ official_id: "o1", response: "accepted" }]),
        canEdit: true,
        tz: TZ,
        nowMs: NOW,
        awaitingDraw: false,
        awaitsSettle: false,
      }),
    ).toEqual({ kind: "score" });
  });
});
