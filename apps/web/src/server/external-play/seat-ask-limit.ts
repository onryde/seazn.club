import "server-only";
// A per-seat limit on the match room's two doors that can cost the platform's RealtimeKit budget (T17B fix 2, D21-fix-4,
// review I2): the seat claim (POST …/room) and the camera-token ask (POST …/room/camera).
//
// THE THREAT. Both routes answer to any signed-in player of a board, and one claim is up to four vendor calls (a token
// refresh and the three reads of a camera). The budget (video/budget.ts) is ONE bucket for the whole account, refilled at
// two calls a second: a player asking at twenty requests a second empties it and keeps it empty, and every club's check-in
// answers `camera_starting` while the sweep's retries find no token to spend. The budget bounds the vendor; this bounds
// WHO may spend it, so one seat's loop cannot starve the others.
//
// WHY NOT lib/rate-limit.ts. It is Redis-only, INERT wherever Redis is not configured (local dev, e2e, any environment
// without REDIS_URL) and fail-OPEN when Redis blips - a limit built on it would be absent exactly where it is tested and
// where it is needed. This one is a Postgres row per (fixture, person, route), like the budget it protects: one UPSERT
// counts the ask and decides, the row lock serialises machines, and the clock is the DATABASE's.
//
// THE NUMBERS ARE THE ROOM'S WORST CASE, not a guess. A limit under what the room itself sends would refuse the product's
// own check-in, so each is what the room can legitimately send inside one window, for two devices at once (a phone and a
// laptop, or a second tab - the same person is seated once but may ask from both):
//   seat   = DEVICES x (the press + CAMERA_EVIDENCE_MAX_POLLS re-asks + SEAT_RETRIES re-claims + the one a retired meeting
//            earns) = 2 x (1 + 5 + 3 + 1) = 20. The re-asks are on the back-off 1, 2, 4, 8, 8 s (23 s) and the re-claims
//            1.5 s apart, so a whole attempt is ~28 s - inside one window.
//   camera = DEVICES x the densest minute of the tile retry's back-off (2, 4, 8, 16, then every 30 s: asks at 2, 6, 14, 30,
//            60 s = 5) = 10.
// seat-ask-limit.test.ts DERIVES both from the room's own declarations and replays the room's real schedule against this
// limiter, so a change to the room's bounds moves the test, not a number typed twice.
//
// WHAT AN OVER-LIMIT ASK COSTS THE PLAYER. A 429 with the window's true remaining seconds in Retry-After, nothing else done:
// no claim, no vendor call. The room treats a 429 as "later" on both doors (use-room.ts: the camera door asks again on its
// back-off; a refused seat claim leaves the seat as it was and the screen reads on). What it does NOT do is tell the player
// - there is no new copy in this change - so a person who presses Check in more than the limit inside a minute sees the
// button do nothing until the window ends. That is a person mashing a button for a minute, which is the thing this exists
// to bound.
//
// WHAT IT DOES NOT BOUND. The sum over players: N seats at their limit still spend N x the limit. That is the budget's
// (reserved lane for a game's create, spec §5.6) and the owner's, not a per-seat number's.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";

/** The two doors. Mirrors V458's CHECK: a third is a migration as well as a line here. */
export const SEAT_ASK_ROUTES = ["seat", "camera"] as const;
export type SeatAskRoute = (typeof SEAT_ASK_ROUTES)[number];

/** The window every limit below is counted in. */
export const SEAT_ASK_WINDOW_S = 60;

/** Asks one (fixture, person) may make of each door inside one window. Derivation above; pinned by seat-ask-limit.test.ts. */
export const SEAT_ASK_LIMIT: Readonly<Record<SeatAskRoute, number>> = { seat: 20, camera: 10 };

const TOO_MANY = "Too many requests — slow down and try again.";

/**
 * Count one ask of `route` by `personId` on `fixtureId`; throw 429 (with Retry-After) when it is past the limit. Call it
 * AFTER the room has proved who the caller is - a stranger is the room's 404 and leaves no row - and BEFORE anything that
 * can reach the vendor.
 *
 * ONE statement: the first ask makes the row (window opening now, one ask); an ask inside the open window adds one; an ask
 * at or past the window's end opens a new window with itself as its first. The window is judged against the clock read in
 * the VALUES row (RETURNING cannot see it, so the Retry-After hint reads the clock again - a hint, accurate to the
 * milliseconds between). An ask whose clock is BEHIND the window's start (a stepped-back clock) is counted into the open
 * window - the strict direction - and never resets it. Concurrent asks queue on the row lock, so between them they pass at
 * most the limit.
 *
 * `opts.at` is a test seam - the statement's clock; production passes nothing and the database's clock decides.
 */
export async function takeSeatAsk(
  ask: { fixtureId: string; personId: string; route: SeatAskRoute },
  opts: { at?: Date } = {},
): Promise<void> {
  const clock = opts.at ? sql`${opts.at}::timestamptz` : sql`clock_timestamp()`;
  const window = sql`make_interval(secs => ${SEAT_ASK_WINDOW_S}::float8)`;
  const [row] = await sql<{ asks: number; retryAfterS: number }[]>`
    insert into fixture_seat_asks as a (fixture_id, person_id, route, window_started_at, asks)
    values (${ask.fixtureId}, ${ask.personId}, ${ask.route}, ${clock}, 1)
    on conflict (fixture_id, person_id, route) do update
       set window_started_at = case when excluded.window_started_at >= a.window_started_at + ${window}
                                    then excluded.window_started_at else a.window_started_at end,
           asks              = case when excluded.window_started_at >= a.window_started_at + ${window}
                                    then 1 else a.asks + 1 end
    returning asks, ceil(extract(epoch from (window_started_at + ${window} - ${clock})))::int as "retryAfterS"`;
  if (!row) throw new Error("fixture_seat_asks: the ask statement returned no row"); // an UPSERT always returns one
  if (row.asks <= SEAT_ASK_LIMIT[ask.route]) return;
  // The window's TRUE remaining whole seconds, never 0 while any time remains (a 0 makes a client hammer), and never past
  // the window itself (a stepped-back clock would otherwise promise longer than any window lasts).
  const retryAfter = Math.min(Math.max(row.retryAfterS, 1), SEAT_ASK_WINDOW_S);
  throw new HttpError(429, TOO_MANY, undefined, undefined, { "Retry-After": String(retryAfter) });
}
