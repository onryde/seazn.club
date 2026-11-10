import "server-only";
// Shared lookups: a fixture's org and competition, and its active session (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ACTIVE_STATES } from "@/server/relay/domain/session";

export async function fixtureContext(fixtureId: string): Promise<{ orgId: string; competitionId: string }> {
  const [row] = await sql<{ org_id: string; competition_id: string }[]>`
    select c.org_id, c.id as competition_id from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${fixtureId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  return { orgId: row.org_id, competitionId: row.competition_id };
}

export async function activeSessionIdFor(fixtureId: string, exec: Tx | typeof sql = sql): Promise<string | null> {
  const [row] = await exec<{ id: string }[]>`
    select id from fixture_stream_sessions where fixture_id = ${fixtureId} and state in ${sql([...ACTIVE_STATES])} limit 1`;
  return row?.id ?? null;
}
