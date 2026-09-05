// Schema-level regression tests (no DB) for the entrant/team contract added
// with the unified Add-Entrant + team-squad work.
import { describe, expect, it } from "vitest";
import {
  AppendEventRequest,
  ApplyScheduleRequest,
  CapacityPrecheck,
  CreateClubContact,
  CreateCompetition,
  CreateDivision,
  CreateEntrant,
  CreateStage,
  CreateTeam,
  Division,
  EligibilityOverride,
  EventImportRequest,
  LineupSlotInput,
  PatchCompetition,
  PatchDivision,
  PatchEntrant,
  PatchFixture,
  PutRegistrationSettings,
  RestoreCompetitionScheduleResult,
  SetTeamSquad,
} from "../schemas";

const UUID = "11111111-1111-4111-8111-111111111111";
/** A SECOND id, so a two-division payload cannot pass by echoing the first. */
const UUID2 = "22222222-2222-4222-8222-222222222222";

describe("CreateEntrant", () => {
  it("accepts display_name without team_id", () => {
    expect(CreateEntrant.safeParse({ kind: "individual", display_name: "A" }).success).toBe(true);
  });

  it("accepts team_id without display_name (server snapshots the name)", () => {
    expect(CreateEntrant.safeParse({ kind: "team", team_id: UUID }).success).toBe(true);
  });

  it("rejects when BOTH display_name and team_id are absent", () => {
    const r = CreateEntrant.safeParse({ kind: "individual" });
    expect(r.success).toBe(false);
  });

  it("accepts an optional copy_roster_from_entrant_id", () => {
    const r = CreateEntrant.safeParse({ kind: "team", team_id: UUID, copy_roster_from_entrant_id: UUID });
    expect(r.success).toBe(true);
  });
});

describe("CreateTeam", () => {
  it("requires a name", () => {
    expect(CreateTeam.safeParse({ name: "Riverside U12" }).success).toBe(true);
    expect(CreateTeam.safeParse({ name: "" }).success).toBe(false);
    expect(CreateTeam.safeParse({}).success).toBe(false);
  });
});

describe("CreateClubContact", () => {
  it("accepts a valid contact with a well-formed email", () => {
    expect(
      CreateClubContact.safeParse({ role_key: "secretary", full_name: "X", email: "sec@club.test" })
        .success,
    ).toBe(true);
  });

  it("rejects a malformed email at the edge (400, not a DB round-trip)", () => {
    const r = CreateClubContact.safeParse({
      role_key: "secretary",
      full_name: "X",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "email")).toBe(true);
    }
  });
});

