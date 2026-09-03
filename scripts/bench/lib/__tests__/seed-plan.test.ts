// Unit coverage for the pure pack -> seed-plan mapping (lib/seed-plan.ts).
//
// This suite exists to pin two things a single-division fixture cannot: a
// hardcoded or unfiltered lookup agrees with the right answer when there is
// only one of everything (AGENTS.md recurring-failure class — "a fixture
// with one of something proves nothing"), and the coach/staff/official lane
// ruling in the B03 brief, which is the subtle part of this task. So the
// fixture below carries TWO divisions with different sport keys and
// different entrant counts, no two refs share a name, and every numeric
// field (seed, squad_number) is chosen so the WRONG answer (array position)
// differs visibly from the RIGHT one (the pack's own declared value).
import { describe, expect, it } from "vitest";
import { buildSeedPlan } from "../seed-plan.ts";
import { PackSchema, roundRobinFixtureCount, type Pack } from "../pack-schema.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Two divisions (football/team, cricket/team), different entrant counts (2
 * vs 3), a division with two stages (one league, one knockout — so
 * `expectedFixtureCounts` must skip the knockout rather than mis-answer it),
 * and every lane the coach/staff/official ruling has to distinguish:
 *   - p-morgan / p-noor / p-eve / p-farid / p-gia: lane "player"
 *   - p-priya: lane "coach", pack declares NO roles (roles stay EMPTY — the
 *              lane travels in `CreatePerson.lane`, not in `roles`)
 *   - p-sam:   lane "coach", pack ALREADY declares roles ["coach","tactics"]
 *              (must not duplicate)
 *   - p-rio:   lane "staff", pack declares roles ["physio"] (must gain "staff"
 *              alongside the existing role, not replace it)
 *   - p-quinn: lane "official" — declared in `persons` but rostered nowhere;
 *              must land in `officialPersonRefs` and nowhere in `entrants`.
 *
 * `seed` and `squadNumber` are deliberately NOT equal to array position (nor
 * position+1), in every division and globally, so an off-by-one or an
 * index-substituted-for-value bug is visible rather than accidentally
 * agreeing with the fixture.
 */
function rawPack(): unknown {
  return {
    schemaVersion: 1,
    suite: "_seed-plan-fixture",
    org: { name: "Riverside Sports Club", slug: "riverside-sc", timezone: "Australia/Sydney" },
    competition: {
      name: "Riverside Winter Series",
      slug: "riverside-winter",
      startsOn: "2027-06-01",
      endsOn: "2027-08-01",
      description: "Two-sport winter series across football and cricket.",
    },
    divisions: [
      {
        ref: "d-football",
        name: "Football Open",
        sportKey: "football",
        variantKey: "outdoor11",
        moduleVersion: "1.0.0",
        cfgOverrides: { allowDraws: true },
        tiebreakers: ["points", "diff", "h2h_points"],
        stages: [
          { ref: "st-football-league", seq: 1, kind: "league", name: "Regular Season", config: { legs: 2 } },
          {
            ref: "st-football-finals",
            seq: 2,
            kind: "knockout",
            name: "Finals",
            config: {},
            progression: { from: "st-football-league", take: 4 },
          },
        ],
      },
      {
        ref: "d-cricket",
        name: "Cricket T20",
        sportKey: "cricket",
        variantKey: "t20",
        moduleVersion: "1.0.0",
        cfgOverrides: { oversPerInnings: 20 },
        stages: [
          { ref: "st-cricket-league", seq: 1, kind: "league", name: "Group Stage", config: { legs: 1 } },
        ],
      },
    ],
    persons: [
      { ref: "p-morgan", fullName: "Morgan Ito", lane: "player" },
      { ref: "p-noor", fullName: "Noor Haddad", lane: "player" },
      { ref: "p-priya", fullName: "Priya Nair", lane: "coach" },
      { ref: "p-quinn", fullName: "Quinn Osei", lane: "official" },
      { ref: "p-rio", fullName: "Rio Alves", lane: "staff" },
      { ref: "p-sam", fullName: "Sam Delacroix", lane: "coach" },
      { ref: "p-eve", fullName: "Eve Kowalski", lane: "player", dob: "1998-04-12", gender: "f" },
      { ref: "p-farid", fullName: "Farid Bakr", lane: "player" },
      { ref: "p-gia", fullName: "Gia Torres", lane: "player" },
    ],
    entrants: [
      {
        ref: "e-lions",
        divisionRef: "d-football",
        kind: "team",
        displayName: "Riverside Lions",
        seed: 5,
        roster: [
          { person: "p-morgan", squadNumber: 7, captain: true },
          { person: "p-noor", squadNumber: 15 },
          { person: "p-priya" },
        ],
      },
      {
        ref: "e-tigers",
        divisionRef: "d-football",
        kind: "team",
        displayName: "Riverside Tigers",
        seed: 8,
        roster: [
          { person: "p-eve", squadNumber: 3 },
          { person: "p-rio", roles: ["physio"] },
          { person: "p-sam", roles: ["coach", "tactics"] },
        ],
      },
      {
        ref: "e-eagles",
        divisionRef: "d-cricket",
        kind: "team",
        displayName: "Coastal Eagles",
        seed: 9,
        roster: [{ person: "p-farid", squadNumber: 11, captain: true }],
      },
      {
        ref: "e-falcons",
        divisionRef: "d-cricket",
        kind: "team",
        displayName: "Coastal Falcons",
        seed: 6,
        roster: [{ person: "p-gia", squadNumber: 21, captain: true }],
      },
      {
        ref: "e-hawks",
        divisionRef: "d-cricket",
        kind: "team",
        displayName: "Coastal Hawks",
        seed: 1,
        roster: [],
      },
    ],
    expected: {},
    meta: { synthetic: true },
  };
}

