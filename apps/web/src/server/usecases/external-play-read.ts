import "server-only";
import { sql } from "@/lib/db";
import type { PublicExternalPlay } from "@/server/external-play/public-view";

/** Privileged read of the public-safe bridge row for a fixture (or null). */
export async function loadPublicExternalPlay(
  fixtureId: string,
): Promise<PublicExternalPlay | null> {
  const [row] = await sql<
    {
      status: PublicExternalPlay["status"];
      play_url: string | null;
      white_play_url: string | null;
      black_play_url: string | null;
      last_error: string | null;
    }[]
  >`
    select status, play_url, white_play_url, black_play_url, last_error
      from fixture_external_play
     where fixture_id = ${fixtureId}`;
  if (!row) return null;
  return {
    status: row.status,
    playUrl: row.play_url,
    whitePlayUrl: row.white_play_url,
    blackPlayUrl: row.black_play_url,
    lastError: row.last_error,
  };
}
