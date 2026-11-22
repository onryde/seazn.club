// W5 follow-ups B7 (perf-measure-report "Not verified: possible refold race"): `recomputeStandings` read the stage's inputs
// BEFORE it took the division lock, and the snapshot upsert has no staleness guard. Two result writes could therefore
// interleave so that the refold which loaded FIRST wrote LAST: A loads (one result), B's result commits, B's refold loads both,
// locks and writes both, then A locks and overwrites the table with its stale one - the stored table misses B's result until
// the stage's next write.
//
// Driven through the real doors with the interleaving forced: refold A is paused right after its input load (a gate on the
// real `loadStageInputs`), then a second result is scored through `scoreEvent` - its own refold runs (or waits on A's lock) -
// then A is released. The stored table must count BOTH results. Expected values come from the scene (two decided matches =
// four appearances), never from the fold under test.
// single-sport (generic): the race is in the lock order, not in any sport's scoring.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { post } from "@/server/usecases/__tests__/_groups-ko-scene";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { recomputeStandings } from "../competition/standings";

const HAS_DB = !!process.env.DATABASE_URL;

/** One armed pause, after the real input load returns: `loaded` resolves when the paused call has its inputs. */
const gate = vi.hoisted(() => {
  const g = {
    armed: false,
    loaded: Promise.resolve(),
    release: () => {},
    wait: Promise.resolve(),
    arm() {
      g.armed = true;
      let onLoaded = () => {};
      g.loaded = new Promise<void>((r) => (onLoaded = r));
      g.wait = new Promise<void>((r) => (g.release = r));
      return onLoaded;
    },
    onLoaded: () => {},
  };
  return g;
});
vi.mock("@/server/engine-db/competition/stage-inputs", async (orig) => {
  const real = await orig<typeof import("@/server/engine-db/competition/stage-inputs")>();
  return {
    ...real,
    loadStageInputs: async (...args: Parameters<typeof real.loadStageInputs>) => {
      const inputs = await real.loadStageInputs(...args);
      if (gate.armed) {
        gate.armed = false;
        gate.onLoaded();
        await gate.wait;
      }
      return inputs;
    },
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

async function league(): Promise<{ auth: AuthCtx; divId: string; stageId: string; fixtures: { id: string }[] }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Race", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, div.id, [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }] as never);
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, div.id);
  const fixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  return { auth, divId: div.id, stageId: stage!.id, fixtures };
}

async function decide(auth: AuthCtx, fixtureId: string): Promise<void> {
  await post(auth, fixtureId, "core.start");
  await post(auth, fixtureId, "generic.result", { p1Score: 2, p2Score: 0 });
}

/** Appearances in the stored table: each decided match is two (one per side). */
async function storedAppearances(stageId: string): Promise<number> {
  const snaps = await sql<{ rows: { played: number }[] }[]>`select rows from standings_snapshots where stage_id = ${stageId}`;
  expect(snaps.length, "the premise: the stage has a stored table").toBeGreaterThan(0);
  return snaps.flatMap((s) => s.rows).reduce((n, r) => n + r.played, 0);
}

/** Until `p` settles or a backend waits on THIS division's advisory lock (the second refold queued behind the paused one).
 *  Keyed on the lock's own value, never "any advisory waiter": another session on the same cluster (a running server) waits on
 *  advisory locks too, and a bare count read one of those as this race's queue. */
async function settledOrQueued(p: Promise<unknown>, divisionId: string): Promise<"settled" | "queued"> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200; i++) {
    if (settled) return "settled";
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())
         and ((classid::bigint << 32) | objid::bigint) = hashtext(${"division:" + divisionId})::bigint`;
    if (n > 0) return "queued";
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the second write neither finished nor queued in 10 s");
}

describe.skipIf(!HAS_DB)("B7 two interleaved result writes: the stored table never loses the later one", () => {
  it("a refold that loaded before a second result committed cannot overwrite that result's refold", async () => {
    const s = await league();
    expect(s.fixtures.length, "the premise: a four-entrant league has six lines").toBe(6);
    await decide(s.auth, s.fixtures[0]!.id);
    expect(await storedAppearances(s.stageId), "after the first result").toBe(2);

    gate.onLoaded = gate.arm();
    const a = recomputeStandings(s.auth.orgId, s.stageId, undefined, { cause: "result" });
    await gate.loaded; // refold A holds inputs with ONE result
    const b = decide(s.auth, s.fixtures[1]!.id); // the second result commits; its refold runs or queues
    const state = await settledOrQueued(b, s.divId);
    gate.release();
    await Promise.all([a, b]);
    expect(["settled", "queued"]).toContain(state);
    expect(await storedAppearances(s.stageId), `both results are in the stored table (second write ${state})`).toBe(4);
  });

  it("the sequence without a race: a third result after the interleaving is counted too (the guard does not freeze the table)", async () => {
    const s = await league();
    for (const [i, f] of s.fixtures.slice(0, 3).entries()) {
      await decide(s.auth, f.id);
      expect(await storedAppearances(s.stageId), `after result ${i + 1}`).toBe(2 * (i + 1));
    }
  });
});
