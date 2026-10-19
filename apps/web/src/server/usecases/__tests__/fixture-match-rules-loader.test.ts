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
import { formatLineOf } from "@/server/engine-db/rules-version";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { loadFixtureMatchRules } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { withdrawEntrantCascade } from "../withdrawal";
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
/** The describer's line over a cfg, in a dictionary's language: the engine-side expectation for `stageLine`/`effectiveLine`
 *  (never read off the loader). The division's own config is the loader's `divisionCfg` argument. */
async function divisionConfigOf(divisionId: string): Promise<unknown> {
  const [d] = await sql<{ config: unknown }[]>`select config from divisions where id = ${divisionId}`;
  return d!.config;
}
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
    // No override: the match plays the stage's format, so the two lines are one (and the block shows neither a chip nor the line).
    expect(r.effectiveLine, "no override: the played format is the stage's").toBe(r.stageLine);
    expect(r.cancelled).toBe(false);
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

    const divisionCfg = await divisionConfigOf(b.divisionId);
    const lineOf = (cfg: unknown): string | null => formatLineOf("badminton", mod("badminton"), cfg, "league", divisionCfg, dict);

    await writeFixtureRulesOverride(b.auth, [id], { bestOf: other });
    let r = await loadFixtureMatchRules(b.auth, id, dict);
    expect(r.override).toEqual({ bestOf: other });
    expect(r.effective).toMatchObject({ bestOf: other });
    // I2: the format it plays, in words - the describer over what it plays - and NOT the stage's.
    expect(r.effectiveLine, "the describer over `effective`").toBe(lineOf(r.effective));
    expect(r.effectiveLine.length, "a line the describer has").toBeGreaterThan(0);
    expect(r.effectiveLine, "the override moved the line off the stage's").not.toBe(r.stageLine);
    expect(r.stageResolved, "the stage's own format is untouched by the match override").toMatchObject({ bestOf: stageBestOf });
    expect(r.state).toBe("unstarted");

    // A pad opened on it: the first event freezes the cfg, the match is live.
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    r = await loadFixtureMatchRules(b.auth, id, dict);
    expect(r.state).toBe("live");
    expect(r.effective, "a started match reads its frozen cfg").toMatchObject({ bestOf: other });
    expect(r.effectiveLine, "started: the describer over the frozen cfg").toBe(lineOf(r.effective));

    await sql`update fixtures set status = 'finalized' where id = ${id}`;
    r = await loadFixtureMatchRules(b.auth, id, dict);
    expect(r.state, "after finalize: locked").toBe("locked");
    // The match was PLAYED under the override: finished, it still says so (the stage's format is another line).
    expect(r.effectiveLine, "finished: the format it was played under").toBe(lineOf(r.effective));
    expect(r.effectiveLine).not.toBe(r.stageLine);
    expect(r.cancelled, "finalized is not cancelled").toBe(false);

    // Set back to the stage's: a finished match refuses the write, so reset on a sibling that is not finished.
    const second = b.fixtureIds[1];
    if (second !== undefined) {
      await writeFixtureRulesOverride(b.auth, [second], { bestOf: other });
      expect((await loadFixtureMatchRules(b.auth, second, dict)).override).toEqual({ bestOf: other });
      await writeFixtureRulesOverride(b.auth, [second], null);
      r = await loadFixtureMatchRules(b.auth, second, dict);
      expect(r.override, "reset clears the override").toBeNull();
      expect(r.effective).toMatchObject({ bestOf: stageBestOf });
      expect(r.effectiveLine, "after a reset the played format is the stage's again").toBe(r.stageLine);
    }
  });

  it("the lock is the writer's own predicate: locked exactly for the statuses the writer refuses on (counted)", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const dict = await getDictionary("en", "public");
    let locked = 0;
    let open = 0;
    let cancelled = 0;
    for (const status of FIXTURE_STATUSES) {
      await sql`update fixtures set status = ${status} where id = ${id}`;
      const loaded = await loadFixtureMatchRules(b.auth, id, dict);
      const state = loaded.state;
      expect(loaded.cancelled, `${status}: only a cancelled match says so`).toBe(status === "cancelled");
      if (status === "cancelled") cancelled++;
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
    expect(cancelled, "the cancelled status was reached, and is a locked one").toBe(1);
    expect(LOCKED_FIXTURE_STATUSES.has("cancelled")).toBe(true);
  });

  it("M4 - the stage's line and the played line are said in the reader's language, in every locale (counted)", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const divisionCfg = await divisionConfigOf(b.divisionId);
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    const en = await loadFixtureMatchRules(b.auth, id, await getDictionary("en", "public"));
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const dict = await getDictionary(locale, "public");
      const r = await loadFixtureMatchRules(b.auth, id, dict);
      // Both lines are the describer's own, in THIS locale's dictionary.
      expect(r.stageLine, `${locale} stage line`).toBe(formatLineOf("badminton", mod("badminton"), r.stageResolved, "league", divisionCfg, dict));
      expect(r.effectiveLine, `${locale} played line`).toBe(formatLineOf("badminton", mod("badminton"), r.effective, "league", divisionCfg, dict));
      if (locale !== "en") {
        expect(r.stageLine, `${locale} is not the English stage line`).not.toBe(en.stageLine);
        expect(r.effectiveLine, `${locale} is not the English played line`).not.toBe(en.effectiveLine);
      }
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a forfeit EVENT recorded (not finalized) is live - played - and the writer's own 'started' agrees", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const dict = await getDictionary("en", "public");
    expect((await loadFixtureMatchRules(b.auth, id, dict)).state, "premise: nothing recorded").toBe("unstarted");
    const [fx] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${id}`;
    await appendEvent(b.auth.orgId, id, 0, { type: "core.forfeit", payload: { by: fx!.home_entrant_id, reason: "walkover" } });
    expect((await loadFixtureMatchRules(b.auth, id, dict)).state, "a forfeit is play the format must fit: live, not unstarted").toBe("live");
    const out = await writeFixtureRulesOverride(b.auth, [id], null);
    expect(out.fixtures[0]!.started, "the writer's started").toBe(true);
  });

  it("decided WITHOUT play (no event, no frozen cfg): a scored award is live - a correction refits it - and a bye is 'decided', which the writer refuses on", async () => {
    const dict = await getDictionary("en", "public");
    // Ruling 116 through the real producers (W2b Task 16's chain): line a is played, its winner withdraws while her next tie
    // waits, line b is played, the arriving side walks over her dead seat - an award no event records.
    const k = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
    const rows = await rowsOf(k.stageId);
    const first = Math.min(...rows.map((r) => r.round_no));
    const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    const a = r1.find((x) => r1.some((y) => y.id !== x.id && y.winner_to_fixture !== null && y.winner_to_fixture === x.winner_to_fixture))!;
    const sib = r1.find((y) => y.id !== a.id && y.winner_to_fixture === a.winner_to_fixture)!;
    const parentId = a.winner_to_fixture!;
    const w1 = (await playBadminton(k.auth, a.id, true)).home_entrant_id!;
    await withdrawEntrantCascade(k.auth, w1);
    await playBadminton(k.auth, sib.id, true);
    const walkover: FixtureRow = await fixtureRow(parentId);
    const [snap] = await sql<{ config_snapshot: unknown }[]>`select config_snapshot from fixtures where id = ${parentId}`;
    const events = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${parentId}`;
    expect(events[0]!.n, "premise: no event records the walkover").toBe(0);
    expect(walkover.outcome, "premise: an outcome stands").not.toBeNull();
    expect(snap!.config_snapshot, "premise: nothing froze its cfg, so it is not 'played'").toBeNull();
    expect((await loadFixtureMatchRules(k.auth, parentId, dict)).state, "decided without play, credited a score: a correction refits it").toBe("live");
    expect((await writeFixtureRulesOverride(k.auth, [parentId], null)).fixtures[0]!.started, "the writer: started").toBe(true);

    // A bye (an odd draw): decided without play and credited no score - the writer refuses every change to it.
    const odd = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 6 });
    const byes = (await rowsOf(odd.stageId)).filter((r) => r.outcome?.reason === "bye");
    expect(byes.length, "premise: the odd draw has byes").toBeGreaterThan(0);
    for (const bye of byes) {
      expect((await loadFixtureMatchRules(odd.auth, bye.id, dict)).state, "a bye").toBe("decided");
      await expect(writeFixtureRulesOverride(odd.auth, [bye.id], { bestOf: 1 })).rejects.toMatchObject({
        code: "FIXTURE_FORMAT_LOCKED",
        extra: { reason: "decided" },
      });
    }
    // The played matches of the same draw are not byes.
    const played = (await rowsOf(odd.stageId)).filter((r) => r.outcome === null && r.home_entrant_id && r.away_entrant_id);
    expect(played.length, "premise: the odd draw also has real matches").toBeGreaterThan(0);
    expect((await loadFixtureMatchRules(odd.auth, played[0]!.id, dict)).state, "a real, unplayed match").toBe("unstarted");
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
