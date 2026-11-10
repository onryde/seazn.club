// W4 app-A Task 16 (SP-UI): a stepladder or a page playoff with nothing to seed from is refused by name, on BOTH stage
// writers — the create (`POST /divisions/{id}/stages`) and the Format dialog's replace (`PUT /divisions/{id}/stages`, the
// one write that can take a progression away: pre-flight D11) — and nothing is written. Both stay offered as final stages.
// Expected values come from the rulebook (RB4-S6 / X-SP-6, RB4-S7 / X-SP-7, ruling 269), the engine's sport registry and
// the product's own template list — never from the predicate under test.
//
// Driven through the real route handlers (body parse, authz, the v1 error envelope) against a real Postgres; skipped
// without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { TEMPLATE_CATALOG } from "@/server/templates/catalog";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { standaloneStageRefusal } from "@/lib/stage-standalone";
import { insertLegacyStandaloneStage } from "@/server/usecases/__tests__/_legacy-standalone-stage";
import { asOwner, seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { POST as postStagesRoute, PUT as putStagesRoute } from "@/app/api/v1/divisions/[id]/stages/route";

// RB4-S6, typed here: each table-only kind and the name its refusal carries (one code per kind, pre-flight D13).
const REFUSED = [
  { kind: "stepladder", code: "STEPLADDER_NEEDS_TABLE_SOURCE" },
  { kind: "page_playoff", code: "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE" },
] as const;
// RB4-S7: the builder's final-stage shapes — league then stepladder, league then page playoff, Swiss then page playoff.
const FINAL_STAGE_TEMPLATES = ["group_stepladder", "group_playoffs", "swiss_playoff"] as const;
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function jsonReq(method: string, path: string, body: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function variantOf(sport: string): Promise<string> {
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = ${sport} and is_system order by key limit 1`;
  if (!row) throw new Error(`no system variant for ${sport} (sync:sports not run?)`);
  return row.key;
}

async function signedInOwner(plan: "community" | "pro" = "pro"): Promise<AuthCtx> {
  const { orgId, ownerId } = await seedOrg(plan);
  authState.userId = ownerId;
  return asOwner(orgId, ownerId);
}

async function seedDivision(owner: AuthCtx, sport: string, compId?: string): Promise<{ compId: string; divisionId: string }> {
  const id =
    compId ??
    (await createCompetition(owner, { ends_on: "2030-12-31", name: "Ladder Cup " + randomUUID().slice(0, 6), visibility: "public", branding: {} })).id;
  const division = await createDivision(owner, id, {
    name: "Open " + randomUUID().slice(0, 4),
    slug: "open-" + randomUUID().slice(0, 8),
    sport_key: sport,
    variant_key: await variantOf(sport),
    config: {},
  } as never);
  return { compId: id, divisionId: division.id };
}

async function stagesOf(divisionId: string): Promise<{ id: string; seq: number; kind: string; progression: unknown }[]> {
  return sql`select id, seq, kind, progression from stages where division_id = ${divisionId} order by seq`;
}

const PROGRESSION = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe("standalone stepladder / page playoff (W4 T16)", () => {
  it("assumption as a guard: no catalog template builds a stage the standalone rule refuses (counted over every stage of every template)", () => {
    let stages = 0;
    let tableOnly = 0;
    for (const t of TEMPLATE_CATALOG) {
      for (const d of t.divisions) {
        for (const s of d.stages) {
          expect(standaloneStageRefusal({ kind: s.kind, progression: s.progression ?? null }), `${t.key}: ${s.kind}`).toBeNull();
          stages++;
          if (REFUSED.some((r) => r.kind === s.kind)) tableOnly++;
        }
      }
    }
    expect(stages, "catalog stages checked").toBeGreaterThan(0);
    // league-playoff's page playoff (fed from its league) is the one table-only stage the catalog builds.
    expect(tableOnly, "catalog table-only stages checked").toBe(1);
  });
});

describe.skipIf(!HAS_DB)("standalone stepladder / page playoff on the wire (W4 T16, X-SP-6 / X-SP-7)", () => {
  it.each(REFUSED)("X-SP-6 a standalone $kind is refused by name (422 $code), nothing is written, and a second POST says the same", async ({ kind, code }) => {
    const owner = await signedInOwner();
    const { divisionId } = await seedDivision(owner, "badminton");
    for (const attempt of [1, 2]) {
      const res = await read(await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, { seq: 1, kind, name: "Finals", config: {} }), ctx(divisionId)));
      expect(res.status, `attempt ${attempt}`).toBe(422);
      expect(res.body.ok).toBe(false);
      expect(res.body.error?.code, `attempt ${attempt}`).toBe(code);
      expect(await stagesOf(divisionId), `attempt ${attempt}: nothing written`).toEqual([]);
    }
    // An explicit `progression: null` is the same "no source".
    const nulled = await read(await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, { seq: 1, kind, name: "Finals", config: {}, progression: null }), ctx(divisionId)));
    expect([nulled.status, nulled.body.error?.code]).toEqual([422, code]);
    expect(await stagesOf(divisionId)).toEqual([]);
  });

  it("X-SP-6 a batch carrying one is refused WHOLE: a league beside a progression-less stepladder writes neither; the same league with the stepladder fed from it is taken", async () => {
    const owner = await signedInOwner();
    const { divisionId } = await seedDivision(owner, "badminton");
    const league = { seq: 1, kind: "league", name: "League", config: { legs: 1 } };
    const refused = await read(
      await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, [league, { seq: 2, kind: "stepladder", name: "Finals", config: {} }]), ctx(divisionId)),
    );
    expect([refused.status, refused.body.error?.code]).toEqual([422, "STEPLADDER_NEEDS_TABLE_SOURCE"]);
    expect(await stagesOf(divisionId), "the league was not written either").toEqual([]);
    // Positive pair: the same batch with the stepladder fed from the league.
    const ok = await read(
      await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, [league, { seq: 2, kind: "stepladder", name: "Finals", config: {}, progression: PROGRESSION }]), ctx(divisionId)),
    );
    expect(ok.status).toBe(201);
    expect((await stagesOf(divisionId)).map((s) => [s.seq, s.kind, s.progression !== null])).toEqual([
      [1, "league", false],
      [2, "stepladder", true],
    ]);
  });

  it("X-SP-6 a later stage with no progression is still standalone: a stepladder POSTed after a league stands, with no source named, is refused", async () => {
    const owner = await signedInOwner();
    const { divisionId } = await seedDivision(owner, "football");
    await createStages(owner, divisionId, { seq: 1, kind: "league", name: "League", config: { legs: 1 } });
    for (const { kind, code } of REFUSED) {
      const res = await read(await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, { seq: 2, kind, name: "Finals", config: {} }), ctx(divisionId)));
      expect([kind, res.status, res.body.error?.code]).toEqual([kind, 422, code]);
    }
    expect((await stagesOf(divisionId)).map((s) => s.kind), "only the league stands").toEqual(["league"]);
  });

  it("X-SP-6 the refusal is the format's, asked before any plan gate: with formats.double_elim denied, a standalone page playoff is named (422), while the fed one meets the gate (402)", async () => {
    const owner = await signedInOwner();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${owner.orgId}, 'formats.double_elim', false)
      on conflict (org_id, feature_key) do update set bool_value = false`;
    const { divisionId } = await seedDivision(owner, "generic");
    const res = await read(await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, { seq: 1, kind: "page_playoff", name: "Playoffs", config: {} }), ctx(divisionId)));
    expect([res.status, res.body.error?.code]).toEqual([422, "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE"]);
    // Positive pair: the gate is live for this org — the same kind fed from a league is a plan question, not a format one.
    const fed = await read(
      await postStagesRoute(
        jsonReq("POST", `/divisions/${divisionId}/stages`, [
          { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
          { seq: 2, kind: "page_playoff", name: "Playoffs", config: {}, progression: PROGRESSION },
        ]),
        ctx(divisionId),
      ),
    );
    expect(fed.status, "the fed page playoff meets the denied gate").toBe(402);
    expect(await stagesOf(divisionId)).toEqual([]);
  });

  it("D11 the Format dialog's replace cannot take the source away: PUT (and its dry run) of a progression-less stepladder or page playoff over league -> finals is refused by name, and the division keeps its stages", async () => {
    const owner = await signedInOwner();
    let checked = 0;
    for (const { kind, code } of REFUSED) {
      const { divisionId } = await seedDivision(owner, "badminton");
      const fed = [
        { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
        { seq: 2, kind, name: "Finals", config: {}, progression: PROGRESSION },
      ];
      expect((await read(await postStagesRoute(jsonReq("POST", `/divisions/${divisionId}/stages`, fed), ctx(divisionId)))).status).toBe(201);
      const before = await stagesOf(divisionId);
      expect(before.map((s) => [s.kind, s.progression !== null])).toEqual([["league", false], [kind, true]]);
      // The source cleared in place, the league dropped, and the dry run of each: every one refused, nothing changed.
      const bodies = [
        [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }, { seq: 2, kind, name: "Finals", config: {}, progression: null }],
        [{ seq: 1, kind, name: "Finals", config: {} }],
      ];
      for (const body of bodies) {
        for (const query of ["", "?dry_run=1"]) {
          const res = await read(await putStagesRoute(jsonReq("PUT", `/divisions/${divisionId}/stages${query}`, body), ctx(divisionId)));
          expect([kind, query, res.status, res.body.error?.code]).toEqual([kind, query, 422, code]);
          expect(await stagesOf(divisionId), `${kind} ${query}: the division keeps its stages`).toEqual(before);
          checked++;
        }
      }
      // Positive pair: the same replace that keeps the source is taken.
      const kept = await read(await putStagesRoute(jsonReq("PUT", `/divisions/${divisionId}/stages`, fed), ctx(divisionId)));
      expect(kept.status, `${kind}: a replace that keeps the source`).toBe(200);
      expect((await stagesOf(divisionId)).map((s) => [s.kind, s.progression !== null])).toEqual([["league", false], [kind, true]]);
    }
    expect(checked, "(kind, body, dry run) replaces refused").toBe(8);
  });

  it("X-SP-7 league then stepladder, league then page playoff and Swiss then page playoff stay offered on every sport whose kinds allow them, and the stage create takes each built body (counted)", async () => {
    const owner = await signedInOwner();
    let offered = 0;
    let created = 0;
    for (const m of builtinModules) {
      let compId: string | undefined;
      const kinds = effectiveEntrantModel(m.entrantModel ?? null, null).kinds;
      const keys = templatesForSport(m.key, kinds).map((t) => t.key);
      for (const template of FINAL_STAGE_TEMPLATES) {
        // None of the three holds a kind any sport refuses (only pair-minting kinds are refused), so every sport is offered all three.
        expect(keys, `${m.key} offers ${template}`).toContain(template);
        offered++;
        const div = await seedDivision(owner, m.key, compId);
        compId = div.compId;
        const body = buildTemplateStages(template, KNOBS).map((s, i) => ({ ...s, seq: i + 1 }));
        const rows = await createStages(owner, div.divisionId, body as never);
        const finals = rows.find((r) => r.seq === 2)!;
        expect([m.key, template, finals.kind, finals.progression !== null]).toEqual([m.key, template, body[1]!.kind, true]);
        created++;
      }
    }
    expect(offered, "(sport, final-stage template) offers checked").toBe(builtinModules.length * FINAL_STAGE_TEMPLATES.length);
    expect(created).toBe(offered);
    expect(builtinModules.length).toBeGreaterThan(1);
  });

  it("C5 the legacy seed (the suites' stand-in for the standalone stages that stand) writes the config the stage create writes for the same kind, on every sport; generic's is a lots seed alone (the e2e and smoke twins' literal)", async () => {
    // The create's config does not depend on the progression (stageConfigsAtCreate never reads it), so the offered final
    // stage — same sport, same variant, same kind — is the reference the legacy row must match.
    const owner = await signedInOwner();
    let matched = 0;
    let withPreset = 0;
    for (const m of builtinModules) {
      for (const { kind } of REFUSED) {
        const fed = await seedDivision(owner, m.key);
        const legacy = await seedDivision(owner, m.key, fed.compId);
        const rows = await createStages(owner, fed.divisionId, [
          { seq: 1, kind: "league", name: "League", config: {} },
          { seq: 2, kind, name: "Finals", config: {}, progression: PROGRESSION },
        ] as never);
        const row = await insertLegacyStandaloneStage(legacy.divisionId, { seq: 1, kind, name: "Finals" });
        expect([m.key, kind, row.kind, row.progression]).toEqual([m.key, kind, kind, null]);
        // `rngSeed` is the row's own random lots seed (W2d T10, `stage-defaults.ts` withRngSeed: "a random 31-bit integer"
        // on every new stage, the legacy one too): compared by type, never by value. Everything else is the create's, key for key.
        const { rngSeed: seedLegacy, ...legacyConfig } = (row.config ?? {}) as Record<string, unknown>;
        const { rngSeed: seedFed, ...fedConfig } = (rows[1]!.config ?? {}) as Record<string, unknown>;
        expect([typeof seedLegacy, typeof seedFed], `${m.key}/${kind}: both rows carry a lots seed`).toEqual(["number", "number"]);
        expect(legacyConfig, `${m.key}/${kind}: the legacy row's config is the create's`).toEqual(fedConfig);
        if (m.key === "generic") expect(legacyConfig, "generic: the e2e/smoke twins write a lots seed and nothing else").toEqual({});
        if (Object.keys(legacyConfig).length > 0) withPreset++;
        matched++;
      }
    }
    expect(matched, "(sport, kind) legacy rows matched").toBe(builtinModules.length * REFUSED.length);
    // Non-vacuous: some sport lays a preset over the row (so the twins' generic-only guard is load-bearing).
    expect(withPreset).toBeGreaterThan(0);
  });

  it("C5 the legacy seed refuses any stage the product takes — another kind, or a table-only kind WITH a source — and writes nothing", async () => {
    const owner = await signedInOwner();
    const { divisionId } = await seedDivision(owner, "generic");
    let refused = 0;
    for (const stage of [
      { seq: 1, kind: "knockout", name: "KO" },
      { seq: 1, kind: "league", name: "L" },
      ...REFUSED.map(({ kind }) => ({ seq: 1, kind, name: "Finals", progression: PROGRESSION })),
    ]) {
      await expect(insertLegacyStandaloneStage(divisionId, stage), stage.kind).rejects.toThrow(/use createStages/);
      refused++;
    }
    expect(await stagesOf(divisionId)).toEqual([]);
    expect(refused).toBe(4);
  });
});
