// Public hub query perf, T1 (docs/superpowers/specs/2026-09-24-public-hub-query-perf.md)
// — `public_entrants_v` asks the player-profiles entitlement ONCE per entrant
// row, not twice per member, and publishes exactly what it published before.
//
// Prod evidence (pg_stat_statements, 2026-09-18 → 24): the by-division read of
// this view was 12,292 calls at 24 ms mean, and EXPLAIN put almost all of the
// members subplan's time in `org_has_feature(...)` — STABLE SECURITY DEFINER
// with a pinned search_path, so never inlined — called once for the photo arm
// and once for the person_id arm of EVERY consenting member. The answer depends
// only on the competition, so the view now reads it once through a lateral.
//
// The change is perf-only, so the load-bearing claims are about OUTPUT:
//
//  * GRANTED / DENIED — the members array is spelled out here, in both
//    entitlement states: a consenting member carries photo and person_id only
//    while the org holds the feature; a non-consenting member never does. The
//    ORDER (squad_number nulls last, then full_name) is made to disagree with
//    insertion order, with a squad-number tie and an unnumbered member, so an
//    agg that lost its ORDER BY cannot pass by accident. A tombstoned member
//    (`merged_into`) proves the #404 exclusion survived the rewrite. An empty
//    roster (members `[]`) and a roster nobody consents on ride through every
//    test, DIFFERENTIAL included.
//  * DIFFERENTIAL — every column of every row is compared against the
//    definition this migration replaced, read out of V416's own migration FILE
//    (never a hand copy that could drift from what shipped), in both states.
//    Retire or re-point it deliberately if a later migration changes the
//    view's output on purpose.
//  * CALLS — `pg_stat_xact_user_functions` counts `org_has_feature` calls in
//    the test's own transaction. The positive pair runs V416's body the same
//    way and must show the old per-member count, so a counter that silently
//    reads 0 cannot make the "at most once per entrant" bound pass vacuously.
//
// The feature key is read out of the view definition itself — the gate this
// test exercises — and cross-checked against the plan catalog, never typed.
//
// Real Postgres required; skipped without DATABASE_URL, the same convention as
// `public-entrants-show-seeds.test.ts` beside this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");

/** The `select …` body of the definition T1 replaced, straight from the file
 *  that shipped it. Its unqualified names resolve through the pool's own
 *  `search_path`, exactly as the migration's did. */
function v416Body(): string {
  const text = readFileSync(resolve(DELTAS, "V416__division_show_seeds.sql"), "utf8");
  const match = /create or replace view public_entrants_v as\s+([\s\S]*?);\s*$/.exec(text);
  if (!match) throw new Error("V416 no longer defines public_entrants_v — re-point this differential");
  return match[1]!;
}

type Consent = { public_name?: boolean; public_photo?: boolean };
interface Seat {
  fullName: string;
  squad: number | null;
  consent: Consent;
  /** Tombstoned after seeding: must vanish from the roster (#404). */
  merged?: boolean;
}

/** The published order disagrees with BOTH insertion order and plain name
 *  order: Anchors publish Zoe (2) before Adam (9); Breakers publish the
 *  squad-5 tie by name (Bea, Cal) and the unnumbered Abel LAST, although Abel
 *  sorts first by name. An agg ordered by name alone, or by insertion, or with
 *  nulls first, cannot match. (A first seed that let squad order coincide with
 *  name order let an `order by p.full_name` mutant survive.) */
const ROSTERS: { team: string; seats: Seat[] }[] = [
  {
    team: "Anchors",
    seats: [
      { fullName: "Adam Brook", squad: 9, consent: { public_name: false, public_photo: false } },
      { fullName: "Zoe Quinn", squad: 2, consent: { public_name: true, public_photo: true } },
      { fullName: "Tomas Stale", squad: 1, consent: { public_name: true, public_photo: true }, merged: true },
    ],
  },
  {
    team: "Breakers",
    seats: [
      { fullName: "Cal Rivers", squad: 5, consent: { public_name: false, public_photo: false } },
      // Name consent WITHOUT photo consent: the two arms read different keys.
      { fullName: "Abel Vance", squad: null, consent: { public_name: true, public_photo: false } },
      { fullName: "Bea Stone", squad: 5, consent: { public_name: true, public_photo: true } },
    ],
  },
  // The empty set: no roster at all — members must be exactly `[]`.
  { team: "Cavity", seats: [] },
  // Nobody consents (one explicit refusal, one `{}`): V416 never asked the
  // entitlement for this entrant; V418 asks once. The stated trade, pinned in
  // CALLS below rather than left to the migration's prose.
  {
    team: "Decliners",
    seats: [
      { fullName: "Dora Decline", squad: 4, consent: { public_name: false, public_photo: false } },
      { fullName: "Eli Empty", squad: 3, consent: {} },
    ],
  },
];

/** Consent keys that are TRUE across a roster's live seats — each one cost
 *  V416 a call (`consent AND org_has_feature(...)` stops at a false consent). */
