// candidate-courts.test.ts — P9 pass 2 (venues & courts -> scheduler): the
// pure candidate-court filter shared by BOTH the build-input assembly
// (apps/web usecases/schedule.ts) and the validate path
// (validateScheduleIn) — see candidate-courts.ts's own header for why this
// must stay the ONE copy (ruling 4, the placer/verifier fork this repo keeps
// re-deriving as a bug).
import { describe, expect, it } from "vitest";
import { candidateCourts, type CourtMeta } from "./candidate-courts.ts";
import { validateAssignments, type Assignment, type VerifyConfig } from "./calendar.ts";

function meta(id: string, tags: string[], archived = false): CourtMeta {
  return { id, tags, archived };
}

describe("candidateCourts — tag subset filter (design doc: tags ⊇ required)", () => {
  it("a court whose tags are a SUPERSET of required qualifies", () => {
    const out = candidateCourts(["c1"], [meta("c1", ["clay", "indoor", "lit"])], ["clay", "indoor"]);
    expect(out.ids).toEqual(["c1"]);
  });

  it("a court whose tags EXACTLY match required qualifies", () => {
    const out = candidateCourts(["c1"], [meta("c1", ["clay", "indoor"])], ["clay", "indoor"]);
    expect(out.ids).toEqual(["c1"]);
  });

  it("a court missing ONE required tag is excluded", () => {
    const out = candidateCourts(["c1"], [meta("c1", ["clay"])], ["clay", "indoor"]);
    expect(out.ids).toEqual([]);
  });

  it("empty required tags qualifies every configured, non-archived court", () => {
    const out = candidateCourts(
      ["c1", "c2"],
      [meta("c1", []), meta("c2", ["clay"])],
      [],
    );
    expect(out.ids).toEqual(["c1", "c2"]);
  });

  it("a duplicate tag ON THE COURT does not change qualification", () => {
    const out = candidateCourts(["c1"], [meta("c1", ["clay", "clay", "indoor"])], ["clay"]);
    expect(out.ids).toEqual(["c1"]);
  });

  it("tag matching is case-sensitive — slugs arrive already lowercase; this fn never folds case", () => {
    const out = candidateCourts(["c1"], [meta("c1", ["clay"])], ["Clay"]);
    expect(out.ids).toEqual([]);
  });
});

describe("candidateCourts — id→index mapping (ruling 1: position in config.courts, never sorted by id)", () => {
  it("candidate order follows the CONFIGURED array's position, not the id's own sort order", () => {
    const out = candidateCourts(["zzz", "aaa"], [meta("zzz", []), meta("aaa", [])], []);
    expect(out.ids).toEqual(["zzz", "aaa"]);
    expect(out.indexOf.get("zzz")).toBe(0);
    expect(out.indexOf.get("aaa")).toBe(1);
  });

  it("the same configured array always yields the same indices (deterministic)", () => {
    const courts = [meta("a", []), meta("b", []), meta("c", [])];
    const out1 = candidateCourts(["a", "b", "c"], courts, []);
    const out2 = candidateCourts(["a", "b", "c"], courts, []);
    expect([...out1.indexOf.entries()]).toEqual([...out2.indexOf.entries()]);
    expect(out1.indexOf.get("a")).toBe(0);
    expect(out1.indexOf.get("b")).toBe(1);
    expect(out1.indexOf.get("c")).toBe(2);
  });

  it("filtering a court out removes it WITHOUT reordering the survivors", () => {
    // b lacks the required tag the other two carry -> excluded; a and c
    // survive IN ORDER, closing up the gap rather than leaving it.
    const courts = [meta("a", ["clay"]), meta("b", []), meta("c", ["clay"])];
    const out = candidateCourts(["a", "b", "c"], courts, ["clay"]);
    expect(out.ids).toEqual(["a", "c"]);
    expect(out.indexOf.get("a")).toBe(0);
    expect(out.indexOf.get("c")).toBe(1);
    expect(out.indexOf.has("b")).toBe(false);
  });

  it("a duplicate id in the configured array collapses to its FIRST occurrence's index", () => {
    const courts = [meta("a", []), meta("b", [])];
    const out = candidateCourts(["a", "b", "a"], courts, []);
    expect(out.ids).toEqual(["a", "b"]);
    expect(out.indexOf.get("a")).toBe(0);
    expect(out.indexOf.get("b")).toBe(1);
  });

  it("a configured id with no matching court row (deleted?) is silently excluded", () => {
    const out = candidateCourts(["ghost", "a"], [meta("a", [])], []);
    expect(out.ids).toEqual(["a"]);
  });
});

