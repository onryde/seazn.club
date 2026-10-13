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
import type { AuthCtx } from "@/server/api-v1/auth";
import { ENGINE_HTTP } from "@/server/api-v1/http";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
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
async function rig(sport: string, variant: string) {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind: "individual" as const, display_name: `E${i}`, seed: i, members: [] })));
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
