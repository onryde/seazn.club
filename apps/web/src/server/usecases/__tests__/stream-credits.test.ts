// The money ledger (design §5.2, §5.4) and the staff writers (Task 7A rulings). Real
// Postgres; skipped without DATABASE_URL. Killers recorded for the PR's mutant table:
//   m2  delete `await lockOrg(tx, args.orgId)` in consumeForSession → "two concurrent consumers"
//   m3  drop stripe_event_id unique (or the on-conflict)      → "a replayed purchase"
//   m5  delete the 24 h reuse rule                            → "a restart on the same fixture inside the reuse window" (and its past-the-window half)
//   m6  delete the whole `if (prior) { … }` block (THE key check) → "a replayed grant" (the unique index's 23505, answered as 409)
//   m7  revoke: `debit(balance, args.delta)` → `{ balanceAfter: balance - args.delta }` → "revoke" (23514, not 422)
//   m8  delete the linked-refund cap `if … throw`             → "a session-linked refund is capped"
//   m9  cap ignores prior refunds: `s!.refunded + args.delta > s!.consumed` → `args.delta > s!.consumed` → the same test
//   m10 move the key lookup and its `if (prior) { … }` BELOW the guard block → "a replayed session-linked refund"
//   m11 delete the staff_audit_log insert                     → "a replayed grant" (audit count) and the read-back in "revoke"
//   m12 write an audit row on the replay path too             → "a replayed grant" (2 audit rows)
//   m13 drop `prior.org_id === args.orgId.toLowerCase() &&` from `same` → "a key reused for a DIFFERENT adjustment" (another org's row answers applied false)
//   m14 delete `await lockOrg(tx, args.orgId)` in staffRow    → "first-ever writes on an EMPTY ledger" (1 waiter, not 3; the same-key pair both miss the key, one rejects)
//   m15 delete `await lockOrg(tx, args.orgId)` in recordPurchase → "first-ever writes on an EMPTY ledger" (2 waiters, not 3)
//   m16 delete `if (!same) throw …` (the reused-key refusal)  → "a key reused for a DIFFERENT adjustment" (every row answers applied false)
//   m17 drop `prior.delta === delta &&` from `same`           → "a key reused for a DIFFERENT adjustment" (the different-delta row)
//   m18 drop `prior.reason === kind &&` from `same`           → "a key reused for a DIFFERENT adjustment" (the different-kind row)
//   m19 drop `&& prior.session_id === sessionId` from `same`  → "a key reused for a DIFFERENT adjustment" (the different-session row)
//   m20 the null-fixture skip → `s.fixture_id is not distinct from ${args.fixtureId}` → "a session whose fixture is GONE"
//   m21 drop `.toLowerCase()` in orgMoneyLockKey             → "first-ever writes on an EMPTY ledger" (the upper/lower key assertion; the upper-case hold queues nobody)
//   m22 delete staffRow's `.catch` (23505 on the key index → 409) → "the same key on two DIFFERENT orgs at once" (a raw 23505)
// Fix round 1 (review C1, C2, I4):
//   m23 drop `and org_id = …` from recordPurchase's replay read-back (and its mismatch throw)
//                                                             → "the SAME stripe_event_id arriving for a DIFFERENT org"
//   m24 drop `.toLowerCase()` on the audit row's target_id     → "a staff write made through an UPPER-CASE org id"
//   m25 drop `|| args.delta > STAFF_CREDIT_MAX` from staffRow's range guard → "…between 1 and STAFF_CREDIT_MAX" (the "past the max (m25)" row)
//   m26 drop `args.delta < 1 ||` from the same guard           → the same test (the "zero (m26)" row)
// Fix round 2 (re-review N1): C2 normalised THREE surfaces and only the audit COLUMN had a mutant.
// m13 proves the `prior` comparison EXISTS, not that it compares a normalised value, so both
// comparisons survived all 18 tests. One mutant each, never one combined:
//   m27 `prior.org_id === orgId` → `=== args.orgId`      → "a staff REPLAY made through an UPPER-CASE org id"
//   m28 `existing!.org_id !== args.orgId.toLowerCase()` → `!== args.orgId`
//                                                        → "a purchase replay made through an UPPER-CASE org id"
// Fix round 3 (Task 7 re-review, carried into Task 7A: I5, I3, N6). Each is a guard the writer
// owns because the route is not its only caller — Tasks 10/11/12 call these functions directly:
//   m29 drop `note.length < 1 ||` from the note guard   → "a staff write needs a REASON" (the empty row)
//   m30 drop `|| note.length > STAFF_NOTE_MAX`          → the same test (the one-past-the-max row)
//   m31 `const note = args.note.trim()` → `args.note`   → the same test (the whitespace row AND the stored/audited note)
//   m32 move the staff_audit_log insert AFTER sql.begin → "the ledger row and its audit row are ONE transaction"
//   m33 write the audit row on the pool's `sql` instead of `tx` → the same test's xmin assertion
//   m34 drop `args.delta <= 0` from recordPurchase's guard → "recordPurchase refuses a delta" (0 and -1)
//   m35 drop `!Number.isInteger(args.delta)` from it       → the same test (the fraction row)
// The races use the registration-concurrency.test.ts idiom: REAL calls, the lock held by
// a transaction the test controls, and every waiter observed BLOCKED before release —
// here in pg_locks (not granted), scoped to waiters blocked BY the holder's own backend
// pid (pg_blocking_pids), so no parallel worker's lock is ever counted and no sleep
// guesses the timing. The money-lock races wait on an `advisory` lock; the cross-org key
// race waits on the other writer's `transactionid` (a unique-index insert conflict).
//
// EVERY stripe_event_id here is scoped to its own org id. The column is TABLE-wide unique
// (V410) and this suite runs against a database that is NOT recreated between runs, so a
// literal like `evt_link_1` passes once and then answers `applied: false` out of the
// previous run's row — a second run would read a balance of 0 and go red on the consume.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { CREDIT_REUSE_HOURS } from "@/server/relay/config";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { adjustmentsForOrg } from "../admin-adjustments-log";
import {
  NoCreditsError, STAFF_CREDIT_MAX, STAFF_NOTE_MAX, consumeForSession, creditBalance, grantCredits, lockOrg, orgMoneyLockKey, recordPurchase, refundCredits, revokeCredits,
} from "../stream-credits";

