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
//   H12 rollover tie    drop `(c.reason <> 'expire') desc` from the order (and the cursor key)  → "every writer's row lands on its own kind" (the chain and the tie)
//   H11 unmapped        classifier `default` returns a mapped kind                → "a row no writer produces is reported and never wears a real label"
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rigTarget, rigUser, streamRig } from "@/server/relay/__tests__/_session-rig";
import {
  consumeForSession, ensureMonthlyStreamGrant, grantCredits, grantPassStreamCredits, recordPurchase,
  recordStreamPackRefund, refundConsumeForSession, refundCredits, revokeCredits, streamPassCredits,
} from "@/server/usecases/stream-credits";

const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));
vi.mock("@/lib/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sentry")>()),
  captureError: (...args: unknown[]) => captureErrorMock(...args),
}));

import {
  STREAM_HISTORY_KINDS, STREAM_HISTORY_MAX_LIMIT, STREAM_LEDGER_REASONS, listStreamCreditHistory, streamHistoryKind,
  type StreamHistoryKind,
} from "../stream-credit-history";

const HAS_DB = !!process.env.DATABASE_URL;

const sessionAuth = (orgId: string, role: AuthCtx["role"] = "viewer"): AuthCtx => ({ orgId, via: "session", userId: null, role, keyId: null });

beforeEach(() => captureErrorMock.mockClear());

describe("streamHistoryKind — the pure map (no DB)", () => {
  const base = { reason: "grant", bucket: "pack", byStaff: false, sessionId: null, idempotencyKey: null };
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
    ["a revoke with no author and no claw-back key", { ...base, reason: "revoke" }],
    ["a refund with no author and no session", { ...base, reason: "refund" }],
    ["a reason the constraint does not hold", { ...base, reason: "gift" }],
  ])("%s is `other` — the only door to that kind", (_name, input) => {
    expect(streamHistoryKind(input)).toBe("other");
  });
});

describe("the classifier's one assumption about a writer, held to the tree", () => {
  const SRC = join(process.cwd(), "src");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
      return /\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("refundConsumeForSession has exactly ONE production call — the R2008 never-live cancel — because an author-less, session-linked refund reads as \"the camera never connected\"", () => {
    const calls: string[] = [];
    let scanned = 0;
    for (const file of walk(SRC)) {
      scanned += 1;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (/\brefundConsumeForSession\(/.test(code) && !/function refundConsumeForSession\(/.test(code)) {
          calls.push(`${relative(SRC, file)}:${i + 1}`);
        }
      });
    }
    expect(scanned, "the scan walked the source tree").toBeGreaterThan(200);
    // A second caller must give its refunds their own discriminator in streamHistoryKind (and a kind), then update this list.
    expect(calls.map((c) => c.replace(/:\d+$/, ""))).toEqual(["server/usecases/stream-sessions.ts"]);
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
    const note = (id: string, kind: StreamHistoryKind, sign: 1 | -1, reason: string) => expected.set(id, { kind, sign, reason });
    const byKey = async (key: string) => (await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and idempotency_key = ${key}`)[0]!.id;

    // 1. a bought 5-pack, with the Stripe link the webhook writes
    const bought = await recordPurchase({
      orgId: r.orgId, delta: 5, stripeEventId: `cs_${randomUUID()}`,
      link: { checkoutSessionId: null, paymentIntentId: intent, pack: "seazn_stream_pack_5", amountMinor: 2500, currency: "gbp" },
    });
    note(bought.id, "packPurchase", 1, "purchase");
    // 2. this month's free grant
    const now = new Date();
    const granted = await ensureMonthlyStreamGrant(r.orgId, now);
    expect(granted, "the community plan grants a free monthly credit — the monthly bucket is under test").toBeGreaterThan(0);
    const [monthlyRow] = await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and reason = 'grant' and bucket = 'monthly'`;
    note(monthlyRow!.id, "monthlyGrant", 1, "grant");
    // 3. a match streamed on the free credit (monthly is drawn first), 4. one on the bought pack
    const c0 = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx0, sessionId: s0 }));
    note(c0.ledgerId!, "streamUsed", -1, "consume");
    const c1 = await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx1, sessionId: s1 }));
    note(c1.ledgerId!, "streamUsed", -1, "consume");
    // 5. the platform returns the first (R2008: the camera never connected)
    const sysRefund = await sql.begin((tx) => refundConsumeForSession(tx, { orgId: r.orgId, sessionId: s0, note: "R2008 test" }));
    note(sysRefund.ledgerId!, "refundNoCamera", 1, "refund");
    // 6. a staff refund linked to the second session, 7. a staff goodwill refund
    const linked = await refundCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "linked", idempotencyKey: `k-${randomUUID()}`, sessionId: s1 });
    note(linked.id, "refundStaff", 1, "refund");
    const goodwill = await refundCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "goodwill", idempotencyKey: `k-${randomUUID()}`, sessionId: null });
    note(goodwill.id, "refundStaff", 1, "refund");
    // 8. a staff grant, 9. a staff revoke
    const sg = await grantCredits({ orgId: r.orgId, delta: 2, createdBy: staff, note: "pilot", idempotencyKey: `k-${randomUUID()}` });
    note(sg.id, "staffAdjust", 1, "grant");
    const sr = await revokeCredits({ orgId: r.orgId, delta: 1, createdBy: staff, note: "oops", idempotencyKey: `k-${randomUUID()}` });
    note(sr.id, "staffAdjust", -1, "revoke");
    // 10. an Event Pass's one-off credits
    expect(await streamPassCredits("event_pass"), "the Event Pass rung grants match credits").toBeGreaterThan(0);
    const anchor = `pi_pass_${randomUUID()}`;
    expect(await grantPassStreamCredits({ orgId: r.orgId, passKey: "event_pass", anchor })).toBeGreaterThan(0);
    note(await byKey(`stream-pass:${anchor}`), "passGrant", 1, "grant");
    // 11. the Stripe claw-back of the bought pack
    const claw = await recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: "ch_test" });
    expect(claw.applied, "the claw-back wrote its row").toBe(true);
    note(await byKey(`stream_pack_refund:${intent}`), "packRefund", -1, "revoke");
    // 12. next month: the unspent free credit expires, and the new month's arrives
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    await ensureMonthlyStreamGrant(r.orgId, nextMonth);
    const [expireRow] = await sql<{ id: string }[]>`select id from org_stream_credits where org_id = ${r.orgId} and reason = 'expire'`;
    note(expireRow!.id, "expired", -1, "expire");
    const [newGrant] = await sql<{ id: string }[]>`
      select id from org_stream_credits where org_id = ${r.orgId} and reason = 'grant' and bucket = 'monthly' and id <> ${monthlyRow!.id}`;
    note(newGrant!.id, "monthlyGrant", 1, "grant");

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
    expect(Object.keys(rows[0]!).sort()).toEqual(["balanceAfter", "dateIso", "delta", "fixture", "id", "kind"]);
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
      for (const bad of ["", "not-base64!!", Buffer.from("nope").toString("base64url"), Buffer.from("2026-01-01|not-a-uuid").toString("base64url")]) {
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
