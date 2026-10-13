// W2b ruling R115-1 (2026-10-12) — every web count of a person's matches reads the engine's one players'-stats reader.
// X-PS-1: a walkover, a withdrawal or a double walkover never counts as a match played in any player's stats and
// credits no personal W/L; ruling 115 adds a disqualification with nothing played. X-PS-2: a retirement or an in-match
// disqualification (something played first) counts for both sides' players, W/L as decided.
//
// The defect this file pins: the snapshot fold honoured those rules, while the career "matches" count (/me Career, the
// console's ?group=sport, the public player card) and the public player's match list counted every fixture whose
// status was decided/finalized/forfeited — so a walkover read as a match played, and its badge as a personal win.
//
// One player, seven-entrant league, real product writes through `scoreEvent` (the organiser's own door), per sport:
//   1. a played win                            → a match, a win
//   2. a walkover win (opponent no-show)       → no match (X-PS-1)
//   3. a walkover loss (the player's no-show)  → no match (X-PS-1)
//   4. a DQ of the player after a bare Start   → no match (ruling 115)
//   5. a DQ of the player after play           → a match, a loss (X-PS-2)
//   6. a double walkover the withdrawal cascade writes WITHOUT an event (stages.ts, the `dw` mode) → no match (X-PS-1)
// Expected, from the rules above and nothing else: matches = 2, wins = 1, losses = 1, draws = 0.
//
// Two sports, deliberately different in what their snapshot declares: badminton (setbased: a `matches` key, no W/L)
// and generic (W/D/L, no `matches`). Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { badminton } from "@seazn/engine/sports/setbased";
import { generic } from "@seazn/engine/sports/generic";
import type { AnySportModule } from "@seazn/engine/sport";
import { STATS_FOLD_VERSION } from "@seazn/engine/stats";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { readPlayerMatchSeeds } from "@/server/public-site/public-player-matches";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  countMatchesByDivision,
  divisionPlayerStats,
  personCareerStats,
  playerStatsCoverage,
  playerStatsInputsMd5,
  playerStatsOwed,
} from "../player-stats";
import { listMyCareerStats } from "../me";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { preR1152InputsMd5 } from "./_pre-r115-2-inputs-md5";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

type Side = "home" | "away";
interface SportCase {
  module: AnySportModule;
  variant: string;
  /** The player's side wins a played match outright. */
  win: (mine: Side) => { type: string; payload: unknown }[];
  /** One sport event that is play and decides nothing (rulings 112, 114: anything after the Start). */
  play: (opponentEntrant: string) => { type: string; payload: unknown };
}

const SPORTS: SportCase[] = [
  {
    module: badminton as AnySportModule,
    variant: "bwf",
    win: (mine) => {
      const game = mine === "home" ? { home: 21, away: 10 } : { home: 10, away: 21 };
      return [
        { type: "badminton.game.summary", payload: game },
        { type: "badminton.game.summary", payload: game },
      ];
    },
    play: (opponentEntrant) => ({ type: "badminton.rally", payload: { wonBy: opponentEntrant } }),
  },
  {
    module: generic as AnySportModule,
    variant: "score",
    win: (mine) => [{ type: "generic.result", payload: mine === "home" ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 } }],
    play: (opponentEntrant) => ({ type: "generic.score", payload: { by: opponentEntrant, points: 1 } }),
  },
];

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  competitionId: string;
  divisionId: string;
  personId: string;
  userId: string;
  /** The opponent person of the walkover win (2) and of the DQ after play (5) — the other side's players. */
  walkoverOpponent: string;
  playedDqOpponent: string;
  /** Fixture id per scenario number, and its stored status. */
  fixtures: Map<number, { id: string; status: string }>;
}