const HAS_DB = !!process.env.DATABASE_URL;

async function rig(fixtures: 1 | 2 = 1) {
  const r = await streamRig({ fixtures });
  return { orgId: r.orgId, userId: r.createdBy, fixtureIds: r.fixtureIds, session: r.session };
}

/** A fresh key per staff write — what the panel mints per submission. */
const key = () => `idem-${randomUUID()}`;

const auditRows = (orgId: string) =>
  sql<{ actor_id: string; action: string; target_type: string; detail: Record<string, unknown> }[]>`
    select actor_id, action, target_type, detail from staff_audit_log where target_id = ${orgId} order by created_at`;

/** Advisory-lock waiters blocked BY one backend (the holder's pid): pg_locks, never
 *  pg_stat_activity's query text (an advisory wait's text names no table). Bounded poll
 *  that returns what it last saw: on a mutant fewer writers queue, the poll times out, and
 *  the caller's exact-count assertion is what goes red. */
async function advisoryWaitersBehind(holderPid: number, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    seen = row!.n;
    if (seen >= want || Date.now() >= deadline) return seen;
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** The same bounded poll for a waiter on another transaction's uncommitted row: an insert that
 *  conflicts with an uncommitted unique-index entry waits on that transaction's id
 *  (`locktype = 'transactionid'`), blocked BY the holder's pid. */
async function keyWaitersBehind(holderPid: number, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'transactionid' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    seen = row!.n;
    if (seen >= want || Date.now() >= deadline) return seen;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe.skipIf(!HAS_DB)("stream credits — the ledger", () => {
  it("an empty ledger has balance 0 (the empty set, explicitly)", async () => {
    const r = await rig();
    expect(await creditBalance(sql, r.orgId)).toBe(0);
  });

  it("purchase + consume + refund sum, and every row's balance_after is the running sum", async () => {
    const r = await rig();
    const p = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: `cs_${r.orgId}_a` });
    expect(p.applied).toBe(true);
    expect(p.balance).toBe(5);
    const sid = await r.session(r.fixtureIds[0]!);
    const c = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid }));
    expect(c).toEqual({ consumed: true, balance: 4, ledgerId: expect.any(String) });
    const rf = await refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "test", idempotencyKey: key() });
    expect(rf).toEqual({ id: expect.any(String), balance: 5, applied: true });
    const g = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "pilot", idempotencyKey: key() });
    expect(g).toEqual({ id: expect.any(String), balance: 7, applied: true });
    expect(await creditBalance(sql, r.orgId)).toBe(7);
    const rows = await sql<{ delta: number; balance_after: number; reason: string }[]>`
      select delta, balance_after, reason from org_stream_credits where org_id = ${r.orgId} order by created_at`;
    expect(rows.map((x) => [x.reason, x.delta, x.balance_after])).toEqual([
      ["purchase", 5, 5], ["consume", -1, 4], ["refund", 1, 5], ["grant", 2, 7],
    ]);
  });

  it("a replayed purchase (same stripe_event_id) writes no second row (m3)", async () => {
    const r = await rig();
    const a = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: `cs_${r.orgId}_replay` });
    const b = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: `cs_${r.orgId}_replay` });
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false);
    expect(b.id).toBe(a.id);
    expect(await creditBalance(sql, r.orgId)).toBe(5);
  });

  it("the SAME stripe_event_id arriving for a DIFFERENT org is refused 409 stripe_event_org_mismatch with no row and no credit — while that org's own replay still answers applied false with ITS OWN row's id (m23)", async () => {
    const r = await rig();
    const other = await rig();
    const evt = `evt_xorg_${r.orgId}`;
    const first = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: evt });
    expect(first).toMatchObject({ applied: true, balance: 5 });
    // `on conflict (stripe_event_id) do nothing` writes nothing here, and the read-back must not
    // hand this caller the FIRST org's row: that answers `applied: false` to an org that paid and
    // got no credit, and the returned id would cross-link two orgs through credit_ledger_id.
    await expect(recordPurchase({ orgId: other.orgId, delta: 5, stripeEventId: evt }))
      .rejects.toMatchObject({ status: 409, code: "stripe_event_org_mismatch" });
    expect(await creditBalance(sql, other.orgId)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${other.orgId}`;
    expect(n).toBe(0);
    // The positive pair: the SAME org's replay is still an idempotent no-op returning its own row.
    expect(await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: evt }))
      .toEqual({ id: first.id, applied: false, balance: 5 });
  });

  it("a purchase replay made through an UPPER-CASE org id is that org's own idempotent no-op, NOT a cross-org refusal: applied false with the original id, one row, balance unchanged (m28)", async () => {
    const r = await rig();
    const evt = `evt_upper_${r.orgId}`;
    const first = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: evt });
    expect(first).toMatchObject({ applied: true, balance: 5 });
    // The org-scoped read-back above compares the STORED org against this caller's. Postgres returns
    // uuids lower-case, so the stored side is always lower-case; if the caller's side were compared
    // RAW, this same org's own replay would be refused 409 stripe_event_org_mismatch — the guard
    // firing on the org it is meant to protect. `m13` proves the comparison exists, never that it
    // compares a normalised value, which is why this case is its own `it`.
    expect(await recordPurchase({ orgId: r.orgId.toUpperCase(), delta: 5, stripeEventId: evt }))
      .toEqual({ id: first.id, applied: false, balance: 5 });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
    expect(n).toBe(1);
    expect(await creditBalance(sql, r.orgId)).toBe(5);
  });

  it("balance 0 → NoCreditsError 402 no_credits; balance 1 → consumed (the positive pair)", async () => {
    const r = await rig();
    const sid = await r.session(r.fixtureIds[0]!);
    await expect(
      sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid })),
    ).rejects.toBeInstanceOf(NoCreditsError);
    await expect(
      sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid })),
    ).rejects.toMatchObject({ status: 402, code: "no_credits" });
    await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "one", idempotencyKey: key() });
    const c = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid }));
    expect(c).toEqual({ consumed: true, balance: 0, ledgerId: expect.any(String) });
  });

  it("a restart on the same fixture inside the reuse window consumes nothing; one hour past it consumes again (m5, differential)", async () => {
    const r = await rig();
    await grantCredits({ orgId: r.orgId, delta: 3, createdBy: r.userId, note: "three", idempotencyKey: key() });
    const first = await r.session(r.fixtureIds[0]!, "failed");
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: first }));
    const second = await r.session(r.fixtureIds[0]!);
    const again = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: second }));
    expect(again).toEqual({ consumed: false, balance: 2, ledgerId: null });   // nothing was written, so there is no id
    // Push the consume row past the window — the ONLY thing that changes. The offset is DERIVED
    // from CREDIT_REUSE_HOURS (config.ts, the one authority `withinReuseWindow` itself reads), not
    // a typed `interval '25 hours'`: moving the constant must move this test with it rather than
    // leave it asserting yesterday's number (S10's oracle order).
    await sql`update org_stream_credits
                 set created_at = now() - make_interval(hours => ${CREDIT_REUSE_HOURS + 1})
              where org_id = ${r.orgId} and reason = 'consume'`;
    const later = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: second }));
    expect(later).toEqual({ consumed: true, balance: 1, ledgerId: expect.any(String) });
  });

  it("two concurrent consumers on two fixtures with balance 1: exactly one consumes, one gets no_credits (m2)", async () => {
    const r = await rig(2);
    await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "one", idempotencyKey: key() });
    const sidA = await r.session(r.fixtureIds[0]!);
    const sidB = await r.session(r.fixtureIds[1]!);

    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((res) => (releaseA = res));
    let signalALocked!: (pid: number) => void;
    const aLocked = new Promise<number>((res) => (signalALocked = res));

    const a = sql.begin(async (tx) => {
      const out = await consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sidA });
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      signalALocked(pid);       // A holds the org's money lock now, on THIS backend
      await aMayCommit;         // …and parks until the test has seen B block
      return out;
    });
    const aPid = await aLocked;
    const b = sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[1]!, sessionId: sidB }));

    // B must be a REAL waiter blocked by A's backend before A is released (pg_locks, scoped
    // to A's pid). On the m2 mutant nothing blocks, the poll times out at 0, and both this
    // count and the OUTCOME assertions below turn red.
    const blocked = await advisoryWaitersBehind(aPid, 1, 2000);
    releaseA();

    const results = await Promise.allSettled([a, b]);
    const ok = results.filter((x): x is PromiseFulfilledResult<{ consumed: boolean; balance: number; ledgerId: string | null }> => x.status === "fulfilled");
    const bad = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(blocked, "B never queued behind A's backend on the org's money lock (pg_locks: advisory, not granted, blocked by A's pid)").toBe(1);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.value).toEqual({ consumed: true, balance: 0, ledgerId: expect.any(String) });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(NoCreditsError);
    expect(await creditBalance(sql, r.orgId)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.orgId} and reason = 'consume'`;
    expect(n).toBe(1);
  });

  // ---- The staff writers (Task 7A rulings, 2026-09-16) --------------------------------

  it("a staff write made through an UPPER-CASE org id is still findable in that org's Adjustments log: staff_audit_log.target_id is TEXT, so the ledger row's uuid normalises but the audit row's id would not (m24)", async () => {
    const r = await rig();
    // What a staffer's own pasted /admin/orgs/<ID> URL produces: z.uuid() accepts it and the
    // organizations lookup is a uuid comparison, so the page resolves and 7A calls through.
    const g = await grantCredits({ orgId: r.orgId.toUpperCase(), delta: 3, createdBy: r.userId, note: "an upper-case admin url", idempotencyKey: key() });
    expect(g).toMatchObject({ balance: 3, applied: true });
    // The REAL reader, in the canonical (lower-case) spelling every other adjustment row uses —
    // adjustmentsForOrg compares target_id as an exact STRING (`and s.target_id = ${orgId}`), so an
    // un-normalised insert is a money movement with a permanently unfindable audit trail.
    expect((await adjustmentsForOrg(r.orgId)).map((e) => [e.action, e.category, e.reason, e.actorId])).toEqual([
      ["stream_credit_grant", "credits", "an upper-case admin url", r.userId],
    ]);
    // …and the ledger agrees with it, so the balance panel and the log cannot disagree.
    expect(await creditBalance(sql, r.orgId)).toBe(3);
  });

  it("a staff REPLAY made through an UPPER-CASE org id is the SAME adjustment, not a reused key: applied false with the original id, still one ledger row and one audit row (m27)", async () => {
    const r = await rig();
    const k = key();
    const first = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "pilot league", idempotencyKey: k });
    expect(first).toMatchObject({ balance: 2, applied: true });
    // The retry arrives from a hand-typed /admin/orgs/<ID> URL, carrying the same minted key. The
    // stored row's org_id is lower-case (uuid), so comparing it against the RAW argument makes this
    // legitimate replay a 409 idempotency_key_reused. That is not a harmless wrong status: the
    // panel's documented answer to that 409 is to drop the card's key, reset, and let staff retry —
    // and the retry mints a NEW key, so the grant lands a SECOND time. A double grant, reached by
    // nothing worse than an org id typed in upper case.
    expect(await grantCredits({ orgId: r.orgId.toUpperCase(), delta: 2, createdBy: r.userId, note: "pilot league", idempotencyKey: k }))
      .toEqual({ id: first.id, balance: 2, applied: false });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
    expect(n).toBe(1);
    expect(await auditRows(r.orgId)).toHaveLength(1);
    expect(await creditBalance(sql, r.orgId)).toBe(2);
  });

  it("a staff write moves between 1 and STAFF_CREDIT_MAX credits: BOTH boundaries apply, while 0 and one past the maximum are refused 422 delta_out_of_range with no row — the bound is the exported constant, never a literal (m25, m26)", async () => {
    const r = await rig();
    // The two accepted boundaries. STAFF_CREDIT_MAX is IMPORTED, so moving the ruled cap moves this
    // test and 7A's zod together instead of leaving either asserting yesterday's number.
    expect(await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "the floor", idempotencyKey: key() }))
      .toMatchObject({ balance: 1, applied: true });
    expect(await grantCredits({ orgId: r.orgId, delta: STAFF_CREDIT_MAX, createdBy: r.userId, note: "the ceiling", idempotencyKey: key() }))
      .toMatchObject({ balance: 1 + STAFF_CREDIT_MAX, applied: true });
    // Both refusals, settled rather than `.rejects`-ed, so each bound's mutant names ITSELF (a
    // `.rejects` label is dropped on exactly the "resolved instead of rejecting" path a deleted
    // bound takes — measured in this file's reused-key `it`).
    const refusals: [string, number][] = [["zero (m26)", 0], ["past the max (m25)", STAFF_CREDIT_MAX + 1]];
    const outcomes: [string, { refused: boolean; status?: number; code?: string }][] = [];
    for (const [label, delta] of refusals) {
      outcomes.push([
        label,
        await grantCredits({ orgId: r.orgId, delta, createdBy: r.userId, note: label, idempotencyKey: key() }).then(
          () => ({ refused: false }),
          (e: unknown) => ({ refused: true, status: (e as { status?: number }).status, code: (e as { code?: string }).code }),
        ),
      ]);
    }
    expect(outcomes, "both delta bounds must be exercised").toHaveLength(2);
    const notRefused = outcomes
      .filter(([, o]) => !(o.refused && o.status === 422 && o.code === "delta_out_of_range"))
      .map(([label]) => label)
      .join(" | ");
    expect(notRefused, "a delta outside 1..STAFF_CREDIT_MAX must be refused 422 delta_out_of_range").toBe("");
    // Neither refusal wrote anything: only the two accepted boundaries are on the ledger.
    const rows = await sql<{ delta: number }[]>`
      select delta from org_stream_credits where org_id = ${r.orgId} order by created_at`;
    expect(rows.map((x) => x.delta)).toEqual([1, STAFF_CREDIT_MAX]);
    expect(await auditRows(r.orgId)).toHaveLength(2);
  });

  it("a staff write needs a REASON: '', a whitespace-only note and one past STAFF_NOTE_MAX are refused 422 note_invalid with no row, while 'x' and a note of exactly STAFF_NOTE_MAX apply — and the STORED note, in the ledger row AND in the audit detail, is the TRIMMED one (I5: m29, m30, m31)", async () => {
    const r = await rig();
    // The accepted boundaries FIRST, so the refusals below cannot be read as a writer that refuses
    // everything. STAFF_NOTE_MAX is IMPORTED — never a 500 typed here (S10). The bound is not
    // cosmetic: the note lands in staff_audit_log.detail, which V111 canonicalises into a hash
    // chain, so an unbounded note is a real column hazard.
    expect(await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "x", idempotencyKey: key() }))
      .toMatchObject({ balance: 1, applied: true });
    expect(await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "y".repeat(STAFF_NOTE_MAX), idempotencyKey: key() }))
      .toMatchObject({ balance: 2, applied: true });
    // Settled rather than `.rejects`-ed, so each bound's mutant names ITSELF: a deleted bound
    // RESOLVES, and that is exactly the path whose custom label vitest drops (measured above).
    const refusals: [string, string][] = [
      ["empty (m29)", ""],
      ["whitespace only (m31)", "   "],
      ["one past STAFF_NOTE_MAX (m30)", "z".repeat(STAFF_NOTE_MAX + 1)],
    ];
    const outcomes: [string, { refused: boolean; status?: number; code?: string }][] = [];
    for (const [label, note] of refusals) {
      outcomes.push([
        label,
        await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note, idempotencyKey: key() }).then(
          () => ({ refused: false }),
          (e: unknown) => ({ refused: true, status: (e as { status?: number }).status, code: (e as { code?: string }).code }),
        ),
      ]);
    }
    expect(outcomes, "all three note bounds must be exercised").toHaveLength(3);
    const notRefused = outcomes
      .filter(([, o]) => !(o.refused && o.status === 422 && o.code === "note_invalid"))
      .map(([label]) => label)
      .join(" | ");
    expect(notRefused, "a note outside 1..STAFF_NOTE_MAX after trimming must be refused 422 note_invalid").toBe("");
    // The stored note is the trimmed one, in BOTH places an operator reads it. A reason of pure
    // whitespace is what admin-adjustments-log.ts's text() turns into null — a money movement
    // rendered in the Adjustments log with no reason at all, which is the defect I5 names.
    const padded = await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "  pilot league  ", idempotencyKey: key() });
    const [stored] = await sql<{ note: string }[]>`select note from org_stream_credits where id = ${padded.id}`;
    expect(stored!.note).toBe("pilot league");
    expect((await auditRows(r.orgId)).map((a) => a.detail.reason)).toEqual(["x", "y".repeat(STAFF_NOTE_MAX), "pilot league"]);
    // Not one of the three refusals wrote a row: only the three accepted notes are on the ledger.
    const rows = await sql<{ note: string }[]>`
      select note from org_stream_credits where org_id = ${r.orgId} order by created_at`;
    expect(rows.map((x) => x.note)).toEqual(["x", "y".repeat(STAFF_NOTE_MAX), "pilot league"]);
  });

  it("the ledger row and its staff_audit_log row are ONE transaction: both carry the same xmin, and an audit insert that FAILS leaves NO ledger row behind (I3: m32, m33)", async () => {
    const r = await rig();
    // POSITIVE, and the part an audit COUNT cannot see: xmin is the xid that inserted a row, so
    // equal xmins ARE the shared transaction. m11 (delete the audit insert) is killed by a count;
    // an audit write moved onto its own connection, or after sql.begin, is not — it leaves the row
    // present and the count green while the money and its trail can now commit apart.
    const g = await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "atomic", idempotencyKey: key() });
    const [led] = await sql<{ x: string }[]>`select xmin::text as x from org_stream_credits where id = ${g.id}`;
    const [aud] = await sql<{ x: string }[]>`
      select xmin::text as x from staff_audit_log where detail->>'ledger_id' = ${g.id}`;
    expect(aud, "the grant wrote no audit row naming its ledger id").toBeTruthy();
    expect(aud!.x, "the audit row was written by a DIFFERENT transaction from its ledger row").toBe(led!.x);
    // NEGATIVE, and cheap because the schema already disagrees with itself here:
    // org_stream_credits.created_by is `uuid null` with NO foreign key (V410), while
    // staff_audit_log.actor_id is `not null references users(id)` (V103). An author who is not a
    // users row therefore inserts the ledger row and then fails the audit insert on 23503 — and
    // only a shared transaction takes the money back with it.
    const ghost = randomUUID();
    const before = await creditBalance(sql, r.orgId);
    await expect(
      grantCredits({ orgId: r.orgId, delta: 5, createdBy: ghost, note: "an author who is not a user", idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: "23503" });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.orgId} and created_by = ${ghost}`;
    expect(n, "a ledger row survived an audit insert that failed — the two are not one transaction").toBe(0);
    expect(await creditBalance(sql, r.orgId)).toBe(before);
  });

  it("recordPurchase refuses a delta that is not a positive integer: 0, -1 and 1.5 → 422 delta_invalid with no row; 1 applies (N6: m34, m35)", async () => {
    const r = await rig();
    // The refusal had no `code` until now, so `handler` forwarded a bare 422 and no client could
    // tell it from the ledger's own refusals. Settled, for the same labelling reason as above.
    const refusals: [string, number][] = [["zero (m34)", 0], ["negative (m34)", -1], ["a fraction (m35)", 1.5]];
    const outcomes: [string, { refused: boolean; status?: number; code?: string }][] = [];
    for (const [label, delta] of refusals) {
      outcomes.push([
        label,
        await recordPurchase({ orgId: r.orgId, delta, stripeEventId: `evt_bad_${delta}_${r.orgId}` }).then(
          () => ({ refused: false }),
          (e: unknown) => ({ refused: true, status: (e as { status?: number }).status, code: (e as { code?: string }).code }),
        ),
      ]);
    }
    expect(outcomes, "every non-positive-integer purchase delta must be exercised").toHaveLength(3);
    const notRefused = outcomes
      .filter(([, o]) => !(o.refused && o.status === 422 && o.code === "delta_invalid"))
      .map(([label]) => label)
      .join(" | ");
    expect(notRefused, "a purchase delta outside the positive integers must be refused 422 delta_invalid").toBe("");
    expect(await creditBalance(sql, r.orgId)).toBe(0);
    // The positive pair: the smallest legal purchase still applies.
    expect(await recordPurchase({ orgId: r.orgId, delta: 1, stripeEventId: `evt_ok_${r.orgId}` }))
      .toMatchObject({ applied: true, balance: 1 });
  });

  it("a replayed grant (same key, same values) writes no second ledger row and no second audit row — the ORIGINAL id, applied false, balance unchanged; a NEW key applies (m6, m11, m12)", async () => {
    const r = await rig();
    const k = key();
    const first = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "pilot league", idempotencyKey: k });
    expect(first).toEqual({ id: expect.any(String), balance: 2, applied: true });
    const replay = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "pilot league", idempotencyKey: k });
    expect(replay).toEqual({ id: first.id, balance: 2, applied: false });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
    expect(n).toBe(1);
    expect([...(await auditRows(r.orgId))]).toEqual([
      { actor_id: r.userId, action: "stream_credit_grant", target_type: "org",
        detail: { delta: 2, reason: "pilot league", session_id: null, ledger_id: first.id, balance_after: 2 } },
    ]);
    // The positive pair: a new key is a new submission.
    expect(await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "second", idempotencyKey: key() }))
      .toMatchObject({ balance: 3, applied: true });
    expect(await auditRows(r.orgId)).toHaveLength(2);
  });

  it("a key reused for a DIFFERENT adjustment → 409 idempotency_key_reused with no row and no audit row anywhere — a different delta, a different kind, a different session, another org — while the EXACT replay (a retyped note included: the note is not in the tuple) answers applied false with the original id (m13, m16–m19)", async () => {
    const r = await rig();
    const other = await rig();
    const sid = await r.session(r.fixtureIds[0]!);
    const k = key();
    const first = await refundCredits({ orgId: r.orgId, delta: 1, sessionId: null, createdBy: r.userId, note: "goodwill", idempotencyKey: k });
    expect(first).toEqual({ id: expect.any(String), balance: 1, applied: true });
    // Each row differs from the stored (org, reason, delta 1, session null) in exactly ONE member,
    // so each member's comparison has its own killer.
    const reused: [string, () => Promise<unknown>][] = [
      ["a different delta (m17)", () => refundCredits({ orgId: r.orgId, delta: 2, sessionId: null, createdBy: r.userId, note: "goodwill", idempotencyKey: k })],
      ["a different kind (m18)", () => grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "goodwill", idempotencyKey: k })],
      ["a different session (m19)", () => refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "goodwill", idempotencyKey: k })],
      ["another org (m13)", () => refundCredits({ orgId: other.orgId, delta: 1, sessionId: null, createdBy: other.userId, note: "goodwill", idempotencyKey: k })],
    ];
    // `expect(p, label).rejects` DROPS its custom label on the "promise resolved instead of
    // rejecting" path (vitest 4.1, MEASURED: m13/m16/m17 all failed with a bare "promise
    // resolved … instead of rejecting"), and that is the path EVERY one of these mutants
    // takes — so the four members' killers were indistinguishable from the failure text.
    // An object `toEqual` diff is ALSO summarised, to `{ …(4) }` in the headline, and the
    // headline is all the JSON reporter carries (MEASURED too). So the COMPARED VALUE is the
    // list of row labels that were not refused: the failure then reads `expected 'a different
    // delta (m17)' to be ''`. Settling each call also means no row is skipped by an early
    // abort, so m16 (all four resolve) is told apart from a single member's mutant (one).
    const outcomes: [string, { refused: boolean; status?: number; code?: string }][] = [];
    for (const [label, call] of reused) {
      outcomes.push([
        label,
        await call().then(
          () => ({ refused: false }),
          (e: unknown) => ({ refused: true, status: (e as { status?: number }).status, code: (e as { code?: string }).code }),
        ),
      ]);
    }
    // The empty set, explicitly: `notRefused === ""` is ALSO true of a `reused` table somebody
    // emptied, so the member count is pinned to the literal 4 — the four members of the stored
    // tuple (org, reason, signed delta, session). Deriving this from `reused.length` would be a
    // tautology.
    expect(outcomes, "the reused-key table must still cover all four tuple members").toHaveLength(4);
    const notRefused = outcomes
      .filter(([, o]) => !(o.refused && o.status === 409 && o.code === "idempotency_key_reused"))
      .map(([label]) => label)
      .join(" | ");
    expect(notRefused, "every reused-key row must be refused 409 idempotency_key_reused").toBe("");
    // The positive pair: the exact replay, with a retyped note.
    expect(await refundCredits({ orgId: r.orgId, delta: 1, sessionId: null, createdBy: r.userId, note: "goodwill, retyped", idempotencyKey: k }))
      .toEqual({ id: first.id, balance: 1, applied: false });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id in (${r.orgId}, ${other.orgId})`;
    expect(n).toBe(1);
    expect((await auditRows(r.orgId)).map((a) => a.action)).toEqual(["stream_credit_refund"]);
    expect(await auditRows(other.orgId)).toHaveLength(0);
  });

  it("first-ever writes on an EMPTY ledger serialise on the org's money lock: a purchase and a same-key grant pair queue behind the test's own hold (3 waiters), then land with running balance_after snapshots, one grant applied and its twin applied false — never a 23505; the hold is taken with the org id UPPER-cased, and it is still the same lock (m14, m15, m21)", async () => {
    const r = await rig();
    expect(await creditBalance(sql, r.orgId)).toBe(0);   // the empty ledger IS the case: `for update` would lock nothing here
    // N1: ONE key per org whatever the case of the id. The /admin route's URL is z.uuid(), which
    // accepts upper case; Task 10's consume and Task 8's purchase pass the DB's lower-case id.
    expect(orgMoneyLockKey(r.orgId.toUpperCase())).toBe(orgMoneyLockKey(r.orgId));
    const k = key();
    let release!: () => void;
    const released = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    // The TEST holds the org's money lock, so every writer below must queue behind this backend.
    // Held through the UPPER-case spelling: the writers below pass the lower-case id (m21 witness).
    const holder = sql.begin(async (tx) => {
      await lockOrg(tx, r.orgId.toUpperCase());
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      signalHeld(pid);
      await released;
    });
    const holderPid = await held;
    const writes = [
      recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: `evt_first_${r.orgId}` }),
      grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "first grant", idempotencyKey: k }),
      grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "first grant", idempotencyKey: k }),
    ];
    const blocked = await advisoryWaitersBehind(holderPid, writes.length);
    release();
    await holder;
    const settled = await Promise.allSettled(writes);

    expect(blocked, "every first writer queues behind the holder's backend (m14: the grants do not; m15: the purchase does not)").toBe(3);
    expect(settled.map((s) => s.status), JSON.stringify(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")))).toEqual([
      "fulfilled", "fulfilled", "fulfilled",
    ]);
    const [p, g1, g2] = settled.map((s) => (s as PromiseFulfilledResult<{ id: string; applied: boolean; balance: number }>).value);
    expect(p!.applied).toBe(true);
    expect([g1!.applied, g2!.applied].sort()).toEqual([false, true]);
    expect(g1!.id).toBe(g2!.id);
    // Serialised, so each snapshot is the running sum: the second writer read the first one's row.
    const snapshots = (await sql<{ balance_after: number }[]>`
      select balance_after from org_stream_credits where org_id = ${r.orgId}`).map((x) => x.balance_after).sort((a, b) => a - b);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBe(7);
    expect([2, 5]).toContain(snapshots[0]);
    expect(await creditBalance(sql, r.orgId)).toBe(7);
  });

  it("the same key on two DIFFERENT orgs at once: the money locks differ, so the second writer misses the first's uncommitted row, waits on it at the TABLE-wide key index, and answers 409 idempotency_key_reused — never a raw 23505 (a 500) — with no row and no audit row; a new key then applies (N3, m22)", async () => {
    const r = await rig();
    const other = await rig();
    const k = key();
    let release!: () => void;
    const released = new Promise<void>((res) => (release = res));
    let signalHeld!: (pid: number) => void;
    const held = new Promise<number>((res) => (signalHeld = res));
    // OTHER's writer parked between its insert and its commit: it holds OTHER's money lock and an
    // UNCOMMITTED row carrying k — where a real grant sits just before sql.begin commits.
    const holder = sql.begin(async (tx) => {
      await lockOrg(tx, other.orgId);
      await tx`insert into org_stream_credits (org_id, delta, reason, balance_after, idempotency_key)
               values (${other.orgId}, 1, 'grant', 1, ${k})`;
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      signalHeld(pid);
      await released;
    });
    const holderPid = await held;
    // R's grant takes R's lock (a DIFFERENT lock — nothing queues it behind the holder), its key
    // lookup cannot see the uncommitted row, and its insert waits on the holder's transaction.
    const write = grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "same key, other org", idempotencyKey: k })
      .catch((e: unknown) => e);   // settled here, so the rejection is never unhandled while the test polls
    const blocked = await keyWaitersBehind(holderPid, 1);
    release();
    await holder;
    const out = await write;

    expect(blocked, "R's insert never waited on the holder's uncommitted key (pg_locks: transactionid, not granted, blocked by the holder's pid)").toBe(1);
    // m22: the rejection is the raw PostgresError (code 23505, no status), which the route answers 500.
    expect(out, JSON.stringify(out)).toMatchObject({ status: 409, code: "idempotency_key_reused" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
    expect(n).toBe(0);
    expect(await auditRows(r.orgId)).toHaveLength(0);
    expect(await creditBalance(sql, other.orgId)).toBe(1);   // the holder's row committed; only R's write was refused
    // The positive pair: R's writer is not wedged — a NEW key applies.
    expect(await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "new key", idempotencyKey: key() }))
      .toMatchObject({ balance: 2, applied: true });
  });

  it("a session whose fixture is GONE (fixtureId null — V410 `on delete set null`, Task 2A's nullable Session.fixtureId) consumes every time: the 24 h reuse rule is per fixture, and no fixture is never a match (G2, m20)", async () => {
    const r = await rig();
    await grantCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "two", idempotencyKey: key() });
    const sid = await r.session(r.fixtureIds[0]!, "failed");
    await sql`update fixture_stream_sessions set fixture_id = null where id = ${sid}`;
    const first = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId: sid }));
    const second = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: null, sessionId: sid }));
    expect([first.consumed, first.balance, second.consumed, second.balance]).toEqual([true, 1, true, 0]);
  });

  it("revoke writes a NEGATIVE 'revoke' row: 1 of 1 → balance 0, audited, and readable in the Adjustments log; 1 of 0 → 422 insufficient_credits with no row and no audit row (m7, m11)", async () => {
    const r = await rig();
    await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "mistaken grant", idempotencyKey: key() });
    expect(await revokeCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "reverse the mistaken grant", idempotencyKey: key() }))
      .toEqual({ id: expect.any(String), balance: 0, applied: true });
    await expect(
      revokeCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "nothing left", idempotencyKey: key() }),
    ).rejects.toMatchObject({ status: 422, code: "insufficient_credits" });
    const rows = await sql<{ reason: string; delta: number; balance_after: number; created_by: string }[]>`
      select reason, delta, balance_after, created_by from org_stream_credits where org_id = ${r.orgId} order by created_at`;
    expect(rows.map((x) => [x.reason, x.delta, x.balance_after, x.created_by])).toEqual([
      ["grant", 1, 1, r.userId], ["revoke", -1, 0, r.userId],
    ]);
    // The audit's REAL consumer: the unified Adjustments log an operator reads on /admin/orgs/[id]
    // (newest first). An action missing from ADJUSTMENT_ACTIONS would be absent here.
    expect((await adjustmentsForOrg(r.orgId)).map((e) => [e.action, e.category, e.reason, e.actorId])).toEqual([
      ["stream_credit_revoke", "credits", "reverse the mistaken grant", r.userId],
      ["stream_credit_grant", "credits", "mistaken grant", r.userId],
    ]);
  });

  it("a session-linked refund is capped at what that session consumed: 1 of 1 → applied; a second → 422 refund_exceeds_consumed, no row, no audit row; an UNLINKED (goodwill) refund still applies; a session that consumed nothing refuses any linked refund (m8, m9)", async () => {
    const r = await rig();
    await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "fund", idempotencyKey: key() });
    const sid = await r.session(r.fixtureIds[0]!);
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid }));
    expect(await refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "failed stream", idempotencyKey: key() }))
      .toMatchObject({ balance: 1, applied: true });
    await expect(
      refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "again", idempotencyKey: key() }),
    ).rejects.toMatchObject({ status: 422, code: "refund_exceeds_consumed" });
    expect(await refundCredits({ orgId: r.orgId, delta: 1, sessionId: null, createdBy: r.userId, note: "goodwill", idempotencyKey: key() }))
      .toMatchObject({ balance: 2, applied: true });
    const idle = await r.session(r.fixtureIds[0]!, "failed");   // terminal, so the one-active index admits it beside `sid`
    await expect(
      refundCredits({ orgId: r.orgId, delta: 1, sessionId: idle, createdBy: r.userId, note: "never consumed", idempotencyKey: key() }),
    ).rejects.toMatchObject({ status: 422, code: "refund_exceeds_consumed" });
    const rows = await sql<{ reason: string; delta: number; session_id: string | null }[]>`
      select reason, delta, session_id from org_stream_credits where org_id = ${r.orgId} order by created_at`;
    expect(rows.map((x) => [x.reason, x.delta, x.session_id])).toEqual([
      ["grant", 1, null], ["consume", -1, sid], ["refund", 1, sid], ["refund", 1, null],
    ]);
    expect((await auditRows(r.orgId)).map((a) => a.action)).toEqual([
      "stream_credit_grant", "stream_credit_refund", "stream_credit_refund",
    ]);
  });

  it("a REPLAYED session-linked refund answers applied false, not 422 — the key check runs BEFORE the cap the original call used up (m10, the ordering differential)", async () => {
    const r = await rig();
    await grantCredits({ orgId: r.orgId, delta: 1, createdBy: r.userId, note: "fund", idempotencyKey: key() });
    const sid = await r.session(r.fixtureIds[0]!);
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid }));
    const k = key();
    const first = await refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "failed stream", idempotencyKey: k });
    expect(await refundCredits({ orgId: r.orgId, delta: 1, sessionId: sid, createdBy: r.userId, note: "failed stream", idempotencyKey: k }))
      .toEqual({ id: first.id, balance: 1, applied: false });
  });

  it("recordPurchase stores the Stripe link on the purchase row (checkout, payment intent, pack, amount, currency lower-cased); a consume row carries none; a replay keeps the FIRST link", async () => {
    const r = await rig();
    const link = { checkoutSessionId: "cs_test_1", paymentIntentId: "pi_1", pack: "seazn_stream_pack_5", amountMinor: 4900, currency: "GBP" };
    // Org-scoped event id: stripe_event_id is TABLE-wide unique and this database is not
    // recreated between runs, so a literal would answer `applied: false` on the second run.
    const evt = `evt_link_${r.orgId}`;
    const first = await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: evt, link });
    await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: evt, link: { ...link, amountMinor: 1 } });   // replay: no-op, the row is unchanged
    const [row] = await sql<{ stripe_checkout_session_id: string; stripe_payment_intent_id: string; pack_key: string; amount_minor: number; currency: string }[]>`
      select stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency from org_stream_credits where id = ${first.id}`;
    expect(row).toEqual({ stripe_checkout_session_id: "cs_test_1", stripe_payment_intent_id: "pi_1", pack_key: "seazn_stream_pack_5", amount_minor: 4900, currency: "gbp" });
    const sid = await r.session(r.fixtureIds[0]!);
    const c = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: r.fixtureIds[0]!, sessionId: sid }));
    expect(c.ledgerId).toBeTruthy();
    const [consume] = await sql<{ pack_key: string | null; amount_minor: number | null }[]>`select pack_key, amount_minor from org_stream_credits where id = ${c.ledgerId}`;
    expect(consume).toEqual({ pack_key: null, amount_minor: null });
  });
});
