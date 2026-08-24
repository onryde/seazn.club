// candidate-courts.test.ts — P9 pass 2 (venues & courts -> scheduler): the
// pure candidate-court filter shared by BOTH the build-input assembly
// (apps/web usecases/schedule.ts) and the validate path
// (validateScheduleIn) — see candidate-courts.ts's own header for why this
// must stay the ONE copy (ruling 4, the placer/verifier fork this repo keeps
// re-deriving as a bug).
import { describe, expect, it } from "vitest";
import { candidateCourts, type CourtMeta } from "./candidate-courts.ts";
import {
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type VerifyConfig,
} from "./calendar.ts";

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

describe(
  "isBlockingConflict — court_tag_mismatch is REPORTED, never BLOCKING (review finding #10, ruling 3: " +
    "a required-tag change — or a hand-drag through moveFixture, which performs no tag check of its own — " +
    "must not retroactively hard-refuse a board that already exists)",
  () => {
    it("a court_tag_mismatch conflict is NOT blocking", () => {
      const conflict: Conflict = {
        fixtureId: "f1",
        reason: "court",
        details: { kind: "court_tag_mismatch", court: "clay-court" },
      };
      expect(isBlockingConflict(conflict)).toBe(false);
    });

    // The other half of the carve-out: narrowing `reason === "court"` must not
    // become a blanket weakening of every court conflict — a GENUINE double
    // booking (two fixtures, one court, overlapping time) is still a physical
    // impossibility and stays blocking exactly as before.
    it("a court_double_booking conflict sharing the SAME reason is still blocking", () => {
      const conflict: Conflict = {
        fixtureId: "f1",
        reason: "court",
        details: { kind: "court_double_booking", court: "clay-court" },
      };
      expect(isBlockingConflict(conflict)).toBe(true);
    });
  },
);

// --- #622: per-fixture required court tags (round-scoped) -------------------

describe(
  "validateAssignments — courtTagQualifiedIdsByFixture (#622: two rounds of ONE stage " +
    "requiring different courts, which a single division-wide list cannot express)",
  () => {
    // Each row gets its own hour, so a two-row board on ONE court reports the
    // tag mismatch alone rather than a court_double_booking pair on top of it
    // — this block is about the tag rule, and a clash would drown it.
    let nextSlot = 0;
    function assignment(fixtureId: string, court: string): Assignment {
      const startAt = nextSlot++ * 3_600_000;
      return { fixtureId, court, startAt, endAt: startAt + 30 * 60_000, entrants: [], people: [] };
    }

    it("judges each fixture against ITS OWN qualified set", () => {
      // The motivating shape: a semi-final may use any court, the final needs
      // the championship court. Before #622 the verifier held one list for the
      // whole division, so this was only expressible as the UNION of the two
      // (which lets the final sit on the ordinary court) or their INTERSECTION
      // (which reds the semi-final). Neither is the answer.
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIdsByFixture: new Map([
          ["semi", ["show-court", "court-2"]],
          ["final", ["show-court"]],
        ]),
      };
      const clean = validateAssignments(
        [assignment("semi", "court-2"), assignment("final", "show-court")],
        config,
        [],
        [],
      );
      expect(clean).toEqual([]);

      const dirty = validateAssignments(
        [assignment("semi", "court-2"), assignment("final", "court-2")],
        config,
        [],
        [],
      );
      expect(dirty).toEqual([
        {
          fixtureId: "final",
          reason: "court",
          details: { kind: "court_tag_mismatch", court: "court-2" },
          rule: "H2",
        },
      ]);
    });

    it("falls back to the flat division-wide list for a fixture the map does not name", () => {
      // An obstacle row from another division, or a fixture deleted between
      // the two reads `validateScheduleIn` makes. The flat field is what those
      // fall back to; it is not superseded by the map, it is the default.
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIds: ["show-court"],
        courtTagQualifiedIdsByFixture: new Map([["final", ["court-2"]]]),
      };
      const conflicts = validateAssignments(
        [assignment("stranger", "court-2"), assignment("final", "court-2")],
        config,
        [],
        [],
      );
      expect(conflicts).toEqual([
        {
          fixtureId: "stranger",
          reason: "court",
          details: { kind: "court_tag_mismatch", court: "court-2" },
          rule: "H2",
        },
      ]);
    });

    it("a per-fixture entry of [] reds every court, and is not confused with an absent entry", () => {
      // `[]` here means "no court qualifies" (the caller resolved a tag no
      // court carries), which is a real answer and NOT the "unconstrained"
      // reading an absent field gets. Getting these two the wrong way round is
      // the single failure mode that decides whether a board reports clean or
      // reds wholesale.
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIdsByFixture: new Map([["impossible", []]]),
      };
      expect(validateAssignments([assignment("impossible", "c1")], config, [], [])).toHaveLength(1);
      expect(validateAssignments([assignment("other", "c1")], config, [], [])).toEqual([]);
    });

    it("stays NON-BLOCKING, like every other court_tag_mismatch (ruling 3)", () => {
      // The per-fixture form must not smuggle in a new hard refusal: an
      // organiser who adds a round rule to a board that already exists has to
      // stay able to publish through acknowledge_warnings.
      const config: VerifyConfig = {
        perEntrantMinRest: 0,
        gapMinutes: 0,
        courtTagQualifiedIdsByFixture: new Map([["final", ["show-court"]]]),
      };
      const conflicts = validateAssignments([assignment("final", "court-2")], config, [], []);
      expect(conflicts).toHaveLength(1);
      expect(conflicts.every(isBlockingConflict)).toBe(false);
    });
  },
);

