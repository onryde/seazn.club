import "server-only";
// Push nudges (spec 2026-11-24 §2.3, plan Task 6 / T1.4) — the capture-side PUBLISHER: a private `nudge` on `capture:{pairingId}` tells
// the phone to beat now instead of waiting out its poll. The nudge carries a reason and a time, never state, an id or a URL
// (`nudgeMessage`); the beat is still how the phone learns anything.
//
// Every export here is BEST-EFFORT and never throws: a nudge is sent after the commit of the change that caused it, fire-and-forget,
// and a failure to send it — a blank id, a read that fails, a publish that throws — is logged by ids and the error's CLASS NAME
// and swallowed. A message, a url or a key never reaches a log line (a publish error's message can quote the request).
//
//   nudgeReasonFor   the pure table: a session move -> the reason it sends, or null
//   nudgePairings    the one sender: pairing ids -> ONE request (the id is validated before a topic is built — Task 3 review m-b)
//   nudgeSession     a session's state changed: the pairing that is its phone NOW
//   nudgeCodesOver   a code ended by reissue or withdraw: every open pairing it has. EXPIRY sends nothing: it is lazy, found on the
//                    phone's own next call, which already answers 401 (the spec's table lists it; this is the deviation)
//   fireNudge        the fire-and-forget seam `apply` and the claim use, so a test can wait out what the code under test forgot
import { sql } from "@/lib/db";
import { captureTopic, nudgeMessage, type CaptureNudgeReason, type RealtimeMessage } from "@/lib/realtime";
import { log } from "@/server/logger";
import type { SessionState } from "@/server/relay/domain/session";
import { publishOf, type SessionDeps } from "./deps";

type NudgeDeps = Pick<SessionDeps, "publish">;
/** The label every capture nudge goes out under (`broadcast`'s warn line: `[realtime] capture nudge broadcast failed (...)`). */
const LABEL = "capture nudge";
const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

/**
 * The reason a session's move sends, or null. Entry into `provisioning` or `warming` is `go-live` (plan pin 12: the session row is
 * inserted `requested` outside `apply`, so the first move `apply` sees is out of it); into `ending` is `stop`, whatever ended it
 * (the organiser's Stop, the automatic stop, the phone-lost ends); into `completed` or `failed` is `over`. No move is no nudge.
 */
export function nudgeReasonFor(from: SessionState, to: SessionState): CaptureNudgeReason | null {
  if (from === to) return null;
  switch (to) {
    case "provisioning":
    case "warming":
      return "go-live";
    case "ending":
      return "stop";
    case "completed":
    case "failed":
      return "over";
    default:
      return null;
  }
}

/** Fired and not awaited: tracked only so `nudgesSettled` can wait for them. Each task is a nudge function above, which never rejects. */
const inFlight = new Set<Promise<void>>();
export function fireNudge(task: Promise<void>): void {
  inFlight.add(task);
  const done = () => { inFlight.delete(task); };
  void task.then(done, done);
}
/** Resolves once every nudge fired so far has finished (sent or failed). For tests, and for a graceful drain. */
export async function nudgesSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * Nudge `pairingIds` with `reason`, in ONE request. A blank id is refused by `captureTopic`; it is skipped with a warn (the id only)
 * and the rest still go — a throw here would be an unhandled rejection in every fire-and-forget caller. With nothing left to send,
 * nothing is published. A publish that throws is warned by the pairing ids and the error's class name.
 */
export async function nudgePairings(pairingIds: readonly string[], reason: CaptureNudgeReason, deps?: NudgeDeps): Promise<void> {
  try {
    const messages: RealtimeMessage[] = [];
    for (const id of pairingIds) {
      try {
        messages.push(nudgeMessage(captureTopic(id), reason));
      } catch {
        log.warn({ pairingId: id, reason }, "capture nudge: a blank pairing id is skipped");
      }
    }
    if (messages.length === 0) return;
    await publishOf(deps)(messages, LABEL);
  } catch (err) {
    log.warn({ pairingIds, reason, err: errName(err) }, "capture nudge: the publish failed");
  }
}

/**
 * A session's state changed: nudge the pairing that is its phone NOW. That is the session's own `pairing_id` while that pairing is
 * still OPEN, else the open slot-0 pairing on the session's code (a phone that moved on, or a new one that scanned the code); with
 * neither, nothing is sent. One POOLED read — never inside a transaction (lib/db.ts's nesting guard) — so callers fire this AFTER
 * their commit. A phone whose own `ended` closed its pairing has no open pairing: its nudge has no target, by design.
 */
export async function nudgeSession(sessionId: string, reason: CaptureNudgeReason, deps?: NudgeDeps): Promise<void> {
  try {
    const [row] = await sql<{ pairing_id: string | null }[]>`
      select coalesce(
               (select p.id from fixture_stream_pairings p where p.id = s.pairing_id and p.ended_at is null),
               (select p.id from fixture_stream_pairings p where p.code_id = s.code_id and p.slot = 0 and p.ended_at is null)
             ) as pairing_id
        from fixture_stream_sessions s where s.id = ${sessionId}`;
    if (!row || row.pairing_id === null) return;
    await nudgePairings([row.pairing_id], reason, deps);
  } catch (err) {
    log.warn({ sessionId, reason, err: errName(err) }, "capture nudge: the session's pairing could not be read");
  }
}

/** Codes the organiser ended (reissue, withdraw): `over` to every open pairing they have, in one request. After the commit. */
export async function nudgeCodesOver(codeIds: readonly string[], deps?: NudgeDeps): Promise<void> {
  if (codeIds.length === 0) return;
  try {
    const rows = await sql<{ id: string }[]>`
      select id from fixture_stream_pairings where code_id in ${sql([...codeIds])} and ended_at is null order by code_id, slot`;
    await nudgePairings(rows.map((r) => r.id), "over", deps);
  } catch (err) {
    log.warn({ codeIds, err: errName(err) }, "capture nudge: the ended codes' pairings could not be read");
  }
}
