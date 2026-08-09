// #364 Task 2 — the three marketing-demo seed builders.
//
// The demo fixtures (Task 3) are captured ONCE from a real architect run, and
// the issue's acceptance is that the capture "re-runs and reproduces". That
// only holds if the BOARD the run saw is reproducible, so the contract these
// tests pin is: reseeding a template into a fresh org produces a pack that is
// identical up to the per-seed UUIDs. `normalizeIds` is the equivalence — it
// maps UUIDs to first-seen placeholders, so ORDER stays asserted (a pack whose
// rows reordered maps to different placeholders) while the random ids do not.
//
// Real Postgres required; skipped without DATABASE_URL. The `normalizeIds`
// block is pure and always runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { buildSchedulePack } from "@/server/usecases/schedule-ai";
import { buildCompetitionPack } from "@/server/usecases/competition-schedule-ai";
import {
  normalizeIds,
  seedClubNight,
  seedFinalsDay,
  seedNorthsideOpen,
  type SeededTemplate,
} from "../seeds";

const HAS_DB = !!process.env.DATABASE_URL;

// The capture harness (Task 3) injects the SAME instant, so the pack a demo
// fixture records is the pack this suite proves reproducible. Literal, never
// derived from the clock: `buildSchedulePack` renders "today" from it.
const ANCHOR_NOW = new Date("2026-09-01T08:00:00.000Z").getTime();

/** Finals Day's rain window opens at 13:00 local — the cutoff the already-played
 *  half of that board must sit entirely before. */
const T3_BLACKOUT_FROM = Date.parse("2026-09-26T13:00:00+01:00");

