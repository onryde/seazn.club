import "server-only";
// Spectator W2, Task 14 — the Redis keys behind the public player page's poll
// (`publicPlayerMatches`, usecases/public.ts), shared with every writer that
// must retire them: a score write (`invalidatePublicCache`, usecases/scoring.ts)
// and every PERSON or division-policy write that changes what a document may
// show about someone (`retireOrgPlayerMatches` below). Only the database, the cache and the logger
// are imported, so a writer takes the spelling without pulling the reader's
// module graph.
//
// Why a GENERATION and not a glob: the document is keyed per PERSON, and a
// score write knows its fixture, not everyone who played in it. A
// `pub:v1:player-matches:{competitionId}:*` sweep would reach them, but it is a
// SCAN over the whole keyspace on every score write, billed per page. Instead
// every document in a competition embeds that competition's current generation
// token, and a writer DELETES the token — one more name in a DEL it already
// sends. The next read finds no token, mints a fresh one, and misses every
// document keyed under the old one; those age out on their own TTL.
import { sql } from "@/lib/db";
import { cacheDel } from "@/lib/cache";
import { log } from "@/server/logger";

/** The competition's current generation token. Absent → the next reader mints one. */
export function playerMatchesGenKey(competitionId: string): string {
  return `pub:v1:player-matches-gen:${competitionId}`;
}

/** One person's match lines, under one generation of their competition. */
export function playerMatchesKey(competitionId: string, generation: string, personId: string): string {
  return `pub:v1:player-matches:${competitionId}:${generation}:${personId}`;
}

/**
 * Retire every player-matches document in an ORG: one DEL of the generation
 * token of each of its competitions. Called AFTER COMMIT by every writer that
 * changes what those documents may show about a person — their consent, their
 * name, their date of birth (which decides who may change their consent) — and
 * by a merge and its reversal, which rewrite the survivor's consent:
 *  - `setMyConsent` (usecases/me.ts), the player's own door;
 *  - `patchPerson` (usecases/persons.ts), the organiser's, and the ONLY door
 *    for an under-16, whom `setMyConsent` refuses;
 *  - `mergePersons` / `reverseMerge` (usecases/person-merge.ts);
 *  - `patchDivision` (usecases/divisions.ts), when the division's `youth` or
 *    `player_name_display` — the masking policy for its entrants' names —
 *    actually changes.
 * Without it a revoked person's own lines, and their full name as the OPPONENT
 * in everyone else's lines, stay served until the document expires: the
 * reader's consent gate and name masking run only on a cache miss.
 *
 * Scope is the org, not the competitions the person's roster names. Tenancy
 * bounds every source of a person's name in these documents — their own lines
 * come from lineups as well as the roster, and opponent names from any entrant
 * they are a member of — so the org can never be too narrow, where a join here
 * would have to track the reader's. These writes are rare; the cost is one
 * indexed read and ONE DEL.
 *
 * Never rejects: the write it follows has already committed. The competition
 * read is awaited (bounded by Postgres) and logged if it fails; the DEL is sent
 * and not awaited — ioredis has no command timeout, so a Redis that stops
 * answering must not hold the writer's response — and logged if it fails.
 */
export async function retireOrgPlayerMatches(orgId: string, context: Record<string, unknown>): Promise<void> {
  let keys: string[];
  try {
    const competitions = await sql<{ id: string }[]>`select id from competitions where org_id = ${orgId}`;
    keys = competitions.map((c) => playerMatchesGenKey(c.id));
  } catch (err) {
    log.error(
      { err, orgId, ...context },
      "consent: the org's competitions could not be listed for a public Redis delete (the write stands)",
    );
    return;
  }
  void cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, ...context, keys }, "consent: a public Redis delete failed (the write stands)");
  });
}
