// The organiser-facing match-credit HISTORY (Settings → Credits → Streaming): server/usecases/stream-credit-history.ts.
// Real Postgres; skipped without DATABASE_URL. Every ledger row below is written by the REAL writer the product
// uses (recordPurchase, consumeForSession, the staff trio, the monthly rollover, the Event Pass grant, the R2008
// refund, the Stripe claw-back) and only then read back through the reader — a hand-built row proves the fixture,
// not the seam (AGENTS.md class 1).
//
// Mutant table (each killed by the named test; run once by hand, see the PR):
//   H1 org scope        drop `where c.org_id = ${orgId}`                         → "only THIS org's rows"
//   H2 tenant join      drop `s.org_id = c.org_id` from the session join         → "each tenancy join guard holds on its own" (the session's org alone)
//   H13 tenant join     drop `comp.org_id = c.org_id` from the competition join  → "each tenancy join guard holds on its own" (the competition's org alone)
//   H3 order            `c.created_at desc, c.id desc` → asc                      → "newest first" + the pagination sweep
//   H4 keyset           `<` → `<=` in the cursor predicate                        → "the pages tile the ledger"
//   H5 cursor precision cursor built from the JS Date instead of the text column  → "the pages tile the ledger" (µs-spaced ties)
//   H6 limit+1          fetch `limit` rows instead of `limit + 1`                 → "a ledger of exactly one page has no next page" / "the pages tile the ledger"
//   H7 session-only     delete the `via !== "session"` refusal                    → "an API key and a device link are refused"
//   H8 org match        delete the org-mismatch refusal                           → "another organisation's session is a 404"
//   H9 staff identity   add `createdBy` to the mapped row                         → "no staff identity, note or key leaves the reader"
//   H10 reason map      swap two branches of the classifier                       → "every writer's row lands on its own kind"
//   H12 rollover tie    drop `(c.reason <> 'expire') desc` from the order           → "the rollover's tie" (fixed ids whose `id desc` order is wrong: deterministic, 3 runs)
//   H14 cursor flag    drop the flag from the cursor predicate / swap it on encode / misread it on decode → "the rollover's tie" (a page ending exactly on the expiry or the grant)
//   H11 unmapped        classifier `default` returns a mapped kind                → "a row no writer produces is reported and never wears a real label"
//   H15 report once     report per unmapped row instead of once per read          → "many unmapped rows are ONE report, with the count"
//   H16 month / day     drop the month range, or the day-of-month check           → "a cursor whose instant does not exist is refused" (month 13, Feb 31, 2027-02-29, 2100-02-29)
//   H17 clock / offset  drop the hour/minute/second range, or the offset ceiling → same test (25:00, 99 seconds, +99)
//   H18 package join    drop `and p.org_id = c.org_id` from the package join                → "a ledger row naming ANOTHER org's package is reported, never shown as a division's"
//   H19 first payment   `c.created_at = p.paid_at` → `true`                                 → "every package writer's row lands on its own kind" (the upgrade reads as the first payment)
//   H20 full refund     drop `and c.created_at = p.refunded_at` / the refunded_at null test → same test (a move down reads as a refund)
//   H21 name snapshot   `coalesce(pd.name, p.division_name)` → `pd.name`                    → "a deleted division's package rows keep the name the package snapshotted"
//   H22 settle row      drop the `idempotencyKey === null && hasPaymentIntent` branch       → "every package writer's row lands on its own kind" (the settle row is `other`)
//   H27 stored size     `coalesce(c.package_size, p.size)` → `p.size`                       → "every package writer's row lands on its own kind…" (an upgrade row shows the size now) and the legacy test
//   H28 size fallback   → `c.package_size`                                              → "a package row written before the size column reads the package's own size"
//   H29 size order      → `coalesce(p.size, c.package_size)`                           → same tests
//   H23 package block   drop the `onlinePackage` mapping / the package fields               → same test + "no staff identity, note or key leaves the reader"
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rigTarget, rigUser, streamRig } from "@/server/relay/__tests__/_session-rig";
import {
  consumeForSession, ensureMonthlyStreamGrant, grantCredits, grantMonthlyStreamCredits, grantPassStreamCredits, recordPurchase,
  recordStreamPackRefund, refundConsumeForSession, refundCredits, revokeCredits, streamPassCredits,
} from "@/server/usecases/stream-credits";
import { deleteDivision } from "@/server/usecases/divisions";
import { buy, cardRefund, ocCompetition, ocDivision, ocOrg, pay, spendTheMonth } from "@/server/usecases/online-package/__tests__/_oc-rig";
import { LEDGER_WRITER_SITES, PACKAGE_WRITER_FILE, STREAM_WRITER_FILE } from "./_ledger-writer-sites";

const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));
vi.mock("@/lib/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sentry")>()),
  captureError: (...args: unknown[]) => captureErrorMock(...args),
}));

import {
  STREAM_HISTORY_KINDS, STREAM_HISTORY_MAX_LIMIT, STREAM_LEDGER_REASONS, cursorFromQuery, listStreamCreditHistory, streamHistoryKind,
  type StreamHistoryKind,
} from "../stream-credit-history";

const HAS_DB = !!process.env.DATABASE_URL;

const sessionAuth = (orgId: string, role: AuthCtx["role"] = "viewer"): AuthCtx => ({ orgId, via: "session", userId: null, role, keyId: null });

beforeEach(() => captureErrorMock.mockClear());

describe("the cursor's calendar (no DB) — a link that names an instant that does not exist is not one of ours (m2)", () => {
  const cursor = (at: string, flag = "t", id = "11111111-1111-4111-8111-111111111111") => Buffer.from(`${at}|${flag}|${id}`).toString("base64url");

  it("an instant postgres would refuse (22008) is not a cursor — month 13, Feb 31, a non-leap Feb 29, hour 25, second 99, an offset of +99", () => {
    const real = ["2026-10-20 09:00:00.123456+00", "2026-12-31 23:59:59+00", "2026-01-01 00:00:00Z", "2026-10-20 09:00:00+05:30", "2026-10-20 09:00:00-15:59"];
    let judged = 0;
    for (const at of real) { expect(cursorFromQuery(cursor(at)), `${at} is real`).toBe(cursor(at)); judged += 1; }
    // leap days: 2028 and 2000 had a Feb 29, 2027 and 2100 did not
    for (const at of ["2028-02-29 00:00:00+00", "2000-02-29 00:00:00+00"]) { expect(cursorFromQuery(cursor(at)), at).toBe(cursor(at)); judged += 1; }
    const fake = [
      "2026-13-01 00:00:00+00",   // month 13
      "2026-00-10 00:00:00+00",   // month 0
      "2026-02-31 00:00:00+00",   // Feb 31
      "2026-04-31 00:00:00+00",   // April has 30
      "2026-06-00 00:00:00+00",   // day 0
      "2027-02-29 00:00:00+00",   // not a leap year
      "2100-02-29 00:00:00+00",   // a century that is not a leap year
      "2026-10-20 25:00:00+00",   // hour 25
      "2026-10-20 09:60:00+00",   // minute 60
      "2026-10-20 09:00:99+00",   // second 99
      "2026-10-20 09:00:00+99",   // offset +99
      "2026-10-20 09:00:00+16",   // offset past postgres' 15:59
      "2026-10-20 09:00:00+05:99", // offset minutes 99
      "0000-10-20 09:00:00+00",   // there is no year 0
    ];
    for (const at of fake) { expect(cursorFromQuery(cursor(at)), `${at} is not real`).toBeUndefined(); judged += 1; }
    expect(judged, "anti-vacuity: every instant was judged").toBe(21);
  });

  it("the flag and the id are still held to their shapes", () => {
    const at = "2026-10-20 09:00:00+00";
    expect(cursorFromQuery(cursor(at, "x"))).toBeUndefined();
    expect(cursorFromQuery(cursor(at, "t", "not-a-uuid"))).toBeUndefined();
    expect(cursorFromQuery(Buffer.from(`${at}|t`).toString("base64url"))).toBeUndefined();
    expect(cursorFromQuery(cursor(at, "f"))).toBe(cursor(at, "f"));
  });
});