async function seedScene(c: SportCase): Promise<Scene> {
  const key = c.module.key;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug) values (${"XPS1 " + suffix}, ${"xps1-" + suffix})
    returning id, slug`;
  await setOrgPlan(orgId, "pro"); // personCareerStats reads stats.player.career, a Pro key
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `XPS1 ${key} ${suffix}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: key, variant_key: c.variant, config: {} });
  const names = ["Pat Player", "Opp One", "Opp Two", "Opp Three", "Opp Four", "Opp Five", "Opp Six"];
  const people: { id: string }[] = [];
  for (const full_name of names) {
    people.push(await createPerson(auth, { full_name, consent: { public_name: true }, dob: null, gender: null, external_ref: null }));
  }
  const entrants = await createEntrants(
    auth,
    division.id,
    people.map((p, i) => ({
      kind: "individual" as const,
      display_name: names[i]!,
      seed: i + 1,
      members: [{ person_id: p.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);

  const pat = entrants[0]!.id;
  const personOf = new Map(entrants.map((e, i) => [e.id, people[i]!.id]));
  const mine = fixtures.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && (f.home_entrant_id === pat || f.away_entrant_id === pat));
  expect(mine.length, `${key}: Pat meets each of the six opponents once`).toBe(6);

  const seqOf = new Map<string, number>();
  const post = async (fixtureId: string, type: string, payload: unknown) => {
    const expected_seq = seqOf.get(fixtureId) ?? 0;
    await scoreEvent(auth, fixtureId, { expected_seq, type, payload } as never);
    seqOf.set(fixtureId, expected_seq + 1);
  };
  const scenes = new Map<number, string>();
  let walkoverOpponent = "";
  let playedDqOpponent = "";
  for (const [i, f] of mine.entries()) {
    const n = i + 1;
    const side: Side = f.home_entrant_id === pat ? "home" : "away";
    const opp = side === "home" ? f.away_entrant_id! : f.home_entrant_id!;
    scenes.set(n, f.id);
    if (n === 1) {
      await post(f.id, "core.start", {});
      for (const e of c.win(side)) await post(f.id, e.type, e.payload);
    } else if (n === 2) {
      await post(f.id, "core.forfeit", { by: opp, reason: "walkover" });
      walkoverOpponent = personOf.get(opp)!;
    } else if (n === 3) {
      await post(f.id, "core.forfeit", { by: pat, reason: "walkover" });
    } else if (n === 4) {
      await post(f.id, "core.start", {});
      await post(f.id, "core.forfeit", { by: pat, reason: "disqualified" });
    } else if (n === 5) {
      await post(f.id, "core.start", {});
      const p = c.play(opp);
      await post(f.id, p.type, p.payload);
      await post(f.id, "core.forfeit", { by: pat, reason: "disqualified" });
      playedDqOpponent = personOf.get(opp)!;
    } else {
      // The withdrawal cascade's double walkover over a match nothing was recorded in — its own statement, verbatim
      // (stages.ts, `dw` mode): no event is written.
      await sql`
        update fixtures set status = 'forfeited', outcome = ${sql.json({ kind: "double_walkover" } as never)}
        where id = ${f.id} and status in ('scheduled', 'in_play', 'needs_decision', 'abandoned')`;
    }
  }

  const stored = await sql<{ id: string; status: string }[]>`select id, status from fixtures where id in ${sql([...scenes.values()])}`;
  const statusOf = new Map(stored.map((r) => [r.id, r.status]));
  const fixtureMap = new Map([...scenes].map(([n, id]) => [n, { id, status: statusOf.get(id)! }]));

  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`pat-${suffix}@test.local`}, 'Pat', true) returning id`;
  await sql`update persons set user_id = ${userId} where id = ${people[0]!.id}`;

  return {
    auth,
    orgSlug,
    compSlug: comp.slug,
    competitionId: comp.id,
    divisionId: division.id,
    personId: people[0]!.id,
    userId,
    walkoverOpponent,
    playedDqOpponent,
    fixtures: fixtureMap,
  };
}

describe.skipIf(!HAS_DB)("R115-1 / X-PS-1 / X-PS-2: a person's matches and W/L count only matches played — every web reader", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: matches = 2 and W/L 1–1 on the career count (person + claimed user), the console career, /me career and the public match list`, async () => {
      const s = await seedScene(c);
      const key = c.module.key;

      // The product wrote what each scenario says — a decided played win, forfeits for the rest.
      const statuses = [...s.fixtures.entries()].map(([n, f]) => `${n}:${f.status}`);
      expect(statuses, `${key}: stored statuses`).toEqual(["1:decided", "2:forfeited", "3:forfeited", "4:forfeited", "5:forfeited", "6:forfeited"]);

      // The career count, both owners (organiser/public by person, /me by claimed user).
      const byPerson = await countMatchesByDivision(sql, { by: "person", personId: s.personId }, [s.divisionId]);
      expect(byPerson.get(s.divisionId), `${key}: matches by person`).toBe(2);
      const byUser = await countMatchesByDivision(sql, { by: "claimedPersons", userId: s.userId }, [s.divisionId]);
      expect(byUser.get(s.divisionId), `${key}: matches by claimed user`).toBe(2);
      // The other side's players (X-PS-2 "both sides"; X-PS-1 "any player"): the DQ-after-play opponent played one
      // match against Pat, the walkover opponent none (their other fixtures are unplayed).
      const opp = await countMatchesByDivision(sql, { by: "person", personId: s.playedDqOpponent }, [s.divisionId]);
      expect(opp.get(s.divisionId), `${key}: DQ-after-play opponent`).toBe(1);
      const wo = await countMatchesByDivision(sql, { by: "person", personId: s.walkoverOpponent }, [s.divisionId]);
      expect(wo.get(s.divisionId) ?? 0, `${key}: walkover opponent`).toBe(0);

      // Fold the snapshot through the product's own read, then the two career rollups that read it.
      await divisionPlayerStats(s.auth, s.divisionId, {});
      const consoleCareer = await personCareerStats(s.auth, s.personId);
      expect(consoleCareer.sports.map((x) => [x.sport_key, x.matches]), `${key}: console career`).toEqual([[key, 2]]);
      const me = await listMyCareerStats(s.userId);
      expect(me.map((x) => [x.sport_key, x.matches]), `${key}: /me career`).toEqual([[key, 2]]);
      const metric = (k: string) => me[0]!.metrics.find((m) => m.key === k)?.value;
      const declared = new Set([...(c.module.playerStats?.metrics ?? []).map((m) => m.key), ...(c.module.playerStats?.folded?.keys ?? []).map((k) => k.key)]);
      let wlChecked = 0;
      if (declared.has("wins")) {
        // A fold credits only the keys a fact applies to (no draw was had, so no `draws` row): absent reads 0.
        expect([metric("wins"), metric("draws") ?? 0, metric("losses")], `${key}: /me career W/D/L`).toEqual([1, 0, 1]);
        wlChecked++;
      }

      // The public player's match list: two lines, one won, one lost; no walkover, no DQ before play, no double walkover.
      const seeds = await readPlayerMatchSeeds(sql, { personId: s.personId, competitionId: s.competitionId, orgSlug: s.orgSlug, compSlug: s.compSlug, locale: "en" });
      const listed = new Map(seeds.map((x) => [x.fixtureId, x.result]));
      const want = new Map([
        [s.fixtures.get(1)!.id, "won"],
        [s.fixtures.get(5)!.id, "lost"],
      ]);
      expect(listed, `${key}: the public match lines`).toEqual(want);
      wlChecked++;
      expect(wlChecked, `${key}: W/L surfaces checked`).toBe(declared.has("wins") ? 2 : 1);
    });
  }

  it("the empty case: a person on no settled fixture has no count and no lines; an empty division list asks nothing", async () => {
    const s = await seedScene(SPORTS[1]!);
    const { id: loner } = await createPerson(s.auth, { full_name: "Lone Wolf", consent: { public_name: true }, dob: null, gender: null, external_ref: null });
    expect((await countMatchesByDivision(sql, { by: "person", personId: loner }, [s.divisionId])).size).toBe(0);
    expect((await countMatchesByDivision(sql, { by: "person", personId: s.personId }, [])).size).toBe(0);
    const seeds = await readPlayerMatchSeeds(sql, { personId: loner, competitionId: s.competitionId, orgSlug: s.orgSlug, compSlug: s.compSlug, locale: "en" });
    expect(seeds).toEqual([]);
  });
});

