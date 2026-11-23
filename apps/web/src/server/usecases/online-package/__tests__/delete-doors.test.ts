// The doors that take a division away carry its Online Chess package (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.3,
// §11; P7; plan Task 6): `deleteDivision` (a setup division, or the purge of a 30-day archive) and `deleteCompetition`. Each is
// a tenant transaction (withTenant, app_user, RLS); the packages are planned in its privileged PRELUDE — read and locked BEFORE
// the delete sets their `division_id` to null — and refunded or deleted in its privileged EPILOGUE, so the money commits or rolls
// back with the delete. REAL doors against a REAL database (skipped without DATABASE_URL). The race with a payment is the
// stream-credits idiom: a transaction the test controls holds the `division:` lock, each door is observed BLOCKED behind it in
// pg_locks before the release, and no sleep guesses the timing.
//
// Expected numbers: the Global Constraints' price table (`gcPrice`), over buckets the case put there (the month spent to 0, so
// every payment draws bought credits and every refund returns them in full).
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   D1 deleteDivision's prelude/epilogue pair removed                    -> "delete division: paid → refund …"
//   D2 deleteCompetition's prelude/epilogue pair removed                 -> "delete competition with three paid …"
//   D3 the frozen skip in planPackageDelete dropped                      -> "… frozen → row kept, no refund" (the delete 409s)
//   D4 the packages read in the epilogue, by division, after the cascade -> "delete division: paid → refund …" (nothing found)
//   D5 the money lock taken in the prelude BEFORE the division lock      -> "a delete parked on the division lock holds neither …"
//   D6 the prelude's org scope dropped (another org's division planned)  -> expected EQUIVALENT: the tenant callback 404s the foreign
//      division and the transaction rolls back before the epilogue; "another org's division id: 404 …" pins the outcome, not the scope
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { deleteCompetition } from "@/server/usecases/competitions";
import { archiveDivision, deleteDivision, restoreDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { orgMoneyLockKey } from "@/server/usecases/stream-credits";
import { payOnlinePackage } from "@/server/usecases/online-package";
import {
  balance, buy, divisionExists, expectBooks, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg,
  orgLedgerCount, packageById, packageLedger, pay, refusal, spendTheMonth, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** An org whose month is spent, holding `pack` bought credits. */
async function moneyOrg(pack: number): Promise<Org> {
  const o = await ocOrg();
  await spendTheMonth(o.orgId);
  await buy(o.orgId, pack);
  return o;
}

describe.skipIf(!HAS_DB)("deleteDivision carries the package", () => {
  it("delete division: paid → refund in the same transaction; unpaid → no row left; frozen → row kept, no refund", async () => {
    const o = await moneyOrg(20);
    const c = await ocCompetition(o);
    let doors = 0;

    const paid = await ocDivision(o, c);
    await pay(o, paid.id, 128);
    const p = await liveOf(paid.id);
    expect((await balance(o.orgId)).pack).toBe(20 - gcPrice(128));
    await deleteDivision(o.auth, paid.id);
    expect(await divisionExists(paid.id)).toBe(false);
    const after = (await packageById(p.id))!;
    expect(after, "kept as history, its division gone, its name kept").toMatchObject({
      division_id: null, division_name: paid.name, credits_paid: gcPrice(128), credits_refunded: gcPrice(128), credits_forfeited: 0,
    });
    expect(after.refunded_at).not.toBeNull();
    expect((await balance(o.orgId)).pack, "the 8 came back").toBe(20);
    expect(await expectBooks(p.id, "the deleted division's package")).toBe(1);
    doors += 1;

    const unpaid = await ocDivision(o, c);
    const u = await liveOf(unpaid.id);
    const rows = await orgLedgerCount(o.orgId);
    await deleteDivision(o.auth, unpaid.id);
    expect(await packageById(u.id), "no orphan unpaid row").toBeNull();
    expect(await orgLedgerCount(o.orgId), "and no money moved").toBe(rows);
    doors += 1;

    const frozen = await ocDivision(o, c);
    await pay(o, frozen.id, 16);
    const f = await liveOf(frozen.id);
    await freeze(f.id);
    const before = await balance(o.orgId);
    await deleteDivision(o.auth, frozen.id);
    expect(await divisionExists(frozen.id)).toBe(false);
    expect(await packageById(f.id), "the frozen row is left as it was (only its division link goes)").toMatchObject({
      division_id: null, credits_refunded: 0, refunded_at: null, credits_paid: gcPrice(16),
    });
    expect(await balance(o.orgId), "nothing came back: the package ran").toEqual(before);
    doors += 1;
    expect(doors).toBe(3);
  });

  it("a refund that fails in the epilogue rolls the delete back: the division still exists", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    const p = await liveOf(d.id);
    // A paid row its ledger cannot account for (no consume row behind it): the return refuses it by name, in the epilogue.
    await sql`update division_online_packages set paid_at = now(), paid_by = ${o.auth.userId}, cameras_paid = false, credits_paid = 1 where id = ${p.id}`;
    const err = await refusal(deleteDivision(o.auth, d.id));
    expect(err.status).toBe(500);
    expect(await divisionExists(d.id), "the delete rolled back with the refund").toBe(true);
    expect(await packageById(p.id)).toMatchObject({ division_id: d.id, refunded_at: null, credits_refunded: 0 });
  });

  it("archive holds the package; restore returns it; purge refunds", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    const p = await liveOf(d.id);
    await archiveDivision(o.auth, d.id);
    expect(await liveOf(d.id), "archived: the package as it was").toEqual(p);
    await restoreDivision(o.auth, d.id);
    expect(await liveOf(d.id), "restored: the same package").toEqual(p);
    await archiveDivision(o.auth, d.id);
    // The purge cool-off (30 days) has passed.
    await sql`update divisions set archived_at = now() - interval '31 days' where id = ${d.id}`;
    await deleteDivision(o.auth, d.id);
    expect(await divisionExists(d.id)).toBe(false);
    expect(await packageById(p.id)).toMatchObject({ division_id: null, credits_refunded: gcPrice(32) });
    expect((await balance(o.orgId)).pack).toBe(10);
  });

  it("another org's division id: 404, its package untouched (the prelude reads org-scoped)", async () => {
    const victim = await moneyOrg(10);
    const d = await ocDivision(victim, await ocCompetition(victim));
    await pay(victim, d.id, 32);
    const p = await liveOf(d.id);
    const attacker = await ocOrg();
    const err = await refusal(deleteDivision(attacker.auth, d.id));
    expect(err.status).toBe(404);
    expect(await liveOf(d.id)).toEqual(p);
    expect((await balance(victim.orgId)).pack).toBe(10 - gcPrice(32));
  });
});

