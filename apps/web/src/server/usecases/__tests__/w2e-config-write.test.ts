// W2e Task 13 (spec 2026-10-28 §5.5, E15; D8) — every door that WRITES a sport config asks the engine's write-door
// refusals (`writeConfigIssues`): ruling 31's set-target floor for volleyball and table tennis (rows VB-CF-1, TT-CF-1) and
// tennis's best of 1 with a match tie-break (RB2A-13, row TN-CF-1). The doors: division create and save (the save's
// re-parse after its per-field lock included), a template's division and stage, the stage rules (PUT and create), and a
// match's own format. A refusal is 422 CONFIG_INVALID carrying the engine's sentence in `issues`, and writes nothing.
// `configSchema` is unchanged (E15), so a config stored below the floor still loads its pad and still scores.
//
// Expected values come from the rulings (floor 5; best of 1 has no deciding set to replace) and the engine's exported
// sentences, never from the doors. Real Postgres (`describe.skipIf(!HAS_DB)`); every case seeds its own division.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { foldMatchWithStoppage } from "@seazn/engine/core";
import { BO1_MATCH_TIEBREAK, SET_TARGET_BELOW_FLOOR } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { v1 } from "@/server/api-v1/http";
import { appendEvent } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import type { CompetitionTemplate } from "@/server/templates/schema";
import { createDivision, patchDivision } from "../divisions";
import { resolveScorePadBootstrap } from "../fidelity";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { loadFixturePadCfg } from "../fixtures";
import { putStageRules } from "../stage-rules";
import { createStages } from "../stages";
import { TEMPLATE_INSTANTIATION_FAILED_CODE, instantiateTemplate } from "../templates";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** Ruling 31: a volleyball or table tennis set is played to at least this many points. */
const FLOOR = 5;

const mod = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};

/** What a door answers on the wire: the v1 envelope (`http.ts`), as the route returns it. */
async function wire(door: () => Promise<unknown>): Promise<{ status: number; error: { code?: string; issues?: { message: string }[]; refused?: { field: string }[]; cause?: string } }> {
  const res = await v1(async () => {
    await door();
    return { done: true };
  });
  const body = (await res.json()) as { ok: boolean; error?: Record<string, unknown> };
  return { status: res.status, error: (body.error ?? {}) as never };
}

/** A door refused with CONFIG_INVALID (422) whose issues carry `sentence`. */
async function expectRefused(door: () => Promise<unknown>, sentence: string, label: string) {
  const { status, error } = await wire(door);
  expect({ status, code: error.code }, label).toEqual({ status: 422, code: "CONFIG_INVALID" });
  expect((error.issues ?? []).map((i) => i.message), `${label}: the engine's sentence`).toContain(sentence);
  return error;
}

const divisionConfig = async (id: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${id}`)[0]!.config;
const divisionCount = async (competitionId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from divisions where competition_id = ${competitionId}`)[0]!.n;
const stageRules = async (id: string) =>
  (await sql<{ rules: unknown }[]>`select config -> 'rules' as rules from stages where id = ${id}`)[0]!.rules ?? null;
const overrideOf = async (id: string) =>
  (await sql<{ o: unknown }[]>`select rules_override as o from fixtures where id = ${id}`)[0]!.o ?? null;

const volleyballLeague = () => seedBracket({ sport: "volleyball", variant: "indoor", stageKind: "league", entrants: 2 });
const slug = () => `d-${randomUUID().slice(0, 8)}`;

