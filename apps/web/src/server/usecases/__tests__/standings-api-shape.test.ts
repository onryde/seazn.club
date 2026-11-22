// W5 app PR A, Task 22 (X-SF-6 <- RB5-T13; ST-G23, ST-G28): the standings API declares its row, serves every pool of a pooled stage
// without a `pool_id`, lists a pooled stage's pools, and names a departed entrant on its row.
//
// Driven through the REAL route handlers (the `v1()` envelope, `requireResourceAuth` with a session, the usecases) on the label DB; the
// producers are the organiser's own doors (`rig` -> `generateStageFixtures` -> `startDivision` -> `playToDecided` -> `withdrawEntrantCascade`).
// Expected values come from the rows the generator and the write path stored (which entrants sit in which pool, who left), never from the
// code under test; the status vocabulary is read from the leaf the whole product shares (`lib/departed-status-keys.ts`).
//
// differential (today, ca3b24767d): `GET /stages/{id}/standings` on a TWO-pool stage with no `pool_id` answers `rows: []` (ST-G28); no
// row carries `name`, `status` or `pool`, so a withdrawn entrant's row is an unnamed id the public entrants list does not resolve; there is
// no `/stages/{id}/pools`. Every case below that reads those is red on that tree.
//
// Sequence (TEST-STRATEGY): the empty case (a generated pooled stage nobody has played), a second GET, a withdrawal and a disqualification
// and the Reinstate that undoes them, a LEVEL pool beside a decided one (each table judged on its own rows), a league (pool null) and a
// one-pool group (reads as a league, X-BD-7), and a second sport.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
// The public Redis document, in memory: the public route is read THROUGH its cache, and a withdrawal's invalidation drops it.
const redis = vi.hoisted(() => ({ docs: new Map<string, string>() }));
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  const held = (key: string) => key.startsWith("pub:v1:");
  return {
    ...actual,
    cacheGet: async (key: string) => {
      if (!held(key)) return actual.cacheGet(key);
      const raw = redis.docs.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    cacheSet: async (key: string, value: unknown, ttl: number) => {
      if (!held(key)) return actual.cacheSet(key, value, ttl);
      redis.docs.set(key, JSON.stringify(value));
    },
    cacheDel: async (...keys: string[]) => {
      const rest = keys.filter((k) => !held(k));
      for (const key of keys) if (held(key)) redis.docs.delete(key);
      if (rest.length > 0) await actual.cacheDel(...rest);
    },
    cacheDelPattern: async (pattern: string) => {
      if (!held(pattern)) return actual.cacheDelPattern(pattern);
      const prefix = pattern.slice(0, -1);
      for (const key of [...redis.docs.keys()]) if (pattern.endsWith("*") && key.startsWith(prefix)) redis.docs.delete(key);
    },
  };
});

