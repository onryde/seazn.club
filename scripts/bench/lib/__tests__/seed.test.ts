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
import type { SeedPlan } from "../seed-plan.ts";
import {
  bindStreamFixtures,
  seedSuite,
  type GeneratedFixtureRef,
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
    persons: [{ ref: "p1", full_name: "Alice Anders", consent: { public_name: true } }],
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
    expect(result.stageIdByRef.get("st1")).toBe("stage-league-one");
    expect(result.personIdByRef.get("p1")).toBe("person-alice-anders");
    expect(result.entrantIdByRef.get("e1")).toBe("entrant-team-alpha");
    expect(result.entrantIdByRef.get("e2")).toBe("entrant-team-beta");
    expect(result.fixtureIdByKey.get(fixtureKey("d1", "rr-r1-c1"))).toBe("fx-1");

    // The run tag is THIS layer's parameter (seed.ts header comment) — it
    // lands on both the sign-in email and the competition name, never
    // invented by seed-plan.ts.
    expect(calls).toContainEqual({ method: "SIGNIN", path: "bench-riverside-abc123@example.com", body: undefined });
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
      courts: [{ ref: "c1", name: "Court 1", tags: [] }],
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
      { ref: "p1", full_name: "Alice Anders", consent: { public_name: true } },
      { ref: "p2", full_name: "Bob Baker", consent: { public_name: true } },
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
    const st2Call = calls.find((c) => c.path === "/api/v1/divisions/div-division-two/stages");
    expect(st2Call?.body).toEqual([{ seq: 1, kind: "league", name: "League B", config: { legs: 1 } }]);
  });
});
