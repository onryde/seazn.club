// X-SR-4 — division table rules and match format lock per STARTED INHERITING
// stage (Q3, Q4; plan D12). P4's lock sequence for the division (spec §9).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { RULE_ERROR_STATUS, ruleErrorMessage, type RuleErrorCode } from "@/lib/rule-errors";
import { BRACKET_KINDS, DRAW_KINDS, EngineError, StageKind, forbidsLevelResult } from "@seazn/engine/core";
import { deciderKeysFor, pointsKeysFor, ruleKeyApplies, stageDefaultsFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { PointsRule, applyPointsRule } from "@seazn/engine/competition";
import { defaultLineupPair } from "@seazn/engine/testkit";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ENGINE_HTTP, v1 } from "@/server/api-v1/http";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { STAGE_POINTS_REPLACES, divisionRefusals, tableRuleKeys } from "../rule-locks";
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
    // W2c Task 12 (Task 2 review): the real refusal through the real v1 envelope — `refused` reaches the client beside
    // `issues`, so the organiser is told which kept values the config no longer parses with.
    const wire = (await (await v1(async () => { throw err; })).json()) as { error: { refused?: unknown; issues?: unknown } };
    expect(wire.error.refused, "the 422 names the kept fields").toEqual(data.refused);
    expect(Array.isArray(wire.error.issues) && wire.error.issues.length > 0, "and the engine's issues").toBe(true);
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

/** A division with ONE stage of `kind` that has started: a fixture row carrying a frozen config, the lock's own started
 *  predicate (`lockedStageIdsAmong`: a `config_snapshot` or a score event). Only the lock is under test, so the fixture is
 *  the thinnest row that predicate reads, not a generated draw (some kinds need a format the lock does not care about). */
async function startedStageOfKind(sport: string, variant: string, kind: StageKind) {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  const [stage] = await createStages(auth, d.id, { seq: 1, kind, name: `K-${kind}`, config: kind === "swiss" ? { rounds: 3 } : {}, progression: null });
  await sql`insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, fixture_no, config_snapshot)
            values (${stage!.id}, ${d.id}, ${auth.orgId}, 1, 1, 1, ${sql.json({} as never)})`;
  return { divisionId: d.id, stage: stage! };
}

