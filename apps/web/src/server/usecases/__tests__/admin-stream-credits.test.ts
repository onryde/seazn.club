// The staff "Match credits" panel's read (Task 7A, owner ruling 15). Real Postgres; skipped
// without DATABASE_URL. Rows are inserted by hand at explicit AGES so the order is the test's,
// not the clock's. Killers for the PR's mutant table (Step 5):
//   R1 one authority  balance: creditBalance(sql, orgId) → rows[0]?.balanceAfter ?? 0 → "the balance is sum(delta)"
//   R2 left join      `left join users` → `join users`                                → "every field is mapped"
//   R3 org scope      drop `where c.org_id = ${orgId}`                                 → "only THIS org"
//   R4 order          `c.created_at desc` → `c.created_at asc`                         → "the newest … rows"
//   R6 limit          drop `limit ${STREAM_CREDIT_LEDGER_LIMIT}`                        → "the newest … rows"
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { STAFF_CREDIT_MAX } from "@/server/usecases/stream-credits";
import { STREAM_CREDIT_ADJUST_MAX, STREAM_CREDIT_LEDGER_LIMIT, streamCreditsForOrg } from "../admin-stream-credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function freshOrg(): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ledger " + s}, ${"ledger-" + s}) returning id`;
  return id;
}

async function author(): Promise<{ id: string; email: string }> {
  const email = `ledger-author-${uniq()}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Ledger Author', true) returning id`;
  return { id, email };
}

/** One ledger row at an explicit age. */
async function ledgerRow(orgId: string, r: {
  reason: string; delta: number; balanceAfter: number; minutesAgo: number;
  note?: string; createdBy?: string; sessionId?: string; stripeEventId?: string;
}): Promise<void> {
  await sql`
    insert into org_stream_credits (org_id, delta, reason, balance_after, note, created_by, session_id, stripe_event_id, created_at)
    values (${orgId}, ${r.delta}, ${r.reason}, ${r.balanceAfter}, ${r.note ?? null}, ${r.createdBy ?? null},
            ${r.sessionId ?? null}, ${r.stripeEventId ?? null}, now() - (${r.minutesAgo}::int * interval '1 minute'))`;
}