describe("slotFixtures — SchedulableFixture.allowedCourts (#622)", () => {
  const config = {
    startAt: 0,
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    courts: ["court-1", "court-2", "show-court"],
  };

  it("places a narrowed fixture only on a court it is allowed", () => {
    const { assignments } = slotFixtures({
      fixtures: [{ id: "final", home: "a", away: "b", allowedCourts: ["show-court"] }],
      config,
    });
    expect(assignments.map((a) => a.court)).toEqual(["show-court"]);
  });

  it("leaves an un-narrowed fixture on the organiser's own first court", () => {
    // Court ORDER is the organiser's preference (ruling 1), so the un-narrowed
    // case must still take `config.courts[0]` — proving the skip is a filter,
    // not a reordering.
    const { assignments } = slotFixtures({
      fixtures: [{ id: "qf", home: "a", away: "b" }],
      config,
    });
    expect(assignments.map((a) => a.court)).toEqual(["court-1"]);
  });

  it("reads an EMPTY allowedCourts as unconstrained, never as 'no court'", () => {
    // The one reading that decides whether an ordinary board places at all:
    // `[]` matches `candidateCourts`'s reading of an empty required-tag list
    // and the wire's reading of an empty `allowed_court_indices`.
    const { assignments } = slotFixtures({
      fixtures: [{ id: "qf", home: "a", away: "b", allowedCourts: [] }],
      config,
    });
    expect(assignments.map((a) => a.court)).toEqual(["court-1"]);
  });

  it("keeps two rounds of one stage apart on the same pass", () => {
    // #622's motivating case in the placer: the final is confined to the show
    // court while the semis are free, and all three still place.
    const { assignments } = slotFixtures({
      fixtures: [
        { id: "sf1", home: "a", away: "b" },
        { id: "sf2", home: "c", away: "d" },
        { id: "final", home: "e", away: "f", allowedCourts: ["show-court"] },
      ],
      config,
    });
    const byId = new Map(assignments.map((a) => [a.fixtureId, a.court]));
    expect(byId.size).toBe(3);
    expect(byId.get("final")).toBe("show-court");
  });

  it("honours a pin onto a court the fixture is NOT allowed (ruling 3)", () => {
    // An organiser's own lock outranks a tag rule: refusing it would make a
    // board they already published unrepresentable. The verifier reports it as
    // a non-blocking court_tag_mismatch instead, which is the tested behaviour
    // in the describe block above.
    const { assignments } = slotFixtures({
      fixtures: [
        {
          id: "final",
          home: "a",
          away: "b",
          allowedCourts: ["show-court"],
          locked: { court: "court-1", startAt: 0 },
        },
      ],
      config,
    });
    expect(assignments.map((a) => a.court)).toEqual(["court-1"]);
  });
});
