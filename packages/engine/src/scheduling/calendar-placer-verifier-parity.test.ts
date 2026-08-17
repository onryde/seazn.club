// #463 — THE test this wave exists for. A test that asserts only the placer's
// behaviour cannot catch a fork; this one feeds the placer's OWN OUTPUT back to
// `validateAssignments` per rule family, so any family the placer stops
// honouring fails here rather than shipping as "Auto proposes a board the apply
// gate warns about, and re-running Auto proposes the same board again".
//
// Every typed-rule breach reports `reason: "instruction"` (rule code H8) — there
// is no per-family field on `Conflict` — and each case below puts exactly one
// family in force, so an `instruction` row can only have come from it.
//
// Each config is sized so the rule BITES: without the placer honouring it the
// board really does breach, which is what a parity assertion needs to be worth
// running. Proven by reverting calendar.ts to the pre-#463 placer, where every
// case here fails.
import { describe, expect, it } from "vitest";
import {
  slotFixtures,
  validateAssignments,
  type RuleFixture,
  type SchedulableFixture,
} from "./calendar.ts";
import { SchedulingConstraints, type HardConstraint } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";

const TZ = "America/Los_Angeles";
const SAT_1000_LOCAL = Date.UTC(2026, 6, 11, 17, 0);
const SAT_0600_LOCAL = Date.UTC(2026, 6, 11, 13, 0);

const D1 = { kind: "division", divisionId: "d1" } as const;
const TERMINAL = { kind: "terminal" } as const;

// One shared entrant, so the cards serialise on the board and the rule under
// test is the only thing that can move them off it.
const cards = (n: number): SchedulableFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    home: "e1",
    away: `e${i + 10}`,
    divisionId: "d1",
  }));

// `winnerTo: null` for all of them: nothing feeds on, so `terminal` names the
// whole set and a selector-driven rule is exercised rather than skipped.
const ruleFixturesFor = (n: number): RuleFixture[] =>
  cards(n).map((f) => ({ id: f.id, extKey: f.id, divisionId: "d1", winnerTo: null }));

