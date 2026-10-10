// W2b Task 7 (plan D18; X-AB-2; spec §13 premise 9). Auto-advance fires when every fixture of the stage is FINISHED:
// decided, forfeited, finalized — and an abandon that gave a result is decided (ST-G1). The open count used to treat
// `finalized` as unfinished, so a stage whose organiser finalized as they went never advanced. A group (league) stage
// feeds a knockout of its top two, auto_progress on. Real Postgres.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { finalizeFixture, scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// single-sport: cricket — the one sport whose abandon gives a points-bearing result in a table (CK-AB-2), and whose
// default tie-break cascade ends on seed, so a table with a double walkover still ranks without drawing lots.
const SPORT = "cricket";
const VARIANT = "t20";
const cricket = builtinModules.find((m) => m.key === SPORT)!;
const CFG = cricket.configSchema.parse(cricket.variants[VARIANT]) as { ballsPerInnings: number };

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);

/** A full T20 match: the side batting first makes 150, the chase falls short in its full quota. */
async function play(auth: AuthCtx, id: string) {
  await post(auth, id, "core.start");
  await post(auth, id, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: CFG.ballsPerInnings });
  const out = await post(auth, id, "cricket.innings.summary", { runs: 100, wickets: 6, legalBalls: CFG.ballsPerInnings });
  expect(out.status, "rig: a played match is decided").toBe("decided");
}

async function rig(sportKey: string = SPORT, variantKey: string = VARIANT) {
  const mod = builtinModules.find((m) => m.key === sportKey)!;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"AA " + suffix}, ${"aa-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "AA " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: sportKey,
    variant_key: variantKey,
    config: mod.variants[variantKey] as Record<string, unknown>,
  });
  const kind = mod.entrantModel?.defaultKind ?? "individual";
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((n, i) => ({ kind, display_name: n, seed: i + 1, members: [] })),
  );
  await patchDivision(auth, division.id, { auto_progress: true });
  const [group, ko] = await createStages(auth, division.id, [
    { seq: 1, kind: "league", name: "Group", config: {} },
    {
      seq: 2,
      kind: "knockout",
      name: "Final",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
    },
  ]);
  const { fixtures } = await generateStageFixtures(auth, group!.id);
  await startDivision(auth, division.id);
  expect(fixtures.length, "rig: a four-entrant group has six fixtures").toBe(6);
  return {
    auth,
    divisionId: division.id,
    groupId: group!.id,
    koId: ko!.id,
    fixtures: fixtures.map((f) => f.id),
    sides: fixtures.map((f) => [f.home_entrant_id, f.away_entrant_id] as const),
  };
}

/** Every fixture but the last is played and FINALIZED as the organiser goes; the last is `last`. */
async function finishGroup(auth: AuthCtx, fixtures: readonly string[], last: (id: string) => Promise<void>) {
  for (const id of fixtures.slice(0, -1)) {
    await play(auth, id);
    await finalizeFixture(auth, id, await tip(id));
  }
  await last(fixtures[fixtures.length - 1]!);
}

