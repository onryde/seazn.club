// Pay under its locks (spec 2026-11-23-online-chess-credits-design.md §7.3, §7.4, §11 "Two tabs pay for the same size" / "for
// different sizes"; plan Task 5). REAL calls of `payOnlinePackage` against a REAL database, the races in the stream-credits
// idiom: a transaction the test controls HOLDS a lock, every waiter is observed BLOCKED in pg_locks (not granted, blocked BY the
// holder's own backend pid) before the release, and no sleep guesses the timing. Skipped without DATABASE_URL.
//
// The lock order is witnessed from outside while a pay is parked: waiting on the `division:` lock it must hold NEITHER the org
// money lock nor the package row; waiting on the money lock it must hold the division lock but NOT the row. Each is probed with a
// non-blocking try (pg_try_advisory_xact_lock / `for update nowait`) on a connection of its own.
//
// single-sport: Online Chess is boardgame only (online-play.ts).
//
// Mutant table (each run once by hand; results in the commit message):
//   L1 the `division:` lock dropped                 -> "a pay parked on the division lock", "two concurrent payments ..." (no waiter)
//   L2 the money lock taken BEFORE the division lock -> "a pay parked on the division lock holds neither ..."
//   L3 the package row locked before the money lock -> "a pay parked on the money lock holds the division lock, not the row"
//   L4 the door's own money lock dropped            -> same test (the row is locked before the debit's own lock is reached)
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { lockOrg, orgMoneyLockKey, recordPurchase } from "@/server/usecases/stream-credits";
import { payOnlinePackage, type PayResult } from "@/server/usecases/online-package";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;
/** Global Constraints: 32 → 2 credits, 64 → 4, without cameras. */
const PRICE_32 = 2;
const PRICE_64 = 4;

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  // Each payment below must be ONE consume row, so "one debit" is "one row": pro's month must cover 64's 4 credits on its own.
  const [r] = await sql<{ v: number | null }[]>`
    select int_value as v from plan_entitlements where plan_key = 'pro' and feature_key = 'streaming.credits.monthly'`;
  expect(r?.v ?? 0, "premise: pro includes at least 4 credits a month").toBeGreaterThanOrEqual(PRICE_64);
});

afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

interface Rig { orgId: string; auth: AuthCtx; divisionId: string; packageId: string }

/** A pro org with its owner, one online chess division and its UNPAID package at 32, and 10 bought credits. */
async function rig(): Promise<Rig> {
  const s = suffix();
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"OC Race " + s}, ${"oc-race-" + s}) returning id`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${`race-${s}@t.local`}, 'Owner', true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
  await setOrgPlan(org!.id, "pro");
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility) values (${org!.id}, ${"OC Race " + s}, ${"oc-race-" + s}, 'private') returning id`;
  const name = `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${c!.id}, ${name}, ${"oc-race-" + s}, 'boardgame', 'classical', ${sql.json({ onlinePlay: "lichess" } as never)}, '1.0.0') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into division_online_packages (org_id, division_id, division_name, size) values (${org!.id}, ${d!.id}, ${name}, 32) returning id`;
  const cs = `cs_ocrace_${s}`;
  await recordPurchase({
    orgId: org!.id, delta: 10, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: "seazn_stream_pack_10", amountMinor: 600, currency: "gbp" },
  });
  return {
    orgId: org!.id,
    auth: { orgId: org!.id, via: "session", userId: user!.id, role: "owner", keyId: null },
    divisionId: d!.id,
    packageId: p!.id,
  };
}

/** Holds a lock from a transaction the test controls, on its own backend, until `release()`. */
async function hold(take: (tx: Tx) => Promise<unknown>): Promise<{ pid: number; release: () => Promise<void> }> {
  let release!: () => void;
  const mayEnd = new Promise<void>((res) => (release = res));
  let signal!: (pid: number) => void;
  const held = new Promise<number>((res) => (signal = res));
  const done = sql.begin(async (tx) => {
    await take(tx);
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    signal(pid);
    await mayEnd;
  });
  const pid = await held;
  return { pid, release: async () => { release(); await done; } };
}

/** Advisory-lock waiters blocked BY `holderPid`, polled until `want` or the deadline (stream-credits.test.ts's helper). */
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

