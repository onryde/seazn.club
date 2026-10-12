// W2b ruling 122 (owner "B", 2026-10-12): a team match counts on a person's career record only for players — the
// recorded lineup, or the roster when no lineup was recorded. Real Postgres required.
//
// The rule, in the ruling's own words (`_INDEX.md`, 122):
//   - A person gets a match only with the player role. Coach and staff never get one.
//   - If the fixture has a recorded lineup, only people in it get the match.
//   - If no lineup was recorded, the roster's players get it.
//   - Individual-entrant sports are unchanged.
//   - Known residue, accepted: a player added to the roster after a fixture with no lineup is still credited,
//     because no join date is stored.
//
// Where the roles live (read off the schema, not assumed): a roster row (`entrant_members`) carries no player/coach
// role — its `roles` column is the sport's position-catalog roles (captain, wicketkeeper), filtered against the
// module's `positions.roles` by `filterRosterForSport`, and `[]` means "no catalog role". A coach or staff member is
// registered as such on the PERSON (`persons.lane`, V356 — written by `createPerson` and by `createEntrants`'
// `new_person.lane`), and named as such on a fixture's team sheet (`lineups.role`, V357 — written by `putLineup`, the
// lineup editor's role select). So the roster fallback reads the person's lane, and a recorded lineup reads its own
// role column.
//
// "A recorded lineup" is per side, the reading the public match lines already use (`readPlayerMatchSeeds`): a side
// that declared no sheet for the fixture stands its roster in, whatever the other side did.
//
// Every scene goes through the real writers: `createPerson` (lane), `createEntrants` (roster), `putLineup` (the sheet,
// with its role), `patchEntrant` (the late addition). A settled fixture is raw-flipped to `finalized` over the one
// ledger row a real one always opens with (`core.start`, R115-1), as the career tests beside this one do.
//
// Both readers that credit a person with a match are asked, and must agree on every team-sport person: the career
// count (`careerMatchesByDivision`, which the career listing cards from — one reader for both), by person and by
// claimed user, and the public player page's match seeds (`readPlayerMatchSeeds`).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { readPlayerMatchSeeds } from "@/server/public-site/public-player-matches";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { putLineup } from "../fixtures";
import { createPerson } from "../persons";
import { careerMatchesByDivision } from "../player-stats";

const HAS_DB = !!process.env.DATABASE_URL;
type Lane = "player" | "coach" | "staff";
type Kind = "team" | "individual" | "pair";

/** Every sport the engine ships once (the latest of each key), with the entrant kinds it declares. */
const SPORTS: readonly AnySportModule[] = [...new Map(builtinModules.map((m) => [m.key, m])).values()];
const kindsOf = (m: AnySportModule): readonly Kind[] => effectiveEntrantModel(m.entrantModel).kinds;
const TEAM_SPORTS = SPORTS.filter((m) => kindsOf(m).includes("team"));
const INDIVIDUAL_SPORTS = SPORTS.filter((m) => kindsOf(m).includes("individual"));

async function seedOrg(): Promise<{ auth: AuthCtx; orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `r122-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"R122 " + suffix}, ${orgSlug}) returning id`;
  // No active-competition cap: a community cap silently downgrades an over-cap public competition to private, and
  // the public seeds would then read nothing for the wrong reason (the same override the public match-line tests use).
  await setOrgPlan(orgId);
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;
  await invalidateOrgEntitlements(orgId);
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, orgSlug };
}

