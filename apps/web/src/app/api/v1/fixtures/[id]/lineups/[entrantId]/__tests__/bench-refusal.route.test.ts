// PUT /api/v1/fixtures/{id}/lineups/{entrantId} refuses a bench row when the
// sport's catalog declares `benchMax: 0` (boardgame, carrom, generic).
//
// Before this, `putLineup` saved the row and `validateLineup` only warned
// (`bench_size`). The engine never uses such a bench, and the boardgame and
// carrom stats folds credited every bench row on the sheet with no event
// touching it. Driven through the REAL `PUT` and `GET` handlers (only the auth
// door is mocked, as in route.test.ts beside this file) against a real
// Postgres, over every sport the engine ships — the limit is each sport's own
// resolved catalog declaration, never a sport-name list.
//
// Owner scope (2026-10-16): only `benchMax: 0` is refused. A bench over a
// positive `benchMax` is still a saved lineup with a `bench_size` warning, and
// the last describe block pins that through the real door.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

const requireFixtureActorMock = vi.hoisted(() => vi.fn<() => Promise<AuthCtx>>());
vi.mock("@/server/api-v1/auth", () => ({ requireFixtureActor: requireFixtureActorMock }));

import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { GET, PUT } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

type Kind = "team" | "individual" | "pair";
type Wire = { slot: "starting" | "bench"; person_id: string; role?: "player" | "coach" | "staff"; order_no?: number };

/** Every sport the engine ships once (the latest of each key), with its resolved catalog's bench declaration. */
const SPORTS = [...new Map(builtinModules.map((m) => [m.key, m])).values()].map((module) => ({
  module,
  benchMax: lineupCatalogFor(module, {}).lineup.benchMax,
}));
const NO_BENCH = SPORTS.filter((s) => s.benchMax === 0);
const WITH_BENCH = SPORTS.filter((s) => (s.benchMax ?? 0) > 0);

const CODE = "LINEUP_BENCH_NOT_SUPPORTED";

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The sport row and one system variant from the module's own presets — present already where `sync:sports` ran. */
async function ensureSport(m: AnySportModule): Promise<string> {
  const variantKey = Object.keys(m.variants)[0];
  if (variantKey === undefined) throw new Error(`premise: ${m.key} declares no variant preset`);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${m.key}, ${m.key}, ${m.version}, ${sql.json((m.positions ?? { groups: [] }) as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values (${m.key}, ${variantKey}, ${variantKey}, ${sql.json(m.variants[variantKey] as never)}, true)
    on conflict do nothing`;
  return variantKey;
}

const kindOf = (m: AnySportModule): Kind => {
  const kinds = effectiveEntrantModel(m.entrantModel).kinds as readonly Kind[];
  // A pair entrant needs a roster shape this test does not care about; every shipped sport offers team or individual.
  const kind = kinds.includes("team") ? "team" : kinds.includes("individual") ? "individual" : undefined;
  if (kind === undefined) throw new Error(`premise: ${m.key} offers neither a team nor an individual entrant`);
  return kind;
};

interface Scene {
  auth: AuthCtx;
  fixtureId: string;
  entrantId: string;
  divisionId: string;
  persons: string[];
}

/** One sport, one fixture between two entrants, `people` persons who are all members of the FIRST entrant. */
async function seedScene(auth: AuthCtx, m: AnySportModule, people: number): Promise<Scene> {
  const variantKey = await ensureSport(m);
  const suffix = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Bench ${m.key} ${suffix}`,
    visibility: "private",
    branding: {},
  } as never);
  const division = await createDivision(auth, comp.id, {
    name: `Bench ${m.key}`,
    slug: `bench-${m.key}-${suffix}`,
    sport_key: m.key,
    variant_key: variantKey,
    config: {},
  } as never);
  const kind = kindOf(m);
  const [mine, theirs] = await createEntrants(auth, division.id, [
    { kind, display_name: "Mine", seed: 1, members: [] },
    { kind, display_name: "Theirs", seed: 2, members: [] },
  ] as never);
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${division.id}, 1, 'league', 'League') returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${division.id}, 1, 1, ${mine!.id}, ${theirs!.id}, 'scheduled') returning id`;
  const rows = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name)
    select ${auth.orgId}, ${`${m.key} P`} || g from generate_series(1, ${people}) g returning id`;
  const persons = rows.map((r) => r.id);
  for (const id of persons) await sql`insert into entrant_members (entrant_id, person_id) values (${mine!.id}, ${id})`;
  return { auth, fixtureId, entrantId: mine!.id, divisionId: division.id, persons };
}

