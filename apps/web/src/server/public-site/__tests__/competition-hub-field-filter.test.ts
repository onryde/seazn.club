// F10 (2026-09-21), the hub's half — `loadCompetitionHub` against real
// Postgres, with one entrant of EACH departed status in the division.
//
// V412 widened `public_entrants_v` to publish departed entrants, so
// `getPublicDivision`'s `entrants` now carries them and the hub's name/badge/
// colour maps can resolve a side that a result mentions. The flip side is that
// the two hub consumers meaning "who is competing" — the Teams cards and the
// squad lists behind them — now filter for themselves (`entrants.filter(
// inTheField)` in competition-hub.ts). This file drives the REAL loader over a
// real scene and pins both halves at once:
//
//   nameable   — a match she actually played still prints her NAME. The hub's
//                fallback for an unresolvable side is "?" (the division page's
//                was the raw UUID that started all this).
//   not in the field — no Teams card, and no squad line: `divisionSquads` is
//                given `field`, so her roster is never even read, which shows
//                up as a ban of hers carrying no public person id while an
//                in-field player's ban carries one.
//
// Real Postgres required; skipped without DATABASE_URL, the same convention
// and the same seeding shape as `competition-hub-db.test.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Passthrough, never a memoising double — the hub reads the same division
// through `getPublicDivision` for every assertion in this file.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { FIELD_ENTRANT_STATUSES } from "@/lib/entrant-field";
import { isRestBye } from "@/lib/fixture-bye";
import { EntrantStatus } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;

const STAYING = ["Ada Stays", "Bo Stays", "Cyd Stays"] as const;

/** BOTH ways out of a field, in the one scene.
 *
 *  This file used to seed a single WITHDRAWAL, which proved the hub's filter
 *  for half the vocabulary: replacing `entrants.filter(inTheField)` with
 *  `entrants.filter((e) => e.status !== "withdrawn")` changed nothing it could
 *  see and survived 754 tests, so a DISQUALIFIED entrant would have kept her
 *  Teams card and her squad line on the public competition hub (independent
 *  mutation campaign B14, 2026-09-21). Every assertion below is driven over
 *  both, and the premise row checks the pair against the product's own
 *  departed vocabulary so a fifth status reds here rather than arriving
 *  untested. */
const DEPARTURES = [
  { name: "Dee Departs", status: "withdrawn" },
  { name: "Eve Expelled", status: "disqualified" },
] as const;

interface Departure {
  name: string;
  status: string;
  /** The entrant (and person) given that status AFTER the fixtures were
   *  generated, so her matches survive her. */
  entrantId: string;
  personId: string;
  /** Fixtures she is a side of. Non-empty by assertion. */
  fixtureIds: string[];
}

