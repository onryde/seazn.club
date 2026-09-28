// POST /api/admin/orgs/[id]/stream-credits — the staff "Match credits" panel's three money actions
// (Task 7A, owner ruling 15; Revision 1). DB-backed. Only `requireUser` is doubled — the discovery
// route test's idiom (api/admin/competitions/[id]/discovery/__tests__/route.test.ts) — so the REAL
// requireStaff reads a REAL users row, and Task 7's REAL grantCredits / refundCredits /
// revokeCredits write REAL org_stream_credits and staff_audit_log rows. Skipped without
// DATABASE_URL. Killers for the PR's mutant table (Step 9):
//   S1 staff guard        requireStaff() → requireUser()                → "a signed-in NON-staff user"
//   S2 authorize first    move `Body.parse` above `requireStaff`        → the same test's malformed-body row
//   O1 session ownership  drop `and org_id = ${id}`                      → "THIS org's consumed session … ANOTHER org" (422, not 404)
//   O2 session existence  delete the whole session lookup                → "exists nowhere" (422, not 404)
//   O3 the org's own id   `orgId: org.id` → `orgId: id`                  → MEASURED EQUIVALENT, see below
//   N1 note required      Note: drop `.min(1)`                           → "the note is required" ('' rows)
//   N2 note trimmed       Note: drop `.trim()`                           → "the note is required" ('   ' rows)
//   N3 note bounded       Note: drop `.max(STAFF_NOTE_MAX)`              → "the note is required" (the one-past-the-max rows)
//   D1 delta ceiling      Delta: drop `.max(STREAM_CREDIT_ADJUST_MAX)`   → "delta bounds" (MAX + 1 row)
//   A1 author             `createdBy: staff.id` → `createdBy: id` (grant) → "staff grant" (created_by and the audit actor; the FK refuses an org id → 500)
//   K0 key bounds         Key: drop `.min(8)`                            → "idempotency_key is required" (7-char row)
//   K1 key passed through `idempotencyKey: body.idempotency_key` → `idempotencyKey: randomUUID()` (grant) → "a replayed key"
//   V2 revoke routed      revoke arm → `grantCredits(...)`                → "revoke"
// O3 is recorded as a MEASURED EQUIVALENT mutant, not a killed one. The plan's killer was "a route
// that passed the raw URL id files the audit row under the upper-case spelling, where this org's
// Adjustments log never finds it" — true when the plan was written, and FALSE since Task 7's fix
// round 2: `staffRow` now lower-cases the org id ITSELF (`const orgId = args.orgId.toLowerCase()`)
// and it is that value the audit insert's TEXT `target_id` carries. Every other use of the id
// downstream is a `uuid` comparison or `orgMoneyLockKey`, both case-insensitive, so `orgId: id` and
// `orgId: org.id` are observationally identical through this route. `org.id` is KEPT: it costs
// nothing and it stops this route depending on a normalisation that lives in another module (whose
// own mutants, m24/m27, are in stream-credits.test.ts). The assertion below is still worth its
// place — it pins that an upper-case /admin/orgs/<ID> URL is that org's own grant and that the
// audit row is findable by the stored id — but it is the WRITER it holds to that, not the route.
//
// N2 used to have a SECOND limb here — "staff grant"'s stored note. Task 7's re-review (I5) moved
// the note guard into `staffRow` itself, which now trims what it stores, so an untrimmed route no
// longer reaches the database with padding; what the route still owns is the STATUS (a schema 400,
// not the writer's 422), and the '   ' rows are its killer.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { STREAM_CREDIT_ADJUST_MAX } from "@/server/usecases/admin-stream-credits";
import { STAFF_NOTE_MAX, consumeForSession, grantCredits } from "@/server/usecases/stream-credits";

