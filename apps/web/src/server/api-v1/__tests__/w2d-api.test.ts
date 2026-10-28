// W2d Task 13 (spec §7, §10, §6 W9; rule rows X-TB-1, X-TB-5, X-PT-3) — the table rules over API v1, through the REAL
// route handlers (the `v1()` envelope, `parseBody`, `requireResourceAuth` with a session, the usecases) on the label DB:
//
//   GET /stages/{id} and GET /divisions/{id}/stages  → `tableRules`: the order, its source and pin, the sport's default
//                                                      (the editor's Reset, PS-7b), the cross-group order, the points and
//                                                      the outcomes they range over;
//   PUT /stages/{id}/rules                           → the own order arms (`tiebreakers`, `crossGroupTiebreakers`), the
//                                                      strict body, the refusals by name (TIEBREAK_KEY_INVALID,
//                                                      POINTS_OUTCOME_UNCOVERED, POINTS_SPLIT_FLATTENED);
//   GET /stages/{id}/standings and the public one    → rows with `won_ot`/`won_so`/`lost_ot`/`lost_so`, `tieBreak.drawnAt`,
//                                                      `level`, validated against the documented schema;
//   PATCH /divisions/{id}                            → `stagesKeptPinned` after activation;
//   both standings endpoints (W2e Task 27, D11 b)     → `rank: null` on every row of a LEVEL table, at the route only: the
//                                                      stored snapshot and `getStandings` keep the places 1..n (E24), the
//                                                      public route's Redis entry is `standings-v2`.
//
// Carried from PR A (orchestrator rulings): N2 (a flat rule over a split sport is refused naming the split; fix round 1 I1:
// its premise — that some flat rule pays a split sport as the sport does — is false, a retirement after play always pays
// the flat loss), N3 (the same answer for a rule `replaceStages` carries), m8 (the API's tie-break enums take
// `fewest_played` and `h2h_incomplete`), and the strict body (an unknown top-level key is 400).
//
// Expected values come from the rulebooks named in each test and the engine's declarations (`defaultTiebreakers`,
// `validateCascade`, `reachableOutcomes`, `coverage`, `defaultCrossGroup`, `primaryTableKey`), never from the code under
// test. DB cases are skipped without DATABASE_URL; the schema and scan cases are pure.
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HAS_DB = !!process.env.DATABASE_URL;

// The session door, as the desk route test drives it: the caller is the scene's owner; everything else is real.
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
// The public Redis documents, in memory (as the real client holds them: JSON text), so the public standings route is read
// THROUGH its cache. Only `pub:v1:` keys are held; a literal DEL and a `prefix*` sweep apply the moment they are called, as
// the score writes' invalidation does in production. `gets`/`hits` count every ask and every found entry per key.
const redis = vi.hoisted(() => ({ docs: new Map<string, string>(), gets: new Map<string, number>(), hits: new Map<string, number>(), sets: [] as string[] }));
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  const held = (key: string) => key.startsWith("pub:v1:");
  return {
    ...actual,
    cacheGet: async (key: string) => {
      if (!held(key)) return actual.cacheGet(key);
      redis.gets.set(key, (redis.gets.get(key) ?? 0) + 1);
      const raw = redis.docs.get(key);
      if (raw === undefined) return null;
      redis.hits.set(key, (redis.hits.get(key) ?? 0) + 1);
      return JSON.parse(raw);
    },
    cacheSet: async (key: string, value: unknown, ttlSeconds: number) => {
      if (!held(key)) return actual.cacheSet(key, value, ttlSeconds);
      redis.sets.push(key);
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

import { PointsRule, coverage, defaultCrossGroup, isLevelTable, membersKeyOf, rankText, reachableOutcomes, validateCascade, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import * as S from "@/server/api-v1/schemas";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { generateStageFixtures, getStandings } from "@/server/usecases/stages";
import { serialiseLevelRanks } from "@/server/api-v1/level-rank";
import { startDivision } from "@/server/usecases/schedule";
import { between, genericResult, seatedFixtures, tableScene } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
import { fixtureRow, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { GET as getStageRoute } from "@/app/api/v1/stages/[id]/route";
import { PUT as putRulesRoute } from "@/app/api/v1/stages/[id]/rules/route";
import { GET as standingsRoute } from "@/app/api/v1/stages/[id]/standings/route";
import { GET as listStagesRoute, PUT as replaceStagesRoute } from "@/app/api/v1/divisions/[id]/stages/route";
import { PATCH as patchDivisionRoute } from "@/app/api/v1/divisions/[id]/route";
import { PUT as putFixtureRulesRoute } from "@/app/api/v1/fixtures/[id]/rules/route";
import { GET as publicStandingsRoute } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/divisions/[divisionSlug]/standings/route";

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 1 });
});

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
const parsedCfg = (m: AnySportModule, cfg: unknown): unknown => m.configSchema.parse(cfg);

// ── The HTTP half: a request through the real handler, its envelope read back ──────────────────────────────────────

interface Envelope {
  status: number;
  data: unknown;
  error: { code: string; message: string; [k: string]: unknown } | undefined;
}
type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;
async function call<P>(handler: Handler<P>, params: P, method: string, path: string, body?: unknown): Promise<Envelope> {
  const req = new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  const json = (await res.json()) as { ok: boolean; data?: unknown; error?: Envelope["error"] };
  return { status: res.status, data: json.data, error: json.error };
}

/** The scene's owner is the session caller. */
const as = <T extends { auth: { userId: string | null } }>(s: T): T => {
  authState.userId = s.auth.userId ?? "";
  return s;
};

type Wire = ReturnType<typeof S.StageWithTableRules.parse>;
async function getStage(stageId: string): Promise<Wire> {
  const r = await call(getStageRoute, { id: stageId }, "GET", `/stages/${stageId}`);
  expect(r.status, `GET /stages/${stageId}: ${JSON.stringify(r.error)}`).toBe(200);
  // The served document is the documented one (OpenAPI is generated from this schema).
  return S.StageWithTableRules.parse(r.data);
}
async function listStages(divisionId: string): Promise<Wire[]> {
  const r = await call(listStagesRoute, { id: divisionId }, "GET", `/divisions/${divisionId}/stages`);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return S.StageWithTableRules.array().parse(r.data);
}
const putRules = (stageId: string, body: unknown) => call(putRulesRoute, { id: stageId }, "PUT", `/stages/${stageId}/rules`, body);
const patchDivision = (divisionId: string, body: unknown) => call(patchDivisionRoute, { id: divisionId }, "PATCH", `/divisions/${divisionId}`, body);
const standings = async (stageId: string) => {
  const r = await call(standingsRoute, { id: stageId }, "GET", `/stages/${stageId}/standings`);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return S.StandingsSnapshot.parse(r.data);
};
const pinnedAtOf = async (stageId: string): Promise<string | null> =>
  (await sql<{ at: string | null }[]>`select to_json(table_rules_pinned_at) #>> '{}' as at from stages where id = ${stageId}`)[0]!.at;