/** The sport row and one system variant from the module's own presets — present already where `sync:sports` ran. */
async function ensureSport(m: AnySportModule): Promise<string> {
  const variantKey = Object.keys(m.variants)[0];
  if (variantKey === undefined) throw new Error(`premise: ${m.key} declares no variant preset`);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${m.key}, ${m.key}, ${m.version}, ${sql.json((m.positions ?? { groups: [] }) as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values (${m.key}, ${variantKey}, ${variantKey}, ${sql.json(m.variants[variantKey] as never)}, true)
    on conflict do nothing`;
  return variantKey;
}

async function seedDivision(auth: AuthCtx, m: AnySportModule) {
  const variantKey = await ensureSport(m);
  const suffix = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `R122 ${m.key} ${suffix}`,
    visibility: "public",
    branding: {},
  } as never);
  const division = await createDivision(auth, comp.id, {
    name: `R122 ${m.key}`,
    slug: `r122-${m.key}-${suffix}`,
    sport_key: m.key,
    variant_key: variantKey,
    config: {},
  } as never);
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${division.id}, 1, 'league', 'League') returning id`;
  const [{ slug, visibility }] = await sql<{ slug: string; visibility: string }[]>`
    select slug, visibility from competitions where id = ${comp.id}`;
  expect(visibility, `${m.key}: premise — the competition stayed public, so the public seeds can see it`).toBe("public");
  return { divisionId: division.id, stageId, competitionId: comp.id, compSlug: slug };
}

async function person(auth: AuthCtx, name: string, lane: Lane): Promise<string> {
  const p = await createPerson(auth, { full_name: name, consent: {}, dob: null, gender: null, external_ref: null, lane } as never);
  return p.id;
}

const member = (personId: string) => ({ person_id: personId, squad_number: null, default_position_key: null, is_captain: false, roles: [] });

async function entrant(auth: AuthCtx, divisionId: string, kind: Kind, name: string, personIds: string[]): Promise<string> {
  const [e] = await createEntrants(auth, divisionId, [{ kind, display_name: name, seed: 1, members: personIds.map(member) }] as never);
  return e!.id;
}

let round = 0;
async function scheduledFixture(stageId: string, divisionId: string, home: string, away: string): Promise<string> {
  round += 1;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${divisionId}, ${round}, 1, ${home}, ${away}, 'scheduled') returning id`;
  return id;
}

/** Settle a fixture the way the career tests beside this one do: finalized, over the ledger's opening row. */
async function settle(fixtureId: string): Promise<void> {
  await sql`update fixtures set status = 'finalized' where id = ${fixtureId}`;
  await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
            values (gen_random_uuid(), ${fixtureId}, 1, 'core.start', '{}', now())`;
}

type Sheet = { personId: string; slot: "starting" | "bench"; role: Lane };
async function sheet(auth: AuthCtx, fixtureId: string, entrantId: string, rows: Sheet[]): Promise<void> {
  await putLineup(auth, fixtureId, entrantId, {
    slots: rows.map((r, i) => ({ person_id: r.personId, slot: r.slot, position_key: null, order_no: i + 1, roles: [], role: r.role })),
  } as never);
}

async function claim(personId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`r122-${randomUUID().slice(0, 12)}@test.local`}, 'R122', true) returning id`;
  await sql`update persons set user_id = ${id} where id = ${personId}`;
  return id;
}

type Asked = { byPerson: number; byUser: number; seeds: number; carded: boolean };
async function ask(personId: string, userId: string, d: { divisionId: string; competitionId: string; compSlug: string }, orgSlug: string): Promise<Asked> {
  const byPerson = await careerMatchesByDivision(sql, { by: "person", personId }, [d.divisionId]);
  const byUser = await careerMatchesByDivision(sql, { by: "claimedPersons", userId }, [d.divisionId]);
  const seeds = await readPlayerMatchSeeds(sql, { personId, competitionId: d.competitionId, orgSlug, compSlug: d.compSlug, locale: "en" });
  return {
    byPerson: byPerson.get(d.divisionId)?.matches ?? 0,
    byUser: byUser.get(d.divisionId)?.matches ?? 0,
    seeds: seeds.filter((s) => s.status !== "in_play").length,
    carded: byPerson.has(d.divisionId),
  };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("ruling 122: a team match counts on a career record only for players", () => {
  it("premise: the engine declares team sports and individual sports to sweep", () => {
    expect(TEAM_SPORTS.length).toBeGreaterThan(0);
    expect(INDIVIDUAL_SPORTS.length).toBeGreaterThan(0);
    // A sport is swept once: the de-duplication by key kept every shipped key.
    expect(SPORTS.map((m) => m.key).sort()).toEqual([...new Set(builtinModules.map((m) => m.key))].sort());
  });

  it("every team sport: coach and staff get 0; a recorded lineup credits only its players; no lineup credits the roster's players; and a player added after a lineup-less fixture still gets it (ruling 122's accepted residue)", async () => {
    const { auth, orgSlug } = await seedOrg();
    const n = { sports: 0, persons: 0, zeroes: 0, residue: 0 };
    for (const m of TEAM_SPORTS) {
      const d = await seedDivision(auth, m);
      const p = {
        rosterPlayer: await person(auth, `${m.key} Roster Player`, "player"),
        starter: await person(auth, `${m.key} Starter`, "player"),
        bench: await person(auth, `${m.key} Bench`, "player"),
        sheetCoach: await person(auth, `${m.key} Sheet Coach`, "player"),
        coach: await person(auth, `${m.key} Coach`, "coach"),
        staff: await person(auth, `${m.key} Staff`, "staff"),
        oppPlayer: await person(auth, `${m.key} Opp Player`, "player"),
        oppCoach: await person(auth, `${m.key} Opp Coach`, "coach"),
        late: await person(auth, `${m.key} Late`, "player"),
      };
      const squad = [p.rosterPlayer, p.starter, p.bench, p.sheetCoach, p.coach, p.staff];
      const mine = await entrant(auth, d.divisionId, "team", `${m.key} Mine`, squad);
      const theirs = await entrant(auth, d.divisionId, "team", `${m.key} Theirs`, [p.oppPlayer, p.oppCoach]);

      // F1: no lineup on either side. F2: Mine recorded a sheet — a starter, a bench player, a squad player the
      // sheet names as coach, and the registered coach and staff under their own roles; Theirs recorded none.
      const f1 = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
      const f2 = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
      await sheet(auth, f2, mine, [
        { personId: p.starter, slot: "starting", role: "player" },
        { personId: p.bench, slot: "bench", role: "player" },
        { personId: p.sheetCoach, slot: "starting", role: "coach" },
        { personId: p.coach, slot: "starting", role: "coach" },
        { personId: p.staff, slot: "bench", role: "staff" },
      ]);
      const [{ count: sheetRows }] = await sql<{ count: number }[]>`
        select count(*)::int as count from lineups where fixture_id = ${f2}`;
      expect(sheetRows, `${m.key}: premise — the sheet was stored on F2, and only on Mine's side`).toBe(5);
      await settle(f1);
      await settle(f2);
      // The late player joins Mine's roster after both fixtures settled.
      await patchEntrant(auth, mine, { members: [...squad, p.late].map(member) } as never);

      // Expected, per fixture, from ruling 122's text:
      const expected: Record<keyof typeof p, number> = {
        rosterPlayer: 1 + 0, // F1: a roster player, no lineup. F2: a lineup was recorded and does not name them.
        starter: 1 + 1, // F1: roster player. F2: in the lineup as a player.
        bench: 1 + 1, // F1: roster player. F2: in the lineup (as a player; the substitutes-who-came-on rule is ruling 121's).
        sheetCoach: 1 + 0, // F1: a roster player. F2: in the lineup, but as coach — "coach and staff never get one".
        coach: 0 + 0, // a coach never gets a match, lineup or not.
        staff: 0 + 0, // nor staff.
        oppPlayer: 1 + 1, // Theirs recorded no lineup for either fixture: the roster's players get both.
        oppCoach: 0 + 0, // the roster's coach gets neither.
        late: 1 + 0, // ACCEPTED RESIDUE: F1 had no lineup and no join date is stored. F2's lineup does not name them.
      };
      for (const [role, personId] of Object.entries(p) as [keyof typeof p, string][]) {
        const userId = await claim(personId);
        const got = await ask(personId, userId, d, orgSlug);
        const want = expected[role];
        expect(got, `${m.key} / ${role}`).toEqual({ byPerson: want, byUser: want, seeds: want, carded: want > 0 });
        n.persons++;
        if (want === 0) n.zeroes++;
      }
      if (expected.late === 1) n.residue++;
      n.sports++;
    }
    // Anti-vacuity: every team sport the engine declares was swept, each with its zero-credit and residue scenes.
    expect(n.sports).toBe(TEAM_SPORTS.length);
    expect(n.persons).toBe(TEAM_SPORTS.length * 9);
    expect(n.zeroes).toBe(TEAM_SPORTS.length * 3);
    expect(n.residue).toBe(TEAM_SPORTS.length);
  }, 300_000);

  it("ruling 122: a lineup-only player — on the sheet, since removed from the roster — still gets the match the sheet recorded", async () => {
    // Single sport, deliberately: the rule's lineup branch is one SQL predicate for every team sport, which the sweep
    // above covers; this pins the one shape the sweep does not build (a sheet row with no roster row behind it).
    const { auth, orgSlug } = await seedOrg();
    const m = TEAM_SPORTS[0]!;
    const d = await seedDivision(auth, m);
    const left = await person(auth, `${m.key} Left`, "player");
    const stays = await person(auth, `${m.key} Stays`, "player");
    const opp = await person(auth, `${m.key} Opp`, "player");
    const mine = await entrant(auth, d.divisionId, "team", "Mine", [left, stays]);
    const theirs = await entrant(auth, d.divisionId, "team", "Theirs", [opp]);
    const f = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
    await sheet(auth, f, mine, [{ personId: left, slot: "starting", role: "player" }]);
    await settle(f);
    await patchEntrant(auth, mine, { members: [stays].map(member) } as never);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from entrant_members where entrant_id = ${mine} and person_id = ${left}`;
    expect(count, "premise: no roster row behind the sheet row").toBe(0);
    expect(await ask(left, await claim(left), d, orgSlug)).toEqual({ byPerson: 1, byUser: 1, seeds: 1, carded: true });
    // The positive pair: the squad player the sheet left out gets nothing for it.
    expect(await ask(stays, await claim(stays), d, orgSlug)).toEqual({ byPerson: 0, byUser: 0, seeds: 0, carded: false });
  }, 60_000);

  it("every individual-entrant sport is unchanged: the roster credits whoever is on it, whatever their lane", async () => {
    const { auth, orgSlug } = await seedOrg();
    const n = { sports: 0, persons: 0, pairs: 0 };
    for (const m of INDIVIDUAL_SPORTS) {
      const d = await seedDivision(auth, m);
      // A person registered under the coach lane, on an individual entrant: credited by the roster as always.
      const solo = await person(auth, `${m.key} Solo`, "coach");
      const rival = await person(auth, `${m.key} Rival`, "player");
      const soloE = await entrant(auth, d.divisionId, "individual", "Solo", [solo]);
      const rivalE = await entrant(auth, d.divisionId, "individual", "Rival", [rival]);
      await settle(await scheduledFixture(d.stageId, d.divisionId, soloE, rivalE));
      for (const personId of [solo, rival]) {
        expect(await ask(personId, await claim(personId), d, orgSlug), `${m.key}: individual`).toEqual({ byPerson: 1, byUser: 1, seeds: 1, carded: true });
        n.persons++;
      }
      if (kindsOf(m).includes("pair")) {
        const a = await person(auth, `${m.key} Pair A`, "player");
        const b = await person(auth, `${m.key} Pair B`, "staff");
        const c = await person(auth, `${m.key} Pair C`, "player");
        const e = await person(auth, `${m.key} Pair D`, "player");
        const ab = await entrant(auth, d.divisionId, "pair", "AB", [a, b]);
        const ce = await entrant(auth, d.divisionId, "pair", "CE", [c, e]);
        await settle(await scheduledFixture(d.stageId, d.divisionId, ab, ce));
        for (const personId of [a, b]) {
          expect(await ask(personId, await claim(personId), d, orgSlug), `${m.key}: pair`).toEqual({ byPerson: 1, byUser: 1, seeds: 1, carded: true });
          n.persons++;
        }
        n.pairs++;
      }
      n.sports++;
    }
    expect(n.sports).toBe(INDIVIDUAL_SPORTS.length);
    const pairSports = INDIVIDUAL_SPORTS.filter((m) => kindsOf(m).includes("pair")).length;
    expect(n.pairs).toBe(pairSports);
    expect(pairSports).toBeGreaterThan(0);
    expect(n.persons).toBe(INDIVIDUAL_SPORTS.length * 2 + pairSports * 2);
  }, 300_000);

  it("individual entrants are unchanged: a sheet naming an individual entrant's member as coach does not reach the career count", async () => {
    // Single sport, deliberately: the kind guard is one SQL predicate, and the sweep above covers every individual
    // sport's roster credit. Only the career count is asked: the public match lines read a sheet for every entrant
    // kind (their own rule, older than ruling 122 and unchanged by it).
    const { auth } = await seedOrg();
    const m = INDIVIDUAL_SPORTS[0]!;
    const d = await seedDivision(auth, m);
    const solo = await person(auth, `${m.key} Solo`, "player");
    const rival = await person(auth, `${m.key} Rival`, "player");
    const soloE = await entrant(auth, d.divisionId, "individual", "Solo", [solo]);
    const rivalE = await entrant(auth, d.divisionId, "individual", "Rival", [rival]);
    const f = await scheduledFixture(d.stageId, d.divisionId, soloE, rivalE);
    await sheet(auth, f, soloE, [{ personId: solo, slot: "starting", role: "coach" }]);
    await settle(f);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from lineups where fixture_id = ${f}`;
    expect(count, "premise: the sheet was stored").toBe(1);
    const userId = await claim(solo);
    expect((await careerMatchesByDivision(sql, { by: "person", personId: solo }, [d.divisionId])).get(d.divisionId)?.matches).toBe(1);
    expect((await careerMatchesByDivision(sql, { by: "claimedPersons", userId }, [d.divisionId])).get(d.divisionId)?.matches).toBe(1);
  }, 60_000);
});