function pack(): Pack {
  return PackSchema.parse(rawPack());
}

/** For the entrant/member lookup boilerplate every test below needs. */
function entrant(plan: ReturnType<typeof buildSeedPlan>, ref: string) {
  const e = plan.entrants.find((x) => x.ref === ref);
  if (e === undefined) throw new Error(`fixture bug: plan carries no entrant "${ref}"`);
  return e;
}
function member(e: ReturnType<typeof entrant>, personRef: string) {
  const m = e.members.find((x) => x.personRef === personRef);
  if (m === undefined) throw new Error(`fixture bug: entrant "${e.ref}" carries no member "${personRef}"`);
  return m;
}

// ---------------------------------------------------------------------------
// org / competition
// ---------------------------------------------------------------------------

describe("buildSeedPlan — org and competition", () => {
  it("resolves org and competition verbatim from the pack, field for field", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.org).toEqual({
      name: "Riverside Sports Club",
      slug: "riverside-sc",
      timezone: "Australia/Sydney",
    });
    expect(plan.competition).toEqual({
      name: "Riverside Winter Series",
      slug: "riverside-winter",
      startsOn: "2027-06-01",
      endsOn: "2027-08-01",
      description: "Two-sport winter series across football and cricket.",
    });
  });

  it("omits optional competition fields the pack did not declare, rather than writing them as undefined", () => {
    const raw = rawPack() as { competition: Record<string, unknown> };
    delete raw.competition.slug;
    delete raw.competition.startsOn;
    delete raw.competition.description;
    const plan = buildSeedPlan(PackSchema.parse(raw));
    expect(plan.competition).toEqual({
      name: "Riverside Winter Series",
      endsOn: "2027-08-01",
    });
    expect("slug" in plan.competition).toBe(false);
    expect("startsOn" in plan.competition).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// divisions / stages
// ---------------------------------------------------------------------------

describe("buildSeedPlan — divisions and stages", () => {
  it("resolves both divisions with their OWN sport/variant/config — no cross-contamination between them", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.divisions).toHaveLength(2);

    const football = plan.divisions.find((d) => d.ref === "d-football");
    expect(football).toEqual({
      ref: "d-football",
      name: "Football Open",
      sport_key: "football",
      variant_key: "outdoor11",
      config: { allowDraws: true },
      tiebreakers: ["points", "diff", "h2h_points"],
      stages: [
        { ref: "st-football-league", seq: 1, kind: "league", name: "Regular Season", config: { legs: 2 } },
        {
          ref: "st-football-finals",
          seq: 2,
          kind: "knockout",
          name: "Finals",
          config: {},
          progression: { from: "st-football-league", take: 4 },
        },
      ],
    });

    const cricket = plan.divisions.find((d) => d.ref === "d-cricket");
    expect(cricket).toEqual({
      ref: "d-cricket",
      name: "Cricket T20",
      sport_key: "cricket",
      variant_key: "t20",
      config: { oversPerInnings: 20 },
      stages: [{ ref: "st-cricket-league", seq: 1, kind: "league", name: "Group Stage", config: { legs: 1 } }],
    });
  });
});

