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
//   PATCH /divisions/{id}                            → `stagesKeptPinned` after activation.
//
// Carried from PR A (orchestrator rulings): N2 (a flat rule that pays every outcome as the sport does is accepted; one that
// flattens a real split stays refused), N3 (the same answer for a rule `replaceStages` carries), m8 (the API's tie-break
// enums take `fewest_played` and `h2h_incomplete`), and the strict body (an unknown top-level key is 400).
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

import { PointsRule, coverage, defaultCrossGroup, membersKeyOf, reachableOutcomes, validateCascade } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import * as S from "@/server/api-v1/schemas";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { between, genericResult, tableScene } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
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

// single-sport: generic is the rig's sport for the sport-blind rules below; a test whose rule belongs to one sport names that sport (and says why).
const generic = mod("generic");
const GENERIC_DEFAULT = generic.defaultTiebreakers("league", parsedCfg(generic, GENERIC_CONFIG));
const DIV_ORDER: TiebreakerKey[] = ["points", "diff", "lots"];
const OWN_ORDER: TiebreakerKey[] = ["points", "for", "diff", "lots"];
/** A rule that pays every outcome generic reaches (a win, a loss, a draw) and differs from generic's own 3/1/0. */
const RULE = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] } as const;

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
    // The shoot-out stream is payout-decided-in-db.test.ts's (the golden corpus's `default` seed 80: W wins the 11th round).
    const so = await play(Y, Z, [
      ...toFt,
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      ...Array.from({ length: 10 }, (_, i) => ({ type: "icehockey.shootout.attempt", payload: { by: i % 2 === 0 ? "W" : "L", scored: true } })),
      { type: "icehockey.shootout.attempt", payload: { by: "W", scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: "L", scored: false } },
    ]);
    expect([ot.outcome?.method, so.outcome?.method], "rig: an overtime and a shoot-out decision").toEqual(["extra_time", "shootout"]);
    const hRows = (await standings(hStage)).rows;
    const metric = (id: string, k: string) => hRows.find((r) => r.entrantId === id)?.metrics[k];
    expect([metric(X, "won_ot"), metric(Y, "lost_ot"), metric(Y, "won_so"), metric(Z, "lost_so")]).toEqual([1, 1, 1, 1]);
    expect([metric(X, "won_so"), metric(Z, "won_ot")], "only on the side and the way the match was decided").toEqual([undefined, undefined]);
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

  it("N2 a flat PUT body that pays every outcome the stage reaches as the sport does is accepted (ITTF: win 2, loss 1, a walkover 2/0 by the forfeit row); a flat body that flattens a real split stays 422 POINTS_SPLIT_FLATTENED", async () => {
    // ITTF team league points (DOMAIN.tabletennis.md, TT-PT-1): a win 2, a played loss 1, a loss not played 0. A flat rule
    // whose forfeit row pays the walkover 2/0 pays every outcome a table-tennis league reaches the same way.
    const tt = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    const ittfEqual = { win: { regulation: 2 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } };
    const accepted = await putRules(tt.stageIds[0]!, { points: ittfEqual });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect((await getStage(tt.stageIds[0]!)).tableRules!.points).toMatchObject({ rule: PointsRule.parse(ittfEqual), source: "stage" });
    // The refused direction, same sport: no forfeit row, so a walkover would pay the played loss's 1 — the split flattened.
    const flat = { ...ittfEqual, forfeit: undefined };
    const tt2 = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    const refused = await putRules(tt2.stageIds[0]!, { points: flat });
    expect(refused.status).toBe(422);
    expect(refused.error?.code).toBe("POINTS_SPLIT_FLATTENED");
    expect(refused.error?.splits).toEqual(["unplayed"]);
    // A flat rule that pays any reachable outcome other than the sport does is refused too (a walkover winner's 3, not 2).
    const other = await putRules(tt2.stageIds[0]!, { points: { ...ittfEqual, forfeit: { winnerPoints: 3, loserPoints: 0 } } });
    expect(other.status).toBe(422);
    expect(other.error?.code).toBe("POINTS_SPLIT_FLATTENED");
    expect(Object.hasOwn(await stageConfig(tt2.stageIds[0]!), "points"), "nothing stored").toBe(false);
    // Another sport: IIHF's overtime 2/1 is a split no flat rule pays (IIHF 3-2-1-0) — refused naming it; a sport with no
    // split (generic) takes the flat rule.
    const ih = as(await tableScene({ sport: "icehockey", variant: "iihf", entrants: 2 }));
    const iihf = await putRules(ih.stageIds[0]!, { points: { win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] } });
    expect([iihf.status, iihf.error?.code, iihf.error?.splits]).toEqual([422, "POINTS_SPLIT_FLATTENED", ["otWin", "otLoss"]]);
    const g = as(await tableScene({ entrants: 2 }));
    const plain = await putRules(g.stageIds[0]!, { points: RULE });
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
  });

  it("N3 replaceStages carries a stored flat rule on a split sport by the same answer: one that pays as the sport does is kept (ITTF), one that flattens a split is refused naming it (a beach rule carried onto FIVB indoor)", async () => {
    // ITTF-equal (N2's accepted rule), stored through the PUT, then the whole graph replaced: the slot keeps its points.
    const tt = as(await tableScene({ sport: "tabletennis", variant: "bo5", entrants: 2 }));
    const ittfEqual = { win: { regulation: 2 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } };
    expect((await putRules(tt.stageIds[0]!, { points: ittfEqual })).status).toBe(200);
    const graph = [{ seq: 1, kind: "league", name: "League", config: {}, progression: null }];
    const kept = await call(replaceStagesRoute, { id: tt.divisionId }, "PUT", `/divisions/${tt.divisionId}/stages`, graph);
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    const [after] = S.Stage.array().parse(kept.data);
    expect((await stageConfig(after!.id)).points, "the carried rule").toMatchObject(PointsRule.parse(ittfEqual));
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