describe.skipIf(!HAS_DB)("W2e write doors refuse a config below ruling 31's floor (VB-CF-1, TT-CF-1)", () => {
  it("VB-CF-1 division create: setTo or finalSetTo below 5 is 422 CONFIG_INVALID with the sentence and writes nothing; 5 is created", async () => {
    const b = await volleyballLeague();
    const before = await divisionCount(b.competitionId);
    for (const key of ["setTo", "finalSetTo"] as const) {
      await expectRefused(
        () => createDivision(b.auth, b.competitionId, { name: "Low", slug: slug(), sport_key: "volleyball", variant_key: "indoor", config: { [key]: FLOOR - 1 } }),
        SET_TARGET_BELOW_FLOOR,
        `create ${key} ${FLOOR - 1}`,
      );
    }
    expect(await divisionCount(b.competitionId), "nothing written").toBe(before);
    // Sequence: the same create at the floor lands.
    const ok = await createDivision(b.auth, b.competitionId, { name: "Five", slug: slug(), sport_key: "volleyball", variant_key: "indoor", config: { setTo: FLOOR, finalSetTo: FLOOR } });
    expect(await divisionConfig(ok.id)).toMatchObject({ setTo: FLOOR, finalSetTo: FLOOR });
  });

  it("TT-CF-1 table tennis refuses below the floor at create too; badminton, on the same kernel, declares no floor", async () => {
    const b = await volleyballLeague();
    await expectRefused(
      () => createDivision(b.auth, b.competitionId, { name: "TT", slug: slug(), sport_key: "tabletennis", variant_key: "bo5", config: { setTo: 3, finalSetTo: 3 } }),
      SET_TARGET_BELOW_FLOOR,
      "table tennis create",
    );
    const bd = await createDivision(b.auth, b.competitionId, { name: "BD", slug: slug(), sport_key: "badminton", variant_key: "short", config: { setTo: 3, finalSetTo: 3, cap: 5 } });
    expect(await divisionConfig(bd.id), "badminton keeps its short set").toMatchObject({ setTo: 3 });
  });

  it("VB-CF-1 division save (PATCH): a format below the floor is refused with the sentence and the stored config is untouched; a variant switch too; at 5 it lands", async () => {
    const b = await volleyballLeague();
    const stored = await divisionConfig(b.divisionId);
    await expectRefused(() => patchDivision(b.auth, b.divisionId, { config: { ...stored, setTo: FLOOR - 1 } }), SET_TARGET_BELOW_FLOOR, "patch setTo");
    await expectRefused(
      () => patchDivision(b.auth, b.divisionId, { variant_key: "beach", config: { ...(mod("volleyball").variants.beach as Record<string, unknown>), finalSetTo: 2 } }),
      SET_TARGET_BELOW_FLOOR,
      "variant switch with finalSetTo 2",
    );
    expect(await divisionConfig(b.divisionId), "refused saves wrote nothing").toEqual(stored);
    await patchDivision(b.auth, b.divisionId, { config: { ...stored, setTo: FLOOR } });
    expect(await divisionConfig(b.divisionId)).toMatchObject({ setTo: FLOOR });
  });

  it("VB-CF-1 stage rules: the PUT and a new stage's own rules are refused below the floor; the PUT at 15 lands", async () => {
    const b = await volleyballLeague();
    const before = await stageRules(b.stageId);
    await expectRefused(() => putStageRules(b.auth, b.stageId, { rules: { setTo: FLOOR - 1 } }), SET_TARGET_BELOW_FLOOR, "stage PUT");
    expect(await stageRules(b.stageId), "nothing written").toEqual(before);
    await expectRefused(
      () => createStages(b.auth, b.divisionId, { seq: 2, kind: "league", name: "S2", config: { rules: { finalSetTo: FLOOR - 1 } }, progression: null }),
      SET_TARGET_BELOW_FLOOR,
      "stage create",
    );
    expect((await sql`select 1 from stages where division_id = ${b.divisionId}`).length, "no second stage").toBe(1);
    await putStageRules(b.auth, b.stageId, { rules: { setTo: 15 } });
    expect(await stageRules(b.stageId)).toMatchObject({ setTo: 15 });
  });

  it("VB-CF-1 a match's own format: an override below the floor is refused with the sentence; 15 is stored", async () => {
    const b = await volleyballLeague();
    const id = b.fixtureIds[0]!;
    const error = await expectRefused(() => writeFixtureRulesOverride(b.auth, [id], { setTo: FLOOR - 1 }), SET_TARGET_BELOW_FLOOR, "fixture override");
    expect(error).toMatchObject({ field: "setTo" });
    expect(await overrideOf(id), "nothing written").toBeNull();
    await writeFixtureRulesOverride(b.auth, [id], { setTo: 15 });
    expect(await overrideOf(id)).toMatchObject({ setTo: 15 });
  });

  it("VB-CF-1 a template's division and its stage's rules are refused below the floor (the template's own 422, locating it), and nothing is created", async () => {
    const b = await volleyballLeague();
    const template = (division: Record<string, unknown>, stage: Record<string, unknown> = {}): CompetitionTemplate =>
      ({
        key: "test-w2e-floor",
        version: 1,
        i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
        divisions: [
          {
            i18nNameKey: "templates.slam128.div.main",
            sportKey: "volleyball",
            variantKey: "indoor",
            entrantKind: "team",
            entrantCount: 4,
            ...division,
            stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "league", ...stage }],
          },
        ],
      }) as CompetitionTemplate;
    const comps = async () => (await sql<{ n: number }[]>`select count(*)::int as n from competitions where org_id = ${b.auth.orgId}`)[0]!.n;
    const before = await comps();
    // A template is code, so its refusal is a catalog bug, located (templates.ts: the division, and the stage when the stage
    // refused it). The division door names the sentence in the cause; the stage door's CONFIG_INVALID carries it in its
    // issues, which the template's own envelope does not forward, so the stage case is pinned by where it was refused.
    let checked = 0;
    for (const [label, t, at, sentence] of [
      ["division cfgOverrides", template({ cfgOverrides: { setTo: FLOOR - 1 } }), { divisionIndex: 0, stageIndex: null }, true],
      ["stage rules", template({}, { config: { rules: { finalSetTo: FLOOR - 1 } } }), { divisionIndex: 0, stageIndex: 0 }, false],
    ] as const) {
      const { status, error } = await wire(() => instantiateTemplate(b.auth, t, { name: `T ${randomUUID().slice(0, 6)}`, ends_on: "2030-12-31" }));
      expect({ status, code: error.code }, label).toEqual({ status: 422, code: TEMPLATE_INSTANTIATION_FAILED_CODE });
      expect(error, label).toMatchObject(at);
      if (sentence) expect(String(error.cause), label).toContain(SET_TARGET_BELOW_FLOOR);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await comps(), "no competition left behind").toBe(before);
    // Positive pair: the same template at the floor instantiates.
    await instantiateTemplate(b.auth, template({ cfgOverrides: { setTo: FLOOR, finalSetTo: FLOOR } }, { config: { rules: { finalSetTo: FLOOR } } }), {
      name: `T ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
    });
    expect(await comps()).toBe(before + 1);
  });

  it("VB-CF-1 E15 an existing setTo 3 volleyball division still loads its pad bootstrap, and its match still scores", async () => {
    const b = await volleyballLeague();
    // A config stored before W2e (raw SQL: no door would write it now).
    await sql`update divisions set config = config || ${sql.json({ setTo: 3, finalSetTo: 3 } as never)} where id = ${b.divisionId}`;
    const id = b.fixtureIds[0]!;
    const pad = await loadFixturePadCfg(b.auth, id);
    expect(pad.cfg).toMatchObject({ setTo: 3, finalSetTo: 3 });
    const boot = await resolveScorePadBootstrap({
      sportModule: mod("volleyball"),
      rawConfig: pad.cfg,
      hasFeatureFn: async () => false,
      initialEvents: [],
      identity: { recordedBy: null, deviceLinkId: null },
      stageKind: pad.stageKind,
      rulesVersion: pad.rulesVersion,
    });
    expect(boot, "fidelity.ts parses it: the pad renders").not.toBeNull();
    expect(boot!.resolvedConfig).toMatchObject({ setTo: 3 });
    // Scoring is no config write: three rallies close a set to 3 (a lead of the preset's 2).
    const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${id}`;
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    for (let seq = 1; seq <= 3; seq++) await appendEvent(b.auth.orgId, id, seq, { type: "volleyball.rally", payload: { wonBy: home } });
    const inputs = (await withTenant(b.auth.orgId, (tx) => loadFoldInputs(tx, id)))!;
    const state = foldMatchWithStoppage(inputs.module, inputs.cfg, inputs.lineups, inputs.envelopes).state as { setsWon: { home: number } };
    expect(state.setsWon.home).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("W2e write doors refuse tennis best of 1 with a match tie-break (TN-CF-1)", () => {
  const tennisLeague = (divisionConfig?: Record<string, unknown>, stageRules?: Record<string, unknown>) =>
    seedBracket({ sport: "tennis", variant: "tour", stageKind: "league", entrants: 2, ...(divisionConfig ? { divisionConfig } : {}), ...(stageRules ? { stageRules } : {}) });

  it("TN-CF-1 create and save: best of 1 with a match tie-break is 422 CONFIG_INVALID with the sentence; best of 1 with a final-set tie-break is created", async () => {
    const b = await tennisLeague();
    await expectRefused(
      () => createDivision(b.auth, b.competitionId, { name: "Bo1", slug: slug(), sport_key: "tennis", variant_key: "doubles-noad-mtb10", config: { bestOf: 1 } }),
      BO1_MATCH_TIEBREAK,
      "create doubles preset cut to best of 1",
    );
    const stored = await divisionConfig(b.divisionId);
    await expectRefused(() => patchDivision(b.auth, b.divisionId, { config: { ...stored, bestOf: 1, finalSet: { matchTiebreakTo: 10 } } }), BO1_MATCH_TIEBREAK, "save");
    expect(await divisionConfig(b.divisionId)).toEqual(stored);
    const slam = await createDivision(b.auth, b.competitionId, { name: "Bo1 TB", slug: slug(), sport_key: "tennis", variant_key: "tour", config: { bestOf: 1, finalSet: { tiebreakTo: 10 } } });
    expect(await divisionConfig(slam.id)).toMatchObject({ bestOf: 1, finalSet: { tiebreakTo: 10 } });
  });

  it("TN-CF-1 the save's re-parse after its per-field lock: a kept best of 1 beside a newly saved match tie-break is refused, naming the kept field", async () => {
    // Stored: best of 1, a final set like any other. The started stage plays its OWN final set (so the division's
    // `finalSet` is free to change) and inherits `bestOf` (so a change to it is refused and kept as stored).
    const b = await tennisLeague({ ...(mod("tennis").variants.tour as Record<string, unknown>), bestOf: 1 }, { finalSet: "same" });
    await appendEvent(b.auth.orgId, b.fixtureIds[0]!, 0, { type: "core.start", payload: {} });
    const stored = await divisionConfig(b.divisionId);
    expect(stored, "premise").toMatchObject({ bestOf: 1, finalSet: "same" });
    // Each half alone is valid (best of 3 with a match tie-break); the lock keeps best of 1, and the mix that would land
    // is the refused pair.
    const error = await expectRefused(
      () => patchDivision(b.auth, b.divisionId, { config: { ...stored, bestOf: 3, finalSet: { matchTiebreakTo: 10 } } }),
      BO1_MATCH_TIEBREAK,
      "save after the lock",
    );
    expect((error.refused ?? []).map((r) => r.field), "names the field kept as stored").toContain("bestOf");
    expect(await divisionConfig(b.divisionId), "nothing written").toEqual(stored);
  });
});
