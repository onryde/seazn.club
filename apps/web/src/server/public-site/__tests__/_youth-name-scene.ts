// Shared DB seed for the youth name-policy suites (privacy hotfix,
// 2026-09-16). One Pro org, one PUBLIC competition with two divisions, and a
// second UNLISTED competition the youth player is NOT rostered in:
//
//   youth  — `divisions.youth = true`, `player_name_display` left NULL, so
//            `resolveNameDisplay` resolves it to first_initial. "Arun Kumar"
//            is rostered here WITH public-name and public-photo consent —
//            RS007's default for a registered player, i.e. the normal case.
//   open   — an adult division, no policy. "Dev Patel", same consent. The
//            positive pair for every negative: the full name, the photo and
//            the player-page link must all still be there.
//
// Both players carry an ACTIVE suspension in their own division, so the
// division page's suspensions strip has a row for each.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";

export interface ScenePlayer {
  divisionId: string;
  divisionSlug: string;
  entrantId: string;
  personId: string;
  fullName: string;
  photo: string;
}

export interface YouthNameScene {
  auth: AuthCtx;
  orgId: string;
  orgSlug: string;
  compSlug: string;
  compName: string;
  /** Same org, unlisted, and neither player is rostered in it. */
  otherCompSlug: string;
  youth: ScenePlayer;
  open: ScenePlayer;
}

const GENERIC = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

export const YOUTH_FULL = "Arun Kumar";
export const YOUTH_MASKED = "Arun K.";
export const OPEN_FULL = "Dev Patel";

export async function seedYouthNameScene(): Promise<YouthNameScene> {
  const { auth } = await seedOrg("pro");
  const orgId = auth.orgId;
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${orgId}`;
  const suffix = randomUUID().slice(0, 8);
  const compName = "Youth Policy Cup " + suffix;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: compName,
    visibility: "public",
    branding: {},
  });
  const other = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Other Cup " + suffix,
    visibility: "unlisted",
    branding: {},
  });

  const player = async (divisionName: string, fullName: string, youth: boolean): Promise<ScenePlayer> => {
    const division = await createDivision(auth, comp.id, {
      name: divisionName,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC,
    });
    if (youth) await sql`update divisions set youth = true where id = ${division.id}`;
    const photo = `photos/${divisionName.toLowerCase()}-${suffix}.jpg`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, photo_path, consent)
      values (${orgId}, ${fullName}, ${photo},
              ${sql.json({ public_name: true, public_photo: true })})
      returning id`;
    const [{ id: entrantId }] = await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: fullName,
        seed: 1,
        members: [{ person_id: personId, squad_number: 7, default_position_key: null, is_captain: true, roles: [] }],
      },
    ]);
    await sql`
      insert into suspensions (org_id, division_id, person_id, status, source, reason, matches_total)
      values (${orgId}, ${division.id}, ${personId}, 'active', 'manual', 'test ban', 2)`;
    return { divisionId: division.id, divisionSlug: division.slug, entrantId, personId, fullName, photo };
  };

  const youth = await player("Juniors", YOUTH_FULL, true);
  const open = await player("Seniors", OPEN_FULL, false);
  return { auth, orgId, orgSlug, compSlug: comp.slug, compName, otherCompSlug: other.slug, youth, open };
}

/** postgres.js keeps the pool open; close it so the worker can exit. */
export async function closeSql(): Promise<void> {
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
}
