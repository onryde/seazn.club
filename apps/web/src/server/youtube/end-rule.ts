import "server-only";
// YouTube Connect T13 — the end rule (spec §6.4 with owner D4/D5; plan P5, R2; preflight F8).
//
// WHEN a YouTube broadcast is due to be ended is computed from facts, never from a stored deadline, so a result that
// lands late needs no hook on the fixture write (spec §6.4). Two halves:
//   broadcastEndDueAt  PURE: the facts and a clock in, a due time (or null) out.
//   readEndFacts       the facts, read with plain selects and NO lock. The caller holds whatever lock it needs: T10's
//                      admission holds the broadcast row `for update` before it asks; T14's end step re-checks under its own.
//
// The rule:
//   - never due (null) while a session ON THIS BROADCAST is active, while a reservation is unlapsed, or before any session
//     has used the broadcast — that one belongs to the orphan rule (§6.2, P4). T10 reuses a broadcast on null (R2).
//   - S = the latest ended_at among THIS BROADCAST's sessions (P5). Spec §6.4 says "the fixture's sessions"; P5 narrows
//     both the activity check and S to the broadcast, so a pasted-key session on the same fixture neither holds an API
//     broadcast open nor moves its end (Review Focus 3).
//   - not finished → S + 5 min (D4's grace: a quick restart joins the same video).
//   - finished     → min(S + 5, max(S, F) + 2 min) (D5), F = fixtures.finished_at.
// `finished` is the fixture STATUS being in FINISHED_STATUSES: decided | finalized (owner, D5) plus forfeited | abandoned |
// cancelled (spec §6.4). Never needs_decision (F8): the V432 trigger stamps finished_at on a held fixture too, but a held
// result can resume, so the status decides and the stamp only says when.
//
// Two "cannot happen"s are guards, not comments (TEST-STRATEGY rule 4), each an EndRuleInvariantError:
//   - a terminal session on the broadcast with no ended_at — every terminal entry writes it (§6.3), and without it S is
//     unknown, so the rule refuses rather than anchor on an earlier Stop;
//   - a finished status with no finished_at — fixtures_track_finished (V430/V432) stamps every finished status on insert
//     and on every update that names status, and V430 backfilled the rest.
import { sql, type Tx } from "@/lib/db";
import { YOUTUBE_GRACE_MINUTES } from "@/lib/youtube";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";

/** D4: after Stop the broadcast stays open this long, so the same match going live again continues the same video. Declared in lib/youtube
 *  (the e2e walkthrough cannot import this `server-only` module) and re-exported here, so every server reader is unchanged. */
export { YOUTUBE_GRACE_MINUTES };
/** D5: a finished match's broadcast ends this long after Stop, or after the result when it lands inside the grace. */
export const YOUTUBE_FINISHED_END_MINUTES = 2;
/** Spec §6.4: the fixture statuses that make a match finished. NEVER needs_decision (F8). */
export const FINISHED_STATUSES = ["decided", "finalized", "forfeited", "abandoned", "cancelled"] as const;

export type EndFacts = {
  activeSessionOnBroadcast: boolean; reservedUntil: Date | null; latestEndedAt: Date | null;
  fixtureStatus: string; finishedAt: Date | null; terminalWithoutEndedAt: boolean;
};

/** The facts break an assumption the rule rests on; the rule refuses rather than answer a time it cannot know. */
export class EndRuleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndRuleInvariantError";
  }
}

const MINUTE_MS = 60_000;
const plusMinutes = (at: number, minutes: number): number => at + minutes * MINUTE_MS;
const isFinished = (status: string): boolean => (FINISHED_STATUSES as readonly string[]).includes(status);

/** null = NEVER due while a session on this broadcast is active, a reservation is unlapsed, or no session has used it yet
 *  (R2: T10 reuses on null). S = the latest ended_at among sessions ON THIS BROADCAST (P5).
 *  Throws EndRuleInvariantError when terminalWithoutEndedAt. */
export function broadcastEndDueAt(f: EndFacts, now: Date): Date | null {
  if (f.terminalWithoutEndedAt) {
    throw new EndRuleInvariantError("a terminal session on this broadcast has no ended_at, so its Stop time is unknown");
  }
  if (f.activeSessionOnBroadcast) return null;
  if (f.reservedUntil !== null && f.reservedUntil.getTime() > now.getTime()) return null;
  if (f.latestEndedAt === null) return null;

  const stop = f.latestEndedAt.getTime();
  const graceEnd = plusMinutes(stop, YOUTUBE_GRACE_MINUTES);
  if (!isFinished(f.fixtureStatus)) return new Date(graceEnd);
  if (f.finishedAt === null) {
    throw new EndRuleInvariantError(`fixture status '${f.fixtureStatus}' is finished but finished_at is null`);
  }
  const resultEnd = plusMinutes(Math.max(stop, f.finishedAt.getTime()), YOUTUBE_FINISHED_END_MINUTES);
  return new Date(Math.min(graceEnd, resultEnd));
}

interface FactsRow {
  reserved_until: Date | null; fixture_status: string; finished_at: Date | null;
  active: boolean; latest_ended_at: Date | null; terminal_without_ended_at: boolean;
}

/** The broadcast's end facts in one statement: plain selects, no lock. Sessions are this broadcast's only
 *  (`youtube_broadcast_id = b.id`, P5); the states are the stream domain's ACTIVE_STATES / TERMINAL_STATES, the one
 *  authority. Throws EndRuleInvariantError for an id with no broadcast row (callers pass one they just read). */
export async function readEndFacts(exec: Tx | typeof sql, broadcastId: string): Promise<EndFacts> {
  const [row] = await exec<FactsRow[]>`
    select b.reserved_until, f.status as fixture_status, f.finished_at,
           exists (select 1 from fixture_stream_sessions s
                    where s.youtube_broadcast_id = b.id and s.state in ${sql([...ACTIVE_STATES])}) as active,
           (select max(s.ended_at) from fixture_stream_sessions s
             where s.youtube_broadcast_id = b.id and s.state in ${sql([...TERMINAL_STATES])}) as latest_ended_at,
           exists (select 1 from fixture_stream_sessions s
                    where s.youtube_broadcast_id = b.id and s.state in ${sql([...TERMINAL_STATES])}
                      and s.ended_at is null) as terminal_without_ended_at
      from youtube_broadcasts b
      join fixtures f on f.id = b.fixture_id
     where b.id = ${broadcastId}`;
  if (!row) throw new EndRuleInvariantError(`no youtube_broadcasts row ${broadcastId}`);
  return {
    activeSessionOnBroadcast: row.active,
    reservedUntil: row.reserved_until,
    latestEndedAt: row.latest_ended_at,
    fixtureStatus: row.fixture_status,
    finishedAt: row.finished_at,
    terminalWithoutEndedAt: row.terminal_without_ended_at,
  };
}
