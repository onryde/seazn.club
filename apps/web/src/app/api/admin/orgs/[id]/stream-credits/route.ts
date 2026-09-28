// POST /api/admin/orgs/[id]/stream-credits — the staff "Match credits" panel's three money actions
// (Task 7A, owner ruling 15; Revision 1). Outside the v1 OpenAPI spec (app/api/admin/**, like its
// donor ../credits/route.ts). Parse → authorize → delegate, AUTHORIZING FIRST as the donor does (a
// non-staff caller learns nothing about the body): requireStaff, the strict body, the org, a
// refund's session must be THIS org's, then Task 7's grantCredits / refundCredits / revokeCredits.
// Those own the org's advisory money lock, the idempotency key, the revoke floor, the refund cap,
// the one row AND its staff_audit_log row, all in one transaction; their 422 refusals and the
// 409 idempotency_key_reused reach the client, code included, through `handler`.
// This file writes no SQL and no audit row (plan Task 7A, deviation c).
//
// RESPONSE CONTRACT, for the panel that echoes it:
//   200 { ok: true, data: { id, balance, applied } } — SINGLE-wrapped. `handler` wraps Task 7's
//       StaffCreditResult exactly once, so a client reads `d.data.balance` with ONE `.data`. This
//       is a deliberate difference from the donor, which returns its own `{ ok: true, … }` INSIDE
//       the same wrapper and so answers a double-wrapped body.
//   `applied: false` is an EXACT replay of the key. **On that replay branch `balance` is the
//       CURRENT balance, not the balance the original row left behind** (Task 7's staffRow returns
//       the balance it read under the lock). So a panel that paints `data.balance` after a replay
//       shows a number that includes every write since the original — correct as a balance, but
//       NOT a re-statement of what that submission did. Deliberate: one authority for the balance
//       beats a stale snapshot. A panel that wants "what this submission did" must re-read.
//   401 non-staff or anonymous, BEFORE the body is parsed · 400 schema · 404 org_not_found (an
//   unknown or malformed org id) · 404 session_not_found (a refund naming a session that is not
//   this org's) · 409 idempotency_key_reused · 422 insufficient_credits / refund_exceeds_consumed
//   / delta_out_of_range / note_invalid (all four from Task 7's writer).
//   Everything a client acts on arrives in `code`: `handler` forwards `code` and DROPS `extra`
//   on the generic HttpError branch (lib/http.ts).
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { STREAM_CREDIT_ADJUST_MAX } from "@/server/usecases/admin-stream-credits";
import { STAFF_NOTE_MAX, grantCredits, refundCredits, revokeCredits } from "@/server/usecases/stream-credits";

/** IMPORTED, never a literal 50: `STREAM_CREDIT_ADJUST_MAX` is a re-export of the writer's own
 *  `STAFF_CREDIT_MAX`, which staffRow refuses past with a 422. Two numbers would mean a staff
 *  member meets a 422 where this form promised a 400. */
const Delta = z.number().int().min(1).max(STREAM_CREDIT_ADJUST_MAX);
/** The money audit trail: required, trimmed, and bounded by the writer's own `STAFF_NOTE_MAX`
 *  (imported for the same reason). zod 4 applies `.trim()` BEFORE the length checks — measured
 *  against zod 4.4.3 — so a whitespace-only note fails `.min(1)` here and is a 400, not the
 *  writer's 422. `staffRow` re-checks and stores the trimmed value; this is the status, not the
 *  authority. */
const Note = z.string().trim().min(1).max(STAFF_NOTE_MAX);
/** The donor's bounds exactly (api/admin/orgs/[id]/credits/route.ts:22). REQUIRED on every kind:
 *  the panel mints one per submission and resends it on a retry, so a replay writes nothing. */
const Key = z.string().min(8).max(200);
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), delta: Delta, note: Note, idempotency_key: Key }).strict(),
  z.object({ kind: z.literal("refund"), delta: Delta, note: Note, idempotency_key: Key, session_id: z.uuid().nullable().optional() }).strict(),
  z.object({ kind: z.literal("revoke"), delta: Delta, note: Note, idempotency_key: Key }).strict(),
]);

const orgNotFound = () => new HttpError(404, "Organization not found", "org_not_found");

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const body = Body.parse(await req.json().catch(() => null));          // unparseable JSON is a 400, not a 500
    if (!z.uuid().safeParse(id).success) throw orgNotFound();              // not Postgres 22P02 → 500
    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw orgNotFound();
    // `org.id`, never the URL's `id` (Revision 3, N1): z.uuid() accepts an upper-case id, the
    // lookup above matches it (a uuid compares by value), and a raw pass-through would reach Task 7
    // in the URL's spelling — staff_audit_log.target_id is TEXT, so the audit row would be filed
    // where this org's Adjustments log never looks. The stored id is the one authority.
    const common = { orgId: org.id, delta: body.delta, createdBy: staff.id, note: body.note, idempotencyKey: body.idempotency_key };

    if (body.kind === "grant") return grantCredits(common);
    if (body.kind === "revoke") return revokeCredits(common);
    const sessionId = body.session_id ?? null;
    if (sessionId) {
      // The route's own 404: Task 7's cap would answer 422 for a session with no consume row here.
      const [session] = await sql<{ id: string }[]>`
        select id from fixture_stream_sessions where id = ${sessionId} and org_id = ${id}`;
      if (!session) throw new HttpError(404, "No stream session with that id in this organisation", "session_not_found");
    }
    return refundCredits({ ...common, sessionId });
  });
}