/** Whether an advisory key is free right now: taken and at once released by a transaction of its own. */
async function advisoryFree(key: string): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    const [r] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`;
    return r!.ok;
  })) as unknown as boolean;
}

/** Whether the package row is unlocked right now: `for update nowait` on a transaction of its own. */
async function rowFree(packageId: string): Promise<boolean> {
  try {
    await sql.begin((tx) => tx`select id from division_online_packages where id = ${packageId} for update nowait`);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "55P03") return false;
    throw e;
  }
}

type Ledger = { delta: number; reason: string }[];
const packageLedger = (packageId: string) =>
  sql<Ledger>`select delta, reason from org_stream_credits where online_package_id = ${packageId} and reason = 'consume'`;

describe.skipIf(!HAS_DB)("payOnlinePackage under its locks", () => {
  it("two concurrent payments for one size write one debit: one applies, the other finds the row at the target", async () => {
    const r = await rig();
    const holder = await hold((tx) => tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`);
    const input = { size: 32 as const, expectedOwed: PRICE_32 };
    const a = payOnlinePackage(r.auth, r.divisionId, input);
    const b = payOnlinePackage(r.auth, r.divisionId, input);
    const blocked = await advisoryWaitersBehind(holder.pid, 2);
    await holder.release();
    const results = await Promise.allSettled([a, b]);
    expect(blocked, "both payments queued on the division lock behind the holder").toBe(2);
    const ok = results.filter((x): x is PromiseFulfilledResult<PayResult> => x.status === "fulfilled").map((x) => x.value.applied).sort();
    expect(ok, "both answered: one applied, one found the row at the target").toEqual([false, true]);
    expect(await packageLedger(r.packageId), "one debit").toEqual([{ delta: -PRICE_32, reason: "consume" }]);
    const [p] = await sql<{ size: number; credits_paid: number }[]>`select size, credits_paid from division_online_packages where id = ${r.packageId}`;
    expect(p).toEqual({ size: 32, credits_paid: PRICE_32 });
  });

  it("two concurrent payments for different sizes (32 and 64) write one debit: the second meets the first's state and answers 409", async () => {
    const r = await rig();
    const holder = await hold((tx) => tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`);
    const a = payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: PRICE_32 });
    const b = payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: PRICE_64 });
    const blocked = await advisoryWaitersBehind(holder.pid, 2);
    await holder.release();
    const results = await Promise.allSettled([a, b]);
    expect(blocked).toBe(2);
    const applied = results.filter((x): x is PromiseFulfilledResult<PayResult> => x.status === "fulfilled");
    const refused = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(applied.map((x) => x.value.applied)).toEqual([true]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(HttpError);
    expect((refused[0]!.reason as HttpError).code).toBe("ONLINE_QUOTE_CHANGED");
    const won = applied[0]!.value.package.size;
    expect(await packageLedger(r.packageId), "one debit, of the winner's price").toEqual([{ delta: -(won === 32 ? PRICE_32 : PRICE_64), reason: "consume" }]);
  });

  it("a pay parked on the division lock holds neither the org money lock nor the package row (division → money → row)", async () => {
    const r = await rig();
    const holder = await hold((tx) => tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`);
    const p = payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: PRICE_32 });
    const blocked = await advisoryWaitersBehind(holder.pid, 1);
    const money = await advisoryFree(orgMoneyLockKey(r.orgId));
    const row = await rowFree(r.packageId);
    await holder.release();
    const result = await p;
    expect(blocked, "the pay is parked on the division lock").toBe(1);
    expect(money, "the money lock is not taken before the division lock").toBe(true);
    expect(row, "the package row is not locked before the division lock").toBe(true);
    expect(result.applied).toBe(true);
  });

  it("a pay parked on the money lock holds the division lock, not the row (the row is locked last)", async () => {
    const r = await rig();
    const holder = await hold((tx) => lockOrg(tx, r.orgId));
    const p = payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: PRICE_32 });
    const blocked = await advisoryWaitersBehind(holder.pid, 1);
    const division = await advisoryFree("division:" + r.divisionId);
    const row = await rowFree(r.packageId);
    await holder.release();
    const result = await p;
    expect(blocked, "the pay is parked on the org money lock").toBe(1);
    expect(division, "the division lock is already held by the parked pay").toBe(false);
    expect(row, "the package row is not locked before the money lock").toBe(true);
    expect(result.applied).toBe(true);
    expect(await packageLedger(r.packageId)).toEqual([{ delta: -PRICE_32, reason: "consume" }]);
  });

  it("the package row is locked before it is read: a row frozen by another writer while the pay waited is refused, never charged", async () => {
    const r = await rig();
    await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: PRICE_32 });
    // Another writer holds the row and freezes it (a round opening), without the advisory locks — only the row lock stands between.
    const holder = await hold(async (tx) => {
      await tx`select id from division_online_packages where id = ${r.packageId} for update`;
      await tx`update division_online_packages set frozen_at = now() where id = ${r.packageId}`;
    });
    const p = payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: PRICE_64 - PRICE_32 });
    const blocked = await waitersBehind(holder.pid, 1);
    await holder.release();
    const outcome = await p.then(() => null, (e: unknown) => e);
    expect(blocked, "the pay waited on the row").toBe(1);
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).code, "it read the row the other writer left: frozen").toBe("ONLINE_QUOTE_CHANGED");
    expect(((outcome as HttpError).extra as { quote: { refusal: string } }).quote.refusal).toBe("frozen");
    expect(await packageLedger(r.packageId), "only the first payment").toEqual([{ delta: -PRICE_32, reason: "consume" }]);
    const [p2] = await sql<{ size: number; credits_paid: number }[]>`select size, credits_paid from division_online_packages where id = ${r.packageId}`;
    expect(p2).toEqual({ size: 32, credits_paid: PRICE_32 });
  });

  it("a division switched off online play while the pay waited on the division lock is refused 422, and nothing is written", async () => {
    const r = await rig();
    const holder = await hold(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      await tx`update divisions set config = ${sql.json({ onlinePlay: "off" } as never)} where id = ${r.divisionId}`;
    });
    const p = payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: PRICE_32 });
    const blocked = await advisoryWaitersBehind(holder.pid, 1);
    await holder.release();
    const outcome = await p.then(() => null, (e: unknown) => e);
    expect(blocked).toBe(1);
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).code).toBe("ONLINE_FORMAT_NOT_SUPPORTED");
    expect(await packageLedger(r.packageId)).toEqual([]);
  });
});

/** Any lock waiter (a row lock waits on the holder's transaction id or the tuple) blocked BY `holderPid`. */
async function waitersBehind(holderPid: number, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(distinct pid)::int as n from pg_locks where not granted and ${holderPid} = any(pg_blocking_pids(pid))`;
    if (row!.n >= want || Date.now() >= deadline) return row!.n;
    await new Promise((res) => setTimeout(res, 25));
  }
}