describe.skipIf(!HAS_DB)("streamCreditsForOrg — the staff panel's read", () => {
  it("an EMPTY ledger reads { balance: 0, rows: [] } (the empty set, explicitly)", async () => {
    expect(await streamCreditsForOrg(await freshOrg())).toEqual({ balance: 0, rows: [] });
  });

  it("every field is mapped, newest first — a purchase row with NO author and a consume row with NO author survive the users join (R2), the consume row carries its session, and a NEGATIVE revoke row passes through signed", async () => {
    const a = await author();
    const r = await streamRig({ createdBy: a.id });
    const orgId = r.orgId;
    const sessionId = await r.session(r.fixtureIds[0]!, "failed");
    await ledgerRow(orgId, { reason: "purchase", delta: 5, balanceAfter: 5, minutesAgo: 40, stripeEventId: `evt_${randomUUID()}` });
    await ledgerRow(orgId, { reason: "consume", delta: -1, balanceAfter: 4, minutesAgo: 30, sessionId });
    await ledgerRow(orgId, { reason: "grant", delta: 3, balanceAfter: 7, minutesAgo: 20, note: "pilot league", createdBy: a.id });
    await ledgerRow(orgId, { reason: "revoke", delta: -1, balanceAfter: 6, minutesAgo: 10, note: "one too many", createdBy: a.id });
    const read = await streamCreditsForOrg(orgId);
    expect(read.balance).toBe(6);
    expect(read.rows).toEqual([
      { id: expect.any(String), reason: "revoke", delta: -1, balanceAfter: 6, note: "one too many", createdBy: a.id, createdByEmail: a.email, sessionId: null,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) },
      { id: expect.any(String), reason: "grant", delta: 3, balanceAfter: 7, note: "pilot league", createdBy: a.id, createdByEmail: a.email, sessionId: null, createdAt: expect.any(String) },
      { id: expect.any(String), reason: "consume", delta: -1, balanceAfter: 4, note: null, createdBy: null, createdByEmail: null, sessionId, createdAt: expect.any(String) },
      { id: expect.any(String), reason: "purchase", delta: 5, balanceAfter: 5, note: null, createdBy: null, createdByEmail: null, sessionId: null, createdAt: expect.any(String) },
    ]);
  });

  it("only THIS org's rows and balance — another org's grant is in neither, and is readable where it belongs (R3, with its positive pair)", async () => {
    const a = await freshOrg();
    const b = await freshOrg();
    await ledgerRow(a, { reason: "grant", delta: 1, balanceAfter: 1, minutesAgo: 2 });
    await ledgerRow(b, { reason: "grant", delta: 4, balanceAfter: 4, minutesAgo: 1 });
    const read = await streamCreditsForOrg(a);
    expect(read.balance).toBe(1);
    expect(read.rows.map((r) => r.delta)).toEqual([1]);
    const other = await streamCreditsForOrg(b);
    expect([other.balance, other.rows.map((r) => r.delta)]).toEqual([4, [4]]);
  });

  it("the newest STREAM_CREDIT_LEDGER_LIMIT rows, newest first — the OLDEST is the one dropped — while the balance still counts EVERY row (R4, R6)", async () => {
    const orgId = await freshOrg();
    const n = STREAM_CREDIT_LEDGER_LIMIT + 1;
    for (let i = 1; i <= n; i++) {
      // row 1 is the oldest; row n the newest
      await ledgerRow(orgId, { reason: "grant", delta: 1, balanceAfter: i, minutesAgo: n - i + 1, note: `row ${i}` });
    }
    const read = await streamCreditsForOrg(orgId);
    expect(read.rows).toHaveLength(STREAM_CREDIT_LEDGER_LIMIT);
    expect(read.rows[0]!.note).toBe(`row ${n}`);
    expect(read.rows.map((r) => r.note)).not.toContain("row 1");
    // The differential: the balance is over ALL rows, the displayed rows sum to one fewer.
    expect(read.balance).toBe(n);
    expect(read.rows.reduce((s, r) => s + r.delta, 0)).toBe(STREAM_CREDIT_LEDGER_LIMIT);
  });

  it("the balance is sum(delta) through creditBalance, NOT the newest row's balance_after — a disagreeing snapshot is shown as-is and never read as the balance (R1)", async () => {
    const orgId = await freshOrg();
    await ledgerRow(orgId, { reason: "grant", delta: 3, balanceAfter: 99, minutesAgo: 1 });
    const read = await streamCreditsForOrg(orgId);
    expect(read.balance).toBe(3);
    expect(read.rows[0]!.balanceAfter).toBe(99);
  });

  it("the panel's ceiling is the WRITER's ceiling, re-exported and never a second 50: STREAM_CREDIT_ADJUST_MAX is stream-credits.ts's STAFF_CREDIT_MAX itself (carry I-cap)", async () => {
    // A re-export, not a copy: the route's zod ceiling, the panel's input `max` and staffRow's own
    // 1..MAX refusal are one binding, so moving the ruled cap moves all three together. Identity is
    // asserted against the IMPORTED constant — never against a literal typed here (S10).
    expect(STREAM_CREDIT_ADJUST_MAX).toBe(STAFF_CREDIT_MAX);
    // …and the alias must be a RE-EXPORT rather than a second declaration: a redeclared
    // `export const STREAM_CREDIT_ADJUST_MAX = 50` satisfies the line above today and still drifts
    // the day STAFF_CREDIT_MAX moves, so the module's own source is read for the binding's shape.
    const src = await readFile(new URL("../admin-stream-credits.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export\s*\{\s*STAFF_CREDIT_MAX as STREAM_CREDIT_ADJUST_MAX\s*\}\s*from\s*"@\/server\/usecases\/stream-credits"/);
    expect(src, "the ceiling must be re-exported, never redeclared").not.toMatch(/const\s+STREAM_CREDIT_ADJUST_MAX/);
  });
});
