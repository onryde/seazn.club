// Unit coverage for lib/stats.ts (B03 T6b) — the player-stats baseline.
//
// Same DI shape as every other file in this directory: a recording fake
// `SeedTransport`, never `global.fetch`. Two layers, matching seed.test.ts's
// own precedent ("pure-builder tests cannot see wiring"):
//   * `readPlayerStatsBaseline` end to end through a fake — proves the
//     driver hits all three routes with the right ids/query params and
//     assembles the result correctly.
//   * `playerStatsBaselineIssues` directly, with hand-built baselines —
//     fast, exhaustive on the guard logic itself, including the branch that
//     is INERT against today's live run (see stats.ts's header comment) but
//     is fully exercisable here with a crafted, post-fold-shaped fake.
import { describe, expect, it } from "vitest";
import type { RequestOptions, Session } from "../http.ts";
import {
  playerStatsBaselineIssues,
  readPlayerStatsBaseline,
  type PlayerStatsBaseline,
  type ReadPlayerStatsBaselineInput,
  type RosterMemberRef,
} from "../stats.ts";

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface FakeConfig {
  orgs?: { id: string; slug: string }[];
  divisionSlug?: string;
  personStats?: Record<string, { divisions: { division_id: string; division_name: string; stats: Record<string, number> }[] }>;
  divisionStats?: {
    metrics: { key: string; label: string }[];
    rows: { person_id: string; full_name: string; stats: Record<string, number> }[];
    requires_detailed_scoring: boolean;
  };
  publicStats?: { rows: { name: string; stats: Record<string, number> }[] };
}

const DEFAULT_DIVISION_STATS = { metrics: [], rows: [], requires_detailed_scoring: false };

