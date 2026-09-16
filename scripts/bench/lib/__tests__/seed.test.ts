// Unit coverage for lib/seed.ts — the HTTP driver.
//
// Every call this file makes goes through the injected `SeedTransport`
// (seed.ts's own header comment: same DI shape as `runPreflight`'s
// `PreflightProbes` in lib/env.ts) — NOTHING here touches `global.fetch`,
// unlike lib/__tests__/http.test.ts, which mocks it deliberately to test
// `request()` itself. This suite is DB-free and server-free, matching CI's
// own comment on why the bench lib suite has no live-infra dependency
// (.github/workflows/ci.yml:167-170).
//
// Two layers of coverage, on purpose (AGENTS.md recurring-failure class 2 —
// "pure-builder tests cannot see wiring"):
//   * `bindStreamFixtures` directly — fast, exhaustive on the KEY-matching
//     logic itself (shuffled order, two divisions sharing an ext_key, both
//     error paths, the null-ext_key decision).
//   * `seedSuite` end-to-end through a recording fake transport — proves the
//     DRIVER threads each generated fixture's OWNING division through
//     correctly before it ever reaches the binder, which a pure test of the
//     binder alone cannot see (the binder is handed already-correct input by
//     construction in every one of its own tests).
import { describe, expect, it } from "vitest";
import type { RequestOptions, Session } from "../http.ts";
import { fixtureKey, type PackStream, type PackVenue } from "../pack-schema.ts";
import type { SeedPlan, SeedPlanClaimInvite, SeedPlanOfficial } from "../seed-plan.ts";
import {
  bindStreamFixtures,
  officialInviteEmail,
  runOfficialsAutoAssign,
  seedOfficialsAndClaims,
  seedSuite,
  stageKey,
  type GeneratedFixtureRef,
  type RunOfficialsAutoAssignInput,
  type SeedOfficialsAndClaimsInput,
  type SeedSuiteInput,
  type SeedTransport,
} from "../seed.ts";

// A minimal, legal PackEvent (pack-schema.ts:546-563) — enough to satisfy
// PackStream's required `events` field; its content is never read by
// anything under test here.
const EV = { type: "generic.result", payload: {} } as const;

function stream(divisionRef: string, fixtureExtKey: string, home: string, away: string): PackStream {
  return {
    divisionRef,
    fixtureExtKey,
    home,
    away,
    provenance: "real",
    events: [EV],
  };
}

// ---------------------------------------------------------------------------
// stageKey — the division + stage-ref join (Ruling R26 / CRUX 2)
// ---------------------------------------------------------------------------

describe("stageKey — the division + stage-ref join", () => {
  it("is injective over arbitrary strings, not just today's PackRef charset", () => {
    // Mirrors fixtureKey's own test one-for-one (pack-schema.test.ts,
    // "fixtureKey — the division + ext_key join"). A `${division} ${stageRef}`
    // join would merge these two into one bucket ("d-a b s-1"), and a
    // genuinely duplicated stage ref across divisions would then hide behind
    // the collision. Today's PackRef happens to forbid spaces so a
    // space-delimiter join is accidentally safe (as the seed.ts header
    // comment for stageKey warns: it "must not quietly depend on PackRef's
    // current character class") — this test is what stops that accident from
    // being load-bearing.
    expect(stageKey("d-a", "s rr-1")).not.toBe(stageKey("d-a s", "rr-1"));
    expect(stageKey("d", '"x')).not.toBe(stageKey('d"', "x"));
  });

  it("is stable — the same pair always yields the same key", () => {
    expect(stageKey("d-main", "s-playoff")).toBe(stageKey("d-main", "s-playoff"));
  });
});

// ---------------------------------------------------------------------------
// bindStreamFixtures — the pure key-matching logic
// ---------------------------------------------------------------------------

describe("bindStreamFixtures", () => {
  it("binds by ext_key, NEVER by array position — fixtures arrive shuffled relative to the streams", () => {
    const streams = [
      stream("d1", "k1", "e1", "e2"),
      stream("d1", "k2", "e1", "e2"),
      stream("d1", "k3", "e1", "e2"),
    ];
    // Deliberately NOT in stream order — every positional pairing below is
    // wrong, so a binder that (re)introduced index-based matching fails on
    // all three, not just one.
    const fixtures: GeneratedFixtureRef[] = [
      { divisionRef: "d1", extKey: "k3", id: "fx-3" },
      { divisionRef: "d1", extKey: "k1", id: "fx-1" },
      { divisionRef: "d1", extKey: "k2", id: "fx-2" },
    ];

    const map = bindStreamFixtures(streams, fixtures);

    expect(map.size).toBe(3);
    expect(map.get(fixtureKey("d1", "k1"))).toBe("fx-1"); // positional (index 0) would say "fx-3"
    expect(map.get(fixtureKey("d1", "k2"))).toBe("fx-2"); // positional (index 1) would say "fx-1"
    expect(map.get(fixtureKey("d1", "k3"))).toBe("fx-3"); // positional (index 2) would say "fx-2"
  });

  it("two divisions sharing the SAME ext_key string bind to their own division's fixture, not a global match", () => {
    const streams = [stream("d1", "shared", "e1", "e2"), stream("d2", "shared", "e3", "e4")];
    // d2's fixture is listed FIRST, so a global (non-composite) map keyed
    // only on ext_key would end up with "shared" -> "fx-d1" (the later
    // write wins) for BOTH divisions — this is the exact defect the
    // composite key exists to prevent (pack-schema.ts:621-624,
    // fixtureKey's own doc at :1315-1332).
    const fixtures: GeneratedFixtureRef[] = [
      { divisionRef: "d2", extKey: "shared", id: "fx-d2" },
      { divisionRef: "d1", extKey: "shared", id: "fx-d1" },
    ];

    const map = bindStreamFixtures(streams, fixtures);

    expect(map.get(fixtureKey("d1", "shared"))).toBe("fx-d1");
    expect(map.get(fixtureKey("d2", "shared"))).toBe("fx-d2");
  });

  it("a stream matching no generated fixture throws, naming the stream's division and ext_key", () => {
    const streams = [stream("d1", "k1", "e1", "e2"), stream("d1", "missing-key", "e1", "e2")];
    const fixtures: GeneratedFixtureRef[] = [{ divisionRef: "d1", extKey: "k1", id: "fx-1" }];

    expect(() => bindStreamFixtures(streams, fixtures)).toThrow(
      /division "d1" ext_key "missing-key"/,
    );
  });

  it("a generated fixture no stream claims throws, naming that fixture's key and id", () => {
    const streams = [stream("d1", "k1", "e1", "e2")];
    const fixtures: GeneratedFixtureRef[] = [
      { divisionRef: "d1", extKey: "k1", id: "fx-1" },
      { divisionRef: "d1", extKey: "k2", id: "fx-2" },
    ];

    expect(() => bindStreamFixtures(streams, fixtures)).toThrow(/fx-2/);
  });

  it("a generated fixture with a null ext_key throws immediately — never collapses into a map key of the string \"null\"", () => {
    const fixtures: GeneratedFixtureRef[] = [{ divisionRef: "d1", extKey: null, id: "fx-null" }];

    expect(() => bindStreamFixtures([], fixtures)).toThrow(/fx-null/);
    expect(() => bindStreamFixtures([], fixtures)).toThrow(/no ext_key/);
  });

  // B06b — a bracket settles its own BYES at creation (`stages.ts:1351` stamps
  // `forfeited` on any generated game carrying an `award`), and a bye cannot
  // be a stream at all: `PackStream` requires BOTH `home` and `away` and its
  // `events` is `.min(1)`. Suite 11 is the first pack with byes — 49 of them
  // across two 128-slot draws — and the unclaimed guard refused the entire
  // seed before this.
  it("a generated BYE needs no stream — it was already settled by the generator", () => {
    const streams = [stream("d1", "k1", "e1", "e2")];
    const fixtures: GeneratedFixtureRef[] = [
      { divisionRef: "d1", extKey: "k1", id: "fx-1" },
      { divisionRef: "d1", extKey: "k-bye", id: "fx-bye", status: "forfeited" },
    ];

    const map = bindStreamFixtures(streams, fixtures);
    // Bound: the real match. NOT bound: the bye — there is nothing to fold
    // onto it, so it must not appear in the map either.
    expect([...map.keys()]).toEqual([fixtureKey("d1", "k1")]);
  });

  it("still throws for an unclaimed fixture that is merely SCHEDULED", () => {
    // The exemption is positive — the fixture must actually be settled. An
    // exemption written as "ignore unclaimed" would have hidden exactly the
    // missing-stream defect this guard exists for.
    const streams = [stream("d1", "k1", "e1", "e2")];
    const fixtures: GeneratedFixtureRef[] = [
      { divisionRef: "d1", extKey: "k1", id: "fx-1" },
      { divisionRef: "d1", extKey: "k2", id: "fx-2", status: "scheduled" },
    ];

    expect(() => bindStreamFixtures(streams, fixtures)).toThrow(/fx-2 \(scheduled\)/);
  });

  it("treats an ABSENT status as scheduled — the strict side", () => {
    // Dozens of hand-built refs in this suite predate the field. Absent must
    // read as "owes a stream", never as a free pass.
    const fixtures: GeneratedFixtureRef[] = [{ divisionRef: "d1", extKey: "k2", id: "fx-2" }];

    expect(() => bindStreamFixtures([], fixtures)).toThrow(/fx-2 \(scheduled\)/);
  });
});

