// X-SR-4 — division table rules and match format lock per STARTED INHERITING
// stage (Q3, Q4; plan D12). P4's lock sequence for the division (spec §9).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { RULE_ERROR_STATUS, ruleErrorMessage, type RuleErrorCode } from "@/lib/rule-errors";
import { EngineError } from "@seazn/engine/core";
import { deciderKeysFor, pointsKeysFor, ruleKeyApplies, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ENGINE_HTTP } from "@/server/api-v1/http";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { divisionRefusals, tableRuleKeys } from "../rule-locks";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { putStageRules } from "../stage-rules";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });

async function seedOrg(): Promise<AuthCtx> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"Dl " + s}, ${"dl-" + s}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** Two league stages, 2 entrants each in one division; stage 1 generated. */
async function rig(sport: string, variant: string, kind: "individual" | "team" = "individual") {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind, display_name: `E${i}`, seed: i, members: [] })));
  const [s1] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
  const [s2] = await createStages(auth, d.id, { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null });
  await generateStageFixtures(auth, s1!.id);
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s1!.id} order by id limit 1`;
  return { auth, divisionId: d.id, s1: s1!, s2: s2!, fixtureId: f!.id };
}
const start = (auth: AuthCtx, fixtureId: string) => appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });

/** Pool B generates its fixtures and takes its first event: a SECOND started stage (`rig` starts neither). */
async function startPoolB(r: Awaited<ReturnType<typeof rig>>): Promise<void> {
  await generateStageFixtures(r.auth, r.s2.id);
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.s2.id} order by id limit 1`;
  await start(r.auth, f!.id);
}

/** The `refused` list off a rejected save (the 409 carries it in `extra`, a CONFIG_INVALID in `data`). */
async function rejection(p: Promise<unknown>): Promise<Record<string, unknown>> {
  return p.then(
    () => { throw new Error("expected the save to be refused, but it resolved"); },
    (e: unknown) => e as Record<string, unknown>,
  );
}