const consentingKeys = (seats: readonly Seat[]): number =>
  seats
    .filter((s) => !s.merged)
    .reduce((n, s) => n + (s.consent.public_photo === true ? 1 : 0) + (s.consent.public_name === true ? 1 : 0), 0);

/** `order by em.squad_number nulls last, p.full_name`, spelled out here rather
 *  than read back from the database under test. */
function publishedOrder(seats: readonly Seat[]): Seat[] {
  return seats
    .filter((s) => !s.merged)
    .sort((a, b) => {
      if (a.squad !== b.squad) {
        if (a.squad === null) return 1;
        if (b.squad === null) return -1;
        return a.squad - b.squad;
      }
      return a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0;
    });
}

interface Scene {
  auth: AuthCtx;
  orgId: string;
  divisionId: string;
  featureKey: string;
  personIds: Map<string, string>;
}

let scene: Scene;

async function setFeature(orgId: string, featureKey: string, value: boolean): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${featureKey}, ${value}, 'test')
    on conflict (org_id, feature_key) do update set bool_value = excluded.bool_value`;
  await invalidateOrgEntitlements(orgId);
}

/** The key the view gates photos and person ids on, read from the view. */
async function viewFeatureKey(): Promise<string> {
  const [{ def }] = await sql<{ def: string }[]>`
    select pg_get_viewdef('public_entrants_v'::regclass, true) as def`;
  const keys = new Set([...def.matchAll(/org_has_feature\([^,]+,\s*'([^']+)'/g)].map((m) => m[1]!));
  expect([...keys]).toHaveLength(1);
  return [...keys][0]!;
}

async function seed(): Promise<Scene> {
  const { auth } = await seedOrg("community");
  const orgId = auth.orgId;
  const featureKey = await viewFeatureKey();
  // A real catalog key, not a string the resolver has never heard of.
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from plan_entitlements where feature_key = ${featureKey}`;
  expect(n).toBeGreaterThan(0);

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Once Per Entrant " + randomUUID().slice(0, 8),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });

  const personIds = new Map<string, string>();
  for (const { seats } of ROSTERS) {
    for (const seat of seats) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, dob, gender, photo_path, consent)
        values (${orgId}, ${seat.fullName}, '2000-04-03', 'f',
                ${"photos/" + seat.fullName.replace(/\s+/g, "-")}, ${sql.json(seat.consent as never)})
        returning id`;
      personIds.set(seat.fullName, id);
    }
  }

  await createEntrants(
    auth,
    division.id,
    ROSTERS.map(({ team, seats }, i) => ({
      kind: "team" as const,
      display_name: team,
      seed: i + 1,
      members: seats.map((s) => ({
        person_id: personIds.get(s.fullName)!,
        squad_number: s.squad,
        default_position_key: null,
        is_captain: false,
        roles: [],
      })),
    })),
  );

  // Tombstone AFTER the roster is written — the view, not the write path, is
  // what must drop an absorbed duplicate.
  const survivor = personIds.get("Zoe Quinn")!;
  for (const { seats } of ROSTERS) {
    for (const seat of seats.filter((s) => s.merged)) {
      await sql`update persons set merged_into = ${survivor} where id = ${personIds.get(seat.fullName)!}`;
    }
  }

  return { auth, orgId, divisionId: division.id, featureKey, personIds };
}

/** The members array the view must publish for one roster. Names go through
 *  the database's own `public_person_name` — the masking rule is the view's
 *  authority, not this test's. */
async function expectedMembers(seats: readonly Seat[], entitled: boolean): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const seat of publishedOrder(seats)) {
    const [{ name }] = await sql<{ name: string }[]>`
      select public_person_name(${seat.fullName}, ${sql.json(seat.consent as never)}) as name`;
    out.push({
      name,
      photo: entitled && seat.consent.public_photo === true ? "photos/" + seat.fullName.replace(/\s+/g, "-") : null,
      person_id: entitled && seat.consent.public_name === true ? scene.personIds.get(seat.fullName)! : null,
      squad_number: seat.squad,
      position: null,
    });
  }
  return out;
}

async function readMembers(): Promise<Map<string, unknown[]>> {
  const rows = await sql<{ display_name: string; members: unknown[] }[]>`
    select display_name, members from public_entrants_v
    where division_id = ${scene.divisionId}`;
  return new Map(rows.map((r) => [r.display_name, r.members]));
}

/** `org_has_feature` calls made by one statement, as a DELTA inside one
 *  transaction. Not the raw counter: `pg_stat_xact_user_functions` reads the
 *  backend's pending (unflushed) stats, which still hold an earlier
 *  transaction's calls on the same pooled connection until the idle flush —
 *  a raw read double-counted here (5 + 5 = 10). No flush can happen inside a
 *  transaction block, so the delta is exactly this statement's calls. */
async function featureCalls(statement: string, params: string[] = [scene.divisionId]): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`set local track_functions = 'all'`;
    const read = async (): Promise<number> => {
      const [{ calls }] = await tx<{ calls: number }[]>`
        select coalesce(sum(calls), 0)::int as calls
        from pg_stat_xact_user_functions where funcname = 'org_has_feature'`;
      return calls;
    };
    const start = await read();
    await tx.unsafe(statement, params);
    return (await read()) - start;
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("public_entrants_v — the player-profiles entitlement, once per entrant", () => {
  it("GRANTED: a consenting member carries photo and person_id (each by its OWN consent key), a non-consenting one neither, in squad-number-then-name order, tombstones excluded", async () => {
    await setFeature(scene.orgId, scene.featureKey, true);
    const members = await readMembers();
    expect([...members.keys()].sort()).toEqual(ROSTERS.map((r) => r.team).sort());
    for (const { team, seats } of ROSTERS) {
      expect(members.get(team)).toEqual(await expectedMembers(seats, true));
    }
    // The order, literally, so the sort helper above cannot agree with a wrong
    // database by sharing its mistake.
    const squads = (team: string) => (members.get(team) as { squad_number: number | null }[]).map((m) => m.squad_number);
    expect(squads("Anchors")).toEqual([2, 9]);
    expect(squads("Breakers")).toEqual([5, 5, null]);
    expect((members.get("Breakers") as { name: string }[])[0]!.name).toBe("Bea Stone");
    // The empty roster publishes an empty array — not null, not a missing row.
    expect(members.get("Cavity")).toEqual([]);
    // The positive half is really exercised: something WAS published.
    const anchors = members.get("Anchors") as { person_id: string | null; photo: string | null }[];
    expect(anchors.some((m) => m.person_id !== null && m.photo !== null)).toBe(true);
  });

  it("DENIED: no member carries a photo or a person_id, consent notwithstanding", async () => {
    await setFeature(scene.orgId, scene.featureKey, false);
    const members = await readMembers();
    for (const { team, seats } of ROSTERS) {
      const got = members.get(team) as { photo: unknown; person_id: unknown }[];
      expect(got).toEqual(await expectedMembers(seats, false));
      expect(got.every((m) => m.photo === null && m.person_id === null)).toBe(true);
    }
  });

  it.each([true, false])(
    "DIFFERENTIAL (entitled=%s): every column of every row is identical to the V416 definition it replaced",
    async (entitled) => {
      await setFeature(scene.orgId, scene.featureKey, entitled);
      const now = await sql.unsafe<{ row: unknown }[]>(
        `select to_jsonb(v) as row from public_entrants_v v where v.division_id = $1 order by v.id`,
        [scene.divisionId],
      );
      const before = await sql.unsafe<{ row: unknown }[]>(
        `select to_jsonb(v) as row from (${v416Body()}) v where v.division_id = $1 order by v.id`,
        [scene.divisionId],
      );
      expect(now.length).toBe(ROSTERS.length);
      expect(now.map((r) => r.row)).toEqual(before.map((r) => r.row));
    },
  );

  it("CALLS: org_has_feature runs at most once per entrant row — V416 ran it per consenting member, per arm", async () => {
    await setFeature(scene.orgId, scene.featureKey, true);
    // V416: `consent AND org_has_feature(...)` per arm per member; AND stops at
    // a false consent, so each consent key that is TRUE costs one call.
    const perMemberCalls = ROSTERS.reduce((n, r) => n + consentingKeys(r.seats), 0);

    const before = await featureCalls(
      `select members from (${v416Body()}) v where v.division_id = $1`,
    );
    const after = await featureCalls(`select members from public_entrants_v where division_id = $1`);

    // Positive pair first: the counter sees the old per-member cost.
    expect(before).toBe(perMemberCalls);
    // The fix: bounded by entrant rows, and still consulted at all.
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(ROSTERS.length);
    // A reader that never selects `members` (counts, names, seeds) pays
    // nothing: the planner drops the fenced lateral's unused output.
    expect(
      await featureCalls(`select id, display_name, seed from public_entrants_v where division_id = $1`),
    ).toBe(0);
  });

  it("CALLS per entrant: exactly one call for every entrant row — including the empty and no-consent rosters V416 answered for free (the stated trade)", async () => {
    // One entrant per statement, so the count is the same whichever side of
    // the join the planner evaluates the lateral on.
    await setFeature(scene.orgId, scene.featureKey, true);
    const ids = new Map(
      (
        await sql<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where division_id = ${scene.divisionId}`
      ).map((r) => [r.display_name, r.id]),
    );
    const perEntrant: Record<string, { v416: number; v418: number }> = {};
    for (const { team, seats } of ROSTERS) {
      const id = ids.get(team)!;
      const v416 = await featureCalls(`select members from (${v416Body()}) v where v.id = $1`, [id]);
      const v418 = await featureCalls(`select members from public_entrants_v where id = $1`, [id]);
      perEntrant[team] = { v416, v418 };
      expect(v416, `${team} under V416`).toBe(consentingKeys(seats));
      expect(v418, `${team} under V418`).toBe(1);
    }
    // The trade, literally: the rosters nobody consents on went from free to
    // one call each; the consenting ones went from per-member to one.
    expect(perEntrant["Cavity"]).toEqual({ v416: 0, v418: 1 });
    expect(perEntrant["Decliners"]).toEqual({ v416: 0, v418: 1 });
    expect(perEntrant["Anchors"]!.v416).toBeGreaterThan(1);
  });
});