// vi.hoisted: the mock factory runs before this module's own consts initialise.
const { requireUserMock } = vi.hoisted(() => ({ requireUserMock: vi.fn<() => Promise<{ id: string }>>() }));
// Spread the real module: _rig.ts's usecases import from @/lib/auth too, and a bare factory
// would hand them `undefined` for every other export.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: () => requireUserMock(),
}));

import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const minted: string[] = [];

const post = (orgId: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/orgs/${orgId}/stream-credits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orgId }) },
  );

/** A fresh users row (`role` null = a plain signed-in user), signed in as the caller. */
async function signedIn(role: "support" | "superadmin" | null): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`stream-credits-${uniq()}@test.local`}, 'Credits Staff', true, ${role !== null}, ${role})
    returning id`;
  minted.push(id);
  requireUserMock.mockReset().mockResolvedValue({ id });
  return id;
}

async function freshOrg(): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Credits " + s}, ${"credits-" + s}) returning id`;
  return id;
}

type LedgerRow = { reason: string; delta: number; balance_after: number; note: string | null; created_by: string | null; session_id: string | null };
const ledger = async (orgId: string): Promise<LedgerRow[]> => [
  ...(await sql<LedgerRow[]>`
    select reason, delta, balance_after, note, created_by, session_id
      from org_stream_credits where org_id = ${orgId} order by created_at`),
];
/** Task 7's audit rows for an org — the route must add none of its own. */
const audits = async (orgId: string) => [
  ...(await sql<{ actor_id: string; action: string }[]>`
    select actor_id, action from staff_audit_log where target_id = ${orgId} order by created_at`),
];

/** A fresh key per submission, as the panel mints one. */
const k = () => `idem-${randomUUID()}`;

/** A real session in a real org that CONSUMED one credit, through Task 7's real producer. */
async function consumedSession(staffId: string): Promise<{ orgId: string; sessionId: string }> {
  const r = await streamRig({ createdBy: staffId });
  await grantCredits({ orgId: r.orgId, delta: 1, createdBy: staffId, note: "fund", idempotencyKey: k() });
  const sessionId = await r.session(r.fixtureIds[0]!);
  await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId }));
  return { orgId: r.orgId, sessionId };
}

afterAll(async () => {
  // Revoke, not delete: no staff bit minted here may outlive the file in a shared DB.
  if (HAS_DB && minted.length) await sql`update users set is_staff = false, staff_role = null where id = any(${minted})`;
});

