import "server-only";
// server/video/organiser-replays.ts — the organiser's side of a fixture's Seazn replays (Task 25; Task 26 adds the delete here).
//
//   fixtureSeaznReplays(orgId, fixtureId)  the fixture stream panel's list: each part the replay move made (fixture_video_replays),
//                                          by its STORED number, in the organiser's three words. Org-scoped: the fixture must be
//                                          the org's (another org's read is 404, never an empty list, as the session view's is),
//                                          and so must every row. A removed part (`deleted`, or the organiser's delete, which sets
//                                          `deleted_at` before the state moves) is not listed. It rides the session view
//                                          (`currentSession().seaznReplays`), which the panel already polls.
//
// The words: `processing` while the move is on its way (found, downloading, fetching, encoding), `playable` once the copy is
// verified, `failed` when it failed its check. A state outside REPLAY_ROW_STATES (V542's CHECK forbids one) is refused by name.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { ReplayRowState } from "./domain/replay-move";

export type OrganiserReplayState = "processing" | "playable" | "failed";
export interface OrganiserReplay {
  id: string;
  partNo: number;
  state: OrganiserReplayState;
  lengthSeconds: number | null;
}

/** A row state with no organiser word: one V542's CHECK does not admit, or `deleted` (never listed). */
export class UnknownOrganiserReplayState extends Error {
  override readonly name = "UnknownOrganiserReplayState";
  constructor(state: string) {
    super(`a fixture_video_replays state with no organiser word: ${JSON.stringify(state)}`);
  }
}

const WORD_OF: Record<Exclude<ReplayRowState, "deleted">, OrganiserReplayState> = {
  found: "processing",
  downloading: "processing",
  fetching: "processing",
  encoding: "processing",
  playable: "playable",
  failed: "failed",
};

export function organiserReplayState(state: string): OrganiserReplayState {
  if (!Object.hasOwn(WORD_OF, state)) throw new UnknownOrganiserReplayState(state);
  return WORD_OF[state as keyof typeof WORD_OF];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fixtureSeaznReplays(orgId: string, fixtureId: string): Promise<OrganiserReplay[]> {
  if (!UUID.test(fixtureId)) throw new HttpError(404, "fixture not found");
  // One read: the fixture (scoped to the org through its competition) and its listed rows. No fixture row: 404.
  const rows = await sql<{ id: string | null; part_no: number | null; state: string | null; length_seconds: number | null }[]>`
    select r.id, r.part_no, r.state, r.length_seconds
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id and c.org_id = ${orgId}
      left join fixture_video_replays r
        on r.fixture_id = f.id and r.org_id = ${orgId} and r.state <> 'deleted' and r.deleted_at is null
     where f.id = ${fixtureId}
     order by r.part_no`;
  if (rows.length === 0) throw new HttpError(404, "fixture not found");
  return rows
    .filter((r): r is { id: string; part_no: number; state: string; length_seconds: number | null } => r.id !== null)
    .map((r) => ({ id: r.id, partNo: r.part_no, state: organiserReplayState(r.state), lengthSeconds: r.length_seconds }));
}
