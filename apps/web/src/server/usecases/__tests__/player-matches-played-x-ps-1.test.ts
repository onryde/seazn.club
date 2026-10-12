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
import { sql } from "@/lib/db";
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
import { countMatchesByDivision, divisionPlayerStats, personCareerStats } from "../player-stats";
import { listMyCareerStats } from "../me";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

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