// `cards()` deliberately shares one entrant so the rule under test is the only
// thing that can move a card. That makes it USELESS for telling a universal
// scope from a named one: with every card on `e1`, a cap scoped to `e1` and a
// cap scoped to "every entrant" are the same assertion. These cards share
// nothing, so a named-entrant cap binds exactly one of them and only a
// universal cap binds them all.
const disjointCards = (n: number): SchedulableFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${i + 1}`,
    home: `h${i + 1}`,
    away: `a${i + 1}`,
    divisionId: "d1",
    // `SchedulableFixture.people` is OPTIONAL (calendar.ts:82) and `scopeRowOf`
    // fills `people: [...(f.people ?? [])]`. Omitting it makes every
    // person-scoped rule silently bind nothing, so a person case built on a
    // helper that forgets this passes while asserting nothing.
    people: [`p-h${i + 1}`, `p-a${i + 1}`],
  }));

// `configFor` derives its rule fixtures from `cards(n)`. Cases that supply
// their own board — disjoint entrants, or two divisions — must derive them from
// THAT board, or every selector-resolved rule silently names nothing.
const configOver = (rule: HardConstraint, fixtures: SchedulableFixture[], startAt: number) => ({
  startAt,
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["C1", "C2"],
  blackouts: [],
  sessionWindows: [],
  tz: TZ,
  horizonMinutes: 60 * 24 * 21,
  ruleFixtures: fixtures.map((f) => ({
    id: f.id,
    extKey: f.id,
    divisionId: f.divisionId,
    winnerTo: null,
  })),
  constraints: SchedulingConstraints.parse({ hard: [rule] }),
});

const configFor = (rule: HardConstraint, n: number, startAt: number) => ({
  startAt,
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["C1", "C2"],
  blackouts: [],
  sessionWindows: [],
  tz: TZ,
  horizonMinutes: 60 * 24 * 21,
  ruleFixtures: ruleFixturesFor(n),
  constraints: SchedulingConstraints.parse({ hard: [rule] }),
});

const FAMILIES: ReadonlyArray<readonly [string, HardConstraint, number, number]> = [
  // Six cards capped at two a day: the placer must spread them over three days.
  [
    "max_fixtures_per_day",
    { type: "max_fixtures_per_day", count: 2, scope: { kind: "entrant", entrantId: "e1" } },
    6,
    SAT_1000_LOCAL,
  ],
  // First slot is 06:00 local, three hours inside the bound.
  ["not_before", { type: "not_before", time: "09:00", scope: D1 }, 3, SAT_0600_LOCAL],
  // Twelve cards from 10:00 local run to 15:30 — seven of them past the bound.
  ["not_after", { type: "not_after", time: "12:00", scope: D1 }, 12, SAT_1000_LOCAL],
  // The first slot is a Saturday.
  ["fixture_on_weekday", { type: "fixture_on_weekday", selector: TERMINAL, weekday: "WED", scope: D1 }, 3, SAT_1000_LOCAL],
  ["fixture_on_date", { type: "fixture_on_date", selector: TERMINAL, date: "2026-07-15", scope: D1 }, 3, SAT_1000_LOCAL],
];

// A CHARACTERISATION test, not a red-first one: it passes before the refactor
// below it and must keep passing after. `dayCapRulesFor`'s comment claims it is
// the one resolution shared by the placement-time tally READ and the
// commit-time WRITE, but only `countDay` called it — `nextAcceptableStart`
// walked `placementHard` itself. They agreed only because both happened to call
// `scopeCoversFixture` with the same arguments, which is a coincidence rather
// than an invariant, and it stops holding the moment a scope makes the read and
// the write differ in SHAPE rather than in predicate.
//
// Two caps with DIFFERENT scopes are what makes the resolution observable at
// all: with one rule, index 0 is the only index and any walk finds it.
describe("the day-cap read and write resolve the same rules", () => {
  it("honours two differently-scoped day caps at once", () => {
    // `e2` is on f1 and f2 only; `e1` is on all four. A cap of 1 on `e2` and a
    // cap of 3 on `e1` must BOTH hold, so the tally each rule reads has to be
    // the tally that rule wrote.
    const fixtures: SchedulableFixture[] = [
      { id: "f1", home: "e1", away: "e2", divisionId: "d1" },
      { id: "f2", home: "e1", away: "e2", divisionId: "d1" },
      { id: "f3", home: "e1", away: "e3", divisionId: "d1" },
      { id: "f4", home: "e1", away: "e4", divisionId: "d1" },
    ];
    const config = {
      startAt: SAT_1000_LOCAL,
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["C1", "C2"],
      blackouts: [],
      sessionWindows: [],
      tz: TZ,
      horizonMinutes: 60 * 24 * 21,
      ruleFixtures: fixtures.map((f) => ({
        id: f.id,
        extKey: f.id,
        divisionId: "d1",
        winnerTo: null,
      })),
      constraints: SchedulingConstraints.parse({
        hard: [
          { type: "max_fixtures_per_day", count: 1, scope: { kind: "entrant", entrantId: "e2" } },
          { type: "max_fixtures_per_day", count: 3, scope: { kind: "entrant", entrantId: "e1" } },
        ],
      }),
    };

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(4);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });
});

// Guards every universal-scope case added later. A universal scope is coming to
// `ConstraintScope`, and the obvious way to cover it — another `FAMILIES` row —
// would be measured against `cards()`, where every card sits on `e1` and the
// existing cap row is already scoped to `e1`. On that board a universal cap and
// a named cap are indistinguishable, so the row would pass without ever
// exercising the new scope. This proves the disjoint helper CAN tell them
// apart, using only the scopes that exist today.
describe("the parity harness can tell scopes apart", () => {
  it("a named-entrant cap on disjoint cards binds one card, not the set", () => {
    const n = 6;
    const fixtures = disjointCards(n);
    const config = configOver(
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "entrant", entrantId: "h1" } },
      fixtures,
      SAT_1000_LOCAL,
    );

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);

    // THE DISCRIMINATING ASSERTION. `h1` is on ONE card, so a cap of 1 scoped to
    // `h1` costs nothing and all six fit on day one. If this ever reads as more
    // than one day, the scope is being ignored — and every universal-scope
    // assertion built on this helper would be worthless.
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(1);

    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });

  it("the same cap on the SHARED-entrant board does bite", () => {
    // The control. Same rule shape, same count, board where `e1` really is on
    // every card: three cards capped at 1 must land on three days. Without this
    // the assertion above could pass because the cap does nothing anywhere.
    const n = 3;
    const config = configFor(
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "entrant", entrantId: "e1" } },
      n,
      SAT_1000_LOCAL,
    );
    const { assignments } = slotFixtures({ fixtures: cards(n), config });
    expect(assignments).toHaveLength(n);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(3);
  });
});

describe("universal daily caps count each entity separately", () => {
  it("every_entrant caps each entrant's own day, not the day's total", () => {
    // Six cards, no shared entrant, cap 2 per entrant. Every entrant is on
    // exactly ONE card, so a correct per-entity cap costs nothing and all six
    // fit on day one. A tally still counting per RULE per DAY reads this as
    // "at most 2 fixtures a day" and spreads them over three days — the
    // 60-player-event bug PARSER_PROMPT rule 8 exists to prevent.
    const n = 6;
    const fixtures = disjointCards(n);
    const config = configOver(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } },
      fixtures,
      SAT_1000_LOCAL,
    );

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(1);
    expect(
      validateAssignments(assignments, config)
        .filter((c) => c.reason === "instruction")
        .map((c) => c.details),
    ).toEqual([]);
  });

  it("every_entrant still bites the entrant who is over", () => {
    // The direction the old per-rule tally already got right, which must not
    // regress while making the case above pass. `cards()` puts every card on
    // `e1`: six capped at 2 is three days.
    const n = 6;
    const config = configFor(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } },
      n,
      SAT_1000_LOCAL,
    );
    const { assignments } = slotFixtures({ fixtures: cards(n), config });
    expect(assignments).toHaveLength(n);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(3);
    expect(
      validateAssignments(assignments, config).filter((c) => c.reason === "instruction"),
    ).toEqual([]);
  });

  it("every_person catches the player entered in two divisions", () => {
    // THE case an entrant-scoped cap misses, and the reason a person scope
    // exists at all. `pX` plays for entrant `s1` in d1 and `m1` in d2 — two
    // entrants, one human. A cap of 2 per PERSON must spread four cards over
    // two days; a cap of 2 per ENTRANT would leave all four on one.
    const fixtures: SchedulableFixture[] = [
      { id: "x1", home: "s1", away: "s9", divisionId: "d1", people: ["pX", "p9"] },
      { id: "x2", home: "s1", away: "s8", divisionId: "d1", people: ["pX", "p8"] },
      { id: "x3", home: "m1", away: "m9", divisionId: "d2", people: ["pX", "q9"] },
      { id: "x4", home: "m1", away: "m8", divisionId: "d2", people: ["pX", "q8"] },
    ];
    const config = configOver(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_person" } },
      fixtures,
      SAT_1000_LOCAL,
    );

    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(4);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(2);
    expect(
      validateAssignments(assignments, config).filter((c) => c.reason === "instruction"),
    ).toEqual([]);
  });

  it("an entrant-scoped cap does NOT catch that player — the control", () => {
    // Proves the case above measures the PERSON scope and not merely the cap.
    // Same board, cap 2 per named entrant `s1`: `s1` is on two cards, so the
    // cap costs nothing and all four fit on one day.
    const fixtures: SchedulableFixture[] = [
      { id: "x1", home: "s1", away: "s9", divisionId: "d1", people: ["pX", "p9"] },
      { id: "x2", home: "s1", away: "s8", divisionId: "d1", people: ["pX", "p8"] },
      { id: "x3", home: "m1", away: "m9", divisionId: "d2", people: ["pX", "q9"] },
      { id: "x4", home: "m1", away: "m8", divisionId: "d2", people: ["pX", "q8"] },
    ];
    const config = configOver(
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "entrant", entrantId: "s1" } },
      fixtures,
      SAT_1000_LOCAL,
    );
    const { assignments } = slotFixtures({ fixtures, config });
    expect(assignments).toHaveLength(4);
    expect(new Set(assignments.map((a) => dayKeyInTz(a.startAt, TZ))).size).toBe(1);
  });
});

describe("the placer's own output satisfies the verifier (#463)", () => {
  it.each(FAMILIES)("emits no %s violation it could have avoided", (_family, rule, n, startAt) => {
    const config = configFor(rule, n, startAt);
    const { assignments, conflicts } = slotFixtures({ fixtures: cards(n), config });

    // A card the placer REFUSED to place is honest; a card it placed into a
    // violation is the fork. These configs are all satisfiable inside the
    // horizon, so refusing one would mean the placer over-constrained — and
    // without this line "place nothing" would satisfy the assertion below.
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);

    // No cast: the placer's config IS a VerifyConfig now that `SlotConfig`
    // carries `tz` and `ruleFixtures`, which is the point — one object, one
    // clock, one rule list, handed to both sides.
    const verdict = validateAssignments(assignments, config);
    // Mapped to `details` so a failure names the day or the time that broke,
    // rather than printing five identical conflict objects.
    expect(verdict.filter((c) => c.reason === "instruction").map((c) => c.details)).toEqual([]);
  });
});