describe("streamHistoryKind — the pure map (no DB)", () => {
  const base = {
    reason: "grant", bucket: "pack", byStaff: false, sessionId: null, idempotencyKey: null,
    packageId: null, packageFound: false, packageFirstPayment: false, packageFullRefund: false, hasPaymentIntent: false,
  };
  /** An Online Chess package row's shape (online-package/ledger.ts): the package named and found, no session, no author, no key. */
  const pkg = { packageId: "pkg-1", packageFound: true };
  // One row per branch the writers can produce. The list is the ORACLE: it is written from the writer list in
  // stream-credits.ts, not read back from the classifier.
  const cases: [string, Parameters<typeof streamHistoryKind>[0], StreamHistoryKind][] = [
    ["a bought pack", { ...base, reason: "purchase" }, "packPurchase"],
    ["a consume (either bucket)", { ...base, reason: "consume", bucket: "monthly", sessionId: "s" }, "streamUsed"],
    ["a consume from the pack bucket", { ...base, reason: "consume", sessionId: "s" }, "streamUsed"],
    ["the month's free grant", { ...base, bucket: "monthly", idempotencyKey: "stream-monthly:o:2026-10" }, "monthlyGrant"],
    ["a mid-month top-up", { ...base, bucket: "monthly", idempotencyKey: "stream-monthly:o:2026-10:to-5" }, "monthlyGrant"],
    ["an Event Pass grant", { ...base, idempotencyKey: "stream-pass:pi_1" }, "passGrant"],
    ["a staff grant", { ...base, byStaff: true, idempotencyKey: "k" }, "staffAdjust"],
    ["a staff revoke", { ...base, reason: "revoke", byStaff: true, idempotencyKey: "k" }, "staffAdjust"],
    ["a Stripe claw-back", { ...base, reason: "revoke", idempotencyKey: "stream_pack_refund:pi_1" }, "packRefund"],
    ["the system refund of a never-connected camera", { ...base, reason: "refund", bucket: "monthly", sessionId: "s" }, "refundNoCamera"],
    ["a staff refund linked to a session", { ...base, reason: "refund", byStaff: true, sessionId: "s" }, "refundStaff"],
    ["a staff goodwill refund", { ...base, reason: "refund", byStaff: true }, "refundStaff"],
    ["the month's expiry", { ...base, reason: "expire", bucket: "monthly" }, "expired"],
    // Online Chess (§8.8): one row per branch of the package writer and of the settle step, from the writers' own contract
    ["a package's first payment", { ...base, ...pkg, reason: "consume", bucket: "monthly", packageFirstPayment: true }, "onlinePackagePaid"],
    ["a package's first payment from the pack bucket", { ...base, ...pkg, reason: "consume", packageFirstPayment: true }, "onlinePackagePaid"],
    ["a package's upgrade (a later payment)", { ...base, ...pkg, reason: "consume", bucket: "monthly" }, "onlinePackageResized"],
    ["a package's move down (a return that is not the full refund)", { ...base, ...pkg, reason: "refund" }, "onlinePackageResized"],
    ["a package's full refund", { ...base, ...pkg, reason: "refund", packageFullRefund: true }, "onlinePackageRefunded"],
    ["the settle of a reversed pack (no author, no key, the payment intent)", { ...base, reason: "revoke", hasPaymentIntent: true }, "packRefund"],
  ];
  it.each(cases)("%s", (_name, input, kind) => {
    expect(streamHistoryKind(input)).toBe(kind);
  });

  it("anti-vacuity: the table reaches EVERY kind the reader declares except `other`, and every reason", () => {
    const reached = new Set(cases.map((c) => c[2]));
    expect([...reached].sort()).toEqual(STREAM_HISTORY_KINDS.filter((k) => k !== "other").sort());
    const reasons = new Set(cases.map((c) => c[1].reason));
    expect([...reasons].sort()).toEqual([...STREAM_LEDGER_REASONS].sort());
  });

  it("no branch the table above lists answers `other`", () => {
    for (const [, input] of cases) expect(streamHistoryKind(input)).not.toBe("other");
  });

  it.each([
    ["a grant that is neither monthly, pass nor staff", { ...base }],
    ["a revoke with no author, no key and no payment intent", { ...base, reason: "revoke" }],
    ["a revoke with a key that is not the claw-back's, and a payment intent", { ...base, reason: "revoke", idempotencyKey: "other:pi_1", hasPaymentIntent: true }],
    ["a refund with no author, no session and no package", { ...base, reason: "refund" }],
    ["a reason the constraint does not hold", { ...base, reason: "gift" }],
    ["a consume naming a package that did not resolve (another org's, or none)", { ...base, reason: "consume", packageId: "pkg-1", packageFound: false, packageFirstPayment: false }],
    ["a first-payment consume naming a package that did not resolve", { ...base, reason: "consume", packageId: "pkg-1", packageFound: false, packageFirstPayment: true }],
    ["a refund naming a package that did not resolve", { ...base, reason: "refund", packageId: "pkg-1", packageFound: false, packageFullRefund: true }],
  ])("%s is `other` — the only door to that kind", (_name, input) => {
    expect(streamHistoryKind(input)).toBe("other");
  });

  it("a package row is never a stream's: the same consume with and without a package names two different kinds; staff authorship still wins on a refund", () => {
    const consume = { ...base, reason: "consume", bucket: "monthly", sessionId: "s" };
    expect(streamHistoryKind(consume)).toBe("streamUsed");
    expect(streamHistoryKind({ ...consume, sessionId: null, ...pkg, packageFirstPayment: true })).toBe("onlinePackagePaid");
    // a staff refund is staff's, whatever it names: the package block never hides who wrote a row
    expect(streamHistoryKind({ ...base, ...pkg, reason: "refund", byStaff: true, packageFullRefund: true })).toBe("refundStaff");
  });
});

