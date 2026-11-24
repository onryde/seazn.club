// The competition page's header and divisions list change shape once the competition is FINISHED (owner, Option 1): the
// finished divisions are listed, Registration and the Multi Schedule Board are gone, and "Add division" steps back to a quiet
// link. Separately - in BOTH phases - a completed or archived competition has no "Add division" at all (the server answers 409
// COMPETITION_ENDED). `deskChrome` is the one rule the async page reads, so it is reachable from a unit test.
import { describe, expect, it } from "vitest";
import { deskChrome } from "@/lib/competition-desk-chrome";
import type { CompetitionPillPhase } from "@/server/usecases/competition-desk";

// Exhaustive by construction: a Record over the union's own `kind`, so a new competition phase is a compile error here until it
// is placed, rather than a kind this sweep silently never judges.
const KIND_SET: Record<CompetitionPillPhase["kind"], true> = {
  in_play: true, match_day: true, next: true, finished: true, scheduled: true, setting_up: true,
};
const COMPETITION_PHASE_KINDS = Object.keys(KIND_SET);

const LIVE = { status: "live", canEdit: true, frozen: false } as const;

describe("deskChrome - empty / unknown first", () => {
  // TEST-STRATEGY: state the empty case first. A competition whose desk produced no phase (the summary failed) or whose phase is
  // `setting_up` because it has ZERO divisions is NOT finished - it keeps every tool and a primary "Add division".
  it("no phase (desk failed to load) is not finished: nothing is hidden", () => {
    expect(deskChrome({ ...LIVE, phaseKind: null })).toEqual({
      finished: false, showRegistration: true, showScheduleBoard: true, addDivision: "primary", ledgerListsFinished: false,
    });
  });
  it("a competition with no divisions reads setting_up: not finished, primary add", () => {
    const c = deskChrome({ ...LIVE, phaseKind: "setting_up" });
    expect(c.finished).toBe(false);
    expect(c.addDivision).toBe("primary");
  });
});

describe("deskChrome - finished competition", () => {
  const c = deskChrome({ ...LIVE, phaseKind: "finished" });
  it("hides Registration and the schedule board, lists finished divisions, demotes Add division", () => {
    expect(c).toEqual({
      finished: true, showRegistration: false, showScheduleBoard: false, addDivision: "quiet", ledgerListsFinished: true,
    });
  });
  it("only the finished phase changes the shape: every other competition phase keeps the full header", () => {
    const others = COMPETITION_PHASE_KINDS.filter((k) => k !== "finished");
    expect(others.length).toBeGreaterThan(0); // anti-vacuity
    for (const k of others) {
      expect(deskChrome({ ...LIVE, phaseKind: k }), k).toEqual({
        finished: false, showRegistration: true, showScheduleBoard: true, addDivision: "primary", ledgerListsFinished: false,
      });
    }
  });
  it("a view-only member sees no Add division, finished or not", () => {
    expect(deskChrome({ ...LIVE, canEdit: false, phaseKind: "finished" }).addDivision).toBe("none");
    expect(deskChrome({ ...LIVE, canEdit: false, phaseKind: "scheduled" }).addDivision).toBe("none");
  });
  it("a frozen competition offers no Add division (read-only), but still reads finished", () => {
    const f = deskChrome({ ...LIVE, frozen: true, phaseKind: "finished" });
    expect(f.addDivision).toBe("none");
    expect(f.finished).toBe(true);
  });
});

describe("deskChrome - an ended (completed/archived) competition has no Add division, in both phases", () => {
  it("every terminal status x every phase kind (and no phase) hides it", () => {
    let judged = 0;
    for (const status of ["completed", "archived"]) {
      for (const phaseKind of [...COMPETITION_PHASE_KINDS, null]) {
        expect(deskChrome({ status, canEdit: true, frozen: false, phaseKind }).addDivision, `${status}/${phaseKind}`).toBe("none");
        judged++;
      }
    }
    expect(judged).toBe(2 * (COMPETITION_PHASE_KINDS.length + 1));
  });
  it("a non-terminal status does not hide it (the pairing the negative needs)", () => {
    for (const status of ["draft", "published", "live"]) {
      expect(deskChrome({ status, canEdit: true, frozen: false, phaseKind: "scheduled" }).addDivision, status).toBe("primary");
      expect(deskChrome({ status, canEdit: true, frozen: false, phaseKind: "finished" }).addDivision, status).toBe("quiet");
    }
  });
});
