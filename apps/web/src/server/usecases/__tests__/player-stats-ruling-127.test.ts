// W2b ruling 127 (2026-10-13, owner "A"; amends X-PS-1): a withdrawal counts as a match in players' stats if and only
// if play was recorded before it. Before any play nobody is credited (a bare Start is not play, ruling 112); after real
// play the match stands for both sides' players, with NO personal win or loss.
//
// Through the product's own doors: a league the usecases seed, Pat's matches written by the console (`scoreEvent`), and
// Pat's withdrawal through the organiser's cascade (`withdrawEntrantCascade`) — the one writer of a `withdrew` forfeit
// (PF-2: the server refuses that reason from anybody else). Every web reader of a person's matches is then asked: the
// career count (by person and by claimed user), the console and /me career rollups, and the public match list with its
// badges. Seven entrants, so Pat has six fixtures:
//   1–3. Pat wins                                  → three matches, three wins
//   4.   play recorded, then Pat withdraws         → a match for both sides, no win and no loss (ruling 127)
//   5.   a bare Start, then Pat withdraws          → no match (rulings 112, 127)
//   6.   unstarted, then Pat withdraws             → no match (X-PS-1)
// Three played of six is half, so the table policy walks the three pending lines over (EXPUNGES_EARLY_WITHDRAWAL).
// Expected, from the rules above and nothing else: Pat 4 matches, W/D/L 3–0–0; scene 4's opponent 1 match and no
// result; scenes 5 and 6's opponents none.
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
import { withdrawEntrantCascade } from "../withdrawal";
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
  win: (mine: Side) => { type: string; payload: unknown }[];
  /** One sport event that is play and decides nothing (rulings 112, 114). */
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