const stageConfig = async (stageId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const divisionCfg = async (divisionId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;
const sorted = (xs: readonly string[]) => [...xs].sort();

// ── W2e Task 27 (spec §6.3 D11 b): rank null while a table is level, at the two route handlers only ─────────────────────

/** A standings row as the wire carries it, read UNPARSED: the documented schema takes a null and an omitted rank alike. */
interface WireRow {
  entrantId: string;
  rank?: number | null;
  level?: boolean;
}
interface WireTable {
  stage_id: string;
  pool_id: string | null;
  rows: WireRow[];
}
/** GET /stages/{id}/standings (a pool's table with `poolId`): the rows as served, the document checked against the schema. */
async function stageTable(stageId: string, poolId?: string): Promise<WireRow[]> {
  const q = poolId === undefined ? "" : `?pool_id=${poolId}`;
  const r = await call(standingsRoute, { id: stageId }, "GET", `/stages/${stageId}/standings${q}`);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  S.StandingsSnapshot.parse(r.data);
  return (r.data as { rows: WireRow[] }).rows;
}
/** The division's competition made public; the three slugs the public read is addressed by. */
async function publish(divisionId: string): Promise<[string, string, string]> {
  await sql`update competitions set visibility = 'public' where id = (select competition_id from divisions where id = ${divisionId})`;
  const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
    select o.slug as org, c.slug as comp, d.slug as div
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${divisionId}`;
  return [slugs!.org, slugs!.comp, slugs!.div];
}
/** GET …/divisions/{divisionSlug}/standings: every published table as served, the document checked against the schema. */
async function publicTables([orgSlug, slug, divisionSlug]: readonly [string, string, string]): Promise<WireTable[]> {
  const r = await call(publicStandingsRoute, { orgSlug, slug, divisionSlug }, "GET", `/public/orgs/${orgSlug}/competitions/${slug}/divisions/${divisionSlug}/standings`);
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  S.PublicDivisionStandings.parse(r.data);
  return (r.data as { standings: WireTable[] }).standings;
}
/** `rank` is PRESENT and null on every row (an omitted key would read the same through the schema), and the row is still
 *  level; returns the rows checked (anti-vacuity: the caller states how many it expects). */
function expectRankNull(rows: readonly WireRow[], expected: number, what: string): number {
  expect(rows.length, `${what}: one row per entrant`).toBe(expected);
  for (const r of rows) {
    expect(Object.hasOwn(r, "rank"), `${what}: ${r.entrantId} carries the rank key`).toBe(true);
    expect(r.rank, `${what}: ${r.entrantId}`).toBeNull();
    expect(r.level, `${what}: ${r.entrantId} is still level`).toBe(true);
  }
  return rows.length;
}
/** The places 1..n and no level row (the ranker's positional rank, a tie included). Returns the rows checked. */
function expectPlaces(rows: readonly WireRow[], expected: number, what: string): number {
  expect(rows.length, `${what}: one row per entrant`).toBe(expected);
  for (const r of rows) {
    expect(typeof r.rank, `${what}: ${r.entrantId} keeps its place`).toBe("number");
    expect(r.level, `${what}: ${r.entrantId} is not level`).not.toBe(true);
  }
  expect(rows.map((r) => r.rank as number).sort((a, b) => a - b), `${what}: the places`).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
  return rows.length;
}

// single-sport: generic is the rig's sport for the sport-blind rules below; a test whose rule belongs to one sport names that sport (and says why).
const generic = mod("generic");
const GENERIC_DEFAULT = generic.defaultTiebreakers("league", parsedCfg(generic, GENERIC_CONFIG));
const DIV_ORDER: TiebreakerKey[] = ["points", "diff", "lots"];
const OWN_ORDER: TiebreakerKey[] = ["points", "for", "diff", "lots"];
/** A rule that pays every outcome generic reaches (a win, a loss, a draw) and differs from generic's own 3/1/0. */
const RULE = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] } as const;

// single-sport: table tennis is the split (a loss not played, ITTF 2/1/0 — rulebook-W2-sets-cricket.md:218-221, spec D6)
// a flat rule's forfeit row seems to pay whole: the row pays the walkover 2/0, but a retirement AFTER play pays the flat
// loss (1) where ITTF pays the retired loser 0 (fix round 1 I1).
const tt = mod("tabletennis");
const TT_DECLARED = tt.tablePointsRule(parsedCfg(tt, tt.variants.bo5), "league");
const ITTF_FLAT = { win: { regulation: 2 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } };
/** The split the ENGINE declares for a table-tennis league — the loss not played paid apart — so the refusal names it. */
const TT_SPLITS = TT_DECLARED.loss.unplayed !== undefined && TT_DECLARED.loss.unplayed !== TT_DECLARED.loss.regulation ? ["unplayed"] : [];
/** ITTF's rule with the split STATED (the engine's own amounts): the caller's choice, never refused. */
const ITTF_STATED = { ...ITTF_FLAT, win: { regulation: TT_DECLARED.win.regulation }, loss: { regulation: TT_DECLARED.loss.regulation, unplayed: TT_DECLARED.loss.unplayed } };

describe.skipIf(!HAS_DB)("W2d T13 the table rules over API v1 (route handlers, label DB)", () => {
  it("premise: the orders the tests save are valid generic league orders, and differ from the sport's own and from each other", () => {
    const ctx = { module: generic, cfg: parsedCfg(generic, GENERIC_CONFIG), stageKind: "league" as const, crossGroup: false };
    expect(validateCascade(DIV_ORDER, ctx)).toEqual([]);
    expect(validateCascade(OWN_ORDER, ctx)).toEqual([]);
    expect(new Set([JSON.stringify(GENERIC_DEFAULT), JSON.stringify(DIV_ORDER), JSON.stringify(OWN_ORDER)]).size).toBe(3);
  });

  it("X-TB-1 GET /stages/{id} returns tableRules with source 'sport' before any edit, 'division' after a division default, 'stage' after PUT rules", async () => {
    const s = as(await tableScene({ entrants: 2 }));
    const [stageId] = s.stageIds as [string];
    const reach = sorted([...reachableOutcomes(generic, parsedCfg(generic, GENERIC_CONFIG), "league")]);
    expect(reach.length, "premise: generic reaches outcomes").toBeGreaterThan(0);

    // GET before any edit: the sport's order and points, nothing pinned.
    const before = (await getStage(stageId)).tableRules!;
    expect(before.tiebreakers).toEqual({ keys: GENERIC_DEFAULT, source: "sport", pinnedAt: null, sportDefault: GENERIC_DEFAULT });
    expect(before.crossGroup.keys).toEqual(defaultCrossGroup(GENERIC_DEFAULT));
    expect(before.points.source).toBe("sport");
    expect(before.points.rule, "the sport's own points for the kind").toEqual(PointsRule.parse(generic.tablePointsRule(parsedCfg(generic, GENERIC_CONFIG), "league")));
    expect(before.points.pinnedAt).toBeNull();
    expect(sorted(before.reachableOutcomes)).toEqual(reach);
    // The stages list carries the same rules for the same stage.
    const listed = await listStages(s.divisionId);
    expect(listed.map((x) => x.id)).toEqual([stageId]);
    expect(listed[0]!.tableRules).toEqual(before);

    // A division default: the pending stage inherits it.
    const patched = await patchDivision(s.divisionId, { tiebreakers: DIV_ORDER });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    const inherited = (await getStage(stageId)).tableRules!;
    expect(inherited.tiebreakers).toEqual({ keys: DIV_ORDER, source: "division", pinnedAt: null, sportDefault: GENERIC_DEFAULT });
    expect(inherited.crossGroup.keys).toEqual(defaultCrossGroup(DIV_ORDER));

    // PUT the stage's own order: the answer carries it, and the GET says it is the stage's.
    const put = await putRules(stageId, { tiebreakers: OWN_ORDER });
    expect(put.status, JSON.stringify(put.error)).toBe(200);
    expect(S.StageRules.parse(put.data)).toMatchObject({ tiebreakers: OWN_ORDER, crossGroupTiebreakers: null, points: null });
    const own = (await getStage(stageId)).tableRules!;
    expect(own.tiebreakers).toEqual({ keys: OWN_ORDER, source: "stage", pinnedAt: null, sportDefault: GENERIC_DEFAULT });
    expect(own.points.source, "the order arm leaves the points as they were").toBe("sport");

    // The stage's own points: the points' source moves, the order's stays.
    const putPoints = await putRules(stageId, { points: RULE });
    expect(putPoints.status, JSON.stringify(putPoints.error)).toBe(200);
    const withPoints = (await getStage(stageId)).tableRules!;
    expect(withPoints.points).toEqual({ rule: PointsRule.parse(RULE), source: "stage", pinnedAt: null });
    expect(withPoints.tiebreakers.source).toBe("stage");

    // The sequence: clearing the own order falls back to the division's (a second call, null).
    const cleared = await putRules(stageId, { tiebreakers: null });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect(S.StageRules.parse(cleared.data).tiebreakers).toBeNull();
    expect((await getStage(stageId)).tableRules!.tiebreakers.source).toBe("division");

    // Generated: the stage is pinned, and the GET says when (the DB's own stamp); the sources the pin took are kept.
    await generateStageFixtures(s.auth, stageId);
    const pinnedAt = await pinnedAtOf(stageId);
    expect(pinnedAt, "premise: generating pins the stage").not.toBeNull();
    const pinned = (await getStage(stageId)).tableRules!;
    expect(pinned.tiebreakers).toEqual({ keys: DIV_ORDER, source: "division", pinnedAt, sportDefault: GENERIC_DEFAULT });
    expect(pinned.points).toEqual({ rule: PointsRule.parse(RULE), source: "stage", pinnedAt });

    // Another sport: a BWF league takes its own order, h2h_two steps and all (BWF GCR 16.2: the two-way head-to-head).
    const bwf = mod("badminton");
    const b = as(await tableScene({ sport: "badminton", variant: "bwf", entrants: 2 }));
    const bwfCfg = parsedCfg(bwf, await divisionCfg(b.divisionId));
    const bwfDefault = bwf.defaultTiebreakers("league", bwfCfg);
    expect(bwfDefault, "premise: BWF's own order splits two-way ties head to head").toContain("h2h_two");
    const bwfOwn = bwfDefault.filter((k, i) => k !== "point_diff" && !(k === "h2h_two" && i === bwfDefault.lastIndexOf("h2h_two")));
    expect(bwfOwn).toContain("h2h_two");
    expect(validateCascade(bwfOwn, { module: bwf, cfg: bwfCfg, stageKind: "league", crossGroup: false }), "premise: a valid BWF order").toEqual([]);
    expect(bwfOwn).not.toEqual(bwfDefault);
    const bwfPut = await putRules(b.stageIds[0]!, { tiebreakers: bwfOwn });
    expect(bwfPut.status, JSON.stringify(bwfPut.error)).toBe(200);
    const bwfRules = (await getStage(b.stageIds[0]!)).tableRules!;
    expect(bwfRules.tiebreakers).toEqual({ keys: bwfOwn, source: "stage", pinnedAt: null, sportDefault: bwfDefault });

    // Another org's stage is not served to this caller (not a member: 401, and no body).
    authState.userId = s.auth.userId ?? "";
    const foreign = await call(getStageRoute, { id: b.stageIds[0]! }, "GET", `/stages/${b.stageIds[0]}`);
    expect([foreign.status, foreign.error?.code]).toEqual([401, "UNAUTHENTICATED"]);
    expect(foreign.data).toBeUndefined();
  });

  it("PS-7b tableRules.tiebreakers.sportDefault is the sport's default for the stage kind and the division cfg even when an own order wins (football with fairPlay off: no fair_play; on: fair_play before lots)", async () => {
    // single-sport: PS-7b's witness is football's fair-play step, the one default order a division cfg key (FIFA's fair
    // play, tracked or not) moves.
    const football = mod("football");
    const own: TiebreakerKey[] = [football.primaryTableKey, "diff", "for", "lots"];
    let checked = 0;
    for (const fairPlay of [false, true]) {
      const s = as(await tableScene({ sport: "football", variant: "11-a-side", config: { ...(football.variants["11-a-side"] as object), fairPlay }, entrants: 2 }));
      const cfg = parsedCfg(football, await divisionCfg(s.divisionId)) as { fairPlay: boolean };
      expect(cfg.fairPlay, "premise: the division tracks fair play as asked").toBe(fairPlay);
      const want = football.defaultTiebreakers("league", cfg);
      // FIFA World Cup 2026 Art. 13: fair play is the step before the drawing of lots — when the division tracks cards.
      if (fairPlay) expect(want.slice(-2), "on: fair_play right before lots").toEqual(["fair_play", "lots"]);
      else expect(want, "off: no fair_play step").not.toContain("fair_play");
      expect(validateCascade(own, { module: football, cfg, stageKind: "league", crossGroup: false })).toEqual([]);
      const put = await putRules(s.stageIds[0]!, { tiebreakers: own });
      expect(put.status, JSON.stringify(put.error)).toBe(200);
      const rules = (await getStage(s.stageIds[0]!)).tableRules!;
      expect(rules.tiebreakers.keys, "the own order wins").toEqual(own);
      expect(rules.tiebreakers.sportDefault, "the Reset is the sport's, never the winning order").toEqual(want);
      expect(rules.tiebreakers.sportDefault).not.toEqual(own);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-TB-5 PUT /stages/{id}/rules {tiebreakers:['points','nrr','lots']} on football → 422 TIEBREAK_KEY_INVALID, extra.refusals[0] = {index:1,key:'nrr',reason:'sport'}", async () => {
    // single-sport: the sport refusal needs a sport that records no net run rate (cricket's step); football is one.
    const football = mod("football");
    const s = as(await tableScene({ sport: "football", variant: "11-a-side", entrants: 2 }));
    const order: TiebreakerKey[] = ["points", "nrr", "lots"];
    const cfg = parsedCfg(football, await divisionCfg(s.divisionId));
    const want = validateCascade(order, { module: football, cfg, stageKind: "league", crossGroup: false });
    expect(want[0], "premise: the engine refuses nrr for the sport").toMatchObject({ index: 1, key: "nrr", reason: "sport" });
    const r = await putRules(s.stageIds[0]!, { tiebreakers: order });
    expect(r.status).toBe(422);
    expect(r.error?.code).toBe("TIEBREAK_KEY_INVALID");
    // The brief's triple; the engine's refusal also says what the step needs (`need`), so the whole list is the engine's.
    expect((r.error?.refusals as unknown[])[0]).toMatchObject({ index: 1, key: "nrr", reason: "sport" });
    expect(r.error?.refusals).toEqual(want);
    expect(Object.hasOwn(await stageConfig(s.stageIds[0]!), "tiebreakers"), "nothing stored").toBe(false);
    expect((await getStage(s.stageIds[0]!)).tableRules!.tiebreakers.source, "the stage still reads the sport's order").toBe("sport");
    // The positive pair, same stage: the sport's own default as the stage's order.
    const fine = football.defaultTiebreakers("league", cfg);
    const ok = await putRules(s.stageIds[0]!, { tiebreakers: [...fine] });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect((await getStage(s.stageIds[0]!)).tableRules!.tiebreakers).toMatchObject({ keys: fine, source: "stage" });
  });

  it("X-PT-3 PUT /fixtures/{id}/rules best of 3 on a FIVB best-of-5 stage → 422 POINTS_OUTCOME_UNCOVERED, extra.uncovered ['set:2-0','set:2-1']", async () => {
    // single-sport: X-PT-3's case is volleyball's (FIVB V3: a best-of-5 table priced by 3-0/3-1/3-2).
    const vb = mod("volleyball");
    const s = as(await tableScene({ sport: "volleyball", variant: "indoor", entrants: 2 }));
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const rules = (await getStage(stageId)).tableRules!;
    expect(rules.points.pinnedAt, "premise: pinned").not.toBeNull();
    const cfg = parsedCfg(vb, await divisionCfg(s.divisionId)) as { bestOf: number };
    expect(cfg.bestOf, "premise: indoor is a best-of-5").toBe(5);
    const want = coverage(PointsRule.parse(rules.points.rule), reachableOutcomes(vb, { ...cfg, bestOf: 3 }, "league"));
    expect(want, "premise: the FIVB best-of-5 rule pays no best-of-3 score").toEqual({ ok: false, uncovered: ["set:2-0", "set:2-1"], inapplicable: [] });
    const f = await between(stageId, s.entrants[0]!, s.entrants[1]!);
    const r = await call(putFixtureRulesRoute, { id: f.id }, "PUT", `/fixtures/${f.id}/rules`, { rules: { bestOf: 3 } });
    expect(r.status).toBe(422);
    expect(r.error?.code).toBe("POINTS_OUTCOME_UNCOVERED");
    expect(r.error?.uncovered).toEqual(["set:2-0", "set:2-1"]);
    const [{ rules_override }] = await sql<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${f.id}`;
    expect(rules_override, "nothing stored").toBeNull();
    // The positive pair: the reachable outcomes the stage serves are the ones the stage's own format reaches.
    expect(sorted(rules.reachableOutcomes)).toEqual(sorted([...reachableOutcomes(vb, cfg, "league")]));
  });

  it("an old-shape points body {base:{…}} is 400 (greenfield, no alias); so is any unknown top-level key (the strict body)", async () => {
    const s = as(await tableScene({ entrants: 2 }));
    const stageId = s.stageIds[0]!;
    const old = await putRules(stageId, { points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [] } });
    expect(old.status).toBe(400);
    expect(old.error?.code).toBe("VALIDATION");
    const top = await putRules(stageId, { base: { win: 3, draw: 1, loss: 0 } });
    expect(top.status).toBe(400);
    expect(JSON.stringify(top.error?.issues)).toContain("base");
    const stray = await putRules(stageId, { tiebreakers: OWN_ORDER, crossGroupOrder: ["points", "lots"] });
    expect(stray.status, "a misspelled arm is refused, never stripped").toBe(400);
    expect(JSON.stringify(stray.error?.issues)).toContain("crossGroupOrder");
    expect(await stageConfig(stageId), "nothing stored by any of them").not.toHaveProperty("tiebreakers");
    expect(Object.hasOwn(await stageConfig(stageId), "points")).toBe(false);
    // The positive pair: the same order through the real arm.
    const ok = await putRules(stageId, { tiebreakers: OWN_ORDER });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect((await stageConfig(stageId)).tiebreakers).toEqual(OWN_ORDER);
  });

  it("GET standings rows carry won_ot/won_so/lost_ot/lost_so, tieBreak.drawnAt for a lots tie, level on an empty table", async () => {
    // Level on an empty table, then a residual tie only lots can split (generic 3/1/0: A beats C, B beats D; A and B never
    // meet, so they are level on every step before lots), then the public read of the same rows.
    const s = as(await tableScene({ entrants: 4 }));
    const stageId = s.stageIds[0]!;
    const [A, B, C, D] = s.entrants as [string, string, string, string];
    await generateStageFixtures(s.auth, stageId);
    const empty = await standings(stageId);
    expect(empty.rows.length).toBe(4);
    expect(empty.rows.every((r) => r.level === true), "no counted fixture: every row level").toBe(true);
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, stageId, A, C, 1, 0);
    await genericResult(s.auth, stageId, B, D, 1, 0);
    const table = await standings(stageId);
    expect(table.rows.some((r) => r.level === true), "a counted fixture: no row level").toBe(false);
    const draws = await sql<{ members_key: string; drawn_at: string }[]>`
      select members_key, to_json(drawn_at) #>> '{}' as drawn_at from stage_lots_draws where stage_id = ${stageId} and superseded_at is null`;
    const ab = draws.find((d) => d.members_key === membersKeyOf([A, B]));
    expect(ab, `premise: A and B were drawn by lots (${JSON.stringify(draws)})`).toBeDefined();
    for (const id of [A, B]) {
      const row = table.rows.find((r) => r.entrantId === id)!;
      expect(row.tieBreak, `${id}: drawn by lots on the stored draw's date`).toMatchObject({ key: "lots", drawnAt: ab!.drawn_at });
    }

    // The public read serves the same rows, documented the same way.
    await sql`update competitions set visibility = 'public' where id = (select competition_id from divisions where id = ${s.divisionId})`;
    const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id where d.id = ${s.divisionId}`;
    const pub = await call(
      publicStandingsRoute,
      { orgSlug: slugs!.org, slug: slugs!.comp, divisionSlug: slugs!.div },
      "GET",
      `/public/orgs/${slugs!.org}/competitions/${slugs!.comp}/divisions/${slugs!.div}/standings`,
    );
    expect(pub.status, JSON.stringify(pub.error)).toBe(200);
    const doc = S.PublicDivisionStandings.parse(pub.data);
    const pubRows = doc.standings.find((x) => x.stage_id === stageId)?.rows ?? [];
    expect(pubRows.find((r) => r.entrantId === A)?.tieBreak).toMatchObject({ key: "lots", drawnAt: ab!.drawn_at });

    // Another sport: ice hockey (IIHF 3-2-1-0) — an overtime win and a shoot-out win reach the rows' display ledger.
    // single-sport: ice hockey is the one sport whose table reaches both an overtime and a shoot-out decision.
    const h = as(await tableScene({ sport: "icehockey", variant: "iihf", entrants: 3 }));
    const hStage = h.stageIds[0]!;
    await generateStageFixtures(h.auth, hStage);
    await startDivision(h.auth, h.divisionId);
    const [X, Y, Z] = h.entrants as [string, string, string];
    const toFt = [
      { type: "core.start" },
      { type: "icehockey.period.advance", payload: { to: "P2" } },
      { type: "icehockey.period.advance", payload: { to: "P3" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
    ];
    const play = async (x: string, y: string, events: { type: string; payload?: Record<string, unknown> }[]) => {
      const f = await between(hStage, x, y);
      for (const e of events) {
        const payload = Object.fromEntries(Object.entries(e.payload ?? {}).map(([k, v]) => [k, k === "by" ? (v === "W" ? x : y) : v]));
        await post(h.auth, f.id, e.type, payload);
      }
      return fixtureRow(f.id);
    };
    const ot = await play(X, Y, [...toFt, { type: "icehockey.goal", payload: { by: "W" } }]);
    // The shoot-out stream is payout-decided-in-db.test.ts's: five rounds level, then W wins the first tie-break duel. W2e
    // (IIHF 84.4 IX): the side that shot second in the five, L, shoots first in the tie-break, so L misses and W scores.
    const so = await play(Y, Z, [
      ...toFt,
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      ...Array.from({ length: 10 }, (_, i) => ({ type: "icehockey.shootout.attempt", payload: { by: i % 2 === 0 ? "W" : "L", scored: true } })),
      { type: "icehockey.shootout.attempt", payload: { by: "L", scored: false } },
      { type: "icehockey.shootout.attempt", payload: { by: "W", scored: true } },
    ]);
    expect([ot.outcome?.method, so.outcome?.method], "rig: an overtime and a shoot-out decision").toEqual(["extra_time", "shootout"]);
    const hRows = (await standings(hStage)).rows;
    const metric = (id: string, k: string) => hRows.find((r) => r.entrantId === id)?.metrics[k];
    expect([metric(X, "won_ot"), metric(Y, "lost_ot"), metric(Y, "won_so"), metric(Z, "lost_so")]).toEqual([1, 1, 1, 1]);
    expect([metric(X, "won_so"), metric(Z, "won_ot")], "only on the side and the way the match was decided").toEqual([undefined, undefined]);
  });

  it("D11b both endpoints serve rank null on a level table: rank is present and null on every row, and the row is still level", async () => {
    // single-sport: generic is the rig's sport; the registry sweep below covers every sport.
    const s = as(await tableScene({ entrants: 4 }));
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const own = await stageTable(stageId);
    const pub = (await publicTables(await publish(s.divisionId))).filter((t) => t.stage_id === stageId);
    expect(pub.map((t) => t.pool_id), "premise: one public table, the stage's own").toEqual([null]);
    const checked = expectRankNull(own, 4, "GET /stages/{id}/standings") + expectRankNull(pub[0]!.rows, 4, "the public read");
    expect(checked, "both endpoints, every entrant").toBe(8);
    expect(new Set(pub[0]!.rows.map((r) => r.entrantId)), "the same rows on both").toEqual(new Set(own.map((r) => r.entrantId)));
  });

  it("D11b a decided table keeps rank 1..n on both endpoints, and the table goes level -> decided -> level again with the results entered and voided", async () => {
    const s = as(await tableScene({ entrants: 4 }));
    const stageId = s.stageIds[0]!;
    const [A, B, C, D] = s.entrants as [string, string, string, string];
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const slugs = await publish(s.divisionId);
    const both = async () => ({ own: await stageTable(stageId), pub: (await publicTables(slugs)).filter((t) => t.stage_id === stageId) });
    let checked = 0;

    // The empty case first: nothing counted, so level.
    const empty = await both();
    checked += expectRankNull(empty.own, 4, "before a result: own") + expectRankNull(empty.pub[0]!.rows, 4, "before a result: public");

    // A result counts: the places 1..n, no row null, on both (the cached public document dropped by the score write).
    await genericResult(s.auth, stageId, A, C, 1, 0);
    const one = await both();
    checked += expectPlaces(one.own, 4, "one result: own") + expectPlaces(one.pub[0]!.rows, 4, "one result: public");
    await genericResult(s.auth, stageId, B, D, 1, 0);
    const two = await both();
    checked += expectPlaces(two.own, 4, "two results: own") + expectPlaces(two.pub[0]!.rows, 4, "two results: public");

    // Take both results back: nothing counts again, so the table is level again and the wire says so again.
    for (const [x, y] of [[A, C], [B, D]] as const) {
      const f = await between(stageId, x, y);
      const [ev] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${f.id} and type = 'generic.result'`;
      await post(s.auth, f.id, "core.void", { event_id: ev!.id });
    }
    const again = await both();
    checked += expectRankNull(again.own, 4, "both results voided: own") + expectRankNull(again.pub[0]!.rows, 4, "both results voided: public");
    expect(checked, "four reads of each endpoint, every entrant").toBe(32);
  });

  it("D11b each table is judged on its own rows: a stage with a counted result keeps its places while the stage beside it, still level, serves null", async () => {
    // single-sport: which tables are level is sport-blind; generic is the rig's sport.
    const s = as(
      await tableScene({
        entrants: 4,
        stages: [
          { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null },
          { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null },
        ],
      }),
    );
    const [a, b] = s.stageIds as [string, string];
    await generateStageFixtures(s.auth, a);
    await generateStageFixtures(s.auth, b);
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, a, s.entrants[0]!, s.entrants[2]!, 1, 0);
    const pub = await publicTables(await publish(s.divisionId));
    expect(pub.map((t) => t.stage_id).sort(), "premise: both stages publish a table").toEqual([a, b].sort());
    const of = (stageId: string) => pub.find((t) => t.stage_id === stageId)!.rows;
    const checked =
      expectPlaces(await stageTable(a), 4, "the stage with a result: own") +
      expectPlaces(of(a), 4, "the stage with a result: public") +
      expectRankNull(await stageTable(b), 4, "the level stage: own") +
      expectRankNull(of(b), 4, "the level stage: public");
    expect(checked, "two stages of four on both endpoints").toBe(16);
  });

  it("D11b an empty pool table stays an empty list (no rows is no table, never a level one) beside a played pool that keeps its places", async () => {
    // single-sport: pools are a group-stage seam, sport-blind; generic is the rig's sport.
    const s = as(await tableScene({ entrants: 4, stages: { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } } }));
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const fixtures = await seatedFixtures(stageId);
    expect(fixtures, "rig: two pools of two, one match each").toHaveLength(2);
    const played = fixtures[0]!;
    await genericResult(s.auth, stageId, played.home, played.away, 3, 1);
    const stored = await sql<{ pool_id: string; rows: { entrantId: string }[] }[]>`
      select pool_id, rows from standings_snapshots where stage_id = ${stageId} and pool_id is not null`;
    expect(stored, "premise: one stored table per pool").toHaveLength(2);
    const playedPool = stored.find((t) => t.rows.some((r) => r.entrantId === played.home))!;
    const idlePool = stored.find((t) => t !== playedPool)!;
    expect(idlePool.rows, "premise: the pool with no counted fixture stores no rows at all").toEqual([]);

    const pub = (await publicTables(await publish(s.divisionId))).filter((t) => t.stage_id === stageId);
    const poolTable = (poolId: string) => pub.filter((t) => t.pool_id === poolId);
    expect([poolTable(playedPool.pool_id).length, poolTable(idlePool.pool_id).length], "one public table per pool").toEqual([1, 1]);
    expect(expectPlaces(await stageTable(stageId, playedPool.pool_id), 2, "the played pool: own") + expectPlaces(poolTable(playedPool.pool_id)[0]!.rows, 2, "the played pool: public")).toBe(4);
    expect(await stageTable(stageId, idlePool.pool_id), "the idle pool: own").toEqual([]);
    expect(poolTable(idlePool.pool_id)[0]!.rows, "the idle pool: public").toEqual([]);
  });

  it("D11b every sport's level table serves rank null on both endpoints (registry sweep, a generated stage per sport)", async () => {
    let sports = 0;
    let rows = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const s = as(await tableScene({ sport: m.key, variant, entrants: 3 }));
      const stageId = s.stageIds[0]!;
      await generateStageFixtures(s.auth, stageId);
      rows += expectRankNull(await stageTable(stageId), 3, `${m.key}: own`);
      const pub = (await publicTables(await publish(s.divisionId))).filter((t) => t.stage_id === stageId);
      expect(pub, `${m.key}: one public table`).toHaveLength(1);
      rows += expectRankNull(pub[0]!.rows, 3, `${m.key}: public`);
      sports++;
    }
    expect(sports, "every registered sport swept").toBe(builtinModules.length);
    expect(sports, "premise: the registry is not one sport").toBeGreaterThan(1);
    expect(rows, "three entrants on two endpoints per sport").toBe(sports * 6);
  }, 300_000);

  it("D11b the public route serves the new shape through the cache: read twice, held under standings-v2, the old key never asked, a storage-shaped entry served null", async () => {
    const s = as(await tableScene({ entrants: 3 }));
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const slugs = await publish(s.divisionId);
    const OLD = `pub:v1:div:${s.divisionId}:standings`;
    const NEW = `pub:v1:div:${s.divisionId}:standings-v2`;
    // The previous build's entry, left under the key this build used to read: it must never be served.
    redis.docs.set(OLD, JSON.stringify({ division_id: s.divisionId, standings: [{ stage_id: stageId, pool_id: null, rows: [], updated_at: "previous-build" }] }));
    redis.docs.delete(NEW);
    const setsBefore = redis.sets.filter((k) => k === NEW).length;

    const first = await publicTables(slugs);
    expect(redis.sets.filter((k) => k === NEW).length - setsBefore, "the first read missed and filled the new key, once").toBe(1);
    expect(redis.hits.get(NEW) ?? 0, "premise: the first read was a miss").toBe(0);
    const cached = JSON.parse(redis.docs.get(NEW)!) as { standings: { rows: { rank?: number | null }[] }[] };
    expect(cached.standings.flatMap((t) => t.rows).every((r) => typeof r.rank === "number"), "premise: the held entry is the stored shape (E24: only the routes null)").toBe(true);

    const second = await publicTables(slugs);
    expect(redis.hits.get(NEW), "the second read was a hit on the new key").toBe(1);
    expect(redis.sets.filter((k) => k === NEW).length - setsBefore, "and filled nothing more").toBe(1);
    expect(second, "a hit serves what the miss did").toEqual(first);
    const mine = (t: WireTable[]) => t.filter((x) => x.stage_id === stageId);
    expect(expectRankNull(mine(first)[0]!.rows, 3, "the miss") + expectRankNull(mine(second)[0]!.rows, 3, "the hit")).toBe(6);
    expect(redis.gets.get(OLD), "the old key is never asked for").toBeUndefined();
    expect(first.map((t) => t.stage_id), "the real table, not the old key's entry").toEqual([stageId]);

    // The write that drops the entry (a score) drops the new key, and the next read is level -> decided: the places.
    await startDivision(s.auth, s.divisionId);
    const [A, B] = s.entrants as [string, string, string];
    await genericResult(s.auth, stageId, A, B, 1, 0);
    expect(redis.docs.has(NEW), "a score write dropped the new key by name").toBe(false);
    expectPlaces(mine(await publicTables(slugs))[0]!.rows, 3, "after a result");
  });

  it("D11b getStandings still returns rank 1..n for a level table, and the stored snapshot keeps them: the dash comes from level, never from a null rank", async () => {
    const s = as(await tableScene({ entrants: 4 }));
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const rows = (await getStandings(s.auth, stageId)).rows as StandingsRow[];
    expect(rows.length, "one row per entrant").toBe(4);
    expect(rows.map((r) => r.rank).sort(), "the usecase keeps the places 1..n").toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.level === true), "premise: the table is level").toBe(true);
    // rankText consumers (PDF export, slideshow, OG card, digest) print the dash from `level`, with the rank still a number.
    // The dash is the spec's en dash (§5.7), typed here.
    expect(isLevelTable(rows), "the engine reads the usecase's rows as level").toBe(true);
    expect(rows.map((r) => rankText(r, isLevelTable(rows)))).toEqual(["–", "–", "–", "–"]);
    // The stored snapshot, and the public view over it, are untouched: only the two route handlers null.
    const [stored] = await sql<{ rows: { rank?: number | null }[] }[]>`select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
    expect(stored!.rows.map((r) => r.rank).sort(), "the stored snapshot").toEqual([1, 2, 3, 4]);
    await publish(s.divisionId);
    const [view] = await sql<{ rows: { rank?: number | null }[] }[]>`select rows from public_standings_v where stage_id = ${stageId} and pool_id is null`;
    expect(view!.rows.map((r) => r.rank).sort(), "public_standings_v").toEqual([1, 2, 3, 4]);
    // Once a result counts the same consumers print the place.
    await startDivision(s.auth, s.divisionId);
    const [A, B] = s.entrants as [string, string, string, string];
    await genericResult(s.auth, stageId, A, B, 1, 0);
    const decided = (await getStandings(s.auth, stageId)).rows as StandingsRow[];
    expect(isLevelTable(decided)).toBe(false);
    expect(decided.map((r) => rankText(r, isLevelTable(decided))).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("PATCH division tiebreakers after activation → 200 with stagesKeptPinned naming the stage", async () => {
    const s = as(
      await tableScene({
        entrants: 2,
        stages: [
          { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null },
          { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null },
        ],
      }),
    );
    const [a, b] = s.stageIds as [string, string];
    await generateStageFixtures(s.auth, a);
    expect(await pinnedAtOf(a), "premise: Pool A is pinned (activated)").not.toBeNull();
    const r = await patchDivision(s.divisionId, { tiebreakers: DIV_ORDER });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    const row = S.PatchedDivision.parse(r.data);
    expect(row.refused).toEqual([]);
    expect(row.tiebreakers).toEqual(DIV_ORDER);
    expect(row.stagesKeptPinned).toEqual([{ stageId: a, name: "Pool A" }]);
    expect((await getStage(a)).tableRules!.tiebreakers, "Pool A kept its pin").toMatchObject({ keys: GENERIC_DEFAULT, source: "sport" });
    expect((await getStage(b)).tableRules!.tiebreakers, "Pool B reads the new order").toMatchObject({ keys: DIV_ORDER, source: "division" });
    // The second call: the same order again moves nothing, so nothing is listed.
    const again = await patchDivision(s.divisionId, { tiebreakers: DIV_ORDER });
    expect(again.status).toBe(200);
    expect(S.PatchedDivision.parse(again.data).stagesKeptPinned).toEqual([]);
  });

  it("N2 a flat PUT body over a split sport is 422 POINTS_SPLIT_FLATTENED naming the engine's split, even ITTF's 2/1 with a forfeit row paying the walkover 2/0; the split stated is accepted; a sport with no split takes the flat rule", async () => {
    expect(TT_SPLITS, "premise: the engine declares a table-tennis league's loss not played apart").toEqual(["unplayed"]);
    const t1 = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    const t1Stage = t1.stageIds[0]!;
    // ITTF-looking: the forfeit row pays the walkover 2/0, but a retirement after play would pay the flat loss — refused.
    const looking = await putRules(t1Stage, { points: ITTF_FLAT });
    expect([looking.status, looking.error?.code, looking.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", TT_SPLITS]);
    // No forfeit row, or a walkover paying 3/0: refused the same way.
    const noRow = await putRules(t1Stage, { points: { ...ITTF_FLAT, forfeit: undefined } });
    expect([noRow.status, noRow.error?.code, noRow.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", TT_SPLITS]);
    const other = await putRules(t1Stage, { points: { ...ITTF_FLAT, forfeit: { winnerPoints: 3, loserPoints: 0 } } });
    expect([other.status, other.error?.code]).toEqual([422, "POINTS_SPLIT_FLATTENED"]);
    expect(Object.hasOwn(await stageConfig(t1Stage), "points"), "nothing stored by any of them").toBe(false);
    // The positive pair, same stage (a second call after three refusals): the split stated is the caller's choice.
    const stated = await putRules(t1Stage, { points: ITTF_STATED });
    expect(stated.status, JSON.stringify(stated.error)).toBe(200);
    expect((await getStage(t1Stage)).tableRules!.points).toMatchObject({ rule: PointsRule.parse(ITTF_STATED), source: "stage" });
    // Another sport: IIHF's overtime 2/1 is a split no flat rule pays (IIHF 3-2-1-0) — refused naming it; a sport with no
    // split (generic) takes the flat rule.
    const ih = as(await tableScene({ sport: "icehockey", variant: "iihf", entrants: 2 }));
    const iihf = await putRules(ih.stageIds[0]!, { points: { win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] } });
    expect([iihf.status, iihf.error?.code, iihf.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", ["otWin", "otLoss"]]);
    const g = as(await tableScene({ entrants: 2 }));
    const plain = await putRules(g.stageIds[0]!, { points: RULE });
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
  });

  it("I1 a retirement AFTER play pays the retired table-tennis loser the sport's loss not played (0), never a flat loss: the flat ITTF body is refused, and the standings read back pay 2 and 0", async () => {
    expect(TT_DECLARED.loss.unplayed, "premise: ITTF's retired loser is paid apart from a played loss").not.toBe(ITTF_FLAT.loss.regulation);
    const s = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    const stageId = s.stageIds[0]!;
    const declared = tt.tablePointsRule(parsedCfg(tt, await divisionCfg(s.divisionId)), "league");
    const refused = await putRules(stageId, { points: ITTF_FLAT });
    expect([refused.status, refused.error?.code, refused.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", TT_SPLITS]);
    expect(Object.hasOwn(await stageConfig(stageId), "points"), "the flat rule never reached the stage").toBe(false);
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const [W, L] = s.entrants as [string, string];
    const f = await between(stageId, W, L);
    await post(s.auth, f.id, "core.start");
    for (let i = 0; i < 3; i++) await post(s.auth, f.id, "tabletennis.rally", { wonBy: W });
    await post(s.auth, f.id, "tabletennis.rally", { wonBy: L });
    await post(s.auth, f.id, "core.forfeit", { by: L, reason: "retired" });
    const row = await fixtureRow(f.id);
    expect(row.outcome, "rig: a retirement after play").toMatchObject({ kind: "award", winner: W, loser: L, reason: "retired" });
    const rows = (await standings(stageId)).rows;
    const pts = (id: string) => rows.find((r) => r.entrantId === id)?.points;
    expect([pts(W), pts(L)], "the sport's win and its loss not played").toEqual([declared.win.regulation, declared.loss.unplayed]);
    expect(pts(L), "never the flat rule's played loss").not.toBe(ITTF_FLAT.loss.regulation);
  });

  it("N3 replaceStages carries a stored rule on a split sport by the same answer: the split stated is kept (ITTF), a flat one is refused naming the split (a flat ITTF rule stored before I1; a beach rule carried onto FIVB indoor)", async () => {
    // ITTF with its split stated, stored through the PUT, then the whole graph replaced: the slot keeps its points.
    const t1 = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    expect((await putRules(t1.stageIds[0]!, { points: ITTF_STATED })).status).toBe(200);
    const graph = [{ seq: 1, kind: "league", name: "League", config: {}, progression: null }];
    const kept = await call(replaceStagesRoute, { id: t1.divisionId }, "PUT", `/divisions/${t1.divisionId}/stages`, graph);
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    const [after] = S.Stage.array().parse(kept.data);
    expect((await stageConfig(after!.id)).points, "the carried rule").toMatchObject(PointsRule.parse(ITTF_STATED));
    // A flat ITTF rule already stored (planted: no PUT writes one now) is refused when the replace carries it.
    const t2 = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    await sql`update stages set config = config || ${sql.json({ points: ITTF_FLAT })} where id = ${t2.stageIds[0]!}`;
    const flatCarried = await call(replaceStagesRoute, { id: t2.divisionId }, "PUT", `/divisions/${t2.divisionId}/stages`, graph);
    expect([flatCarried.status, flatCarried.error?.code, flatCarried.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", TT_SPLITS]);
    // FIVB beach pays 2-0 on every set score (no split), so a flat 2/0 is stored there; the division then moves to indoor
    // (FIVB V3: 3-2 pays 2/1) before any fixture, and the replace carries the flat rule onto a split it would flatten.
    const vb = as(await tableScene({ sport: "volleyball", variant: "beach", entrants: 2 }));
    const beachFlat = { win: { regulation: 2 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] };
    expect((await putRules(vb.stageIds[0]!, { points: beachFlat })).status, "beach: no split to flatten").toBe(200);
    const moved = await patchDivision(vb.divisionId, { variant_key: "indoor", config: { ...(mod("volleyball").variants.indoor as object) } });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect((parsedCfg(mod("volleyball"), await divisionCfg(vb.divisionId)) as { bestOf: number }).bestOf, "premise: indoor").toBe(5);
    const refused = await call(replaceStagesRoute, { id: vb.divisionId }, "PUT", `/divisions/${vb.divisionId}/stages`, graph);
    expect([refused.status, refused.error?.code, refused.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", ["pointsMap"]]);
    expect((await stageConfig(vb.stageIds[0]!)).points, "a refused save leaves the stage untouched").toMatchObject(beachFlat);
  });
});

// ── Pure: the documented schemas and the retired code ────────────────────────────────────────────────────────────────

/** Every object schema in `doc` that has a `tieBreak` property (a standings row): its tie-break enums and the metrics it
 *  names. */
function tieBreakSchemas(doc: unknown): { key: string[]; note: string[]; metrics: string[] }[] {
  const out: { key: string[]; note: string[]; metrics: string[] }[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const props = o.properties as Record<string, { properties?: Record<string, { enum?: string[] }> }> | undefined;
    const tb = props?.tieBreak?.properties;
    if (tb !== undefined) {
      out.push({ key: tb.key?.enum ?? [], note: tb.note?.enum ?? [], metrics: Object.keys(props?.metrics?.properties ?? {}) });
    }
    Object.values(o).forEach(walk);
  };
  walk(doc);
  return out;
}

const REPO = join(__dirname, "..", "..", "..", "..", "..", "..");

describe("W2d T13 the documented standings row and the retired code", () => {
  it("m8 the standings row's tie-break enums take fewest_played and h2h_incomplete, through the zod schema AND the generated openapi", () => {
    // The engine's declarations: `PartialScheduleKey` (sport/module.ts — IIHF RBG:349-350's fewest games played) and
    // `TieBreakNote` (competition/standings.ts — a head-to-head over an incomplete mini-schedule, X-TB-8).
    const row = {
      entrantId: "e1", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: { won_ot: 1 },
      tieBreak: { key: "fewest_played", with: ["e2"], note: "h2h_incomplete", drawnAt: "2026-10-27T10:00:00.000000+00:00" },
      level: true,
    };
    expect(S.StandingsRow.parse(row)).toEqual(row);
    expect(S.StandingsRow.parse({ ...row, tieBreak: { key: "lots", with: [], note: "h2h_two_not_applicable" } }).tieBreak?.note).toBe("h2h_two_not_applicable");
    expect(S.StandingsRow.safeParse({ ...row, tieBreak: { key: "not_a_step", with: [] } }).success, "the enum is closed").toBe(false);
    // Every TiebreakerKey is a tie-break reason too.
    for (const key of S.TiebreakerKeyS.options) expect(S.TieBreakKeyS.safeParse(key).success, key).toBe(true);
    let checked = 0;
    for (const [name, doc] of [
      ["built", buildOpenApiDocument()],
      ["v1.json", JSON.parse(readFileSync(join(REPO, "openapi", "v1.json"), "utf8"))],
      ["v1.public.json", JSON.parse(readFileSync(join(REPO, "openapi", "v1.public.json"), "utf8"))],
    ] as const) {
      const found = tieBreakSchemas(doc);
      expect(found.length, `${name}: the standings routes document a tieBreak`).toBeGreaterThan(0);
      for (const f of found) {
        expect(f.key, name).toContain("fewest_played");
        expect(f.note, name).toContain("h2h_incomplete");
        // Spec §5.7's display fold: how a win or a loss was decided beyond regulation, named on the documented row.
        expect(f.metrics, name).toEqual(expect.arrayContaining(["won_ot", "won_so", "lost_ot", "lost_so"]));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("m3 the published standings response examples are documents their schemas take (computed_through_seq a decimal string), in both generated JSONs", () => {
    let checked = 0;
    for (const file of ["v1.json", "v1.public.json"]) {
      const doc = JSON.parse(readFileSync(join(REPO, "openapi", file), "utf8")) as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { example?: { data?: unknown } }> }> }>> };
      const example = (path: string) => doc.paths[path]?.get?.responses["200"]?.content?.["application/json"]?.example?.data;
      const own = example("/api/v1/stages/{id}/standings");
      expect(own, `${file}: the stage standings example`).toBeDefined();
      expect(S.StandingsSnapshot.safeParse(own).success, `${file}: ${JSON.stringify(own)}`).toBe(true);
      checked++;
      const pub = example("/api/v1/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/standings");
      expect(pub, `${file}: the public standings example`).toBeDefined();
      expect(S.PublicDivisionStandings.safeParse(pub).success, `${file}: ${JSON.stringify(pub)}`).toBe(true);
      checked++;
    }
    expect(checked, "both examples in both JSONs").toBe(4);
  });

  it("the published PUT /stages/{id}/rules example's orders are ones the validator takes (a generic league; the cross-group one across groups)", () => {
    // single-sport: the example is sport-blind, and generic is the sport the docs' examples are written for.
    let checked = 0;
    for (const [name, doc] of [
      ["v1.json", JSON.parse(readFileSync(join(REPO, "openapi", "v1.json"), "utf8"))],
      ["v1.public.json", JSON.parse(readFileSync(join(REPO, "openapi", "v1.public.json"), "utf8"))],
    ] as const) {
      const example = doc.paths["/api/v1/stages/{id}/rules"].put.requestBody.content["application/json"].example as {
        tiebreakers: TiebreakerKey[];
        crossGroupTiebreakers: TiebreakerKey[];
      };
      const ctx = { module: generic, cfg: parsedCfg(generic, GENERIC_CONFIG), stageKind: "group" as const };
      expect(example.tiebreakers.length, name).toBeGreaterThan(1);
      expect(validateCascade(example.tiebreakers, { ...ctx, crossGroup: false }), `${name}: the order`).toEqual([]);
      expect(validateCascade(example.crossGroupTiebreakers, { ...ctx, crossGroup: true }), `${name}: the cross-group order`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("POINTS_RULE_INEXPRESSIBLE appears nowhere in schemas, openapi or the error map (greenfield deletion, git grep -a, counted files > 0)", () => {
    const code = ["POINTS", "RULE", "INEXPRESSIBLE"].join("_");
    const paths = [
      "apps/web/src/server/api-v1/schemas.ts",
      "apps/web/src/server/api-v1/openapi.ts",
      "apps/web/src/server/api-v1/http.ts",
      "apps/web/src/lib/rule-errors.ts",
      "openapi/v1.json",
      "openapi/v1.public.json",
    ];
    const listed = execFileSync("git", ["ls-files", "--", ...paths], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(listed.length, "every scanned file is tracked").toBe(paths.length);
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-a", "-l", "-F", code, "--", ...paths], { cwd: REPO, encoding: "utf8" });
    } catch (e) {
      // `git grep` exits 1 when nothing matches; anything else is a broken scan.
      expect((e as { status?: number }).status, String(e)).toBe(1);
    }
    expect(hits).toBe("");
    // The scan is not blind: the code it looks for is found where it is still documented as retired.
    const seen = execFileSync("git", ["grep", "-a", "-l", "-F", code, "--", "docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md"], { cwd: REPO, encoding: "utf8" });
    expect(seen.trim()).toBe("docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md");
  });
});

// ── The serialiser itself (pure) ────────────────────────────────────────────────────────────────────────────────────────

describe("D11b serialiseLevelRanks (W2e Task 27)", () => {
  type Row = { entrantId: string; rank?: number; level?: boolean; points?: number };
  const row = (entrantId: string, o: Partial<Row> = {}): Row => ({ entrantId, points: 0, ...o });

  it("D11b nulls every rank of a level table, keeps every other field, and leaves its input alone", () => {
    const input = Object.freeze([row("a", { rank: 1, level: true }), row("b", { rank: 2, level: true }), row("c", { level: true })]);
    const out = serialiseLevelRanks(input);
    expect(out, "every row, in order, rank present and null").toEqual([
      { entrantId: "a", points: 0, rank: null, level: true },
      { entrantId: "b", points: 0, rank: null, level: true },
      { entrantId: "c", points: 0, rank: null, level: true },
    ]);
    for (const r of out) expect(Object.hasOwn(r, "rank"), "a row with no stored rank gets the key too").toBe(true);
    expect(input.map((r) => r.rank), "the input is not mutated").toEqual([1, 2, undefined]);
  });

  it("D11b leaves a table with any counted row alone, byte for byte: mixed, none level, and no level field at all", () => {
    const tables: [string, Row[]][] = [
      ["one row not level", [row("a", { rank: 1, level: true }), row("b", { rank: 2 })]],
      ["level false on a row", [row("a", { rank: 1, level: true }), row("b", { rank: 2, level: false })]],
      ["no level field", [row("a", { rank: 1 }), row("b", { rank: 2 })]],
    ];
    let checked = 0;
    for (const [what, rows] of tables) {
      const before = JSON.stringify(rows);
      const out = serialiseLevelRanks(rows);
      expect(JSON.stringify(out), what).toBe(before);
      expect(out.map((r) => r.rank).every((r) => typeof r === "number"), `${what}: the places stay`).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("D11b the documented row takes rank null, a number or none, and nothing else, in the schema and in both generated JSONs", () => {
    const row = { entrantId: "a", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, level: true };
    expect(S.StandingsRow.safeParse({ ...row, rank: null }).success, "null").toBe(true);
    expect(S.StandingsRow.safeParse({ ...row, rank: 3 }).success, "a place").toBe(true);
    expect(S.StandingsRow.safeParse(row).success, "none").toBe(true);
    expect(S.StandingsRow.safeParse({ ...row, rank: "1" }).success, "a string").toBe(false);
    // Both generated documents say so for both operations: every `rank` property under the 200 response admits null.
    const nullable = (schema: unknown): boolean => JSON.stringify(schema).includes('"type":"null"');
    const ranks = (node: unknown): unknown[] => {
      if (node === null || typeof node !== "object") return [];
      const found: unknown[] = [];
      for (const [k, v] of Object.entries(node)) {
        if (k === "properties" && v !== null && typeof v === "object" && "rank" in v) found.push((v as { rank: unknown }).rank);
        found.push(...ranks(v));
      }
      return found;
    };
    let checked = 0;
    for (const file of ["v1.json", "v1.public.json"]) {
      const doc = JSON.parse(readFileSync(join(REPO, "openapi", file), "utf8")) as { paths: Record<string, { get?: { responses: Record<string, unknown> } }> };
      for (const path of ["/api/v1/stages/{id}/standings", "/api/v1/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/standings"]) {
        const found = ranks(doc.paths[path]?.get?.responses["200"]);
        expect(found.length, `${file} ${path}: the 200 response documents rank`).toBeGreaterThan(0);
        for (const schema of found) {
          expect(nullable(schema), `${file} ${path}: rank admits null (${JSON.stringify(schema)})`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked, "four documented ranks (two operations in two documents)").toBeGreaterThanOrEqual(4);
  });

  it("D11b no rows is no table: an empty list stays empty (never a level one)", () => {
    expect(serialiseLevelRanks([])).toEqual([]);
  });

  it("D11b a second call changes nothing more (null stays null)", () => {
    const once = serialiseLevelRanks([row("a", { rank: 1, level: true }), row("b", { rank: 2, level: true })]);
    expect(serialiseLevelRanks(once as never)).toEqual(once);
  });
});
