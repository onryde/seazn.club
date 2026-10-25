// The D17 state, built through the real usecases (T17B fix 2; the organiser's re-open of a board our side closed with no game).
// Shared by the reader's tests (open-round-view.test.ts) and the Arbiter Panel's (arbiter-panel-d17.test.tsx), so the state they
// read is one state: neither builds a hand fixture of "a re-armed board".
import { expect } from "vitest";
import { sql } from "@/lib/db";
import { resolveExternalPlay } from "../external-play/resolve";
import { scoreEvent } from "../scoring";
import type { SeedOnlineChessRoundResult } from "./_external-play-seed";

const lastEvent = async (fixtureId: string) =>
  (await sql<{ id: string; seq: number }[]>`select id, seq from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!;

/** The arbiter's No result (the real resolve), then the organiser's undo on the match page (the real void): the board is playable again. */
export async function noResultThenVoid(r: Pick<SeedOnlineChessRoundResult, "owner">, fixtureId: string) {
  expect(await resolveExternalPlay(r.owner, fixtureId, "no_result")).toEqual({ status: "finished" });
  const last = await lastEvent(fixtureId);
  await scoreEvent(r.owner, fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
  const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  expect(["scheduled", "in_play"], "premise: the void made the board playable again").toContain(fx!.status);
  const [b] = await sql<{ status: string; challenge_id: string | null; create_sent_at: Date | null }[]>`
    select status, challenge_id, create_sent_at from fixture_external_play where fixture_id = ${fixtureId}`;
  expect([b?.status, b?.challenge_id, b?.create_sent_at], "premise: closed, no game").toEqual(["finished", null, null]);
}

/** A neighbour DECIDED on the pad (the real scoring usecase): a Start, then a result. */
export async function decide(r: Pick<SeedOnlineChessRoundResult, "owner">, b: SeedOnlineChessRoundResult["boards"][number]) {
  await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(r.owner, b.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.home.entrantId, method: "resign" } });
  const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${b.fixtureId}`;
  expect(["scheduled", "in_play"], "premise: the neighbour is decided").not.toContain(fx!.status);
}
