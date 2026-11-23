// The sweep pass's two budgets, in a leaf with no imports so the load harness (e2e/load, outside Next's server graph, where
// pass.ts's `server-only` cannot load) derives its waits from the SAME numbers the server runs on. pass.ts re-exports both.

/** Final review I-1: the pass stops STARTING network work (NETWORK_JOBS) once this much wall-clock time has gone. The
 *  cron Worker abandons a job at 60 s (JOB_TIMEOUT_MS, apps/cron-worker/src/call.ts) and records a timeout; stopping
 *  here leaves 15 s for the row in flight, the figure stream-tick's STREAM_TICK_BUDGET_MS chose for the same Worker.
 *  external-play/route.test.ts pins it below the Worker's figure. RESIDUAL, as stream-tick's: one row's worst case is
 *  not under 15 s — every Lichess and RealtimeKit request is bounded at 10 s, and a reconcile can make three in a row
 *  plus a 3 s broadcast — so a row started just inside the budget against a stalled vendor can still outlive the
 *  Worker. That reads as a Worker timeout (an error, one Sentry event an hour under R2), never as silence. T17B fix 2,
 *  D11 widens it: a board whose side to move is at zero is read again on a stream HELD ~9 s (reconcile
 *  FLAG_SETTLE_HOLD_MS, bounded at LICHESS_TIMEOUT_MS + the hold). D20 bounds that: SWEEP_SETTLING_READS_PER_PASS and
 *  SWEEP_RECONCILE_BUDGET_MS (pass.ts). */
export const SWEEP_PASS_BUDGET_MS = 45_000;

/** Check-in capacity plan 2 Task 8 (finding 15): the RealtimeKit requests one pass makes for the jobs the cap applies to - teardown,
 *  the camera evidence, the TTL and ended-room arms of the arbiter removal, and the parked rooms (a stale-paired retire is the
 *  teardown's). One request a second for the budget the cron Worker leaves the pass: the same arithmetic as the pre-mint job's
 *  PREMINT_CALLS_PER_PASS, a CEILING that holds when nothing else stopped the pass. NOT counted: the revocation job (never capped,
 *  R5), and the reconcile and mint-retry jobs, which create or finish a GAME and build their own adapters (a game held back by the
 *  sweep's own cap is a player waiting). The platform's bucket meters every request regardless of this ceiling.
 *  The camera evidence is capped at a room's START, not per request (PR-2 whole review I1): a room started under the cap is read to
 *  the end on the platform's bucket, so a pass can pass the ceiling by one room's reads, and everything capped after it then finds
 *  the cap spent and waits for the next pass. */
export const SWEEP_RTK_CALLS_PER_PASS = Math.floor(SWEEP_PASS_BUDGET_MS / 1000);