async function advanced(r: Awaited<ReturnType<typeof rig>>) {
  const [ko] = await sql<{ n: number; seated: number }[]>`
    select count(*)::int as n,
           count(*) filter (where home_entrant_id is not null and away_entrant_id is not null)::int as seated
      from fixtures where stage_id = ${r.koId}`;
  const [ev] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'stage_auto_advanced'`;
  const [st] = await sql<{ s: string[] }[]>`select array_agg(distinct status order by status) as s from fixtures where stage_id = ${r.groupId}`;
  return { koFixtures: ko!.n, koSeated: ko!.seated, autoAdvanced: ev!.n, group: st!.s };
}

describe.skipIf(!HAS_DB)("D18 / X-AB-2: auto-advance fires when every group fixture is finished", () => {
  it("every group fixture finalized → the knockout is seeded", async () => {
    const r = await rig();
    await finishGroup(r.auth, r.fixtures, async (id) => {
      await play(r.auth, id);
      await finalizeFixture(r.auth, id, await tip(id));
    });
    expect(await advanced(r)).toEqual({ koFixtures: 1, koSeated: 1, autoAdvanced: 1, group: ["finalized"] });
  }, 120_000);

  it("the same with one fixture an abandon-with-result (decided, CK-AB-2) → seeded", async () => {
    const r = await rig();
    await finishGroup(r.auth, r.fixtures, async (id) => {
      await post(r.auth, id, "core.start");
      const out = await post(r.auth, id, "core.abandon", { reason: "rain" });
      expect([out.status, (out.outcome as { kind: string }).kind], "rig: a rain no-result").toEqual(["decided", "no_result"]);
    });
    expect(await advanced(r)).toEqual({ koFixtures: 1, koSeated: 1, autoAdvanced: 1, group: ["decided", "finalized"] });
  }, 120_000);

  it("the same with one double walkover (forfeited) → seeded", async () => {
    const r = await rig();
    await finishGroup(r.auth, r.fixtures, async (id) => {
      const out = await post(r.auth, id, "core.forfeit", { by: "both", reason: "walkover" });
      expect(out.status, "rig: a double walkover").toBe("forfeited");
    });
    expect(await advanced(r)).toEqual({ koFixtures: 1, koSeated: 1, autoAdvanced: 1, group: ["finalized", "forfeited"] });
  }, 120_000);

  it("the same with one fixture CANCELLED (D18's fourth finished status) → seeded", async () => {
    // No product write sets `cancelled` today (dead-feeder-cascade.test.ts's own note: every production reference
    // READS it), so the rig writes the status the way a staff fix would. Cancelled FIRST, so the last write is a finalize
    // that runs the auto-advance check with the cancelled fixture already in the count.
    const r = await rig();
    const [gone, ...rest] = r.fixtures;
    await sql`update fixtures set status = 'cancelled' where id = ${gone!}`;
    for (const id of rest) {
      await play(r.auth, id);
      await finalizeFixture(r.auth, id, await tip(id));
    }
    expect(await advanced(r)).toEqual({ koFixtures: 1, koSeated: 1, autoAdvanced: 1, group: ["cancelled", "finalized"] });
  }, 120_000);

  it("the negative pair: one fixture in_play → not seeded", async () => {
    const r = await rig();
    // The in-play fixture is started first; the rest finish (and finalize) after it, so the LAST write is a finalize
    // that runs the auto-advance check with one fixture still open.
    const [open, ...rest] = r.fixtures;
    await post(r.auth, open!, "core.start");
    for (const id of rest) {
      await play(r.auth, id);
      await finalizeFixture(r.auth, id, await tip(id));
    }
    expect(await advanced(r)).toEqual({ koFixtures: 0, koSeated: 0, autoAdvanced: 0, group: ["finalized", "in_play"] });
  }, 120_000);
});

// Owner ruling 105 (2026-10-10, loop-F M-10): a withdrawal's EXPUNGE leaves its group fixtures `abandoned` with an
// active `core.abandon{expunge: true}` (D5). Nothing is owed on them — the matches left the table — so they count as
// closed; a plain recorded abandon still holds the stage (W2a). single-sport: badminton — its abandon folds to no
// outcome, so a plain abandon STAYS `abandoned` (cricket's would decide a no-result, CK-AB-2, and could not be the
// negative pair).
describe.skipIf(!HAS_DB)("M-10: an expunged group fixture is closed for auto-advance; a plain abandon is not", () => {
  const BADMINTON = "badminton";
  const BWF = "bwf";
  async function playBadminton(auth: AuthCtx, id: string, homeWins = true) {
    await post(auth, id, "core.start");
    for (let g = 0; g < 2; g++) await post(auth, id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
    const [r] = await sql<{ status: string }[]>`select status from fixtures where id = ${id}`;
    expect(r!.status, "rig: a played match is decided").toBe("decided");
  }
  /** The fixtures of the group that do NOT involve `entrant`. */
  const without = (r: Awaited<ReturnType<typeof rig>>, entrant: string) =>
    r.fixtures.filter((_, i) => !r.sides[i]!.includes(entrant));

  it("an under-50% withdrawal expunges her group fixtures; once the rest decide, the stage auto-advances", async () => {
    const r = await rig(BADMINTON, BWF);
    const leaver = r.sides[0]![0]!;
    const out = await withdrawEntrantCascade(r.auth, leaver);
    expect([out.policy, out.voided], "rig: nothing played, so every one of her three fixtures is expunged").toEqual(["expunge", 3]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures f
       where f.stage_id = ${r.groupId} and f.status = 'abandoned'
         and exists (select 1 from score_events a where a.fixture_id = f.id and a.type = 'core.abandon' and a.payload ->> 'expunge' = 'true')`;
    expect(n, "rig: three abandoned fixtures, each with its expunge abandon").toBe(3);
    const rest = without(r, leaver);
    expect(rest, "the three fixtures among the others").toHaveLength(3);
    // Loop-F tidy: a LADDER among the three who stayed — X beats both, Y beats Z, Z loses both — so Z, who played every
    // match, has no point either. "Excluded" and "ranked last" then differ: ranked, the leaver (nothing played) would
    // sit beside Z; the take (ranks 1-2) is X and Y either way, so the seats alone cannot tell them apart.
    const stayed = [...new Set(rest.flatMap((id) => [...r.sides[r.fixtures.indexOf(id)]!]))].filter((id): id is string => id !== null).sort();
    expect(stayed, "rig: three entrants stayed").toHaveLength(3);
    const [x, y, z] = stayed as [string, string, string];
    const beats = (w: string, l: string) => (w === x) || (w === y && l === z);
    for (const id of rest) {
      const [home, away] = r.sides[r.fixtures.indexOf(id)]!;
      await playBadminton(r.auth, id, beats(home!, away!));
    }
    expect(await advanced(r)).toEqual({ koFixtures: 1, koSeated: 1, autoAdvanced: 1, group: ["abandoned", "decided"] });
    const [ko] = await sql<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${r.koId}`;
    const seated = [ko!.home, ko!.away];
    expect(seated, "the leaver does not advance").not.toContain(leaver);
    expect([...seated].sort(), "the two who won a match advance").toEqual([x, y].sort());
    // D5: her expunged lines leave the table for EVERYONE — each of the three who stayed counts two matches, not three,
    // and her own row (the snapshot keeps a departed entrant's row) counts none.
    const rows = (await getStandings(r.auth, r.groupId)).rows as { entrantId: string; played: number }[];
    const played = Object.fromEntries(rows.map((q) => [q.entrantId, q.played]));
    expect([played[x], played[y], played[z]], "the three who stayed: two matches each").toEqual([2, 2, 2]);
    expect(played[leaver] ?? 0, "the leaver: nothing counted").toBe(0);
    // NOT pinned (loop-F tidy finding, routed to the owner): the snapshot RANKS her — last, below Z who lost both — and
    // a take that reaches her rank seats her and walks her over (F14). Whether an expunged leaver belongs in the
    // qualification ranks at all is unruled; pinning either answer here would freeze it.
  }, 120_000);

  it("the negative pair: a plain (organiser) abandon in the same group still holds the stage", async () => {
    const r = await rig(BADMINTON, BWF);
    const [held, ...rest] = r.fixtures;
    await post(r.auth, held!, "core.start");
    await post(r.auth, held!, "core.abandon", { reason: "rain" });
    const [h] = await sql<{ status: string }[]>`select status from fixtures where id = ${held!}`;
    expect(h!.status, "rig: a plain abandon stays abandoned in badminton").toBe("abandoned");
    for (const id of rest) await playBadminton(r.auth, id);
    expect(await advanced(r)).toEqual({ koFixtures: 0, koSeated: 0, autoAdvanced: 0, group: ["abandoned", "decided"] });
  }, 120_000);
});
