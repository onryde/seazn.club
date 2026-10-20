// GET /o/[orgSlug]/settings/credits/stream.csv — the Streaming history export. Real Postgres; skipped without
// DATABASE_URL. The REAL `requireBillingPage` runs (members and the group's payer admitted, everyone else 404), over
// a real ledger written by real writers.
//
//   E1 one page only     export a single reader page (limit) instead of paging to the end → "exports EVERY row, past one page"
//   E2 org scope         pass another org's id to the reader                               → "another org's rows are never in the file"
//   E3 gate              swap requireBillingPage for requireOrgPage                         → "the group's payer, not a member, may export"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { User } from "@/lib/types";

vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => ({ count: 1, ttlMs: 60_000 }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  permanentRedirect: (to: string) => { throw new Error(`PERMANENT_REDIRECT:${to}`); },
}));
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: async () => (authState.userId ? ({ id: authState.userId } as User) : null),
    getActiveOrgId: async () => null,
  };
});

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recordPurchase } from "@/server/usecases/stream-credits";
import { STREAM_HISTORY_MAX_LIMIT } from "@/server/usecases/stream-credit-history";
import { STREAM_HISTORY_CSV_HEADER } from "@/server/usecases/stream-credit-history-csv";
import { GET } from "../stream.csv/route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(label: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`stream-csv-${label}-${uniq()}@test.local`}, ${label}, true) returning id`;
  return row!.id;
}
async function makeClub(): Promise<{ ownerId: string; orgId: string; orgSlug: string }> {
  const ownerId = await makeUser("Owner");
  const org = await createOrgForUser(ownerId, `Stream CSV ${uniq()}`);
  const [row] = await sql<{ slug: string }[]>`select slug from organizations where id = ${org.id}`;
  return { ownerId, orgId: org.id, orgSlug: row!.slug };
}
const get = (orgSlug: string) => GET(new Request("http://test/x"), { params: Promise.resolve({ orgSlug }) });

describe.skipIf(!HAS_DB)("GET settings/credits/stream.csv", () => {
  beforeEach(() => { authState.userId = ""; });

  it("a member gets the file: CSV headers, the stable header row, and one line per ledger row, newest first — only THIS org's (E2)", async () => {
    const club = await makeClub();
    const other = await makeClub();
    await recordPurchase({ orgId: club.orgId, delta: 5, stripeEventId: `cs_${randomUUID()}` });
    await recordPurchase({ orgId: other.orgId, delta: 9, stripeEventId: `cs_${randomUUID()}` });
    authState.userId = club.ownerId;
    const res = await get(club.orgSlug);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stream-credits.csv"');
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe([...STREAM_HISTORY_CSV_HEADER].join(","));
    expect(lines.slice(1).map((l) => l.split(",").slice(1))).toEqual([["packPurchase", "5", "5", "", ""]]);
  });

  it("an org with an empty ledger exports the header alone", async () => {
    const club = await makeClub();
    authState.userId = club.ownerId;
    expect(await (await get(club.orgSlug)).text()).toBe([...STREAM_HISTORY_CSV_HEADER].join(","));
  });

  it("exports EVERY row, past one reader page (E1) — the file is not silently a page long", async () => {
    const club = await makeClub();
    const n = STREAM_HISTORY_MAX_LIMIT + 5;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, created_at)
      select ${club.orgId}, 1, 'purchase', 'pack', g + 1, now() - interval '1 day' + g * interval '1 second' from generate_series(0, ${n - 1}) g`;
    authState.userId = club.ownerId;
    const lines = (await (await get(club.orgSlug)).text()).split("\r\n");
    expect(lines).toHaveLength(n + 1);
    // newest first across the page seam: the balance column counts down from n to 1
    expect(lines.slice(1).map((l) => Number(l.split(",")[3]))).toEqual(Array.from({ length: n }, (_, i) => n - i));
  });

  it("the group's payer who is NOT a member may export (E3); a stranger is a 404; a signed-out visitor goes to /login", async () => {
    const club = await makeClub();
    await recordPurchase({ orgId: club.orgId, delta: 2, stripeEventId: `cs_${randomUUID()}` });
    const payerId = await makeUser("Payer");
    const payerOrg = await createOrgForUser(payerId, `Payer Org ${uniq()}`);
    const groupId = await setOrgPlan(payerOrg.id, "pro");
    await sql`update subscriptions set owner_user_id = ${payerId} where id = ${groupId}`;
    await sql`update organizations set subscription_id = ${groupId} where id = ${club.orgId}`;
    const [member] = await sql`select 1 from org_members where org_id = ${club.orgId} and user_id = ${payerId}`;
    expect(member, "premise: the payer is not a member of the club").toBeUndefined();

    authState.userId = payerId;
    const ok = await get(club.orgSlug);
    expect(ok.status).toBe(200);
    expect((await ok.text()).split("\r\n")).toHaveLength(2);

    authState.userId = await makeUser("Stranger");
    await expect(get(club.orgSlug)).rejects.toThrow("NOT_FOUND");

    authState.userId = "";
    await expect(get(club.orgSlug)).rejects.toThrow("REDIRECT:/login");
  });
});
