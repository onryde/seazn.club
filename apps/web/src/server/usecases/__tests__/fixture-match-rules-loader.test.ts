// W2c Task 19 (S2, X-SR-2, X-SR-3, X-SR-5) - `loadFixtureMatchRules`: what the fixture console's "Match rules" block reads.
//
// Expected values come from the engine's own declarations (`variants`, `configSchema`, `ruleKeys`/`fixtureKeysFor`),
// from the rulebook's lock set (`LOCKED_FIXTURE_STATUSES`, the set the writer itself refuses on) and from the
// writer's own results - never from the loader. Real Postgres (`describe.skipIf(!HAS_DB)`); every case seeds its own
// division through the usecases.
import { afterAll, describe, expect, it } from "vitest";
import { fixtureKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { getDictionary } from "@/lib/i18n";
import { matchFieldsFor } from "@/lib/rule-scope";
import { appendEvent } from "@/server/engine-db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { loadFixtureMatchRules } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const parsedVariant = (key: string, variant: string): Record<string, unknown> =>
  mod(key).configSchema.parse(mod(key).variants[variant]) as Record<string, unknown>;

describe.skipIf(!HAS_DB)("loadFixtureMatchRules", () => {
  it("unstarted with no override: state unstarted, override null, effective = the stage's parsed format, the fields are the match fields", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const dict = await getDictionary("en", "public");
    const r = await loadFixtureMatchRules(b.auth, b.fixtureIds[0]!, dict);
    expect(r.state).toBe("unstarted");
    expect(r.override).toBeNull();
    expect(r.sportKey).toBe("badminton");
    expect(r.stageKind).toBe("league");
    // The effective format IS the variant's own, parsed by the sport's schema (the stage here carries no rules of its own).
    expect(r.effective).toMatchObject(parsedVariant("badminton", "short"));
    expect(r.stageResolved).toEqual(r.effective);
    const want = matchFieldsFor({ module: mod("badminton"), stageKind: "league", variant: "short" });
    expect(want.length, "badminton has match fields").toBeGreaterThan(0);
    expect(r.fields.map((f) => f.key)).toEqual(want.map((f) => f.key));
    expect(r.stageLine.length, "the stage's format is said in words").toBeGreaterThan(0);
  });

  it("override -> started -> finalized -> reset: effective follows the override, state follows the ledger and the lock", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const dict = await getDictionary("en", "public");
    const stageBestOf = parsedVariant("badminton", "short").bestOf as number;
    // A best-of the stage does NOT play, from the sport's own declared options for the field (never a typed literal).
    const bestOfField = matchFieldsFor({ module: mod("badminton"), stageKind: "league", variant: "short" }).find((f) => f.key === "bestOf")!;
    const other = Number(bestOfField.options!.map((o) => o.value).find((v) => Number(v) !== stageBestOf));
    expect(other, "the sport offers a best-of the stage does not play").not.toBe(stageBestOf);

    await writeFixtureRulesOverride(b.auth, [id], { bestOf: other });
    let r = await loadFixtureMatchRules(b.auth, id, dict);
    expect(r.override).toEqual({ bestOf: other });
    expect(r.effective).toMatchObject({ bestOf: other });
    expect(r.stageResolved, "the stage's own format is untouched by the match override").toMatchObject({ bestOf: stageBestOf });
    expect(r.state).toBe("unstarted");

    // A pad opened on it: the first event freezes the cfg, the match is live.
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    r = await loadFixtureMatchRules(b.auth, id, dict);
    expect(r.state).toBe("live");
    expect(r.effective, "a started match reads its frozen cfg").toMatchObject({ bestOf: other });

    await sql`update fixtures set status = 'finalized' where id = ${id}`;
    expect((await loadFixtureMatchRules(b.auth, id, dict)).state, "after finalize: locked").toBe("locked");

    // Set back to the stage's: a finished match refuses the write, so reset on a sibling that is not finished.
    const second = b.fixtureIds[1];
    if (second !== undefined) {
      await writeFixtureRulesOverride(b.auth, [second], { bestOf: other });
      expect((await loadFixtureMatchRules(b.auth, second, dict)).override).toEqual({ bestOf: other });
      await writeFixtureRulesOverride(b.auth, [second], null);
      r = await loadFixtureMatchRules(b.auth, second, dict);
      expect(r.override, "reset clears the override").toBeNull();
      expect(r.effective).toMatchObject({ bestOf: stageBestOf });
    }
  });

  it("the lock is the writer's own predicate: locked exactly for the statuses the writer refuses on (counted)", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const dict = await getDictionary("en", "public");
    let locked = 0;
    let open = 0;
    for (const status of FIXTURE_STATUSES) {
      await sql`update fixtures set status = ${status} where id = ${id}`;
      const state = (await loadFixtureMatchRules(b.auth, id, dict)).state;
      if (LOCKED_FIXTURE_STATUSES.has(status)) {
        expect(state, status).toBe("locked");
        locked++;
      } else {
        expect(state, status).not.toBe("locked");
        open++;
      }
      // And the writer agrees: it refuses a locked status 409, and accepts the rest (a no-op write here).
      const write = writeFixtureRulesOverride(b.auth, [id], null);
      if (LOCKED_FIXTURE_STATUSES.has(status)) await expect(write, `writer on ${status}`).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED" });
      else await expect(write, `writer on ${status}`).resolves.toBeDefined();
    }
    expect(locked).toBe(LOCKED_FIXTURE_STATUSES.size);
    expect(locked + open).toBe(FIXTURE_STATUSES.length);
    expect(open, "some statuses are not locked").toBeGreaterThan(0);
  });

  it("a walkover recorded but not finalized is live (decided without play) - the writer's own 'started' agrees", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const dict = await getDictionary("en", "public");
    expect((await loadFixtureMatchRules(b.auth, id, dict)).state, "premise: nothing recorded").toBe("unstarted");
    const [fx] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${id}`;
    await appendEvent(b.auth.orgId, id, 0, { type: "core.forfeit", payload: { by: fx!.home_entrant_id, reason: "walkover" } });
    const state = (await loadFixtureMatchRules(b.auth, id, dict)).state;
    expect(state, "a forfeit is play the format must fit: live, not unstarted").toBe("live");
    // The writer reports the same fact: the write is a live correction (`started`).
    const out = await writeFixtureRulesOverride(b.auth, [id], null);
    expect(out.fixtures[0]!.started, "the writer's started").toBe(true);
  });

  it("another sport (football knockout): the fields are the match keys only - no stage-only decider", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2 });
    const dict = await getDictionary("en", "public");
    const r = await loadFixtureMatchRules(b.auth, b.fixtureIds[0]!, dict);
    const edited = r.fields.flatMap((f) => f.edits);
    const m = mod("football");
    const matchKeys = new Set(fixtureKeysFor(m, "knockout", "11-a-side"));
    const stageOnly = stageKeysFor(m, "knockout", "11-a-side").filter((k) => !matchKeys.has(k));
    expect(stageOnly.length, "football declares stage-only keys, so the absence below is a real claim").toBeGreaterThan(0);
    for (const k of stageOnly) expect(edited, k).not.toContain(k);
    expect(edited.length).toBeGreaterThan(0);
    for (const k of edited) expect(matchKeys.has(k), `${k} is a match key`).toBe(true);
    // The knockout's preset extra time is the stage's own: the effective cfg carries it.
    expect(r.stageResolved.extraTime, "the knockout stage plays its preset extra time").toMatchObject({ enabled: true });
  });

  it("a sport with no match fields (generic) answers an empty field list, not a crash", async () => {
    const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    const dict = await getDictionary("en", "public");
    const r = await loadFixtureMatchRules(b.auth, b.fixtureIds[0]!, dict);
    expect(matchFieldsFor({ module: mod("generic"), stageKind: "league", variant: "score" })).toEqual([]);
    expect(r.fields).toEqual([]);
    expect(r.state).toBe("unstarted");
  });

  it("a fixture of another organisation is a 404, never its rules", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const { auth: other } = await seedOrg();
    const dict = await getDictionary("en", "public");
    await expect(loadFixtureMatchRules(other, b.fixtureIds[0]!, dict)).rejects.toMatchObject({ status: 404 });
    await expect(loadFixtureMatchRules(b.auth, "00000000-0000-0000-0000-000000000000", dict)).rejects.toMatchObject({ status: 404 });
  });
});