const url = (s: Scene) => `http://localhost/api/v1/fixtures/${s.fixtureId}/lineups/${s.entrantId}`;
const ctx = (s: Scene) => ({ params: Promise.resolve({ id: s.fixtureId, entrantId: s.entrantId }) });

interface Answer {
  status: number;
  body: { ok: boolean; data?: { slots: { person_id: string; slot: string; role: string }[]; warnings?: string[]; checked?: boolean }; error?: { code: string; message: string; bench_max?: number; bench_rows?: number } };
}

async function put(s: Scene, slots: Wire[]): Promise<Answer> {
  requireFixtureActorMock.mockResolvedValue(s.auth);
  const res = await PUT(
    new Request(url(s), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots }) }),
    ctx(s),
  );
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

async function get(s: Scene): Promise<Answer> {
  requireFixtureActorMock.mockResolvedValue(s.auth);
  const res = await GET(new Request(url(s)), ctx(s));
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

async function stored(s: Scene): Promise<{ person_id: string; slot: string }[]> {
  return sql<{ person_id: string; slot: string }[]>`
    select person_id, slot from lineups where fixture_id = ${s.fixtureId} and entrant_id = ${s.entrantId} order by order_no`;
}

describe.skipIf(!HAS_DB)("PUT lineups — the bench a catalog does not have", () => {
  it("premise: the registry declares a no-bench trio and sports with a bench, so the sweeps below can fail", () => {
    expect(NO_BENCH.map((s) => s.module.key).sort()).toEqual(expect.arrayContaining(["boardgame", "carrom", "generic"]));
    expect(WITH_BENCH.length).toBeGreaterThan(0);
  });

  it("sweep: starters + one bench row is refused (422, named code, nothing written) exactly where benchMax is 0, saved everywhere else", async () => {
    const { auth } = await seedOrg();
    let refused = 0;
    let saved = 0;
    for (const { module, benchMax } of SPORTS) {
      const s = await seedScene(auth, module, 2);
      const [a, b] = s.persons as [string, string];
      const answer = await put(s, [
        { person_id: a, slot: "starting", order_no: 1 },
        { person_id: b, slot: "bench", order_no: 2 },
      ]);
      if (benchMax === 0) {
        expect(answer.status, `${module.key}: status`).toBe(422);
        expect(answer.body.ok, `${module.key}: envelope`).toBe(false);
        expect(answer.body.error?.code, `${module.key}: code`).toBe(CODE);
        expect(answer.body.error?.bench_max, `${module.key}: the limit it refused against`).toBe(0);
        expect(answer.body.error?.bench_rows, `${module.key}: bench rows it counted`).toBe(1);
        expect(await stored(s), `${module.key}: nothing written`).toEqual([]);
        refused++;
      } else {
        expect(answer.status, `${module.key}: status`).toBe(200);
        expect(await stored(s), `${module.key}: both rows written`).toEqual([
          { person_id: a, slot: "starting" },
          { person_id: b, slot: "bench" },
        ]);
        saved++;
      }
    }
    expect(refused + saved).toBe(SPORTS.length);
    expect(refused).toBe(NO_BENCH.length);
    expect(refused).toBeGreaterThanOrEqual(3);
    expect(saved).toBeGreaterThan(0);
  }, 120_000);

  it("the same sports accept the same sheet with no bench row — starters only, and an empty lineup", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const { module } of NO_BENCH) {
      const s = await seedScene(auth, module, 2);
      const [a] = s.persons as [string, string];
      const starters = await put(s, [{ person_id: a, slot: "starting", order_no: 1 }]);
      expect(starters.status, `${module.key}: starters only`).toBe(200);
      expect(starters.body.data?.slots.map((x) => x.slot), `${module.key}: stored`).toEqual(["starting"]);
      // The empty case: no slots at all is not a bench row, and replaces the lineup with nothing.
      const empty = await put(s, []);
      expect(empty.status, `${module.key}: empty lineup`).toBe(200);
      expect(await stored(s), `${module.key}: emptied`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(NO_BENCH.length);
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("a second PUT: a refused bench PUT leaves the lineup already on file untouched, and a repeat of the good one still works", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const { module } of NO_BENCH) {
      const s = await seedScene(auth, module, 3);
      const [a, b, c] = s.persons as [string, string, string];
      const first = await put(s, [{ person_id: a, slot: "starting", order_no: 1 }]);
      expect(first.status, `${module.key}: first`).toBe(200);
      // Replacing it with a sheet that has a bench row is refused, and the lineup on file is still there afterwards.
      // (Not a placement witness: the whole PUT is one transaction, so a refusal thrown after the writes would roll
      // them back too. What it pins is that a refused PUT never costs an organiser the sheet they already had.)
      const refused = await put(s, [
        { person_id: b, slot: "starting", order_no: 1 },
        { person_id: c, slot: "bench", order_no: 2 },
      ]);
      expect(refused.status, `${module.key}: second`).toBe(422);
      expect(refused.body.error?.code).toBe(CODE);
      expect(await stored(s), `${module.key}: the first lineup survives`).toEqual([{ person_id: a, slot: "starting" }]);
      // And the very same refusal twice is the same refusal, not a different failure.
      const again = await put(s, [{ person_id: c, slot: "bench", order_no: 1 }]);
      expect(again.status, `${module.key}: third`).toBe(422);
      expect(again.body.error?.bench_rows).toBe(1);
      expect(await stored(s), `${module.key}: still the first`).toEqual([{ person_id: a, slot: "starting" }]);
      // A repeat of the accepted PUT is idempotent.
      const repeat = await put(s, [{ person_id: a, slot: "starting", order_no: 1 }]);
      expect(repeat.status, `${module.key}: repeat`).toBe(200);
      expect(await stored(s), `${module.key}: repeat stored`).toEqual([{ person_id: a, slot: "starting" }]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("counts every bench row (3 sent, 3 reported) and a coach or staff bench row is a bench row too", async () => {
    const { auth } = await seedOrg();
    const { module } = NO_BENCH[0]!;
    const s = await seedScene(auth, module, 4);
    const [a, b, c, d] = s.persons as [string, string, string, string];
    const answer = await put(s, [
      { person_id: a, slot: "starting", order_no: 1 },
      { person_id: b, slot: "bench", order_no: 2 },
      { person_id: c, slot: "bench", role: "coach", order_no: 3 },
      { person_id: d, slot: "bench", role: "staff", order_no: 4 },
    ]);
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe(CODE);
    expect(answer.body.error?.bench_rows).toBe(3);
    // A lone coach row on the bench is refused on its own.
    const coachOnly = await put(s, [{ person_id: c, slot: "bench", role: "coach", order_no: 1 }]);
    expect(coachOnly.status).toBe(422);
    expect(coachOnly.body.error?.bench_rows).toBe(1);
    expect(await stored(s)).toEqual([]);
  });

  it("READS are untouched: a bench row saved before this rule still reads back, and can be replaced by a sheet without it", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const { module } of NO_BENCH) {
      const s = await seedScene(auth, module, 2);
      const [a, b] = s.persons as [string, string];
      // Legacy data: written straight into the table, the way the old door used to let it in.
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no)
        values (${s.fixtureId}, ${s.entrantId}, ${a}, ${auth.orgId}, 'starting', 1),
               (${s.fixtureId}, ${s.entrantId}, ${b}, ${auth.orgId}, 'bench', 2)`;
      const read = await get(s);
      expect(read.status, `${module.key}: GET`).toBe(200);
      expect(read.body.data?.slots.map((x) => [x.person_id, x.slot]), `${module.key}: GET rows`).toEqual([
        [a, "starting"],
        [b, "bench"],
      ]);
      // Re-sending the sheet as it stands is refused...
      const resend = await put(s, [
        { person_id: a, slot: "starting", order_no: 1 },
        { person_id: b, slot: "bench", order_no: 2 },
      ]);
      expect(resend.status, `${module.key}: resend with the bench`).toBe(422);
      expect((await get(s)).body.data?.slots.length, `${module.key}: the legacy sheet is still there`).toBe(2);
      // ...and dropping the bench row is the way through.
      const fixed = await put(s, [{ person_id: a, slot: "starting", order_no: 1 }]);
      expect(fixed.status, `${module.key}: without the bench`).toBe(200);
      expect(await stored(s)).toEqual([{ person_id: a, slot: "starting" }]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("a division whose sport module cannot be resolved is not refused — the existing save-unchecked posture, not a 500", async () => {
    const { auth } = await seedOrg();
    const { module } = NO_BENCH[0]!;
    const s = await seedScene(auth, module, 2);
    const [a, b] = s.persons as [string, string];
    await sql`update divisions set module_version = '9.9.9' where id = ${s.divisionId}`;
    const answer = await put(s, [
      { person_id: a, slot: "starting", order_no: 1 },
      { person_id: b, slot: "bench", order_no: 2 },
    ]);
    // Without a catalog there is no benchMax to refuse against: it saves, and says it did not check.
    expect(answer.status).toBe(200);
    expect(answer.body.data?.checked).toBe(false);
    expect(await stored(s)).toHaveLength(2);
  });
});

describe.skipIf(!HAS_DB)("PUT lineups — a sport WITH a bench keeps it (owner scope: benchMax 0 only)", () => {
  it("a bench exactly at the catalog's benchMax is saved with no bench warning, in every sport that has a bench", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const { module, benchMax } of WITH_BENCH) {
      const s = await seedScene(auth, module, 1 + benchMax!);
      const [first, ...rest] = s.persons as [string, ...string[]];
      const answer = await put(s, [
        { person_id: first, slot: "starting", order_no: 1 },
        ...rest.map((person_id, i) => ({ person_id, slot: "bench" as const, order_no: i + 2 })),
      ]);
      expect(answer.status, `${module.key}: ${benchMax} on the bench`).toBe(200);
      expect((await stored(s)).filter((r) => r.slot === "bench"), `${module.key}: bench rows stored`).toHaveLength(benchMax!);
      expect(
        (answer.body.data?.warnings ?? []).filter((w) => /bench/i.test(w)),
        `${module.key}: no bench warning at the limit`,
      ).toEqual([]);
      checked++;
    }
    expect(checked).toBe(WITH_BENCH.length);
  }, 180_000);

  it("a bench ONE over the catalog's benchMax is still saved, with the soft bench_size warning — not this refusal", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const { module, benchMax } of WITH_BENCH) {
      const s = await seedScene(auth, module, 2 + benchMax!);
      const [first, ...rest] = s.persons as [string, ...string[]];
      expect(rest).toHaveLength(benchMax! + 1);
      const answer = await put(s, [
        { person_id: first, slot: "starting", order_no: 1 },
        ...rest.map((person_id, i) => ({ person_id, slot: "bench" as const, order_no: i + 2 })),
      ]);
      expect(answer.status, `${module.key}: ${benchMax! + 1} on a bench of ${benchMax}`).toBe(200);
      expect((await stored(s)).filter((r) => r.slot === "bench"), `${module.key}: stored`).toHaveLength(benchMax! + 1);
      const warned = (answer.body.data?.warnings ?? []).filter((w) => /bench/i.test(w));
      expect(warned, `${module.key}: the warning names both numbers`).toHaveLength(1);
      expect(warned[0]).toContain(String(benchMax! + 1));
      expect(warned[0]).toContain(String(benchMax));
      checked++;
    }
    expect(checked).toBe(WITH_BENCH.length);
  }, 180_000);
});