// R115-2 (controller ruling 2026-10-12, option b): a snapshot is served while its fold record's ledger map and inputs
// md5 match the database — and before this ruling the md5 named no fold-code version, so a snapshot folded by OLDER fold
// rules (every one on staging and production before W2b's X-PS-1/X-PS-2) read as covered and was served as stored, for
// ever, until something in its division changed. The md5 now carries `STATS_FOLD_VERSION`, so a record written before it
// (or under any other version) reads as owed and the first read that folds refolds it. No migration, no production write.
//
// The md5 a record folded before the version existed holds comes from the FROZEN pre-R115-2 statement
// (`_pre-r115-2-inputs-md5.ts`, R115 review M4), never from the code under test. `playerStatsInputsMd5(tx, id, null)` is
// asserted to reproduce it (`concat_ws` skips a NULL argument), so the version-less statement stays the pre-R115-2 one.
describe.skipIf(!HAS_DB)("R115-2: a snapshot folded under an older fold version is recomputed on read", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: same version + stale rows → served as stored (the control); pre-version record → owed, and the console read refolds it`, async () => {
      const s = await seedScene(c);
      const key = c.module.key;
      const patRow = async () =>
        (await divisionPlayerStats(s.auth, s.divisionId, {})).rows.find((r) => r.person_id === s.personId)?.stats;
      const storedPat = async () =>
        (await sql<{ stats: Record<string, number> }[]>`
          select stats from player_stat_snapshots where division_id = ${s.divisionId} and person_id = ${s.personId}`)[0]?.stats;
      const coverage = () => withTenant(s.auth.orgId, (tx) => playerStatsCoverage(tx, s.divisionId));

      // The first read folds under the current version. Pat's numbers are X-PS-1's: two matches played, W1 L1.
      const right = await patRow();
      expect(right, `${key}: Pat has a row`).toBeDefined();
      if ("matches" in right!) expect(right!.matches, `${key}: matches (X-PS-1)`).toBe(2);
      if ("wins" in right!) expect([right!.wins, right!.losses], `${key}: W/L (X-PS-1)`).toEqual([1, 1]);
      expect("matches" in right! || "wins" in right!, `${key}: a rule-derived key was checked`).toBe(true);
      expect((await coverage()).covered, `${key}: covered after the fold`).toBe(true);

      // A stand-in for an older fold's numbers: every value off by five.
      const stale = Object.fromEntries(Object.entries(right!).map(([k, v]) => [k, v + 5]));
      await sql`update player_stat_snapshots set stats = ${sql.json(stale as never)}
        where division_id = ${s.divisionId} and person_id = ${s.personId}`;

      // The control (the R115-1 live proof): same fold version, nothing in the division changed → the stored rows
      // are what a read serves. That is the snapshot design, not a defect; it is what lets the version be the trigger.
      expect((await coverage()).covered, `${key}: an edited row alone breaks no coverage`).toBe(true);
      expect(await patRow(), `${key}: served as stored`).toEqual(stale);

      // Now the record as the pre-version code wrote it: its md5 has no version in it.
      const [md5Now, md5Before, md5Null, md5Next] = await withTenant(s.auth.orgId, async (tx) => [
        await playerStatsInputsMd5(tx, s.divisionId),
        await preR1152InputsMd5(tx, s.divisionId),
        await playerStatsInputsMd5(tx, s.divisionId, null),
        await playerStatsInputsMd5(tx, s.divisionId, STATS_FOLD_VERSION + 1),
      ]);
      expect(md5Null, `${key}: a null version reproduces the frozen pre-R115-2 md5`).toBe(md5Before);
      expect(new Set([md5Now, md5Before, md5Next]).size, `${key}: three versions, three md5s`).toBe(3);
      await sql`update player_stat_folds set inputs_md5 = ${md5Before} where division_id = ${s.divisionId}`;

      const before = await coverage();
      expect([before.covered, before.owed, before.inputsSame], `${key}: a pre-version record is owed`).toEqual([false, true, false]);
      // The public reads' check (`reconcilePlayerStatsOnRead`) asks exactly this, so they queue the refold too.
      expect(await withTenant(s.auth.orgId, (tx) => playerStatsOwed(tx, s.divisionId)), `${key}: owed to the read-side check`).toBe(true);

      // The first read that folds (the console leaderboard) refolds and writes: the right rows, stored, stamped now.
      expect(await patRow(), `${key}: refolded on read`).toEqual(right);
      expect(await storedPat(), `${key}: the refold was written`).toEqual(right);
      const [{ inputs_md5 }] = await sql<{ inputs_md5: string }[]>`
        select inputs_md5 from player_stat_folds where division_id = ${s.divisionId}`;
      expect(inputs_md5, `${key}: re-stamped under the current version`).toBe(md5Now);
      expect((await coverage()).covered, `${key}: covered again`).toBe(true);
    });
  }

  it("the fold version is one positive integer constant (a bump is the only way to retire stored snapshots)", () => {
    expect(Number.isInteger(STATS_FOLD_VERSION) && STATS_FOLD_VERSION >= 2).toBe(true);
  });
});

// R115-3 (controller ruling 2026-10-12): a bye is not a match played. The generator settles it with no event written
// (`status: 'forfeited'`, `byeAward` — an award nobody forfeited), so X-PS-1's reading of an unplayed award applies:
// no appearance, no personal W/L, no line in the player's match list. Expected values from that rule alone.
// Three-entrant knockout, real generator, real `scoreEvent` writes: seed 1 (Pat) gets the bye, 2 v 3 is played, then Pat
// plays the final and wins. Pat: one match, one win. The semi winner: two matches (semi + final).
describe.skipIf(!HAS_DB)("R115-3: a bye is no match played — career count, match list, snapshot", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: Pat's bye + won final → matches 1, W1 L0, one public line; the semi winner → matches 2`, async () => {
      const key = c.module.key;
      const suffix = randomUUID().slice(0, 8);
      const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
        insert into organizations (name, slug) values (${"R1153 " + suffix}, ${"r1153-" + suffix}) returning id, slug`;
      await setOrgPlan(orgId, "pro");
      await invalidateOrgEntitlements(orgId);
      const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `R1153 ${key} ${suffix}`, visibility: "public", branding: {} });
      const division = await createDivision(auth, comp.id, { name: "KO", slug: `ko-${suffix}`, sport_key: key, variant_key: c.variant, config: {} });
      const names = ["Pat Bye", "Second Seed", "Third Seed"];
      const people: { id: string }[] = [];
      for (const full_name of names) {
        people.push(await createPerson(auth, { full_name, consent: { public_name: true }, dob: null, gender: null, external_ref: null }));
      }
      const entrants = await createEntrants(
        auth,
        division.id,
        people.map((p, i) => ({
          kind: "individual" as const,
          display_name: names[i]!,
          seed: i + 1,
          members: [{ person_id: p.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
        })),
      );
      const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "KO", config: {} });
      await generateStageFixtures(auth, stage!.id);
      await startDivision(auth, division.id);
      const pat = entrants[0]!.id;
      const personOf = new Map(entrants.map((e, i) => [e.id, people[i]!.id]));

      type Row = { id: string; round_no: number; status: string; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown; events: number };
      const rows = () => sql<Row[]>`
        select f.id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id, f.outcome,
               (select count(*)::int from score_events se where se.fixture_id = f.id) as events
        from fixtures f where f.stage_id = ${stage!.id} order by f.round_no, f.seq_in_round`;

      // The producer wrote a bye exactly as R115-3 reads it: one seat (Pat), settled, an award with no loser, no event.
      const byes = (await rows()).filter((r) => r.status === "forfeited");
      expect(byes.length, `${key}: one generated bye`).toBe(1);
      const bye = byes[0]!;
      expect([bye.home_entrant_id ?? bye.away_entrant_id, bye.events], `${key}: Pat's bye, no event`).toEqual([pat, 0]);
      expect(bye.outcome, `${key}: the bye award`).toEqual({ kind: "award", winner: pat, loser: null, reason: "bye" });

      const seqOf = new Map<string, number>();
      const post = async (fixtureId: string, type: string, payload: unknown) => {
        const expected_seq = seqOf.get(fixtureId) ?? 0;
        await scoreEvent(auth, fixtureId, { expected_seq, type, payload } as never);
        seqOf.set(fixtureId, expected_seq + 1);
      };
      const playWin = async (fixtureId: string, side: Side) => {
        await post(fixtureId, "core.start", {});
        for (const e of c.win(side)) await post(fixtureId, e.type, e.payload);
      };

      const semi = (await rows()).find((r) => r.home_entrant_id !== null && r.away_entrant_id !== null && r.home_entrant_id !== pat && r.away_entrant_id !== pat);
      expect(semi, `${key}: the 2 v 3 semi`).toBeDefined();
      await playWin(semi!.id, "home");
      const semiWinner = semi!.home_entrant_id!;

      const final = (await rows()).find((r) => r.status === "scheduled" && r.home_entrant_id !== null && r.away_entrant_id !== null);
      expect(final && [final.home_entrant_id, final.away_entrant_id].sort(), `${key}: the final seats Pat and the semi winner`).toEqual([pat, semiWinner].sort());
      await playWin(final!.id, final!.home_entrant_id === pat ? "home" : "away");

      const settled = (await rows()).map((r) => r.status).sort();
      expect(settled, `${key}: every fixture settled`).toEqual(["decided", "decided", "forfeited"]);

      // The career count (person + every web rollup reads it).
      const patCount = await countMatchesByDivision(sql, { by: "person", personId: personOf.get(pat)! }, [division.id]);
      expect(patCount.get(division.id), `${key}: Pat — the final only`).toBe(1);
      const winnerCount = await countMatchesByDivision(sql, { by: "person", personId: personOf.get(semiWinner)! }, [division.id]);
      expect(winnerCount.get(division.id), `${key}: the semi winner — semi + final`).toBe(2);

      // The public match list: the final, won; no bye line.
      const seeds = await readPlayerMatchSeeds(sql, { personId: personOf.get(pat)!, competitionId: comp.id, orgSlug, compSlug: comp.slug, locale: "en" });
      expect(new Map(seeds.map((x) => [x.fixtureId, x.result])), `${key}: Pat's public lines`).toEqual(new Map([[final!.id, "won"]]));

      // The snapshot fold agrees (the engine reader, the same rule).
      const board = await divisionPlayerStats(auth, division.id, {});
      const patStats = board.rows.find((r) => r.person_id === personOf.get(pat))?.stats ?? {};
      let checked = 0;
      if ((c.module.playerStats?.folded?.keys ?? []).some((k) => k.key === "matches") || "matches" in patStats) {
        expect(patStats.matches, `${key}: snapshot matches`).toBe(1);
        checked++;
      }
      if ("wins" in patStats || "losses" in patStats) {
        expect([patStats.wins ?? 0, patStats.losses ?? 0], `${key}: snapshot W/L`).toEqual([1, 0]);
        checked++;
      }
      expect(checked, `${key}: snapshot keys checked`).toBe(1);
    });
  }
});

