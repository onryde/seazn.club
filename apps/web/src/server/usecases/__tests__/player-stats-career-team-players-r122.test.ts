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
// Round 1 (coordinator review): the rule is ONE reader now (`@/server/appearances`), shared by the career count and
// the public match lines, and the bench rows follow the owner's bench rule (`benchRowIsAppearance`, 2026-09-16) in
// both. Every person below is asked through FIVE readers, which must all give the ruling's number: the career count
// by person and by claimed user (`careerMatchesByDivision`), the public player page's settled match lines
// (`readPlayerMatchLines`, bench rule applied), the console career (`personCareerStats`) and /me Career
// (`listMyCareerStats`) — the last two through their own division scope (`placedDivisions`), which must reach a
// division the person played in from a sheet after leaving the roster.
//
// The per-fixture cache of the lines' cricket figures is a pass-through here: this file asks the rule, not the cache.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { benchRowIsAppearance } from "@/server/appearances";
import { readPlayerMatchLines } from "@/server/public-site/public-player-matches";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { putLineup } from "../fixtures";
import { lineupCatalogFor } from "../lineup-catalog";
import { createPerson } from "../persons";
import { listMyCareerStats } from "../me";
import { careerMatchesByDivision, personCareerStats } from "../player-stats";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;
type Lane = "player" | "coach" | "staff";
type Kind = "team" | "individual" | "pair";

/** Every sport the engine ships once (the latest of each key), with the entrant kinds it declares. */
const SPORTS: readonly AnySportModule[] = [...new Map(builtinModules.map((m) => [m.key, m])).values()];
const kindsOf = (m: AnySportModule): readonly Kind[] => effectiveEntrantModel(m.entrantModel).kinds;
const TEAM_SPORTS = SPORTS.filter((m) => kindsOf(m).includes("team"));
const INDIVIDUAL_SPORTS = SPORTS.filter((m) => kindsOf(m).includes("individual"));
/** Every sport with a non-team entrant kind — volleyball's pair (beach) among them, which declares no individual. */
const NON_TEAM_SPORTS = SPORTS.filter((m) => kindsOf(m).includes("individual") || kindsOf(m).includes("pair"));

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
  return { divisionId: division.id, stageId, competitionId: comp.id, compSlug: slug, sportKey: m.key };
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
async function sheet(auth: AuthCtx, fixtureId: string, entrantId: string, rows: Sheet[], m: AnySportModule): Promise<void> {
  // PUT lineups refuses a bench row where the sport's catalog declares `benchMax: 0` (boardgame, carrom, generic), so the
  // door no longer writes one. A sheet saved BEFORE that rule is still data every reader must count by the same bench
  // rule, so for those sports the bench rows go in the way the old door wrote them: straight into `lineups`.
  const noBench = lineupCatalogFor(m, {}).lineup.benchMax === 0;
  const viaDoor = rows.flatMap((r, i) => (noBench && r.slot === "bench" ? [] : [{ r, i }]));
  const legacy = rows.flatMap((r, i) => (noBench && r.slot === "bench" ? [{ r, i }] : []));
  await putLineup(auth, fixtureId, entrantId, {
    slots: viaDoor.map(({ r, i }) => ({ person_id: r.personId, slot: r.slot, position_key: null, order_no: i + 1, roles: [], role: r.role })),
  } as never);
  for (const { r, i } of legacy) {
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no, role)
      values (${fixtureId}, ${entrantId}, ${r.personId}, ${auth.orgId}, 'bench', ${i + 1}, ${r.role})`;
  }
}

async function claim(personId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`r122-${randomUUID().slice(0, 12)}@test.local`}, 'R122', true) returning id`;
  await sql`update persons set user_id = ${id} where id = ${personId}`;
  return id;
}

type Asked = { byPerson: number; byUser: number; lines: number; career: number; me: number };
type Scene = { divisionId: string; competitionId: string; compSlug: string; sportKey: string };
/** One person through the five readers. Each org and each claimed user holds this one division of the sport, so a
 *  career card's match count is the division's. */