describe.skipIf(!HAS_DB)("the reader's reason set is the DB constraint's", () => {
  it("STREAM_LEDGER_REASONS equals org_stream_credits_reason_check, read from pg_constraint", async () => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'org_stream_credits' and c.conname = 'org_stream_credits_reason_check'`;
    // The guard on the guard: exactly one constraint answered, and it parsed to a non-empty list.
    expect(rows).toHaveLength(1);
    const fromDb = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(fromDb.length).toBeGreaterThan(0);
    expect([...STREAM_LEDGER_REASONS].sort()).toEqual([...fromDb].sort());
  });
});

describe.skipIf(!HAS_DB)("listStreamCreditHistory — every writer's row, through the real reader", () => {
  async function orgFacts(orgId: string) {
    const [o] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;
    return o!;
  }

  async function fixtureFacts(fixtureId: string) {
    const [f] = await sql<{
      fixture_no: number; div_slug: string; comp_slug: string; comp_name: string; home: string | null; away: string | null;
    }[]>`
      select f.fixture_no, d.slug as div_slug, c.slug as comp_slug, c.name as comp_name, h.display_name as home, a.display_name as away
        from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
        left join entrants h on h.id = f.home_entrant_id left join entrants a on a.id = f.away_entrant_id
       where f.id = ${fixtureId}`;
    return f!;
  }

  it("every writer's row lands on its own kind, with its own sign — and the six reasons in the DB constraint are ALL exercised", async () => {
    const r = await streamRig({ fixtures: 2 });
    const staff = await rigUser();
    const [fx0, fx1] = r.fixtureIds as [string, string];
    const s0 = await r.session(fx0);
    const s1 = await r.session(fx1);
    const intent = `pi_${randomUUID()}`;
    const expected = new Map<string, { kind: StreamHistoryKind; sign: 1 | -1; reason: string }>();
    // Every row is noted AGAINST the writer site that wrote it (_ledger-writer-sites.ts — the nine of stream-credits.ts, scanned out
    // of it by stream-credit-ledger-writers.test.ts; the package writer's three are driven by the next test). The matrix is not a
    // hand-kept list of "the writers I remembered": it must drive all nine, and every row must wear the shape its own site declares.
    const drove = new Map<string, string[]>();
    const note = (site: string, id: string, kind: StreamHistoryKind, sign: 1 | -1, reason: string) => {
      const declared = LEDGER_WRITER_SITES.find((x) => x.key === site);
      expect(declared, `site ${site} is in the registry`).toBeDefined();
      expect(declared!.kinds, `${site} shows as ${kind}`).toContain(kind);
      expect(declared!.reasons, `${site} writes a ${reason}`).toContain(reason);
      drove.set(site, [...(drove.get(site) ?? []), id]);
      expected.set(id, { kind, sign, reason });
    };
    const byKey = async (key: string) => (await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and idempotency_key = ${key}`)[0]!.id;

    // 1. a bought 5-pack, with the Stripe link the webhook writes
    const bought = await recordPurchase({
      orgId: r.orgId, delta: 5, stripeEventId: `cs_${randomUUID()}`,
      link: { checkoutSessionId: null, paymentIntentId: intent, pack: "seazn_stream_pack_5", amountMinor: 2500, currency: "gbp" },
    });
    note("purchase", bought.id, "packPurchase", 1, "purchase");
    // 2. this month's free grant
    const now = new Date();
    const granted = await ensureMonthlyStreamGrant(r.orgId, now);
    expect(granted, "the community plan grants a free monthly credit — the monthly bucket is under test").toBeGreaterThan(0);
    const [monthlyRow] = await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and reason = 'grant' and bucket = 'monthly' and idempotency_key not like '%:to-%'`;
    note("monthly-grant", monthlyRow!.id, "monthlyGrant", 1, "grant");
    // 3. a match streamed on the free credit (monthly is drawn first), 4. one on the bought pack
    const c0 = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx0, sessionId: s0 }));
    note("consume", c0.ledgerId!, "streamUsed", -1, "consume");
    const c1 = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx1, sessionId: s1 }));
    note("consume", c1.ledgerId!, "streamUsed", -1, "consume");
    // 4b. a mid-month upgrade: the plan now grants two more than this month has, so the rollover writes a TOP-UP of exactly
    //     the difference (review I3) — a third monthly-grant row, under its own key, that the matrix once never drove.
    expect(await grantMonthlyStreamCredits(r.orgId, granted + 2, now), "the top-up is the difference").toBe(2);
    const [topUpRow] = await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and reason = 'grant' and bucket = 'monthly' and idempotency_key like '%:to-%'`;
    note("monthly-topup", topUpRow!.id, "monthlyGrant", 1, "grant");
    // 5. the platform returns the first (R2008: the camera never connected)
    const sysRefund = await sql.begin((tx) => refundConsumeForSession(tx, { orgId: r.orgId, sessionId: s0, fixtureId: fx0, note: "R2008 test" }, new Date()));
    note("never-live-refund", sysRefund.ledgerId!, "refundNoCamera", 1, "refund");
    // 6. a staff refund linked to the second session, 7. a staff goodwill refund
    const linked = await refundCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "linked", idempotencyKey: `k-${randomUUID()}`, sessionId: s1 });
    note("staff", linked.id, "refundStaff", 1, "refund");
    const goodwill = await refundCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "goodwill", idempotencyKey: `k-${randomUUID()}`, sessionId: null });
    note("staff", goodwill.id, "refundStaff", 1, "refund");
    // 8. a staff grant, 9. a staff revoke
    const sg = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: staff, note: "pilot", idempotencyKey: `k-${randomUUID()}` });
    note("staff", sg.id, "staffAdjust", 1, "grant");
    const sr = await revokeCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "oops", idempotencyKey: `k-${randomUUID()}` });
    note("staff", sr.id, "staffAdjust", -1, "revoke");
    // 10. an Event Pass's one-off credits
    expect(await streamPassCredits("event_pass"), "the Event Pass rung grants match credits").toBeGreaterThan(0);
    const anchor = `pi_pass_${randomUUID()}`;
    expect(await grantPassStreamCredits({ orgId: r.orgId, passKey: "event_pass", anchor })).toBeGreaterThan(0);
    note("event-pass", await byKey(`stream-pass:${anchor}`), "passGrant", 1, "grant");
    // 11. the Stripe claw-back of the bought pack
    const claw = await recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: "ch_test" });
    expect(claw.applied, "the claw-back wrote its row").toBe(true);
    note("pack-clawback", await byKey(`stream_pack_refund:${intent}`), "packRefund", -1, "revoke");
    // 12. next month: the unspent free credit expires, and the new month's arrives
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    await ensureMonthlyStreamGrant(r.orgId, nextMonth);
    const [expireRow] = await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and reason = 'expire'`;
    note("monthly-expire", expireRow!.id, "expired", -1, "expire");
    const [newGrant] = await sql<{ id: string }[]>`
      select id from org_stream_credits where org_id = ${r.orgId} and reason = 'grant' and bucket = 'monthly' and id <> ${monthlyRow!.id} and idempotency_key not like '%:to-%'`;
    note("monthly-grant", newGrant!.id, "monthlyGrant", 1, "grant");

    const page = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: 50 });
    // Anti-vacuity: every ledger row came back, all of them were judged, and the judged set covers every reason.
    const total = (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`)[0]!.n;
    expect(page.rows).toHaveLength(total);
    expect(expected.size).toBe(total);
    expect(page.nextCursor).toBeNull();
    for (const row of page.rows) {
      const want = expected.get(row.id);
      expect(want, `row ${row.id} was written by a writer this test did not account for`).toBeDefined();
      expect(row.kind, `${want!.reason} row ${row.id}`).toBe(want!.kind);
      expect(Math.sign(row.delta)).toBe(want!.sign);
    }
    // All nine writer sites were driven, and every row wears the shape the site that wrote it declares — reason, bucket, author,
    // session link and idempotency-key format. A row attributed to the wrong site, or a site the matrix forgot, fails here.
    const nine = LEDGER_WRITER_SITES.filter((x) => x.file === STREAM_WRITER_FILE);
    expect([...drove.keys()].sort(), "the matrix drives every writer site of stream-credits.ts").toEqual(nine.map((x) => x.key).sort());
    expect(nine).toHaveLength(9);
    const shapes = await sql<{ id: string; reason: string; bucket: string; by_staff: boolean; session_id: string | null; idempotency_key: string | null; online_package_id: string | null }[]>`
      select id, reason, bucket, (created_by is not null) as by_staff, session_id, idempotency_key, online_package_id from org_stream_credits where org_id = ${r.orgId}`;
    let shaped = 0;
    for (const [siteKey, ids] of drove) {
      const declared = LEDGER_WRITER_SITES.find((x) => x.key === siteKey)!;
      for (const id of ids) {
        const row = shapes.find((x) => x.id === id);
        expect(row, `${siteKey}: row ${id} is in the ledger`).toBeDefined();
        expect(declared.reasons, `${siteKey}: reason ${row!.reason}`).toContain(row!.reason);
        expect(declared.buckets, `${siteKey}: bucket ${row!.bucket}`).toContain(row!.bucket);
        expect(row!.by_staff, `${siteKey}: authored by staff`).toBe(declared.byStaff);
        expect(row!.online_package_id !== null, `${siteKey}: names a package`).toBe(declared.package === "always");
        if (declared.session === "always") expect(row!.session_id, `${siteKey}: session`).not.toBeNull();
        if (declared.session === "never") expect(row!.session_id, `${siteKey}: session`).toBeNull();
        if (declared.key_shape) expect(row!.idempotency_key, `${siteKey}: key`).toMatch(declared.key_shape);
        else expect(row!.idempotency_key, `${siteKey}: key`).toBeNull();
        shaped += 1;
      }
    }
    expect(shaped, "anti-vacuity: every ledger row was shape-checked against its site").toBe(total);
    const reasonsSeen = new Set([...expected.values()].map((e) => e.reason));
    expect([...reasonsSeen].sort()).toEqual([...STREAM_LEDGER_REASONS].sort());
    expect(captureErrorMock, "no real writer's row reaches the unmapped door").not.toHaveBeenCalled();
    // newest first, by the table's own clock
    const stamps = page.rows.map((x) => Date.parse(x.dateIso));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    // the snapshot rides through untouched: the newest row's balance_after is the org's balance
    const [bal] = await sql<{ b: string }[]>`select coalesce(sum(delta), 0)::text as b from org_stream_credits where org_id = ${r.orgId}`;
    expect(page.rows[0]!.balanceAfter).toBe(Number(bal!.b));
    // The chain a reader follows down the page: each row's snapshot is the next-older row's snapshot plus its own change,
    // and the oldest row starts from nothing. Held for EVERY writer's row, rollover pair included (H12).
    for (let i = 0; i < page.rows.length - 1; i += 1) {
      expect(page.rows[i + 1]!.balanceAfter + page.rows[i]!.delta, `row ${i} (${page.rows[i]!.kind})`).toBe(page.rows[i]!.balanceAfter);
    }
    const oldest = page.rows[page.rows.length - 1]!;
    expect(oldest.balanceAfter).toBe(oldest.delta);
    // The rollover writes the expiry and the new grant in ONE transaction: the same created_at to the microsecond.
    // The grant (written second) lists above the expiry — the tie is real, and the order is the writers'.
    const [tie] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits where org_id = ${r.orgId} and id in (${expireRow!.id}, ${newGrant!.id})
       group by created_at having count(*) = 2`;
    expect(tie?.n, "the expiry and the new grant share a created_at").toBe(2);
    const at = (id: string) => page.rows.findIndex((x) => x.id === id);
    expect(at(newGrant!.id)).toBeLessThan(at(expireRow!.id));
  });

  it("every package writer's row lands on its own kind, with its own shape — pay, upgrade, move down, full refund, the card refund and its settle (H19, H20, H22, H23)", async () => {
    const packageSites = LEDGER_WRITER_SITES.filter((x) => x.file === PACKAGE_WRITER_FILE);
    expect(packageSites.map((x) => x.key).sort(), "premise: the registry's three package sites").toEqual(["package-debit", "package-return", "package-settle"]);
    const drove = new Set<string>();
    const kindsSeen = new Set<StreamHistoryKind>();
    let judged = 0;
    let packageRows = 0;
    let sizesChecked = 0;

    /** One org's story, told step by step: after each real door, the rows it wrote are exactly the ones the step lists (reason,
     *  bucket, signed change, the kind an organiser reads, and — for a package row — the writer site). The expected kinds are the
     *  spec's §8.8 words, the sizes and prices its decision-5 table (16 → 1, 32 → 2, 64 → 4, 256 → 16), typed here. */
    async function story(orgId: string, auth: AuthCtx) {
      const seen = new Set<string>();
      const expected = new Map<string, { kind: StreamHistoryKind; site: string | null; reason: string; size: number | null }>();
      /** `size` is the package's size AT THE TIME of the row (V561 package_size), typed from the story, never read back. */
      type Want = [reason: string, bucket: string, delta: number, kind: StreamHistoryKind, site?: string, size?: number];
      const step = async (name: string, want: Want[]) => {
        const rows = await sql<{ id: string; reason: string; bucket: string; delta: number }[]>`
          select id, reason, bucket, delta from org_stream_credits where org_id = ${orgId}`;
        const fresh = rows.filter((r) => !seen.has(r.id));
        const label = (r: { reason: string; bucket: string; delta: number }) => `${r.reason}/${r.bucket}/${r.delta}`;
        expect(fresh.map(label).sort(), `${name}: the rows the door wrote`).toEqual(want.map((w) => `${w[0]}/${w[1]}/${w[2]}`).sort());
        for (const f of fresh) {
          const w = want.find((x) => `${x[0]}/${x[1]}/${x[2]}` === label(f))!;
          seen.add(f.id);
          expected.set(f.id, { kind: w[3], site: w[4] ?? null, reason: f.reason, size: w[5] ?? null });
        }
      };
      const read = async () => listStreamCreditHistory(auth, orgId, { limit: 100 });
      /** The page, judged: every row came back, wearing the kind and the shape its step said. */
      const judge = async (label: string, pkg: { name: string; competition: string | null }) => {
        const page = await read();
        expect(page.rows, `${label}: every ledger row came back`).toHaveLength(expected.size);
        expect(page.nextCursor).toBeNull();
        const shapes = await sql<{ id: string; reason: string; bucket: string; by_staff: boolean; session_id: string | null; idempotency_key: string | null; online_package_id: string | null; intent: string | null; package_size: number | null }[]>`
          select id, reason, bucket, (created_by is not null) as by_staff, session_id, idempotency_key, online_package_id, stripe_payment_intent_id as intent, package_size
            from org_stream_credits where org_id = ${orgId}`;
        for (const row of page.rows) {
          const want = expected.get(row.id);
          expect(want, `${label}: row ${row.id} is one a step accounted for`).toBeDefined();
          expect(row.kind, `${label}: ${want!.reason} row ${row.id}`).toBe(want!.kind);
          kindsSeen.add(row.kind);
          judged += 1;
          if (want!.site !== null) {
            const declared = LEDGER_WRITER_SITES.find((x) => x.key === want!.site)!;
            const shape = shapes.find((x) => x.id === row.id)!;
            expect(declared.kinds, `${want!.site} shows as ${row.kind}`).toContain(row.kind);
            expect(declared.reasons, `${want!.site}: reason ${shape.reason}`).toContain(shape.reason);
            expect(declared.buckets, `${want!.site}: bucket ${shape.bucket}`).toContain(shape.bucket);
            expect(shape.by_staff, `${want!.site}: authored by staff`).toBe(declared.byStaff);
            expect(shape.session_id, `${want!.site}: session`).toBeNull();
            expect(shape.online_package_id !== null, `${want!.site}: names a package`).toBe(declared.package === "always");
            if (declared.key_shape) expect(shape.idempotency_key).toMatch(declared.key_shape);
            else expect(shape.idempotency_key, `${want!.site}: key`).toBeNull();
            if (want!.site === "package-settle") expect(shape.intent, "the settle row carries the reversed payment").not.toBeNull();
            // I1: the size is the one the row was written at — on the row itself (the writer's own column), and on the reader's block
            // — whatever the package's size is now. The settle row names no package: no size, no block.
            expect(shape.package_size, `${want!.site}: the stored size`).toBe(want!.size);
            if (want!.size !== null) {
              expect(row.onlinePackage, `${label}: ${row.kind} row ${row.id}: the division, ITS size, its competition`)
                .toEqual({ divisionName: pkg.name, size: want!.size, competitionName: pkg.competition });
              sizesChecked += 1;
            } else {
              expect(row.onlinePackage, `${label}: ${want!.site} names no package`).toBeNull();
            }
            drove.add(want!.site);
            packageRows += declared.package === "always" ? 1 : 0;
          }
        }
        return page;
      };
      return { step, judge };
    }
    const compName = async (compId: string) => (await sql<{ name: string }[]>`select name from competitions where id = ${compId}`)[0]!.name;

    // ---- A: the included credits (the monthly bucket), three payments and a full refund
    const a = await ocOrg();
    const aComp = await ocCompetition(a);
    const aDiv = await ocDivision(a, aComp, { name: "Matrix Open A" });
    const rate = (await sql<{ v: number }[]>`select int_value as v from plan_entitlements where plan_key = 'pro' and feature_key = 'streaming.credits.monthly'`)[0]!.v;
    expect(rate, "premise: the plan's month covers a 64-player package (4) and a 32 (2) one after the other, with credits to spare").toBeGreaterThanOrEqual(4);
    const sa = await story(a.orgId, a.auth);
    await pay(a, aDiv.id, 32);   // 32 players: 2 credits, drawn from the month's (the rollover grants the month in the same transaction)
    await sa.step("A first payment", [["grant", "monthly", rate, "monthlyGrant"], ["consume", "monthly", -2, "onlinePackagePaid", "package-debit", 32]]);
    await pay(a, aDiv.id, 64);   // up to 64: the difference, 2 credits
    await sa.step("A upgrade", [["consume", "monthly", -2, "onlinePackageResized", "package-debit", 64]]);
    await pay(a, aDiv.id, 32);   // back down: the 2 come back, in the month they were spent
    await sa.step("A move down", [["refund", "monthly", 2, "onlinePackageResized", "package-return", 32]]);
    // I1: the package is at 32 now, and the upgrade row still says 64 — each row reads its own size, never the package's current one.
    expect((await sql<{ size: number }[]>`select size from division_online_packages where division_id = ${aDiv.id}`)[0]!.size, "premise: the package is back at 32").toBe(32);
    const livePage = await sa.judge("A, live", { name: "Matrix Open A", competition: await compName(aComp) });
    const livePkgRows = livePage.rows.filter((r) => r.kind.startsWith("onlinePackage"));
    expect(livePkgRows, "anti-vacuity: A's package rows were read").toHaveLength(3);
    expect(livePkgRows.map((r) => [r.kind, r.onlinePackage!.size]).sort(), "the sizes at the time: 32, 64, then 32 again").toEqual([
      ["onlinePackagePaid", 32], ["onlinePackageResized", 32], ["onlinePackageResized", 64],
    ]);
    expect(livePage.rows.filter((r) => !r.kind.startsWith("onlinePackage")).every((r) => r.onlinePackage === null), "a row that is no package's carries no package block").toBe(true);
    await deleteDivision(a.auth, aDiv.id);   // the whole package goes back: 2 credits
    await sa.step("A delete", [["refund", "monthly", 2, "onlinePackageRefunded", "package-return", 32]]);
    // H21: the division is gone, its competition link with it; the rows keep the name the package snapshotted, and their own sizes
    const gonePage = await sa.judge("A, after the delete", { name: "Matrix Open A", competition: null });
    const gonePkg = gonePage.rows.filter((r) => r.kind.startsWith("onlinePackage"));
    expect(gonePkg, "the three earlier package rows and the refund").toHaveLength(4);
    expect(gonePkg.map((r) => r.onlinePackage!.size).sort((x, y) => x - y), "32, 32, 32 and the upgrade's 64").toEqual([32, 32, 32, 64]);

    // ---- P: the bought credits (the pack bucket), a card refund, and the settle step
    const p = await ocOrg();
    const pComp = await ocCompetition(p);
    const pDiv = await ocDivision(p, pComp, { name: "Matrix Open P" });
    const sp = await story(p.orgId, p.auth);
    await spendTheMonth(p.orgId);
    await sp.step("P the month spent", [["grant", "monthly", rate, "monthlyGrant"], ["consume", "monthly", -rate, "streamUsed"]]);
    const intent = await buy(p.orgId, 20);
    await sp.step("P a bought pack", [["purchase", "pack", 20, "packPurchase"]]);
    await pay(p, pDiv.id, 256);   // 256 players: 16 credits, all from the pack (the month is spent)
    await sp.step("P first payment", [["consume", "pack", -16, "onlinePackagePaid", "package-debit", 256]]);
    expect(await cardRefund(intent)).toMatchObject({ matched: true, clawedBack: 4, applied: true });
    await sp.step("P card refund", [["revoke", "pack", -4, "packRefund"]]);
    await deleteDivision(p.auth, pDiv.id);
    await sp.step("P delete", [["refund", "pack", 16, "onlinePackageRefunded", "package-return", 256], ["revoke", "pack", -16, "packRefund", "package-settle"]]);
    const pPage = await sp.judge("P, after the delete", { name: "Matrix Open P", competition: null });
    const settle = pPage.rows.find((r) => r.kind === "packRefund" && r.delta === -16)!;
    expect(settle, "the settle row is shown as a pack refunded").toBeDefined();
    expect(settle.onlinePackage, "…and names no package: it is the card's claw-back finishing, not a division's row").toBeNull();
    expect(pPage.rows.find((r) => r.kind === "onlinePackageRefunded")!.onlinePackage).toEqual({ divisionName: "Matrix Open P", size: 256, competitionName: null });
    expect(sizesChecked, "anti-vacuity: every package row's size was judged (3 of A live, 4 of A after the delete, 2 of P)").toBe(9);

    // The three package sites were all driven, every kind they can wear was seen, nothing was left unmapped, and the wire holds no
    // payer, package id or payment: the organiser reads words and numbers.
    expect([...drove].sort(), "the matrix drives every package writer site").toEqual(packageSites.map((x) => x.key).sort());
    for (const k of ["onlinePackagePaid", "onlinePackageResized", "onlinePackageRefunded", "packRefund"] as const) expect(kindsSeen.has(k), `kind ${k} was seen`).toBe(true);
    expect(kindsSeen.has("other"), "no real writer's row reaches the unmapped door").toBe(false);
    expect(packageRows, "anti-vacuity: package rows were shape-checked").toBeGreaterThanOrEqual(7);
    expect(judged, "anti-vacuity: every row of both orgs was judged").toBeGreaterThanOrEqual(15);
    expect(captureErrorMock, "unmapped count 0").not.toHaveBeenCalled();
    const [pkgA] = await sql<{ id: string }[]>`select id from division_online_packages where org_id = ${a.orgId}`;
    const wire = JSON.stringify([...gonePage.rows, ...pPage.rows]);
    for (const leaked of [a.auth.userId!, p.auth.userId!, pkgA!.id, intent]) expect(wire, "no payer, package id or payment intent leaves the reader").not.toContain(leaked);
  });

  it("a package row written before the size column (package_size null) reads the package's own size; a row that has one never does (H27-H29)", async () => {
    const o = await ocOrg();
    const div = await ocDivision(o, await ocCompetition(o), { name: "Legacy Open" });
    await pay(o, div.id, 64);
    const [pkg] = await sql<{ id: string }[]>`select id from division_online_packages where division_id = ${div.id}`;
    // the same package at 64 now; a row written at 16 (the size it had when it was written) and one with no size at all
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, package_size, balance_after)
      values (${o.orgId}, -1, 'consume', 'monthly', ${pkg!.id}, 16, 0), (${o.orgId}, -1, 'consume', 'monthly', ${pkg!.id}, null, 0)`;
    const rows = (await listStreamCreditHistory(o.auth, o.orgId, { limit: 100 })).rows.filter((r) => r.kind.startsWith("onlinePackage"));
    const bySize = rows.map((r) => r.onlinePackage!.size).sort((x, y) => x - y);
    expect(bySize, "the real payment (64), the row written at 16, and the row with no size reading the package's 64").toEqual([16, 64, 64]);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("a ledger row naming ANOTHER org's package is reported, never shown as a division's — and that org's own history still shows it (H18)", async () => {
    const a = await ocOrg();
    const b = await ocOrg();
    const bDiv = await ocDivision(b, await ocCompetition(b), { name: "Rival Open Of B" });
    await pay(b, bDiv.id, 16);
    const [bPkg] = await sql<{ id: string }[]>`select id from division_online_packages where division_id = ${bDiv.id}`;
    // V560/V561 do not make the package's org the ledger row's: only the reader's join stands between A's page and B's division.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, balance_after)
      values (${a.orgId}, -1, 'consume', 'monthly', ${bPkg!.id}, 0)`;
    const asA = await listStreamCreditHistory(a.auth, a.orgId);
    expect(asA.rows, "anti-vacuity: the crossed row was read").toHaveLength(1);
    expect(asA.rows[0]!.kind).toBe("other");
    expect(asA.rows[0]!.onlinePackage).toBeNull();
    expect(JSON.stringify(asA.rows), "another org's division name is never read").not.toContain("Rival Open Of B");
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    captureErrorMock.mockClear();
    // positive pair: B's own page shows its own package under its own name
    const asB = await listStreamCreditHistory(b.auth, b.orgId);
    const paid = asB.rows.find((r) => r.kind === "onlinePackagePaid");
    expect(paid?.onlinePackage?.divisionName).toBe("Rival Open Of B");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("consume and refund rows link their match — names, competition and the fixture page's own URL; a purchase links nothing", async () => {
    const r = await streamRig();
    const fx = r.fixtureIds[0]!;
    const s = await r.session(fx);
    await recordPurchase({ orgId: r.orgId, delta: 2, stripeEventId: `cs_${randomUUID()}` });
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx, sessionId: s }));
    const facts = await fixtureFacts(fx);
    const org = await orgFacts(r.orgId);
    expect(facts.home && facts.away, "the rig's fixture has two named entrants").toBeTruthy();

    const { rows } = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    const consume = rows.find((x) => x.kind === "streamUsed")!;
    expect(consume.fixture).toEqual({
      homeName: facts.home, awayName: facts.away, fixtureNo: facts.fixture_no, competitionName: facts.comp_name,
      href: routes.fixture(org.slug, facts.comp_slug, facts.div_slug, facts.fixture_no),
    });
    expect(rows.find((x) => x.kind === "packPurchase")!.fixture).toBeNull();
  });

  it("a fixture that has since gone shows the row without a link — the ledger outlives the match", async () => {
    const r = await streamRig();
    const fx = r.fixtureIds[0]!;
    const s = await r.session(fx);
    await recordPurchase({ orgId: r.orgId, delta: 1, stripeEventId: `cs_${randomUUID()}` });
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx, sessionId: s }));
    // fixture_stream_sessions.fixture_id is `on delete set null` (V410): the session survives its fixture.
    await sql`update fixture_stream_sessions set fixture_id = null where id = ${s}`;
    const { rows } = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    const consume = rows.find((x) => x.kind === "streamUsed")!;
    expect(consume.fixture).toBeNull();
    expect(consume.delta).toBe(-1);
  });

  it("only THIS org's rows — another org's ledger is in neither list, and each is readable where it belongs (H1, with its positive pair)", async () => {
    const a = await streamRig();
    const b = await streamRig();
    await recordPurchase({ orgId: a.orgId, delta: 3, stripeEventId: `cs_${randomUUID()}` });
    await recordPurchase({ orgId: b.orgId, delta: 7, stripeEventId: `cs_${randomUUID()}` });
    const ra = await listStreamCreditHistory(sessionAuth(a.orgId), a.orgId);
    const rb = await listStreamCreditHistory(sessionAuth(b.orgId), b.orgId);
    expect(ra.rows.map((x) => x.delta)).toEqual([3]);
    expect(rb.rows.map((x) => x.delta)).toEqual([7]);
  });

  it("a ledger row linked to ANOTHER org's session shows no fixture (H2) — the other org's match is never named", async () => {
    const a = await streamRig();
    const b = await streamRig();
    const sessionOfA = await a.session(a.fixtureIds[0]!);
    // A corrupt/hand-built row: B's ledger naming A's session. No FK stops it; the reader's join must.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after)
      values (${b.orgId}, -1, 'consume', 'pack', ${sessionOfA}, 0)`;
    const { rows } = await listStreamCreditHistory(sessionAuth(b.orgId), b.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("streamUsed");
    expect(rows[0]!.fixture).toBeNull();
    // positive pair: A's own consume of its own session does link.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after)
      values (${a.orgId}, -1, 'consume', 'pack', ${sessionOfA}, 0)`;
    const own = await listStreamCreditHistory(sessionAuth(a.orgId), a.orgId);
    expect(own.rows[0]!.fixture).not.toBeNull();
  });

  it("each tenancy join guard holds on its own: a session of org A on a fixture of org B's competition names no match to EITHER org (H2, H13)", async () => {
    // The test above cannot tell the two guards apart: with the session's org guard dropped, the competition's org guard
    // still nulls the fixture, and the other way round — two guards covering for each other, so each is untested. This
    // row is the one only ONE guard can refuse: a session whose org is A but whose fixture is B's.
    const a = await streamRig();
    const b = await streamRig();
    const fixtureOfB = b.fixtureIds[0]!;
    const targetOfA = await rigTarget(a.orgId);
    const [cross] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
      select f.id, ${a.orgId}, 'passthrough', 'completed', ${targetOfA}, ${a.createdBy}, d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureOfB}
      returning id`;
    expect(cross, "the cross-org session was written").toBeDefined();
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after)
      values (${b.orgId}, -1, 'consume', 'pack', ${cross!.id}, 0), (${a.orgId}, -1, 'consume', 'pack', ${cross!.id}, 0)`;
    // B's ledger row names a session that is A's: refused by the session's org (the competition BELONGS to B, so only the
    // session guard stands between this row and B's own match).
    const asB = await listStreamCreditHistory(sessionAuth(b.orgId), b.orgId);
    expect(asB.rows).toHaveLength(1);
    expect(asB.rows[0]!.fixture, "H2: the session is another org's").toBeNull();
    // A's ledger row names A's own session, whose fixture is in B's competition: refused by the competition's org (the
    // session passes the first guard, so only the competition guard stands between this row and B's competition name).
    const asA = await listStreamCreditHistory(sessionAuth(a.orgId), a.orgId);
    expect(asA.rows).toHaveLength(1);
    expect(asA.rows[0]!.fixture, "H13: the competition is another org's").toBeNull();
    // positive pair: B's own session on B's own fixture links, so a null above is a refusal and not a broken join.
    const own = await b.session(fixtureOfB);
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after) values (${b.orgId}, -1, 'consume', 'pack', ${own}, 0)`;
    const again = await listStreamCreditHistory(sessionAuth(b.orgId), b.orgId);
    expect(again.rows.filter((x) => x.fixture !== null)).toHaveLength(1);
  });

  it("no staff identity, note or key leaves the reader (H9) — the row's keys are exactly the organiser's", async () => {
    const r = await streamRig();
    const staff = await rigUser();
    const [u] = await sql<{ email: string }[]>`select email from users where id = ${staff}`;
    const secretNote = `internal-note-${randomUUID()}`;
    const key = `k-${randomUUID()}`;
    await grantCredits({ orgId: r.orgId, delta: 2, createdBy: staff, note: secretNote, idempotencyKey: key });
    const { rows } = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["balanceAfter", "dateIso", "delta", "fixture", "id", "kind", "onlinePackage"]);
    const wire = JSON.stringify(rows);
    for (const leaked of [staff, u!.email, secretNote, key]) expect(wire).not.toContain(leaked);
  });

  it("a row no writer produces is reported and never wears a real label (H11)", async () => {
    const r = await streamRig();
    // grant / pack / no author / no key — none of the four grant writers leaves this shape.
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, 3, 'grant', 'pack', 3)`;
    const { rows } = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    expect(rows.map((x) => x.kind)).toEqual(["other"]);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(String((captureErrorMock.mock.calls[0]![0] as Error).message)).toContain("org_stream_credits");
  });

  it("many unmapped rows are ONE report per read, carrying the count — not one per row per read (H15)", async () => {
    const r = await streamRig();
    for (let i = 1; i <= 3; i += 1) {
      await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${r.orgId}, 1, 'grant', 'pack', ${i})`;
    }
    const { rows } = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    expect(rows.map((x) => x.kind), "anti-vacuity: three unmapped rows were read").toEqual(["other", "other", "other"]);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureErrorMock.mock.calls[0]! as [Error, { orgId: string; extra: { count: number; sample: unknown[] } }];
    expect(err.message).toContain("3 org_stream_credits row(s)");
    expect(ctx.orgId).toBe(r.orgId);
    expect(ctx.extra.count).toBe(3);
    expect(ctx.extra.sample).toHaveLength(3);
    // a second read is a second report (the problem is still there) — once per read
    await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId);
    expect(captureErrorMock).toHaveBeenCalledTimes(2);
    // …and a page of mapped rows reports nothing
    const clean = await streamRig();
    await recordPurchase({ orgId: clean.orgId, delta: 5, stripeEventId: `cs_${randomUUID()}` });
    captureErrorMock.mockClear();
    await listStreamCreditHistory(sessionAuth(clean.orgId), clean.orgId);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("an EMPTY ledger reads { rows: [], nextCursor: null } — the empty set, stated", async () => {
    const r = await streamRig();
    expect(await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId)).toEqual({ rows: [], nextCursor: null });
  });

  describe("pagination", () => {
    /** 9 purchase rows, µs-spaced in pairs: ties on created_at (broken by id) AND neighbours a microsecond apart —
     *  the shape a millisecond cursor mishandles (H5). */
    async function tiedLedger(orgId: string, n = 9, hoursAgo = 1) {
      await sql`
        insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, created_at)
        select ${orgId}, 1, 'purchase', 'pack', g + 1, now() - ${hoursAgo} * interval '1 hour' + (g / 2) * interval '1 microsecond'
          from generate_series(0, ${n - 1}) g`;
      return (await sql<{ id: string }[]>`
        select id from org_stream_credits where org_id = ${orgId} order by created_at desc, id desc`).map((x) => x.id);
    }

    it("the pages tile the ledger — every row once, in order, ties and microsecond neighbours included (H3/H4/H5/H6)", async () => {
      const r = await streamRig();
      const all = await tiedLedger(r.orgId, 9);
      expect(new Set((await sql<{ t: string }[]>`select created_at::text as t from org_stream_credits where org_id = ${r.orgId}`).map((x) => x.t)).size,
        "the fixture really has tied created_at values").toBeLessThan(9);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: 4, cursor });
        pages += 1;
        seen.push(...page.rows.map((x) => x.id));
        cursor = page.nextCursor ?? undefined;
        if (cursor) expect(page.rows).toHaveLength(4);
      } while (cursor && pages < 10);
      expect(pages).toBe(3);                // 4 + 4 + 1
      expect(seen).toEqual(all);            // no dupes, no gaps, newest first
    });

    it("the rollover's tie: the expiry lists BELOW the grant it was written with, whatever their ids say — and a page that ends on either row never repeats one (H12, H14)", async () => {
      // The month turning writes an expiry and the new grant in ONE transaction: the same created_at to the microsecond. The
      // ids here are chosen so that `id desc` ALONE gets the order wrong (the expiry's id is the largest possible, the
      // grant's the smallest) — the random ids the writers' own rows get would be a coin flip. The expected order is the
      // order the rows were WRITTEN in (the expiry, then the grant), newest first, written out by hand.
      const r = await streamRig();
      const hex = () => randomUUID().replace(/-/g, "").slice(0, 12);
      const expiryId = `ffffffff-ffff-4fff-8fff-${hex()}`;
      const grantId = `00000000-0000-4000-8000-${hex()}`;
      const purchaseId = randomUUID();
      const septemberId = randomUUID();
      const tie = "2026-10-01 00:00:00.123456+00";
      await sql`
        insert into org_stream_credits (id, org_id, delta, reason, bucket, balance_after, idempotency_key, created_at) values
          (${septemberId}, ${r.orgId}, 1, 'grant', 'monthly', 1, ${`stream-monthly:${r.orgId}:2026-09`}, '2026-09-01 00:00:01+00'),
          (${expiryId}, ${r.orgId}, -1, 'expire', 'monthly', 0, null, ${tie}::text::timestamptz),
          (${grantId}, ${r.orgId}, 1, 'grant', 'monthly', 1, ${`stream-monthly:${r.orgId}:2026-10`}, ${tie}::text::timestamptz),
          (${purchaseId}, ${r.orgId}, 2, 'purchase', 'pack', 3, null, '2026-10-05 12:00:00+00')`;
      const [tied] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId} and id in (${expiryId}, ${grantId}) group by created_at having count(*) = 2`;
      expect(tied?.n, "PREMISE: the expiry and the grant share a created_at to the microsecond").toBe(2);
      expect(expiryId > grantId, "PREMISE: `id desc` alone would list the expiry first").toBe(true);

      const expected = [purchaseId, grantId, expiryId, septemberId];   // newest first; the expiry below the grant
      const whole = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: 50 });
      expect(whole.rows.map((x) => x.id), "one page").toEqual(expected);
      // The chain a reader follows down the page: each snapshot is the next-older one plus the row's own change.
      for (let i = 0; i < whole.rows.length - 1; i += 1) {
        expect(whole.rows[i + 1]!.balanceAfter + whole.rows[i]!.delta, `row ${i}`).toBe(whole.rows[i]!.balanceAfter);
      }

      // Every page size: limit 1 and 3 end a page on the tie rows themselves (3 ends exactly on the EXPIRY), 2 starts one on it.
      let boundariesOnTie = 0;
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit, cursor });
          pages += 1;
          seen.push(...page.rows.map((x) => x.id));
          const last = page.rows[page.rows.length - 1]!;
          if (page.nextCursor && (last.id === expiryId || last.id === grantId)) {
            boundariesOnTie += 1;
            // The cursor's flag is the row's own: `f` after the expiry, `t` after anything else (the tie-break's whole content).
            const [, flag] = Buffer.from(page.nextCursor, "base64url").toString("utf8").split("|");
            expect(flag, `a page ending on ${last.id === expiryId ? "the expiry" : "the grant"}`).toBe(last.id === expiryId ? "f" : "t");
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor && pages < 6);
        expect(seen, `limit ${limit}: every row once, in order`).toEqual(expected);
        expect(new Set(seen).size, `limit ${limit}: no row repeated`).toBe(expected.length);
        expect(pages).toBe(Math.ceil(expected.length / limit));
      }
      expect(boundariesOnTie, "anti-vacuity: pages really did end on the tie rows").toBeGreaterThanOrEqual(3);
    });

    it("a ledger of exactly one page has no next page — not an empty one (H6)", async () => {
      const r = await streamRig();
      await tiedLedger(r.orgId, 4);
      const page = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: 4 });
      expect(page.rows).toHaveLength(4);
      expect(page.nextCursor).toBeNull();
    });

    it("the default page is 25 and the ceiling is STREAM_HISTORY_MAX_LIMIT; anything outside 1..ceiling is refused by name", async () => {
      const r = await streamRig();
      await tiedLedger(r.orgId, 30);
      expect((await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId)).rows).toHaveLength(25);
      for (const bad of [0, -1, 1.5, STREAM_HISTORY_MAX_LIMIT + 1]) {
        await expect(listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: bad })).rejects.toMatchObject({ status: 422, code: "limit_invalid" });
      }
      expect((await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId, { limit: STREAM_HISTORY_MAX_LIMIT })).rows).toHaveLength(30);
    });

    it("a cursor that is not one of ours is a 400, not a SQL error — and another org's cursor reads only the reader's own org", async () => {
      const a = await streamRig();
      const b = await streamRig();
      await tiedLedger(a.orgId, 6);
      await tiedLedger(b.orgId, 2, 2);   // older than any cursor A's pages hand out, so B's reader has rows to return
      const aUuid = "11111111-1111-4111-8111-111111111111";
      const withAt = (at: string) => Buffer.from(`${at}|t|${aUuid}`).toString("base64url");
      for (const bad of [
        "", "not-base64!!", Buffer.from("nope").toString("base64url"), Buffer.from("2026-01-01|not-a-uuid").toString("base64url"),
        withAt("2026-13-01 00:00:00+00"), withAt("2026-02-31 00:00:00+00"), withAt("2026-10-20 09:00:00+99"),   // shaped right, no such instant (m2)
      ]) {
        await expect(listStreamCreditHistory(sessionAuth(a.orgId), a.orgId, { cursor: bad })).rejects.toMatchObject({ status: 400, code: "cursor_invalid" });
      }
      // A's cursor handed to B's reader: B's two rows are older than the cursor, so they come back — and nothing of A's does.
      const first = await listStreamCreditHistory(sessionAuth(a.orgId), a.orgId, { limit: 2 });
      const asB = await listStreamCreditHistory(sessionAuth(b.orgId), b.orgId, { cursor: first.nextCursor! });
      const bIds = new Set((await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${b.orgId}`).map((x) => x.id));
      expect(asB.rows.length).toBeGreaterThan(0);
      for (const row of asB.rows) expect(bIds.has(row.id)).toBe(true);
    });
  });

  describe("authz — the AI credits tab's own audience: a signed-in person of the org (or its billing payer), nothing else", () => {
    it("an owner, an admin, a viewer and a billing payer who is not a member (role null) may all read (positive pairs)", async () => {
      const r = await streamRig();
      await recordPurchase({ orgId: r.orgId, delta: 1, stripeEventId: `cs_${randomUUID()}` });
      for (const role of ["owner", "admin", "viewer", null] as const) {
        const page = await listStreamCreditHistory(sessionAuth(r.orgId, role), r.orgId);
        expect(page.rows, `role ${String(role)}`).toHaveLength(1);
      }
    });

    it("an API key and a device link are refused — a scoring device never reads the money ledger (H7)", async () => {
      const r = await streamRig();
      await recordPurchase({ orgId: r.orgId, delta: 1, stripeEventId: `cs_${randomUUID()}` });
      for (const via of ["api_key", "device_link"] as const) {
        const auth: AuthCtx = { orgId: r.orgId, via, userId: null, role: null, keyId: via === "api_key" ? randomUUID() : null };
        await expect(listStreamCreditHistory(auth, r.orgId)).rejects.toMatchObject({ status: 403, code: "history_session_only" });
      }
    });

    it("another organisation's session is a 404 — never a 403 that confirms the org exists (H8)", async () => {
      const a = await streamRig();
      const b = await streamRig();
      await recordPurchase({ orgId: b.orgId, delta: 1, stripeEventId: `cs_${randomUUID()}` });
      const err = await listStreamCreditHistory(sessionAuth(a.orgId, "owner"), b.orgId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
    });

    it("an upper-case org id (a hand-built URL) names the same org — the comparison is case-blind, like the money lock's", async () => {
      const r = await streamRig();
      await recordPurchase({ orgId: r.orgId, delta: 1, stripeEventId: `cs_${randomUUID()}` });
      const page = await listStreamCreditHistory(sessionAuth(r.orgId), r.orgId.toUpperCase());
      expect(page.rows).toHaveLength(1);
    });
  });
});