async function seedScene(c: SportCase) {
  const key = c.module.key;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId, slug: orgSlug }] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug) values (${"R127 " + suffix}, ${"r127-" + suffix}) returning id, slug`;
  await setOrgPlan(orgId, "pro"); // personCareerStats reads stats.player.career, a Pro key
  await invalidateOrgEntitlements(orgId);
  const auth = { orgId, via: "session" as const, userId: null, role: "owner" as const, keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `R127 ${key} ${suffix}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: `open-${suffix}`, sport_key: key, variant_key: c.variant, config: {} });
  const names = ["Pat Player", "Opp One", "Opp Two", "Opp Three", "Opp Four", "Opp Five", "Opp Six"];
  const people: { id: string }[] = [];
  for (const full_name of names) people.push(await createPerson(auth, { full_name, consent: { public_name: true }, dob: null, gender: null, external_ref: null }));
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
  const scene = new Map<number, { id: string; opponent: string }>();
  for (const [i, f] of mine.entries()) {
    const n = i + 1;
    const side: Side = f.home_entrant_id === pat ? "home" : "away";
    const opp = side === "home" ? f.away_entrant_id! : f.home_entrant_id!;
    scene.set(n, { id: f.id, opponent: personOf.get(opp)! });
    if (n <= 3) {
      await post(f.id, "core.start", {});
      for (const e of c.win(side)) await post(f.id, e.type, e.payload);
    } else if (n === 4) {
      await post(f.id, "core.start", {});
      const p = c.play(opp);
      await post(f.id, p.type, p.payload);
    } else if (n === 5) {
      await post(f.id, "core.start", {});
    }
  }
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`pat-${suffix}@test.local`}, 'Pat', true) returning id`;
  await sql`update persons set user_id = ${userId} where id = ${people[0]!.id}`;
  return { auth, orgSlug, compSlug: comp.slug, competitionId: comp.id, divisionId: division.id, pat, personId: people[0]!.id, userId, scene };
}

describe.skipIf(!HAS_DB)("ruling 127: a withdrawal is a match in players' stats only once play was recorded — and never a personal W/L — every web reader", () => {
  for (const c of SPORTS) {
    it(`${c.module.key}: Pat withdraws — after play a match with no result, after a bare Start or before it none; career 4, W/D/L 3–0–0, the match line unbadged`, async () => {
      const s = await seedScene(c);
      const key = c.module.key;
      const out = await withdrawEntrantCascade(s.auth, s.pat);
      expect(out, `${key}: half played, so the three pending lines walk over`).toMatchObject({ policy: "walkover", walkovers: 3, voided: 0 });
      const rows = await sql<{ id: string; status: string; outcome: { kind?: string; reason?: string } | null }[]>`
        select id, status, outcome from fixtures where id in ${sql([...s.scene.values()].map((x) => x.id))}`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const n of [4, 5, 6]) {
        const r = byId.get(s.scene.get(n)!.id)!;
        expect([r.status, r.outcome?.kind, r.outcome?.reason], `${key} scene ${n}: the cascade's withdrawal`).toEqual(["forfeited", "award", "withdrew"]);
      }

      // The career count, both owners.
      const byPerson = await countMatchesByDivision(sql, { by: "person", personId: s.personId }, [s.divisionId]);
      expect(byPerson.get(s.divisionId), `${key}: Pat's matches by person`).toBe(4);
      const byUser = await countMatchesByDivision(sql, { by: "claimedPersons", userId: s.userId }, [s.divisionId]);
      expect(byUser.get(s.divisionId), `${key}: Pat's matches by claimed user`).toBe(4);
      // The other side's players: scene 4's opponent played one match against Pat (ruling 127: "both sides"); scenes 5
      // and 6's opponents none (their other fixtures are unplayed).
      const count = async (personId: string) => (await countMatchesByDivision(sql, { by: "person", personId }, [s.divisionId])).get(s.divisionId) ?? 0;
      expect(await count(s.scene.get(4)!.opponent), `${key}: scene 4's opponent`).toBe(1);
      expect([await count(s.scene.get(5)!.opponent), await count(s.scene.get(6)!.opponent)], `${key}: scenes 5 and 6's opponents`).toEqual([0, 0]);

      // The snapshot, through the product's own read, and the two career rollups that read it.
      const board = await divisionPlayerStats(s.auth, s.divisionId, {});
      const consoleCareer = await personCareerStats(s.auth, s.personId);
      expect(consoleCareer.sports.map((x) => [x.sport_key, x.matches]), `${key}: console career`).toEqual([[key, 4]]);
      const me = await listMyCareerStats(s.userId);
      expect(me.map((x) => [x.sport_key, x.matches]), `${key}: /me career`).toEqual([[key, 4]]);
      const declared = new Set([...(c.module.playerStats?.metrics ?? []).map((m) => m.key), ...(c.module.playerStats?.folded?.keys ?? []).map((k) => k.key)]);
      let wl = 0;
      if (declared.has("wins")) {
        const metric = (k: string) => me[0]!.metrics.find((m) => m.key === k)?.value ?? 0;
        expect([metric("wins"), metric("draws"), metric("losses")], `${key}: /me career W/D/L — no loss for the withdrawal`).toEqual([3, 0, 0]);
        wl++;
      }
      if (declared.has("matches")) {
        // The fold's own `matches` key (setbased: `playedInStats`): Pat 4, scene 4's opponent 1.
        const matchesOf = (personId: string) => board.rows.find((r) => r.person_id === personId)?.stats.matches ?? 0;
        expect([matchesOf(s.personId), matchesOf(s.scene.get(4)!.opponent)], `${key}: the snapshot's matches key`).toEqual([4, 1]);
        wl++;
      }

      // The public match list: the three wins badged, scene 4 listed with no badge, scenes 5 and 6 not listed.
      const seeds = await readPlayerMatchSeeds(sql, { personId: s.personId, competitionId: s.competitionId, orgSlug: s.orgSlug, compSlug: s.compSlug, locale: "en" });
      expect(new Map(seeds.map((x) => [x.fixtureId, x.result])), `${key}: the public match lines`).toEqual(
        new Map([
          [s.scene.get(1)!.id, "won"],
          [s.scene.get(2)!.id, "won"],
          [s.scene.get(3)!.id, "won"],
          [s.scene.get(4)!.id, null],
        ]),
      );
      wl++;
      expect(wl, `${key}: surfaces checked`).toBe(1 + (declared.has("wins") ? 1 : 0) + (declared.has("matches") ? 1 : 0));
    }, 120_000);
  }
});