// ---------------------------------------------------------------------------
// seedSuite — end to end, through a recording fake transport
// ---------------------------------------------------------------------------

/** Deterministic, content-addressed id assignment: every fake response's id
 *  is derived from the request body's own name field, never from call
 *  order — so the fixture below reads the same whichever order `Promise.all`
 *  happens to fire its callbacks in, and a test can predict every id up
 *  front instead of capturing it off a live response. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function fakeTransport(generateFixturesByStageId: Record<string, { id: string; ext_key: string | null }[]>): {
  transport: SeedTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: SeedTransport = {
    async signIn(_base: string, _s: Session, email: string) {
      calls.push({ method: "SIGNIN", path: email, body: undefined });
      return { has_org: true, org_id: "org-1", redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, path: string, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? "GET";
      const body = opts?.body;
      calls.push({ method, path, body });

      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(path)) {
        return { id: `venue-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues\/[^/]+\/courts$/.test(path)) {
        return { id: `court-${slug((body as { name: string }).name)}` } as T;
      }
      // The calendar route's real response is `CourtCalendar` — the stored
      // rows plus two advisory stranded-fixture counts (schemas.ts:4556).
      // It is deliberately NOT an echo of the request: `seedVenuesAndCourts`
      // must not start reading its own write back as though it were a fetch,
      // and a fake that echoed would hide it if it did.
      if (method === "PUT" && /^\/api\/v1\/orgs\/[^/]+\/courts\/[^/]+\/calendar$/.test(path)) {
        return {
          hours: [],
          exceptions: [],
          strandedFixtureCount: 0,
          newlyStrandedFixtureCount: 0,
        } as T;
      }
      if (method === "POST" && path === "/api/v1/persons") {
        return { id: `person-${slug((body as { full_name: string }).full_name)}` } as T;
      }
      if (method === "POST" && path === "/api/v1/competitions") {
        return { id: `comp-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(path)) {
        return { id: `div-${slug((body as { name: string }).name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/stages$/.test(path)) {
        const stages = body as { name: string }[];
        return stages.map((st) => ({ id: `stage-${slug(st.name)}` })) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/entrants$/.test(path)) {
        const rows = body as { display_name: string }[];
        return rows.map((e) => ({ id: `entrant-${slug(e.display_name)}` })) as unknown as T;
      }
      const generateMatch = /^\/api\/v1\/stages\/([^/]+)\/generate$/.exec(path);
      if (method === "POST" && generateMatch) {
        const stageId = generateMatch[1]!;
        const fixtures = generateFixturesByStageId[stageId];
        if (!fixtures) throw new Error(`fake transport: no scripted /generate response for stage "${stageId}"`);
        return { fixtures } as unknown as T;
      }
      throw new Error(`fake transport: unhandled ${method} ${path}`);
    },
  };
  return { transport, calls };
}

describe("seedSuite — single division, no venues (the _tiny shape)", () => {
  const plan: SeedPlan = {
    org: { name: "Riverside", slug: "riverside", timezone: "UTC" },
    competition: { name: "Riverside Cup", endsOn: "2027-01-01" },
    divisions: [
      {
        ref: "d1",
        name: "Open Division",
        sport_key: "football",
        variant_key: "outdoor11",
        config: {},
        stages: [{ ref: "st1", seq: 1, kind: "league", name: "League One", config: { legs: 1 } }],
      },
    ],
    persons: [{ ref: "p1", full_name: "Alice Anders", lane: "player", consent: { public_name: true } }],
    entrants: [
      {
        ref: "e1",
        divisionRef: "d1",
        kind: "team",
        display_name: "Team Alpha",
        members: [{ personRef: "p1", is_captain: true, roles: [] }],
      },
      { ref: "e2", divisionRef: "d1", kind: "team", display_name: "Team Beta", members: [] },
    ],
    officialPersonRefs: [],
    officials: [],
    claimInvites: [],
    expectedFixtureCounts: [],
  };

  it("resolves every ref to the real id the fake handed back, and leaves venues/courts as empty maps", async () => {
    const { transport, calls } = fakeTransport({
      "stage-league-one": [{ id: "fx-1", ext_key: "rr-r1-c1" }],
    });
    const input: SeedSuiteInput = {
      base: "http://bench.example",
      plan,
      streams: [stream("d1", "rr-r1-c1", "e1", "e2")],
      runTag: "abc123",
      transport,
    };

    const result = await seedSuite(input);

    expect(result.orgId).toBe("org-1");
    expect(result.competitionId).toBe(`comp-${slug("Riverside Cup abc123")}`);
    expect(result.venueIdByRef.size).toBe(0);
    expect(result.courtIdByRef.size).toBe(0);
    expect(result.divisionIdByRef.get("d1")).toBe("div-open-division");
    expect(result.stageIdByRef.get(stageKey("d1", "st1"))).toBe("stage-league-one");
    expect(result.personIdByRef.get("p1")).toBe("person-alice-anders");
    expect(result.entrantIdByRef.get("e1")).toBe("entrant-team-alpha");
    expect(result.entrantIdByRef.get("e2")).toBe("entrant-team-beta");
    expect(result.fixtureIdByKey.get(fixtureKey("d1", "rr-r1-c1"))).toBe("fx-1");

    // The run tag is THIS layer's parameter (seed.ts header comment) — it
    // lands on both the sign-in email and the competition name, never
    // invented by seed-plan.ts.
    expect(calls).toContainEqual({ method: "SIGNIN", path: "delivered+bench-riverside-abc123@resend.dev", body: undefined });
    const compCall = calls.find((c) => c.path === "/api/v1/competitions");
    expect((compCall?.body as { name: string }).name).toBe("Riverside Cup abc123");

    // The roster member's personRef resolved to the REAL person_id, not
    // left as the pack ref.
    const entrantCall = calls.find((c) => c.path === "/api/v1/divisions/div-open-division/entrants");
    const sentEntrants = entrantCall?.body as { display_name: string; members: { person_id: string }[] }[];
    const alpha = sentEntrants.find((e) => e.display_name === "Team Alpha")!;
    expect(alpha.members).toEqual([{ person_id: "person-alice-anders", is_captain: true, roles: [] }]);

    // The DIVISION create body, asserted field for field.
    //
    // Nothing asserted this body until now, and the gap was not theoretical:
    // renaming the plan's `sportKey` -> `sport_key` (to match what
    // `CreateDivision` actually spells, schemas.ts:229-230) left this file's
    // fixture on the old name, so the driver sent `sport_key: undefined` — a
    // REQUIRED field (`z.string().min(1)`) — and the whole suite stayed green.
    // `tsc` could not see it either: `tsconfig.scripts.json:35` EXCLUDES
    // `scripts/**/*.test.ts`, so a stale fixture in a test file is checked by
    // nothing at all. The live run would have failed on the first division.
    const divisionCall = calls.find((c) => /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(c.path));
    expect(divisionCall?.body).toEqual({
      name: "Open Division",
      sport_key: "football",
      variant_key: "outdoor11",
      config: {},
    });
    // No `tiebreakers` key at all when the plan declares none — `CreateDivision`
    // is NON-strict, so a key sent as `undefined` is silently dropped rather
    // than refused, which is precisely why absence has to be asserted as a
    // missing KEY rather than as an undefined value.
    expect(divisionCall?.body && "tiebreakers" in (divisionCall.body as object)).toBe(false);

    // Same for the stage body, where the asymmetry bites harder: `CreateStage`
    // is `.strict()` (schemas.ts:821), so an undeclared key is REJECTED and a
    // stray `progression: undefined` would fail the create call outright.
    const stageCall = calls.find((c) => c.path === "/api/v1/divisions/div-open-division/stages");
    expect(stageCall?.body).toEqual([
      { seq: 1, kind: "league", name: "League One", config: { legs: 1 } },
    ]);

    // And the persons body, which nothing asserted either — the same hole the
    // division body had, on the field added most recently. `lane` is optional
    // on `CreatePerson` and defaults to 'player' server side, so a driver that
    // dropped it would look correct for a player and silently seed a coach as
    // a player. Asserted as a whole-body equality so an omission fails.
    const personCall = calls.find((c) => c.path === "/api/v1/persons");
    expect(personCall?.body).toEqual({
      full_name: "Alice Anders",
      lane: "player",
      consent: { public_name: true },
    });
  });

  it("propagates bindStreamFixtures' own error when a stream matches no generated fixture", async () => {
    const { transport } = fakeTransport({
      "stage-league-one": [{ id: "fx-1", ext_key: "rr-r1-c1" }],
    });
    const input: SeedSuiteInput = {
      base: "http://bench.example",
      plan,
      // "wrong-key" matches nothing the fake generated.
      streams: [stream("d1", "wrong-key", "e1", "e2")],
      runTag: "abc123",
      transport,
    };

    await expect(seedSuite(input)).rejects.toThrow(/division "d1" ext_key "wrong-key"/);
  });
});

describe("seedSuite — two divisions, venues+courts, and a SHARED ext_key across divisions", () => {
  const venues: PackVenue[] = [
    {
      ref: "v1",
      name: "Main Ground",
      // `hours`/`exceptions` are `.default([])` on `PackCourt`, so a REAL
      // pack always arrives with both present. This literal skips
      // `PackSchema.parse`, so it has to state them itself — `seedSuite` is
      // entitled to a parsed pack and does not re-defend against a
      // half-built one.
      courts: [{ ref: "c1", name: "Court 1", tags: [], hours: [], exceptions: [] }],
    },
  ];

  const plan: SeedPlan = {
    org: { name: "Meadow", slug: "meadow", timezone: "UTC" },
    competition: { name: "Meadow Cup", endsOn: "2027-05-01" },
    divisions: [
      {
        ref: "d1",
        name: "Division One",
        sport_key: "football",
        variant_key: "outdoor11",
        config: {},
        // Declared on d1/st1 ONLY. The sibling division and stage below carry
        // neither, so this fixture catches BOTH failure directions: dropping
        // the field (d1 loses it) and blanket-applying it (d2 gains one it
        // never declared). A fixture where every division looked the same
        // could not tell those apart.
        tiebreakers: ["points", "nrr"],
        stages: [
          {
            ref: "st1",
            seq: 1,
            kind: "league",
            name: "League A",
            config: { legs: 1 },
            progression: { from: "st0", take: 2 },
          },
        ],
      },
      {
        ref: "d2",
        name: "Division Two",
        sport_key: "cricket",
        variant_key: "t20",
        config: {},
        stages: [{ ref: "st2", seq: 1, kind: "league", name: "League B", config: { legs: 1 } }],
      },
    ],
    persons: [
      { ref: "p1", full_name: "Alice Anders", lane: "player", consent: { public_name: true } },
      { ref: "p2", full_name: "Bob Baker", lane: "coach", consent: { public_name: true } },
    ],
    entrants: [
      {
        ref: "e1",
        divisionRef: "d1",
        kind: "team",
        display_name: "Alpha One",
        members: [{ personRef: "p1", is_captain: true, roles: [] }],
      },
      { ref: "e2", divisionRef: "d1", kind: "team", display_name: "Beta One", members: [] },
      {
        ref: "e3",
        divisionRef: "d2",
        kind: "team",
        display_name: "Alpha Two",
        members: [{ personRef: "p2", is_captain: false, roles: ["coach"] }],
      },
      { ref: "e4", divisionRef: "d2", kind: "team", display_name: "Beta Two", members: [] },
    ],
    officialPersonRefs: [],
    officials: [],
    claimInvites: [],
    expectedFixtureCounts: [],
  };

  // BOTH divisions' single stage generates a fixture with the SAME ext_key
  // ("m1") — this is what proves the DRIVER itself (not just
  // bindStreamFixtures, which has its own isolated test for this) tags each
  // generated fixture with its OWNING division rather than the last
  // division processed, or the first, or a shared loop variable.
  const streams = [stream("d1", "m1", "e1", "e2"), stream("d2", "m1", "e3", "e4")];

  it("wires venues/courts, both divisions' entrants, and binds each division's fixture to ITS OWN stream", async () => {
    const { transport, calls } = fakeTransport({
      "stage-league-a": [{ id: "fx-d1-m1", ext_key: "m1" }],
      "stage-league-b": [{ id: "fx-d2-m1", ext_key: "m1" }],
    });
    const input: SeedSuiteInput = {
      base: "http://bench.example",
      plan,
      venues,
      streams,
      runTag: "xyz789",
      transport,
    };

    const result = await seedSuite(input);

    expect(result.venueIdByRef.get("v1")).toBe("venue-main-ground");
    expect(result.courtIdByRef.get("c1")).toBe("court-court-1");
    expect(result.divisionIdByRef.get("d1")).toBe("div-division-one");
    expect(result.divisionIdByRef.get("d2")).toBe("div-division-two");
    expect(result.entrantIdByRef.get("e1")).toBe("entrant-alpha-one");
    expect(result.entrantIdByRef.get("e3")).toBe("entrant-alpha-two");

    // The load-bearing assertion: two divisions, one shared ext_key string,
    // two DIFFERENT fixtures — each stream must land on its own division's
    // fixture, not the other's.
    expect(result.fixtureIdByKey.get(fixtureKey("d1", "m1"))).toBe("fx-d1-m1");
    expect(result.fixtureIdByKey.get(fixtureKey("d2", "m1"))).toBe("fx-d2-m1");
    expect(result.fixtureIdByKey.size).toBe(2);

    // `tiebreakers` and `progression` reach the wire, and reach ONLY the
    // division/stage that declared them.
    //
    // Both are real create-body fields (`CreateDivision.tiebreakers`,
    // schemas.ts:233; `CreateStage.progression`, schemas.ts:819) and both were
    // dropped on the floor by the first cut of the plan builder. That was
    // invisible to every test then in the tree because no fixture declared
    // either — and `_tiny.json` itself declares `"tiebreakers"`, so the only
    // pack in existence was losing its tie order, which would have surfaced
    // much later as the PRODUCT failing that pack's own `expected.tables`
    // rank assertions for a value the BENCH never sent.
    const divisionCalls = calls.filter((c) => /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(c.path));
    const d1Call = divisionCalls.find((c) => (c.body as { name?: string }).name === "Division One");
    expect((d1Call?.body as { tiebreakers?: unknown }).tiebreakers).toEqual(["points", "nrr"]);

    const d2Call = divisionCalls.find((c) => (c.body as { name?: string }).name === "Division Two");
    expect(d2Call?.body && "tiebreakers" in (d2Call.body as object)).toBe(false);

    const st1Call = calls.find((c) => c.path === "/api/v1/divisions/div-division-one/stages");
    expect(st1Call?.body).toEqual([
      { seq: 1, kind: "league", name: "League A", config: { legs: 1 }, progression: { from: "st0", take: 2 } },
    ]);

    // The sibling stage must carry NO `progression` key whatsoever —
    // `CreateStage` is `.strict()`, so `progression: undefined` would be
    // rejected outright rather than ignored.
    // A coach, whose correct lane differs from the column default — without a
    // case like this the assertion above cannot witness a driver that hardcodes
    // "player" or drops the field and lets the server default fill in.
    const coachCall = calls.find(
      (c) => c.path === "/api/v1/persons" && (c.body as { full_name?: string } | undefined)?.full_name === "Bob Baker",
    );
    expect(coachCall?.body).toEqual({
      full_name: "Bob Baker",
      lane: "coach",
      consent: { public_name: true },
    });

    const st2Call = calls.find((c) => c.path === "/api/v1/divisions/div-division-two/stages");
    expect(st2Call?.body).toEqual([{ seq: 1, kind: "league", name: "League B", config: { legs: 1 } }]);
  });

  // -------------------------------------------------------------------------
  // A court's calendar reaches the wire (B04 T7)
  //
  // `PackCourt.hours`/`.exceptions` are validated by `PackSchema` and consumed
  // by `checker.ts`'s court-hours rule off `BoardCourt`. Between those two
  // sits this driver, and until it issued the PUT below the field was a
  // validated-but-unsent seam: a pack could declare a narrow window, stage 0
  // would bless it, the product would schedule against a court that was open
  // all day, and the checker would recompute containment against hours the
  // database never held — reporting clean for the wrong reason.
  //
  // Note the calendar route is ORG-scoped (`/orgs/{id}/courts/{courtId}`),
  // not nested under the venue the court was created through.
  // -------------------------------------------------------------------------
  const calendarPath = "/api/v1/orgs/org-1/courts/court-court-1/calendar";

  it("PUTs a declared calendar to the org-scoped route, renaming camelCase to the wire's snake_case exactly once", async () => {
    const { transport, calls } = fakeTransport({
      "stage-league-a": [{ id: "fx-d1-m1", ext_key: "m1" }],
      "stage-league-b": [{ id: "fx-d2-m1", ext_key: "m1" }],
    });
    await seedSuite({
      base: "http://bench.example",
      plan,
      venues: [
        {
          ref: "v1",
          name: "Main Ground",
          courts: [
            {
              ref: "c1",
              name: "Court 1",
              tags: [],
              hours: [
                { weekday: 6, openMin: 540, closeMin: 720 },
                { weekday: 0, openMin: 600, closeMin: 780 },
              ],
              exceptions: [
                { date: "2027-04-03", closed: true },
                { date: "2027-04-04", closed: false, openMin: 600, closeMin: 660 },
              ],
            },
          ],
        },
      ],
      streams,
      runTag: "xyz789",
      transport,
    });

    const cal = calls.filter((c) => c.path === calendarPath);
    expect(cal).toHaveLength(1);
    expect(cal[0]?.method).toBe("PUT");
    // Whole-body equality, not a key probe: a driver that dropped `exceptions`
    // or emitted `openMin` alongside `open_min` would satisfy any narrower
    // assertion, and `PutCourtCalendarInput` is not strict about extra keys.
    expect(cal[0]?.body).toEqual({
      hours: [
        { weekday: 6, open_min: 540, close_min: 720 },
        { weekday: 0, open_min: 600, close_min: 780 },
      ],
      exceptions: [
        { date: "2027-04-03", closed: true, open_min: null, close_min: null },
        { date: "2027-04-04", closed: false, open_min: 600, close_min: 660 },
      ],
    });

    // Declaration order survives. `court_hours` has no ordering column and
    // `usableWindows` sorts for itself, so this is not a correctness claim
    // about the product — it is a claim about this driver, which must not
    // sort, dedupe or normalise a list the pack author wrote deliberately.
    expect((cal[0]?.body as { hours: { weekday: number }[] }).hours.map((h) => h.weekday)).toEqual([6, 0]);

    // Ordering against the court's own creation: a calendar PUT that raced
    // ahead of the POST would 404 against an id that does not exist yet.
    const courtPost = calls.findIndex(
      (c) => c.method === "POST" && /\/venues\/[^/]+\/courts$/.test(c.path),
    );
    expect(courtPost).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(cal[0]!)).toBeGreaterThan(courtPost);
  });

  it("issues NO calendar call for a court that declares neither hours nor exceptions", async () => {
    // The other direction, and the one that carries the risk: a PUT of two
    // empty arrays is a FULL replace that deletes every row and inserts none.
    // On a freshly created court that is a no-op, so a driver which always
    // PUT would look correct here and would silently wipe a calendar the
    // moment anything else wrote one first. `_tiny`'s own courts take this
    // path, so it is also the default the whole suite runs through.
    const { transport, calls } = fakeTransport({
      "stage-league-a": [{ id: "fx-d1-m1", ext_key: "m1" }],
      "stage-league-b": [{ id: "fx-d2-m1", ext_key: "m1" }],
    });
    await seedSuite({
      base: "http://bench.example",
      plan,
      venues,
      streams,
      runTag: "xyz789",
      transport,
    });

    expect(calls.filter((c) => /\/calendar$/.test(c.path))).toEqual([]);
    // …and the court itself was still created, so the emptiness above is the
    // calendar's, not a venue block that never ran.
    expect(calls.some((c) => c.method === "POST" && /\/venues\/[^/]+\/courts$/.test(c.path))).toBe(true);
  });

  it("PUTs a court that declares ONLY exceptions — the two lists are independently sufficient", async () => {
    // Guards the skip above against being written as `||`: a court with a
    // shutdown date but no weekly hours is open all day EXCEPT that date, and
    // an `||` skip would drop the closure and leave it open all week.
    const { transport, calls } = fakeTransport({
      "stage-league-a": [{ id: "fx-d1-m1", ext_key: "m1" }],
      "stage-league-b": [{ id: "fx-d2-m1", ext_key: "m1" }],
    });
    await seedSuite({
      base: "http://bench.example",
      plan,
      venues: [
        {
          ref: "v1",
          name: "Main Ground",
          courts: [
            {
              ref: "c1",
              name: "Court 1",
              tags: [],
              hours: [],
              exceptions: [{ date: "2027-04-03", closed: true }],
            },
          ],
        },
      ],
      streams,
      runTag: "xyz789",
      transport,
    });

    const cal = calls.filter((c) => c.path === calendarPath);
    expect(cal).toHaveLength(1);
    expect(cal[0]?.body).toEqual({
      hours: [],
      exceptions: [{ date: "2027-04-03", closed: true, open_min: null, close_min: null }],
    });
  });
});

// ---------------------------------------------------------------------------
// seedOfficialsAndClaims — officials + claim invites (B03 T6)
// ---------------------------------------------------------------------------

interface FixtureOfficialsRead {
  official_id: string;
  name: string;
  role: string;
  locked: boolean;
  response: string;
  decline_reason: string | null;
}

interface ClaimRead {
  id: string;
  person_id: string;
  email: string;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
}

interface OfficialsFakeConfig {
  fixtureReads?: Record<string, FixtureOfficialsRead[]>;
  autoProposals?: Record<string, { assignments: { fixtureId: string; officialId: string; roleKey: string; locked?: boolean }[] }>;
  validateResponses?: Record<string, { conflicts: { fixture_id: string; code: string; blocking: boolean }[] }>;
  claimReads?: Record<string, ClaimRead>;
  /** B03 T6b — officials' OWN claim invites (`POST /officials/{id}/invite`).
   *  Keyed by the MINTED person id this fake hands back — same "distinct
   *  GET, never the write's echo" precedent as `claimReads` above. Every
   *  minted person id defaults to `invited-${officialId}` (no config
   *  needed) with a matching default read, so existing tests written before
   *  this task keep passing unmodified; a test that cares about the invite
   *  itself overrides via `officialInviteReads`. */
  officialInviteReads?: Record<string, ClaimRead>;
}

/** A recording fake covering exactly the surface `seedOfficialsAndClaims`
 *  calls. The PATCH .../officials response is deliberately a STALE, wrong
 *  echo — real `patchFixtureOfficials` does return the fresh cache, but this
 *  fake's whole job is proving the driver reads back through its OWN,
 *  distinct `GET /fixtures/{id}` call rather than trusting what a write
 *  returned (this file's own header comment on "not merely 201"). Same for
 *  the claim-invite POST vs its GET: two different shapes, so a test
 *  asserting the read-back result cannot accidentally pass by reusing the
 *  write's response. */
function fakeOfficialsTransport(config: OfficialsFakeConfig): { transport: SeedTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: SeedTransport = {
    async signIn(_base: string, _s: Session, email: string) {
      calls.push({ method: "SIGNIN", path: email, body: undefined });
      return { has_org: true, org_id: "org-1", redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, path: string, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? "GET";
      const body = opts?.body;
      calls.push({ method, path, body });

      if (method === "POST" && path === "/api/v1/officials") {
        return { id: `official-${slug((body as { display_name: string }).display_name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/officials\/[^/]+\/availability$/.test(path)) {
        return { date: (body as { date: string }).date, note: (body as { note?: string }).note ?? null } as T;
      }
      if (method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+\/officials$/.test(path)) {
        return {
          officials: [
            { official_id: "STALE", name: "STALE", role: "STALE", locked: false, response: "pending", decline_reason: null },
          ],
        } as T;
      }
      const getFixtureMatch = /^\/api\/v1\/fixtures\/([^/]+)$/.exec(path);
      if (method === "GET" && getFixtureMatch) {
        const fixtureId = getFixtureMatch[1]!;
        const officials = config.fixtureReads?.[fixtureId];
        if (officials === undefined) throw new Error(`fake: no scripted GET /fixtures/${fixtureId} response`);
        return { officials } as T;
      }
      const autoMatch = /^\/api\/v1\/divisions\/([^/]+)\/officials\/auto$/.exec(path);
      if (method === "POST" && autoMatch) {
        const proposal = config.autoProposals?.[autoMatch[1]!];
        if (proposal === undefined) throw new Error(`fake: no scripted /officials/auto response for division "${autoMatch[1]}"`);
        return proposal as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/apply$/.test(path)) {
        return { applied: (body as { assignments: unknown[] }).assignments.length } as T;
      }
      const validateMatch = /^\/api\/v1\/divisions\/([^/]+)\/schedule\/validate$/.exec(path);
      if (method === "POST" && validateMatch) {
        return (config.validateResponses?.[validateMatch[1]!] ?? { conflicts: [] }) as T;
      }
      const claimMatch = /^\/api\/v1\/persons\/([^/]+)\/claim-invites$/.exec(path);
      if (method === "POST" && claimMatch) {
        return {
          id: "WRITE-ECHO",
          person_id: claimMatch[1],
          email: (body as { email: string }).email,
          expires_at: "2099-01-01T00:00:00Z",
          claimed_at: null,
          revoked_at: null,
          claim_url: "https://bench.example/claim/x",
          email_sent: true,
        } as T;
      }
      if (method === "GET" && claimMatch) {
        const personId = claimMatch[1]!;
        const scripted = config.claimReads?.[personId] ?? config.officialInviteReads?.[personId];
        if (scripted !== undefined) return scripted as T;
        // Default for an officials-invite-minted person id (see the POST
        // handler below) that no test bothered to script explicitly.
        if (personId.startsWith("invited-")) {
          return {
            id: `claim-${personId}`,
            person_id: personId,
            email: "delivered+official-invite-default@resend.dev",
            expires_at: "2099-01-01T00:00:00Z",
            claimed_at: null,
            revoked_at: null,
          } as T;
        }
        throw new Error(`fake: no scripted GET /persons/${personId}/claim-invites response`);
      }
      const inviteMatch = /^\/api\/v1\/officials\/([^/]+)\/invite$/.exec(path);
      if (method === "POST" && inviteMatch) {
        const officialId = inviteMatch[1]!;
        const personId = `invited-${officialId}`;
        return {
          id: "WRITE-ECHO-OFFICIAL-INVITE",
          person_id: personId,
          email: (body as { email: string }).email,
          expires_at: "2099-01-01T00:00:00Z",
          claimed_at: null,
          revoked_at: null,
          claim_url: "https://bench.example/claim/official",
          email_sent: true,
        } as T;
      }
      throw new Error(`fake officials transport: unhandled ${method} ${path}`);
    },
  };
  return { transport, calls };
}

