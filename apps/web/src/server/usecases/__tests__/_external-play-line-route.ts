// Route-level scenes for the check-in line (spec §8.1): a board seeded in a round opened at a fixed instant, the REAL claim
// (`claimRoomSeat` -> `seatPlayer` -> the gate -> the T7 adapter) in front of the in-memory RealtimeKit, and a bucket that holds
// a STATED level and never refills during the test. Setup only; every answer a test reads comes from the real claim.
//
// Two clocks, kept apart on purpose: the claim's clock (`at`, handed to `deps.now` and `deps.line.at`) is the test's, and the
// vendor-call budget's own spend reads the database's. A bucket stamped an hour AHEAD of every clock refills nothing on either
// (elapsed is floored at zero), so a level is exactly what `fund` set less the calls the fixture server saw.
import { vi } from "vitest";
import { sql } from "@/lib/db";
import { takeRealtimeKitCall } from "@/server/external-play/video/budget";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { claimRoomSeat, type RoomClaim, type RoomDeps } from "../external-play/room";
import { seatPlayer } from "../external-play/preflight";
import { CAMERA_ON_EVENTS, configureRealtimeKit, fakeRealtimeKit } from "./_external-play-rtk-fake";
import { clearBucket, setBucket, stubBucket } from "./_external-play-line";
import { seedOnlineChessFixture } from "./_external-play-seed";

export const MIN = 60_000;
/** The instant the scenes' round was opened. A window is `[OPENED - lead, OPENED + DEADLINE_AFTER_MS)` for batch 0. */
export const OPENED = new Date("2026-10-01T12:00:00.000Z");
export const DEADLINE = new Date(OPENED.getTime() + DEADLINE_AFTER_MS);
export const inWindow = (ms: number) => new Date(OPENED.getTime() + ms);

export type Rtk = ReturnType<typeof fakeRealtimeKit>;
export type World = { key: string; rtk: Rtk };
export type Board = Awaited<ReturnType<typeof seedBoard>>;
export type Side = "home" | "away";

const used: string[] = [];
/** A fresh vendor base - a bucket and a line of its own - with RealtimeKit configured and an in-memory vendor in front of it. */
export function world(): World {
  configureRealtimeKit();
  const key = stubBucket();
  used.push(key);
  // The adapter exempts a caller-supplied `fetch` from the platform's bucket, so the REAL bucket is handed in as the budget.
  return { key, rtk: fakeRealtimeKit({ budget: (k) => takeRealtimeKitCall(k) }) };
}
export async function dropWorlds(): Promise<void> {
  for (const k of used.splice(0)) await clearBucket(k);
  vi.unstubAllEnvs();
}

/** The bucket holds exactly `tokens` and refills nothing for the length of the test. */
export const fund = (key: string, tokens: number) => setBucket(key, tokens, new Date(Date.now() + 3_600_000));
export async function level(key: string): Promise<number> {
  const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
  return row ? Number(row.tokens) : Number.NaN;
}

export const seedBoard = (over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(OPENED.getTime() + 10 * MIN),
    linked: true,
    roundOpenedAt: OPENED,
    cameraPolicy: "required",
    ...over,
  });

export type Spies = { publish: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
/** One claim for `side` of `board` at `at` (the claim's and the gate's clock). Returns the answer and the spies it ran against. */
export async function claimRoom(
  w: World,
  board: Board,
  side: Side,
  at: Date,
  extra: Partial<RoomDeps> = {},
): Promise<RoomClaim & Spies> {
  const publish = vi.fn(async () => {});
  const create = vi.fn(async () => ({ created: false as const, reason: "not_ready" as const }));
  const deps = {
    now: at,
    publish,
    create,
    offered: vi.fn(async () => true),
    mintRealtime: vi.fn(async () => "rt-token"),
    line: { at },
    seat: (a: Parameters<typeof seatPlayer>[0], d: Parameters<typeof seatPlayer>[1]) => seatPlayer(a, { ...d, video: w.rtk.video }),
    ...extra,
  } as unknown as RoomDeps;
  const got = await claimRoomSeat({ kind: "session", userId: board[side].userId }, board.fixtureId, deps);
  return { ...got, publish, create };
}

type Seat = RoomClaim["seat"];
const tokenOf = (seat: Seat): { participantId: string; authToken: string } => {
  const p = seat && "participant" in seat ? seat.participant : null;
  if (!p) throw new Error(`no participant token in ${JSON.stringify(seat)}`);
  return p;
};
type Peer = { joinedAt: string; events: unknown[] | null };
const peerOf = (w: World, seat: Seat): Peer => {
  const peer = (w.rtk.participants.get(tokenOf(seat).participantId)?.peerList as Peer[] | undefined)?.at(-1);
  if (!peer) throw new Error("the participant has no peer");
  return peer;
};

/** The browser joins the meeting with the token the answer handed over, `at` being its clock, with a camera that has not
 *  reported yet (`pending`, the default) or with the stated events. */
export function joinAt(w: World, seat: Seat, at: Date, events: ((at: string) => unknown[] | null) | null = null): void {
  w.rtk.joinWith(tokenOf(seat).authToken, events ?? (() => null));
  peerOf(w, seat).joinedAt = new Date(at.getTime() - 1_000).toISOString();
}
/** The camera comes on (the peer's report now holds the measured honest events). */
export function cameraOn(w: World, seat: Seat, at: Date): void {
  peerOf(w, seat).events = CAMERA_ON_EVENTS(at.toISOString());
}

export async function availability(fixtureId: string, personId: string): Promise<{ checked_in_at: Date | null } | null> {
  const [row] = await sql<{ checked_in_at: Date | null }[]>`
    select checked_in_at from fixture_availability where fixture_id = ${fixtureId} and person_id = ${personId}`;
  return row ?? null;
}
