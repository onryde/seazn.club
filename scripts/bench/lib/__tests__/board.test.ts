// Unit coverage for `lib/board.ts` — B04's transport-free seam.
//
// The file under test is mostly TYPES, and a type cannot be tested. What CAN
// be tested is the two pure functions that live beside them, and both of them
// are places where a silent wrong answer is worse than a loud refusal:
//
//   - `encodeConstraints` builds the checker's ORACLE. Every rule in
//     `checker.ts` measures the product's board against this object, so a
//     knob this function drops, defaults, or mis-converts does not fail — it
//     makes the checker agree with a board it should have reddened. That is
//     failure class 3 ("a guard nothing kills is not tested") one layer up.
//   - `judgeDivision` is the only place the three verification layers are
//     combined into one verdict. A test that asserted only `red === true`
//     could not tell a working composition from `return { red: true }`, so
//     every red case below asserts BOTH the boolean AND that `reasons` names
//     the specific trigger that fired.
//
// Two habits this suite keeps on purpose:
//   - **Values, not shapes.** `45`/`3`/`570` are asserted, never "a number" —
//     a mapper reading `count` off the wrong union member still produces a
//     one-entry array (the brief's own note), and a wall clock read as an
//     integer still produces a number.
//   - **Asymmetric fixtures.** `blockingCount: 2` / `unplacedCount: 7` /
//     three schedule errors in the all-five case, so a transposed field read
//     shows up as the wrong number in the wrong reason rather than passing.
//
// Epoch literals below were derived OUTSIDE this process (`date -u -r`), not
// from `Date.parse` — deriving the expectation from the implementation's own
// call is the tautology this repo has already paid for.
//
// One import here reaches OUT of `scripts/bench` and into the product:
// `ScheduleConfig`, so the three defaults `board.ts` restates are pinned to the
// declaration they were copied from rather than to a second copy of the same
// number (see the drift guard at the end of the `encodeConstraints` block).
// `board.ts` itself must NOT gain that dependency — it is the runtime, and it
// stays import-free apart from two `import type`s. Two consequences worth
// knowing: this suite now fails to COLLECT if `schemas.ts` ever throws at
// module scope, and a collection failure contributes ZERO failures to the JSON
// reporter — so judge this file on `numTotalTests`, never on `numFailedTests`.
import { describe, expect, it } from "vitest";
import { ScheduleConfig } from "../../../../apps/web/src/server/api-v1/schemas.ts";
import {
  encodeConstraints,
  judgeDivision,
  type CertificateVerdict,
  type CheckerFinding,
  type CheckerReport,
} from "../board.ts";

const COURT_ONE = "11111111-1111-4111-8111-111111111111";
const courts = new Map([["c-one", COURT_ONE]]);

