// The Streaming screenshots' ledger (e2e/helpers/stream-history-seed.ts) is hand-written SQL imitating writers a browser
// cannot reach. This runs it against a real database and reads it back through the REAL history reader, so a seed that
// violates a constraint, or lands on a kind other than the one it claims, fails here (with a stack) instead of in a CI
// browser run with nothing but a screenshot to read. Real Postgres; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { listAllStreamCreditHistory, listStreamCreditHistory, STREAM_HISTORY_DEFAULT_LIMIT } from "../stream-credit-history";
import { seedStreamHistory } from "../../../../e2e/helpers/stream-history-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const auth = (orgId: string): AuthCtx => ({ orgId, via: "session", userId: null, role: "owner", keyId: null });

describe.skipIf(!HAS_DB)("the e2e history seed", () => {
  it("writes exactly the rows it reports, and the reader shows every curated kind, newest first, with its fixture where one belongs", async () => {
    const r = await streamRig();
    const seed = await seedStreamHistory(sql, { orgId: r.orgId, ownerId: r.createdBy, fixtureId: r.fixtureIds[0]! });
    const all = await listAllStreamCreditHistory(auth(r.orgId), r.orgId);
    expect(all).toHaveLength(seed.rows);
    expect(seed.rows).toBe(seed.bulk + seed.curatedKinds.length);
    expect(all.slice(0, seed.curatedKinds.length).map((x) => x.kind)).toEqual([...seed.curatedKinds]);
    expect(all.slice(seed.curatedKinds.length).every((x) => x.kind === "packPurchase" && x.delta === 1)).toBe(true);
    expect(all.slice(seed.curatedKinds.length)).toHaveLength(seed.bulk);
    // no row fell to the neutral label — the seed is photographed as what it says
    expect(all.filter((x) => x.kind === "other")).toEqual([]);

    // the two matches' rows carry the fixture; nothing else does
    const withFixture = all.filter((x) => x.fixture !== null).map((x) => x.kind);
    expect(withFixture).toEqual(["streamUsed", "refundNoCamera", "streamUsed"]);

    // the balance chain is coherent end to end, and ends where the seed says
    expect(all[0]!.balanceAfter).toBe(seed.balance);
    for (let i = 0; i < all.length - 1; i++) {
      expect(all[i]!.balanceAfter, `row ${i}`).toBe(all[i + 1]!.balanceAfter + all[i]!.delta);
    }
    const [total] = await sql<{ n: number }[]>`select sum(delta)::int as n from org_stream_credits where org_id = ${r.orgId}`;
    expect(total!.n).toBe(seed.balance);
  });

  it("is entirely before the current UTC month — it never touches this month's free-credit meter — and runs past one page", async () => {
    const r = await streamRig();
    const seed = await seedStreamHistory(sql, { orgId: r.orgId, ownerId: r.createdBy, fixtureId: r.fixtureIds[0]! });
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_stream_credits
       where org_id = ${r.orgId} and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
    expect(n).toBe(0);
    expect(seed.rows, "the seed alone pages (the page's own grant makes it one more)").toBeGreaterThan(STREAM_HISTORY_DEFAULT_LIMIT);
    const first = await listStreamCreditHistory(auth(r.orgId), r.orgId, {});
    expect(first.rows).toHaveLength(STREAM_HISTORY_DEFAULT_LIMIT);
    expect(first.nextCursor).not.toBeNull();
  });
});