describe.skipIf(!HAS_DB)("deleteCompetition carries every division's package", () => {
  it("delete competition with three paid and one unpaid division: three refunds, no orphan unpaid row", async () => {
    const o = await moneyOrg(30);
    const c = await ocCompetition(o);
    const sizes = [16, 64, 128] as const;
    const paid: string[] = [];
    for (const size of sizes) {
      const d = await ocDivision(o, c);
      await pay(o, d.id, size);
      paid.push((await liveOf(d.id)).id);
    }
    const spent = sizes.reduce((s, z) => s + gcPrice(z), 0);
    expect((await balance(o.orgId)).pack).toBe(30 - spent);
    const unpaid = await liveOf((await ocDivision(o, c)).id);
    // Another competition of the org, paid: the delete must not reach it.
    const other = await ocDivision(o, await ocCompetition(o));
    await pay(o, other.id, 32);
    const otherRow = await liveOf(other.id);

    await deleteCompetition(o.auth, c);
    let refunded = 0;
    for (const [i, id] of paid.entries()) {
      const row = (await packageById(id))!;
      expect(row, `division ${i + 1}`).toMatchObject({ division_id: null, credits_refunded: gcPrice(sizes[i]!) });
      expect(row.refunded_at).not.toBeNull();
      expect(await packageLedger(id), `division ${i + 1}: one debit, one return`).toEqual([
        { reason: "consume", bucket: "pack", delta: -gcPrice(sizes[i]!) },
        { reason: "refund", bucket: "pack", delta: gcPrice(sizes[i]!) },
      ]);
      refunded += 1;
    }
    expect(refunded).toBe(3);
    expect(await packageById(unpaid.id), "no orphan unpaid row").toBeNull();
    expect(await liveOf(other.id), "the other competition's package").toEqual(otherRow);
    expect((await balance(o.orgId)).pack).toBe(30 - gcPrice(32));
  });

  it("a competition whose division froze: the frozen package is left, the others refunded", async () => {
    const o = await moneyOrg(10);
    const c = await ocCompetition(o);
    const a = await ocDivision(o, c);
    await pay(o, a.id, 32);
    const pa = await liveOf(a.id);
    const b = await ocDivision(o, c);
    await pay(o, b.id, 16);
    const pb = await liveOf(b.id);
    await freeze(pb.id);
    await deleteCompetition(o.auth, c);
    expect(await packageById(pa.id)).toMatchObject({ credits_refunded: gcPrice(32) });
    expect(await packageById(pb.id)).toMatchObject({ credits_refunded: 0, refunded_at: null, division_id: null });
    expect((await balance(o.orgId)).pack).toBe(10 - gcPrice(16));
  });
});

// ─── The race: a delete and a payment of the same division ───────────────────────────────────────────────────────────