describe("encodeConstraints", () => {
  it("resolves an @-sigil court ref to the seeded court id", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { courts: ["@c-one"], matchMinutes: 45 },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.courtIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(out.matchMinutes).toBe(45);
  });

  it("REPORTS a hard constraint it cannot model rather than dropping it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [{ type: "fixture_on_weekday", weekday: "FR", selector: {}, scope: {} }],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toHaveLength(0);
    expect(out.unmodelled).toEqual([
      { type: "fixture_on_weekday", reason: expect.stringContaining("not modelled") },
    ]);
  });

  // The value, not just the key: a mapper that read `count` off the wrong
  // member would still produce a one-entry array.
  //
  // Amended from the brief's two-key form, which asserted `scope` DISCARDED.
  // An entrant-scoped day cap applied universally reds fixtures the rule never
  // covered, so the bench would file a false product defect — the exact
  // misreading `constraints.ts:36-50` documents, where the distinction lives in
  // the TALLY KEY and not in the predicate. The scope below is deliberately
  // NON-universal so a reader that hardcoded `{ kind: "competition" }` dies.
  it("carries max_fixtures_per_day's own count and its own scope, not a default", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            {
              type: "max_fixtures_per_day",
              count: 3,
              scope: { kind: "entrant", entrantId: "e-9" },
            },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([
      { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant", entrantId: "e-9" } },
    ]);
  });

  it("refuses an unresolvable court ref instead of silently emitting the sigil", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { courts: ["@c-missing"] },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/c-missing/);
  });

  it("defaults matchMinutes to the product's own default when the pack omits it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {},
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.matchMinutes).toBe(30); // ScheduleConfig.matchMinutes default
  });

  // ---- beyond the brief's five: the rest of what step 3 mandates ---------
  // Each behaviour below is required by the task brief's implementation step
  // and reached by none of the five tests above. Shipping them untested would
  // hand T2 an oracle whose conversions nothing kills.

  it("passes a real court id through untouched and preserves the pack's order", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // Sigil SECOND, so a mapper that resolved only the head of the array —
      // or that sorted — differs visibly from the right answer.
      scheduleConfig: { courts: [other, "@c-one"] },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.courtIds).toEqual([other, COURT_ONE]);
  });

  it("converts every ISO instant to epoch ms, offset included, and resolves a blackout's own court ref", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        startAt: "2027-06-01T08:00:00+00:00",
        endAt: "2027-06-03T20:00:00+00:00",
        // +05:30, deliberately: an implementation that dropped the offset and
        // read the wall clock as UTC would answer 1811860200000 here.
        sessionWindows: [{ from: "2027-06-01T14:30:00+05:30", to: "2027-06-01T17:00:00+00:00" }],
        blackouts: [
          { court: "@c-one", from: "2027-06-01T12:00:00+00:00", to: "2027-06-01T13:00:00+00:00" },
        ],
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.startAt).toBe(1811836800000);
    expect(out.endAt).toBe(1812052800000);
    expect(out.sessionWindows).toEqual([{ from: 1811840400000, to: 1811869200000 }]);
    expect(out.blackouts).toEqual([
      { courtId: COURT_ONE, from: 1811851200000, to: 1811854800000 },
    ]);
  });

  // The oracle must name the same instant on every machine that runs the bench.
  // `Date.parse` reads an OFFSETLESS ISO date-time as LOCAL time — measured on
  // this box, `Date.parse("2027-06-01T08:00:00")` answers 1811836800000 under
  // TZ=UTC, 1811833200000 under Europe/London and 1811817000000 under
  // Asia/Kolkata, a 5.5-hour spread — so accepting one would put the machine's
  // timezone inside a file whose whole contract is "no clock".
  it("reads a Z instant and the SAME instant written with a +05:30 offset as one number", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        // 08:00Z and 13:30+05:30 are the same instant. A reader that dropped
        // the offset would answer 1811836800000 for the first and
        // 1811856600000 (13:30 read as UTC) for the second.
        startAt: "2027-06-01T08:00:00Z",
        endAt: "2027-06-01T13:30:00+05:30",
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    // `date -u -r 1811836800` -> 2027-06-01T08:00:00Z, derived outside this
    // process.
    expect(out.startAt).toBe(1811836800000);
    expect(out.endAt).toBe(1811836800000);
  });

  it("REFUSES an offsetless ISO date-time instead of reading it in the machine's own timezone", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { startAt: "2027-06-01T08:00:00" },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
      // Names the offending field AND why, so a pack author can fix it without
      // reading this file.
    ).toThrow(/scheduleConfig\.startAt.*offset/s);
  });

  it("leaves a global blackout global — an absent court is not resolved to one", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        blackouts: [{ from: "2027-06-01T12:00:00+00:00", to: "2027-06-01T13:00:00+00:00" }],
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.blackouts).toHaveLength(1);
    expect(out.blackouts[0]?.courtId).toBeUndefined();
  });

  // `null` and ABSENT are the same thing for a `.nullish()` product field and
  // different things for an `.optional()` one, and `blackouts[].court` is the
  // second kind. Both directions below, because a helper that got this right in
  // one direction only would still pass a one-sided test.
  it("REFUSES a present-but-null blackout court instead of widening it to every court", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: {
          blackouts: [
            {
              // `court` is `.optional()`, not `.nullish()` — a `null` fails the
              // product's own parse. Reading it as "no court" turns ONE court's
              // blackout into a venue-wide one that blocks every court for the
              // window, which is precisely what `schemas.ts`'s `blackouts` doc
              // comment says must never happen: an entry whose court cannot be
              // identified is DROPPED, never widened.
              court: null,
              from: "2027-06-01T12:00:00+00:00",
              to: "2027-06-01T13:00:00+00:00",
            },
          ],
        },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.blackouts\[0\]\.court.*null/);
  });

  it("keeps null meaning ABSENT for startAt/endAt, which the product declares nullish", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // `schemas.ts:1284`/`:1286` are `.nullish()`, so a stored config
      // round-trips these as nulls and refusing one would red every division
      // that never set a window.
      scheduleConfig: { startAt: null, endAt: null },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.startAt).toBeUndefined();
    expect(out.endAt).toBeUndefined();
  });

  it("converts not_before/not_after wall clock to minutes into the day", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            // Two DIFFERENT scopes, so a reader that copied the first rule's
            // scope onto every rule differs visibly from the right answer.
            { type: "not_before", time: "09:30", scope: { kind: "every_person" } },
            { type: "not_after", time: "21:15", scope: { kind: "pool", divisionId: "d-1", pool: "A" } },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    // 570 and 1275, NOT 930 and 2115 — an HHMM read as a decimal integer is
    // the exact bug this asserts against, and both differ from their wrong
    // answer.
    expect(out.hard).toEqual([
      { type: "not_before", minutesIntoDay: 570, scope: { kind: "every_person" } },
      {
        type: "not_after",
        minutesIntoDay: 1275,
        scope: { kind: "pool", divisionId: "d-1", pool: "A" },
      },
    ]);
    expect(out.unmodelled).toEqual([]);
  });

  it("renames min_rest_minutes' rest_scope to restScope and carries its declared value", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            // The MIDDLE member, so a hardcoded first-member default differs
            // from the right answer.
            {
              type: "min_rest_minutes",
              minutes: 45,
              rest_scope: "feeder_to_dependent",
              scope: { kind: "person", personKey: "p-3" },
            },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([
      {
        type: "min_rest_minutes",
        minutes: 45,
        restScope: "feeder_to_dependent",
        // `rest_scope` and `scope` are DIFFERENT fields and neither stands in
        // for the other: the first says which rest a rule measures, the second
        // says whose fixtures it covers.
        scope: { kind: "person", personKey: "p-3" },
      },
    ]);
  });

  it("reports a modellable rule whose own operand is unreadable, rather than emitting a broken one", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // A `max_fixtures_per_day` with no `count` — schema-illegal, but
      // `PackDivision.scheduleConfig` is an opaque record that nothing
      // type-checks, so this reaches here.
      // Valid scope, missing `count`: the two guards are checked one at a
      // time, so this test witnesses the OPERAND guard alone and the scope
      // test below witnesses the other.
      scheduleConfig: {
        constraints: {
          hard: [{ type: "max_fixtures_per_day", scope: { kind: "competition" } }],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([
      { type: "max_fixtures_per_day", reason: expect.stringContaining("not modelled") },
    ]);
  });

  it("REPORTS a hard rule whose ConstraintScope is unreadable rather than applying it universally", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            // Operand fine, scope not: `{ kind: "entrant" }` with no
            // `entrantId` fails the product's own `ConstraintScope`
            // (`constraints.ts:30`), and there is no safe universal reading of
            // it — assuming one is how the bench files a FALSE product defect.
            { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant" } },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([
      { type: "max_fixtures_per_day", reason: expect.stringContaining("not modelled") },
    ]);
    expect(out.unmodelled[0]?.reason).toMatch(/scope/i);
  });

  it("carries a UNIVERSAL scope verbatim — every_entrant is not collapsed to competition", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            // `constraints.ts:36-50`: `every_entrant` means "each entrant,
            // counted separately", NOT "the whole run". `scopeCoversFixture`
            // answers `true` for both and cannot tell them apart, so the
            // distinction survives only if the encoding keeps the kind.
            { type: "min_rest_minutes", minutes: 20, rest_scope: "both", scope: { kind: "every_entrant" } },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([
      { type: "min_rest_minutes", minutes: 20, restScope: "both", scope: { kind: "every_entrant" } },
    ]);
  });

  it("refuses a present-but-unreadable matchMinutes instead of falling back to the default", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { matchMinutes: "45" },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/matchMinutes/);
  });

  // Ruling R14 — the numeric twin of the null-blackout-court fix. None of the
  // three knobs is `.nullish()` in the product (`schemas.ts:1287`/`:1288`/
  // `:1303` are all `z.number().int()...default(n)`), so a `null` is invalid
  // product-side and the bench must not launder it into a valid default. A
  // present-but-wrong value is strictly MORE dangerous than an absent one: the
  // absent knob falls through to the right number, while the null one measures
  // the whole checker against a duration the pack never declared.
  //
  // Both directions in each case, absent asserted FIRST. A throw-on-everything
  // mutant passes the null half alone, and it is the absent half that catches
  // it — so the pair has to travel together, per knob.
  //
  // The expected default is read from `ScheduleConfig.parse({})`, never
  // retyped: the drift guard below stays the single authority on those numbers,
  // and three more hand-copies here would be the exact drift it exists to stop.
  it.each([
    ["matchMinutes", "matchMinutes"],
    ["gapMinutes", "gapMinutes"],
    ["perEntrantMinRest", "perEntrantMinRest"],
  ] as const)("refuses a present-but-null %s but still defaults an absent one", (key) => {
    const encode = (scheduleConfig: Record<string, unknown>) =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig,
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      });
    const product = ScheduleConfig.parse({});

    // ABSENT -> the product's own default, unchanged by this ruling.
    expect(encode({})[key]).toBe(product[key]);
    // PRESENT-BUT-NULL -> refused, naming the field.
    expect(() => encode({ [key]: null })).toThrow(
      new RegExp(`scheduleConfig\\.${key}`),
    );
  });

  it("defaults every knob the pack omits and carries pins and isRoundRobin verbatim", () => {
    const pins = [{ fixtureId: "f-7", start: 1811836800000, courtId: COURT_ONE }];
    const out = encodeConstraints({
      divisionRef: "d-other",
      scheduleConfig: undefined,
      courtIdByRef: courts,
      // FALSE here, unlike every test above — a hardcoded `true` dies.
      isRoundRobin: false,
      pins,
    });
    expect(out.divisionRef).toBe("d-other");
    expect(out.matchMinutes).toBe(30);
    expect(out.gapMinutes).toBe(0);
    expect(out.perEntrantMinRest).toBe(0);
    expect(out.startAt).toBeUndefined();
    expect(out.endAt).toBeUndefined();
    expect(out.courtIds).toEqual([]);
    expect(out.blackouts).toEqual([]);
    expect(out.sessionWindows).toEqual([]);
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([]);
    expect(out.isRoundRobin).toBe(false);
    expect(out.pins).toEqual(pins);
  });

  // ---- unmodelled[] covers every DECLARED knob, not just hard[] -----------
  // Ruling R9. `unmodelled[]` used to mean "`HardConstraint` members this build
  // cannot model", so a pack setting `constraints.restMin: 60` had it dropped
  // with nothing reporting it — the same false-clean design §1.4 exists to
  // prevent, one level up. The list is keyed on PRESENCE, not on value: judging
  // which declared value is inert is exactly the judgement the encoder is
  // saying it did not make.

  it("reports a constraints knob it does not model rather than dropping it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { constraints: { restMin: 60 } },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([
      { type: "constraints.restMin", reason: expect.stringContaining("not modelled") },
    ]);
  });

  // perEntrantMinRest and constraints.restMin are DIFFERENT knobs
  // (`schemas.ts:1303` vs `:1332`) and neither covers for the other. A reader
  // that treated the encoded one as discharging the declared one would report
  // clean on a rest rule it never checked.
  it("does not let perEntrantMinRest stand in for constraints.restMin", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // Different numbers, so a conflated read lands a visibly wrong value.
      scheduleConfig: { perEntrantMinRest: 90, constraints: { restMin: 60 } },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.perEntrantMinRest).toBe(90);
    expect(out.unmodelled.map((u) => u.type)).toEqual(["constraints.restMin"]);
  });

  // Design §3.3's rule list has no gap rule, and court occupancy is judged on
  // `[start, start + matchMinutes)`. `gapMinutes` is a spacing PREFERENCE, so
  // it is encoded for the report and declared unchecked — T2 does not guess.
  it("declares gapMinutes and roundMinutes unmodelled while still carrying gapMinutes' value", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { gapMinutes: 10, roundMinutes: 75 },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.gapMinutes).toBe(10);
    expect(out.unmodelled.map((u) => u.type)).toEqual(["gapMinutes", "roundMinutes"]);
    expect(out.unmodelled[0]?.reason).toMatch(/occupancy/i);
  });

  it("names crossPersonClash as unmodelled AND inert, since the product reads it nowhere", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { constraints: { crossPersonClash: "hard" } },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.unmodelled.map((u) => u.type)).toEqual(["constraints.crossPersonClash"]);
    // `constraints.ts:138-145`: "@deprecated Accepted and stored, read by
    // nothing." Reporting it as merely unchecked would imply the product acts
    // on it, which would send a reader hunting a defect that cannot exist.
    expect(out.unmodelled[0]?.reason).toMatch(/inert/i);
  });

  // Enumerate the table, never one sample: a loop that reported the first key
  // and stopped, or one missing a member, passes any single-knob test.
  it("enumerates EVERY declared knob this build does not model, in schema order", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        gapMinutes: 5,
        roundMinutes: 75,
        // Modelled, so none of these may appear below.
        matchMinutes: 45,
        perEntrantMinRest: 30,
        courts: ["@c-one"],
        constraints: {
          restMin: 60,
          restByGroup: { u12: 45 },
          noBackToBack: true,
          startWindows: [{ target: { kind: "division", id: "d-1" }, notBefore: "2027-06-01T08:00:00Z" }],
          fieldFairness: "rotate",
          parallelism: "block",
          crossPersonClash: "warn",
          // `hard` is modelled rule-by-rule and must NOT appear as a knob.
          hard: [{ type: "not_before", time: "09:30", scope: { kind: "competition" } }],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([
      { type: "not_before", minutesIntoDay: 570, scope: { kind: "competition" } },
    ]);
    expect(out.unmodelled.map((u) => u.type)).toEqual([
      "gapMinutes",
      "roundMinutes",
      "constraints.restMin",
      "constraints.restByGroup",
      "constraints.noBackToBack",
      "constraints.startWindows",
      "constraints.fieldFairness",
      "constraints.parallelism",
      "constraints.crossPersonClash",
    ]);
    // Every reason carries the marker `CheckerReport.unchecked` forwards.
    expect(out.unmodelled.every((u) => u.reason.startsWith("not modelled"))).toBe(true);
  });

  // ---- null must not silently empty a container (fix round 2, F1) ---------
  // `PackJsonValue` admits `null` explicitly (`pack-schema.ts:154-171`), so a
  // pack can reach every one of these. None of the containers below is
  // `.nullish()` in the product — `constraints` and `constraints.hard` are
  // `.optional()` (`schemas.ts:1330`, `:1357`), `courts` / `blackouts` /
  // `sessionWindows` are `.default([])` (`:1302`, `:1318`, `:1322`) — so a null
  // is a present-but-invalid value, not an absence.
  //
  // This is the same defect as the null blackout court and the null numeric
  // knobs, but it fails in the WORST direction: a null container was read as
  // "nothing declared", so the whole rule set vanished AND `unmodelled[]` stayed
  // empty. The report then said every declared constraint was accounted for,
  // which is the exact false-clean design §1.4 exists to prevent.

  // The guard the ruling names, written so it cannot go vacuous: exactly one
  // branch runs and both branches assert. It states the §1.4 INVARIANT rather
  // than today's mechanism, so it keeps holding if the encoder is ever changed
  // to report this instead of refusing it.
  it("never answers a null constraints block with a silent all-clear", () => {
    const outcome = ((): { kind: "returned"; value: ReturnType<typeof encodeConstraints> } | { kind: "refused"; message: string } => {
      try {
        return {
          kind: "returned",
          value: encodeConstraints({
            divisionRef: "d-tiny",
            scheduleConfig: { constraints: null },
            courtIdByRef: courts,
            isRoundRobin: true,
            pins: [],
          }),
        };
      } catch (error) {
        return { kind: "refused", message: String(error) };
      }
    })();

    if (outcome.kind === "returned") {
      // Returning is allowed; returning "no rules AND nothing unchecked" is not.
      expect({
        hard: outcome.value.hard.length,
        unmodelled: outcome.value.unmodelled.length,
      }).not.toEqual({ hard: 0, unmodelled: 0 });
    } else {
      expect(outcome.message).toMatch(/scheduleConfig\.constraints/);
    }
  });

  it("refuses a null constraints block, naming the field", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { constraints: null },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.constraints must be an object, got null/);
  });

  // The same silent drop one level down: `constraints.hard: null` emptied the
  // rule list while `unmodelled[]` stayed empty, because the null never reached
  // a per-rule reader that could report it.
  it("refuses a null constraints.hard rather than dropping the rule set in silence", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { constraints: { hard: null } },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.constraints\.hard must be an array, got null/);
  });

  it.each(["courts", "blackouts", "sessionWindows"] as const)(
    "refuses a null %s rather than reading it as an empty list",
    (key) => {
      expect(() =>
        encodeConstraints({
          divisionRef: "d-tiny",
          scheduleConfig: { [key]: null },
          courtIdByRef: courts,
          isRoundRobin: true,
          pins: [],
        }),
      ).toThrow(new RegExp(`scheduleConfig\\.${key} must be an array, got null`));
    },
  );

  // The OTHER direction, and the reason this is not a blanket "null always
  // throws": `startAt`/`endAt` really are `.nullish()`, and the knob sweep's
  // `roundMinutes` is too. Those keep reading null as absent — already pinned
  // by the startAt/endAt case above, and here for the sweep.
  it("keeps null meaning ABSENT for roundMinutes, which the product declares nullish", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { roundMinutes: null },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    // A null `roundMinutes` is genuinely "not set" (`schemas.ts:1327`), so
    // reporting it as a declared-but-unmodelled knob would be a false claim
    // about what the pack asked for.
    expect(out.unmodelled).toEqual([]);
  });

  // ---- the refusals T4 is told to build on --------------------------------
  // Report §5 hands T4 the decision of whether these throws become a
  // `scheduleErrors[]` entry or abort the run. That decision was being taken
  // against an untested guarantee: a mutant returning `NaN` instead of throwing
  // survived the whole suite, because nothing supplied an unreadable value.
  // Each refusal below also asserts the FIELD PATH, because the message is what
  // a pack author gets — "board: something is wrong" is not actionable.

  it("refuses a non-string where an ISO instant belongs", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        // Epoch NUMBERS, the most plausible slip for a field this file
        // converts TO epoch ms.
        scheduleConfig: { blackouts: [{ from: 1811851200000, to: 1811854800000 }] },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.blackouts\[0\]\.from must be an ISO instant string/);
  });

  it("refuses a well-suffixed string that is not a real instant", () => {
    // Carries a `Z`, so it clears the offset gate added for I1 and reaches the
    // parse guard behind it. Without an input shaped like this that guard is
    // UNREACHABLE and the offset check silently covers for it.
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { startAt: "2027-06-31T25:00:00Z" },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.startAt is not a parseable ISO instant/);
  });

  it("refuses a constraints block that is not an object — an array included", () => {
    const call = (constraints: unknown) => () =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { constraints },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      });
    expect(call("noBackToBack")).toThrow(/scheduleConfig\.constraints must be an object/);
    // `typeof [] === "object"`, so the array exclusion is its own guard and
    // needs its own case.
    expect(call([])).toThrow(/scheduleConfig\.constraints must be an object/);
  });

  it("refuses a list-shaped knob that is not a list, at either nesting level", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        // A bare ref where a list of them belongs.
        scheduleConfig: { courts: "@c-one" },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.courts must be an array/);
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { constraints: { hard: { type: "not_before", time: "09:30" } } },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/scheduleConfig\.constraints\.hard must be an array/);
  });

  // ---- the drift guard ---------------------------------------------------
  // `board.ts` restates `ScheduleConfig`'s three defaults because it reads an
  // OPAQUE record and therefore never runs that zod schema. The briefed test
  // above asserts `30`, which is a SECOND hand-copy of the same literal: move
  // the product's default to 40 and both copies stay mutually consistent, the
  // suite stays green, and the checker measures every overlap rule against a
  // duration the product never used.
  //
  // So this asserts the encoder's defaults against the SCHEMA'S OWN PARSE, not
  // against a table typed into this file. `ScheduleConfig.parse({})` is the
  // product's answer to "what does a division that configured nothing get", and
  // it is the only authority here — if it moves, this reds.
  it("keeps its three defaults equal to ScheduleConfig's own, so a product default change reds HERE", () => {
    const product = ScheduleConfig.parse({});
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {},
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.matchMinutes).toBe(product.matchMinutes);
    expect(out.gapMinutes).toBe(product.gapMinutes);
    expect(out.perEntrantMinRest).toBe(product.perEntrantMinRest);
  });

  it("carries gapMinutes and perEntrantMinRest when the pack declares them", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // Distinct from each other AND from every default, so a swap is visible.
      scheduleConfig: { gapMinutes: 10, perEntrantMinRest: 90 },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.gapMinutes).toBe(10);
    expect(out.perEntrantMinRest).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// judgeDivision
