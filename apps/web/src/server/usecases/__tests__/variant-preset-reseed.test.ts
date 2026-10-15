// W2c Task 12, fix round 1 (R-T12-2) — a division VARIANT change re-seeds the presets of its unstarted stages, in the
// division save's own transaction.
//
// A bracket stage stores its sport's preset at create (X-SR-6), and some presets depend on the variant: the super over
// is a limited-overs knockout's (t20/odi/hundred, not a test match), and a youth knockout's shoot-out is 3 kicks where
// 11-a-side's is 5. A stored key still EQUAL to the old variant's preset is the preset, not the organiser's choice: it
// moves to the new variant's preset, or goes when the new variant declares none. A key the new variant's preset adds
// is written. A key the organiser changed is theirs: kept, and asked the variant's allowlist (M1, refused by name). A
// started stage is never touched (the variant lock refuses the change first). One audit row per stage re-seeded.
//
// Expected values come from the engine's own `stageDefaultsFor`, never a number typed here. Real Postgres for the
// saves; the sweep over every variant-dependent preset is pure.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { putStageRules } from "../stage-rules";
import { reseededRules, reseedStagePresets } from "../stage-preset-reseed";

const HAS_DB = !!process.env.DATABASE_URL;

// A re-seed moves the format the public pages print: the save fires the division's revalidation, as an award re-write
// does. The spy wraps the REAL revalidation (it still runs); it only records which division was asked for.
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: (...args: Parameters<typeof real.fireDivisionRevalidate>) => {
      revalidated.push(args[0]);
      return real.fireDivisionRevalidate(...args);
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

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
const cricket = mod("cricket");
const football = mod("football");
const orNull = (o: Record<string, unknown>) => (Object.keys(o).length === 0 ? null : o);
const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("R-T12-2 the re-seed rule, over every variant-dependent preset the engine declares (pure)", () => {
  it("an untouched preset becomes the new variant's, both directions, every sport x kind x variant pair (counted)", () => {
    const sports = new Set<string>();
    let pairs = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      const vs = Object.keys(m.variants);
      for (const kind of StageKind.options) for (const from of vs) for (const to of vs) {
        if (from === to) continue;
        const was = stageDefaultsFor(m, kind, from);
        const now = stageDefaultsFor(m, kind, to);
        if (isDeepStrictEqual(was, now)) continue;
        expect(reseededRules(orNull(was), was, now), `${m.key} ${kind} ${from} -> ${to}`).toEqual(orNull(now));
        sports.add(m.key);
        pairs++;
      }
    }
    // The ruling names both: cricket's super over and football's youth shoot-out.
    expect([...sports].sort(), "anti-vacuity: the variant-dependent presets").toEqual(expect.arrayContaining(["cricket", "football"]));
    expect(pairs).toBeGreaterThan(0);
  });

  it("the organiser's own keys are kept: a changed preset key, a removed one, and a key no preset names", () => {
    const youth = stageDefaultsFor(football, "knockout", "youth");
    const eleven = stageDefaultsFor(football, "knockout", "11-a-side");
    expect(youth.shootoutAttempts, "the premise: youth and 11-a-side differ on the kicks").not.toEqual(eleven.shootoutAttempts);
    const edited = { ...youth, shootoutAttempts: (youth.shootoutAttempts as number) + 1 };
    expect(reseededRules(edited, youth, eleven), "a changed key is the organiser's").toEqual(edited);
    const removed = without(youth, "shootoutAttempts");
    expect(reseededRules(removed, youth, eleven), "a removed key stays removed (the stage inherits)").toEqual(removed);
    expect(reseededRules({ ...youth, halfMinutes: 40 }, youth, eleven), "a key no preset names rides along").toEqual({ ...eleven, halfMinutes: 40 });
    // A stored null is "inherit" (never a value): dropped, never compared.
    expect(reseededRules({ ...youth, extraTime: null }, youth, eleven)).toEqual(without(eleven, "extraTime"));
    // Empty case: no rules and no preset either side.
    expect(reseededRules(null, {}, {})).toBeNull();
  });
});

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Rs " + suffix}, ${"rs-" + suffix}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedDivision(auth: AuthCtx, sportKey: string, variantKey: string, entrantCount = 0) {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Rs Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sportKey, variant_key: variantKey, config: {},
  });
  if (entrantCount > 0) {
    const kind = mod(sportKey).entrantModel?.defaultKind ?? "individual";
    await createEntrants(auth, division.id, Array.from({ length: entrantCount }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  }
  return { divisionId: division.id, competitionId: comp.id };
}
const knockout = async (auth: AuthCtx, divisionId: string, seq = 1, name = "Final") =>
  (await createStages(auth, divisionId, { seq, kind: "knockout", name, config: {}, progression: null }))[0]!.id;
const rulesOf = async (id: string) => (await sql<{ r: unknown }[]>`select config -> 'rules' as r from stages where id = ${id}`)[0]!.r;
const variantOf = async (id: string) => (await sql<{ v: string }[]>`select variant_key as v from divisions where id = ${id}`)[0]!.v;
const auditRows = async (competitionId: string) =>
  sql<{ payload: Record<string, unknown> }[]>`
    select payload from competition_events where competition_id = ${competitionId} and type = 'stage.rules_reseeded' order by created_at`;

describe.skipIf(!HAS_DB)("R-T12-2 a division variant change re-seeds its unstarted stages' presets (real saves)", () => {
  it("cricket t20 -> test drops the knockout's super over and the save lands; test -> t20 writes it back; a second identical save re-seeds nothing", async () => {
    const auth = await seedOrg();
    const { divisionId, competitionId } = await seedDivision(auth, "cricket", "t20");
    const st = await knockout(auth, divisionId);
    expect(await rulesOf(st), "the premise: the t20 preset").toEqual(stageDefaultsFor(cricket, "knockout", "t20"));
    expect(stageDefaultsFor(cricket, "knockout", "test"), "the premise: a test match declares none").toEqual({});
    await expect(patchDivision(auth, divisionId, { variant_key: "test" })).resolves.toMatchObject({ variant_key: "test", refused: [] });
    expect(await rulesOf(st), "dropped: the stage carries no rules").toBeNull();
    await expect(patchDivision(auth, divisionId, { variant_key: "t20" })).resolves.toMatchObject({ variant_key: "t20" });
    expect(await rulesOf(st), "written back: the key the new variant's preset adds").toEqual(stageDefaultsFor(cricket, "knockout", "t20"));
    const audit = await auditRows(competitionId);
    expect(audit.map((a) => a.payload), "one audit row per stage re-seeded, before and after").toEqual([
      { stage_id: st, division_id: divisionId, from_variant: "t20", to_variant: "test", before: stageDefaultsFor(cricket, "knockout", "t20"), after: null },
      { stage_id: st, division_id: divisionId, from_variant: "test", to_variant: "t20", before: null, after: stageDefaultsFor(cricket, "knockout", "t20") },
    ]);
    // A second identical save: the variant it already has, and the same with the config re-sent. Nothing moves.
    await patchDivision(auth, divisionId, { variant_key: "t20" });
    await patchDivision(auth, divisionId, { variant_key: "t20", config: {} });
    expect(await auditRows(competitionId)).toHaveLength(2);
    expect(await rulesOf(st)).toEqual(stageDefaultsFor(cricket, "knockout", "t20"));
  });

  it("football youth <-> 11-a-side moves the knockout's shootoutAttempts both ways; the keys both presets share are untouched (counted)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth");
    const st = await knockout(auth, divisionId);
    let checked = 0;
    for (const [from, to] of [["youth", "11-a-side"], ["11-a-side", "youth"]] as const) {
      expect(await rulesOf(st), `${from}: the stage is on its preset`).toEqual(stageDefaultsFor(football, "knockout", from));
      expect(stageDefaultsFor(football, "knockout", to).shootoutAttempts, "the premise: the kicks differ").not.toEqual(stageDefaultsFor(football, "knockout", from).shootoutAttempts);
      await patchDivision(auth, divisionId, { variant_key: to });
      expect(await variantOf(divisionId)).toBe(to);
      expect(await rulesOf(st), `${from} -> ${to}`).toEqual(stageDefaultsFor(football, "knockout", to));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an organiser-edited key survives the change; one the new variant cannot carry is refused by name, nothing written", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth");
    const st = await knockout(auth, divisionId);
    const youth = stageDefaultsFor(football, "knockout", "youth");
    const kicks = (youth.shootoutAttempts as number) + 1;
    expect(kicks, "the premise: the edit is neither preset").not.toBe(stageDefaultsFor(football, "knockout", "11-a-side").shootoutAttempts);
    await putStageRules(auth, st, { rules: { shootoutAttempts: kicks } });
    await patchDivision(auth, divisionId, { variant_key: "11-a-side" });
    expect(await rulesOf(st), "the organiser's kicks kept, the rest of the preset re-seeded").toEqual({ ...stageDefaultsFor(football, "knockout", "11-a-side"), shootoutAttempts: kicks });
    // Cricket: the super over switched OFF on a t20 knockout is the organiser's, and a test match cannot carry it.
    const c = await seedDivision(auth, "cricket", "t20");
    const ko = await knockout(auth, c.divisionId);
    await putStageRules(auth, ko, { rules: { superOver: false } });
    const err = await patchDivision(auth, c.divisionId, { variant_key: "test" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "RULE_NOT_SETTABLE", extra: { field: "superOver", stage_id: ko, stage_name: "Final" } });
    expect(await variantOf(c.divisionId)).toBe("t20");
    expect(await rulesOf(ko)).toEqual({ superOver: false });
    expect(await auditRows(c.competitionId), "rolled back with the save").toHaveLength(0);
  });

  it("a started stage is never touched: the variant lock refuses the change (its unstarted sibling is not re-seeded either), and the re-seed itself passes a started stage by", async () => {
    const auth = await seedOrg();
    const { divisionId, competitionId } = await seedDivision(auth, "football", "youth", 2);
    const started = await knockout(auth, divisionId, 1, "Cup");
    const sibling = await knockout(auth, divisionId, 2, "Plate");
    await generateStageFixtures(auth, started);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${started} and home_entrant_id is not null and away_entrant_id is not null limit 1`;
    await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    const youth = stageDefaultsFor(football, "knockout", "youth");
    // A save that ALSO renames lands the name and lists the variant (and the config keys it moves) as refused: nothing
    // is re-seeded.
    const out = await patchDivision(auth, divisionId, { variant_key: "11-a-side", name: "Renamed" });
    expect(out.refused.map((r) => r.field)).toContain("variant_key");
    expect(out.name).toBe("Renamed");
    expect(await rulesOf(started)).toEqual(youth);
    expect(await rulesOf(sibling), "the variant did not change, so neither did the sibling").toEqual(youth);
    expect(await auditRows(competitionId)).toHaveLength(0);
    // The guard under the lock, reached directly: the started stage is passed by, the unstarted one re-seeded.
    const reseeded = await withTenant(auth.orgId, (tx) =>
      reseedStagePresets(tx, { divisionId, module: football, fromVariant: "youth", toVariant: "11-a-side", actorId: null }));
    expect(reseeded).toEqual([sibling]);
    expect(await rulesOf(started), "started: untouched").toEqual(youth);
    expect(await rulesOf(sibling)).toEqual(stageDefaultsFor(football, "knockout", "11-a-side"));
  });

  it("the public pages are revalidated when a change re-seeded a stage, and not when it moved nothing (the empty case first)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "cricket", "t20");
    const mine = () => revalidated.filter((d) => d === divisionId).length;
    await patchDivision(auth, divisionId, { name: "Renamed " + divisionId.slice(0, 6) }); // moves no format at all
    expect(mine(), "nothing moved, nothing revalidated").toBe(0);
    // Batch-5 m-1: a variant change stores a different format whether or not a stage was re-seeded, and the public pages
    // print it - so the stage-less change is told too (it was the case this test used to pin as "nothing re-seeded").
    await patchDivision(auth, divisionId, { variant_key: "odi" }); // no stage: nothing re-seeded, the format moved
    expect(mine(), "the format moved, so the public pages are told").toBe(1);
    await knockout(auth, divisionId);
    await patchDivision(auth, divisionId, { variant_key: "test" });
    expect(mine(), "the knockout's super over went with the variant: told once more, not twice").toBe(2);
  });

  it("empty case: a variant change on a division with no stages, or only table stages, re-seeds nothing and lands", async () => {
    const auth = await seedOrg();
    const { divisionId, competitionId } = await seedDivision(auth, "cricket", "t20");
    await expect(patchDivision(auth, divisionId, { variant_key: "odi" })).resolves.toMatchObject({ variant_key: "odi" });
    const [league] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "Pool", config: {}, progression: null });
    expect(await rulesOf(league!.id), "the premise: a table stage stores no preset").toBeNull();
    await expect(patchDivision(auth, divisionId, { variant_key: "test" })).resolves.toMatchObject({ variant_key: "test" });
    expect(await rulesOf(league!.id)).toBeNull();
    expect(await auditRows(competitionId)).toHaveLength(0);
  });
});