/** Holds a lock from a transaction the test controls, on its own backend, until `release()` (pay-concurrency's helper). */
async function hold(take: (tx: Tx) => Promise<unknown>): Promise<{ pid: number; release: () => Promise<void> }> {
  let release!: () => void;
  const mayEnd = new Promise<void>((res) => (release = res));
  let signal!: (pid: number) => void;
  const held = new Promise<number>((res) => (signal = res));
  const done = sql.begin(async (tx) => {
    await take(tx);
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    signal(pid!);
    await mayEnd;
  });
  const pid = await held;
  return { pid, release: async () => { release(); await done; } };
}

/** Advisory-lock waiters blocked BY `holderPid`, polled until `want` or the deadline. */
async function advisoryWaitersBehind(holderPid: number, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    if (row!.n >= want || Date.now() >= deadline) return row!.n;
    await new Promise((res) => setTimeout(res, 25));
  }
}

async function advisoryFree(key: string): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    const [r] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`;
    return r!.ok;
  })) as unknown as boolean;
}

const settle = async <T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> => p.then((ok) => ({ ok }), (err: unknown) => ({ err }));

describe.skipIf(!HAS_DB)("a delete racing a payment: exactly one wins, the books balance", () => {
  it("a delete parked on the division lock holds neither the money lock nor the package row", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    const p = await liveOf(d.id);
    const holder = await hold((tx) => tx`select pg_advisory_xact_lock(hashtext(${"division:" + d.id}))`);
    const del = settle(deleteDivision(o.auth, d.id));
    expect(await advisoryWaitersBehind(holder.pid, 1), "the delete waits on the division lock").toBe(1);
    expect(await advisoryFree(orgMoneyLockKey(o.orgId)), "…holding no money lock").toBe(true);
    const [row] = await sql<{ id: string }[]>`select id from division_online_packages where id = ${p.id} for update skip locked`;
    expect(row?.id, "…and no package row").toBe(p.id);
    await holder.release();
    expect(await del).toEqual({ ok: undefined });
    expect(await packageById(p.id)).toMatchObject({ credits_refunded: gcPrice(32) });
  });

  for (const first of ["delete", "pay"] as const) {
    it(`delete racing a pay (${first} first): exactly one wins, books balance, no live row`, async () => {
      const o = await moneyOrg(10);
      const d = await ocDivision(o, await ocCompetition(o));
      const unpaid = await liveOf(d.id);
      const ledgerBefore = await orgLedgerCount(o.orgId);
      const holder = await hold((tx) => tx`select pg_advisory_xact_lock(hashtext(${"division:" + d.id}))`);
      const doDelete = () => settle(deleteDivision(o.auth, d.id));
      const doPay = () => settle(payOnlinePackage(o.auth, d.id, { size: 32, expectedOwed: gcPrice(32) }));
      // Park them in the chosen order: the lock queue grants in arrival order.
      const a = first === "delete" ? doDelete() : doPay();
      expect(await advisoryWaitersBehind(holder.pid, 1), `${first} parked`).toBe(1);
      const b = first === "delete" ? doPay() : doDelete();
      expect(await advisoryWaitersBehind(holder.pid, 2), "both parked").toBe(2);
      await holder.release();
      const [ra, rb] = await Promise.all([a, b]);
      const del = first === "delete" ? ra : rb;
      const paid = first === "delete" ? rb : ra;
      expect(del, "the delete always succeeds").toEqual({ ok: undefined });
      expect(await divisionExists(d.id)).toBe(false);
      if (first === "delete") {
        // The pay meets no division: the pay door's own refusal, and no debit.
        expect("err" in paid).toBe(true);
        const e = (paid as { err: unknown }).err as HttpError;
        expect({ status: e.status, code: e.code }).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.formatNotSupported });
        expect(await packageById(unpaid.id), "the unpaid row went with the division").toBeNull();
        expect(await orgLedgerCount(o.orgId), "no money moved").toBe(ledgerBefore);
      } else {
        // The pay committed first; the delete planned AFTER it, under the same lock, and refunded it in full.
        expect("ok" in paid).toBe(true);
        expect(await packageById(unpaid.id)).toMatchObject({ division_id: null, credits_paid: gcPrice(32), credits_refunded: gcPrice(32) });
        expect(await packageLedger(unpaid.id)).toEqual([
          { reason: "consume", bucket: "pack", delta: -gcPrice(32) },
          { reason: "refund", bucket: "pack", delta: gcPrice(32) },
        ]);
      }
      expect((await balance(o.orgId)).pack, "the books balance: every bought credit is back").toBe(10);
      const [{ live }] = await sql<{ live: number }[]>`
        select count(*)::int as live from division_online_packages where org_id = ${o.orgId} and refunded_at is null`;
      expect(live, "no live row left").toBe(0);
    });
  }
});