describe.skipIf(!HAS_DB)("POST /api/admin/orgs/[id]/stream-credits", () => {
  it("a signed-in NON-staff user → 401 and no row — even with a malformed body (authorize BEFORE parse, S1/S2); an anonymous caller → 401", async () => {
    const orgId = await freshOrg();
    await signedIn(null);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "must not land", idempotency_key: k() })).status).toBe(401);
    expect((await post(orgId, { kind: "nope" })).status).toBe(401);
    requireUserMock.mockReset().mockRejectedValue(new AuthError("Not authenticated"));
    expect((await post(orgId, { kind: "grant", delta: 1, note: "must not land", idempotency_key: k() })).status).toBe(401);
    expect(await ledger(orgId)).toEqual([]);
    expect(await audits(orgId)).toEqual([]);
  });

  it("staff grant → 200 { id, balance, applied: true }, exactly ONE row (reason grant, the note TRIMMED, created_by = the staff user) and ONE audit row authored by that user (A1; the 401's positive pair)", async () => {
    const orgId = await freshOrg();
    const staffId = await signedIn("superadmin");
    const res = await post(orgId, { kind: "grant", delta: 3, note: "  pilot league  ", idempotency_key: k() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { id: expect.any(String), balance: 3, applied: true } });
    expect(await ledger(orgId)).toEqual([
      { reason: "grant", delta: 3, balance_after: 3, note: "pilot league", created_by: staffId, session_id: null },
    ]);
    expect(await audits(orgId)).toEqual([{ actor_id: staffId, action: "stream_credit_grant" }]);
  });

  it("a SUPPORT-role staff user may grant too — the guard is requireStaff, not requireSuperadmin", async () => {
    const orgId = await freshOrg();
    const staffId = await signedIn("support");
    expect((await post(orgId, { kind: "grant", delta: 1, note: "support grant", idempotency_key: k() })).status).toBe(200);
    expect((await ledger(orgId)).map((r) => r.created_by)).toEqual([staffId]);
  });

  it("the note is required and bounded by STAFF_NOTE_MAX: absent, '', '   ' and one character past the maximum → 400 with no row on ALL THREE kinds; 'x' and a note of exactly STAFF_NOTE_MAX → 200 (N1, N2, N3)", async () => {
    const orgId = await freshOrg();
    await signedIn("superadmin");
    // The bound is IMPORTED from the writer that enforces it (stream-credits.ts's STAFF_NOTE_MAX),
    // never typed here: the route's zod and staffRow's own 422 must be the same number, or a staff
    // member meets a 422 where the form promised a 400 (S10).
    const tooLong = "n".repeat(STAFF_NOTE_MAX + 1);
    for (const kind of ["grant", "refund", "revoke"] as const) {
      expect((await post(orgId, { kind, delta: 1, idempotency_key: k() })).status, `${kind} without a note`).toBe(400);
      for (const note of ["", "   ", tooLong]) {
        expect((await post(orgId, { kind, delta: 1, note, idempotency_key: k() })).status, `${kind} note length ${note.length}`).toBe(400);
      }
    }
    expect(await ledger(orgId)).toEqual([]);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "x", idempotency_key: k() })).status).toBe(200);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "y".repeat(STAFF_NOTE_MAX), idempotency_key: k() })).status).toBe(200);
    expect(await ledger(orgId)).toHaveLength(2);
  });

  it("delta bounds, derived from STREAM_CREDIT_ADJUST_MAX: 0, -1, 1.5, \"1\" and MAX + 1 → 400 with no row (a revoke's MAX + 1 too); grant 1, refund MAX and revoke MAX → 200 (D1)", async () => {
    const orgId = await freshOrg();
    await signedIn("superadmin");
    for (const delta of [0, -1, 1.5, "1", STREAM_CREDIT_ADJUST_MAX + 1]) {
      expect((await post(orgId, { kind: "grant", delta, note: "bounds", idempotency_key: k() })).status, `delta ${JSON.stringify(delta)}`).toBe(400);
    }
    expect((await post(orgId, { kind: "revoke", delta: STREAM_CREDIT_ADJUST_MAX + 1, note: "bounds", idempotency_key: k() })).status).toBe(400);
    expect(await ledger(orgId)).toEqual([]);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "floor", idempotency_key: k() })).status).toBe(200);
    expect((await post(orgId, { kind: "refund", delta: STREAM_CREDIT_ADJUST_MAX, note: "ceiling", idempotency_key: k() })).status).toBe(200);
    expect((await post(orgId, { kind: "revoke", delta: STREAM_CREDIT_ADJUST_MAX, note: "ceiling back", idempotency_key: k() })).status).toBe(200);
    expect((await ledger(orgId)).map((r) => [r.reason, r.delta])).toEqual([
      ["grant", 1], ["refund", STREAM_CREDIT_ADJUST_MAX], ["revoke", -STREAM_CREDIT_ADJUST_MAX],
    ]);
  });

  it("the body is strict: a grant or a revoke carrying session_id, an unknown field, an unknown kind, a refund whose session_id is '' or not a uuid → 400 with no row", async () => {
    const orgId = await freshOrg();
    await signedIn("superadmin");
    const bodies: unknown[] = [
      { kind: "grant", delta: 1, note: "n", idempotency_key: k(), session_id: randomUUID() },
      { kind: "revoke", delta: 1, note: "n", idempotency_key: k(), session_id: randomUUID() },
      { kind: "grant", delta: 1, note: "n", idempotency_key: k(), extra: true },
      { kind: "debit", delta: 1, note: "n", idempotency_key: k() },
      { kind: "refund", delta: 1, note: "n", idempotency_key: k(), session_id: "" },
      { kind: "refund", delta: 1, note: "n", idempotency_key: k(), session_id: "not-a-uuid" },
    ];
    for (const body of bodies) expect((await post(orgId, body)).status, JSON.stringify(body)).toBe(400);
    expect(await ledger(orgId)).toEqual([]);
  });

  it("idempotency_key is required on every kind, 8..200 chars (the donor's bounds): absent, 7 chars, 201 chars or a number → 400 with no row; 8 and 200 chars → 200 (K0)", async () => {
    const orgId = await freshOrg();
    await signedIn("superadmin");
    for (const kind of ["grant", "refund", "revoke"] as const) {
      for (const idempotency_key of [undefined, "1234567", "k".repeat(201), 12345678]) {
        expect((await post(orgId, { kind, delta: 1, note: "n", idempotency_key })).status, `${kind} key ${JSON.stringify(idempotency_key)}`).toBe(400);
      }
    }
    expect(await ledger(orgId)).toEqual([]);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "n", idempotency_key: randomUUID().slice(0, 8) })).status).toBe(200);
    expect((await post(orgId, { kind: "grant", delta: 1, note: "n", idempotency_key: randomUUID().repeat(6).slice(0, 200) })).status).toBe(200);
    expect(await ledger(orgId)).toHaveLength(2);
  });

  it("a replayed key → 200 applied false with the ORIGINAL id and balance, and still ONE ledger row and ONE audit row; the SAME key with a different amount → 409 idempotency_key_reused, its code forwarded, nothing written; a new key applies (K1, with its positive pair)", async () => {
    const orgId = await freshOrg();
    const staffId = await signedIn("superadmin");
    const key = k();
    const first = await (await post(orgId, { kind: "grant", delta: 2, note: "double click", idempotency_key: key })).json();
    const replay = await post(orgId, { kind: "grant", delta: 2, note: "double click", idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, data: { id: first.data.id, balance: 2, applied: false } });
    // Task 7's reused-key refusal through `handler`: the status AND the code reach the client.
    const reused = await post(orgId, { kind: "grant", delta: 3, note: "double click, retyped", idempotency_key: key });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ ok: false, code: "idempotency_key_reused" });
    expect(await ledger(orgId)).toHaveLength(1);
    expect(await audits(orgId)).toEqual([{ actor_id: staffId, action: "stream_credit_grant" }]);
    expect(await (await post(orgId, { kind: "grant", delta: 1, note: "a new submission", idempotency_key: k() })).json())
      .toMatchObject({ ok: true, data: { balance: 3, applied: true } });
    expect(await ledger(orgId)).toHaveLength(2);
  });

  it("an unknown org → 404 org_not_found; a non-uuid org id → 404, never a 500; a REAL org's id UPPER-cased (z.uuid() accepts it) → 200, and its audit row is findable under the org's STORED id (the writer normalises; O3 is equivalent — see the header)", async () => {
    const staffId = await signedIn("superadmin");
    const missing = await post(randomUUID(), { kind: "grant", delta: 1, note: "n", idempotency_key: k() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, code: "org_not_found" });
    expect((await post("not-a-uuid", { kind: "grant", delta: 1, note: "n", idempotency_key: k() })).status).toBe(404);
    // The positive pair: an id pasted in upper case is that org's OWN grant, not a 404 and not a
    // cross-org refusal, and the audit row is found under the stored (lower-case) id — which is
    // what this org's Adjustments log queries, `target_id` being TEXT. Task 7's writer is what
    // normalises it (m24/m27 over there); this route's `orgId: org.id` is belt and braces.
    const orgId = await freshOrg();
    const upper = await post(orgId.toUpperCase(), { kind: "grant", delta: 1, note: "a pasted upper-case id", idempotency_key: k() });
    expect(upper.status).toBe(200);
    expect(await upper.json()).toMatchObject({ ok: true, data: { balance: 1, applied: true } });
    expect(await audits(orgId)).toEqual([{ actor_id: staffId, action: "stream_credit_grant" }]);
  });

  it("a refund ADDS (Task 7's credit()): on a balance-0 org, an UNLINKED (goodwill) refund of 2 → 200 balance 2 — no refund can drive a balance negative", async () => {
    const orgId = await freshOrg();
    const staffId = await signedIn("support");
    const res = await post(orgId, { kind: "refund", delta: 2, note: "failed stream, session unknown", session_id: null, idempotency_key: k() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { balance: 2, applied: true } });
    expect(await ledger(orgId)).toEqual([
      { reason: "refund", delta: 2, balance_after: 2, note: "failed stream, session unknown", created_by: staffId, session_id: null },
    ]);
  });

  it("a refund naming THIS org's consumed session → 200 and the row carries it; the same session named against ANOTHER org → 404 session_not_found; a SECOND refund of that session → 422 refund_exceeds_consumed; no stray row anywhere (O1, Task 7's cap through the route)", async () => {
    const staffId = await signedIn("superadmin");
    const own = await consumedSession(staffId);
    const other = await freshOrg();
    expect((await post(own.orgId, { kind: "refund", delta: 1, note: "failed stream", session_id: own.sessionId, idempotency_key: k() })).status).toBe(200);
    const foreign = await post(other, { kind: "refund", delta: 1, note: "wrong org", session_id: own.sessionId, idempotency_key: k() });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ ok: false, code: "session_not_found" });
    const again = await post(own.orgId, { kind: "refund", delta: 1, note: "twice", session_id: own.sessionId, idempotency_key: k() });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ ok: false, code: "refund_exceeds_consumed" });
    expect(await ledger(other)).toEqual([]);
    expect((await ledger(own.orgId)).map((r) => [r.reason, r.delta, r.session_id])).toEqual([
      ["grant", 1, null], ["consume", -1, own.sessionId], ["refund", 1, own.sessionId],
    ]);
  });

  it("a refund naming a session id that exists NOWHERE → 404 session_not_found and no row (O2 — Task 7's cap would answer 422, so the 404 is the route's own check)", async () => {
    const orgId = await freshOrg();
    await signedIn("superadmin");
    const res = await post(orgId, { kind: "refund", delta: 1, note: "ghost", session_id: randomUUID(), idempotency_key: k() });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "session_not_found" });
    expect(await ledger(orgId)).toEqual([]);
  });

  it("revoke: 1 of 1 → 200 balance 0 with a NEGATIVE 'revoke' row and its audit row; 1 of 0 → 422 insufficient_credits with no row and no audit row (V2, Task 7's floor through the route)", async () => {
    const orgId = await freshOrg();
    const staffId = await signedIn("support");
    expect((await post(orgId, { kind: "grant", delta: 1, note: "mistaken grant", idempotency_key: k() })).status).toBe(200);
    const ok = await post(orgId, { kind: "revoke", delta: 1, note: "reverse the mistaken grant", idempotency_key: k() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, data: { balance: 0, applied: true } });
    const refused = await post(orgId, { kind: "revoke", delta: 1, note: "nothing left", idempotency_key: k() });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ ok: false, code: "insufficient_credits" });
    expect(await ledger(orgId)).toEqual([
      { reason: "grant", delta: 1, balance_after: 1, note: "mistaken grant", created_by: staffId, session_id: null },
      { reason: "revoke", delta: -1, balance_after: 0, note: "reverse the mistaken grant", created_by: staffId, session_id: null },
    ]);
    expect((await audits(orgId)).map((a) => a.action)).toEqual(["stream_credit_grant", "stream_credit_revoke"]);
  });
});