interface Scene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divisionId: string;
  divisionSlug: string;
  /** One per entry in `DEPARTURES`, in the same order. */
  departed: Departure[];
  /** An entrant who stays, and whose person carries a ban too — the positive
   *  pair for every "she is missing" assertion below. */
  stayEntrantId: string;
  stayPersonId: string;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  // Pro: `dashboard.player_profiles` is what lets `public_entrants_v` publish
  // a member's person id, and a null id on BOTH arms would make the squad
  // assertion below pass vacuously.
  const { auth } = await seedOrg("pro");
  const orgId = auth.orgId;
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${orgId}`;
  const suffix = randomUUID().slice(0, 8);

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Hub Field Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });

  const seat = async (fullName: string, n: number): Promise<{ entrantId: string; personId: string }> => {
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, ${fullName}, ${sql.json({ public_name: true })})
      returning id`;
    const [{ id: entrantId }] = await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: fullName,
        seed: n,
        members: [
          { person_id: personId, squad_number: n, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    return { entrantId, personId };
  };

  const stayers = [];
  for (const [i, name] of STAYING.entries()) stayers.push(await seat(name, i + 1));
  const leaving = [];
  for (const [i, d] of DEPARTURES.entries()) {
    leaving.push({ ...d, ...(await seat(d.name, STAYING.length + 1 + i)) });
  }

  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const departed: Departure[] = leaving.map((d) => ({
    ...d,
    // Her MATCHES. #850: a five-entrant league also rests her one round on a
    // settled rest-bye row, and the hub lists matches, never a bye
    // (owner ruling 2026-09-24) — so that row is not one the hub must name.
    fixtureIds: fixtures
      .filter((f) => f.home_entrant_id === d.entrantId || f.away_entrant_id === d.entrantId)
      .filter((f) => !isRestBye(f, "league"))
      .map((f) => f.id),
  }));

  // An ACTIVE ban each side of the line. The stayer's proves the squad read
  // ran and resolved a public person id; each departed player's is the one
  // that must NOT resolve one, because her roster is never read at all.
  for (const who of [...departed, stayers[0]!]) {
    await sql`
      insert into suspensions (org_id, division_id, person_id, entrant_id, status, source, reason, matches_total)
      values (${orgId}, ${division.id}, ${who.personId}, ${who.entrantId}, 'active', 'manual', 'test ban', 2)`;
  }

  // LAST, and only now: the fixtures above already name them, which is the
  // whole point — a departure settles what is left and leaves what was
  // played. Written straight onto the row for the reason
  // `public-entrants-departed.test.ts` states beside the same line, and
  // `disqualified` has no product path from here at all.
  for (const d of departed) {
    await sql`update entrants set status = ${d.status} where id = ${d.entrantId}`;
  }

  return {
    orgId,
    orgSlug,
    compSlug: competition.slug,
    divisionId: division.id,
    divisionSlug: division.slug,
    departed,
    stayEntrantId: stayers[0]!.entrantId,
    stayPersonId: stayers[0]!.personId,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (scene?.orgId) {
    await sql`delete from organizations where id = ${scene.orgId}`.catch(() => undefined);
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("loadCompetitionHub — a departed entrant is named, but is not the field", () => {
  it("premise: the scene seeds EVERY way out of the field, and each one is in matches", () => {
    // Derived from the product's vocabulary, not typed: a fifth departure
    // status reds here rather than reaching the hub untested. Without this,
    // the rows below prove the filter only for the statuses that happen to be
    // seeded — which is exactly how `disqualified` went unproven.
    const departedVocabulary = EntrantStatus.options.filter(
      (s) => !FIELD_ENTRANT_STATUSES.includes(s),
    );
    expect(departedVocabulary.length, "no status in the vocabulary is a departure").toBeGreaterThanOrEqual(2);
    expect(scene.departed.map((d) => d.status).toSorted()).toEqual([...departedVocabulary].toSorted());
    for (const d of scene.departed) {
      expect(d.fixtureIds.length, `${d.status}: she is in no match, so nothing below witnesses anything`).toBeGreaterThan(0);
    }
  });

  it("NAMEABLE: every match she played still prints her display name, never '?'", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    for (const d of scene.departed) {
      const hers = doc.matches.filter((m) => m.header.sides.some((s) => s.entrantId === d.entrantId));
      expect(hers.map((m) => m.fixtureId).toSorted(), `${d.status}: her matches`).toEqual(
        [...d.fixtureIds].toSorted(),
      );
      for (const match of hers) {
        const side = match.header.sides.find((s) => s.entrantId === d.entrantId)!;
        expect(side.name, `${d.status}: her side is unnameable`).toBe(d.name);
        expect(side.name).not.toBe("?");
      }
    }
    // The positive pair, from the same maps: a stayer reads the same way, so
    // the line above is the widening working rather than a name that would
    // have resolved regardless of status.
    const theirs = doc.matches.flatMap((m) =>
      m.header.sides.filter((s) => s.entrantId === scene.stayEntrantId),
    );
    expect(theirs.length).toBeGreaterThan(0);
    for (const side of theirs) expect(side.name).toBe(STAYING[0]);
  });

  it("TEAM CARDS: neither departure has one; every entrant still in the field does", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    const mine = doc.teams.filter((t) => t.divisionId === scene.divisionId);
    expect(mine.map((t) => t.name).toSorted()).toEqual([...STAYING].toSorted());
    for (const d of scene.departed) {
      expect(
        mine.map((t) => t.entrantId),
        `the ${d.status} entrant still has a Teams card on the public hub`,
      ).not.toContain(d.entrantId);
    }
    expect(mine.map((t) => t.entrantId)).toContain(scene.stayEntrantId);
    // The count line on the division block asks the same question through a
    // different path (`getPublicCompetition`'s subquery), and must agree.
    const block = doc.divisions.find((d) => d.id === scene.divisionId)!;
    expect(block.entrantCount).toBe(STAYING.length);
  });

  it("SQUADS: the departed roster is never read — her ban carries no person id, a stayer's does", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    const block = doc.divisions.find((d) => d.id === scene.divisionId)!;

    // Every ban is published — a departed entrant is still NAMED on the strip,
    // entrant and all. It is her squad that is not resolved, because
    // `divisionSquads` is handed the field, not everyone.
    const bans = block.suspensions ?? [];
    expect(bans).toHaveLength(scene.departed.length + 1); // a departure drops nobody from the strip
    const theirs = bans.find((s) => s.entrantId === scene.stayEntrantId);
    expect(theirs).toBeTruthy();
    expect(theirs!.entrantName).toBe(STAYING[0]);
    // The differential. A null on BOTH arms would mean the entitlement or the
    // consent is what is missing, so the stayer's id is asserted to be real.
    expect(theirs!.personId).toBe(scene.stayPersonId);

    for (const d of scene.departed) {
      const hers = bans.find((s) => s.entrantId === d.entrantId);
      expect(hers, `${d.status}: her ban left the strip`).toBeTruthy();
      expect(hers!.entrantName).toBe(d.name);
      expect(
        hers!.personId,
        `the ${d.status} entrant's roster was read — she is not in the field`,
      ).toBeNull();
      // …and she has no Teams card at all to list a squad line on.
      expect(
        doc.teams.some((t) => t.entrantId === d.entrantId),
        `the ${d.status} entrant still has a squad card`,
      ).toBe(false);
    }

    // And the squad lines themselves: the stayer's card lists her member, so
    // the squad read genuinely ran.
    const stay = doc.teams.find((t) => t.entrantId === scene.stayEntrantId)!;
    expect(stay.members?.map((m) => m.name)).toEqual([STAYING[0]]);
    expect(stay.members?.[0]!.personId).toBe(scene.stayPersonId);
  });
});