// ---------------------------------------------------------------------------
// entrants — cross-contamination and non-positional values
// ---------------------------------------------------------------------------

describe("buildSeedPlan — entrants stay scoped to their own division", () => {
  it("keeps football's two entrants and cricket's three entirely separate", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.entrants).toHaveLength(5);

    const footballRefs = plan.entrants.filter((e) => e.divisionRef === "d-football").map((e) => e.ref).sort();
    const cricketRefs = plan.entrants.filter((e) => e.divisionRef === "d-cricket").map((e) => e.ref).sort();
    expect(footballRefs).toEqual(["e-lions", "e-tigers"]);
    expect(cricketRefs).toEqual(["e-eagles", "e-falcons", "e-hawks"]);
  });

  it("carries the pack's REAL seed, never the array position (position would give 1,2 / 1,2,3 here)", () => {
    const plan = buildSeedPlan(pack());
    expect(entrant(plan, "e-lions").seed).toBe(5);
    expect(entrant(plan, "e-tigers").seed).toBe(8);
    expect(entrant(plan, "e-eagles").seed).toBe(9);
    expect(entrant(plan, "e-falcons").seed).toBe(6);
    expect(entrant(plan, "e-hawks").seed).toBe(1);
  });

  it("maps kind and display_name onto the product's own field names", () => {
    const plan = buildSeedPlan(pack());
    const lions = entrant(plan, "e-lions");
    expect(lions.kind).toBe("team");
    expect(lions.display_name).toBe("Riverside Lions");
  });
});

// ---------------------------------------------------------------------------
// roster members — squad_number/is_captain/roles, and the coach/staff ruling
// ---------------------------------------------------------------------------

