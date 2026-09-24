// Shared DB rig for the scorer-sheet suites (T4 carried-forward, T6 scan page,
// T7/T8 sheets). Real use-cases end to end — never hand-inserted fixtures —
// so feeds, Swiss rounds and stage status are what the product writes.
import { randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createDeviceLink } from "../device-links";
import { GENERIC_CONFIG } from "./_seed";

// Every mint seals (scorer sheets §4.1), so a key must exist. A throwaway key
// of the rig's own, stubbed UNCONDITIONALLY — never `??=` a developer's
// .env.local one: CI's unit job has no DEVICE_LINK_KEK at all, so an ambient
// key (or a malformed one) would make a local run test something CI cannot.
//
// CALLERS: `vi.unstubAllEnvs()` in `afterAll` ONLY — never in `afterEach`. The
// stub runs ONCE, when this module is imported; an afterEach unstub strips the
// key after the first test, and every later mint in the file fails
// 503 DEVICE_LINK_KEK_MISSING (or seals with an ambient key CI never has).
vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

export type RigStageKind = "league" | "knockout" | "swiss" | "page_playoff";

export interface RigFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
}

export async function seedStage(
  auth: AuthCtx,
  kind: RigStageKind,
  names: string[],
  config: Record<string, unknown> = {},
  /** T7/T8: real roster members (inline `new_person`), so name resolution is exercised. */
  opts: { entrantKind?: "individual" | "team"; members?: (name: string) => string[] } = {},
) {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Sheets ${kind} ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    names.map((n, i) => ({
      kind: opts.entrantKind ?? ("individual" as const),
      display_name: n,
      seed: i + 1,
      members: (opts.members?.(n) ?? []).map((full_name) => ({
        new_person: { full_name },
        is_captain: false,
        roles: [],
      })),
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  // Swiss (shell fixtures, 2026-09-18): the FIRST Generate only mints empty
  // shells for every declared round and seats nobody; round 1 is seated by the
  // next Generate — the desk's Pair button — after the start, exactly as
  // swiss-shell-fixtures.test.ts drives it.
  if (kind === "swiss") await generateStageFixtures(auth, stage!.id);
  return { competition, division, stage: stage! };
}

export async function fixturesOf(stageId: string): Promise<RigFixture[]> {
  return sql<RigFixture[]>`
    select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id,
           winner_to_fixture, winner_to_slot
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** Swiss pairs the next round through the same call the desk's Pair button makes. */
export async function pairNextSwissRound(auth: AuthCtx, stageId: string): Promise<void> {
  await generateStageFixtures(auth, stageId);
}

/** A device-link actor for the fixture, through the real bearer door. */
export async function deviceFor(owner: AuthCtx, fixtureId: string): Promise<AuthCtx> {
  const link = await createDeviceLink(owner, fixtureId, null);
  const req = new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${link.secret}` } });
  return requireFixtureActor(req, fixtureId, "score");
}

async function tipSeq(fixtureId: string): Promise<number> {
  const [{ seq }] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}`;
  return seq;
}

/** core.start (if needed) + a 2–1 generic result by `actor`; the result event's id. */
export async function decide(actor: AuthCtx, fixtureId: string): Promise<string> {
  let seq = await tipSeq(fixtureId);
  if (seq === 0) {
    await scoreEvent(actor, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    seq = 1;
  }
  await scoreEvent(actor, fixtureId, {
    expected_seq: seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  const [{ id }] = await sql<{ id: string }[]>`
    select id from score_events where fixture_id = ${fixtureId} and type = 'generic.result'
    order by seq desc limit 1`;
  return id;
}

export async function voidEvent(actor: AuthCtx, fixtureId: string, eventId: string) {
  return scoreEvent(actor, fixtureId, {
    expected_seq: await tipSeq(fixtureId),
    type: "core.void",
    payload: { event_id: eventId },
  });
}
