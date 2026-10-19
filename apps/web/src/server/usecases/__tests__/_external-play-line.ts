// Test helpers for the check-in line (spec §5.7): the ledger's rows read and written as the TEST'S setup, a bucket of a stated
// level at a stated instant, and a base URL that is a bucket of its own. Setup only - a line under test is built by real claims;
// a row written here stands for "somebody else already waiting", which no test of a gate can build without a second player.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { sql } from "@/lib/db";
import { currentBudgetKey } from "@/server/external-play/video/realtimekit";

export type StayRow = {
  fixture_id: string;
  person_id: string;
  budget_key: string;
  first_claim_at: Date;
  last_seen_at: Date;
  last_gate: "held" | "passed";
  queued_at: Date | null;
  released_at: Date | null;
  admitted_at: Date | null;
  completing: boolean;
  served_at: Date | null;
  ended_at: Date | null;
};

/** The stay as stored, or null. A TEST reads the raw row: the product reads it only through seat-line.ts's fragments. */
export async function stayRow(fixtureId: string, personId: string): Promise<StayRow | null> {
  const [row] = await sql<StayRow[]>`select * from fixture_seat_line where fixture_id = ${fixtureId} and person_id = ${personId}`;
  return row ?? null;
}

export type PutStay = {
  fixtureId: string;
  personId: string;
  budgetKey: string;
  firstClaimAt: Date;
  /** Defaults to `firstClaimAt`. */
  seenAt?: Date;
  gate?: "held" | "passed";
  queuedAt?: Date | null;
  admittedAt?: Date | null;
  completing?: boolean;
  servedAt?: Date | null;
  endedAt?: Date | null;
};

export async function putStay(a: PutStay): Promise<void> {
  await sql`
    insert into fixture_seat_line (fixture_id, person_id, budget_key, first_claim_at, last_seen_at, last_gate,
                                   queued_at, admitted_at, completing, served_at, ended_at)
    values (${a.fixtureId}, ${a.personId}, ${a.budgetKey}, ${a.firstClaimAt}, ${a.seenAt ?? a.firstClaimAt}, ${a.gate ?? "held"},
            ${a.queuedAt ?? null}, ${a.admittedAt ?? null}, ${a.completing ?? false}, ${a.servedAt ?? null}, ${a.endedAt ?? null})
    on conflict (fixture_id, person_id) do update set
      budget_key = excluded.budget_key, first_claim_at = excluded.first_claim_at, last_seen_at = excluded.last_seen_at,
      last_gate = excluded.last_gate, queued_at = excluded.queued_at, admitted_at = excluded.admitted_at,
      completing = excluded.completing, served_at = excluded.served_at, ended_at = excluded.ended_at`;
}

/** The bucket `key` holds exactly `tokens` as of `asOf` (a peek at `asOf` reads `tokens`). */
export async function setBucket(key: string, tokens: number, asOf: Date): Promise<void> {
  await sql`
    insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, ${tokens}, ${asOf})
    on conflict (key) do update set tokens = excluded.tokens, refilled_at = excluded.refilled_at`;
}

/** A vendor base that is a bucket - and so a LINE - of its own. The bucket's key IS the base (budget.ts `budgetKey`), so a repeated
 *  base puts two scenes on one line, each reading the other's stays. A UUID in the host is unique across calls, files and
 *  processes alike; the port this used to draw at random out of 40 000 repeated inside a 36-scene test in ~3% of runs, and CI saw
 *  a "served" stay read the previous scene's live one (external-play-line-unique-base.test.ts).
 *
 *  `.test` is reserved (RFC 2606) and never resolves; nothing dials the base (the fake vendor is the adapter's `fetch`), and a
 *  stray dial would fail rather than reach a real host. The path stays `/client/v4`: the fake vendor strips that prefix. */
export function uniqueBase(): string {
  return `http://${randomUUID()}.rtk.test/client/v4`;
}

/** Point the adapter at `base` (default: a fresh one) and meter it, returning the bucket's key. RealtimeKit must be configured
 *  already (`configureRealtimeKit`). */
export function stubBucket(base: string = uniqueBase()): string {
  vi.stubEnv("REALTIMEKIT_BASE_URL", base);
  vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
  const key = currentBudgetKey();
  if (key === null) throw new Error("stubBucket: RealtimeKit is not configured - call configureRealtimeKit() first");
  return key;
}

/** Remove everything a test left on `key`. */
export async function clearBucket(key: string): Promise<void> {
  await sql`delete from fixture_seat_line where budget_key = ${key}`;
  await sql`delete from realtimekit_call_budget where key = ${key}`;
}

// ─── A gate-level scene: one bucket, boards seeded on demand, claims at a stated instant ─────────────────────────────────
import { boardAnchor } from "@/server/external-play/window";
import { gateClaim, type GateAnswer, type GateAsk } from "@/server/external-play/seat-line";
import { seedOnlineChessFixture } from "./_external-play-seed";

export type Board = Awaited<ReturnType<typeof seedOnlineChessFixture>>;
export type Side = "home" | "away";

/** The clock every gate-level test counts from: a minute ago, so no real-time column default (`created_at`) is ever ahead of it. */
export const SCENE_T0 = new Date(Date.now() - 120_000);
/** The anchor every scene board shares: opened five minutes before T0, batch 0, so T0 is inside its window. */
export const SCENE_ANCHOR = boardAnchor(new Date(SCENE_T0.getTime() - 5 * 60_000), 0, false);
export const sceneAt = (ms: number) => new Date(SCENE_T0.getTime() + ms);

export const seedBoard = (): Promise<Board> =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(SCENE_T0.getTime() + 600_000),
    linked: true,
    roundOpenedAt: new Date(SCENE_T0.getTime() - 5 * 60_000),
    cameraPolicy: "required",
  });

/** The gate's ask for `side` of `board` at `when` (the other side is the opponent; not counted unless said). */
export function askOf(key: string, board: Board, side: Side, when: Date, over: Partial<GateAsk> = {}): GateAsk {
  const other: Side = side === "home" ? "away" : "home";
  return {
    fixtureId: board.fixtureId,
    personId: board[side].personId,
    otherPersonId: board[other].personId,
    otherCounted: false,
    budgetKey: key,
    anchor: SCENE_ANCHOR,
    at: when,
    ...over,
  };
}

export const claimAt = (key: string, board: Board, side: Side, when: Date, over: Partial<GateAsk> = {}): Promise<GateAnswer> =>
  gateClaim(askOf(key, board, side, when, over));

/** Somebody else's ADMITTED, live stay on `key` (a reservation of LINE_RESERVATION, plus the surcharge when `completing`): the line
 *  is active and a pool is short by exactly that. `at` is when it was admitted and last heard from. */
export async function holdReservation(key: string, when: Date, completing = false): Promise<Board> {
  const b = await seedBoard();
  await putStay({
    fixtureId: b.fixtureId,
    personId: b.home.personId,
    budgetKey: key,
    firstClaimAt: when,
    seenAt: when,
    gate: "passed",
    queuedAt: when,
    admittedAt: when,
    completing,
  });
  return b;
}

/** Somebody else WAITING on `key`, since `firstClaimAt`. */
export async function holdWaiting(key: string, firstClaimAt: Date, seenAt: Date): Promise<Board> {
  const b = await seedBoard();
  await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key, firstClaimAt, seenAt, gate: "held", queuedAt: firstClaimAt });
  return b;
}

export const unusedId = () => randomUUID();