describe.skipIf(!HAS_DB)("X-SR-4 division locks per started inheriting stage", () => {
  it("empty patch on a started division: saves, refuses nothing", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const out = await patchDivision(r.auth, r.divisionId, {});
    expect(out.refused).toEqual([]);
  });

  it("no stages at all: nothing can have started, so variant, config and tiebreakers all save", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "generic", variant_key: "score", config: {} });
    const out = await patchDivision(auth, d.id, { variant_key: "win_loss", tiebreakers: ["head_to_head"] as never });
    expect(out.refused).toEqual([]);
    expect(out.variant_key).toBe("win_loss");
    expect((out.config as { resultMode: string }).resultMode).toBe("win_loss");
    expect(out.tiebreakers).toEqual(["head_to_head"]);
  });

  it("generated but NOT started: a match-format change saves (the old division-wide FORMAT_LOCKED narrowed, P-2 A)", async () => {
    const r = await rig("badminton", "short");
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...(before.config as object), setTo: 15 } });
    expect(out.refused).toEqual([]);
    expect((out.config as { setTo: number }).setTo).toBe(15);
  });

  it("started inheriting stage: match format refused DIVISION_FORMAT_LOCKED naming the stage; another field still saves", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...(before.config as object), setTo: 15 } });
    expect(out.name).toBe("Renamed");
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { setTo: number }).setTo).toBe((before.config as { setTo: number }).setTo);
  });

  it("a started stage that sets the key itself does not inherit it: the division change saves", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { setTo: 11 } });
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...(before.config as object), setTo: 15 } });
    expect(out.refused).toEqual([]);
    // "Saves" is a claim about the value, not just the absence of a refusal (M-d): on the returned row AND the stored one.
    expect((before.config as { setTo: number }).setTo, "precondition: it was not already 15").toBe(11);
    expect((out.config as { setTo: number }).setTo).toBe(15);
    expect(((await getDivision(r.auth, r.divisionId)).config as { setTo: number }).setTo).toBe(15);
  });

  it("one patch, two keys: the key the started stage inherits is refused and the key it sets itself saves", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { cap: 15 } });             // Pool A sets cap itself, inherits setTo
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number; cap: number };
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...before, setTo: 13, cap: 19 } });
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect(out.config).toEqual({ ...before, cap: 19 });                        // cap saved, setTo restored, nothing else moved
  });

  it("table rules: tiebreakers refused DIVISION_TABLE_RULES_LOCKED once a stage started (Q3; unlocked before W2c)", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "N2", tiebreakers: ["head_to_head", "points_diff"] as never });
    expect(out.refused).toEqual([{ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect(out.tiebreakers, "the refused tiebreakers were not written").toBeNull();
    expect(out.name, "the unrefused name was").toBe("N2");
  });

  it("table rules: not started — tiebreakers save, and clearing them back to null saves too", async () => {
    const r = await rig("badminton", "short");
    const set = await patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never });
    expect(set.refused).toEqual([]);
    expect(set.tiebreakers).toEqual(["head_to_head"]);
    const cleared = await patchDivision(r.auth, r.divisionId, { tiebreakers: null });
    expect(cleared.refused).toEqual([]);
    expect(cleared.tiebreakers).toBeNull();
  });

  it("only refused fields in the patch: 409 with the first refusal's code and the whole list", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never })).rejects.toMatchObject({
      status: 409, code: "DIVISION_TABLE_RULES_LOCKED", extra: { refused: [{ field: "tiebreakers", stageName: "Pool A" }] },
    });
  });

  it("the refusal's message is the spec sentence naming the stage", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never })).rejects.toMatchObject({
      message: "Pool A has started — table rules are locked.",
    });
  });

  it("after the only event is voided the stage is still started (score_events exist): still refused", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    // Void by the real event id (ids are UUIDs; the engine refuses an unknown target, core/events.ts:296).
    const [{ id: startId }] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${r.fixtureId} and type = 'core.start'`;
    const v = await appendEvent(r.auth.orgId, r.fixtureId, 1, { type: "core.void", payload: {}, voids: startId });
    expect(v.event.voids).toBe(startId);                                   // the void landed
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never })).rejects.toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED" });
  });

  it("second call: re-sending the stored value is not a change and is not refused", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: before.config as never });
    expect(out.refused).toEqual([]);
  });

  it("second call: re-sending the stored tiebreakers is not a change and is not refused", async () => {
    const r = await rig("badminton", "short");
    await patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head", "points_diff"] as never });   // before anything started: saves
    await start(r.auth, r.fixtureId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Same", tiebreakers: ["head_to_head", "points_diff"] as never });
    expect(out.refused).toEqual([]);
    expect(out.tiebreakers).toEqual(["head_to_head", "points_diff"]);
    // Order is part of the value: the same keys in the other order ARE a change.
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["points_diff", "head_to_head"] as never })).rejects.toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED" });
  });

  it("every field of a two-field patch refused (variant + tiebreakers, and the preset keys the variant would move): one 409 carrying all of them, the variant's code first", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const err = await patchDivision(r.auth, r.divisionId, { variant_key: "win_loss", tiebreakers: ["head_to_head"] as never }).then(() => undefined, (e: unknown) => e);
    expect(err, "the save was refused outright").toMatchObject({ status: 409, code: "DIVISION_FORMAT_LOCKED" });
    const fields = (err as { extra: { refused: { field: string }[] } }).extra.refused.map((x) => x.field);
    expect(fields).toEqual(expect.arrayContaining(["variant_key", "tiebreakers", "resultMode", "allowDraws"]));
    const after = await getDivision(r.auth, r.divisionId);
    expect(after.config).toEqual(before.config);
    expect(after.tiebreakers).toEqual(before.tiebreakers);
    expect(after.variant_key).toBe(before.variant_key);
  });

  it("another sport: a generic division's points (table rules) refused while a pool has started", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const cfg = before.config as { points: Record<string, number> };
    await expect(patchDivision(r.auth, r.divisionId, { config: { ...cfg, points: { ...cfg.points, w: 2 } } })).rejects.toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED" });
  });

  it("table rules: a started stage that carries its own points does not inherit the division's — the points change saves", async () => {
    // Fixture-only: the producer of a stage's own `config.points` (the stage Points section) is Task 13, so the key
    // is written straight to the column. The predicate under test reads exactly that key.
    const r = await rig("generic", "score");
    await sql`update stages set config = config || ${sql.json({ points: { win: 2, draw: 1, loss: 0 } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const cfg = before.config as { points: Record<string, number> };
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...cfg, points: { ...cfg.points, w: 2 } } });
    expect(out.refused).toEqual([]);
    expect((out.config as { points: { w: number } }).points.w).toBe(2);
  });

  it("variant change refused DIVISION_FORMAT_LOCKED when any stage started", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { variant_key: "win_loss" })).rejects.toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
  });

  it("variant: re-sending the CURRENT variant is not a variant change", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { variant_key: "score", config: before.config as never });
    expect(out.refused).toEqual([]);
    expect(out.variant_key).toBe("score");
  });

  it("I1: a refused variant also drops its preset keys — the stored config is byte-for-byte the old one", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", variant_key: "win_loss" });
    expect(out.name).toBe("Renamed");
    expect(out.variant_key).toBe(before.variant_key);
    expect(out.config).toEqual(before.config);              // no preset key of "win_loss" (resultMode, allowDraws) leaked through
    // Every key the requested variant would have changed is listed, each under the started stage.
    const m = resolveLatestModule("generic");
    // Structural, not `JSON.stringify`: the stored jsonb hands `points` back as {d,l,w} and the engine declares {w,d,l},
    // so a string compare calls an unchanged `points` a change and expects it refused.
    const fromVariant = Object.keys(m.variants["win_loss"] ?? {}).filter((k) => !isDeepStrictEqual((m.variants["win_loss"] as Record<string, unknown>)[k], (before.config as Record<string, unknown>)[k]));
    expect(fromVariant.length, "generic 'win_loss' differs from 'score' on at least one key").toBeGreaterThan(0);
    for (const k of fromVariant) expect(out.refused).toContainEqual(expect.objectContaining({ field: k, stageName: "Pool A" }));
    expect(out.refused).toContainEqual(expect.objectContaining({ field: "variant_key" }));
    const fields = out.refused.map((x) => x.field);
    expect(new Set(fields).size, `no field listed twice: ${fields.join(",")}`).toBe(fields.length);
  });

  it("I1: a refused variant also drops preset-default keys a started stage sets itself (bwf is a partial preset)", async () => {
    // badminton 'bwf' is `{}` — every key it changes comes from the schema's defaults, so a delta over the preset's OWN
    // keys sees nothing. Pool A sets setTo itself (not inherited, so the key alone would save): the half-applied
    // preset must still be dropped, because the variant it belongs to was refused.
    const r = await rig("badminton", "short");
    const m = resolveLatestModule("badminton");
    await putStageRules(r.auth, r.s1.id, { rules: { setTo: 11 } });
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const bwf = m.configSchema.parse(m.variants["bwf"]) as { setTo: number };
    expect(bwf.setTo, "bwf's default setTo differs from short's, or the case is vacuous").not.toBe((before.config as { setTo: number }).setTo);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", variant_key: "bwf" });
    expect(out.variant_key).toBe("short");
    expect(out.config).toEqual(before.config);
    expect(out.refused).toContainEqual(expect.objectContaining({ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageName: "Pool A" }));
    expect(out.refused).toContainEqual(expect.objectContaining({ field: "variant_key" }));
    const fields = out.refused.map((x) => x.field);
    expect(new Set(fields).size, `no field listed twice: ${fields.join(",")}`).toBe(fields.length);
  });

  it("I1: a refused variant also drops nothing the patch set itself — an explicit key of an unrefused kind still saves", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { setTo: 11 } });          // Pool A sets setTo itself
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { finalSetTo: number; cap: number };
    // variant refused; setTo is sent explicitly with a value Pool A does not care about.
    const out = await patchDivision(r.auth, r.divisionId, { variant_key: "bwf", config: { ...before, setTo: 13, cap: 15 } });
    expect(out.variant_key).toBe("short");
    expect((out.config as { setTo: number }).setTo, "the explicit setTo (Pool A sets it itself) was kept").toBe(13);
  });

  it("I1: a refused variant-only patch leaves the entrants override alone", async () => {
    const r = await rig("generic", "score");
    const stored = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const withOverride = { ...stored, entrants: { kinds: ["individual"], defaultKind: "individual" } };
    await patchDivision(r.auth, r.divisionId, { config: withOverride });      // nothing started yet: saves
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    expect((before.config as { entrants?: unknown }).entrants, "the override is stored").toEqual(withOverride.entrants);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", variant_key: "win_loss" });
    expect(out.config, "no entrants key silently cleared").toEqual(before.config);
  });

  it("I1: the config left after restoring refused keys is parsed again — an invalid mix is CONFIG_INVALID and nothing is written", async () => {
    const r = await rig("badminton", "short");
    const m = resolveLatestModule("badminton");
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number; finalSetTo: number };
    // The kernel refines cap >= max(setTo, finalSetTo) (setbased/kernel.ts:129). Pool A sets `cap` itself (so cap is NOT inherited and saves) but inherits setTo (refused once started).
    await putStageRules(r.auth, r.s1.id, { rules: { cap: before.cap } });
    await start(r.auth, r.fixtureId);
    const requested = { ...before, setTo: before.setTo - 4, finalSetTo: before.finalSetTo - 4, cap: before.setTo - 2 };
    const restored = { ...before, cap: before.setTo - 2 };
    // Preconditions from the engine's own schema, so the case cannot pass vacuously:
    expect(m.configSchema.safeParse(requested).success, "the requested pair is valid").toBe(true);
    expect(m.configSchema.safeParse(restored).success, "the restored mix is invalid (cap below setTo)").toBe(false);
    // M-1: the SAME shape as the first parse (an EngineError CONFIG_INVALID carrying the engine's `issues`), plus the locked
    // fields that were kept as stored — the organiser never sent the value that makes the config invalid.
    const err = await rejection(patchDivision(r.auth, r.divisionId, { config: requested }));
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect(ENGINE_HTTP.CONFIG_INVALID, "EngineError CONFIG_INVALID is a 422 on the wire").toBe(422);
    const data = (err as unknown as EngineError).data as { issues: { message: string }[]; refused: { field: string; stageName: string }[] };
    expect(data.issues.length, "the engine's own issues ride along").toBeGreaterThan(0);
    expect(data.issues.map((i) => i.message)).toContain("cap must be ≥ the set target");
    expect(data.refused.map((x) => `${x.field}@${x.stageName}`).sort()).toEqual(["finalSetTo@Pool A", "setTo@Pool A"]);
    expect((err as unknown as Error).message, "the message names the kept fields").toMatch(/setTo.*stay as stored/);
    expect((await getDivision(r.auth, r.divisionId)).config).toEqual(before);
  });

  // ---- fix round 1 (review of 3658e6ea0) ----------------------------------------------------------------------

  it("I-2 withdrawal: an entrant withdrawing before any play STARTS the stage — the save that worked a moment ago is refused, naming it", async () => {
    // The cascade's forfeit goes through scoreEvent, so it writes a score_events row and freezes the fixture's snapshot:
    // that fixture now plays under the rules in force at the withdrawal, and a later division change would put the stage
    // on mixed rules. The lock is correct; the copy ("has started") is the owner's ruling, kept.
    const r = await rig("badminton", "short");
    await startDivision(r.auth, r.divisionId);        // the cascade only settles fixtures of a started division
    const used = () => sql<{ events: number; frozen: number }[]>`
      select (select count(*)::int from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${r.s1.id}) as events,
             (select count(*)::int from fixtures f where f.stage_id = ${r.s1.id} and f.config_snapshot is not null) as frozen`;
    expect((await used())[0], "precondition: Pool A has no event and no snapshot yet").toEqual({ events: 0, frozen: 0 });

    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const ok = await patchDivision(r.auth, r.divisionId, { config: { ...before, setTo: 13 } });          // the negative pair
    expect(ok.refused).toEqual([]);
    expect((ok.config as { setTo: number }).setTo).toBe(13);

    const [e1] = await sql<{ id: string }[]>`select id from entrants where division_id = ${r.divisionId} order by seed limit 1`;
    const out = await withdrawEntrantCascade(r.auth, e1!.id);
    expect(out.walkovers + out.voided, "the cascade wrote an event on Pool A's fixture").toBeGreaterThan(0);
    const after = (await used())[0]!;
    expect(after.events, "the withdrawal left a score event").toBeGreaterThan(0);

    const err = await rejection(patchDivision(r.auth, r.divisionId, { config: { ...(ok.config as object), setTo: 15 } }));
    expect(err).toMatchObject({
      status: 409,
      code: "DIVISION_FORMAT_LOCKED",
      message: "Pool A has started; its match format is locked. Change individual unstarted matches instead.",
      extra: { refused: [{ field: "setTo", stageName: "Pool A" }] },
    });
    expect(((await getDivision(r.auth, r.divisionId)).config as { setTo: number }).setTo, "the refused value was not written").toBe(13);
  });

  it("M-2 two started stages: Pool A sets the key itself, Pool B inherits it — the refusal names Pool B", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { setTo: 11 } });
    await start(r.auth, r.fixtureId);
    await startPoolB(r);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, setTo: 15 } });
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: r.s2.id, stageName: "Pool B" }]);
    expect((out.config as { setTo: number }).setTo).toBe((before as { setTo: number }).setTo);
  });

  it("M-2 two started stages that both inherit: every refusal names the first by seq (Pool A) — config key, variant and tiebreakers", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    await startPoolB(r);
    const before = (await getDivision(r.auth, r.divisionId)).config as { allowDraws: boolean };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed", tiebreakers: ["head_to_head"] as never, config: { ...before, allowDraws: !before.allowDraws },
    });
    expect(out.refused.length, "a config key and the tiebreakers were refused").toBe(2);
    for (const x of out.refused) expect(x, x.field).toMatchObject({ stageId: r.s1.id, stageName: "Pool A" });
    const v = await rejection(patchDivision(r.auth, r.divisionId, { variant_key: "win_loss" }));
    expect((v as { extra: { refused: { field: string; stageName: string }[] } }).extra.refused.find((x) => x.field === "variant_key")).toMatchObject({ stageName: "Pool A" });
  });

  it("M-3 a started stage that carries its own points still inherits every FORMAT key (the table exemption is for table keys only)", async () => {
    // Fixture-only: a stage's own `config.points` has no producer until Task 13, so it is written to the column.
    const r = await rig("generic", "score");
    await sql`update stages set config = config || ${sql.json({ points: { win: 2, draw: 1, loss: 0 } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { allowDraws: boolean };
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, allowDraws: !before.allowDraws } });
    expect(out.refused).toEqual([{ field: "allowDraws", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
  });

  it("M-3 pointsMap is a TABLE rule: refused with the table code while a started stage inherits it, saved once the stage carries its own points", async () => {
    const inherits = await rig("badminton", "short");
    await start(inherits.auth, inherits.fixtureId);
    const b1 = (await getDivision(inherits.auth, inherits.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(inherits.auth, inherits.divisionId, { name: "Renamed", config: { ...b1, pointsMap: { "*": [3, 0] } } });
    expect(refused.refused).toEqual([{ field: "pointsMap", code: "DIVISION_TABLE_RULES_LOCKED", stageId: inherits.s1.id, stageName: "Pool A" }]);
    expect((refused.config as { pointsMap: unknown }).pointsMap).toEqual((b1 as { pointsMap: unknown }).pointsMap);

    const own = await rig("badminton", "short");
    await sql`update stages set config = config || ${sql.json({ points: { win: 3, loss: 0 } } as never)} where id = ${own.s1.id}`;
    await start(own.auth, own.fixtureId);
    const b2 = (await getDivision(own.auth, own.divisionId)).config as Record<string, unknown>;
    const saved = await patchDivision(own.auth, own.divisionId, { config: { ...b2, pointsMap: { "*": [3, 0] } } });
    expect(saved.refused).toEqual([]);
    expect((saved.config as { pointsMap: unknown }).pointsMap).toEqual({ "*": [3, 0] });
  });

  it("M-3 a stored config that LACKS a key the schema defaults: re-sending it is refused as an added key, and the key stays absent", async () => {
    // Legacy-shape fixture (a row written before `winBy` existed): the key is removed from the column directly.
    const r = await rig("badminton", "short");
    await sql`update divisions set config = config - 'winBy' where id = ${r.divisionId}`;
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    expect(before.config, "precondition: the stored config has no winBy").not.toHaveProperty("winBy");
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: before.config as never });
    expect(out.refused).toEqual([{ field: "winBy", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect(out.config, "the refused default was not written: the key is still absent").not.toHaveProperty("winBy");
    expect(out.config).toEqual(before.config);
  });

  it("sibling gap: re-sending the CURRENT variant with no config on a started division is a no-op — the entrants override survives", async () => {
    const r = await rig("generic", "score");
    const stored = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const withOverride = { ...stored, entrants: { kinds: ["individual"], defaultKind: "individual" } };
    await patchDivision(r.auth, r.divisionId, { config: withOverride });
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    expect((before.config as { entrants?: unknown }).entrants, "precondition: the override is stored").toEqual(withOverride.entrants);
    const out = await patchDivision(r.auth, r.divisionId, { variant_key: "score" });
    expect(out.refused).toEqual([]);
    expect(out.variant_key).toBe("score");
    expect(out.config, "nothing changed, the entrants override included").toEqual(before.config);
  });

  it("M-c: re-sending the CURRENT variant with no config changes nothing — a customised key survives it, started or not; an ACCEPTED variant change still resets", async () => {
    // No web caller relies on "re-select the variant to reset to its preset": division-settings.tsx:619-622 always sends
    // `config` with the variant, and no other caller sends a bare variant_key.
    const r = await rig("badminton", "short");
    const base = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number };
    const customised = await patchDivision(r.auth, r.divisionId, { config: { ...base, setTo: 13, cap: 15 } });
    expect((customised.config as { setTo: number }).setTo, "precondition: a customised key, off the preset's 11").toBe(13);
    const stored = await getDivision(r.auth, r.divisionId);

    const again = await patchDivision(r.auth, r.divisionId, { variant_key: "short" });      // nothing started: no lock involved
    expect(again.refused).toEqual([]);
    expect(again.variant_key).toBe("short");
    expect(again.config, "the re-send reset nothing").toEqual(stored.config);
    expect((await getDivision(r.auth, r.divisionId)).config, "and wrote nothing").toEqual(stored.config);

    // Paired positive: a CHANGE of variant (no config) is still the reset to the new preset.
    const changed = await patchDivision(r.auth, r.divisionId, { variant_key: "bwf" });
    expect(changed.variant_key).toBe("bwf");
    expect((changed.config as { setTo: number }).setTo, "bwf's own 21").toBe(21);
  });

  it("M-a: a refused variant also keeps a key the variant switch would REMOVE (optional, no default) even when every started stage sets it", async () => {
    // tennis `interruptions` is an optional config key with NO default: present in the stored config, absent from the parsed
    // preset of any variant, so a restore driven by the preset's keys never names it. Fixture-only: no tennis rule field
    // writes it into a stage (the rule fields are bestOf, setType, finalSet, noAd, tiebreakWinBy), so the stage's own
    // `rules.interruptions` goes to the column; the lock reads `config.rules[key]` whoever wrote it.
    const r = await rig("tennis", "tour");
    const allowance = { medical: { count: 1 } };
    const stored = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    await patchDivision(r.auth, r.divisionId, { config: { ...stored, interruptions: allowance } });
    await sql`update stages set config = config || ${sql.json({ rules: { interruptions: allowance } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    expect((before.config as { interruptions?: unknown }).interruptions, "precondition: the key is stored").toEqual(allowance);
    const [grandSlam] = await sql<{ config: Record<string, unknown> }[]>`select config from sport_variants where sport_key = 'tennis' and key = 'grand-slam' order by org_id nulls last limit 1`;
    const preset = resolveLatestModule("tennis").configSchema.safeParse(grandSlam!.config);
    expect(preset.success && !Object.hasOwn(preset.data as object, "interruptions"), "precondition: the parsed preset has no such key").toBe(true);
    expect(preset.success && (preset.data as { bestOf: number }).bestOf, "and the switch is a real change (best of 5)").toBe(5);

    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", variant_key: "grand-slam" });
    expect(out.variant_key, "the variant stays").toBe("tour");
    expect(out.config, "no preset value landed and the key was not dropped").toEqual(before.config);
    expect((await getDivision(r.auth, r.divisionId)).config).toEqual(before.config);
    expect(out.refused).toContainEqual({ field: "interruptions", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" });
    expect(out.refused).toContainEqual(expect.objectContaining({ field: "variant_key", stageName: "Pool A" }));
  });

  it("tiebreakers: [] against a stored null is a CHANGE (an empty cascade is not the sport default) — refused once started", async () => {
    // Pinned as found, NOT as the fix-round brief asked ("[] and null both mean no custom tie-breaks, treat as equal"):
    // `engine-db/competition.ts:413` reads `division.tiebreakers ?? module.defaultTiebreakers`, so null is the sport's default
    // cascade and [] is an EMPTY one (rows then split by seed). Treating them as equal would either drop the organiser's
    // explicit empty cascade or write it past the lock this task adds.
    const r = await rig("badminton", "short");
    const before = await getDivision(r.auth, r.divisionId);
    expect(before.tiebreakers, "precondition: stored null").toBeNull();
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: [] as never })).rejects.toMatchObject({
      status: 409, code: "DIVISION_TABLE_RULES_LOCKED", extra: { refused: [{ field: "tiebreakers", stageName: "Pool A" }] },
    });
    expect((await getDivision(r.auth, r.divisionId)).tiebreakers, "still null").toBeNull();
    // And null against a stored null is the genuine no-op.
    const same = await patchDivision(r.auth, r.divisionId, { name: "Same", tiebreakers: null });
    expect(same.refused).toEqual([]);
  });
});