// ---------------------------------------------------------------------------

function finding(kind: CheckerFinding["kind"]): CheckerFinding {
  return { kind, divisionRef: "d-tiny", fixtureIds: ["f-1", "f-2"], detail: `${kind} detail` };
}

function checker(over: Partial<CheckerReport> = {}): CheckerReport {
  return { findings: [], unchecked: [], clean: true, ...over };
}

function certificate(over: Partial<CertificateVerdict> = {}): CertificateVerdict {
  return {
    branch: "FEASIBLE",
    reason: "history satisfies the encoding",
    violations: [],
    red: false,
    ...over,
  };
}

type JudgeInput = Parameters<typeof judgeDivision>[0];

function judgeInput(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    divisionRef: "d-tiny",
    blockingCount: 0,
    checker: checker(),
    certificate: certificate(),
    unplacedCount: 0,
    scheduleErrors: [],
    ...over,
  };
}

describe("judgeDivision", () => {
  it("returns a clean verdict with NO reasons when every layer is clean", () => {
    expect(judgeDivision(judgeInput())).toEqual({ red: false, reasons: [] });
  });

  it("reds on blocking conflicts and names the count", () => {
    const out = judgeDivision(judgeInput({ blockingCount: 2 }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/blocking conflicts = 2/);
  });

  it("reds on a checker report that is not clean and names the finding kinds", () => {
    const out = judgeDivision(
      judgeInput({
        checker: checker({ findings: [finding("court_double_booking")], clean: false }),
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/checker findings = 1 \(court_double_booking\)/);
  });

  // The differential that separates "reads `clean`" from "reads
  // `findings.length`": `clean` is the checker's own verdict and the only
  // authority here, so a report that declares itself dirty MUST red even
  // with nothing listed.
  it("reds on clean:false even when the report lists no findings", () => {
    const out = judgeDivision(judgeInput({ checker: checker({ clean: false }) }));
    expect(out.red).toBe(true);
    expect(out.reasons[0]).toMatch(/checker findings = 0/);
  });

  it("reds on a red certificate and names its branch", () => {
    const out = judgeDivision(
      judgeInput({
        certificate: certificate({
          branch: "PACK_AUTHORING_BUG",
          reason: "history breaches the pack's own blackout",
          violations: [finding("inside_blackout")],
          red: true,
        }),
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/certificate PACK_AUTHORING_BUG/);
    expect(out.reasons[0]).toMatch(/history breaches the pack's own blackout/);
  });

  it("reds on unplaced fixtures and names the count", () => {
    const out = judgeDivision(judgeInput({ unplacedCount: 1 }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/unplaced fixtures = 1/);
  });

  it("reds on schedule errors and names them", () => {
    const out = judgeDivision(judgeInput({ scheduleErrors: ["schedule-settings PUT 422"] }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/schedule errors = 1/);
    expect(out.reasons[0]).toMatch(/schedule-settings PUT 422/);
  });

  // §3.3: a non-empty `unchecked` is REPORTED beside the verdict, never a red
  // in itself. A judge that reddened on it would make every pack carrying a
  // `fixture_on_date` permanently red.
  it("does NOT red on a clean report that carries unchecked constraints", () => {
    const out = judgeDivision(
      judgeInput({
        checker: checker({
          unchecked: [{ type: "fixture_on_date", reason: "not modelled by the bench checker" }],
        }),
      }),
    );
    expect(out).toEqual({ red: false, reasons: [] });
  });

  it("names EVERY trigger that fired, each with its own value, in a fixed order", () => {
    const out = judgeDivision(
      judgeInput({
        // Five distinct numbers, so a transposed read lands a visibly wrong
        // value in a visibly wrong reason instead of passing.
        blockingCount: 2,
        checker: checker({
          findings: [finding("entrant_below_rest"), finding("day_cap_exceeded")],
          clean: false,
        }),
        certificate: certificate({
          branch: "PRODUCT_DEFECT",
          reason: "history is feasible and the solver returned infeasible",
          red: true,
        }),
        unplacedCount: 7,
        scheduleErrors: ["auto 500", "apply 409", "validate 503"],
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(5);
    expect(out.reasons[0]).toMatch(/blocking conflicts = 2/);
    expect(out.reasons[1]).toMatch(/checker findings = 2 \(entrant_below_rest, day_cap_exceeded\)/);
    expect(out.reasons[2]).toMatch(/certificate PRODUCT_DEFECT/);
    expect(out.reasons[3]).toMatch(/unplaced fixtures = 7/);
    expect(out.reasons[4]).toMatch(/schedule errors = 3/);
    // Every reason locates itself, so a multi-division report can print them
    // flat without re-attributing them.
    expect(out.reasons.every((r) => r.startsWith("d-tiny: "))).toBe(true);
  });
});