describe("officialInviteEmail", () => {
  it("derives a stable email from the official's ref and the run tag — never a bare literal", () => {
    expect(officialInviteEmail("off-dee", "abc123")).toBe("delivered+bench-official-off-dee-abc123@resend.dev");
  });

  it("two different officials in the same run never collide", () => {
    expect(officialInviteEmail("off-dee", "abc")).not.toBe(officialInviteEmail("off-eli", "abc"));
  });

  it("the same official across two runs never collides either", () => {
    expect(officialInviteEmail("off-dee", "run1")).not.toBe(officialInviteEmail("off-dee", "run2"));
  });

  it("sanitizes a ref character that is legal in a PackRef but not in an email local-part", () => {
    // ":" is legal per PackRef's own regex (pack-schema.ts:176-180) but not
    // a valid unquoted email local-part character.
    expect(officialInviteEmail("off:dee", "abc")).toBe("delivered+bench-official-off-dee-abc@resend.dev");
  });
});

describe("seedOfficialsAndClaims", () => {
  // Mirrors the shape B03 T6 gave `_tiny.json`: off-dee is MANUAL (a named
  // assignment onto rr-r1-c1, a declared blackout), off-eli is AUTO (no
  // assignments at all). One claim invite. `role_keys`/`unavailable` values
  // are chosen so a hand-typed constant in the driver could never agree with
  // them by accident (never "referee" alone, never a round date).
  const officials: SeedPlanOfficial[] = [
    {
      ref: "off-dee",
      personRef: "p-dee",
      display_name: "Dee Duarte",
      role_keys: ["referee"],
      unavailable: [{ date: "2099-01-02", note: "family commitment" }],
      assignments: [{ divisionRef: "d-tiny", fixtureExtKey: "rr-r1-c1", roleKey: "referee" }],
    },
    {
      ref: "off-eli",
      personRef: "p-eli",
      display_name: "Eli Ostrander",
      role_keys: ["linesman"],
      unavailable: [],
      assignments: [],
    },
  ];
  const claimInvites: SeedPlanClaimInvite[] = [{ personRef: "p-ana", email: "delivered+ana.alvarez.claim@resend.dev" }];
  const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fixture-r1"]]);
  const personIdByRef = new Map([["p-ana", "person-ana"]]);

  function baseInput(transport: SeedTransport, overrides: Partial<SeedOfficialsAndClaimsInput> = {}): SeedOfficialsAndClaimsInput {
    return {
      base: "http://bench.example",
      officials,
      claimInvites,
      fixtureIdByKey,
      personIdByRef,
      primaryDivisionId: "div-tiny",
      email: "delivered+bench-tiny-abc@resend.dev",
      runTag: "abc",
      transport,
      ...overrides,
    };
  }

  const HAPPY_CONFIG: OfficialsFakeConfig = {
    fixtureReads: {
      "fixture-r1": [
        { official_id: "official-dee-duarte", name: "Dee Duarte", role: "referee", locked: true, response: "pending", decline_reason: null },
      ],
    },
    // B03 review F3: `seedOfficialsAndClaims` calls `schedule/validate`
    // BEFORE any scheduling exists (it runs from `seedSuite`, which
    // completes before `runTinySuite`'s own scheduling walk) — the real
    // route's `warn.official_unavailable` only fires once the target fixture
    // is actually SCHEDULED onto the blackout date (this file's own header
    // comment, "the blackout read-back finding"), which at THIS call site
    // has not happened. Empty conflicts is the only response the product can
    // actually give here; a non-empty one would be exactly the impossible
    // fake the review found.
    validateResponses: {
      "div-tiny": { conflicts: [] },
    },
    claimReads: {
      "person-ana": {
        id: "claim-1",
        person_id: "person-ana",
        email: "delivered+ana.alvarez.claim@resend.dev",
        expires_at: "2099-01-15T00:00:00Z",
        claimed_at: null,
        revoked_at: null,
      },
    },
  };

  it("creates every official with person_id OMITTED — display_name/role_keys/max_per_day only", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    await seedOfficialsAndClaims(baseInput(transport));

    const created = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/officials");
    expect(created).toHaveLength(2);
    const deeCall = created.find((c) => (c.body as { display_name: string }).display_name === "Dee Duarte");
    expect(deeCall?.body).toEqual({ display_name: "Dee Duarte", role_keys: ["referee"] });
    expect(deeCall?.body && "person_id" in (deeCall.body as object)).toBe(false);
    expect(deeCall?.body && "max_per_day" in (deeCall.body as object)).toBe(false);
  });

  it("sends max_per_day only when the plan carries one", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    const withCap: SeedPlanOfficial[] = [{ ...officials[0]!, max_per_day: 3 }];
    await seedOfficialsAndClaims({ ...baseInput(transport), officials: withCap, claimInvites: [] });
    const created = calls.find((c) => c.method === "POST" && c.path === "/api/v1/officials");
    expect(created?.body).toEqual({ display_name: "Dee Duarte", role_keys: ["referee"], max_per_day: 3 });
  });

  it("sets the blackout with the plan's own date and note", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    await seedOfficialsAndClaims(baseInput(transport));

    const blackoutCall = calls.find((c) => c.method === "POST" && /\/availability$/.test(c.path));
    expect(blackoutCall?.path).toBe("/api/v1/officials/official-dee-duarte/availability");
    expect(blackoutCall?.body).toEqual({ date: "2099-01-02", note: "family commitment" });
  });

  it("PATCHes a manual assignment onto its named fixture, locked, with the pack's own role — never the official's default role", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    await seedOfficialsAndClaims(baseInput(transport));

    const patchCall = calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/fixtures/fixture-r1/officials");
    expect(patchCall?.body).toEqual({
      set: [{ official_id: "official-dee-duarte", role_key: "referee", locked: true }],
    });
  });

  it("groups TWO manual officials sharing one fixture into ONE PATCH call, not two racing writes", async () => {
    const second: SeedPlanOfficial = {
      ref: "off-quinn",
      personRef: "p-quinn",
      display_name: "Quinn Osei",
      role_keys: ["linesman"],
      unavailable: [],
      assignments: [{ divisionRef: "d-tiny", fixtureExtKey: "rr-r1-c1", roleKey: "linesman" }],
    };
    const { transport, calls } = fakeOfficialsTransport({
      fixtureReads: { "fixture-r1": [] },
      claimReads: {},
    });
    await seedOfficialsAndClaims({
      ...baseInput(transport),
      officials: [officials[0]!, second],
      claimInvites: [],
    });

    const patchCalls = calls.filter((c) => c.method === "PATCH" && c.path === "/api/v1/fixtures/fixture-r1/officials");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.body).toEqual({
      set: [
        { official_id: "official-dee-duarte", role_key: "referee", locked: true },
        { official_id: "official-quinn-osei", role_key: "linesman", locked: true },
      ],
    });
  });

  it("defaults an unnamed assignment's role to the official's OWN first role_keys entry", async () => {
    const unnamed: SeedPlanOfficial = { ...officials[0]!, assignments: [{ divisionRef: "d-tiny", fixtureExtKey: "rr-r1-c1" }] };
    const { transport, calls } = fakeOfficialsTransport({ fixtureReads: { "fixture-r1": [] }, claimReads: {} });
    await seedOfficialsAndClaims({ ...baseInput(transport), officials: [unnamed], claimInvites: [] });

    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall?.body).toEqual({ set: [{ official_id: "official-dee-duarte", role_key: "referee", locked: true }] });
  });

  it("throws naming the official and the fixture when a manual assignment matches no generated fixture", async () => {
    const bad: SeedPlanOfficial = { ...officials[0]!, assignments: [{ divisionRef: "d-tiny", fixtureExtKey: "missing-key" }] };
    const { transport } = fakeOfficialsTransport(HAPPY_CONFIG);
    await expect(
      seedOfficialsAndClaims({ ...baseInput(transport), officials: [bad], claimInvites: [] }),
    ).rejects.toThrow(/off-dee.*missing-key/s);
  });

  it("reads back EVERY manually-touched fixture through GET /fixtures/{id} — never the PATCH write's own (stale) body", async () => {
    const { transport } = fakeOfficialsTransport(HAPPY_CONFIG);
    const result = await seedOfficialsAndClaims(baseInput(transport));

    expect(result.fixtureOfficialsById.get("fixture-r1")).toEqual([
      { official_id: "official-dee-duarte", name: "Dee Duarte", role: "referee", locked: true, response: "pending", decline_reason: null },
    ]);
    // The STALE PATCH echo never leaks into the result — proves the GET
    // call, not the write, is what the driver trusts.
    for (const rows of result.fixtureOfficialsById.values()) {
      expect(rows.some((r) => r.official_id === "STALE")).toBe(false);
    }
  });

  // B03 review F3: the OLD version of this test scripted a non-empty
  // `warn.official_unavailable` response here — impossible at THIS call
  // site (see the comment on `HAPPY_CONFIG.validateResponses` above). The
  // call itself is still real and still proven; what it can honestly read
  // back, pre-scheduling, is empty.
  it("calls schedule/validate for the blackout's own division, and reads back exactly what the (honestly empty, pre-scheduling) response carries", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    const result = await seedOfficialsAndClaims(baseInput(transport));

    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/divisions/div-tiny/schedule/validate")).toBe(true);
    expect(result.scheduleConflicts).toEqual([]);
  });

  it("never calls schedule/validate when the plan declares no blackout at all", async () => {
    const noBlackout = officials.map((o) => ({ ...o, unavailable: [] }));
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    await seedOfficialsAndClaims({ ...baseInput(transport), officials: noBlackout });
    expect(calls.some((c) => /\/schedule\/validate$/.test(c.path))).toBe(false);
  });

  it("mints a claim invite with the pack's own email, and reads it back through a DISTINCT GET call — claimed_at null is the proof nothing here accepted it", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    const result = await seedOfficialsAndClaims(baseInput(transport));

    const mintCall = calls.find((c) => c.method === "POST" && c.path === "/api/v1/persons/person-ana/claim-invites");
    expect(mintCall?.body).toEqual({ email: "delivered+ana.alvarez.claim@resend.dev" });
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/v1/persons/person-ana/claim-invites")).toBe(true);

    const read = result.claimInviteByPersonRef.get("p-ana");
    expect(read).toEqual({
      id: "claim-1",
      person_id: "person-ana",
      email: "delivered+ana.alvarez.claim@resend.dev",
      expires_at: "2099-01-15T00:00:00Z",
      claimed_at: null,
      revoked_at: null,
    });
    // The write's own echo carries a different id ("WRITE-ECHO") — this
    // must NOT be what the result holds.
    expect(read?.id).not.toBe("WRITE-ECHO");
  });

  it("throws naming the ref when a claim invite targets a person with no resolved id", async () => {
    const { transport } = fakeOfficialsTransport(HAPPY_CONFIG);
    await expect(
      seedOfficialsAndClaims({ ...baseInput(transport), claimInvites: [{ personRef: "p-ghost", email: "delivered+ghost@resend.dev" }] }),
    ).rejects.toThrow(/p-ghost/);
  });

  // -------------------------------------------------------------------------
  // B03 T6b — officials' OWN claim invites (POST /officials/{id}/invite)
  // -------------------------------------------------------------------------

  it("mints EVERY official's own claim invite, with the derived email — never a bare display_name or literal", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    await seedOfficialsAndClaims(baseInput(transport));

    const inviteCalls = calls.filter((c) => c.method === "POST" && /\/api\/v1\/officials\/[^/]+\/invite$/.test(c.path));
    expect(inviteCalls).toHaveLength(2);
    const deeInvite = inviteCalls.find((c) => c.path === "/api/v1/officials/official-dee-duarte/invite");
    expect(deeInvite?.body).toEqual({ email: officialInviteEmail("off-dee", "abc") });
    const eliInvite = inviteCalls.find((c) => c.path === "/api/v1/officials/official-eli-ostrander/invite");
    expect(eliInvite?.body).toEqual({ email: officialInviteEmail("off-eli", "abc") });
  });

  it("reads each official's invite back through a DISTINCT GET call, keyed by the OFFICIAL's own ref — claimed_at null is the proof nothing here accepted it", async () => {
    const { transport, calls } = fakeOfficialsTransport(HAPPY_CONFIG);
    const result = await seedOfficialsAndClaims(baseInput(transport));

    expect(calls.some((c) => c.method === "GET" && c.path === "/api/v1/persons/invited-official-dee-duarte/claim-invites")).toBe(
      true,
    );
    const read = result.officialClaimInviteByRef.get("off-dee");
    expect(read?.person_id).toBe("invited-official-dee-duarte");
    expect(read?.claimed_at).toBeNull();
    // The write's own echo is a distinct sentinel id — must not be what the
    // result holds, same "not merely 201" precedent as every read-back above.
    expect(read?.id).not.toBe("WRITE-ECHO-OFFICIAL-INVITE");
  });

  it("the minted person is NOT the pack's own PackOfficial.person ref — personIdByRef never resolved it, and the invite mints a brand-new id", async () => {
    // `personIdByRef` in this fixture (like a real SeedPlan's — see
    // seed-plan.ts's own header comment) carries NO entry for "p-dee"/
    // "p-eli" at all: official-lane persons are excluded from `plan.persons`
    // entirely, because `POST /persons` cannot create one (`PersonLane`
    // admits only player/coach/staff). This test is the finding, made
    // concrete: there is no pack-declared id to compare against, and the
    // invite's own minted id is a fresh one this driver never resolved
    // "p-dee"/"p-eli" to.
    expect(personIdByRef.has("p-dee")).toBe(false);
    expect(personIdByRef.has("p-eli")).toBe(false);

    const { transport } = fakeOfficialsTransport(HAPPY_CONFIG);
    const result = await seedOfficialsAndClaims(baseInput(transport));

    const deeInvite = result.officialClaimInviteByRef.get("off-dee");
    expect(deeInvite?.person_id).toBe("invited-official-dee-duarte");
    // Not equal to ANY id this driver resolved for a pack person ref.
    expect([...personIdByRef.values()]).not.toContain(deeInvite?.person_id);
  });
});