// ---- W2c Task 5 — the lock reads the engine's declaration (X-SR-4) -----------------------------------------------------

/** A division whose first stage is a bracket stage ("Final", no table), 2 entrants, generated; `league` adds a "Pool" league stage after it. */
async function rigBracket(sport: string, variant: string, opts: { league?: boolean; kind?: "individual" | "team" } = {}) {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind: opts.kind ?? ("individual" as const), display_name: `E${i}`, seed: i, members: [] })));
  const [ko] = await createStages(auth, d.id, { seq: 1, kind: "knockout", name: "Final", config: {}, progression: null });
  const league = opts.league ? (await createStages(auth, d.id, { seq: 2, kind: "league", name: "Pool", config: {}, progression: null }))[0]! : undefined;
  await generateStageFixtures(auth, ko!.id);
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${ko!.id} order by id limit 1`;
  if (league) await generateStageFixtures(auth, league.id);
  const [lf] = league ? await sql<{ id: string }[]>`select id from fixtures where stage_id = ${league.id} order by id limit 1` : [];
  return { auth, divisionId: d.id, ko: ko!, league, fixtureId: f!.id, leagueFixtureId: lf?.id };
}

describe("X-SR-4 the lock classifies a division key by the ENGINE's declaration (no database)", () => {
  it("X-SR-4 tableRuleKeys is the engine's points keys plus pointsMap, narrowed by variant; another sport's non-points keys are never in it", () => {
    const fake = {
      key: "fake",
      ruleKeys: {
        pts: { scope: "points" },
        vpts: { scope: "points", appliesTo: { variants: ["a"] } },
        fmt: { scope: "match" },
        stg: { scope: "stage" },
      },
    } as unknown as AnySportModule;
    expect([...tableRuleKeys(fake, null)].sort()).toEqual(["pointsMap", "pts", "vpts"]);
    expect([...tableRuleKeys(fake, "a")].sort()).toEqual(["pointsMap", "pts", "vpts"]);
    expect([...tableRuleKeys(fake, "b")].sort(), "a points key that does not apply to the variant is not a table key").toEqual(["pointsMap", "pts"]);
    expect([...tableRuleKeys({ key: "none", ruleKeys: undefined } as unknown as AnySportModule, null)], "no declaration: only pointsMap").toEqual(["pointsMap"]);
    // The real sports, every variant (M-4). The expected classification is the engine's declaration: a declared `points`
    // key is a table rule, every other declared key is not. The config is a second authority: a table key the sport's
    // own parsed config does not carry could never be a changed config key, so it would be a lock that never fires.
    let sports = 0;
    let classified = 0;
    let carried = 0;
    for (const m of builtinModules) {
      for (const variant of [null, ...Object.keys(m.variants)]) {
        const keys = tableRuleKeys(m, variant);
        for (const [k, fact] of Object.entries(m.ruleKeys ?? {})) {
          if (!ruleKeyApplies(fact, null, variant)) continue;
          expect(keys.has(k), `${m.key}/${variant ?? "-"} ${k} (${fact.scope})`).toBe(fact.scope === "points");
          classified++;
        }
        expect(keys.has("pointsMap"), `${m.key}: pointsMap is always a table rule`).toBe(true);
        const parsed = m.configSchema.safeParse(variant === null ? {} : m.variants[variant]);
        if (!parsed.success) continue; // generic's bare config needs a mode; every variant preset parses
        for (const k of pointsKeysFor(m, null, variant)) { expect(k in parsed.data, `${m.key}/${variant ?? "-"} table key ${k} is not in its parsed config`).toBe(true); carried++; }
      }
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(classified, "the sweep classified no key at all").toBeGreaterThan(builtinModules.length);
    expect(carried, "no table key was checked against a parsed config").toBeGreaterThanOrEqual(builtinModules.length);
  });
});

describe.skipIf(!HAS_DB)("X-SR-4 the lock classifies a division key by the ENGINE's declaration", () => {
  it("X-SR-4 table rule keys come from the engine: an ice hockey `points` edit is table rules, a `periods` edit is match format", async () => {
    const ice = resolveLatestModule("icehockey");
    const table = new Set(pointsKeysFor(ice, null, null));
    // The expectation is the engine's own declaration. `awardScore` is the case the old literal got wrong: a points key
    // that is not called `points`.
    expect([...table].sort()).toEqual(["awardScore", "points"]);
    expect(table.has("periods"), "periods is match format").toBe(false);

    const r = await rig("icehockey", "iihf", "team");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { points: object; awardScore: { goals: number }; periods: { count: number; minutes: number } };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed", // a save that applies nothing at all throws; the rename is what lands beside `refused`
      config: { ...before, points: { ...before.points, win: 4 }, awardScore: { goals: before.awardScore.goals + 1 }, periods: { ...before.periods, minutes: before.periods.minutes - 5 } },
    });
    expect(out.refused.map((x) => x.field).sort(), "all three edits were refused").toEqual(["awardScore", "periods", "points"]);
    let judged = 0;
    for (const x of out.refused) {
      expect(x.code, x.field).toBe(table.has(x.field) ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED");
      judged++;
    }
    expect(judged).toBe(3);
    expect(out.refused.filter((x) => x.code === "DIVISION_TABLE_RULES_LOCKED").length, "both points keys were table rules").toBe(table.size);
    expect(out.config, "nothing refused was written").toEqual(before);
  });

  it("M-b a started KNOCKOUT stage has no table: a division pointsMap and tiebreakers edit save; a started league stage refuses the same patch", async () => {
    const ko = await rigBracket("badminton", "short");
    await start(ko.auth, ko.fixtureId);
    const b1 = (await getDivision(ko.auth, ko.divisionId)).config as Record<string, unknown>;
    const saved = await patchDivision(ko.auth, ko.divisionId, { config: { ...b1, pointsMap: { "*": [3, 0] } }, tiebreakers: ["head_to_head"] as never });
    expect(saved.refused).toEqual([]);
    expect((saved.config as { pointsMap: unknown }).pointsMap, "the table change was written").toEqual({ "*": [3, 0] });
    expect(saved.tiebreakers, "the cascade change was written").toEqual(["head_to_head"]);

    // The pair: the same two edits against a started LEAGUE stage are refused, by name.
    const lg = await rig("badminton", "short");
    await start(lg.auth, lg.fixtureId);
    const b2 = (await getDivision(lg.auth, lg.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(lg.auth, lg.divisionId, { name: "Renamed", config: { ...b2, pointsMap: { "*": [3, 0] } }, tiebreakers: ["head_to_head"] as never });
    expect(refused.refused.map((x) => `${x.field}:${x.code}`).sort()).toEqual(["pointsMap:DIVISION_TABLE_RULES_LOCKED", "tiebreakers:DIVISION_TABLE_RULES_LOCKED"]);
  });

  it("M-b a started knockout still inherits the division's MATCH format: setTo is refused naming the Final", async () => {
    const ko = await rigBracket("badminton", "short");
    await start(ko.auth, ko.fixtureId);
    const before = (await getDivision(ko.auth, ko.divisionId)).config as Record<string, unknown>;
    const out = await patchDivision(ko.auth, ko.divisionId, { name: "Renamed", config: { ...before, setTo: 15 } });
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: ko.ko.id, stageName: "Final" }]);
    expect(out.name).toBe("Renamed");
  });

  it("M-b a knockout and a league both started: the table refusal names the league (the stage with a table), the format refusal the knockout (first by seq)", async () => {
    const r = await rigBracket("badminton", "short", { league: true });
    await start(r.auth, r.fixtureId);
    await start(r.auth, r.leagueFixtureId!);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, pointsMap: { "*": [3, 0] }, setTo: 15 }, tiebreakers: ["head_to_head"] as never });
    const byField = Object.fromEntries(out.refused.map((x) => [x.field, x.stageName]));
    expect(byField).toEqual({ pointsMap: "Pool", tiebreakers: "Pool", setTo: "Final" });
  });

  it("M-b carrom `tieBoard` applies to table stages: a started knockout (which forces the extra board) does not inherit it, a started league does", async () => {
    const carrom = resolveLatestModule("carrom");
    expect(ruleKeyApplies(carrom.ruleKeys!.tieBoard!, "knockout", null), "precondition: the engine says tieBoard is not a knockout key").toBe(false);
    expect(ruleKeyApplies(carrom.ruleKeys!.tieBoard!, "league", null), "precondition: and is a league key").toBe(true);

    const ko = await rigBracket("carrom", "icf");
    await start(ko.auth, ko.fixtureId);
    const b1 = (await getDivision(ko.auth, ko.divisionId)).config as Record<string, unknown>;
    expect(b1.tieBoard, "precondition: the stored value is the default").toBe("extra");
    const saved = await patchDivision(ko.auth, ko.divisionId, { config: { ...b1, tieBoard: "draw" } });
    expect(saved.refused).toEqual([]);
    expect((saved.config as { tieBoard: string }).tieBoard).toBe("draw");

    const lg = await rig("carrom", "icf");
    await start(lg.auth, lg.fixtureId);
    const b2 = (await getDivision(lg.auth, lg.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(lg.auth, lg.divisionId, { name: "Renamed", config: { ...b2, tieBoard: "draw" } });
    expect(refused.refused).toEqual([{ field: "tieBoard", code: "DIVISION_FORMAT_LOCKED", stageId: lg.s1.id, stageName: "Pool A" }]);
  });

  it("M-b a started knockout that carries its own top-level `shootout` does not inherit the division's; one that does not, does", async () => {
    const fb = resolveLatestModule("football");
    expect(deciderKeysFor(fb, "knockout", null), "precondition: the engine declares shootout a decider").toContain("shootout");

    const own = await rigBracket("football", "11-a-side", { kind: "team" });
    await sql`update stages set config = config || ${sql.json({ shootout: true } as never)} where id = ${own.ko.id}`;
    await start(own.auth, own.fixtureId);
    const b1 = (await getDivision(own.auth, own.divisionId)).config as Record<string, unknown>;
    const saved = await patchDivision(own.auth, own.divisionId, { config: { ...b1, shootout: true } });
    expect(saved.refused).toEqual([]);
    expect((saved.config as { shootout: boolean }).shootout).toBe(true);

    const inherits = await rigBracket("football", "11-a-side", { kind: "team" });
    await start(inherits.auth, inherits.fixtureId);
    const b2 = (await getDivision(inherits.auth, inherits.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(inherits.auth, inherits.divisionId, { name: "Renamed", config: { ...b2, shootout: true } });
    expect(refused.refused).toEqual([{ field: "shootout", code: "DIVISION_FORMAT_LOCKED", stageId: inherits.ko.id, stageName: "Final" }]);
  });

  it("M-b the division's own variant reaches the lock: cricket DLS, offered in t20, is refused naming the started stage", async () => {
    const cr = resolveLatestModule("cricket");
    expect(ruleKeyApplies(cr.ruleKeys!.dls!, "league", "t20"), "precondition: the engine offers DLS in t20").toBe(true);
    // (The pair, a test-match division, cannot be witnessed through a save: the cricket schema refuses DLS there outright,
    // "DLS requires a limited-overs config". The narrowing itself is proven on a fake module below.)
    const r = await rig("cricket", "t20", "team");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { dls: { enabled: boolean; edition: string } };
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, dls: { ...before.dls, enabled: true } } });
    expect(out.refused).toEqual([{ field: "dls", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { dls: { enabled: boolean } }).dls.enabled, "nothing refused was written").toBe(false);
  });

  // The predicate with a module the test builds, over REAL started stages: each guard witnessed alone (carrom's
  // tieBoard cannot do it: its appliesTo and its forced value cover the same kinds, so either guard hides the other).
  describe("the inherits predicate, one guard at a time (fake module, real stages)", () => {
    const fakeModule = (ruleKeys: Record<string, unknown>, forced: Record<string, unknown> = {}) =>
      ({ key: "fake", ruleKeys, bracketDeciders: () => forced }) as unknown as AnySportModule;
    const refusalsFor = async (r: { divisionId: string }, mod: AnySportModule, keys: string[], variantKey = "x") =>
      sql.begin((tx) => divisionRefusals(tx, r.divisionId, { configKeys: keys, variant: false, tiebreakers: false }, { module: mod, variantKey, divisionConfig: {} }));

    it("X-SR-4 a key that applies to table kinds only is not inherited by a started knockout, and is by a started league", async () => {
      const r = await rigBracket("generic", "score", { league: true });
      await start(r.auth, r.fixtureId);
      const mod = fakeModule({ drawOnly: { scope: "stage", appliesTo: { stageKinds: ["league"] } }, anyKind: { scope: "stage" } });
      const got = await refusalsFor(r, mod, ["drawOnly", "anyKind"]);
      expect(got.map((x) => `${x.field}@${x.stageName}`)).toEqual(["anyKind@Final"]);          // knockout started only: anyKind yes, drawOnly no
      await start(r.auth, r.leagueFixtureId!);
      const both = await refusalsFor(r, mod, ["drawOnly", "anyKind"]);
      expect(both.map((x) => `${x.field}@${x.stageName}`).sort()).toEqual(["anyKind@Final", "drawOnly@Pool"]);
    });

    it("X-SR-4 a top key declared only by a dotted key still applies by its top segment (periods.minutes → periods)", async () => {
      const r = await rigBracket("generic", "score");
      await start(r.auth, r.fixtureId);
      const mod = fakeModule({ "periods.minutes": { scope: "match", appliesTo: { stageKinds: ["league"] } } });
      expect(await refusalsFor(r, mod, ["periods"]), "not a knockout key").toEqual([]);
      expect((await refusalsFor(r, fakeModule({ "periods.minutes": { scope: "match" } }), ["periods"])).map((x) => x.field), "a key with no narrowing").toEqual(["periods"]);
    });

    it("X-SR-4 a key declared for some variants only is inherited by a stage in one of them and not by a stage in another", async () => {
      const r = await rigBracket("generic", "score");
      await start(r.auth, r.fixtureId);
      const mod = fakeModule({ onlyY: { scope: "stage", appliesTo: { variants: ["y"] } } });
      expect((await refusalsFor(r, mod, ["onlyY"], "y")).map((x) => x.field), "offered in y").toEqual(["onlyY"]);
      expect(await refusalsFor(r, mod, ["onlyY"], "z"), "not offered in z").toEqual([]);
    });

    it("X-SR-4 a key the engine never declares keeps locking (interruptions-shaped config the form never edits)", async () => {
      const r = await rigBracket("generic", "score");
      await start(r.auth, r.fixtureId);
      expect((await refusalsFor(r, fakeModule({}), ["undeclared"])).map((x) => x.field)).toEqual(["undeclared"]);
    });

    it("X-SR-4 a key a bracket stage has forced on (bracketDeciders) is not inherited by a started knockout, by a started league it is", async () => {
      const r = await rigBracket("generic", "score", { league: true });
      await start(r.auth, r.fixtureId);
      await start(r.auth, r.leagueFixtureId!);
      const mod = fakeModule({ forcedKey: { scope: "stage" }, plainKey: { scope: "stage" } }, { forcedKey: true });
      const got = await refusalsFor(r, mod, ["forcedKey", "plainKey"]);
      expect(got.map((x) => `${x.field}@${x.stageName}`).sort()).toEqual(["forcedKey@Pool", "plainKey@Final"]);
    });

    it("X-SR-4 a stage that sets a declared decider at its top level does not inherit it; one that sets a non-decider there still does", async () => {
      const r = await rigBracket("generic", "score");
      await sql`update stages set config = config || ${sql.json({ dec: 1, plain: 1 } as never)} where id = ${r.ko.id}`;
      await start(r.auth, r.fixtureId);
      const mod = fakeModule({ dec: { scope: "stage", decider: true }, plain: { scope: "stage" } });
      const got = await refusalsFor(r, mod, ["dec", "plain"]);
      expect(got.map((x) => x.field), "only the non-decider is inherited").toEqual(["plain"]);
    });
  });
});

// lib/rule-errors.ts is the one place the W2c lock codes, their HTTP statuses and their English sentences live.
// The expected table is the plan's (spec §7), typed here once; the code under test is not consulted for it.
describe("X-SR-4 rule-errors: the W2c code table", () => {
  const SPEC: Record<RuleErrorCode, number> = {
    STAGE_FORMAT_LOCKED: 409, DIVISION_TABLE_RULES_LOCKED: 409, DIVISION_FORMAT_LOCKED: 409,
    FIXTURE_FORMAT_LOCKED: 409, FORMAT_DOES_NOT_FIT_PLAY: 409, RULE_NOT_SETTABLE: 400, POINTS_RULE_INEXPRESSIBLE: 422,
  };
  it("declares exactly the seven codes, each with its status", () => {
    expect(Object.keys(SPEC).length).toBe(7);
    expect(RULE_ERROR_STATUS).toEqual(SPEC);
  });
  it("every code has an English sentence, and the stage codes name the stage", () => {
    const codes = Object.keys(SPEC) as RuleErrorCode[];
    let checked = 0;
    for (const code of codes) {
      const msg = ruleErrorMessage(code, { stage: "Pool A", field: "setTo", reason: "why" });
      expect(msg.length, code).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, "anti-vacuity: every declared code was checked").toBe(codes.length);
    expect(ruleErrorMessage("STAGE_FORMAT_LOCKED", { stage: "Pool A" })).toBe("Pool A has started — its rules are locked.");
    expect(ruleErrorMessage("DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" })).toBe("Pool A has started — table rules are locked.");
    expect(ruleErrorMessage("DIVISION_FORMAT_LOCKED", { stage: "Pool A" })).toBe("Pool A has started; its match format is locked. Change individual unstarted matches instead.");
    expect(ruleErrorMessage("FIXTURE_FORMAT_LOCKED", {})).toBe("This match is finished — its format is locked.");
    expect(ruleErrorMessage("FORMAT_DOES_NOT_FIT_PLAY", { reason: "set 2 has 30 points" })).toBe("set 2 has 30 points");
    expect(ruleErrorMessage("FORMAT_DOES_NOT_FIT_PLAY", {})).toBe("The recorded play does not fit this format.");
    expect(ruleErrorMessage("RULE_NOT_SETTABLE", { field: "points" })).toBe("points can't be set here.");
    expect(ruleErrorMessage("RULE_NOT_SETTABLE", { field: "points", reason: "table rules" })).toBe("points can't be set here — table rules.");
    expect(ruleErrorMessage("POINTS_RULE_INEXPRESSIBLE", { reason: "a bonus on a tie" })).toBe("These points can't be set per stage yet — a bonus on a tie.");
  });
});