import { DEPARTED_STATUS_KEYS } from "@/lib/departed-status-keys";
import { DEPARTED_STATUS_CHIPS } from "@/lib/departed-status-chips";
import * as S from "@/server/api-v1/schemas";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { GET as standingsRoute } from "@/app/api/v1/stages/[id]/standings/route";
import { GET as publicStandingsRoute } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/standings/route";
import { patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { playToDecided } from "./_quick-match-probe";
import { levelLeague } from "@/server/engine-db/__tests__/helpers/stored-table-rows";
import { BADMINTON, FOOTBALL, rig, type Rig, type SportPick } from "./_w5-t3-rig";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;
interface Envelope {
  status: number;
  data: unknown;
  error: { code: string; message: string } | undefined;
}
async function call<P>(handler: Handler<P>, params: P, path: string): Promise<Envelope> {
  const res = await handler(new Request(`https://test.local/api/v1${path}`, { method: "GET" }), { params: Promise.resolve(params) });
  const json = (await res.json()) as { ok: boolean; data?: unknown; error?: Envelope["error"] };
  return { status: res.status, data: json.data, error: json.error };
}

type Row = ReturnType<typeof S.StandingsRow.parse>;
type Doc = ReturnType<typeof S.StandingsSnapshot.parse>;

/** `GET /stages/{id}/standings[?pool_id]`, parsed by the documented schema (a row key the schema lacks would be dropped here). */
async function privateDoc(r: Rig, poolId?: string): Promise<Doc> {
  authState.userId = r.auth.userId ?? "";
  const q = poolId === undefined ? "" : `?pool_id=${poolId}`;
  const res = await call(standingsRoute, { id: r.stageId }, `/stages/${r.stageId}/standings${q}`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return S.StandingsSnapshot.parse(res.data);
}

/** Make the competition public; the three slugs the public read is addressed by. */
async function publish(r: Rig): Promise<[string, string, string]> {
  await sql`update competitions set visibility = 'public' where id = (select competition_id from divisions where id = ${r.divisionId})`;
  const [s] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${r.divisionId}`;
  return [s!.org, s!.comp, s!.div];
}
/** `GET /public/…/standings`: every published table, parsed by the documented schema. */
async function publicDoc(slugs: readonly [string, string, string]): Promise<ReturnType<typeof S.PublicDivisionStandings.parse>> {
  const [orgSlug, slug, divisionSlug] = slugs;
  const res = await call(publicStandingsRoute, { orgSlug, slug, divisionSlug }, `/public/orgs/${orgSlug}/competitions/${slug}/divisions/${divisionSlug}/standings`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return S.PublicDivisionStandings.parse(res.data);
}

interface Pool {
  id: string;
  key: string;
  name: string;
  entrants: string[];
}
/** The stage's pools and who sits in each, read off the stored fixtures (the generator's own seating), in key order. */
async function poolsOf(stageId: string): Promise<Pool[]> {
  const pools = await sql<{ id: string; key: string; name: string }[]>`select id, key, name from pools where stage_id = ${stageId} order by key`;
  const out: Pool[] = [];
  for (const p of pools) {
    const fx = await sql<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId} and pool_id = ${p.id}`;
    out.push({ ...p, entrants: [...new Set(fx.flatMap((f) => [f.home, f.away]).filter((x): x is string => x !== null))].sort() });
  }
  return out;
}
const nameOf = async (id: string): Promise<string> => (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${id}`)[0]!.display_name;
const ids = (rows: readonly Row[]) => rows.map((x) => x.entrantId).sort();

/** A group stage of `poolCount` pools of two; `decide` = the pools (by index) whose one match is played through the real write path. */
async function pooled(sport: SportPick, poolCount: number, decide: number[] = []): Promise<{ r: Rig; pools: Pool[] }> {
  const r = await rig({ n: poolCount * 2, kind: "group", pools: poolCount, sport });
  await startDivision(r.auth, r.divisionId);
  const pools = await poolsOf(r.stageId);
  expect(pools, "premise: the generator made every pool").toHaveLength(poolCount);
  for (const i of decide) {
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and pool_id = ${pools[i]!.id}`;
    expect(await playToDecided(r.auth, fx!.id), `premise: pool ${pools[i]!.key}'s match decided`).toMatchObject({ kind: "decided" });
  }
  return { r, pools };
}

describe("X-SF-6 the row declares its shape (pure)", () => {
  it("the status enum is `active` plus the one departed vocabulary, not a second list", () => {
    const status = S.StandingsRow.shape.status;
    expect([...status.options].sort()).toEqual(["active", ...DEPARTED_STATUS_KEYS].sort());
    expect([...DEPARTED_STATUS_KEYS].sort(), "the chips and the schema read the same vocabulary").toEqual(Object.keys(DEPARTED_STATUS_CHIPS).sort());
  });

  it("a level table's null rank parses, and a row with no name, status or pool does not", () => {
    const base = { entrantId: "e1", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, level: true };
    expect(S.StandingsRow.safeParse({ ...base, rank: null, name: "Ann", status: "active", pool: null }).success).toBe(true);
    expect(S.StandingsRow.safeParse({ ...base, rank: null }).success, "name, status and pool are declared, not optional").toBe(false);
    expect(S.StandingsRow.safeParse({ ...base, rank: 1, name: "Ann", status: "left", pool: "A" }).success, "an unknown status").toBe(false);
  });

  it("the OpenAPI document declares the pools route and a standings response whose row carries the three fields", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths["/api/v1/stages/{id}/pools"]?.["get"], "GET /stages/{id}/pools is declared").toBeDefined();
    const text = JSON.stringify(doc.paths["/api/v1/stages/{id}/standings"]?.["get"]);
    for (const key of ['"name"', '"status"', '"pool"', '"withdrawn"', '"disqualified"']) expect(text, `the standings response declares ${key}`).toContain(key);
  });
});