async function fixtureCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures where division_id = ${divisionId}`;
  return n;
}

async function fixturesByStatus(
  divisionId: string,
  status: string,
): Promise<{ id: string; scheduled_at: Date | null }[]> {
  return sql<{ id: string; scheduled_at: Date | null }[]>`
    select id, scheduled_at from fixtures
    where division_id = ${divisionId} and status = ${status}
    order by fixture_no`;
}

/** The pack the capture harness will hand the model, for whichever surface the
 *  template declares — one division, or the joint competition pack. */
async function packFor(auth: AuthCtx, t: SeededTemplate): Promise<unknown> {
  const opts = { mode: t.mode, instruction: t.instruction, now: ANCHOR_NOW } as const;
  if (t.joint) {
    const { pack } = await buildCompetitionPack(auth, t.competitionId, t.divisionIds, opts);
    return pack;
  }
  const { pack } = await buildSchedulePack(auth, t.divisionIds[0]!, opts);
  return pack;
}

/** Seed one template into two FRESH orgs of the same schema and build both
 *  packs — the reseed-reproduces evidence every template block asserts. */
async function seedTwice(seed: (auth: AuthCtx) => Promise<SeededTemplate>): Promise<{
  authA: AuthCtx;
  a: SeededTemplate;
  b: SeededTemplate;
  packA: unknown;
  packB: unknown;
}> {
  const { auth: authA } = await seedOrg("pro");
  const a = await seed(authA);
  const { auth: authB } = await seedOrg("pro");
  const b = await seed(authB);
  return { authA, a, b, packA: await packFor(authA, a), packB: await packFor(authB, b) };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("normalizeIds", () => {
  it("maps UUIDs to first-seen placeholders, keeping repeats identical", () => {
    const u1 = "11111111-2222-4333-8444-555555555555";
    const u2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(normalizeIds({ a: u1, b: u2, c: u1 })).toEqual({
      a: "«u1»",
      b: "«u2»",
      c: "«u1»",
    });
  });

  it("normalizes UUIDs embedded in a longer string", () => {
    const u = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(normalizeIds({ note: `fixture ${u} clashes with ${u}` })).toEqual({
      note: "fixture «u1» clashes with «u1»",
    });
  });

  it("keeps non-UUID content byte-identical", () => {
    const input = { n: 3, s: "Court 1", at: "2026-09-15T18:30:00+01:00", nested: [{ k: null }] };
    expect(normalizeIds(input)).toEqual(input);
  });

  // Order sensitivity is what stops the determinism assertions below from being
  // vacuous — but it comes from the CONTENT beside the ids, not from the
  // placeholders. Both halves are pinned so nobody reads the pack equality as
  // stronger than it is.
  it("separates rows that carry content, when their order changes", () => {
    const u1 = "11111111-2222-4333-8444-555555555555";
    const u2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const a = [
      { id: u1, court: "Court 1" },
      { id: u2, court: "Court 2" },
    ];
    const b = [a[1]!, a[0]!];
    expect(JSON.stringify(normalizeIds(a))).not.toBe(JSON.stringify(normalizeIds(b)));
  });

  it("cannot see a permutation of rows that are nothing but distinct ids", () => {
    const u1 = "11111111-2222-4333-8444-555555555555";
    const u2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    // First-seen renumbering makes a bare permutation identical. Documented,
    // not a defect: every ordered surface a pack carries (fixtures, draft rows,
    // entrants) also carries a time, a court or a name.
    expect(JSON.stringify(normalizeIds([u1, u2]))).toBe(
      JSON.stringify(normalizeIds([u2, u1])),
    );
  });
});

describe.skipIf(!HAS_DB)("seedClubNight (club-night)", () => {
  let t: Awaited<ReturnType<typeof seedTwice>>;

  beforeAll(async () => {
    t = await seedTwice(seedClubNight);
  });

  it("declares a single-division generate run", () => {
    expect(t.a.slug).toBe("club-night");
    expect(t.a.mode).toBe("generate");
    expect(t.a.joint).toBe(false);
    expect(t.a.divisionIds).toHaveLength(1);
    expect(t.a.instruction).toContain("20 minutes rest");
  });

  it("generates 12 pool fixtures (2 pools of 4)", async () => {
    expect(await fixtureCount(t.a.divisionIds[0]!)).toBe(12);
  });

  it("carries the 2-court, 20-minute club-night settings", async () => {
    const [row] = await sql<{ config: Record<string, unknown>; tz: string }[]>`
      select config, tz from schedule_settings where division_id = ${t.a.divisionIds[0]!}`;
    expect(row.tz).toBe("Europe/London");
    expect(row.config.courts).toEqual(["Court 1", "Court 2"]);
    expect(row.config.matchMinutes).toBe(20);
    expect(row.config.gapMinutes).toBe(5);
    expect(row.config.perEntrantMinRest).toBe(20);
    expect(row.config.sessionWindows).toEqual([
      { from: "2026-09-15T18:30:00+01:00", to: "2026-09-15T22:00:00+01:00" },
    ]);
  });

  it("reseeds to an identical pack", () => {
    expect(JSON.stringify(normalizeIds(t.packA))).toBe(JSON.stringify(normalizeIds(t.packB)));
  });
});

describe.skipIf(!HAS_DB)("seedNorthsideOpen (northside-open)", () => {
  let t: Awaited<ReturnType<typeof seedTwice>>;

  beforeAll(async () => {
    t = await seedTwice(seedNorthsideOpen);
  });

  it("declares a three-division joint generate run", () => {
    expect(t.a.slug).toBe("northside-open");
    expect(t.a.mode).toBe("generate");
    expect(t.a.joint).toBe(true);
    expect(t.a.divisionIds).toHaveLength(3);
    expect(t.a.instruction).toContain("Court 5 is juniors only");
  });

  it("generates 31 + 36 + 48 = 115 fixtures in draw order", async () => {
    const counts = await Promise.all(t.a.divisionIds.map(fixtureCount));
    expect(counts).toEqual([31, 36, 48]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(115);
  });

  it("gives the juniors a court set and a finish time the adults do not share", async () => {
    const rows = await sql<{ division_id: string; config: Record<string, unknown> }[]>`
      select division_id, config from schedule_settings
      where division_id in ${sql(t.a.divisionIds)}`;
    const byId = new Map(rows.map((r) => [r.division_id, r.config]));
    const [ms, ws, u15] = t.a.divisionIds.map((id) => byId.get(id)!);
    expect(ms.courts).toEqual(["Court 1", "Court 2", "Court 3", "Court 4"]);
    expect(ws.courts).toEqual(["Court 1", "Court 2", "Court 3", "Court 4"]);
    expect(u15.courts).toEqual(["Court 3", "Court 4", "Court 5"]);
    expect(ms.matchMinutes).toBe(45);
    expect(ws.matchMinutes).toBe(45);
    expect(u15.matchMinutes).toBe(30);
    expect(u15.sessionWindows).toEqual([
      { from: "2026-09-19T09:00:00+01:00", to: "2026-09-19T18:00:00+01:00" },
      { from: "2026-09-20T09:00:00+01:00", to: "2026-09-20T18:00:00+01:00" },
    ]);
  });

  it("retires exactly one Women's Singles entrant, after the draw was made", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants
      where division_id = ${t.a.divisionIds[1]!} and status = 'withdrawn'`;
    expect(n).toBe(1);
    // The withdrawal must not have cost the draw a fixture — it happened after
    // generation, which is what makes it a RETIREMENT rather than a scratch.
    expect(await fixtureCount(t.a.divisionIds[1]!)).toBe(36);
  });

  it("reseeds to an identical joint pack", () => {
    expect(JSON.stringify(normalizeIds(t.packA))).toBe(JSON.stringify(normalizeIds(t.packB)));
  });
});

