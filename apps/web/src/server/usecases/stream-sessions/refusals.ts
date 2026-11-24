import "server-only";
// Start refusals: admit's verdict to HttpError, unreadable-key refusals, the early probe (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { SEAZN_UNAVAILABLE, SEAZN_VIDEO_UNCONFIGURED } from "@/lib/stream-destinations";
import { admit } from "@/server/relay/domain/session";
import {
  TargetSecretUnreadableError,
  lockStreamTarget,
  readTargetSecret,
} from "@/server/relay/secret-columns";
import { youtubeRefusal } from "@/server/youtube/prepare";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { TargetUnreadableError } from "../stream-targets";
import { holderRows } from "../stream-target-holders";
import { activeSessionIdFor } from "./lookups";
import { targetConnectionId } from "./destination";
import { targetInUse } from "./holders";

export function refuse(refusal: Exclude<ReturnType<typeof admit>, { ok: true }>, headroom: number): never {
  switch (refusal.refusal) {
    // R2001: the deployment cannot run a composed session (no compositor image, or no relay) — the ingest's 503 family.
    case "composed_unavailable": throw new HttpError(503, "composed streaming is not available on this deployment", "composed_unavailable");
    case "plan_lacks_overlay": throw new PaymentRequiredError(RELAY_PLAN_GATES.overlay);
    case "overlay_required": throw new HttpError(409, "phone streaming needs the overlay tier", "overlay_required");
    case "plan_lacks_relay": throw new PaymentRequiredError(RELAY_PLAN_GATES.relay);
    case "no_credits": throw new HttpError(402, "This organisation has no Seazn credits", "no_credits", { featureKey: RELAY_PLAN_GATES.relay });
    case "target_not_found": throw new HttpError(404, "stream target not found");
    case "storage_exhausted": throw new HttpError(503, "recording storage is exhausted; no new stream can start", "storage_exhausted", { headroomMinutes: headroom });
    case "active_session": throw new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: refusal.activeSessionId ?? null });
    // W5 / T10 (capture QR v2 §6.7.1): nothing to stream from — the organiser pairs a phone before anything is weighed.
    case "phone_not_paired": throw new HttpError(409, "no phone is paired on this match's stream code", "phone_not_paired");
    // Owner ruling 2026-10-09 (Option 1): a phone IS paired but has gone silent (§6.9) — woken, not rescanned.
    case "phone_not_responding": throw new HttpError(409, "the phone paired on this match's stream code is not responding", "phone_not_responding");
  }
}

/** Seazn-hosted video (Task 11): a start on the Seazn destination while SEAZN_HOSTED_LIVE is off. The same code and words as
 *  the pick's own refusal (stream-codes.ts `writeStreamSettings`), so the organiser reads one answer for both. */
export const seaznUnavailable = (): HttpError => new HttpError(422, "Seazn hosted video is not available", SEAZN_UNAVAILABLE);
/** Task 11: LIVE is on, but a live relay has no SEAZN_VIDEO_ORIGINS to sign its playback with (G5) — the deployment's fault,
 *  the ingest's 503 family. No signing key is checked: Cloudflare live signing needs none (C1). */
export const seaznVideoUnconfigured = (): HttpError =>
  new HttpError(503, "Seazn hosted video is not configured on this deployment", SEAZN_VIDEO_UNCONFIGURED);

/** B2: a saved key that will not open (a KEK change, a damaged byte) is the organiser's to fix — a typed 422 naming the
 *  remedy, logged with the fixture, target and kind only. Any other error (a missing RELAY_KEK is one: secret-columns
 *  rethrows it, M3) is returned unchanged for the caller to throw. */
export function unreadableRefusal(err: unknown, fixtureId: string, targetId: string): unknown {
  // YouTube Connect T11: an API-backed destination never reaches this read (both callers branch on the row's source first), so
  // T8's interim mapping of its ApiBackedTargetError to the "replace the key" copy is gone — that remedy is meaningless for a
  // connection. Were one ever to arrive, it is returned unchanged: a named 500, never the pasted key's copy.
  if (!(err instanceof TargetSecretUnreadableError)) return err;
  log.warn({ fixtureId, targetId, kind: err.kind }, "stream session: the saved destination will not open — start refused; the organiser replaces the key");
  return TargetUnreadableError.forKind(err.kind);
}