// ---------------------------------------------------------------------------
// runOfficialsAutoAssign — B03 review F1(b): the auto pass, split OUT of
// seedOfficialsAndClaims because it is only ever meaningful AFTER scheduling
// exists (officials/auto's own engineInput filters on scheduled_at). Every
// fake below models a fixture that IS already scheduled — that is exactly
// what makes a non-empty `/officials/auto` proposal legitimate to script
// HERE (B03 review F3: it was NOT legitimate at seedOfficialsAndClaims's own
// pre-scheduling call site, which is why that fake moved rather than merely
// being copied).
// ---------------------------------------------------------------------------

describe("runOfficialsAutoAssign", () => {
  const autoOfficials: SeedPlanOfficial[] = [
    {
      ref: "off-eli",
      personRef: "p-eli",
      display_name: "Eli Ostrander",
      role_keys: ["linesman"],
      unavailable: [],
      assignments: [],
    },
  ];

  function baseInput(
    transport: SeedTransport,
    overrides: Partial<RunOfficialsAutoAssignInput> = {},
  ): RunOfficialsAutoAssignInput {
    return {
      base: "http://bench.example",
      email: "delivered+bench-tiny-abc@resend.dev",
      primaryDivisionId: "div-tiny",
      autoOfficials,
      transport,
      ...overrides,
    };
  }

  const NON_EMPTY_PROPOSAL: OfficialsFakeConfig = {
    autoProposals: {
      "div-tiny": {
        assignments: [{ fixtureId: "fixture-auto", officialId: "official-eli-ostrander", roleKey: "linesman" }],
      },
    },
    fixtureReads: {
      "fixture-auto": [
        { official_id: "official-eli-ostrander", name: "Eli Ostrander", role: "linesman", locked: false, response: "pending", decline_reason: null },
      ],
    },
  };

  it("signs in, proposes, then applies against primaryDivisionId, with roles = union of the auto officials' own role_keys", async () => {
    const { transport, calls } = fakeOfficialsTransport(NON_EMPTY_PROPOSAL);
    await runOfficialsAutoAssign(baseInput(transport));

    expect(calls.some((c) => c.method === "SIGNIN")).toBe(true);

    const proposeCall = calls.find((c) => c.method === "POST" && c.path === "/api/v1/divisions/div-tiny/officials/auto");
    expect(proposeCall?.body).toEqual({ policy: { roles: ["linesman"] } });

    const applyCall = calls.find((c) => c.method === "POST" && c.path === "/api/v1/divisions/div-tiny/officials/apply");
    expect(applyCall?.body).toEqual({
      assignments: [{ fixture_id: "fixture-auto", official_id: "official-eli-ostrander", role_key: "linesman", locked: false }],
    });
  });

  it("reads back every fixture the apply call touched through GET /fixtures/{id} — never the apply write's own echo", async () => {
    const { transport } = fakeOfficialsTransport(NON_EMPTY_PROPOSAL);
    const result = await runOfficialsAutoAssign(baseInput(transport));

    expect(result.proposedCount).toBe(1);
    expect(result.appliedCount).toBe(1);
    expect(result.fixtureOfficialsById.get("fixture-auto")).toEqual([
      { official_id: "official-eli-ostrander", name: "Eli Ostrander", role: "linesman", locked: false, response: "pending", decline_reason: null },
    ]);
  });

  it("skips the apply call entirely, and returns zero applied, when the proposal comes back empty — a legitimate post-scheduling response (e.g. no free slot)", async () => {
    const { transport, calls } = fakeOfficialsTransport({ autoProposals: { "div-tiny": { assignments: [] } } });
    const result = await runOfficialsAutoAssign(baseInput(transport));

    expect(calls.some((c) => c.path === "/api/v1/divisions/div-tiny/officials/apply")).toBe(false);
    expect(result.proposedCount).toBe(0);
    expect(result.appliedCount).toBe(0);
    expect(result.fixtureOfficialsById.size).toBe(0);
  });

  it("makes NO http calls at all, not even sign-in, when there are no auto-needing officials", async () => {
    const { transport, calls } = fakeOfficialsTransport({});
    const result = await runOfficialsAutoAssign({ ...baseInput(transport), autoOfficials: [] });

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ proposedCount: 0, appliedCount: 0, fixtureOfficialsById: new Map() });
  });
});
