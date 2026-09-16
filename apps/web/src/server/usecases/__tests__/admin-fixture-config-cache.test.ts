// Spectator W2, Task 15 review (R5) — the config-snapshot escape hatch rewrites
// `fixtures.status` and `fixtures.outcome` from a re-fold
// (`admin-fixture-config.ts`), and that is exactly what the public documents
// are built from: the fixture's own match centre, the competition hub's live
// scores, and the org home's in-play count. With no invalidation, a fixture
// the hatch moved out of (or into) `in_play` kept its old chip and score on
// every public surface until each key's TTL ran out.
//
// The hatch now drops them through the same door a score write uses
// (`invalidatePublicCache`, usecases/scoring.ts), so the key names cannot
// drift apart. Driven against the real database, so the keys are derived from
// the real fixture → division → competition → org rows, not from a stub.
// Only the Redis doors and the ISR tag call are replaced, to be observed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const cacheDel = vi.hoisted(() =>
  vi.fn(async (...keys: string[]) => {
    void keys;
  }),
);
const cacheDelPattern = vi.hoisted(() =>
  vi.fn(async (pattern: string) => {
    void pattern;
  }),
);
const fireScoreRevalidate = vi.hoisted(() => vi.fn());
const standings = vi.hoisted(() => ({ fail: false }));
const scoringDoor = vi.hoisted(() => ({ fail: false }));
// The logger, replaced whole (a spy on the pino singleton keeps its call
// history across tests).
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDel,
  cacheDelPattern,
}));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/revalidate")>()),
  fireScoreRevalidate,
}));
// The real door, unless a test makes it REJECT — the one failure the hatch's
// `.catch` exists for.
vi.mock("@/server/usecases/scoring", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/scoring")>();
  return {
    ...real,
    invalidatePublicCache: async (...args: Parameters<typeof real.invalidatePublicCache>) => {
      if (scoringDoor.fail) throw new Error("public cache lookup failed");
      return real.invalidatePublicCache(...args);
    },
  };
});
vi.mock("@/server/engine-db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...real,
    recomputeStandings: async (...args: Parameters<typeof real.recomputeStandings>) => {
      if (standings.fail) throw new Error("standings recompute failed");
      return real.recomputeStandings(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { resnapshotFixtureConfig } from "../admin-fixture-config";

const HAS_DB = !!process.env.DATABASE_URL;

const CFG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

interface Seed {
  orgId: string;
  actorId: string;
  competitionId: string;
  divisionId: string;
  fixtureId: string;
}

async function seed(): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin')
    returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'generic', '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'score', ${sql.json(CFG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, 'league', 'Stage', ${sql.json({})})
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1)
    returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2)
    returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id`;
  return { orgId, actorId, competitionId, divisionId, fixtureId };
}

/** A fixture scored under CFG, then the division corrected — the hatch's case. */
async function scoredThenCorrected(): Promise<Seed> {
  const s = await seed();
  await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(s.orgId, s.fixtureId, 1, { type: "generic.result", payload: { p1Score: 1, p2Score: 1 } });
  await sql`update divisions set config = ${sql.json({ ...CFG, points: { w: 2, d: 1, l: 0 } })}
            where id = ${s.divisionId}`;
  cacheDel.mockClear();
  fireScoreRevalidate.mockClear();
  return s;
}

const deleted = () => cacheDel.mock.calls.flat();

beforeEach(() => {
  standings.fail = false;
  scoringDoor.fail = false;
  logMock.error.mockClear();
  cacheDel.mockClear();
  cacheDelPattern.mockClear();
  fireScoreRevalidate.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("admin fixture config snapshot — the public caches the rewrite makes stale", () => {
  it("a re-snapshot drops the org home's live key, the competition hub and the fixture's own document", async () => {
    const s = await scoredThenCorrected();
    await resnapshotFixtureConfig(s.actorId, s.fixtureId, "organiser set the points table wrong");

    expect(deleted()).toEqual(
      expect.arrayContaining([
        `pub:v1:org-live:${s.orgId}`,
        `pub:v1:hub:${s.competitionId}`,
        `pub:v1:fixture:${s.fixtureId}`,
      ]),
    );
    // In ONE literal-key DEL, the scoring door's shape.
    expect(cacheDel).toHaveBeenCalledTimes(1);
    expect(cacheDelPattern).toHaveBeenCalledWith(`pub:v1:div:${s.divisionId}:*`);
    // …and the ISR tag for the same division and competition.
    expect(fireScoreRevalidate).toHaveBeenCalledWith(s.divisionId, s.competitionId);
  });

  it("a standings recompute that throws still drops them: the rewrite has already committed", async () => {
    const s = await scoredThenCorrected();
    standings.fail = true;
    await expect(
      resnapshotFixtureConfig(s.actorId, s.fixtureId, "organiser set the points table wrong"),
    ).rejects.toThrow("standings recompute failed");
    expect(deleted()).toEqual(
      expect.arrayContaining([`pub:v1:org-live:${s.orgId}`, `pub:v1:hub:${s.competitionId}`]),
    );
  });

  it("an invalidation that REJECTS is logged, and the re-snapshot still succeeds — it has already committed", async () => {
    const s = await scoredThenCorrected();
    scoringDoor.fail = true;
    await expect(
      resnapshotFixtureConfig(s.actorId, s.fixtureId, "organiser set the points table wrong"),
    ).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ fixture: s.fixtureId }),
      expect.stringContaining("public cache invalidation failed"),
    );
    // Committed: the fixture is frozen under the corrected config.
    const [row] = await sql<{ config_snapshot: { points: unknown } }[]>`
      select config_snapshot from fixtures where id = ${s.fixtureId}`;
    expect(row!.config_snapshot.points).toEqual({ w: 2, d: 1, l: 0 });
  });

  it("a REFUSED re-snapshot drops nothing — the transaction rolled back, so nothing public changed", async () => {
    // No events, so no snapshot: refused inside the transaction (409).
    const s = await seed();
    await expect(resnapshotFixtureConfig(s.actorId, s.fixtureId, "no reason to")).rejects.toMatchObject({
      status: 409,
    });
    expect(cacheDel).not.toHaveBeenCalled();
    expect(fireScoreRevalidate).not.toHaveBeenCalled();
  });
});