describe("candidateCourts — archived exclusion (design doc A3: archived venues AND courts drop out)", () => {
  it("an archived court is excluded from candidates even when its tags match", () => {
    const out = candidateCourts(["a", "b"], [meta("a", [], true), meta("b", [], false)], []);
    expect(out.ids).toEqual(["b"]);
  });

  it(
    "archiving a court excludes it from FUTURE candidates but does not retroactively invalidate an " +
      "EXISTING assignment already sitting on it — validateAssignments never consults candidate-set " +
      "membership, so a court double-booking pass stays clean (ruling 3)",
    () => {
      const courts = [meta("archived-court", [], true)];
      const candidates = candidateCourts(["archived-court"], courts, []);
      expect(candidates.ids).toEqual([]); // excluded for NEW placement

      const assignment: Assignment = {
        fixtureId: "f1",
        court: "archived-court",
        startAt: 0,
        endAt: 30 * 60_000,
        entrants: [],
        people: [],
      };
      const config: VerifyConfig = { perEntrantMinRest: 0, gapMinutes: 0 };
      const conflicts = validateAssignments([assignment], config, [], []);
      expect(conflicts).toEqual([]);
    },
  );
});

describe(
  "validateAssignments — court_tag_mismatch (P9 pass 2c: the verifier's own view of the placer's " +
    "required_court_tags constraint — the placer/verifier fork this session's court-tags work " +
    "introduced, candidate-courts.ts's module header)",
  () => {
    function assignment(court: string): Assignment {
      return { fixtureId: "f1", court, startAt: 0, endAt: 30 * 60_000, entrants: [], people: [] };
    }

    it("an assignment on a court missing a required tag produces court_tag_mismatch, keyed on court_id", () => {
      // "clay-court" is simply absent from the qualified set a real caller
      // would have computed (it lacks the required tag) — courtTagQualifiedIds
      // carries only what candidateCourts decided qualifies.
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIds: [],
      };
      const conflicts = validateAssignments([assignment("clay-court")], config, [], []);
      // `rule: "H2"` is `withRule`'s own stamp (RULE_BY_REASON.court === "H2"),
      // applied generically by REASON at the end of validateAssignments — the
      // same rule code court_double_booking carries, since both share
      // `reason: "court"` (this file's own note on reusing the coarse reason
      // while `kind` carries the fine-grained identity).
      expect(conflicts).toEqual([
        {
          fixtureId: "f1",
          reason: "court",
          details: { kind: "court_tag_mismatch", court: "clay-court" },
          rule: "H2",
        },
      ]);
    });

    it("an assignment on a court whose tags ARE a superset of required does not produce it", () => {
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIds: ["clay-court"],
      };
      const conflicts = validateAssignments([assignment("clay-court")], config, [], []);
      expect(conflicts).toEqual([]);
    });

    it("empty required tags never produce it — proven through the REAL candidateCourts computation, not a hand-built set", () => {
      // A division with no required_court_tags: candidateCourts([], []) reads
      // as "every court qualifies" (candidate-courts.ts ruling 2), which
      // resolveTagQualifiedCourtIds (court-candidates.ts) hands straight
      // through as courtTagQualifiedIds — this is that real computation, not
      // an array asserted by hand.
      const courts: CourtMeta[] = [meta("c1", [])];
      const qualified = candidateCourts(["c1"], courts, []).ids;
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIds: qualified,
      };
      const conflicts = validateAssignments([assignment("c1")], config, [], []);
      expect(conflicts).toEqual([]);
    });

    it("courtTagQualifiedIds entirely absent (every pre-pass-2c caller) never produces it — unconstrained, not zero-qualified", () => {
      const config: VerifyConfig = { perEntrantMinRest: 0, gapMinutes: 0 };
      const conflicts = validateAssignments([assignment("any-court")], config, [], []);
      expect(conflicts).toEqual([]);
    });

    it(
      "an assignment on an ARCHIVED court whose tags satisfy the requirement produces NO conflict " +
        "(ruling 3: archiving must not retroactively invalidate a board) — using the SAME " +
        "archived-neutralising resolution resolveTagQualifiedCourtIds (court-candidates.ts) performs",
      () => {
        const courts: CourtMeta[] = [meta("c1", ["clay"], /* archived */ true)];
        // Mirrors resolveTagQualifiedCourtIds exactly: archived neutralised to
        // false so ONLY the tag comparison governs this conflict — the
        // combined (tag+archived) candidateCourts answer used for
        // config.courts/NEW placement is deliberately NOT what this reads.
        const tagOnly = courts.map((c) => ({ ...c, archived: false }));
        const qualified = candidateCourts(
          tagOnly.map((c) => c.id),
          tagOnly,
          ["clay"],
        ).ids;
        const config: VerifyConfig = {
          perEntrantMinRest: 0,
          gapMinutes: 0,
          courtTagQualifiedIds: qualified,
        };
        const conflicts = validateAssignments([assignment("c1")], config, [], []);
        expect(conflicts).toEqual([]);
      },
    );
  },
);
