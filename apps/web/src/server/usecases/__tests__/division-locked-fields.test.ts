// W2c Task 20 (S4, X-SR-4 UI half) - the division page's loader of the settings form's locks (`divisionLockedFields`,
// rule-locks.ts). The form shows a locked field read-only, with its lock line, BEFORE the organiser types: the page hands it
// the same `divisionRefusals` read the save uses, asked as "if this key changed, would a save refuse it".
//
// Where each expected value comes from: the fields the form shows and the keys they edit are the SPORT_RULES table (the
// declaration the form renders), the table keys are the engine's points declaration (`tableRuleKeys`), the keys a bracket
// stage forces are the module's own `bracketDeciders`, and the save's refusals are `patchDivision`'s - the loader is checked
// against the writer it must agree with, not against itself.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { SPORT_RULES } from "@/lib/match-rules";
import type { RefusedField } from "@/lib/rule-errors";
import { BRACKET_KINDS, DRAW_KINDS, forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { pinStageTableRules } from "@/server/engine-db/table-rules";
import { divisionLockedFields, tableRuleKeys } from "../rule-locks";
import { putStageRules } from "../stage-rules";
import { addFixture, createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });

const topOf = (path: string): string => path.split(".")[0]!;
/** The config keys the settings form's fields edit for a sport: the declaration, not a typed list. */
const formKeys = (sport: string): string[] => [...new Set(SPORT_RULES[sport]!.flatMap((f) => f.edits.map(topOf)))];
const byField = (list: readonly RefusedField[]): Record<string, RefusedField> => Object.fromEntries(list.map((r) => [r.field, r]));
/** W2d Task 10 (spec §5.4 "What changes after the pin", §10): a PINNED stage pays its pin's win/draw/loss rule and
 *  set-score map, never the division's, so these two table keys stop locking; `scoring` and `awardScore` keep W2c's lock.
 *  The rulebook's list, not the module's `STAGE_POINTS_REPLACES`. */
const PIN_REPLACES: ReadonlySet<string> = new Set(["points", "pointsMap"]);

async function seedOrg(): Promise<AuthCtx> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"Lf " + s}, ${"lf-" + s}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedDivision(auth: AuthCtx, sport: string, variant: string, config: Record<string, unknown> = {}) {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Lf " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  return createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config });
}

