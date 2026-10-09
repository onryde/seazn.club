import "server-only";
import { sql } from "@/lib/db";
import type { PublicExternalPlay } from "@/server/external-play/public-view";

/** Privileged read of the public-safe bridge status for a fixture (or null).
 *  Status ONLY: every other column is either gone with the lichess.org mode
 *  or operator-facing (`last_error`). Runs for every public fixture page, so a
 *  column named here that the table lacks errors every one of them. */
export async function loadPublicExternalPlay(
  fixtureId: string,
): Promise<PublicExternalPlay | null> {
  const [row] = await sql<{ status: PublicExternalPlay["status"] }[]>`
    select status
      from fixture_external_play
     where fixture_id = ${fixtureId}`;
  if (!row) return null;
  return { status: row.status };
}
