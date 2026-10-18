// Route-level scenes for the check-in line (spec §8.1): a board seeded in a round opened at a fixed instant, the REAL claim
// (`claimRoomSeat` -> `seatPlayer` -> the gate -> the T7 adapter) in front of the in-memory RealtimeKit, and a bucket that holds
// a STATED level and never refills during the test. Setup only; every answer a test reads comes from the real claim.
//
// Two clocks, kept apart on purpose: the claim's clock (`at`, handed to `deps.now` and `deps.line.at`) is the test's, and the
// vendor-call budget's own spend reads the database's. A bucket stamped an hour AHEAD of every clock refills nothing on either
// (elapsed is floored at zero), so a level is exactly what `fund` set less the calls the fixture server saw.
import { expect, vi } from "vitest";
import { sql } from "@/lib/db";
import { takeRealtimeKitCall } from "@/server/external-play/video/budget";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { claimRoomSeat, type RoomClaim, type RoomDeps } from "../external-play/room";
import { sweepExternalPlay, type SweepDeps, type SweepReport } from "../external-play/sweep";
import { seatPlayer } from "../external-play/preflight";
import { CAMERA_ON_EVENTS, configureRealtimeKit, fakeRealtimeKit } from "./_external-play-rtk-fake";
import { clearBucket, setBucket, stubBucket } from "./_external-play-line";
import { seedOnlineChessFixture } from "./_external-play-seed";

export const MIN = 60_000;
export const SEC = 1_000;
/** The instant the scenes' round was opened. A window is `[OPENED - lead, OPENED + DEADLINE_AFTER_MS)` for batch 0. */
export const OPENED = new Date("2026-10-01T12:00:00.000Z");
export const DEADLINE = new Date(OPENED.getTime() + DEADLINE_AFTER_MS);
export const inWindow = (ms: number) => new Date(OPENED.getTime() + ms);

export type Rtk = ReturnType<typeof fakeRealtimeKit>;
/** `held`: the participant each person's browser holds the token of, as the room's state does (sent as `heldParticipantId`). */
export type World = { key: string; rtk: Rtk; held: Map<string, string> };
export type Board = Awaited<ReturnType<typeof seedBoard>>;
export type Side = "home" | "away";

const used: string[] = [];
/** A fresh vendor base - a bucket and a line of its own - with RealtimeKit configured and an in-memory vendor in front of it. */
export function world(): World {
  configureRealtimeKit();
  const key = stubBucket();
  used.push(key);
  // The adapter exempts a caller-supplied `fetch` from the platform's bucket, so the REAL bucket is handed in as the budget.
  return { key, rtk: fakeRealtimeKit({ budget: (k) => takeRealtimeKitCall(k) }), held: new Map() };
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
): Promise<RoomClaim & { spies: Spies }> {
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
  const personId = board[side].personId;
  const heldParticipantId = w.held.get(personId) ?? null;
  const got = await claimRoomSeat({ kind: "session", userId: board[side].userId }, board.fixtureId, deps, { heldParticipantId });
  const given = got.seat && "participant" in got.seat ? got.seat.participant : null;
  if (given) w.held.set(personId, given.participantId);
  return { ...got, spies: { publish, create } };
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

/** The browser joins the meeting with the token the answer handed over, at `joinedAt` (the peer's own PEER_JOINING time), with a
 *  camera that has not reported yet (`pending`, the default) or with the stated events. */
export function joinAt(w: World, seat: Seat, joinedAt: Date, events: ((at: string) => unknown[] | null) | null = null): void {
  w.rtk.joinWith(tokenOf(seat).authToken, events ?? (() => null));
  peerOf(w, seat).joinedAt = joinedAt.toISOString();
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

/** Real polls of a waiting stay: one claim every `everyMs` from `from`, the last at exactly `to`. Returns every answer's reason
 *  and the last claim in full. */
export async function pollStay(
  w: World,
  board: Board,
  side: Side,
  from: Date,
  to: Date,
  everyMs = 10_000,
): Promise<{ last: RoomClaim & { spies: Spies }; claims: number }> {
  let last: (RoomClaim & { spies: Spies }) | null = null;
  let claims = 0;
  for (let t = from.getTime(); ; t += everyMs) {
    const at = new Date(Math.min(t, to.getTime()));
    last = await claimRoom(w, board, side, at);
    claims += 1;
    if (at.getTime() >= to.getTime()) break;
  }
  return { last: last!, claims };
}

/** One sweep pass at `now`, scoped to the board's organisation, without the single-flight lock (another file may be sweeping
 *  in parallel), with the room's teardown recorded and no create attempted. */
export async function sweepBoard(
  b: Board,
  now: Date,
  over: Partial<SweepDeps> = {},
): Promise<{ report: SweepReport; ended: string[] }> {
  const ended: string[] = [];
  const report = await sweepExternalPlay({
    now,
    orgIds: [b.orgId],
    serialise: false,
    endMeeting: async (id) => {
      ended.push(id);
    },
    createGameIfReady: async () => ({ created: false, reason: "not_ready" }),
    ...over,
  });
  return { report, ended };
}

export async function fixtureStatus(fixtureId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return row!.status;
}

/** `side`'s first two claims at `at` and `at + 1 s`: the mint, a browser that joins with a camera ON, and the seat. The line is
 *  idle and the bucket funded, so this is today's path. Leaves the player SEATED and COUNTED. */
export async function seatAndCount(w: World, b: Board, side: "home" | "away", at: Date): Promise<void> {
  await fund(w.key, 300);
  const minted = await claimRoom(w, b, side, at);
  expect(minted.seat, `${side}: the mint answers camera_required with a token`).toMatchObject({ seated: false, reason: "camera_required" });
  joinAt(w, minted.seat, at, CAMERA_ON_EVENTS);
  const seated = await claimRoom(w, b, side, new Date(at.getTime() + SEC));
  expect(seated.seat?.seated, `${side}: seated`).toBe(true);
}


/** Peer-report events (measured shapes, as `CAMERA_ON_EVENTS`): a camera the browser or the OS refused. */
export const CAMERA_DENIED_EVENTS = (at: string) => [
  { name: "media_permission", metadata: { device_type: "VIDEO", permission: "DENIED" }, timestamp: at },
  { name: "video_off", timestamp: at },
  { name: "precall_begin", timestamp: at },
];
/** A camera that was on and went off a second later. */
export const CAMERA_WENT_OFF_EVENTS = (at: string) => [
  ...CAMERA_ON_EVENTS(at),
  { name: "video_off", timestamp: new Date(new Date(at).getTime() + 1_000).toISOString() },
];