describe("buildSeedPlan — roster members", () => {
  it("carries the REAL squad_number, never the roster array index (index would give 0,1 here)", () => {
    const plan = buildSeedPlan(pack());
    const lions = entrant(plan, "e-lions");
    expect(member(lions, "p-morgan").squad_number).toBe(7);
    expect(member(lions, "p-noor").squad_number).toBe(15);
  });

  it("maps captain -> is_captain, defaulting false when the pack omits it", () => {
    const plan = buildSeedPlan(pack());
    const lions = entrant(plan, "e-lions");
    expect(member(lions, "p-morgan").is_captain).toBe(true);
    expect(member(lions, "p-noor").is_captain).toBe(false);
  });

  it("a coach-lane member with NO declared roles keeps roles EMPTY — the lane is a person fact, not a roster role", () => {
    const plan = buildSeedPlan(pack());
    const priya = member(entrant(plan, "e-lions"), "p-priya");
    // This asserted `["coach"]` while `persons.lane` had no writer. PR #706
    // gave it one, so synthesising a role the pack never declared would now
    // be the bench inventing data. The lane is asserted on the person below.
    expect(priya.roles).toEqual([]);
    expect(priya.is_captain).toBe(false);
  });

  it("a coach-lane member's declared roles are passed through exactly as written", () => {
    const plan = buildSeedPlan(pack());
    const sam = member(entrant(plan, "e-tigers"), "p-sam");
    expect(sam.roles).toEqual(["coach", "tactics"]);
  });

  it("a staff-lane member's declared roles are passed through verbatim — no lane injected", () => {
    const plan = buildSeedPlan(pack());
    const rio = member(entrant(plan, "e-tigers"), "p-rio");
    expect(rio.roles).toEqual(["physio"]);
  });

  it("a player-lane member's roles are untouched too", () => {
    const plan = buildSeedPlan(pack());
    const morgan = member(entrant(plan, "e-lions"), "p-morgan");
    expect(morgan.roles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the coach/staff/official ruling — persons and officials
// ---------------------------------------------------------------------------

describe("buildSeedPlan — the lane ruling on persons/officials", () => {
  it("creates a persons row for player/coach/staff lanes, each carrying its own lane", () => {
    const plan = buildSeedPlan(pack());
    const priya = plan.persons.find((p) => p.ref === "p-priya");
    expect(priya).toEqual({
      ref: "p-priya",
      full_name: "Priya Nair",
      lane: "coach",
      consent: { public_name: true },
    });
    // Inverted deliberately. This asserted `"lane" in priya === false`,
    // because `CreatePerson` had no such field; PR #706 (gap G1) added it, so
    // the field's ABSENCE is now the defect and its presence the contract.
    expect(priya && "lane" in priya).toBe(true);
  });

  it("carries dob/gender only when the pack declares them", () => {
    const plan = buildSeedPlan(pack());
    const eve = plan.persons.find((p) => p.ref === "p-eve");
    expect(eve).toEqual({
      ref: "p-eve",
      full_name: "Eve Kowalski",
      lane: "player",
      dob: "1998-04-12",
      gender: "f",
      consent: { public_name: true },
    });
    const morgan = plan.persons.find((p) => p.ref === "p-morgan");
    expect(morgan).toEqual({
      ref: "p-morgan",
      full_name: "Morgan Ito",
      lane: "player",
      consent: { public_name: true },
    });
    expect(morgan && "dob" in morgan).toBe(false);
    expect(morgan && "gender" in morgan).toBe(false);
  });

  it("never creates an official-lane person via POST /persons", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.persons.some((p) => p.ref === "p-quinn")).toBe(false);
    // The rest of the pool IS still there — this isn't "persons ended up empty".
    expect(plan.persons.map((p) => p.ref).sort()).toEqual(
      ["p-eve", "p-farid", "p-gia", "p-morgan", "p-noor", "p-priya", "p-rio", "p-sam"].sort(),
    );
  });

  it("puts the official-lane person's ref in officialPersonRefs and NOWHERE in any entrant's roster", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.officialPersonRefs).toEqual(["p-quinn"]);
    for (const e of plan.entrants) {
      expect(e.members.some((m) => m.personRef === "p-quinn")).toBe(false);
    }
  });

  it("refuses a pack that rosters an official-lane person as an entrant member, naming the person and the entrant", () => {
    const raw = rawPack() as { entrants: { ref: string; roster: unknown[] }[] };
    const lions = raw.entrants.find((e) => e.ref === "e-lions");
    if (lions === undefined) throw new Error("fixture bug: e-lions missing");
    lions.roster.push({ person: "p-quinn" });
    const bad = PackSchema.parse(raw); // schema-legal: checkRosters does not forbid this
    expect(() => buildSeedPlan(bad)).toThrow(/p-quinn/);
    expect(() => buildSeedPlan(bad)).toThrow(/e-lions/);
  });
});

// ---------------------------------------------------------------------------
// expected fixture counts — league only, reusing pack-io's own arithmetic
// ---------------------------------------------------------------------------

describe("buildSeedPlan — expected fixture counts", () => {
  it("derives one count per LEAGUE stage, and skips the knockout stage rather than mis-answering it", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.expectedFixtureCounts).toHaveLength(2);
    expect(plan.expectedFixtureCounts.find((c) => c.stageRef === "st-football-finals")).toBeUndefined();
  });

  it("pins the VALUE for each division — 2 entrants x 2 legs vs 3 entrants x 1 leg, not the same number by accident", () => {
    const plan = buildSeedPlan(pack());
    const football = plan.expectedFixtureCounts.find((c) => c.stageRef === "st-football-league");
    const cricket = plan.expectedFixtureCounts.find((c) => c.stageRef === "st-cricket-league");
    expect(football).toEqual({ divisionRef: "d-football", stageRef: "st-football-league", count: roundRobinFixtureCount(2, 2) });
    expect(cricket).toEqual({ divisionRef: "d-cricket", stageRef: "st-cricket-league", count: roundRobinFixtureCount(3, 1) });
    expect(football?.count).toBe(2);
    expect(cricket?.count).toBe(3);
    expect(football?.count).not.toBe(cricket?.count);
  });
});

// ---------------------------------------------------------------------------
// tiebreakers and progression — two REAL CreateDivision/CreateStage fields
// ---------------------------------------------------------------------------