async function ask(auth: AuthCtx, personId: string, userId: string, d: Scene, orgSlug: string): Promise<Asked> {
  const byPerson = await careerMatchesByDivision(sql, { by: "person", personId }, [d.divisionId]);
  const byUser = await careerMatchesByDivision(sql, { by: "claimedPersons", userId }, [d.divisionId]);
  const lines = await readPlayerMatchLines(sql, { personId, competitionId: d.competitionId, orgSlug, compSlug: d.compSlug, locale: "en" });
  const card = (sports: { sport_key: string; matches: number }[]) => sports.find((s) => s.sport_key === d.sportKey)?.matches ?? 0;
  return {
    byPerson: byPerson.get(d.divisionId)?.matches ?? 0,
    byUser: byUser.get(d.divisionId)?.matches ?? 0,
    lines: lines.filter((l) => l.result !== "live").length,
    career: card((await personCareerStats(auth, personId)).sports),
    me: card(await listMyCareerStats(userId)),
  };
}
const every = (n: number): Asked => ({ byPerson: n, byUser: n, lines: n, career: n, me: n });

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

  it("every team sport: coach and staff get 0; a recorded lineup credits only its players, a bench row by the bench rule; no lineup credits the roster's players; a player added after a lineup-less fixture still gets it (ruling 122's accepted residue) — five readers agree", async () => {
    const { auth, orgSlug } = await seedOrg();
    const n = { sports: 0, persons: 0, asked: 0, zeroes: 0, residue: 0, leavers: 0, duals: 0 };
    for (const m of TEAM_SPORTS) {
      const d = await seedDivision(auth, m);
      const p = {
        rosterPlayer: await person(auth, `${m.key} Roster Player`, "player"),
        starter: await person(auth, `${m.key} Starter`, "player"),
        bench: await person(auth, `${m.key} Bench`, "player"),
        sheetCoach: await person(auth, `${m.key} Sheet Coach`, "player"),
        coach: await person(auth, `${m.key} Coach`, "coach"),
        staff: await person(auth, `${m.key} Staff`, "staff"),
        leaver: await person(auth, `${m.key} Leaver`, "player"),
        dual: await person(auth, `${m.key} Dual`, "player"),
        oppPlayer: await person(auth, `${m.key} Opp Player`, "player"),
        oppCoach: await person(auth, `${m.key} Opp Coach`, "coach"),
        late: await person(auth, `${m.key} Late`, "player"),
      };
      const squad = [p.rosterPlayer, p.starter, p.bench, p.sheetCoach, p.coach, p.staff, p.leaver, p.dual];
      const mine = await entrant(auth, d.divisionId, "team", `${m.key} Mine`, squad);
      // Dual is on BOTH teams of the division.
      const theirs = await entrant(auth, d.divisionId, "team", `${m.key} Theirs`, [p.oppPlayer, p.oppCoach, p.dual]);

      // F1: no lineup on either side. F2: Mine records a sheet — a starter, a bench player, a squad player the sheet
      // names as coach, the registered coach on the bench as coach, staff as staff, and the leaver as a starter;
      // Theirs records none. Then the leaver leaves Mine's roster and the late player joins it. F3: Mine records a
      // sheet with the starter and, on the bench, the late player and Dual; Theirs none.
      const f1 = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
      const f2 = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
      await sheet(auth, f2, mine, [
        { personId: p.starter, slot: "starting", role: "player" },
        { personId: p.bench, slot: "bench", role: "player" },
        { personId: p.sheetCoach, slot: "starting", role: "coach" },
        { personId: p.coach, slot: "bench", role: "coach" },
        { personId: p.staff, slot: "bench", role: "staff" },
        { personId: p.leaver, slot: "starting", role: "player" },
      ], m);
      await settle(f1);
      await settle(f2);
      await patchEntrant(auth, mine, { members: [...squad.filter((id) => id !== p.leaver), p.late].map(member) } as never);
      const f3 = await scheduledFixture(d.stageId, d.divisionId, mine, theirs);
      await sheet(auth, f3, mine, [
        { personId: p.starter, slot: "starting", role: "player" },
        { personId: p.late, slot: "bench", role: "player" },
        { personId: p.dual, slot: "bench", role: "player" },
      ], m);
      await settle(f3);
      const [{ count: sheetRows }] = await sql<{ count: number }[]>`
        select count(*)::int as count from lineups where fixture_id in (${f1}, ${f2}, ${f3})`;
      expect(sheetRows, `${m.key}: premise — the sheets were stored on F2 and F3, Mine's side only`).toBe(9);
      const [{ count: leaverRows }] = await sql<{ count: number }[]>`
        select count(*)::int as count from entrant_members where person_id = ${p.leaver}`;
      expect(leaverRows, `${m.key}: premise — the leaver is on no roster`).toBe(0);

      // Expected, per fixture, from ruling 122's text; a bench row from the bench rule's own declaration — none of
      // these bench players batted or bowled (the ledgers hold only their opening row), so no figures.
      const B = benchRowIsAppearance(m.key, undefined) ? 1 : 0;
      const expected: Record<keyof typeof p, number> = {
        rosterPlayer: 1 + 0 + 0, // F1: a roster player, no lineup. F2, F3: a lineup was recorded and does not name them.
        starter: 1 + 1 + 1, // F1: roster player. F2, F3: in the lineup as a starting player.
        bench: 1 + B + 0, // F1: roster player. F2: on the bench — the bench rule. F3: not on the sheet.
        sheetCoach: 1 + 0 + 0, // F1: a roster player. F2: in the lineup as coach — "coach and staff never get one".
        coach: 0 + 0 + 0, // a coach never gets a match: roster, or a coach on the lineup's bench.
        staff: 0 + 0 + 0, // nor staff.
        leaver: 0 + 1 + 0, // F1: no lineup, and no longer on the roster (it stores no dates). F2: a starting player on the sheet.
        // On both teams, read once per fixture: F1 once, not twice; F2 by Theirs' roster (no lineup there); F3 the same —
        // a roster stand-in outranks Mine's bench row, so the side that credits them is the one read.
        dual: 1 + 1 + 1,
        oppPlayer: 1 + 1 + 1, // Theirs recorded no lineup: the roster's players get every fixture.
        oppCoach: 0 + 0 + 0, // the roster's coach gets none.
        late: 1 + 0 + B, // ACCEPTED RESIDUE: F1 had no lineup and no join date is stored. F2: not named. F3: the bench rule.
      };
      for (const [role, personId] of Object.entries(p) as [keyof typeof p, string][]) {
        const userId = await claim(personId);
        expect(await ask(auth, personId, userId, d, orgSlug), `${m.key} / ${role}`).toEqual(every(expected[role]));
        n.persons++;
        n.asked += 5;
        if (expected[role] === 0) n.zeroes++;
      }
      if (expected.late >= 1) n.residue++;
      if (expected.leaver === 1) n.leavers++;
      if (expected.dual === 3) n.duals++;
      n.sports++;
    }
    // Anti-vacuity: every team sport the engine declares, each person through all five readers.
    expect(n.sports).toBe(TEAM_SPORTS.length);
    expect(n.persons).toBe(TEAM_SPORTS.length * 11);
    expect(n.asked).toBe(TEAM_SPORTS.length * 11 * 5);
    expect(n.zeroes).toBe(TEAM_SPORTS.length * 3);
    expect([n.residue, n.leavers, n.duals]).toEqual([TEAM_SPORTS.length, TEAM_SPORTS.length, TEAM_SPORTS.length]);
  }, 600_000);

  it("every individual-entrant sport is unchanged: the roster credits whoever is on it, whatever their lane or a sheet says — five readers agree", async () => {
    const { auth, orgSlug } = await seedOrg();
    const n = { sports: 0, persons: 0, singles: 0, pairs: 0 };
    for (const m of NON_TEAM_SPORTS) {
      const d = await seedDivision(auth, m);
      if (kindsOf(m).includes("individual")) {
        // A person registered under the coach lane, on an individual entrant whose sheet names them as coach:
        // credited by the roster as always — neither the lane nor a sheet is read for an individual side.
        const solo = await person(auth, `${m.key} Solo`, "coach");
        const rival = await person(auth, `${m.key} Rival`, "player");
        const soloE = await entrant(auth, d.divisionId, "individual", "Solo", [solo]);
        const rivalE = await entrant(auth, d.divisionId, "individual", "Rival", [rival]);
        const f = await scheduledFixture(d.stageId, d.divisionId, soloE, rivalE);
        await sheet(auth, f, soloE, [{ personId: solo, slot: "bench", role: "coach" }], m);
        await settle(f);
        for (const personId of [solo, rival]) {
          expect(await ask(auth, personId, await claim(personId), d, orgSlug), `${m.key}: individual`).toEqual(every(1));
          n.persons++;
        }
        n.singles++;
      }
      if (kindsOf(m).includes("pair")) {
        const a = await person(auth, `${m.key} Pair A`, "player");
        const b = await person(auth, `${m.key} Pair B`, "staff");
        const c = await person(auth, `${m.key} Pair C`, "player");
        const e = await person(auth, `${m.key} Pair D`, "player");
        const ab = await entrant(auth, d.divisionId, "pair", "AB", [a, b]);
        const ce = await entrant(auth, d.divisionId, "pair", "CE", [c, e]);
        const f = await scheduledFixture(d.stageId, d.divisionId, ab, ce);
        // A pair sheet naming only A: B is still credited by the pair's roster.
        await sheet(auth, f, ab, [{ personId: a, slot: "starting", role: "player" }], m);
        await settle(f);
        for (const personId of [a, b]) {
          expect(await ask(auth, personId, await claim(personId), d, orgSlug), `${m.key}: pair`).toEqual(every(1));
          n.persons++;
        }
        n.pairs++;
      }
      n.sports++;
    }
    // Anti-vacuity: every sport with an individual or pair kind, each kind it declares.
    expect(n.sports).toBe(NON_TEAM_SPORTS.length);
    expect(n.singles).toBe(INDIVIDUAL_SPORTS.length);
    const pairSports = NON_TEAM_SPORTS.filter((m) => kindsOf(m).includes("pair")).length;
    expect(n.pairs).toBe(pairSports);
    expect(pairSports).toBeGreaterThan(0);
    expect(n.persons).toBe(INDIVIDUAL_SPORTS.length * 2 + pairSports * 2);
  }, 600_000);
});
