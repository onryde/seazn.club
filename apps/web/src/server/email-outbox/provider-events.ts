import "server-only";
// Resend's delivery events, applied to the outbox row (spec "The webhook"). Called by POST /api/webhooks/resend after the
// signature has been verified; nothing here trusts the payload beyond treating it as a lookup key.
//
// MATCHING. By `data.email_id` = the row's `provider_id`. A row whose send timed out (Resend accepted it, the 200 never
// arrived) has no `provider_id`, so the fallback is the outbox TAG the sender attaches to every message (`{ outbox: <row
// id> }`, constants.ts OUTBOX_TAG_NAME): Resend echoes tags back as a name -> value map, and the send request carries them as
// `[{ name, value }]`, so both shapes are read. A tag match also writes `provider_id`, so the next event needs no tag. A tag is
// used only for a row that has NO provider id yet: a row that already has one is a different message and is left alone.
//
// MONOTONIC. A row moves only UP the ladder below, and only when the target's rank is strictly greater than its current rank:
//   queued / sending 0  <  sent 1  <  delayed 2  <  delivered 3  <  bounced / complained / failed / suppressed 4.
// So a late `delivered` after `delayed` wins, a late `delayed` (or a repeated `delivered`) after `delivered` is ignored, and the
// four final statuses never move again. `complained` and `bounced` DO move a `delivered` row: a complaint arrives after
// delivery by nature (accepted ruling). `replaced`, `expired` and `dead` are not on the ladder and never move. The rule lives
// in the UPDATE's `where`, in ONE statement, so two events racing for a row cannot regress it whatever order they land in.
//
// A move into a badly-ended status runs the kind's hook through the same `afterEndedBadly` the worker uses (a chess seat is
// released when every row for it has ended badly). The hook runs AFTER the write and is idempotent; if this process dies
// between the two, the worker's re-drive (hooks.ts findUnappliedEndings) finishes the job.
//
// Never log the payload: it carries the recipient's address. The log lines name the event type and ids only.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { ENDED_BADLY_STATUSES, OUTBOX_TAG_NAME, type OutboxKind, type OutboxStatus } from "./constants";
import { afterEndedBadly } from "./hooks";

/** Statuses that are not on the ladder: a webhook never moves them (superseded, never sent, or given up on). */
export const UNMOVABLE_STATUSES = ["replaced", "expired", "dead"] as const satisfies readonly OutboxStatus[];
type RankedStatus = Exclude<OutboxStatus, (typeof UNMOVABLE_STATUSES)[number]>;

/** The ladder. A `Record` over every status that is not unmovable, so a new status is a compile error here until it is placed. */
export const STATUS_RANK: Readonly<Record<RankedStatus, number>> = {
  queued: 0,
  sending: 0,
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
  suppressed: 4,
};

/** The events Resend sends that the outbox tracks, and the status each means. */
export const PROVIDER_EVENT_STATUS = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
} as const satisfies Record<string, RankedStatus>;

export type ProviderEventType = keyof typeof PROVIDER_EVENT_STATUS;
export type ProviderEventResult = "moved" | "ignored" | "unknown" | "not_tracked";

/** The statuses a row may be in for `target` to move it: strictly below the target's rank. */
const movableFrom = (target: RankedStatus): RankedStatus[] =>
  (Object.keys(STATUS_RANK) as RankedStatus[]).filter((s) => STATUS_RANK[s] < STATUS_RANK[target]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The outbox row id carried by a message's tags, or null. Accepts an object map `{ outbox: id }` (what a webhook delivers)
 * and an array `[{ name: "outbox", value: id }]` (what the send request carries). Anything else, and any value that is not a
 * uuid, is null: the id goes into a uuid comparison, and a malformed one would be a cast error, which the route would turn
 * into a 500 that Resend retries for ever.
 */
function tagIdOf(tags: unknown): string | null {
  const candidates: unknown[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) if (isRecord(t) && t.name === OUTBOX_TAG_NAME) candidates.push(t.value);
  } else if (isRecord(tags) && Object.hasOwn(tags, OUTBOX_TAG_NAME)) {
    candidates.push(tags[OUTBOX_TAG_NAME]);
  }
  return candidates.find((v): v is string => typeof v === "string" && UUID.test(v)) ?? null;
}

/** The row an event is about: by provider id, else by tag (only a row that has no provider id yet). */
async function findRow(emailId: string, tagId: string | null): Promise<string | null> {
  const [byProvider] = await sql<{ id: string }[]>`select id from email_outbox where provider_id = ${emailId}`;
  if (byProvider) return byProvider.id;
  if (tagId === null) return null;
  const [byTag] = await sql<{ id: string }[]>`select id from email_outbox where id = ${tagId} and provider_id is null`;
  return byTag?.id ?? null;
}

type MovedRecord = { id: string; kind: OutboxKind; ref_type: string; ref_id: string; meta: Record<string, string> };

/**
 * Apply one Resend event. `moved`: a row changed status. `ignored`: a row matched and the monotonic rule left it alone (a
 * duplicate, or an older event arriving late). `unknown`: no row (an email that is not on the outbox, or an event without a
 * usable id). `not_tracked`: a type the outbox does not follow (email.sent, email.opened, ...).
 *
 * A database failure propagates: the route answers 500 and Resend retries, and a retried event is safe (idempotent by the
 * monotonic rule).
 */
export async function applyProviderEvent(type: string, data: Record<string, unknown>): Promise<ProviderEventResult> {
  // hasOwn: "constructor" and "__proto__" are keys of every plain object, and are not events.
  if (!Object.hasOwn(PROVIDER_EVENT_STATUS, type)) return "not_tracked";
  const target = PROVIDER_EVENT_STATUS[type as ProviderEventType];

  const emailId = typeof data.email_id === "string" && data.email_id !== "" ? data.email_id : null;
  if (emailId === null) return "unknown";

  const rowId = await findRow(emailId, tagIdOf(data.tags));
  if (rowId === null) return "unknown";

  // The write that carries the rule. `status_at` takes the later of its own and now(), so a clock step cannot move it
  // backwards. `provider_id`: the row either holds this id already (matched by it) or holds none (matched by tag), so
  // assigning it records the id for a tag match and changes nothing otherwise.
  const [moved] = await sql<MovedRecord[]>`
    update email_outbox
       set status = ${target}, status_at = greatest(status_at, now()), body_sealed = null, lease_until = null,
           provider_id = ${emailId}
     where id = ${rowId} and status = any(${movableFrom(target)}::text[])
    returning id, kind, ref_type, ref_id, meta`;
  if (!moved) return "ignored";

  log.info({ type, emailId, outboxId: moved.id, status: target }, "resend-webhook: outbox row moved");
  if (ENDED_BADLY_STATUSES.includes(target)) {
    await afterEndedBadly([
      { id: moved.id, kind: moved.kind, refType: moved.ref_type, refId: moved.ref_id, status: target, meta: moved.meta },
    ]);
  }
  return "moved";
}