/** M1: the early probe `createSession` runs before its first provider call. Under the same row lock admission takes, and
 *  only for this org's ACTIVE row — anything else is left for `admit` to answer 404, exactly as before. And only when
 *  `admit` would pass on everything it can weigh WITHOUT the storage read (`admitsBarStorage`, asked with this fixture's
 *  active session read on the same transaction): F-A5 (owner, 2026-09-29) puts "already running" — and the plan, the
 *  credit and the target's existence — before any destination question, and an unreadable key is one. Every such
 *  refusal is left for the admission below, which answers it as before, measurement included (the admission snapshot:
 *  ruling 13, streaming-r1 plan "Data captured"; pinned by the SAMPLES and SNAPSHOTS test). Found by the
 *  destination model's DEST_REGRESSION_FA5_UNREADABLE (stream-sessions.test.ts). */
export async function refuseUnreadableTarget(
  orgId: string, fixtureId: string, targetId: string, admitsBarStorage: (activeSessionId: string | null) => boolean,
): Promise<boolean> {
  // YouTube Connect T11: answers whether the probe PASSED on this org's active row — the gate for preparing a broadcast, which
  // must refuse nothing `admit` would answer first (F-A5) and must never be made for a start the admission is about to refuse.
  return (await sql.begin(async (tx) => {
    if (!(await lockStreamTarget(tx, orgId, targetId))) return false;
    if (!admitsBarStorage(await activeSessionIdFor(fixtureId, tx))) return false;
    // An API-backed row has no key of its own to open: its key is the pooled one `prepare` picks next, opened in admission.
    if ((await targetConnectionId(tx, orgId, targetId)) !== null) return true;
    await readTargetSecret(tx, orgId, targetId).catch((err: unknown) => { throw unreadableRefusal(err, fixtureId, targetId); });
    return true;
  })) as boolean;
}

/** T11, post-T2 amendment: a pooled key that will not open under a valid RELAY_KEK (`TargetSecretUnreadableError`, kind
 *  `youtube`, its id the KEY's) is never the pasted key's "replace the key" refusal — an API row has no key to replace. It is
 *  `youtube_unavailable` (503) naming the connection; the caller's abandon then deletes the prepared broadcast. A missing or
 *  malformed RELAY_KEK (rethrown by secret-columns, M3) and anything else is returned unchanged, for the caller to throw. */
export function pooledKeyRefusal(err: unknown, fixtureId: string, targetId: string, connectionId: string): unknown {
  if (!(err instanceof TargetSecretUnreadableError)) return err;
  log.warn({ fixtureId, targetId, keyId: err.targetId, connectionId }, "stream session: the broadcast's pooled stream key will not open — start refused youtube_unavailable");
  return youtubeRefusal("youtube_unavailable", connectionId);
}

/** Task 36d: Postgres rolled the transaction back whole — chosen as a deadlock victim (40P01) or unable to serialise it (40001).
 *  Nothing it wrote exists, and the same request run alone would not have met it. Read off the driver's `code`. */
export function isSerializationFailure(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "40P01" || code === "40001";
}

/** Task 36d (defence in depth, controller ruling): a start whose ADMISSION transaction Postgres rolled back as a deadlock victim
 *  or a serialization failure is answered as it would have been had it run AFTER the other transaction — read fresh, now that the
 *  other side has had its turn. This fixture already has an active session: `active_session` (admit's own answer, which outranks
 *  every destination question, F-A5). Another match holds this pasted destination: `target_in_use` naming it (the pre-check's
 *  answer; API-backed and Seazn rows hold nothing, `holderRows`). Neither: the typed, retryable 503 of the ingest family — the
 *  same start run again is admitted. Never the raw error, which the route answers as a 500. Reported, because a lock cycle that
 *  reaches here is a defect the lock order should not have (the target row lock's own cycle is closed: lockStreamTarget). */
export async function refuseRaceLoss(err: unknown, orgId: string, fixtureId: string, targetId: string): Promise<never> {
  const code = (err as { code?: unknown }).code;
  log.warn({ fixtureId, targetId, code }, "stream session: Postgres rolled the admission back (a race with another start) — answered as if the two had run one after the other");
  captureError(err, { orgId, route: "relay.session.admission_race", extra: { fixtureId, targetId, code } });
  const active = await activeSessionIdFor(fixtureId);
  if (active !== null) refuse({ ok: false, refusal: "active_session", activeSessionId: active }, 0);
  const [holder] = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  if (holder) throw targetInUse(holder);
  throw new HttpError(503, "another start met this one at the same moment; try again", "ingest_unavailable");
}
