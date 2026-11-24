// A SECOND competition of an existing seed's organisation (test seed). The billing freeze is per COMPETITION of an org, so a test that
// shows the freeze takes one competition and spares another needs two of them under one org: `seedOnlineChessRound` always makes a new org,
// this adds a competition to the org it made. The competition holds one online (Lichess) division, STARTED, with one paired, unopened round 1.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { CameraPolicy } from "@/lib/camera-policy";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { startDivision } from "../schedule";
import { createStagesOnLegacyOnline } from "./_legacy-online-stage";
import { seedLinkedPair, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

export type SecondOnlineRound = {
  competitionId: string;
  divisionId: string;
  stageId: string;
  roundNo: 1;
  boards: SeedRoundBoard[];
};

export async function seedSecondOnlineRound(
  a: Pick<SeedOnlineChessRoundResult, "owner" | "orgId">,
  opts: { scheduledAt: Date; cameraPolicy?: CameraPolicy },
): Promise<SecondOnlineRound> {
  const competition = await createCompetition(a.owner, {
    name: "Second Cup",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(a.owner, competition.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 8),
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
    ...(opts.cameraPolicy ? { camera_policy: opts.cameraPolicy } : {}),
  });
  const pair = await seedLinkedPair(a.owner, division.id);
  const [stage] = await createStagesOnLegacyOnline(a.owner, division.id, { seq: 1, kind: "league", name: "RR", config: {} });
  const [board] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage!.id}, ${division.id}, ${a.orgId}, 1, 1, ${"o4-" + randomUUID().slice(0, 8)}, 'scheduled', ${pair.home.entrantId}, ${pair.away.entrantId}, ${opts.scheduledAt})
    returning id`;
  await startDivision(a.owner, division.id);
  return {
    competitionId: competition.id,
    divisionId: division.id,
    stageId: stage!.id,
    roundNo: 1,
    boards: [{ fixtureId: board!.id, home: pair.home, away: pair.away }],
  };
}
