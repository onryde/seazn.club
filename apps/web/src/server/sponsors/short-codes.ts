import "server-only";
// server/sponsors/short-codes.ts — R4 sponsors on stream, S5 (owner ruling R7): the code a sponsor card prints as
// `seazn.club/s/<code>`, minted server-side once per (sponsor, fixture) into sponsor_short_codes (V483) and resolved by
// S10's /s/ route to that sponsor, that fixture and `src=stream`.
//
// Only a sponsor with a URL gets one: the code is a link, and a sponsor with nowhere to send a viewer prints nothing
// link-like (S7's card). Minting is idempotent: the pair (sponsor_id, fixture_id) is unique, so a second call — or a
// concurrent poll — reads the code the first one wrote. A code is unique across the whole table (its primary key), so a
// random draw that collides with another pair's code is drawn again, and the code grows a character after
// `SHORT_CODE_DRAWS_PER_LENGTH` collisions at one length (the shortest code a viewer has to type, while it lasts).
//
// PRIVILEGED path, like every overlay read: app_user may only READ the table. The database does not check that the
// sponsor and the fixture are the org's (no composite foreign keys), so the mint checks both, in its own statement.
import { randomInt } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import {
  SPONSOR_SHORT_CODE_ALPHABET,
  SPONSOR_SHORT_CODE_MAX_LENGTH,
  SPONSOR_SHORT_CODE_MIN_LENGTH,
} from "@/lib/sponsor-short-code";

/** Collisions tolerated at one length before the next code is one character longer. */
export const SHORT_CODE_DRAWS_PER_LENGTH = 3;

/** Every draw collided, through the longest length: refused by name, never looped. */
export class ShortCodeExhaustedError extends Error {
  override name = "ShortCodeExhaustedError";
}

/** A sponsor or fixture that is not the minting org's: the mint wrote nothing. */
export class ShortCodeOwnershipError extends Error {
  override name = "ShortCodeOwnershipError";
}

export type ShortCodeDraw = (length: number) => string;

/** A uniform draw from the alphabet (crypto, so codes are not predictable from each other). */
export const drawShortCode: ShortCodeDraw = (length) =>
  Array.from({ length }, () => SPONSOR_SHORT_CODE_ALPHABET[randomInt(SPONSOR_SHORT_CODE_ALPHABET.length)]).join("");

/** For these sponsors of the org on this fixture: the codes already minted, and the sponsors that have a URL and no code
 *  yet. A sponsor without a URL is in neither — it prints no link, even if it once had a code. One read. */
export async function shortCodesFor(
  exec: Tx | typeof sql,
  a: { orgId: string; fixtureId: string; sponsorIds: readonly string[] },
): Promise<{ codes: Map<string, string>; unminted: string[] }> {
  if (a.sponsorIds.length === 0) return { codes: new Map(), unminted: [] };
  const rows = await exec<{ id: string; code: string | null }[]>`
    select sp.id, c.code from sponsors sp
      left join sponsor_short_codes c on c.sponsor_id = sp.id and c.fixture_id = ${a.fixtureId}
     where sp.org_id = ${a.orgId} and sp.id = any(${a.sponsorIds as string[]}::uuid[]) and sp.url is not null`;
  const codes = new Map<string, string>();
  const unminted: string[] = [];
  for (const r of rows) {
    if (r.code === null) unminted.push(r.id);
    else codes.set(r.id, r.code);
  }
  return { codes, unminted };
}

/**
 * The code for (sponsor, fixture), minting it if it has none. Returns null when the sponsor has no URL (no link to
 * print). Throws `ShortCodeOwnershipError` when the sponsor or the fixture is not `orgId`'s, `ShortCodeExhaustedError`
 * when every draw collided.
 */
export async function mintShortCode(
  a: { orgId: string; sponsorId: string; fixtureId: string },
  draw: ShortCodeDraw = drawShortCode,
): Promise<string | null> {
  for (let length = SPONSOR_SHORT_CODE_MIN_LENGTH; length <= SPONSOR_SHORT_CODE_MAX_LENGTH; length++) {
    for (let attempt = 0; attempt < SHORT_CODE_DRAWS_PER_LENGTH; attempt++) {
      const code = draw(length);
      // One statement: the ownership of both parents, the sponsor's URL, and the insert. `on conflict do nothing` covers
      // BOTH unique keys — the pair already minted (a concurrent poll) and a code another pair holds (a collision).
      const [row] = await sql<{ owned: boolean; linkable: boolean; inserted: string | null }[]>`
        with parents as (
          select (sp.url is not null) as linkable
            from sponsors sp join fixtures f on f.id = ${a.fixtureId} and f.org_id = sp.org_id
           where sp.id = ${a.sponsorId} and sp.org_id = ${a.orgId}
        ), ins as (
          insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id)
          select ${code}, ${a.orgId}, ${a.sponsorId}, ${a.fixtureId} from parents where linkable
          on conflict do nothing
          returning code
        )
        select exists (select 1 from parents) as owned,
               coalesce((select linkable from parents), false) as linkable,
               (select code from ins) as inserted`;
      if (!row!.owned) throw new ShortCodeOwnershipError(`sponsor ${a.sponsorId} or fixture ${a.fixtureId} is not org ${a.orgId}'s`);
      if (!row!.linkable) return null;
      if (row!.inserted !== null) return row!.inserted;
      const [held] = await sql<{ code: string }[]>`
        select code from sponsor_short_codes where sponsor_id = ${a.sponsorId} and fixture_id = ${a.fixtureId}`;
      if (held !== undefined) return held.code;
      // Neither ours nor inserted: the draw is another pair's code. Draw again.
    }
  }
  throw new ShortCodeExhaustedError(
    `no free short code for sponsor ${a.sponsorId} on fixture ${a.fixtureId} after ` +
      `${(SPONSOR_SHORT_CODE_MAX_LENGTH - SPONSOR_SHORT_CODE_MIN_LENGTH + 1) * SHORT_CODE_DRAWS_PER_LENGTH} draws`,
  );
}