// Ruling 120 (owner "A", 2026-10-12): an abandon counts as a match played in players' stats only if something was
// played before it — any sport event after the Start, scoring or not (ruling 114); with nothing played, no player gets
// a match, whatever the abandon's result or settle. Expected values from that rule alone. Real `scoreEvent` writes:
//   league (Pat meets two opponents):
//     1. Start, play, abandon                            → a match (X-PS-2, ruling 120)
//     2. Start, abandon (rain before play)               → no match
//   knockout (Pat v one opponent; a settle is a knockout's only — append-event.ts refuses it in a league):
//     3. Start, abandon, the organiser settles for Pat   → no match, and no personal win
// Pat: one match, no W/L. The defect it pins on both sides of the change: the career count left out the `abandoned`
// status the snapshot fold reads (tile 1, career 0), and read a settled abandon with nothing played as a match.
describe.skipIf(!HAS_DB)("ruling 120: an abandon is a match only if something was played before it — career count, match list, snapshot", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: a played abandon is Pat's one match; abandons with nothing played (settled or not) are none`, async () => {
      const key = c.module.key;
      const suffix = randomUUID().slice(0, 8);
      const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
        insert into organizations (name, slug) values (${"R120 " + suffix}, ${"r120-" + suffix}) returning id, slug`;
      await setOrgPlan(orgId, "pro");
      await invalidateOrgEntitlements(orgId);
      const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `R120 ${key} ${suffix}`, visibility: "public", branding: {} });
      const names = ["Pat Rain", "Opp One", "Opp Two", "Opp Three"];
      const people: { id: string }[] = [];
      for (const full_name of names) {
        people.push(await createPerson(auth, { full_name, consent: { public_name: true }, dob: null, gender: null, external_ref: null }));
      }
      const seqOf = new Map<string, number>();
      const post = async (fixtureId: string, type: string, payload: unknown) => {
        const expected_seq = seqOf.get(fixtureId) ?? 0;
        await scoreEvent(auth, fixtureId, { expected_seq, type, payload } as never);
        seqOf.set(fixtureId, expected_seq + 1);
      };
      /** A started division of `who` (indexes into `people`), Pat first, its fixtures generated. */
      const divisionOf = async (slug: string, kind: "league" | "knockout", who: number[]) => {
        const division = await createDivision(auth, comp.id, { name: slug, slug: `${slug}-${suffix}`, sport_key: key, variant_key: c.variant, config: {} });
        const entrants = await createEntrants(
          auth,
          division.id,
          who.map((i, seed) => ({
            kind: "individual" as const,
            display_name: names[i]!,
            seed: seed + 1,
            members: [{ person_id: people[i]!.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
          })),
        );
        const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: slug, config: {} });
        const { fixtures } = await generateStageFixtures(auth, stage!.id);
        await startDivision(auth, division.id);
        const pat = entrants[0]!.id;
        const personOf = new Map(entrants.map((e, i) => [e.id, people[who[i]!]!.id]));
        const mine = fixtures.filter((f) => f.home_entrant_id === pat || f.away_entrant_id === pat);
        const oppOf = (f: (typeof mine)[number]) => personOf.get(f.home_entrant_id === pat ? f.away_entrant_id! : f.home_entrant_id!)!;
        const oppEntrantOf = (f: (typeof mine)[number]) => (f.home_entrant_id === pat ? f.away_entrant_id! : f.home_entrant_id!);
        return { division, pat, mine, oppOf, oppEntrantOf };
      };
      const league = await divisionOf("league", "league", [0, 1, 2]);
      expect(league.mine.length, `${key}: Pat meets each league opponent once`).toBe(2);
      const ko = await divisionOf("ko", "knockout", [0, 3]);
      expect(ko.mine.length, `${key}: Pat's knockout match`).toBe(1);
      const [played, bare] = league.mine;
      const settled = ko.mine[0]!;
      await post(played!.id, "core.start", {});
      const p = c.play(league.oppEntrantOf(played!));
      await post(played!.id, p.type, p.payload);
      await post(played!.id, "core.abandon", { reason: "rain" });
      await post(bare!.id, "core.start", {});
      await post(bare!.id, "core.abandon", { reason: "rain" });
      await post(settled.id, "core.start", {});
      await post(settled.id, "core.abandon", { reason: "rain" });
      await post(settled.id, "core.settle", { winner: ko.pat, method: "lot" });

      // The product wrote what each scene says: two abandons that decided nobody, and the organiser's settle.
      const stored = await sql<{ id: string; status: string }[]>`select id, status from fixtures where id in ${sql([played!.id, bare!.id, settled.id])}`;
      const statusOf = new Map(stored.map((r) => [r.id, r.status]));
      expect([statusOf.get(played!.id), statusOf.get(bare!.id), statusOf.get(settled.id)], `${key}: stored statuses`).toEqual(["abandoned", "abandoned", "decided"]);

      // The career count, both owners: the played abandon only.
      const divisions = [league.division.id, ko.division.id];
      const patPerson = people[0]!.id;
      const byPerson = await countMatchesByDivision(sql, { by: "person", personId: patPerson }, divisions);
      expect([...byPerson], `${key}: matches by person`).toEqual([[league.division.id, 1]]);
      const [{ id: userId }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified) values (${`rain-${suffix}@test.local`}, 'Pat', true) returning id`;
      await sql`update persons set user_id = ${userId} where id = ${patPerson}`;
      const byUser = await countMatchesByDivision(sql, { by: "claimedPersons", userId }, divisions);
      expect([...byUser], `${key}: matches by claimed user`).toEqual([[league.division.id, 1]]);
      // The other sides' players: the played abandon's opponent played one; the two others none.
      const opponents = await Promise.all(
        [league.oppOf(played!), league.oppOf(bare!), ko.oppOf(settled)].map(
          async (personId) => [...(await countMatchesByDivision(sql, { by: "person", personId }, divisions)).values()].reduce((a, b) => a + b, 0),
        ),
      );
      expect(opponents, `${key}: the three opponents`).toEqual([1, 0, 0]);

      // The snapshot fold (the tile) agrees with the career count, and the settle credited Pat no win.
      const boards = [await divisionPlayerStats(auth, league.division.id, {}), await divisionPlayerStats(auth, ko.division.id, {})];
      const declared = new Set([...(c.module.playerStats?.metrics ?? []).map((m) => m.key), ...(c.module.playerStats?.folded?.keys ?? []).map((k) => k.key)]);
      // The career listings card the sport with the count's one match — generic's played abandon decided nobody and
      // credits Pat no figure, so no snapshot row holds it; the listing reads the count's division set too.
      const consoleCareer = await personCareerStats(auth, patPerson);
      const me = await listMyCareerStats(userId);
      const careers = [consoleCareer.sports.map((x) => [x.sport_key, x.matches]), me.map((x) => [x.sport_key, x.matches])];
      expect(careers, `${key}: console and /me careers`).toEqual([[[key, 1]], [[key, 1]]]);
      const [leagueStats, koStats] = boards.map((b) => b.rows.find((r) => r.person_id === patPerson)?.stats ?? {});
      let checked = 0;
      if (declared.has("matches")) {
        expect([leagueStats!.matches, koStats!.matches ?? 0], `${key}: the tiles' matches`).toEqual([1, 0]);
        checked++;
      }
      if (declared.has("wins")) {
        expect(koStats!.wins ?? 0, `${key}: no win from the settle of an abandon with nothing played`).toBe(0);
        checked++;
      }
      expect(checked, `${key}: snapshot keys checked`).toBe(1);

      // The public match list: the played abandon, which decided nobody — a line with no badge.
      const seeds = await readPlayerMatchSeeds(sql, { personId: patPerson, competitionId: comp.id, orgSlug, compSlug: comp.slug, locale: "en" });
      expect(new Map(seeds.map((x) => [x.fixtureId, x.result])), `${key}: Pat's public lines`).toEqual(new Map([[played!.id, null]]));
    });
  }
});
