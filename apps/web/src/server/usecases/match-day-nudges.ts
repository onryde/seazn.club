import "server-only";
// Push nudges (spec 2026-11-24 §3, plan Task 10 / T2.3) — the Match Day PUBLISHER: a private `nudge` on `match-day:{codeId}` tells an
// open Match Day screen to re-read its day now instead of waiting out its poll. A nudge carries a reason and a time, never state, an id
// or a URL (`nudgeMessage`); the screen's own read is still how it learns anything.
//
// The reasons: `score` (a score event), `schedule` (a schedule write) and `call` (a match called to a court, `match-day-call.ts`).
//
// This file RETURNS messages; it sends none. A caller appends them to the broadcast it already makes, so a write is still ONE POST
// (Task 2). Everything here is best-effort and never throws: a failed read means no Match Day messages, one warn line naming the
// error's CLASS (never a message, a code id, a token or a url), and the rest of the caller's batch goes out.
//
//   matchDayNudgeMessages  competition -> the nudge for each of its OPEN codes, from a 15 s per-instance memo of the codes
//   matchDayNudgesFor      the caller's door: the gate (publishing on, a uuid), the bound, and the read STARTED at call time
//   broadcastWithMatchDay  scoring's sender: ONE POST of the caller's messages plus a Match Day read already in flight
//   codeMessages           the one builder (a blank id is dropped before its topic is built)
import { sql } from "@/lib/db";
import { broadcast, matchDayTopic, nudgeMessage, realtimePublishEnabled, type MatchDayNudgeReason, type RealtimeMessage } from "@/lib/realtime";
import { log } from "@/server/logger";
import { fireNudge } from "./stream-sessions/nudge";

/** How long a competition's open codes are remembered by one server instance. A code minted inside the window is not nudged until it
 *  lapses; a code WITHDRAWN inside it is nudged at most that long after: the nudge carries no data, and the screen's re-read is
 *  refused by the door that resolves its code. */
export const MATCH_DAY_MEMO_MS = 15_000;
/** How long a write may wait for the read before it goes without the Match Day messages: the same bound as a schedule write's court
 *  read (`COURT_NUDGE_READ_BOUND_MS`, after-write.ts), half of PUSH_AFTER_DELETE_BOUND_MS, so the push is never later than the DEL. */
export const MATCH_DAY_NUDGE_READ_BOUND_MS = 750;
/** Memoised competitions kept at most; the oldest goes first. A competition is only here while it is being written to. */
const MEMO_MAX = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

type OpenCode = { id: string; expiresAt: number };
type Memo = { at: number; codes: Promise<OpenCode[]> };
const memo = new Map<string, Memo>();

/** Forget every remembered competition. For tests. */
export function resetMatchDayMemo(): void {
  memo.clear();
}

/**
 * The messages that nudge `codeIds` with `reason`. A blank id is refused by `matchDayTopic`; it is dropped with a warn (the reason
 * only — an id is a credential's name) and the rest still go: a throw here would be an unhandled rejection in a fire-and-forget caller.
 */
export function codeMessages(codeIds: readonly string[], reason: MatchDayNudgeReason): RealtimeMessage[] {
  const messages: RealtimeMessage[] = [];
  for (const id of codeIds) {
    try {
      messages.push(nudgeMessage(matchDayTopic(id), reason));
    } catch {
      log.warn({ reason }, "match day nudge: a blank code id is skipped");
    }
  }
  return messages;
}

/** The competition's codes open at `now`, one pooled read (never inside a transaction: callers run it AFTER their commit). The SQL
 *  holds the whole open window (not withdrawn, `opens_at <= now < expires_at`) so an old competition's lapsed codes are never loaded;
 *  exported so a test can judge the rows themselves, apart from the serve-time expiry filter that guards the memo. */
export async function readOpenCodes(competitionId: string, now: Date): Promise<OpenCode[]> {
  const rows = await sql<{ id: string; expires_at: Date }[]>`
    select id, expires_at from match_day_codes
     where competition_id = ${competitionId} and revoked_at is null and opens_at <= ${now} and ${now} < expires_at
     order by id`;
  return rows.map((r) => ({ id: r.id, expiresAt: new Date(r.expires_at).getTime() }));
}

/**
 * The `nudge` for each Match Day code of `competitionId` that is open at `now` (not withdrawn, `opens_at <= now < expires_at`), one
 * message per code, with `reason`. No open code is `[]`. The competition's codes are read at most once per MATCH_DAY_MEMO_MS per
 * instance (a burst of scores is one read; concurrent calls share it), so inside that window:
 *   - a code minted or opened since is not nudged yet;
 *   - a code withdrawn since is nudged once more — a nudge carries no data and the door refuses the screen's next read;
 *   - a code that EXPIRES is dropped at once (its expiry is remembered with it).
 * A read that fails is not remembered: the next write reads again. Never throws.
 */
export async function matchDayNudgeMessages(competitionId: string, reason: MatchDayNudgeReason, now: Date = new Date()): Promise<RealtimeMessage[]> {
  try {
    const t = now.getTime();
    let entry = memo.get(competitionId);
    // A clock that went backwards (an entry from the future) is a miss, never a hit.
    if (!entry || t - entry.at >= MATCH_DAY_MEMO_MS || t < entry.at) {
      const codes = readOpenCodes(competitionId, now);
      entry = { at: t, codes };
      memo.delete(competitionId);
      if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
      memo.set(competitionId, entry);
      const forget = (): void => { if (memo.get(competitionId) === entry) memo.delete(competitionId); };
      codes.catch(forget);
    }
    const open = (await entry.codes).filter((c) => t < c.expiresAt);
    return codeMessages(open.map((c) => c.id), reason);
  } catch (err) {
    log.warn({ err: errName(err), reason }, "match day nudge: the open codes could not be read");
    return [];
  }
}

/**
 * The Match Day nudges for a write on `competitionId`, STARTED NOW: the caller keeps the promise and awaits it where it builds its
 * broadcast, so the read runs beside its cache work and the push is never later than the larger of the two. Resolves `[]`, never
 * rejects, and reads nothing (arms no timer) when publishing is off (`realtimePublishEnabled`: a kill switch sends nothing) or the id
 * is not a uuid. A read slower than MATCH_DAY_NUDGE_READ_BOUND_MS is abandoned (a pooled statement cannot be cancelled): the push goes
 * without these messages.
 */
export async function matchDayNudgesFor(competitionId: string, reason: MatchDayNudgeReason): Promise<RealtimeMessage[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!UUID.test(competitionId) || !realtimePublishEnabled()) return [];
    const bound = new Promise<RealtimeMessage[]>((resolve) => {
      timer = setTimeout(() => { resolve([]); }, MATCH_DAY_NUDGE_READ_BOUND_MS);
    });
    return await Promise.race([matchDayNudgeMessages(competitionId, reason), bound]);
  } catch (err) {
    log.warn({ err: errName(err), reason }, "match day nudge: the read could not be started");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send `messages` plus the Match Day nudges of `matchDay` (a read started by `matchDayNudgesFor`, or nothing) as ONE broadcast,
 * fire-and-forget and tracked (`nudgesSettled` waits for it). Never rejects.
 */
export function broadcastWithMatchDay(matchDay: Promise<RealtimeMessage[]> | undefined, messages: readonly RealtimeMessage[], label: string): void {
  fireNudge(
    (async () => {
      const nudges = matchDay ? await matchDay : [];
      await broadcast([...messages, ...nudges], label);
    })().catch((err: unknown) => {
      log.warn({ err: errName(err), label }, "match day nudge: the realtime push failed (the write stands)");
    }),
  );
}