describe("buildSeedPlan — fields the create bodies actually accept", () => {
  // Both of these were dropped on the floor by the first cut of this module,
  // and the fixture could not see it because the fixture declared NEITHER —
  // "a fixture with one of something proves nothing" in its purest form,
  // which is zero of something. A pack with real historical tiebreak rules
  // would have had its standings fall back to the default order, and the
  // pack's own `expected.tables` rank assertions would then have failed
  // against the PRODUCT for a value the BENCH failed to send.
  //
  // `_tiny.json` itself declares `"tiebreakers": ["points", "diff"]`, so this
  // was live data loss on the only pack in existence, not a latent risk.
  it("threads division tiebreakers through — CreateDivision.tiebreakers is real (schemas.ts:233)", () => {
    const plan = buildSeedPlan(pack());
    const football = plan.divisions.find((d) => d.ref === "d-football");
    expect(football?.tiebreakers).toEqual(["points", "diff", "h2h_points"]);
  });

  // The sibling division declares none. If the mapping ever defaults or
  // copies, this is what catches it — a blanket-applied value is as wrong as
  // a dropped one, and only a fixture with BOTH shapes can tell them apart.
  it("leaves tiebreakers absent for a division that declares none, rather than defaulting", () => {
    const plan = buildSeedPlan(pack());
    const cricket = plan.divisions.find((d) => d.ref === "d-cricket");
    expect(cricket && "tiebreakers" in cricket).toBe(false);
  });

  it("threads stage progression through — CreateStage.progression is real (schemas.ts:819)", () => {
    const plan = buildSeedPlan(pack());
    const finals = plan.divisions
      .find((d) => d.ref === "d-football")
      ?.stages.find((st) => st.ref === "st-football-finals");
    expect(finals?.progression).toEqual({ from: "st-football-league", take: 4 });
  });

  it("leaves progression absent on the stages that declare none", () => {
    const plan = buildSeedPlan(pack());
    const league = plan.divisions
      .find((d) => d.ref === "d-football")
      ?.stages.find((st) => st.ref === "st-football-league");
    expect(league && "progression" in league).toBe(false);
  });

  // `CreateStage` is `.strict()` (schemas.ts:821), so a stage body carrying a
  // key the schema does not declare is REJECTED rather than ignored —
  // unlike `CreateDivision`, which is non-strict and silently drops unknown
  // keys (the RS007/V380 comment at schemas.ts:233 records a wizard that lost
  // its whole eligibility block exactly that way). Sending an undefined-valued
  // key is therefore not free here, which is why absence is asserted above as
  // a MISSING KEY and not merely as `undefined`.
  it("names the create-body fields exactly as the API spells them", () => {
    const plan = buildSeedPlan(pack());
    const football = plan.divisions.find((d) => d.ref === "d-football");
    expect(football?.sport_key).toBe("football");
    expect(football?.variant_key).toBe("outdoor11");
  });
});

// ---------------------------------------------------------------------------
// consent — the difference between a seeded person and a VISIBLE one
// ---------------------------------------------------------------------------

describe("buildSeedPlan — person consent", () => {
  // `CreatePerson.consent` is `Consent` (schemas.ts:480-485), which is
  // `.default({})` — so omitting it is legal and lands `{}`. That is the
  // trap: `public_players_v` is OPT-IN, not opt-out. Its predicate is
  // `where coalesce((p.consent->>'public_name')::boolean, false)`, unchanged
  // across all three versions of the view (V237 -> V307 -> V350), so a person
  // seeded with `{}` has NO player card at all.
  //
  // That matters three sessions from now rather than here: bench design §4
  // names "stats/leaderboards/player cards/standings/news" as the browsable
  // payoff the suites assert against, and B05 owns those oracles. A person
  // seeded without consent would make the player-card oracle read an empty
  // view and report the PRODUCT as broken — an oracle asserting against a
  // state the bench itself created.
  //
  // `public_name: true` is not invented here: it is what the product's own
  // primary registration path writes on its INSERT branch
  // (`usecases/registrations.ts:670`, "consent defaults to public_name=true
  // on the INSERT branch only (ruling 5)"). A bench-seeded person is the
  // admin-side analogue of that registrant.
  it("grants public_name so seeded persons appear in public_players_v", () => {
    const plan = buildSeedPlan(pack());
    for (const p of plan.persons) {
      expect(p.consent).toEqual({ public_name: true });
    }
  });

  it("grants it to coach and staff lanes too, not only players", () => {
    const plan = buildSeedPlan(pack());
    const coach = plan.persons.find((p) => p.ref === "p-priya");
    const staff = plan.persons.find((p) => p.ref === "p-rio");
    expect(coach?.consent).toEqual({ public_name: true });
    expect(staff?.consent).toEqual({ public_name: true });
  });
});