describe.runIf(HAS_DB)("X-SF-6 the private GET without pool_id returns every pool", () => {
  for (const sport of [BADMINTON, FOOTBALL]) {
    it(`X-SF-6 ${sport.key}: two pools, no pool_id -> both pools' rows, each tagged with its pool; a pool_id -> that pool only`, async () => {
      const { r, pools } = await pooled(sport, 2, [0, 1]);
      const all = await privateDoc(r);
      expect(all.pool_id, "the envelope names no one pool").toBeNull();
      expect(all.rows, "premise: rows came back (an empty answer is ST-G28 itself)").toHaveLength(4);
      for (const p of pools) {
        const rows = all.rows.filter((x) => x.pool === p.key);
        expect(ids(rows), `pool ${p.key}'s rows are exactly the entrants the generator seated in it`).toEqual(p.entrants);
        expect(rows.map((x) => x.rank).sort(), `pool ${p.key}'s places run 1..2 on their own`).toEqual([1, 2]);
        const own = await privateDoc(r, p.id);
        expect(own.pool_id).toBe(p.id);
        expect(ids(own.rows)).toEqual(p.entrants);
        expect(own.rows.every((x) => x.pool === p.key), "a one-pool request's rows carry that pool's key").toBe(true);
      }
      expect(all.rows.map((x) => x.pool), "rows come in the pools' own order (A before B)").toEqual([...all.rows.map((x) => x.pool)].sort());
      // a second call changes nothing
      expect(await privateDoc(r)).toEqual(all);
    }, 120_000);
  }

  it("X-SF-6 the empty case: a started two-pool stage nobody has played lists each pool's seats, level - no place in either pool", async () => {
    const { r, pools } = await pooled(BADMINTON, 2);
    // W5 app PR B Task 1 (X-PO-1): the fold seats each pool's members, so a pool's table lists them from the first fold, nothing
    // counted. differential: before, a pool had no rows until something in it was decided, and this answer was [].
    const all = await privateDoc(r);
    expect(all.pool_id).toBeNull();
    let checked = 0;
    for (const p of pools) {
      const mine = all.rows.filter((x) => x.pool === p.key);
      expect(ids(mine), `pool ${p.key}: its seats are listed`).toEqual(p.entrants);
      expect(mine.map((x) => x.rank), `pool ${p.key}: level, no place`).toEqual(p.entrants.map(() => null));
      expect(ids((await privateDoc(r, p.id)).rows), `pool ${p.key} alone agrees`).toEqual(p.entrants);
      checked++;
    }
    expect(checked).toBe(2);
  }, 120_000);

  it("X-SF-6 each pool is judged level on its own rows: A decided (places), B level (rank null)", async () => {
    const { r, pools } = await pooled(BADMINTON, 2, [0]);
    // pool B: a started pool with nothing counted whose stored table lists its entrants level (X-TB-6) - the product writes this
    // itself since W5 B T1 (X-PO-1); written here as well so the case stands on the read alone
    const level = levelLeague(pools[1]!.entrants);
    const set = await sql`update standings_snapshots set rows = ${sql.json(level.rows as never)} where stage_id = ${r.stageId} and pool_id = ${pools[1]!.id} returning 1`;
    expect(set, "premise: pool B's stored table is now level").toHaveLength(1);
    const all = await privateDoc(r);
    const a = all.rows.filter((x) => x.pool === pools[0]!.key);
    const b = all.rows.filter((x) => x.pool === pools[1]!.key);
    expect(a.map((x) => x.rank).sort(), "pool A counted a result: its places stand").toEqual([1, 2]);
    expect(ids(b), "premise: pool B's two entrants are listed").toEqual(pools[1]!.entrants);
    expect(b.map((x) => x.rank), "pool B counted nothing: no leader, on ITS rows alone").toEqual([null, null]);
  }, 120_000);

  it("X-SF-6 a never-folded stage (no stored table at all) is folded on the read, like a single table is: every pool comes back", async () => {
    const { r, pools } = await pooled(BADMINTON, 2, [0, 1]);
    const gone = await sql`delete from standings_snapshots where stage_id = ${r.stageId} returning 1`;
    expect(gone.length, "premise: there were stored tables to drop").toBeGreaterThan(0);
    const all = await privateDoc(r);
    expect(all.rows, "both pools' rows, folded on the read").toHaveLength(4);
    for (const p of pools) expect(ids(all.rows.filter((x) => x.pool === p.key))).toEqual(p.entrants);
    const stored = await sql`select 1 from standings_snapshots where stage_id = ${r.stageId}`;
    expect(stored.length, "and the fold stored them, as the single-table read does").toBeGreaterThan(0);
  }, 120_000);

  it("X-SF-6 a league answers ONE table: pool_id null, every row's pool null (pin, no defect expected)", async () => {
    const r = await rig({ n: 4, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const doc = await privateDoc(r);
    expect(doc.pool_id).toBeNull();
    expect(doc.rows, "premise: the league's four").toHaveLength(4);
    expect(doc.rows.every((x) => x.pool === null)).toBe(true);
  }, 120_000);

  it("X-SF-6 a group of ONE pool reads as a league (X-BD-7): its rows name no pool", async () => {
    const r = await rig({ n: 4, kind: "group", pools: 1 });
    await startDivision(r.auth, r.divisionId);
    const doc = await privateDoc(r);
    expect(doc.rows, "premise: the only pool's table").toHaveLength(4);
    expect(doc.rows.every((x) => x.pool === null)).toBe(true);
    // and the public door reads it the same way
    const pub = await publicDoc(await publish(r));
    expect(pub.standings, "premise: one table").toHaveLength(1);
    expect(pub.standings[0]!.rows, "premise: its four rows").toHaveLength(4);
    expect(pub.standings[0]!.rows.every((x) => x.pool === null)).toBe(true);
  }, 120_000);
});

describe.runIf(HAS_DB)("X-SF-6 /stages/{id}/pools lists A and B", () => {
  it("X-SF-6 a two-pool stage lists both, in key order, with the ids the standings filter takes", async () => {
    const { r, pools } = await pooled(BADMINTON, 2, [0, 1]);
    const { GET } = await import("@/app/api/v1/stages/[id]/pools/route");
    authState.userId = r.auth.userId ?? "";
    const res = await call(GET, { id: r.stageId }, `/stages/${r.stageId}/pools`);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const doc = S.StagePools.parse(res.data);
    expect(doc.stage_id).toBe(r.stageId);
    expect(doc.pools.map((p) => p.key), "premise: A and B, in that order").toEqual(["A", "B"]);
    expect(doc.pools).toEqual(pools.map((p) => ({ id: p.id, key: p.key, name: p.name })));
    // the listed id is the one the standings take: the join a client makes
    expect(ids((await privateDoc(r, doc.pools[1]!.id)).rows)).toEqual(pools[1]!.entrants);
  }, 120_000);

  it("X-SF-6 pool order is the product's natural order of the key (2 before 10), not string order, heap order or creation order - /pools, the all-pools standings and the public tables", async () => {
    const { r, pools } = await pooled(BADMINTON, 3, [0, 1, 2]);
    // The generator made A, B, C. Re-key them 10, 2, 1: the declared rule (lib/pool-order.ts: key, natural collation, "Pool 2" before
    // "Pool 10") reads 1, 2, 10; plain string order reads 1, 10, 2; creation / heap order reads 10, 2, 1 - three different answers.
    const rekey: Record<string, string> = { [pools[0]!.id]: "10", [pools[1]!.id]: "2", [pools[2]!.id]: "1" };
    for (const [id, key] of Object.entries(rekey)) await sql`update pools set key = ${key}, name = ${"Pool " + key} where id = ${id}`;
    const declared = ["1", "2", "10"];
    expect([...declared].sort(), "premise: string order differs from the declared one").not.toEqual(declared);
    const { GET } = await import("@/app/api/v1/stages/[id]/pools/route");
    authState.userId = r.auth.userId ?? "";
    const res = await call(GET, { id: r.stageId }, `/stages/${r.stageId}/pools`);
    expect(S.StagePools.parse(res.data).pools.map((p) => p.key), "GET /pools").toEqual(declared);
    const all = await privateDoc(r);
    const seen = all.rows.map((x) => x.pool).filter((k, i, a) => a.indexOf(k) === i);
    expect(all.rows, "premise: both rows of every pool").toHaveLength(6);
    expect(seen, "the all-pools standings list its pools in that order").toEqual(declared);
    const pub = await publicDoc(await publish(r));
    expect(pub.standings.map((t) => rekey[t.pool_id!]), "the public tables, in that order").toEqual(declared);
  }, 120_000);

  it("X-SF-6 a league and a group of one pool list no pools (a table that names none)", async () => {
    const { GET } = await import("@/app/api/v1/stages/[id]/pools/route");
    for (const spec of [{ kind: "league" as const }, { kind: "group" as const, pools: 1 }]) {
      const r = await rig({ n: 4, ...spec });
      authState.userId = r.auth.userId ?? "";
      const res = await call(GET, { id: r.stageId }, `/stages/${r.stageId}/pools`);
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      expect(S.StagePools.parse(res.data).pools, JSON.stringify(spec)).toEqual([]);
    }
  }, 120_000);

  it("X-SF-6 an unknown stage is a 404", async () => {
    const { GET } = await import("@/app/api/v1/stages/[id]/pools/route");
    const r = await rig({ n: 4, kind: "league" });
    authState.userId = r.auth.userId ?? "";
    const missing = "00000000-0000-4000-8000-000000000000";
    const res = await call(GET, { id: missing }, `/stages/${missing}/pools`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 120_000);
});

describe.runIf(HAS_DB)("X-SF-6 a withdrawn row keeps its name and status", () => {
  for (const sport of [BADMINTON, FOOTBALL]) {
    it(`X-SF-6 ${sport.key} league: withdraw -> her row stays, named, status withdrawn, on both doors; DQ -> disqualified; Reinstate -> active`, async () => {
      const r = await rig({ n: 4, kind: "league", sport });
      await startDivision(r.auth, r.divisionId);
      const slugs = await publish(r);
      const her = r.ids[1]!;
      const herName = await nameOf(her);
      const everyone = [...r.ids].sort();

      // the empty case: nobody has left - every row is active and named
      let priv = await privateDoc(r);
      expect(ids(priv.rows)).toEqual(everyone);
      expect(priv.rows.every((x) => x.status === "active" && x.name !== null && x.name.length > 0)).toBe(true);

      const peek = async (door: "private" | "public"): Promise<Row> => {
        const rows = door === "private" ? (await privateDoc(r)).rows : (await publicDoc(slugs)).standings.flatMap((t) => t.rows);
        expect(ids(rows), `${door}: still all four listed`).toEqual(everyone);
        return rows.find((x) => x.entrantId === her)!;
      };

      await withdrawEntrantCascade(r.auth, her);
      for (const door of ["private", "public"] as const) {
        const row = await peek(door);
        expect(row.status, door).toBe("withdrawn");
        expect(row.name, `${door}: the row names her`).toBe(herName);
      }
      priv = await privateDoc(r);
      expect(priv.rows.filter((x) => x.status !== "active").map((x) => x.entrantId), "only she left").toEqual([her]);

      // a second GET changes nothing
      expect(await privateDoc(r)).toEqual(priv);

      // disqualified is its own word, never `withdrawn`
      await patchEntrant(r.auth, her, { status: "confirmed" });
      expect((await peek("private")).status, "Reinstate").toBe("active");
      await withdrawEntrantCascade(r.auth, her, { as: "disqualified" });
      for (const door of ["private", "public"] as const) expect((await peek(door)).status, door).toBe("disqualified");
      await patchEntrant(r.auth, her, { status: "confirmed" });
      for (const door of ["private", "public"] as const) expect((await peek(door)).status, `${door} after Reinstate`).toBe("active");
    }, 180_000);
  }

  it("X-SF-6 the public entrants list does not resolve her, so the row's own name is the only one the API gives (premise of ST-G28)", async () => {
    const r = await rig({ n: 4, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const slugs = await publish(r);
    const her = r.ids[2]!;
    await withdrawEntrantCascade(r.auth, her);
    const { GET } = await import("@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/entrants/route");
    const [orgSlug, slug, divisionSlug] = slugs;
    const res = await call(GET, { orgSlug, slug, divisionSlug }, `/public/orgs/${orgSlug}/competitions/${slug}/divisions/${divisionSlug}/entrants`);
    expect(res.status).toBe(200);
    const listed = (res.data as { entrants: { id: string }[] }).entrants.map((e) => e.id);
    expect(listed, "premise: the entrants list drops the leaver").not.toContain(her);
    expect(listed.length, "premise: and lists the other three").toBe(3);
    const row = (await publicDoc(slugs)).standings.flatMap((t) => t.rows).find((x) => x.entrantId === her);
    expect(row?.name).toBe(await nameOf(her));
  }, 120_000);

  it("X-SF-6 the public row's name is the division's MASKED name - the same one the entrants list prints, never the raw column", async () => {
    const r = await rig({ n: 4, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    // a youth division masks a person's name to a first initial; a single-token name ("P1") would pass through unmasked, so give them two
    await sql`update divisions set youth = true where id = ${r.divisionId}`;
    for (const [i, id] of r.ids.entries()) await sql`update entrants set display_name = ${`Ada Lovelace${i}`} where id = ${id}`;
    const slugs = await publish(r);
    const [orgSlug, slug, divisionSlug] = slugs;
    const { GET } = await import("@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/entrants/route");
    const list = await call(GET, { orgSlug, slug, divisionSlug }, `/public/orgs/${orgSlug}/competitions/${slug}/divisions/${divisionSlug}/entrants`);
    const printed = new Map((list.data as { entrants: { id: string; display_name: string }[] }).entrants.map((e) => [e.id, e.display_name]));
    expect(printed.size, "premise: the entrants list prints all four").toBe(4);
    const rows = (await publicDoc(slugs)).standings.flatMap((t) => t.rows);
    expect(rows, "premise: the four rows").toHaveLength(4);
    for (const row of rows) {
      const raw = await nameOf(row.entrantId);
      expect(printed.get(row.entrantId), "premise: the policy masks this name").not.toBe(raw);
      expect(row.name, `the row prints what the entrants list prints for ${row.entrantId}`).toBe(printed.get(row.entrantId));
    }
  }, 120_000);

  it("X-SF-6 a pooled stage after a withdrawal: her pool's table names her withdrawn, the other pool's rows are all active", async () => {
    const { r, pools } = await pooled(BADMINTON, 2, [0, 1]);
    const slugs = await publish(r);
    const her = pools[0]!.entrants[0]!;
    await withdrawEntrantCascade(r.auth, her);
    const all = await privateDoc(r);
    const row = all.rows.find((x) => x.entrantId === her);
    expect(row, "premise: she played her one match, so the result stands and her row stays").toBeDefined();
    expect(row).toMatchObject({ status: "withdrawn", pool: pools[0]!.key, name: await nameOf(her) });
    expect(all.rows.filter((x) => x.pool === pools[1]!.key).every((x) => x.status === "active")).toBe(true);
    // the public door: one table per pool, each row's pool is its own table's key
    const pub = await publicDoc(slugs);
    expect(pub.standings, "premise: a table per pool").toHaveLength(2);
    for (const t of pub.standings) {
      const key = pools.find((p) => p.id === t.pool_id)!.key;
      expect(t.rows.length).toBeGreaterThan(0);
      expect(t.rows.every((x) => x.pool === key), `public table ${key}: its rows name ${key}`).toBe(true);
    }
    expect(pub.standings.flatMap((t) => t.rows).find((x) => x.entrantId === her)).toMatchObject({ status: "withdrawn", name: await nameOf(her) });
  }, 180_000);

  it("X-SF-6 the public payload of a LEVEL table parses (rank null) and its rows are named (differential: the orphan row schema required an int rank)", async () => {
    const r = await rig({ n: 4, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const slugs = await publish(r);
    const pub = await publicDoc(slugs);
    expect(pub.standings, "premise: one table").toHaveLength(1);
    const rows = pub.standings[0]!.rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.rank === null && x.level === true && x.pool === null && x.status === "active" && typeof x.name === "string")).toBe(true);
  }, 120_000);
});