describe.skipIf(!HAS_DB)("seedFinalsDay (finals-day)", () => {
  let t: Awaited<ReturnType<typeof seedTwice>>;

  beforeAll(async () => {
    t = await seedTwice(seedFinalsDay);
  });

  it("declares a single-division repair run", () => {
    expect(t.a.slug).toBe("finals-day");
    expect(t.a.mode).toBe("repair");
    expect(t.a.joint).toBe(false);
    expect(t.a.divisionIds).toHaveLength(1);
    expect(t.a.instruction).toContain("13:00 to 15:30");
  });

  it("trims the round robin to 40 fixtures, every one of them placed", async () => {
    const divisionId = t.a.divisionIds[0]!;
    expect(await fixtureCount(divisionId)).toBe(40);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where division_id = ${divisionId}
        and (scheduled_at is null or court_label is null)`;
    expect(n).toBe(0);
  });

  it("freezes 11 already-played fixtures, all of them before the rain", async () => {
    const decided = await fixturesByStatus(t.a.divisionIds[0]!, "decided");
    expect(decided).toHaveLength(11);
    for (const f of decided) {
      expect(f.scheduled_at).not.toBeNull();
      expect(new Date(f.scheduled_at!).getTime()).toBeLessThan(T3_BLACKOUT_FROM);
    }
  });

  it("leaves 29 movable fixtures — the repair's whole job", async () => {
    const movable = await fixturesByStatus(t.a.divisionIds[0]!, "scheduled");
    expect(movable).toHaveLength(29);
    // …and the repair pack agrees: `decided` is immovable by construction, so
    // the frozen morning never reaches the model as something it may re-place.
    const { movableIds } = await buildSchedulePack(t.authA, t.a.divisionIds[0]!, {
      mode: "repair",
      instruction: t.a.instruction,
      now: ANCHOR_NOW,
    });
    expect(movableIds.size).toBe(29);
  });

  it("stores the rain blackout the instruction refers to", async () => {
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      select config from schedule_settings where division_id = ${t.a.divisionIds[0]!}`;
    expect(row.config.blackouts).toEqual([
      { from: "2026-09-26T13:00:00+01:00", to: "2026-09-26T15:30:00+01:00" },
    ]);
    expect(row.config.courts).toHaveLength(6);
  });

  it("reseeds to an identical pack", () => {
    expect(JSON.stringify(normalizeIds(t.packA))).toBe(JSON.stringify(normalizeIds(t.packB)));
  });
});