// ---------------------------------------------------------------------------
// lane (G1 / PR #706)
// ---------------------------------------------------------------------------

describe("buildSeedPlan — persons carry their pack lane", () => {
  it("maps each non-official lane onto CreatePerson.lane, player included", () => {
    const plan = buildSeedPlan(pack());
    const laneOf = (ref: string) => plan.persons.find((p) => p.ref === ref)?.lane;
    // Derived from the fixture's own declarations rather than a table typed
    // in here, so a fixture edit moves the expectation with it.
    for (const declared of pack().persons) {
      if (declared.lane === "official") continue;
      expect(laneOf(declared.ref), `lane for ${declared.ref}`).toBe(declared.lane);
    }
    // And at least one case where the right answer differs from "player",
    // or the assertion could not witness a blanket default.
    expect(laneOf("p-priya")).toBe("coach");
    expect(laneOf("p-rio")).toBe("staff");
    expect(laneOf("p-morgan")).toBe("player");
  });

  it("never emits an official lane — officials get no persons row from this plan", () => {
    const plan = buildSeedPlan(pack());
    expect(plan.persons.map((p) => p.lane)).not.toContain("official");
    expect(plan.officialPersonRefs).toContain("p-quinn");
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// officials + claim invites (B03 T6)
// ---------------------------------------------------------------------------
//
// A dedicated, minimal pack rather than an extension of `rawPack()` above:
// an official's `assignments` need at least one declared stream to resolve
// against (`checkReservations`, pack-schema.ts:2093-2107), and adding one to
// the shared fixture would ripple into every other describe block in this
// file. off-ref1 is MANUAL (a named assignment onto fx-1, and a roleKey that
// deliberately differs from its OWN role_keys[0] — "linesman" vs declared
// ["referee","linesman"] — so a bug that silently defaulted the assignment's
// role instead of carrying the pack's own choice would be visible). off-ref2
// is AUTO (no assignments at all, and no `roleKeys` declared either, to pin
// the schema default `["referee"]` survives the pack -> plan hop).
function officialsRawPack(): unknown {
  return {
    schemaVersion: 1,
    suite: "_officials-fixture",
    org: { name: "Bayview Sports Club", slug: "bayview-sc", timezone: "UTC" },
    competition: { name: "Bayview Series", endsOn: "2027-09-01" },
    divisions: [
      {
        ref: "d-main",
        name: "Main",
        sportKey: "generic",
        variantKey: "score",
        moduleVersion: "1.0.0",
        cfgOverrides: {},
        stages: [
          { ref: "s-league", seq: 1, kind: "league", name: "League", config: { legs: 1 }, seeding: ["e-a", "e-b"] },
        ],
      },
    ],
    persons: [
      { ref: "p-a", fullName: "Ada Lin", lane: "player" },
      { ref: "p-b", fullName: "Bela Novak", lane: "player" },
      { ref: "p-ref1", fullName: "Robin Ferreira", lane: "official" },
      { ref: "p-ref2", fullName: "Sasha Weller", lane: "official" },
    ],
    entrants: [
      {
        ref: "e-a",
        divisionRef: "d-main",
        kind: "individual",
        displayName: "Ada Lin",
        roster: [{ person: "p-a", captain: true }],
      },
      {
        ref: "e-b",
        divisionRef: "d-main",
        kind: "individual",
        displayName: "Bela Novak",
        roster: [{ person: "p-b", captain: true }],
      },
    ],
    streams: [
      {
        divisionRef: "d-main",
        fixtureExtKey: "fx-1",
        home: "e-a",
        away: "e-b",
        provenance: "real",
        events: [
          { type: "core.start" },
          { type: "generic.result", payload: { p1Score: 1, p2Score: 0 } },
        ],
      },
    ],
    officials: [
      {
        ref: "off-ref1",
        person: "p-ref1",
        displayName: "Robin Ferreira",
        roleKeys: ["referee", "linesman"],
        maxPerDay: 2,
        unavailable: [
          { date: "2027-08-20", note: "on leave" },
          { date: "2027-08-21" },
        ],
        assignments: [{ divisionRef: "d-main", fixtureExtKey: "fx-1", roleKey: "linesman" }],
      },
      {
        ref: "off-ref2",
        person: "p-ref2",
        displayName: "Sasha Weller",
        assignments: [],
      },
    ],
    claimInvites: [{ person: "p-a", email: "ada.claim@example.com" }],
    expected: {
      matches: [
        {
          divisionRef: "d-main",
          fixtureExtKey: "fx-1",
          outcome: { kind: "win", winner: "e-a", loser: "e-b", method: "regulation" },
          perSide: [
            { entrant: "e-a", line: "1" },
            { entrant: "e-b", line: "0" },
          ],
        },
      ],
    },
    meta: { synthetic: true },
  };
}

function officialsPack(): Pack {
  return PackSchema.parse(officialsRawPack());
}

describe("buildSeedPlan — officials", () => {
  it("resolves display_name/role_keys/max_per_day/unavailable/assignments field-for-field", () => {
    const plan = buildSeedPlan(officialsPack());
    const ref1 = plan.officials.find((o) => o.ref === "off-ref1");
    expect(ref1).toEqual({
      ref: "off-ref1",
      personRef: "p-ref1",
      display_name: "Robin Ferreira",
      role_keys: ["referee", "linesman"],
      max_per_day: 2,
      unavailable: [
        { date: "2027-08-20", note: "on leave" },
        { date: "2027-08-21" },
      ],
      assignments: [{ divisionRef: "d-main", fixtureExtKey: "fx-1", roleKey: "linesman" }],
    });
  });

  it("defaults role_keys to ['referee'] when the pack omits roleKeys — the schema default survives the hop", () => {
    const plan = buildSeedPlan(officialsPack());
    const ref2 = plan.officials.find((o) => o.ref === "off-ref2");
    expect(ref2?.role_keys).toEqual(["referee"]);
    expect(ref2?.max_per_day).toBeUndefined();
    expect(ref2 && "max_per_day" in ref2).toBe(false);
  });

  it("carries personRef through WITHOUT resolving it — PackOfficial.person cannot be honoured by this plan (see the header comment)", () => {
    const plan = buildSeedPlan(officialsPack());
    // Both officials keep their pack person ref, verbatim — this plan has no
    // way to turn either into a real `person_id` (no writer pre-creates a
    // lane="official" persons row; the only one that does, inviteOfficial,
    // needs an email PackOfficial does not declare).
    expect(plan.officials.map((o) => o.personRef).sort()).toEqual(["p-ref1", "p-ref2"]);
  });

  it("the assignment/no-assignment split IS the manual/auto distinction — no separate flag exists on the plan", () => {
    const plan = buildSeedPlan(officialsPack());
    const manual = plan.officials.filter((o) => o.assignments.length > 0);
    const auto = plan.officials.filter((o) => o.assignments.length === 0);
    expect(manual.map((o) => o.ref)).toEqual(["off-ref1"]);
    expect(auto.map((o) => o.ref)).toEqual(["off-ref2"]);
  });

  it("resolves claimInvites[] to {personRef, email}", () => {
    const plan = buildSeedPlan(officialsPack());
    expect(plan.claimInvites).toEqual([{ personRef: "p-a", email: "ada.claim@example.com" }]);
  });

  it("refuses a claim invite naming an official-lane person, naming the person", () => {
    const raw = officialsRawPack() as { claimInvites: unknown[] };
    raw.claimInvites.push({ person: "p-ref1", email: "robin.claim@example.com" });
    const bad = PackSchema.parse(raw); // schema-legal: checkReservations only checks the ref is KNOWN
    expect(() => buildSeedPlan(bad)).toThrow(/p-ref1/);
    expect(() => buildSeedPlan(bad)).toThrow(/lane is "official"/);
  });

  it("a pack that declares no officials/claimInvites resolves to empty arrays, not undefined", () => {
    const plan = buildSeedPlan(pack()); // the shared org/competition fixture — no officials block at all
    expect(plan.officials).toEqual([]);
    expect(plan.claimInvites).toEqual([]);
  });
});

describe("buildSeedPlan — purity", () => {
  it("is deterministic: the same pack produces a deep-equal plan on every call", () => {
    const p = pack();
    expect(buildSeedPlan(p)).toEqual(buildSeedPlan(p));
  });
});