describe("X-SR-4 the lock classifies a division key by the ENGINE's declaration (no database)", () => {
  // Fix round 2, I-2. What a stage PointsRule replaces is a fact about the engine (competition/points.ts: `applyPointsRule`
  // re-derives `points` and leaves the sport's metrics ledger untouched), so it is checked against the engine, not against
  // the lock's own constant.
  it("I-2 STAGE_POINTS_REPLACES names only declared table keys, and the three other points keys a module declares are the ones left locked (counted)", () => {
    const declared = new Set<string>();
    let cells = 0;
    for (const m of builtinModules)
      for (const variant of [null, ...Object.keys(m.variants)]) {
        for (const key of tableRuleKeys(m, variant)) declared.add(key);
        cells++;
      }
    expect(cells, "swept the registry's module x variant cells").toBeGreaterThan(builtinModules.length);
    for (const key of STAGE_POINTS_REPLACES) expect(declared.has(key), `${key} is a table key some module declares`).toBe(true);
    // A new points key a module declares must be classified deliberately: it is locked until someone shows the rule replaces it.
    // W2c Task 9 addendum: a board game's `scoring` also writes the game's own headline, so a stage rule does not replace it.
    expect([...declared].filter((k) => !STAGE_POINTS_REPLACES.has(k)).sort()).toEqual(["awardScore", "byeScore", "scoring"]);
  });

  it("I-2 awardScore reaches the table through the sport's own forfeit credit AFTER play, which a stage PointsRule — even one carrying its own award score — leaves in place (engine differential, every module that declares it)", () => {
    // W2c gap (a): a rule's award score now REPLACES the sport's own score keys (`awardScoreKeys`) on a forfeit with nothing
    // played, so there the division's awardScore stops mattering. It still decides every forfeit AFTER play: X-PT-1 pays
    // that as a result and leaves the sport's credit, and the credit is `goalCredit(awardScore, real)` (FB-RT-1 / HK-RT-1 /
    // IH-RT-1) — so the key stays locked whatever the stage rule carries.
    const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [1, 0] } });
    let swept = 0;
    for (const m of builtinModules) {
      if (!pointsKeysFor(m, null, null).includes("awardScore")) continue;
      swept++;
      const lineups = defaultLineupPair(m.positions);
      const base = m.configSchema.parse({}) as { awardScore: { goals: number } };
      const raised = m.configSchema.parse({ awardScore: { goals: base.awardScore.goals + 2 } });
      const ledger = (cfg: unknown, reason: "walkover" | "retired") => m.forfeitCredit(cfg as never, m.init(cfg as never, lineups), reason, "away").perSide;
      const outcome = (reason: "walkover" | "retired") => ({ kind: "award", winner: "H", loser: "A", reason }) as never;
      const delta = (side: 0 | 1, cfg: unknown, reason: "walkover" | "retired") => ({ entrantId: side === 0 ? "H" : "A", played: 1, won: side === 0 ? 1 : 0, drawn: 0, lost: side === 0 ? 0 : 1, points: 0, metrics: { ...ledger(cfg, reason)[side] } });
      const viaRule = (cfg: unknown, reason: "walkover" | "retired", played: boolean) =>
        applyPointsRule(outcome(reason), [delta(0, cfg, reason), delta(1, cfg, reason)] as never, rule, played, m.awardScoreKeys)[0].metrics;
      const own = Object.keys(ledger(base, "retired")[0]);
      expect(own.length, `${m.key}: the forfeit credits the winner something`).toBeGreaterThan(0);
      expect(ledger(raised, "retired")[0], `${m.key}: awardScore changes what a retirement credits`).not.toEqual(ledger(base, "retired")[0]);
      // After play: the sport's credit stands under the rule, so awardScore still decides the table's goals.
      for (const k of own) expect(viaRule(raised, "retired", true)[k], `${m.key}.${k}: the rule leaves an after-play credit as it was`).toBe(ledger(raised, "retired")[0][k]);
      expect(viaRule(raised, "retired", true), `${m.key}: awardScore decides an after-play forfeit under the rule`).not.toEqual(viaRule(base, "retired", true));
      // Nothing played (gap a): the rule's award replaces it, whatever the division says — the case that does NOT lock.
      expect(viaRule(raised, "walkover", false), `${m.key}: an unplayed walkover reads the rule's award, not the division's`).toEqual(viaRule(base, "walkover", false));
    }
    expect(swept, "football, ice hockey and hockey declare awardScore").toBe(3);
  });

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

  // Fix round 1, I1. A patch is applied PER FIELD (owner P-2 "A"): every field the lock lets through lands, every field it
  // refuses is named in `refused`, and only a patch from which NOTHING lands is a 409. The 409 test therefore asks what
  // WILL BE WRITTEN, never "was something refused": a tiebreakers change a knockout-only division does not refuse is a
  // write like any other, and dropping it behind a 409 that names only setTo would lose it silently.
  it("I1 a mixed patch on a knockout-only division lands what is allowed: tiebreakers is saved, setTo is refused by name (200, not a 409 that drops the tiebreakers)", async () => {
    const ko = await rigBracket("badminton", "short");
    await start(ko.auth, ko.fixtureId);
    const before = (await getDivision(ko.auth, ko.divisionId)).config as Record<string, unknown> & { setTo: number };
    const out = await patchDivision(ko.auth, ko.divisionId, { config: { ...before, setTo: 15 }, tiebreakers: ["head_to_head"] as never });
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: ko.ko.id, stageName: "Final" }]);
    expect(out.tiebreakers, "the allowed change landed").toEqual(["head_to_head"]);
    expect((out.config as { setTo: number }).setTo, "the refused change did not").toBe(before.setTo);
    expect((await getDivision(ko.auth, ko.divisionId)).tiebreakers, "and it is stored").toEqual(["head_to_head"]);

    // The negative's pair: the same patch where the tiebreakers change IS refused too (a started league has a table) lands
    // nothing, so it is a 409 naming the first refused field, with every refused field in `refused`.
    const lg = await rig("badminton", "short");
    await start(lg.auth, lg.fixtureId);
    const b2 = (await getDivision(lg.auth, lg.divisionId)).config as Record<string, unknown>;
    const tiebreakersBefore = (await getDivision(lg.auth, lg.divisionId)).tiebreakers;
    const err = await rejection(patchDivision(lg.auth, lg.divisionId, { config: { ...b2, setTo: 15 }, tiebreakers: ["head_to_head"] as never }));
    expect(err, "the first refusal in the list leads: the cascade, then the config keys").toMatchObject({ status: RULE_ERROR_STATUS.DIVISION_TABLE_RULES_LOCKED, code: "DIVISION_TABLE_RULES_LOCKED" });
    expect((err as { extra?: { refused: { field: string }[] } }).extra?.refused.map((x) => x.field).sort()).toEqual(["setTo", "tiebreakers"]);
    expect((await getDivision(lg.auth, lg.divisionId)).tiebreakers, "nothing landed").toEqual(tiebreakersBefore);
  });

  it("M4 every stage kind: a table key and the cascade lock only a kind with a table, a format key every kind, carrom tieBoard on every kind but those that force it (counted)", async () => {
    const generic = resolveLatestModule("generic");
    const carrom = resolveLatestModule("carrom");
    expect(pointsKeysFor(generic, null, "score"), "precondition: generic's table key").toContain("points");
    expect(stageKeysFor(generic, null, "score"), "precondition: generic's format key").toContain("allowDraws");
    let swept = 0;
    let withTable = 0;
    let withoutTable = 0;
    let tieBoardLocked = 0;
    for (const kind of StageKind.options) {
      const hasTable = DRAW_KINDS.has(kind);
      expect(hasTable !== BRACKET_KINDS.has(kind), `${kind}: the engine puts every kind in exactly one of the two sets`).toBe(true);
      const g = await startedStageOfKind("generic", "score", kind);
      const got = await sql.begin((tx) =>
        divisionRefusals(tx, g.divisionId, { configKeys: ["points", "allowDraws"], variant: false, tiebreakers: true }, { module: generic, variantKey: "score", divisionConfig: {} }));
      const byField = Object.fromEntries(got.map((x) => [x.field, x.code]));
      expect(byField.allowDraws, `${kind}: a format key locks on every kind`).toBe("DIVISION_FORMAT_LOCKED");
      expect(byField.points, `${kind} points`).toBe(hasTable ? "DIVISION_TABLE_RULES_LOCKED" : undefined);
      expect(byField.tiebreakers, `${kind} tiebreakers`).toBe(hasTable ? "DIVISION_TABLE_RULES_LOCKED" : undefined);
      expect(got.every((x) => x.stageId === g.stage.id && x.stageName === g.stage.name), `${kind}: every refusal names the started stage`).toBe(true);
      if (hasTable) withTable++; else withoutTable++;

      const c = await startedStageOfKind("carrom", "icf", kind);
      const tie = await sql.begin((tx) =>
        divisionRefusals(tx, c.divisionId, { configKeys: ["tieBoard"], variant: false, tiebreakers: false }, { module: carrom, variantKey: "icf", divisionConfig: {} }));
      // The oracle is the engine's own declaration of what a bracket stage forces: a stage that forces the tie board ignores
      // the division's, every other kind reads it.
      const forcesTieBoard = forbidsLevelResult(kind) && Object.hasOwn(carrom.bracketDeciders(carrom.configSchema.parse({}) as never), "tieBoard");
      expect(tie.length, `${kind}: carrom tieBoard`).toBe(forcesTieBoard ? 0 : 1);
      tieBoardLocked += tie.length;
      swept++;
    }
    expect(swept, "every kind of the engine's StageKind").toBe(StageKind.options.length);
    expect(withTable).toBe(DRAW_KINDS.size);
    expect(withoutTable).toBe(BRACKET_KINDS.size);
    expect(withTable, "at least one kind with a table was swept").toBeGreaterThan(0);
    expect(withoutTable, "at least one kind without a table was swept").toBeGreaterThan(0);
    expect(tieBoardLocked, "tieBoard locked on exactly the kinds that do not force it").toBe(DRAW_KINDS.size);
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

  it("M-b carrom `tieBoard`: a started knockout forces the extra board and does not inherit the division's, a started league does", async () => {
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

  it("M-b a started knockout that carries its own `shootout` in `rules` (its preset) does not inherit the division's; one with only a top-level key (read by nothing since D3), or cleared back to the division, does", async () => {
    const fb = resolveLatestModule("football");
    expect(deciderKeysFor(fb, "knockout", null), "precondition: the engine declares shootout a decider").toContain("shootout");
    expect(stageDefaultsFor(fb, "knockout", "11-a-side"), "precondition: a new knockout starts with the shoot-out (X-SR-6)").toHaveProperty("shootout");

    // W2c Task 12: the knockout is CREATED with its preset, `rules.shootout` — the stage carries its own.
    const preset = await rigBracket("football", "11-a-side", { kind: "team" });
    await start(preset.auth, preset.fixtureId);
    const b0 = (await getDivision(preset.auth, preset.divisionId)).config as Record<string, unknown>;
    const viaRules = await patchDivision(preset.auth, preset.divisionId, { config: { ...b0, shootout: true } });
    expect(viaRules.refused).toEqual([]);

    // The pre-W2c storage, a top-level key and no rules. W2c Task 13b (D3) retired the resolver's top-level read, so the
    // stage plays the division's shoot-out: a change to it reaches the started stage and is refused, naming it.
    const top = await rigBracket("football", "11-a-side", { kind: "team" });
    await sql`update stages set config = (config - 'rules') || ${sql.json({ shootout: true } as never)} where id = ${top.ko.id}`;
    await start(top.auth, top.fixtureId);
    const b1 = (await getDivision(top.auth, top.divisionId)).config as Record<string, unknown>;
    const topOnly = await patchDivision(top.auth, top.divisionId, { name: "Renamed", config: { ...b1, shootout: true } });
    expect(topOnly.refused).toEqual([{ field: "shootout", code: "DIVISION_FORMAT_LOCKED", stageId: top.ko.id, stageName: "Final" }]);
    expect((topOnly.config as { shootout: boolean }).shootout, "nothing refused was written").toBe(false);

    // The organiser cleared the stage back to the division (`PUT /stages/{id}/rules {rules: null}`): it inherits.
    const inherits = await rigBracket("football", "11-a-side", { kind: "team" });
    await putStageRules(inherits.auth, inherits.ko.id, { rules: null });
    await start(inherits.auth, inherits.fixtureId);
    const b2 = (await getDivision(inherits.auth, inherits.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(inherits.auth, inherits.divisionId, { name: "Renamed", config: { ...b2, shootout: true } });
    expect(refused.refused).toEqual([{ field: "shootout", code: "DIVISION_FORMAT_LOCKED", stageId: inherits.ko.id, stageName: "Final" }]);
  });

  it("M-b cricket DLS, offered in t20, is refused naming the started stage (an engine `appliesTo` is not a lock input, I-1)", async () => {
    const cr = resolveLatestModule("cricket");
    expect(ruleKeyApplies(cr.ruleKeys!.dls!, "league", "t20"), "precondition: the engine offers DLS in t20").toBe(true);
    // (The pair, a test-match division, cannot be witnessed through a save: the cricket schema refuses DLS there outright,
    // "DLS requires a limited-overs config". `appliesTo` is not a lock input: see the I-1 fake-module test below.)
    const r = await rig("cricket", "t20", "team");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { dls: { enabled: boolean; edition: string } };
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, dls: { ...before.dls, enabled: true } } });
    expect(out.refused).toEqual([{ field: "dls", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { dls: { enabled: boolean } }).dls.enabled, "nothing refused was written").toBe(false);
  });

  // W2c Task 12 (batch-2 concern A, Task 5 M2): a decider is the stage's own only where the resolver READS it there. A
  // top-level `superOver` is read by nothing (stage-cfg.ts reads `rules` alone since Task 13b), so a started stage carrying
  // one still plays the DIVISION's super over: a change to it reaches that stage's unplayed fixtures and is refused, naming
  // the stage. Its D3 storage, `rules.superOver`, is its own.
  it("M-b a started t20 stage with a top-level `superOver` (read by nothing) inherits the division's and is refused; one with `rules.superOver` does not", async () => {
    const cr = resolveLatestModule("cricket");
    expect(deciderKeysFor(cr, "league", "t20"), "precondition: the engine declares superOver a t20 decider").toContain("superOver");
    const r = await rig("cricket", "t20", "team");
    await sql`update stages set config = config || ${sql.json({ superOver: true } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, superOver: true } });
    expect(out.refused).toEqual([{ field: "superOver", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { superOver: boolean }).superOver, "nothing refused was written").toBe(false);

    const own = await rig("cricket", "t20", "team");
    await putStageRules(own.auth, own.s1.id, { rules: { superOver: true } });
    await start(own.auth, own.fixtureId);
    const b2 = (await getDivision(own.auth, own.divisionId)).config as Record<string, unknown>;
    const saved = await patchDivision(own.auth, own.divisionId, { config: { ...b2, superOver: true } });
    expect(saved.refused).toEqual([]);
    expect((saved.config as { superOver: boolean }).superOver).toBe(true);
  });

  // Fix round 2, I-1. The engine's `appliesTo` says where a key is OFFERED, not where the fold READS it: boardgame lists
  // `tiebreak` for bracket kinds, but the fold has no stage kind at all and the resolver hands a non-bracket stage the
  // division's value as it stands (fixture-cfg.ts), so a drawn league game folds to the tie-break phase when the division
  // says so. A key a stage truly ignores is the FORCED one (`bracketDeciders`), not the unlisted one.
  it("I-1 a started chess LEAGUE inherits the division's tiebreak: the engine lists it for bracket kinds only, but the fold reads it in every kind", async () => {
    const bg = resolveLatestModule("boardgame");
    // W2c BG-KO-1/3: the organiser's chess decider is the rung list, not `tiebreak` (which the bracket overlay forces and the
    // engine no longer declares as a stage key). The league still folds to the tie-break phase when the division says so.
    expect(bg.ruleKeys!.tiebreak, "precondition: the engine declares no stage key for the forced switch").toBeUndefined();
    expect(ruleKeyApplies(bg.ruleKeys!.tiebreakRungs!, "league", "classical"), "precondition: the engine's appliesTo does not list a league").toBe(false);
    const r = await rig("boardgame", "classical");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    expect(before.tiebreak, "precondition: the stored config does not carry it").toBeUndefined();
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, tiebreak: true } });
    expect(out.refused).toEqual([{ field: "tiebreak", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { tiebreak?: boolean }).tiebreak, "nothing refused was written").toBeUndefined();
  });

  it("I-1 the pair: a started chess KNOCKOUT forces the tie-break on itself, so it does not inherit the division's value and the save lands", async () => {
    const bg = resolveLatestModule("boardgame");
    expect(Object.keys(bg.bracketDeciders(bg.configSchema.parse({}))), "precondition: a bracket game forces tiebreak").toContain("tiebreak");
    const r = await rigBracket("boardgame", "classical");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...before, tiebreak: true } });
    expect(out.refused).toEqual([]);
    expect((out.config as { tiebreak?: boolean }).tiebreak).toBe(true);
  });

  // W2c BG-KO-3 (fix round 1, I3): the rung list is the chess decider, and an EMPTY list is the organiser's choice ("no
  // tie-break games": a drawn game is held). A started knockout stage whose own rules carry it - `[]` included - does not
  // inherit the division's list, so a division save that changes it lands; a stage that carries none inherits it, and the
  // save is refused. The empty list must count as "carried" (a truthiness or length test would call it inherited).
  it("BG-KO-3 a started chess knockout whose stage rules carry their own rung list - the EMPTY list too - does not inherit the division's; one that carries none does", async () => {
    const bg = resolveLatestModule("boardgame");
    expect(deciderKeysFor(bg, "knockout", "classical"), "precondition: the engine declares the rung list the chess decider").toEqual(["tiebreakRungs"]);
    let checked = 0;
    for (const own of [[], ["rapid"], ["armageddon", "blitz"]] as string[][]) {
      const r = await rigBracket("boardgame", "classical");
      await sql`update stages set config = config || ${sql.json({ rules: { tiebreakRungs: own } } as never)} where id = ${r.ko.id}`;
      await start(r.auth, r.fixtureId);
      const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
      const out = await patchDivision(r.auth, r.divisionId, { config: { ...before, tiebreakRungs: ["blitz"] } });
      expect(out.refused, `stage carries ${JSON.stringify(own)}`).toEqual([]);
      expect((out.config as { tiebreakRungs?: string[] }).tiebreakRungs).toEqual(["blitz"]);
      checked++;
    }
    const inherits = await rigBracket("boardgame", "classical");
    await start(inherits.auth, inherits.fixtureId);
    const b = (await getDivision(inherits.auth, inherits.divisionId)).config as Record<string, unknown>;
    const refused = await patchDivision(inherits.auth, inherits.divisionId, { name: "Renamed", config: { ...b, tiebreakRungs: ["blitz"] } });
    expect(refused.refused).toEqual([{ field: "tiebreakRungs", code: "DIVISION_FORMAT_LOCKED", stageId: inherits.ko.id, stageName: "Final" }]);
    expect((refused.config as { tiebreakRungs?: string[] }).tiebreakRungs, "nothing refused was written").toBeUndefined();
    expect(checked).toBe(3);
  });

  // Fix round 2, I-2. A stage PointsRule re-derives `points`, and (W2c X-PT-1 gap a) a forfeit with nothing played's
  // score, so what it exempts from the division is the keys that feed `delta.points`. `awardScore` feeds the forfeit
  // goal credit in the sport's own ledger (gf/ga/gd), which still decides every forfeit after play. The differential
  // proving that is in the no-database describe.
  it("I-2 a started football league with its OWN stage points still locks awardScore (the forfeit goal credit); the points key it replaces saves", async () => {
    const r = await rig("football", "11-a-side", "team");
    await sql`update stages set config = config || ${sql.json({ points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [] } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { awardScore: { goals: number }; points: { win: number; draw: number; loss: number } };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed",
      config: { ...before, awardScore: { goals: before.awardScore.goals + 2 }, points: { ...before.points, win: before.points.win + 1 } } as never,
    });
    expect(out.refused).toEqual([{ field: "awardScore", code: "DIVISION_TABLE_RULES_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as typeof before).awardScore.goals, "the refused key was not written").toBe(before.awardScore.goals);
    expect((out.config as typeof before).points.win, "the key the stage rule replaces was").toBe(before.points.win + 1);
  });

  // W2c gap (a): the rule's award now replaces gf/ga/gd on a forfeit with nothing played, but a forfeit AFTER play keeps
  // the sport's `goalCredit(awardScore, real)` (FB-RT-1), so the division's value still reaches this stage's table.
  it("I-2 a stage rule that carries its own forfeit award score does not take awardScore over either: a forfeit after play still reads the division's", async () => {
    const r = await rig("football", "11-a-side", "team");
    await sql`update stages set config = config || ${sql.json({ points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { awardScore: { goals: number } };
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, awardScore: { goals: before.awardScore.goals + 2 } } as never });
    expect(out.refused.map((x) => x.field)).toEqual(["awardScore"]);
  });

  // W2c Task 9 addendum: a board game's `scoring` is not only `delta.points` — the game's headline (`summary` reads
  // `cfg.scoring`), its declared points sets and its per-match bounds read it too, and a stage rule replaces none of them.
  it("I-2 a started chess league with its OWN stage points still locks `scoring` (it also writes the game's headline): a change is refused", async () => {
    const r = await rig("boardgame", "classical");
    await sql`update stages set config = config || ${sql.json({ points: { base: { win: 2, draw: 1, loss: 0 }, bonuses: [] } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { scoring: { win: number; draw: number; loss: number }; byeScore: number };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed",
      config: { ...before, scoring: { ...before.scoring, win: before.scoring.win + 1 } } as never,
    });
    expect(out.refused).toEqual([{ field: "scoring", code: "DIVISION_TABLE_RULES_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as typeof before).scoring.win, "scoring was not written").toBe(before.scoring.win);
  });

  it("I-2 …and `byeScore` (the other points key chess declares) beside it: both refused, neither written", async () => {
    const r = await rig("boardgame", "classical");
    await sql`update stages set config = config || ${sql.json({ points: { base: { win: 2, draw: 1, loss: 0 }, bonuses: [] } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { scoring: { win: number; draw: number; loss: number }; byeScore: number };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed",
      config: { ...before, scoring: { ...before.scoring, win: before.scoring.win + 1 }, byeScore: before.byeScore + 1 } as never,
    });
    expect(out.refused.map((x) => x.field).sort()).toEqual(["byeScore", "scoring"]);
    expect((out.config as typeof before).scoring.win, "scoring was not written").toBe(before.scoring.win);
    expect((out.config as typeof before).byeScore, "byeScore was not").toBe(before.byeScore);
  });

  it("I-2 the same league WITHOUT its own stage points inherits both: points and awardScore are refused", async () => {
    const r = await rig("football", "11-a-side", "team");
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as { awardScore: { goals: number }; points: { win: number; draw: number; loss: number } };
    const out = await patchDivision(r.auth, r.divisionId, {
      name: "Renamed",
      config: { ...before, awardScore: { goals: before.awardScore.goals + 2 }, points: { ...before.points, win: before.points.win + 1 } } as never,
    });
    expect(out.refused.map((x) => x.field).sort()).toEqual(["awardScore", "points"]);
  });

  // Fix round 2, M-1. A stage's `rules: { key: null }` is "inherit" (stage-cfg.ts: a null is stripped on the way in and
  // skipped on the way out), so the division's value still reaches the stage and the lock must hold.
  it("M-1 a started stage whose rules hold the key as null still inherits it: the null is not an override", async () => {
    const r = await rig("badminton", "short");
    await sql`update stages set config = config || ${sql.json({ rules: { setTo: null } } as never)} where id = ${r.s1.id}`;
    await start(r.auth, r.fixtureId);
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number };
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...before, setTo: before.setTo + 1 } });
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    // The pair: a real value there IS an override.
    const own = await rig("badminton", "short");
    await sql`update stages set config = config || ${sql.json({ rules: { setTo: 11 } } as never)} where id = ${own.s1.id}`;
    await start(own.auth, own.fixtureId);
    const b2 = (await getDivision(own.auth, own.divisionId)).config as Record<string, unknown> & { setTo: number };
    expect((await patchDivision(own.auth, own.divisionId, { config: { ...b2, setTo: b2.setTo + 1 } })).refused).toEqual([]);
  });

  // The predicate with a module the test builds, over REAL started stages: each guard witnessed alone (carrom's
  // tieBoard cannot do it: its appliesTo and its forced value cover the same kinds, so either guard hides the other).
  describe("the inherits predicate, one guard at a time (fake module, real stages)", () => {
    type Parse = (cfg: unknown) => { success: boolean; data?: unknown };
    const fakeModule = (ruleKeys: Record<string, unknown>, forced: Record<string, unknown> | ((cfg: unknown) => Record<string, unknown>) = {}, parse: Parse = (c) => ({ success: true, data: c })) =>
      ({ key: "fake", ruleKeys, configSchema: { safeParse: parse }, bracketDeciders: typeof forced === "function" ? forced : () => forced }) as unknown as AnySportModule;
    const refusalsFor = async (r: { divisionId: string }, mod: AnySportModule, keys: string[], variantKey = "x", divisionConfig: Record<string, unknown> = {}) =>
      sql.begin((tx) => divisionRefusals(tx, r.divisionId, { configKeys: keys, variant: false, tiebreakers: false }, { module: mod, variantKey, divisionConfig }));

    it("I-1 an engine `appliesTo` (stage kinds or variants) never exempts a stage from a key: only a FORCED key is not inherited", async () => {
      const r = await rigBracket("generic", "score", { league: true });
      await start(r.auth, r.fixtureId);
      await start(r.auth, r.leagueFixtureId!);
      const mod = fakeModule({
        bracketOnly: { scope: "stage", appliesTo: { stageKinds: ["knockout"] } },
        leagueOnly: { scope: "stage", appliesTo: { stageKinds: ["league"] } },
        variantY: { scope: "stage", appliesTo: { variants: ["y"] } },
        unlisted: { scope: "stage" },
      });
      // Both stages started, variant z (which variantY is not offered in): every key reaches both stages.
      const got = await refusalsFor(r, mod, ["bracketOnly", "leagueOnly", "variantY", "unlisted"], "z");
      expect(got.map((x) => `${x.field}@${x.stageName}`).sort()).toEqual(
        ["bracketOnly@Final", "leagueOnly@Final", "unlisted@Final", "variantY@Final"].sort());
      // The same keys once the knockout FORCES them: the knockout ignores them, so the refusal names the league instead.
      const forced = fakeModule(
        { bracketOnly: { scope: "stage", appliesTo: { stageKinds: ["knockout"] } }, leagueOnly: { scope: "stage", appliesTo: { stageKinds: ["league"] } } },
        { bracketOnly: true, leagueOnly: true });
      const afterForce = await refusalsFor(r, forced, ["bracketOnly", "leagueOnly"], "z");
      expect(afterForce.map((x) => `${x.field}@${x.stageName}`).sort(), "the knockout ignores a forced key whatever appliesTo says; the league does not").toEqual(["bracketOnly@Pool", "leagueOnly@Pool"]);
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

    it("M3 bracketDeciders is asked with the division config the SCHEMA parsed (defaults applied), as the fixture resolver does; a config the schema refuses is passed as stored", async () => {
      const r = await rigBracket("generic", "score");
      await start(r.auth, r.fixtureId);
      // The decider reads a field the stored config does not carry and the schema defaults in.
      const reads = (cfg: unknown) => ((cfg as { defaulted?: string }).defaulted === "yes" ? { forcedKey: true } : {});
      const withDefault: Parse = (c) => ({ success: true, data: { ...(c as object), defaulted: "yes" } });
      const refuses: Parse = () => ({ success: false });
      const keys = { forcedKey: { scope: "stage" } };
      expect(await refusalsFor(r, fakeModule(keys, reads, withDefault), ["forcedKey"], "x", {}), "parsed cfg: forced, so not inherited").toEqual([]);
      expect((await refusalsFor(r, fakeModule(keys, reads, refuses), ["forcedKey"], "x", {})).map((x) => x.field), "unparsed: the decider sees no default, so the key is inherited").toEqual(["forcedKey"]);
      expect(await refusalsFor(r, fakeModule(keys, reads, refuses), ["forcedKey"], "x", { defaulted: "yes" }), "a refused parse passes the stored config through").toEqual([]);
    });

    // W2c Task 13b (D3): the resolver reads a stage's own values from `rules` alone, so EVERY key at a stage config's top
    // level, `shootout` included (the last one the resolver read there), is inherited; the same keys under `rules` are not.
    it("X-SR-4 a stage's top-level `shootout` is read by nothing since D3 and is inherited like any other top-level decider or key; under `rules` all three are its own", async () => {
      const mod = fakeModule({ shootout: { scope: "stage", decider: true }, dec: { scope: "stage", decider: true }, plain: { scope: "stage" } });
      const r = await rigBracket("generic", "score");
      await sql`update stages set config = config || ${sql.json({ shootout: true, dec: 1, plain: 1 } as never)} where id = ${r.ko.id}`;
      await start(r.auth, r.fixtureId);
      const got = await refusalsFor(r, mod, ["shootout", "dec", "plain"]);
      expect(got.map((x) => x.field), "a decider or key at the top level is inherited (the I-1 class)").toEqual(["shootout", "dec", "plain"]);
      // The pair: the same three stored where the resolver reads them.
      const own = await rigBracket("generic", "score");
      await sql`update stages set config = config || ${sql.json({ rules: { shootout: true, dec: 1, plain: 1 } } as never)} where id = ${own.ko.id}`;
      await start(own.auth, own.fixtureId);
      expect(await refusalsFor(own, mod, ["shootout", "dec", "plain"]), "under rules: the stage's own").toEqual([]);
    });
  });
});

// lib/rule-errors.ts is the one place the W2c lock codes, their HTTP statuses and their English sentences live.
// The expected table is the plan's (spec §7), typed here once; the code under test is not consulted for it.
describe("X-SR-4 rule-errors: the W2c code table", () => {
  const SPEC: Record<RuleErrorCode, number> = {
    STAGE_FORMAT_LOCKED: 409, DIVISION_TABLE_RULES_LOCKED: 409, DIVISION_FORMAT_LOCKED: 409,
    FIXTURE_FORMAT_LOCKED: 409, FORMAT_DOES_NOT_FIT_PLAY: 409, RULE_NOT_SETTABLE: 400, POINTS_RULE_INEXPRESSIBLE: 422,
    // Task 14 (controller ruling, fix round 1): a delete that would take a match's own format with it.
    FIXTURE_HAS_OWN_FORMAT: 409,
    // Task 11 (controller ruling): a stage or division save that would leave an unstarted match's own format unable to fit.
    FIXTURE_OWN_FORMAT_NO_LONGER_FITS: 409,
    // Task 15 (X-SR-7, brief): a pad's tap sent under rules the match no longer plays.
    FIXTURE_RULES_CHANGED: 409,
  };
  it("declares exactly the ten codes, each with its status", () => {
    expect(Object.keys(SPEC).length).toBe(10);
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
    expect(ruleErrorMessage("FIXTURE_HAS_OWN_FORMAT", { match: "Match 3" })).toBe(
      "Match 3 has its own format, and this would delete it — set it back to its stage's format first.",
    );
    expect(ruleErrorMessage("FIXTURE_OWN_FORMAT_NO_LONGER_FITS", { match: "Match 3" })).toBe(
      "Match 3 has its own format that no longer fits — set it back to its stage's format first.",
    );
    expect(ruleErrorMessage("FIXTURE_RULES_CHANGED", { format: "Best of 5, 21 points" })).toBe(
      "The match's format was corrected: Best of 5, 21 points. This entry was not recorded — check the score, then record it again.",
    );
    expect(ruleErrorMessage("FIXTURE_RULES_CHANGED", {})).toBe(
      "The match's format was corrected. This entry was not recorded — check the score, then record it again.",
    );
  });
});
