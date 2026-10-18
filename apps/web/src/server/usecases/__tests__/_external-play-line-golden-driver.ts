// The golden driver (capacity test 18, spec §8.1): ONE board, the check-in line EMPTY, driven through the real room claim against the
// e2e RealtimeKit fixture server, recording the vendor calls the fixture saw at every step.
//
// THIS FILE IS RUN, UNCHANGED, AGAINST TWO TREES: the pre-amendment commit (to record the golden) and the tree under test (to
// compare with it). It therefore imports nothing that only the amended tree has - no line helpers, no `deps.line`, no clock seam
// beyond `deps.now`, which both trees read. Its sha256 is in the fixture's header: editing it without re-recording the golden from
// the pre-amendment commit fails the header test. Nothing in it reads the line.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { sql } from "@/lib/db";
import { REALTIMEKIT_FIXTURE_ENV, type RealtimeKitFixtureServer } from "../../../../e2e/realtimekit-fixture-server";
import { claimRoomSeat, type RoomDeps } from "../external-play/room";
import { seedOnlineChessFixture } from "./_external-play-seed";

// THE REAL CLOCK, deliberately. The pre-amendment tree stamps a check-in with the real time (the amended tree also takes the claim's
// own clock), so a driver that injected a fixed instant would make the two trees disagree about whether the first check-in counted
// - a difference of the harness, not of the product. The round opened five minutes ago; every claim is made now.

export type GoldenStep = { step: string; answer: string; calls: string[]; publishes: number; creates: number };
export type GoldenRecord = { steps: GoldenStep[]; checkedIn: { home: boolean; away: boolean } };

export const driverSha256 = (): string => createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex");

const reasonOf = (seat: { seated: boolean; reason?: string } | null): string => (seat === null ? "none" : seat.seated ? "seated" : String(seat.reason));

/** Drive the board. The caller has started the fixture server (`fx`); this resets it, points RealtimeKit at it and seeds the board. */
export async function driveIdleBoard(fx: RealtimeKitFixtureServer): Promise<{ record: GoldenRecord; fixtureId: string }> {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  const board = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(Date.now() + 10 * 60_000),
    linked: true,
    roundOpenedAt: new Date(Date.now() - 5 * 60_000),
    cameraPolicy: "required",
  });
  const steps: GoldenStep[] = [];
  const held = new Map<string, string>();

  async function claim(step: string, side: "home" | "away", afterJoin?: () => void): Promise<void> {
    afterJoin?.();
    const publish = vi.fn(async () => {});
    const create = vi.fn(async () => ({ created: false as const, reason: "not_ready" as const }));
    const deps = {
      now: new Date(),
      publish,
      create,
      offered: vi.fn(async () => true),
      mintRealtime: vi.fn(async () => "rt-token"),
    } as unknown as RoomDeps;
    const person = board[side];
    const seen = fx.calls.length;
    const got = await claimRoomSeat({ kind: "session", userId: person.userId }, board.fixtureId, deps, { heldParticipantId: held.get(person.personId) ?? null });
    const participant = got.seat && "participant" in got.seat ? got.seat.participant : null;
    if (participant) held.set(person.personId, participant.participantId);
    steps.push({
      step,
      answer: reasonOf(got.seat as { seated: boolean; reason?: string } | null),
      calls: fx.calls.slice(seen).map((c) => c.route),
      publishes: publish.mock.calls.length,
      creates: create.mock.calls.length,
    });
  }

  for (const side of ["home", "away"] as const) {
    await claim(`${side}: the mint`, side);
    const pid = held.get(board[side].personId);
    if (!pid) throw new Error(`the ${side} mint handed no token`);
    await claim(`${side}: the seat`, side, () => fx.setLivePublisher(pid, true, { camera: "on" }));
  }

  const [counted] = await sql<{ home: boolean; away: boolean }[]>`
    select bool_or(a.person_id = ${board.home.personId} and a.checked_in_at is not null) as home,
           bool_or(a.person_id = ${board.away.personId} and a.checked_in_at is not null) as away
      from fixture_availability a where a.fixture_id = ${board.fixtureId}`;
  return { record: { steps, checkedIn: { home: counted?.home === true, away: counted?.away === true } }, fixtureId: board.fixtureId };
}

/** The ledger rows the board left, for the tree that HAS the ledger: none of them was held or admitted. */
export async function ledgerOf(fixtureId: string): Promise<{ rows: number; queued: number; admitted: number } | null> {
  const [t] = await sql<{ t: string | null }[]>`select to_regclass('fixture_seat_line')::text as t`;
  if (!t?.t) return null;
  const [r] = await sql<{ rows: number; queued: number; admitted: number }[]>`
    select count(*)::int as rows, count(queued_at)::int as queued, count(admitted_at)::int as admitted
      from fixture_seat_line where fixture_id = ${fixtureId}`;
  return r!;
}
