// W5 follow-ups fix round 1, review I4: `completeStageIfReady` read the stage's inputs BEFORE it took the division lock, and
// its "already complete" check read those inputs. Two completions that ran together (two final results landing at once: each
// result's auto-advance asks the stage) could both load "not complete", queue on the lock, and BOTH complete - appending
// `stage_completed` and every `rank_lock` twice. And a correction committed between a completion's load and its lock had its
// newer table overwritten by the completion's stale snapshot. The fix is B7's shape: resolve the division, lock, then load.
//
// Driven through the real doors with the interleaving forced: the first completion is paused right after its input load (a
// gate on the real `loadStageInputs`), the racing write runs (or queues on the lock), then the first is released. Expected
// values come from the scene - four entrants, every match drawn, so the four tie and ONE lots draw orders them; a correction
// that makes one draw a 2-0 win gives that winner the only win - never from the code under test.
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
import { scoreEvent } from "@/server/usecases/scoring";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { completeStageIfReady } from "../competition/complete";

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

type Scene = { auth: AuthCtx; divId: string; stageId: string; fixtures: { id: string; home_entrant_id: string }[] };

/** A four-entrant generic league, started, every line DRAWN 1-1 with auto-advance held back: complete-able, not completed. */
async function drawnLeague(): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Race", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, div.id, [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }] as never);
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, div.id);
  const fixtures = await sql<{ id: string; home_entrant_id: string }[]>`
    select id, home_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  for (const f of fixtures) {
    await send(auth, f.id, "core.start");
    await send(auth, f.id, "generic.result", { p1Score: 1, p2Score: 1 });
  }
  return { auth, divId: div.id, stageId: stage!.id, fixtures };
}

/** One score event, auto-advance held back: the test drives the completions itself. */
async function send(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload }, { autoAdvance: false });
}

async function eventCounts(divId: string): Promise<{ completed: number; rankLocks: number }> {
  const rows = await sql<{ type: string; n: number }[]>`
    select type, count(*)::int as n from division_events where division_id = ${divId} and type in ('stage_completed', 'rank_lock') group by type`;
  const of = (t: string) => rows.find((r) => r.type === t)?.n ?? 0;
  return { completed: of("stage_completed"), rankLocks: of("rank_lock") };
}

/** Until `p` settles or a backend waits on THIS division's advisory lock (keyed on the lock's own value: another session on
 *  the same cluster waits on advisory locks too). */
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
  throw new Error("the racing write neither finished nor queued in 10 s");
}

describe.skipIf(!HAS_DB)("I4 a stage completion under the division lock: once, and never over a newer table", () => {
  it("two completions that run together append stage_completed and the lots draw's rank_lock exactly once", async () => {
    const s = await drawnLeague();
    expect(s.fixtures.length, "the premise: a four-entrant league has six lines").toBe(6);
    expect(await eventCounts(s.divId), "the premise: nothing completed yet").toEqual({ completed: 0, rankLocks: 0 });

    gate.onLoaded = gate.arm();
    const a = completeStageIfReady(s.auth.orgId, s.stageId);
    await gate.loaded; // completion A holds inputs that say "not complete"
    const b = completeStageIfReady(s.auth.orgId, s.stageId);
    const state = await settledOrQueued(b, s.divId);
    gate.release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(["settled", "queued"]).toContain(state);
    expect([ra, rb].filter((r) => r.completed && r.already_complete !== true).length, `one call completed it (second ${state})`).toBe(1);
    // Four tied entrants in one table: one lots draw orders them, so one rank_lock - and one stage_completed.
    expect(await eventCounts(s.divId), `each event once (second ${state})`).toEqual({ completed: 1, rankLocks: 1 });
    const [{ status }] = await sql<{ status: string }[]>`select status from stages where id = ${s.stageId}`;
    expect(status).toBe("complete");
  });

  it("a correction committed while a completion waits keeps the newer table: its winner has the only win", async () => {
    const s = await drawnLeague();
    const target = s.fixtures[0]!;

    gate.onLoaded = gate.arm();
    const a = completeStageIfReady(s.auth.orgId, s.stageId);
    await gate.loaded; // completion A holds every line drawn
    const correct = (async () => {
      const [result] = await sql<{ id: string }[]>`
        select id from score_events where fixture_id = ${target.id} and type = 'generic.result' order by seq desc limit 1`;
      await send(s.auth, target.id, "core.void", { event_id: result!.id });
      await send(s.auth, target.id, "generic.result", { p1Score: 2, p2Score: 0 });
    })();
    const state = await settledOrQueued(correct, s.divId);
    gate.release();
    await Promise.all([a, correct]);

    const snaps = await sql<{ rows: { entrantId: string; won?: number; played: number }[] }[]>`
      select rows from standings_snapshots where stage_id = ${s.stageId}`;
    const rows = snaps.flatMap((x) => x.rows);
    expect(rows.length, "the premise: the stored table has the four entrants").toBe(4);
    const winners = rows.filter((r) => (r.won ?? 0) > 0).map((r) => r.entrantId);
    expect(winners, `the corrected line's winner holds the only win (correction ${state})`).toEqual([target.home_entrant_id]);
  });

  it("the sequence without a race: a completion, then a second ask, appends nothing more", async () => {
    const s = await drawnLeague();
    const first = await completeStageIfReady(s.auth.orgId, s.stageId);
    const second = await completeStageIfReady(s.auth.orgId, s.stageId);
    expect(first.completed && first.already_complete !== true).toBe(true);
    expect(second.already_complete).toBe(true);
    expect(await eventCounts(s.divId)).toEqual({ completed: 1, rankLocks: 1 });
  });
});