/** A division with a league stage "Pool A" (2 entrants), generated and NOT started; `second` adds an empty "Pool B" after it. */
async function rig(sport: string, variant: string, opts: { kind?: "individual" | "team"; second?: boolean } = {}) {
  const auth = await seedOrg();
  const d = await seedDivision(auth, sport, variant);
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind: opts.kind ?? ("individual" as const), display_name: `E${i}`, seed: i, members: [] })));
  const [s1] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
  const s2 = opts.second ? (await createStages(auth, d.id, { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null }))[0]! : undefined;
  await generateStageFixtures(auth, s1!.id);
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s1!.id} order by id limit 1`;
  return { auth, divisionId: d.id, s1: s1!, s2, fixtureId: f!.id };
}
const start = (auth: AuthCtx, fixtureId: string) => appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });

/** A division with ONE stage of `kind` that has started: the thinnest row the lock's started predicate reads (a frozen
 *  config snapshot) - only the lock is under test, so any sport and kind can be had without a lineup. */
async function startedStageOfKind(sport: string, variant: string, kind: StageKind, config: Record<string, unknown> = {}) {
  const auth = await seedOrg();
  const d = await seedDivision(auth, sport, variant, config);
  const [stage] = await createStages(auth, d.id, { seq: 1, kind, name: `K-${kind}`, config: kind === "swiss" ? { rounds: 3 } : {}, progression: null });
  await sql`insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, fixture_no, config_snapshot)
            values (${stage!.id}, ${d.id}, ${auth.orgId}, 1, 1, 1, ${sql.json({} as never)})`;
  return { auth, divisionId: d.id, stage: stage! };
}

describe.skipIf(!HAS_DB)("W2c T20 the settings form's locks, loaded from the same read the save uses", () => {
  it("the empty case: a division with no stage at all locks nothing", async () => {
    const auth = await seedOrg();
    const d = await seedDivision(auth, "badminton", "short");
    expect(await divisionLockedFields(auth, d.id)).toEqual([]);
  });

  it("generated but NOT started is open (the over-lock the old 'any fixture exists' predicate made), and the same division locks once its stage starts", async () => {
    const r = await rig("badminton", "short");
    const fixtures = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${r.s1.id}`;
    expect(fixtures[0]!.n, "premise: the division HAS fixtures").toBeGreaterThan(0);
    expect(await divisionLockedFields(r.auth, r.divisionId), "fixtures exist, no stage started: nothing is locked").toEqual([]);

    await start(r.auth, r.fixtureId);
    const after = await divisionLockedFields(r.auth, r.divisionId);
    expect(after.length, "the same division, once Pool A started").toBeGreaterThan(0);
    expect(after.every((x) => x.stageId === r.s1.id && x.stageName === "Pool A"), "every lock names the started stage").toBe(true);
  });

  it("a started league stage that inherits everything, PINNED (W2d T10): the variant and every format field locked, each with its own code; the cascade and the points the pin replaces open; the table keys it does not replace still locked", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const [row] = await sql<{ pinned: boolean }[]>`select table_rules_pinned is not null as pinned from stages where id = ${r.s1.id}`;
    expect(row!.pinned, "premise: the generate pinned Pool A").toBe(true);
    const locks = byField(await divisionLockedFields(r.auth, r.divisionId));
    const mod = resolveLatestModule("badminton");
    const table = tableRuleKeys(mod, "short");

    expect(locks.variant_key).toMatchObject({ code: "DIVISION_FORMAT_LOCKED", stageName: "Pool A" });
    // Spec §5.4, §11 item 4: a started stage ranks by its pin's order, so the division's order carries no lock line.
    expect(locks.tiebreakers, "the cascade is never locked").toBeUndefined();
    const keys = formKeys("badminton");
    expect(keys.length, "badminton's form edits several keys").toBeGreaterThanOrEqual(5);
    for (const k of keys) {
      if (PIN_REPLACES.has(k)) expect(locks[k], `${k}: the pin pays its own`).toBeUndefined();
      else expect(locks[k], `${k} is locked`).toMatchObject({ code: table.has(k) ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" });
    }
    // The table rules the form has no box for are judged too (the response and the API speak them).
    let replaced = 0;
    for (const k of table) {
      if (PIN_REPLACES.has(k)) { expect(locks[k], `${k} (a table rule the pin replaces)`).toBeUndefined(); replaced++; }
      else expect(locks[k]?.code, `${k} (a table rule the pin does not replace)`).toBe("DIVISION_TABLE_RULES_LOCKED");
    }
    expect(table.size, "badminton declares a table rule").toBeGreaterThan(0);
    expect(replaced, "anti-vacuity: badminton's pointsMap is a key the pin replaces").toBeGreaterThan(0);
  });

  it("W2d T10 fix round 1 (I1): a league started AD HOC (a loose match played before any generate: pending, no pin) shows the keys a pin replaces open — the save pins it first — and the format locked", async () => {
    const auth = await seedOrg();
    const d = await seedDivision(auth, "badminton", "short");
    const [e1, e2] = await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind: "individual" as const, display_name: `E${i}`, seed: i, members: [] })));
    const [s1] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
    const { fixture_id } = await addFixture(auth, s1!.id, { home_entrant_id: e1!.id, away_entrant_id: e2!.id });
    await startDivision(auth, d.id);
    await start(auth, fixture_id);
    const [row] = await sql<{ status: string; pinned: boolean }[]>`select status, table_rules_pinned is not null as pinned from stages where id = ${s1!.id}`;
    expect(row, "premise: started ad hoc, pending, no pin").toEqual({ status: "pending", pinned: false });
    const locks = byField(await divisionLockedFields(auth, d.id));
    const table = tableRuleKeys(resolveLatestModule("badminton"), "short");
    expect(locks.variant_key, "premise: the stage has started").toMatchObject({ code: "DIVISION_FORMAT_LOCKED", stageName: "Pool A" });
    expect(locks.tiebreakers, "the cascade is never locked").toBeUndefined();
    let open = 0;
    for (const k of table) {
      if (PIN_REPLACES.has(k)) { expect(locks[k], `${k}: the save pins the stage first`).toBeUndefined(); open++; }
      else expect(locks[k]?.code, `${k} (a table rule no pin replaces)`).toBe("DIVISION_TABLE_RULES_LOCKED");
    }
    expect(open, "anti-vacuity: badminton's pointsMap is judged").toBeGreaterThan(0);
  });

  it("a pre-W2d row (active, no pin: the post-deploy pin's input, which no product path writes, so it is shaped by hand) keeps every table rule locked; the cascade still carries no lock", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${r.s1.id}`;
    const [row] = await sql<{ status: string }[]>`select status from stages where id = ${r.s1.id}`;
    expect(row!.status, "premise: the legacy shape is an ACTIVE stage").toBe("active");
    const locks = byField(await divisionLockedFields(r.auth, r.divisionId));
    const table = tableRuleKeys(resolveLatestModule("badminton"), "short");
    expect(locks.tiebreakers, "the cascade is never locked").toBeUndefined();
    for (const k of table) expect(locks[k], `${k} (a table rule, pre-W2d row)`).toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED", stageName: "Pool A" });
    expect([...table].filter((k) => PIN_REPLACES.has(k)).length, "anti-vacuity: a key the pin would replace is judged").toBeGreaterThan(0);
  });

  it("a started stage that sets a key itself leaves THAT key open: cap is open, setTo is locked - and the save agrees field by field", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { cap: 15 } });
    await start(r.auth, r.fixtureId);
    const locks = byField(await divisionLockedFields(r.auth, r.divisionId));
    expect(locks.cap, "Pool A sets cap itself").toBeUndefined();
    expect(locks.setTo, "and inherits setTo").toMatchObject({ code: "DIVISION_FORMAT_LOCKED", stageName: "Pool A" });

    // The writer it must agree with: one patch changing both keys. cap lands, setTo is refused, by the stage the loader named.
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number; cap: number };
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...before, setTo: before.setTo + 2, cap: before.cap + 4 } });
    expect(out.refused).toEqual([locks.setTo]);
    expect((out.config as { cap: number }).cap, "the key the loader called open landed").toBe(before.cap + 4);
    expect((out.config as { setTo: number }).setTo, "the key it called locked did not").toBe(before.setTo);
  });

  it("every key the loader locks is refused by a save that changes it, and the stage a save names is the stage the loader named (badminton, each form field)", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const locks = byField(await divisionLockedFields(r.auth, r.divisionId));
    const stored = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown>;
    // One legal change per field (the schema's own bounds are the form's: setTo 11..30, cap 15..35 and >= setTo, winBy 1 or 2).
    const change: Record<string, unknown> = { bestOf: 5, setTo: 13, finalSetTo: 13, cap: 20, winBy: 1 };
    let judged = 0;
    for (const f of SPORT_RULES.badminton!) {
      const key = f.edits[0]!;
      expect(change, `the test names a change for ${key}`).toHaveProperty(key);
      expect(stored[key], `${key}: the change differs from what is stored`).not.toEqual(change[key]);
      const out = await patchDivision(r.auth, r.divisionId, { name: `N-${key}`, config: { ...stored, [key]: change[key] } });
      expect(out.refused, `a save changing ${key}`).toEqual([locks[key]]);
      expect(out.name, "the name beside it landed").toBe(`N-${key}`);
      judged++;
    }
    expect(judged, "every badminton form field was judged").toBe(SPORT_RULES.badminton!.length);
  });

  it("the sequence: a first stage that has started names itself; a second stage starting later does not take its place", async () => {
    const r = await rig("badminton", "short", { second: true });
    expect(await divisionLockedFields(r.auth, r.divisionId), "nothing started").toEqual([]);
    await generateStageFixtures(r.auth, r.s2!.id);
    const [f2] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.s2!.id} order by id limit 1`;
    await start(r.auth, f2!.id); // Pool B starts first
    const first = byField(await divisionLockedFields(r.auth, r.divisionId));
    expect(first.setTo?.stageName, "Pool B is the only stage started").toBe("Pool B");
    await start(r.auth, r.fixtureId); // then Pool A
    const both = byField(await divisionLockedFields(r.auth, r.divisionId));
    expect(both.setTo?.stageName, "the first started stage by seq names the lock").toBe("Pool A");
  });

  it("another organisation's session reads nothing: a division it does not own has no locks to show", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    expect((await divisionLockedFields(r.auth, r.divisionId)).length, "premise: the owner sees locks").toBeGreaterThan(0);
    const stranger = await seedOrg();
    expect(await divisionLockedFields(stranger, r.divisionId)).toEqual([]);
    expect(await divisionLockedFields(r.auth, randomUUID()), "and an unknown id").toEqual([]);
  });

  it("every sport, a started league: the variant and every field the form shows are locked by the engine's own table/format split, except the keys a pin replaces — open on a league started pending (the save pins it first) and once pinned, locked on a pre-W2d row (W2d T10)", async () => {
    let sports = 0;
    let judged = 0;
    let tableJudged = 0;
    let tableWithoutBox = 0;
    let pinnedJudged = 0;
    let pinnedOpen = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const g = await startedStageOfKind(m.key, variant, "league");
      const locks = byField(await divisionLockedFields(g.auth, g.divisionId));
      const table = tableRuleKeys(m, variant);
      expect(locks.variant_key, `${m.key}: variant`).toMatchObject({ code: "DIVISION_FORMAT_LOCKED", stageName: g.stage.name });
      // W2d T10 (spec §5.4): the standings cascade carries no lock line for any sport, pinned or not.
      expect(locks.tiebreakers, `${m.key}: the cascade is never locked`).toBeUndefined();
      const keys = formKeys(m.key);
      expect(keys.length, `${m.key}: the form edits at least one key`).toBeGreaterThan(0);
      // The stage above started PENDING (its first frozen fixture, no generate: what an ad-hoc match leaves), so a save that
      // moves its points pins it first (fix round 1, I1): the keys a pin replaces are open, every other key is locked.
      const want = (k: string) => (PIN_REPLACES.has(k) ? undefined : table.has(k) ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED");
      for (const k of keys) {
        expect(locks[k]?.code, `${m.key}.${k}`).toBe(want(k));
        judged++;
      }
      // The table keys the form has no box for (an API client sends them) are named too, for every sport: on a pre-W2d row
      // (active, no pin: the post-deploy pin's input, shaped by hand) the save refuses every one of them, `pointsMap` too.
      await sql`update stages set status = 'active' where id = ${g.stage.id}`;
      const legacy = byField(await divisionLockedFields(g.auth, g.divisionId));
      for (const k of table) {
        expect(locks[k]?.code, `${m.key}.${k} (started pending)`).toBe(want(k));
        expect(legacy[k]?.code, `${m.key}.${k} (a table rule on a pre-W2d row, with or without a form box)`).toBe("DIVISION_TABLE_RULES_LOCKED");
        tableJudged++;
        if (!keys.includes(k)) tableWithoutBox++;
      }
      // Pinned, as every started stage is after the post-deploy pin, it pays its pin's points: those keys open again.
      await pinStageTableRules(sql, g.stage.id);
      const pinned = byField(await divisionLockedFields(g.auth, g.divisionId));
      expect(pinned.variant_key, `${m.key}: variant (pinned)`).toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
      expect(pinned.tiebreakers, `${m.key}: the cascade (pinned)`).toBeUndefined();
      for (const k of new Set([...keys, ...table])) {
        const want = PIN_REPLACES.has(k) ? undefined : table.has(k) ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED";
        expect(pinned[k]?.code, `${m.key}.${k} (pinned)`).toBe(want);
        pinnedJudged++;
        if (want === undefined) pinnedOpen++;
      }
      sports++;
    }
    expect(pinnedJudged, "anti-vacuity: the pinned arm judged every sport's keys").toBeGreaterThan(builtinModules.length * 2);
    expect(pinnedOpen, "anti-vacuity: every sport's pointsMap opens once pinned").toBeGreaterThanOrEqual(builtinModules.length);
    expect(sports, "the whole registry").toBe(builtinModules.length);
    expect(judged, "the sweep judged the sports' fields").toBeGreaterThan(builtinModules.length * 2);
    expect(tableJudged, "the sweep judged every sport's table keys").toBeGreaterThanOrEqual(builtinModules.length);
    expect(tableWithoutBox, "some sport's table key has no form box (football's pointsMap): the API-only keys are judged").toBeGreaterThan(0);
  });

  it("a division whose OWN config makes the bracket force a key (generic, abandonPolicy share): open on a started knockout, locked on a started league", async () => {
    const generic = builtinModules.find((m) => m.key === "generic")!;
    const variant = Object.keys(generic.variants)[0]!;
    const shared = { resultMode: "score", allowDraws: true, abandonPolicy: "share" };
    // The premise is the engine's own declaration: the key is forced by THIS config and by no other.
    expect(Object.keys(generic.bracketDeciders(generic.configSchema.parse(shared) as never)), "premise: share forces abandonPolicy on a bracket").toContain("abandonPolicy");
    expect(Object.keys(generic.bracketDeciders(generic.configSchema.parse({ resultMode: "score", allowDraws: true }) as never)), "premise: the default forces nothing").not.toContain("abandonPolicy");

    const ko = await startedStageOfKind("generic", variant, "knockout", shared);
    expect((await getDivision(ko.auth, ko.divisionId)).config, "premise: the division stored the config").toMatchObject(shared);
    expect(byField(await divisionLockedFields(ko.auth, ko.divisionId)).abandonPolicy, "a knockout plays the forced value, never the division's").toBeUndefined();

    const defaults = await startedStageOfKind("generic", variant, "knockout", { resultMode: "score", allowDraws: true });
    expect(byField(await divisionLockedFields(defaults.auth, defaults.divisionId)).abandonPolicy, "the default config forces nothing: the knockout inherits it").toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });

    const league = await startedStageOfKind("generic", variant, "league", shared);
    expect(byField(await divisionLockedFields(league.auth, league.divisionId)).abandonPolicy, "a league reads the division's value whatever a bracket forces").toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
  });

  it("every sport, a started KNOCKOUT: no table to protect (no cascade, no table key), the match format locked except what the stage forces or sets itself (its preset)", async () => {
    let sports = 0;
    let formatLocked = 0;
    let forcedOpen = 0;
    let presetOpen = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      expect(BRACKET_KINDS.has("knockout") && !DRAW_KINDS.has("knockout"), "premise: a knockout has no table").toBe(true);
      const g = await startedStageOfKind(m.key, variant, "knockout");
      const locks = byField(await divisionLockedFields(g.auth, g.divisionId));
      const table = tableRuleKeys(m, variant);
      const forced = new Set(Object.keys(m.bracketDeciders(m.configSchema.parse(m.variants[variant]) as never)));
      // A knockout stage is created with its sport's preset in its own `rules` (a shoot-out, an extra time): it plays its own
      // value, never the division's, so that key is open. The preset is the engine's declaration (`stageDefaultsFor`).
      const preset = new Set(Object.keys(stageDefaultsFor(m, "knockout", variant)));
      expect(forbidsLevelResult("knockout"), "premise: a knockout forces its deciders").toBe(true);
      expect(locks.tiebreakers, `${m.key}: a knockout ranks no table (and W2d locks no cascade anywhere)`).toBeUndefined();
      expect(locks.variant_key, `${m.key}: the variant still locks`).toMatchObject({ stageName: g.stage.name });
      for (const k of formKeys(m.key)) {
        if (table.has(k)) expect(locks[k], `${m.key}.${k}: a table rule on a knockout`).toBeUndefined();
        else if (forced.has(k)) { expect(locks[k], `${m.key}.${k}: forced by the bracket`).toBeUndefined(); forcedOpen++; }
        else if (preset.has(k)) { expect(locks[k], `${m.key}.${k}: the knockout's own preset`).toBeUndefined(); presetOpen++; }
        else { expect(locks[k]?.code, `${m.key}.${k}`).toBe("DIVISION_FORMAT_LOCKED"); formatLocked++; }
      }
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(formatLocked, "format keys were judged locked").toBeGreaterThan(builtinModules.length);
    expect(forcedOpen, "at least one sport forces a key on its bracket stage (carrom's tie board)").toBeGreaterThan(0);
    expect(presetOpen, "at least one sport seeds a knockout with its own deciders").toBeGreaterThan(0);
  });
});