describe("SetTeamSquad", () => {
  it("defaults members to an empty array", () => {
    const r = SetTeamSquad.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.members).toEqual([]);
  });

  it("accepts squad members in the entrant-member shape", () => {
    const r = SetTeamSquad.safeParse({
      members: [{ person_id: UUID, squad_number: 7, is_captain: true, roles: ["captain"] }],
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateStage.progression (F2 — unified field, replaces .qualification/.seeding)", () => {
  // F2 collapsed the two prior vocabularies (topN/bestOfRank/losersOfRound/
  // take+combine, and rankRange/topNPerGroup/bestNth/source+placement+map)
  // onto one `progression` field: { sources: [{stage,take}], placement,
  // map?, timing }. Full ProgressionSchema branch coverage (every take-rule
  // kind, every rejection path, with issue codes) lives in the dedicated
  // progression-schema.test.ts; these assertions only pin that CreateStage
  // wires the field through correctly (name, nullish, pass-through parse).
  const stage = (progression: unknown) => ({ seq: 2, kind: "knockout", name: "KO", progression });
  const source = (take: unknown) => ({ sources: [{ stage: "previous", take: [take] }], placement: "rank_order", timing: "on_complete" });

  it("accepts each of the five take-rule kinds, and a multi-source progression", () => {
    expect(CreateStage.safeParse(stage(source({ kind: "rankRange", from: 1, to: 4 }))).success).toBe(true);
    expect(CreateStage.safeParse(stage(source({ kind: "topNPerGroup", n: 2 }))).success).toBe(true);
    expect(
      CreateStage.safeParse(stage(source({ kind: "bestNth", nth: 3, count: 8, normaliseUnequalPools: true })))
        .success,
    ).toBe(true);
    expect(CreateStage.safeParse(stage(source({ kind: "picks", picks: [{ pool: "A", rank: 1 }] }))).success).toBe(
      true,
    );
    expect(
      CreateStage.safeParse(stage(source({ kind: "roundLosers", round: 1, count: 4 }))).success,
    ).toBe(true);
    // Multi-source — the capability the old `.qualification.combine`/`.from`
    // never actually resolved server-side (F2 plan Finding 1); dedupe is
    // enforced at resolveProgression, not at parse time.
    expect(
      CreateStage.safeParse(
        stage({
          sources: [
            { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
            { stage: { stageId: "11111111-1111-4111-8111-111111111111" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
          ],
          placement: "rank_order",
          timing: "on_complete",
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts null/absent progression", () => {
    expect(CreateStage.safeParse(stage(null)).success).toBe(true);
    expect(CreateStage.safeParse({ seq: 1, kind: "league", name: "L" }).success).toBe(true);
  });

  it("rejects malformed progressions at the edge (400, not deep engine throw)", () => {
    expect(CreateStage.safeParse(stage({ bogus: 1 })).success).toBe(false);
    expect(CreateStage.safeParse(stage(source({ kind: "picks", picks: [{ pool: "A" }] }))).success).toBe(false); // missing rank
    expect(CreateStage.safeParse(stage(source({ kind: "rankRange", from: 4, to: 1 }))).success).toBe(false); // to < from
    expect(CreateStage.safeParse(stage({ sources: [], placement: "rank_order", timing: "on_complete" })).success).toBe(
      false,
    ); // min 1 source
    // count is REQUIRED (engine progressionSize reads it unconditionally) —
    // a mismatch here is a runtime 500 nobody can debug otherwise.
    expect(CreateStage.safeParse(stage(source({ kind: "roundLosers", round: 1 }))).success).toBe(false);
    expect(CreateStage.safeParse(stage(source({ kind: "roundLosers", round: 0, count: 1 }))).success).toBe(false);
    // timing is required, no default (ruling 5).
    expect(
      CreateStage.safeParse(
        stage({ sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order" }),
      ).success,
    ).toBe(false);
  });
});

describe("CreateStage — .strict() (F2 Task 5): a legacy key is REJECTED, not silently dropped", () => {
  // Before this task, CreateStage was a plain z.object — an unknown key (the
  // old .qualification/.seeding shape, or any typo) parsed successfully with
  // the key silently STRIPPED: stages-panel.tsx's live "Add stage" POST
  // (qualification: {topN}) created a stage with progression: null, returned
  // 201, and generated nobody — no error, no log, ever. `.strict()` converts
  // that whole class of bug from silent to loud: the same POST now 400s,
  // naming the offending key, so a test (and an organiser's error toast) can
  // actually catch it.
  it("rejects a body carrying the legacy qualification key, naming it in the issue", () => {
    const r = CreateStage.safeParse({
      seq: 2,
      kind: "knockout",
      name: "KO",
      qualification: { topN: 4 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(issue, "expected an unrecognized_keys issue, not just any failure").toBeDefined();
      expect((issue as { keys: string[] }).keys).toContain("qualification");
    }
  });

  it("rejects the legacy seeding key the same way", () => {
    const r = CreateStage.safeParse({
      seq: 2,
      kind: "knockout",
      name: "KO",
      seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }], placement: "rank_order" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.code === "unrecognized_keys");
      expect((issue as { keys: string[] } | undefined)?.keys).toContain("seeding");
    }
  });

  it("still accepts a well-formed progression body — strict rejects unknown keys, not known ones", () => {
    const r = CreateStage.safeParse({
      seq: 2,
      kind: "knockout",
      name: "KO",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "on_complete",
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateEntrant.members — inline new persons (PROMPT-60 §2)", () => {
  it("accepts a mix of person_id and new_person members", () => {
    const r = CreateEntrant.safeParse({
      kind: "team",
      display_name: "Mexico",
      members: [
        { person_id: UUID, squad_number: 1 },
        { new_person: { full_name: "Striker Nine" }, squad_number: 9 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a member with neither person_id nor new_person, and >40 members", () => {
    expect(
      CreateEntrant.safeParse({
        kind: "team", display_name: "X", members: [{ squad_number: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CreateEntrant.safeParse({
        kind: "team", display_name: "X",
        members: Array.from({ length: 41 }, (_, i) => ({ new_person: { full_name: `P${i}` } })),
      }).success,
    ).toBe(false);
  });

  it("accepts badge_url on create and PATCH (nullable to clear)", () => {
    expect(
      CreateEntrant.safeParse({
        kind: "individual", display_name: "Solo", badge_url: "https://flags.example/x.png",
      }).success,
    ).toBe(true);
    expect(PatchEntrant.safeParse({ badge_url: null }).success).toBe(true);
    expect(PatchEntrant.safeParse({ badge_url: "entrant-badges/a.png" }).success).toBe(true);
  });
});

// #376: a competition with no end date can never reach the `past_ends_on`
// pass lock, and holds a `competitions.max_active` slot forever. The date is
// therefore mandatory at create, and — the half that actually closes the
// evasion — non-removable at edit: an org must not be able to PATCH it back
// to null and drop out of the lock again.
describe("competition end date is mandatory and non-removable (#376)", () => {
  const base = { name: "Summer Cup", starts_on: "2026-06-01" };
  const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
    r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join("."));

  it("rejects a create with no ends_on at all", () => {
    const r = CreateCompetition.safeParse({ ...base });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("rejects a create that sends ends_on: null", () => {
    const r = CreateCompetition.safeParse({ ...base, ends_on: null });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("accepts a create with a well-formed ends_on", () => {
    const r = CreateCompetition.safeParse({ ...base, ends_on: "2026-08-31" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ends_on).toBe("2026-08-31");
  });

  it("rejects a PATCH that clears ends_on to null", () => {
    const r = PatchCompetition.safeParse({ ends_on: null });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("still accepts a PATCH that CHANGES ends_on to another date", () => {
    const r = PatchCompetition.safeParse({ ends_on: "2027-01-15" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ends_on).toBe("2027-01-15");
  });

  it("still accepts a PATCH that omits ends_on entirely (the field stays optional to send)", () => {
    expect(PatchCompetition.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("still accepts a PATCH that clears starts_on — only the END date is protected", () => {
    expect(PatchCompetition.safeParse({ starts_on: null }).success).toBe(true);
  });
});

describe("competition ends_on >= starts_on (#376)", () => {
  it("rejects a create whose end date precedes its start date", () => {
    const r = CreateCompetition.safeParse({
      name: "Backwards", starts_on: "2026-06-01", ends_on: "2026-05-31",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "ends_on");
      expect(issue?.message).toBe("The end date cannot be before the start date.");
    }
  });

  it("accepts a single-day competition (ends_on === starts_on)", () => {
    expect(
      CreateCompetition.safeParse({ name: "One Day", starts_on: "2026-06-01", ends_on: "2026-06-01" })
        .success,
    ).toBe(true);
  });

  it("accepts a create with no starts_on — there is nothing to compare against", () => {
    expect(CreateCompetition.safeParse({ name: "Open Ended", ends_on: "2026-06-01" }).success).toBe(
      true,
    );
  });

  it("rejects a PATCH that moves ends_on before the starts_on in the SAME patch", () => {
    const r = PatchCompetition.safeParse({ starts_on: "2026-06-01", ends_on: "2026-05-31" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "ends_on")).toBe(true);
    }
  });

  it("accepts a PATCH carrying only one of the two dates", () => {
    expect(PatchCompetition.safeParse({ ends_on: "2020-01-01" }).success).toBe(true);
    expect(PatchCompetition.safeParse({ starts_on: "2030-01-01" }).success).toBe(true);
  });
});

// S7/#427 (#431 item 8) — a tally-settled `generic.result` is the EMPTY object:
// no winnerId, no scores, no isDraw, "settle from whatever the running tally
// says" (generic.ts's `applyResult`, and padSpec's own `settleFromTally`
// action). The acceptance line asks that client validation accept it.
//
// FINDING: no client-side or api-v1 payload validation exists to relax.
// `AppendEventRequest.payload` is `z.unknown()` and the v2 pad chassis posts
// the raw object (`components/v2/scorepad/use-pad-pipeline.ts`'s `submit`,
// via `transport.ts`), so the engine is the only validator — the payload
// shape crosses this boundary untouched. That is the
// right design here (one validator, in the engine, that the fold and the API
// cannot disagree about) and nothing was changed.
//
// What this test IS: the tripwire for the S4-shaped defect on the OTHER side.
// S4's own unplanned fix this same programme was a plain `z.object` in this
// file silently STRIPPING an unrecognised key instead of accepting it. If a
// later wave narrows `payload` to a `z.object` union to "improve" the API,
// `{}` is exactly the shape it will most easily drop or reject, and it would
// do so silently — a tally-settled result would just stop arriving.
describe("AppendEventRequest passes an event payload through untouched (#427)", () => {
  const base = { expected_seq: 3, type: "generic.result" };

  it("accepts a bare {} payload and keeps the key", () => {
    const r = AppendEventRequest.safeParse({ ...base, payload: {} });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.prototype.hasOwnProperty.call(r.data, "payload")).toBe(true);
      expect(r.data.payload).toEqual({});
    }
  });

  it("strips nothing from a populated payload, including keys no schema names", () => {
    // A narrowing `z.object` would drop `fielderAssist`/`incoming` (S7's own
    // new wicket prompts) exactly as S4's did — same defect, same silence.
    const payload = { wicket: { kind: "runout", fielderAssist: "p7", incoming: "p9" }, runs: { bat: 1 } };
    const r = AppendEventRequest.safeParse({ ...base, type: "cricket.ball", payload });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payload).toEqual(payload);
  });

  it("still rejects a request missing the envelope fields it DOES own", () => {
    // Vacuity guard: a schema that accepted everything would pass both cases
    // above while validating nothing.
    expect(AppendEventRequest.safeParse({ type: "generic.result", payload: {} }).success).toBe(false);
    expect(AppendEventRequest.safeParse({ expected_seq: 3, payload: {} }).success).toBe(false);
    expect(AppendEventRequest.safeParse({ ...base, payload: {}, expected_seq: -1 }).success).toBe(false);
  });
});

describe("division tiebreakers are validated keys (F5)", () => {
  it("accepts the expanded fifa2026 cascade, rejects the preset NAME", () => {
    const good = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
    expect(
      CreateDivision.safeParse({
        name: "Open", sport_key: "football", variant_key: "std", tiebreakers: good,
      }).success,
    ).toBe(true);
    expect(
      CreateDivision.safeParse({
        name: "Open", sport_key: "football", variant_key: "std", tiebreakers: ["fifa2026"],
      }).success,
    ).toBe(false); // silent seed-order standings, never again
  });
});

// RS007/V380: the wizard's Eligibility tab used to POST a jsonb `eligibility`
// array CreateDivision never declared — a NON-strict z.object, so zod parsed
// successfully and silently DROPPED it, and every wizard-created division
// shipped with no restriction at all. These columns are the replacement; the
// regression this guards is exactly that silent strip, so every "accepts"
// assertion below checks the PARSED value, not just `.success` (a schema
// that still doesn't know a field would report `.success: true` on the rest
// of an otherwise-valid payload too).
describe("CreateDivision — eligibility columns (RS007 wizard rewire)", () => {
  const base = { name: "Open", sport_key: "football", variant_key: "std" };

  it("accepts and RETAINS category/age_max/age_cutoff_month/age_cutoff_day/eligibility_note", () => {
    const r = CreateDivision.safeParse({
      ...base,
      category: "mens",
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.category).toBe("mens");
      expect(r.data.age_max).toBe(15);
      expect(r.data.age_cutoff_month).toBe(9);
      expect(r.data.age_cutoff_day).toBe(1);
      expect(r.data.eligibility_note).toBe("School-registered students only");
    }
  });

  it("every eligibility field is optional — a create naming none of them still parses (no restriction)", () => {
    const r = CreateDivision.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.category).toBeUndefined();
      expect(r.data.age_max).toBeUndefined();
    }
  });

  it("rejects an unknown category value", () => {
    expect(CreateDivision.safeParse({ ...base, category: "u12" }).success).toBe(false);
  });

  it("rejects age_max less than age_min — the SAME checkAgeBand refine PatchDivision uses", () => {
    const r = CreateDivision.safeParse({ ...base, age_min: 12, age_max: 8 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "age_max")).toBe(true);
    }
  });

  it("rejects a cutoff month without its day — the SAME checkAgeCutoff refine PatchDivision uses", () => {
    const r = CreateDivision.safeParse({ ...base, age_cutoff_month: 9 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "age_cutoff_day")).toBe(true);
    }
  });

  // RS007 review fix L1: age_cutoff_day was validated only as 1-31 (this
  // schema's own min/max above, and the divisions_age_cutoff_check DB
  // constraint), so 31 September or 30 February parsed successfully and
  // silently rolled over a month later at read time
  // (ageBandEligibilityIssues, @/lib/registration-rules — `new
  // Date(Date.UTC(...))` normalises an out-of-range day). Reject the
  // impossible combination HERE, at write time, so the organiser sees it
  // immediately instead of eligibility silently shifting by days.
  it("rejects a cutoff day that does not exist in its month (RS007 review fix L1)", () => {
    const thirtyOneSept = CreateDivision.safeParse({ ...base, age_cutoff_month: 9, age_cutoff_day: 31 });
    expect(thirtyOneSept.success).toBe(false);
    if (!thirtyOneSept.success) {
      expect(thirtyOneSept.error.issues.some((i) => i.path.join(".") === "age_cutoff_day")).toBe(true);
    }
    const thirtyFeb = CreateDivision.safeParse({ ...base, age_cutoff_month: 2, age_cutoff_day: 30 });
    expect(thirtyFeb.success).toBe(false);
    // 29 February is ALSO rejected, deliberately — it IS a real calendar
    // date, but only in a leap year, and this same month/day pair is
    // re-evaluated every season against a DIFFERENT seasonStartYear
    // (ageBandEligibilityIssues anchors at cutoffMonth/cutoffDay of
    // whatever season is being checked). A leap-only cutoff would still
    // silently roll over into 1 March in three years out of four — capping
    // February at 28 here guarantees whatever passes is valid for EVERY
    // year, not just some.
    const leapDay = CreateDivision.safeParse({ ...base, age_cutoff_month: 2, age_cutoff_day: 29 });
    expect(leapDay.success).toBe(false);
  });

  it("accepts every genuinely valid day-of-month boundary", () => {
    // September genuinely has 30 days.
    expect(CreateDivision.safeParse({ ...base, age_cutoff_month: 9, age_cutoff_day: 30 }).success).toBe(true);
    // January genuinely has 31.
    expect(CreateDivision.safeParse({ ...base, age_cutoff_month: 1, age_cutoff_day: 31 }).success).toBe(true);
    // February's cap (see the leap-year note above).
    expect(CreateDivision.safeParse({ ...base, age_cutoff_month: 2, age_cutoff_day: 28 }).success).toBe(true);
  });
});

// RS011 review fix 6: every `entrants-eligibility.test.ts` case calls the
// usecase functions directly, bypassing Zod entirely — a future
// `min(3)`→`min(4)` (or `max(500)`→`max(50)`) typo in `EligibilityOverride`
// (schemas.ts) would go uncaught by any DB test. This pins the boundary
// through the ACTUAL schema, the way every other write-body test in this
// file does.
describe("EligibilityOverride — reason length boundary (RS011 review fix 6)", () => {
  it("accepts exactly 3 characters (the minimum)", () => {
    expect(EligibilityOverride.safeParse({ reason: "abc" }).success).toBe(true);
  });

  it("rejects 2 characters — one under the minimum", () => {
    expect(EligibilityOverride.safeParse({ reason: "ab" }).success).toBe(false);
  });

  it("accepts exactly 500 characters (the maximum)", () => {
    expect(EligibilityOverride.safeParse({ reason: "x".repeat(500) }).success).toBe(true);
  });

  it("rejects 501 characters — one over the maximum", () => {
    expect(EligibilityOverride.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
});

// S12/#421 pass D, V361 — `pair_order` mirrors `order_no`'s own convention
// exactly (`.nullish()`, not `.default()`): optional on the inferred
// PutLineup TS type so every pre-existing caller that builds a slots array
// without it keeps compiling.
describe("LineupSlotInput.pair_order (S12/#421 pass D)", () => {
  const base = { person_id: UUID };

  it("accepts a positive integer", () => {
    expect(LineupSlotInput.safeParse({ ...base, pair_order: 1 }).success).toBe(true);
    expect(LineupSlotInput.safeParse({ ...base, pair_order: 2 }).success).toBe(true);
  });

  it("accepts null and an absent key — both mean 'no declared order'", () => {
    expect(LineupSlotInput.safeParse({ ...base, pair_order: null }).success).toBe(true);
    const r = LineupSlotInput.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pair_order).toBeUndefined();
  });

  it("rejects zero, negative and non-integer values", () => {
    expect(LineupSlotInput.safeParse({ ...base, pair_order: 0 }).success).toBe(false);
    expect(LineupSlotInput.safeParse({ ...base, pair_order: -1 }).success).toBe(false);
    expect(LineupSlotInput.safeParse({ ...base, pair_order: 1.5 }).success).toBe(false);
  });
});

// P9 pass 3a — venues/courts cutover, FULL (not a compatibility shim): the
// legacy free-text `court_label`/`venue` fields leave the wire entirely.
// `.strict()` on both schemas below turns a stale client's old field name
// into a loud 400 instead of a silently-stripped-then-empty-patch no-op.
describe("PatchFixture (P9 pass 3a — venues/courts cutover)", () => {
  const COURT_ID = "22222222-2222-4222-8222-222222222222";
  const VENUE_ID = "33333333-3333-4333-8333-333333333333";

  it("accepts court_id and venue_id", () => {
    const r = PatchFixture.safeParse({ court_id: COURT_ID, venue_id: VENUE_ID });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.court_id).toBe(COURT_ID);
      expect(r.data.venue_id).toBe(VENUE_ID);
    }
  });

  it("accepts a null court_id/venue_id — clearing a fixture's court/venue", () => {
    expect(PatchFixture.safeParse({ court_id: null, venue_id: null }).success).toBe(true);
  });

  it("rejects the retired court_label / venue field names — gone from the wire, not silently ignored", () => {
    expect(PatchFixture.safeParse({ court_label: "Court 1" }).success).toBe(false);
    expect(PatchFixture.safeParse({ venue: "Main venue" }).success).toBe(false);
    // Mixed with an otherwise-valid field: a non-strict schema would silently
    // strip court_label and pass on scheduled_at alone. This must still 400.
    expect(
      PatchFixture.safeParse({ scheduled_at: "2026-08-20T09:00:00.000Z", court_label: "Court 1" }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid court_id — a real courts.id now, never a free-text label", () => {
    expect(PatchFixture.safeParse({ court_id: "Court 1" }).success).toBe(false);
  });
});

describe("ApplyScheduleRequest (P9 pass 3a — venues/courts cutover)", () => {
  const base = { fixture_id: UUID, scheduled_at: "2026-08-20T09:00:00.000Z" };
  const COURT_ID = "22222222-2222-4222-8222-222222222222";

  it("accepts an assignment with court_id, optional venue_id", () => {
    expect(ApplyScheduleRequest.safeParse({ assignments: [{ ...base, court_id: COURT_ID }] }).success).toBe(
      true,
    );
    expect(
      ApplyScheduleRequest.safeParse({
        assignments: [{ ...base, court_id: COURT_ID, venue_id: "33333333-3333-4333-8333-333333333333" }],
      }).success,
    ).toBe(true);
  });

  it("requires court_id — an assignment naming no court is not a valid placement", () => {
    expect(ApplyScheduleRequest.safeParse({ assignments: [base] }).success).toBe(false);
  });

  it("rejects an assignment carrying the retired court_label field", () => {
    expect(
      ApplyScheduleRequest.safeParse({ assignments: [{ ...base, court_label: "Court 1" }] }).success,
    ).toBe(false);
  });
});

// Review finding 3 (resource exhaustion): `window: {from, to}` carried no span
// bound — combined with `courts.max(50)` and calendarDays' own 4000-day
// internal ceiling (capacity-input.ts), an authenticated POST could force
// ~200k usableWindows calls, each intersecting up to 200 session windows and
// 200 blackouts. Bounded to 365 days here (the same horizon this repo's
// engine already treats as a schedule's default span —
// `calendar.ts`'s `horizonMinutes ?? 365 * 24 * 60`) so an over-large window
// is a clear 400, never a silently-truncated, still-expensive 200.
describe("CapacityPrecheck.config.window (review finding 3 — resource exhaustion)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const YEAR_MS = 365 * DAY_MS;
  const baseConfig = (window?: { from: number; to: number }) => ({
    fixtures: [],
    config: {
      courts: [],
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      ...(window !== undefined ? { window } : {}),
    },
  });

  it("accepts a window with no span bound violation (exactly 365 days)", () => {
    expect(baseConfig({ from: 0, to: YEAR_MS }).config.window).toBeDefined();
    expect(CapacityPrecheck.safeParse(baseConfig({ from: 0, to: YEAR_MS })).success).toBe(true);
  });

  it("rejects a window spanning more than 365 days", () => {
    expect(CapacityPrecheck.safeParse(baseConfig({ from: 0, to: YEAR_MS + DAY_MS })).success).toBe(false);
  });

  it("accepts a request with no window at all — the bound applies only when a window is sent", () => {
    expect(CapacityPrecheck.safeParse(baseConfig()).success).toBe(true);
  });
});

// RS004: organiser-facing API for the five V364 eligibility/approval
// columns RS001/RS002 added to the schema but never wired to a request/
// response shape. Validation-only (no DB round trip — see
// division-settings.test.ts for the persisted-value assertions).
describe("PatchDivision (RS004 eligibility columns)", () => {
  it("accepts a valid category", () => {
    expect(PatchDivision.safeParse({ category: "mens" }).success).toBe(true);
    expect(PatchDivision.safeParse({ category: "womens" }).success).toBe(true);
    expect(PatchDivision.safeParse({ category: "mixed" }).success).toBe(true);
    expect(PatchDivision.safeParse({ category: "open" }).success).toBe(true);
  });

  it("accepts a null category (clears back to open)", () => {
    expect(PatchDivision.safeParse({ category: null }).success).toBe(true);
  });

  it("rejects an unknown category value", () => {
    // A companion valid field keeps the patch non-empty regardless of how
    // `category` itself is handled — isolates THIS assertion from the
    // "empty patch" refine (a schema that doesn't know `category` yet would
    // silently strip it, leaving `{name: "Open"}`, a non-empty and
    // otherwise-valid patch that would wrongly parse as success).
    const r = PatchDivision.safeParse({ name: "Open", category: "u12" });
    expect(r.success).toBe(false);
  });

  it("accepts nullable age_min/age_max independently", () => {
    expect(PatchDivision.safeParse({ age_min: 8 }).success).toBe(true);
    expect(PatchDivision.safeParse({ age_max: 12 }).success).toBe(true);
    expect(PatchDivision.safeParse({ age_min: null, age_max: null }).success).toBe(true);
  });

  it("accepts age_min equal to age_max (a single-age band)", () => {
    expect(PatchDivision.safeParse({ age_min: 12, age_max: 12 }).success).toBe(true);
  });

  it("rejects age_min greater than age_max", () => {
    // Same non-empty-patch guard as above — `name` isolates this from the
    // "empty patch" refine.
    const r = PatchDivision.safeParse({ name: "Open", age_min: 12, age_max: 8 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "age_max")).toBe(true);
    }
  });
});

// RS004 review finding 4 (minor, contract asymmetry): PatchDivision bounds
// age_min/age_max to 0-120 (above) but the Division RESPONSE schema left
// them unbounded ints — the generated OpenAPI spec described the same field
// two different ways. Field-level safeParse (Division.shape.<field>) rather
// than building a full Division fixture: isolates the bound from every
// other required key on the response shape.
describe("Division response schema (RS004 review finding 4)", () => {
  it("bounds age_min/age_max to 0-120, matching PatchDivision's request-side bounds", () => {
    expect(Division.shape.age_min.safeParse(121).success).toBe(false);
    expect(Division.shape.age_min.safeParse(-1).success).toBe(false);
    expect(Division.shape.age_max.safeParse(121).success).toBe(false);
    expect(Division.shape.age_max.safeParse(-1).success).toBe(false);
  });

  it("still accepts in-bounds values and null", () => {
    expect(Division.shape.age_min.safeParse(0).success).toBe(true);
    expect(Division.shape.age_min.safeParse(120).success).toBe(true);
    expect(Division.shape.age_min.safeParse(null).success).toBe(true);
    expect(Division.shape.age_max.safeParse(null).success).toBe(true);
  });
});

describe("PutRegistrationSettings (RS004 approval / free agents)", () => {
  const BASE = { enabled: true, entrant_kind: "team" as const };

  it("defaults approval to 'auto' and allow_free_agents to false", () => {
    const r = PutRegistrationSettings.safeParse(BASE);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.approval).toBe("auto");
      expect(r.data.allow_free_agents).toBe(false);
    }
  });

  it("accepts approval: 'manual'", () => {
    // Checks the PARSED value, not just .success — a schema that doesn't
    // recognise `approval` yet would silently strip it and still report
    // success on the rest of the (valid) payload, which would make a bare
    // .success assertion pass whether or not the field is wired up.
    const r = PutRegistrationSettings.safeParse({ ...BASE, approval: "manual" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.approval).toBe("manual");
  });

  it("rejects an unknown approval value", () => {
    expect(PutRegistrationSettings.safeParse({ ...BASE, approval: "sometimes" }).success).toBe(false);
  });

  it("accepts allow_free_agents: true (the entrant_kind='team' business rule is a usecase concern, not zod's)", () => {
    const r = PutRegistrationSettings.safeParse({ ...BASE, allow_free_agents: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.allow_free_agents).toBe(true);
  });
});

// P11 (D6) batch score-event import. Both cases below guard a REFINEMENT that
// nothing else on the branch exercises, which means either one is deletable
// with the rest of the suite green.
describe("EventImportRequest (P11 batch import)", () => {
  const stream = (event: Record<string, unknown>) => ({
    import_id: "imp-1",
    streams: [{ fixture: { ext_key: "M1" }, events: [event] }],
  });

  it("accepts a minimal stream (the control every rejection below is measured against)", () => {
    const r = EventImportRequest.safeParse(stream({ type: "core.start" }));
    expect(r.success).toBe(true);
    // `payload` defaults rather than staying undefined — the usecase hands it
    // straight to the engine and to `appendEventInTx`, neither of which has a
    // fallback of its own.
    if (r.success) expect(r.data.streams[0]!.events[0]!.payload).toEqual({});
  });

  // Final review I-5: owner ruling R2 refuses `core.void` at the request
  // schema — an undo is a live-scoring action, and a wrong import is re-run
  // under a new import_id, never cancelled event by event. Nothing on the
  // branch asserted it, so the refine could be deleted with the suite green.
  it("refuses core.void (owner ruling R2 — an undo is not importable)", () => {
    const r = EventImportRequest.safeParse(stream({ type: "core.void", payload: { event_id: UUID } }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".").endsWith("events.0.type"))).toBe(true);
    }
  });

  // Final review I-4: `at` used to be a bare `z.string().optional()` and the
  // engine only asks `.min(1)`, so a malformed timestamp survived the dry run
  // and raised Postgres 22007 INSIDE the write transaction — neither a unique
  // violation nor an EngineError, so it rethrew as a 500 and discarded the
  // report for every stream that had already committed.
  it("refuses an `at` that is not a parseable ISO-8601 instant", () => {
    for (const at of ["not-a-timestamp", "2026-13-45T99:99:99Z", "20/08/2026", "", "2026-08-20"]) {
      const r = EventImportRequest.safeParse(stream({ type: "core.start", at }));
      expect(r.success, `expected ${JSON.stringify(at)} to be refused`).toBe(false);
    }
  });

  it("accepts a real ISO-8601 instant, in Z and in an explicit offset", () => {
    for (const at of ["2026-08-20T14:05:00Z", "2026-08-20T14:05:00.123Z", "2026-08-20T14:05:00+02:00"]) {
      const r = EventImportRequest.safeParse(stream({ type: "core.start", at }));
      expect(r.success, `expected ${JSON.stringify(at)} to be accepted`).toBe(true);
    }
  });
});


// The joint-undo refusal's MACHINE-READABLE half (schedule-lock copy fix).
//
// `restoreCompetitionSchedule` catches per division and reports each refusal in
// `failed[]`. It used to carry the message alone, so the board's joint-undo
// card had nothing to branch on but English prose — and interpolating
// `SCHEDULE_LOCKED_MESSAGE` into a dictionary placeholder put a raw English
// clause mid-sentence inside a fully translated card, on the first request.
//
// A zod object STRIPS an undeclared key silently. Dropping `code` from this
// schema therefore breaks the card with no type error anywhere: the usecase
// still returns it, `tsc` is satisfied, and the browser simply never sees it.
describe("RestoreCompetitionScheduleResult — the per-division refusal code", () => {
  const payload = {
    restored: [{ division_id: UUID, watermark: 3, steps: 2 }],
    failed: [
      { division_id: UUID2, reason: "the division schedule is locked", code: "SCHEDULE_LOCKED" },
    ],
    ok: false,
  };

  it("survives the published schema instead of being stripped on the way out", () => {
    const parsed = RestoreCompetitionScheduleResult.parse(payload);
    expect(parsed.failed[0]!.code).toBe("SCHEDULE_LOCKED");
    // Nothing else moved: the whole body round-trips unchanged.
    expect(parsed).toEqual(payload);
  });

  it("stays optional, because most refusals carry no code at all", () => {
    // A bare `HttpError(404, "checkpoint not found")` and a thrown `Error` both
    // reach `failed[]` with a reason and nothing else. Requiring the code would
    // 500 the endpoint on the commonest refusal it has.
    const r = RestoreCompetitionScheduleResult.safeParse({
      ...payload,
      failed: [{ division_id: UUID2, reason: "checkpoint not found" }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.failed[0]!.code).toBeUndefined();
  });
});