function fakeStatsTransport(config: FakeConfig = {}): { transport: ReadPlayerStatsBaselineInput["transport"]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const orgs = config.orgs ?? [{ id: "org-1", slug: "bench-org-1" }];
  const divisionSlug = config.divisionSlug ?? "div-tiny-slug";
  const transport = {
    async signIn(_base: string, _s: Session, email: string) {
      calls.push({ method: "SIGNIN", path: email, body: undefined });
      return { has_org: true, org_id: "org-1", redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, path: string, opts?: RequestOptions): Promise<T> {
      const method = opts?.method ?? "GET";
      calls.push({ method, path, body: opts?.body });

      if (method === "GET" && path === "/api/orgs") return orgs as unknown as T;

      const divisionMatch = /^\/api\/v1\/divisions\/([^/]+)$/.exec(path);
      if (method === "GET" && divisionMatch) return { slug: divisionSlug } as T;

      const personStatsMatch = /^\/api\/v1\/persons\/([^/]+)\/stats\?division_id=([^/]+)$/.exec(path);
      if (method === "GET" && personStatsMatch) {
        const personId = personStatsMatch[1]!;
        const read = config.personStats?.[personId];
        if (read === undefined) throw new Error(`fake: no scripted GET /persons/${personId}/stats response`);
        return read as T;
      }

      const divisionStatsMatch = /^\/api\/v1\/divisions\/([^/]+)\/stats\/players$/.exec(path);
      if (method === "GET" && divisionStatsMatch) {
        return (config.divisionStats ?? DEFAULT_DIVISION_STATS) as T;
      }

      const publicMatch = /^\/api\/v1\/public\/orgs\/[^/]+\/competitions\/[^/]+\/divisions\/[^/]+\/stats$/.exec(path);
      if (method === "GET" && publicMatch) {
        return (config.publicStats ?? { rows: [] }) as T;
      }

      throw new Error(`fake stats transport: unhandled ${method} ${path}`);
    },
  };
  return { transport, calls };
}

const ROSTER: RosterMemberRef[] = [
  { personRef: "p-ana", personId: "person-ana", full_name: "Ana Alvarez" },
  { personRef: "p-cho", personId: "person-cho", full_name: "Cho Minjun" },
];

function baseInput(
  transport: ReadPlayerStatsBaselineInput["transport"],
  overrides: Partial<ReadPlayerStatsBaselineInput> = {},
): ReadPlayerStatsBaselineInput {
  return {
    base: "http://bench.example",
    email: "delivered+bench-tiny-abc@resend.dev",
    orgId: "org-1",
    divisionId: "div-tiny",
    roster: ROSTER,
    competitionSlug: "bench-tiny-series",
    transport,
    ...overrides,
  };
}

const EMPTY_PERSON_STATS = { divisions: [] };

describe("readPlayerStatsBaseline", () => {
  it("looks up the org's own slug via GET /api/orgs — never a pack-declared slug (seed.ts's own finding: there is no such route)", async () => {
    const { transport, calls } = fakeStatsTransport({
      orgs: [{ id: "org-other", slug: "wrong" }, { id: "org-1", slug: "bench-org-real" }],
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    const result = await readPlayerStatsBaseline(baseInput(transport));
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/orgs")).toBe(true);
    expect(result.orgSlug).toBe("bench-org-real");
  });

  it("throws naming the org id when GET /api/orgs never returns it for this session", async () => {
    const { transport } = fakeStatsTransport({ orgs: [{ id: "org-other", slug: "x" }] });
    await expect(readPlayerStatsBaseline(baseInput(transport))).rejects.toThrow(/org-1/);
  });

  it("reads the division's slug back through GET /divisions/{id} — never guessed offline (it is server-generated from name)", async () => {
    const { transport, calls } = fakeStatsTransport({
      divisionSlug: "d-tiny-generated",
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    const result = await readPlayerStatsBaseline(baseInput(transport));
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/v1/divisions/div-tiny")).toBe(true);
    expect(result.divisionSlug).toBe("d-tiny-generated");
  });

  it("queries GET /persons/{id}/stats INDIVIDUALLY for every roster member, scoped to this division", async () => {
    const { transport, calls } = fakeStatsTransport({
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    const result = await readPlayerStatsBaseline(baseInput(transport));
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/v1/persons/person-ana/stats?division_id=div-tiny")).toBe(
      true,
    );
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/v1/persons/person-cho/stats?division_id=div-tiny")).toBe(
      true,
    );
    expect(result.personStatsByPersonRef.get("p-ana")).toEqual(EMPTY_PERSON_STATS);
    expect(result.personStatsByPersonRef.get("p-cho")).toEqual(EMPTY_PERSON_STATS);
  });

  it("hits the ORG-authenticated division leaderboard exactly once, regardless of roster size", async () => {
    const { transport, calls } = fakeStatsTransport({
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    await readPlayerStatsBaseline(baseInput(transport));
    const hits = calls.filter((c) => c.method === "GET" && c.path === "/api/v1/divisions/div-tiny/stats/players");
    expect(hits).toHaveLength(1);
  });

  it("hits the PUBLIC route with orgSlug/competitionSlug/divisionSlug, all real reads — never a pack-declared division slug", async () => {
    const { transport, calls } = fakeStatsTransport({
      orgs: [{ id: "org-1", slug: "real-org-slug" }],
      divisionSlug: "real-division-slug",
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    await readPlayerStatsBaseline(baseInput(transport, { competitionSlug: "bench-tiny-series" }));
    expect(
      calls.some(
        (c) =>
          c.method === "GET" &&
          c.path === "/api/v1/public/orgs/real-org-slug/competitions/bench-tiny-series/divisions/real-division-slug/stats",
      ),
    ).toBe(true);
  });

  it("skips the public route entirely — and leaves publicDivisionStats ABSENT — when competitionSlug is undefined", async () => {
    const { transport, calls } = fakeStatsTransport({
      personStats: { "person-ana": EMPTY_PERSON_STATS, "person-cho": EMPTY_PERSON_STATS },
    });
    const result = await readPlayerStatsBaseline(baseInput(transport, { competitionSlug: undefined }));
    expect(calls.some((c) => c.path.includes("/api/v1/public/"))).toBe(false);
    expect(result.publicDivisionStats).toBeUndefined();
  });

  it("assembles the full baseline from real, distinct reads — never a shared/echoed value across routes", async () => {
    const { transport } = fakeStatsTransport({
      orgs: [{ id: "org-1", slug: "bench-org-1" }],
      divisionSlug: "d-tiny",
      personStats: {
        "person-ana": { divisions: [] },
        "person-cho": { divisions: [{ division_id: "div-tiny", division_name: "Tiny", stats: { points: 0 } }] },
      },
      divisionStats: { metrics: [{ key: "points", label: "Points" }], rows: [], requires_detailed_scoring: false },
      publicStats: { rows: [] },
    });
    const result = await readPlayerStatsBaseline(baseInput(transport));
    expect(result.personStatsByPersonRef.get("p-cho")?.divisions).toHaveLength(1);
    expect(result.divisionStats.metrics).toEqual([{ key: "points", label: "Points" }]);
    expect(result.publicDivisionStats).toEqual({ rows: [] });
  });
});

// ---------------------------------------------------------------------------
// playerStatsBaselineIssues — the pure guard
// ---------------------------------------------------------------------------

function baselineWith(overrides: Partial<PlayerStatsBaseline> = {}): PlayerStatsBaseline {
  return {
    orgSlug: "org-slug",
    divisionSlug: "div-slug",
    personStatsByPersonRef: new Map([
      ["p-ana", EMPTY_PERSON_STATS],
      ["p-cho", EMPTY_PERSON_STATS],
    ]),
    divisionStats: { metrics: [], rows: [], requires_detailed_scoring: false },
    publicDivisionStats: { rows: [] },
    ...overrides,
  };
}

describe("playerStatsBaselineIssues", () => {
  it("is clean against today's REAL baseline shape — reachable, empty rows, requires_detailed_scoring false", () => {
    expect(playerStatsBaselineIssues(baselineWith(), ROSTER)).toEqual([]);
  });

  it("flags a roster person with no recorded read-back at all — the coverage check, real against today's baseline", () => {
    const baseline = baselineWith({ personStatsByPersonRef: new Map([["p-ana", EMPTY_PERSON_STATS]]) });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("p-cho"))).toBe(true);
  });

  it("flags a division-leaderboard row for a person OUTSIDE the seeded roster — real regardless of fold state", () => {
    const baseline = baselineWith({
      divisionStats: {
        metrics: [],
        rows: [{ person_id: "person-STRANGER", full_name: "Nobody", stats: {} }],
        requires_detailed_scoring: false,
      },
    });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("person-STRANGER"))).toBe(true);
  });

  it("flags a duplicate person_id in the division leaderboard", () => {
    const baseline = baselineWith({
      divisionStats: {
        metrics: [],
        rows: [
          { person_id: "person-ana", full_name: "Ana Alvarez", stats: {} },
          { person_id: "person-ana", full_name: "Ana Alvarez", stats: {} },
        ],
        requires_detailed_scoring: false,
      },
    });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("person-ana") && i.includes("twice"))).toBe(true);
  });

  it("flags requires_detailed_scoring=true against an unscored division — DERIVED false, not guessed", () => {
    const baseline = baselineWith({ divisionStats: { metrics: [], rows: [], requires_detailed_scoring: true } });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("requires_detailed_scoring"))).toBe(true);
  });

  // --- the public-projection consent check: INERT against today's live run
  // (empty rows), fully exercisable here with a crafted, post-fold-shaped
  // fake — see stats.ts's header comment on why. ---

  it("passes clean once the public table is populated with every roster person's FULL name (the consent this seed writes)", () => {
    const baseline = baselineWith({
      publicDivisionStats: { rows: [{ name: "Ana Alvarez", stats: { points: 3 } }, { name: "Cho Minjun", stats: { points: 1 } }] },
    });
    expect(playerStatsBaselineIssues(baseline, ROSTER)).toEqual([]);
  });

  it("catches a consent regression — INITIALS instead of the full name every seeded person consents to", () => {
    // "Ana Alvarez" -> "A.A." is exactly what public_person_name() returns
    // when consent.public_name is NOT true (V229__fn_public_person_name.sql)
    // — the shape a seeding regression (dropping seed-plan.ts's own
    // `{public_name:true}`) would actually produce.
    const baseline = baselineWith({ publicDivisionStats: { rows: [{ name: "A.A.", stats: { points: 3 } }] } });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("A.A.") && i.includes("consent"))).toBe(true);
  });

  it("catches an unrecognised name in the public table — a stranger, or a leak from another division", () => {
    const baseline = baselineWith({ publicDivisionStats: { rows: [{ name: "Someone Else", stats: {} }] } });
    const issues = playerStatsBaselineIssues(baseline, ROSTER);
    expect(issues.some((i) => i.includes("Someone Else"))).toBe(true);
  });

  it("does nothing with the public check when publicDivisionStats is absent (no competition slug)", () => {
    const baseline = baselineWith({ publicDivisionStats: undefined });
    expect(playerStatsBaselineIssues(baseline, ROSTER)).toEqual([]);
  });
});
