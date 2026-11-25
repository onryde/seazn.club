// Online Chess credits Task 5 — GET and POST /divisions/{id}/online-package over HTTP: the wire shapes (each response parsed by
// its own zod contract, the one the served OpenAPI is derived from), who may call, the strict body, and that every refusal
// carries its code and writes nothing. The usecase's own behaviour (every money case) is online-package/__tests__/pay.test.ts's.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
// PostHog answers OFF; ONLINE_CHESS_ALWAYS=1 (beforeAll) is what offers Online Chess here.
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { ONLINE_MAX_OWED, OnlinePackagePayInput, OnlinePackagePayResult, OnlinePackageQuote } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { recordPurchase } from "@/server/usecases/stream-credits";
import { GET as quoteRoute, POST as payRoute } from "@/app/api/v1/divisions/[id]/online-package/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;
/** Global Constraints: 32 → 2 credits and 64 → 4 without cameras; 32 → 4 with. */
const PRICE = { 32: 2, 64: 4, cams32: 4 } as const;

beforeAll(() => {
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
beforeEach(() => {
  authState.userId = "";
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string; [k: string]: unknown } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
const get = (divisionId: string, query: string, headers: Record<string, string> = {}) =>
  quoteRoute(new Request(`https://test.local/api/v1/divisions/${divisionId}/online-package?${query}`, { headers }), ctx(divisionId));
const post = (divisionId: string, body: unknown, headers: Record<string, string> = {}) =>
  payRoute(
    new Request(`https://test.local/api/v1/divisions/${divisionId}/online-package`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(divisionId),
  );

interface Rig { orgId: string; ownerId: string; divisionId: string; packageId: string }

/** A pro org, its owner, one online chess division with its UNPAID package at 32, and `pack` bought credits. */
async function rig(pack = 10): Promise<Rig> {
  const s = suffix();
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"OC Route " + s}, ${"oc-route-" + s}) returning id`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${`owner-${s}@t.local`}, 'Owner', true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
  await setOrgPlan(org!.id, "pro");
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility) values (${org!.id}, ${"OC Route " + s}, ${"oc-route-" + s}, 'private') returning id`;
  const name = `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${c!.id}, ${name}, ${"oc-route-" + s}, 'boardgame', 'classical', ${sql.json({ onlinePlay: "lichess" } as never)}, '1.0.0') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into division_online_packages (org_id, division_id, division_name, size) values (${org!.id}, ${d!.id}, ${name}, 32) returning id`;
  if (pack > 0) {
    const cs = `cs_ocroute_${s}`;
    await recordPurchase({
      orgId: org!.id, delta: pack, stripeEventId: cs,
      link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: `seazn_stream_pack_${pack}`, amountMinor: 600, currency: "gbp" },
    });
  }
  return { orgId: org!.id, ownerId: user!.id, divisionId: d!.id, packageId: p!.id };
}

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${suffix()}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

/** Everything a payment could write: the org's ledger rows and the package row's money columns. */
async function written(r: Rig) {
  const [l] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
  const [p] = await sql<{ size: number; credits_paid: number; paid_at: Date | null }[]>`
    select size, credits_paid, paid_at from division_online_packages where id = ${r.packageId}`;
  return { ledger: l!.n, row: p! };
}

/** Global Constraints' price table (without / with cameras), typed here: the bound's oracle. */
const GC_PRICE: Record<number, readonly [number, number]> = { 16: [1, 2], 32: [2, 4], 64: [4, 8], 128: [8, 16], 256: [16, 32] };

describe("OnlinePackagePayInput: the expectedOwed bound", () => {
  it("is the dearest package's price, and every total a payment can owe — any first payment, any change between two states — is inside it", () => {
    expect(ONLINE_MAX_OWED, "256 with cameras, the Global Constraints' dearest cell").toBe(32);
    const states = Object.entries(GC_PRICE).flatMap(([size, [without, withCams]]) => [
      { size: Number(size), cameras: false, price: without },
      { size: Number(size), cameras: true, price: withCams },
    ]);
    let checked = 0;
    for (const to of states) {
      // A first payment owes the whole price.
      expect(OnlinePackagePayInput.safeParse({ size: to.size, expectedOwed: to.price }).success, `first payment ${to.size}/${to.cameras}`).toBe(true);
      checked += 1;
      // A paid package holds its own price of value (§7.1); a change owes the difference, cameras never lowered (P19).
      for (const from of states) {
        const target = GC_PRICE[to.size]![from.cameras || to.cameras ? 1 : 0]!;
        const owed = target - from.price;
        expect(OnlinePackagePayInput.safeParse({ size: to.size, expectedOwed: owed }).success, `${from.size}/${from.cameras} → ${to.size}/${to.cameras}: ${owed}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "first payments and changes").toBe(10 + 100);
    for (const outside of [ONLINE_MAX_OWED + 1, -ONLINE_MAX_OWED - 1]) {
      expect(OnlinePackagePayInput.safeParse({ size: 256, expectedOwed: outside }).success, `${outside}`).toBe(false);
    }
  });
});

describe.skipIf(!HAS_DB)("GET and POST /divisions/{id}/online-package", () => {
  it("the organiser reads the quote, pays it, and a second press writes nothing: each answer is its contract's shape", async () => {
    const r = await rig();
    authState.userId = r.ownerId;
    const q = await read(await get(r.divisionId, "size=32"));
    expect(q.status).toBe(200);
    const quote = OnlinePackageQuote.parse(q.body.data);
    expect(quote).toMatchObject({ size: 32, cameras: false, price: PRICE[32], owed: PRICE[32], refusal: null });
    const paid = await read(await post(r.divisionId, { size: 32, expectedOwed: quote.owed }));
    expect(paid.status).toBe(200);
    const result = OnlinePackagePayResult.parse(paid.body.data);
    expect(result).toMatchObject({ applied: true, capacityLoweredTo: null, package: { id: r.packageId, size: 32, creditsPaid: PRICE[32], paidBy: r.ownerId } });
    expect(result.package.paidAt, "a timestamp on the wire").toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await read(await post(r.divisionId, { size: 32, expectedOwed: quote.owed }));
    expect(again.status).toBe(200);
    expect(OnlinePackagePayResult.parse(again.body.data).applied).toBe(false);
    expect((await written(r)).row.credits_paid, "one debit").toBe(PRICE[32]);
    // The camera answer over the query string (Task 15): Yes prices the camera, No over a package paid without it owes nothing.
    const cams = await read(await get(r.divisionId, "size=32&cameras=true"));
    expect(OnlinePackageQuote.parse(cams.body.data)).toMatchObject({ cameras: true, owed: PRICE.cams32 - PRICE[32] });
    const no = await read(await get(r.divisionId, "size=32&cameras=false"));
    expect(OnlinePackageQuote.parse(no.body.data)).toMatchObject({ cameras: false, owed: 0 });
  });

  it("a stale total is 409 ONLINE_QUOTE_CHANGED carrying the fresh quote; a short balance is 402 ONLINE_CHESS_NO_CREDITS with owed and balance", async () => {
    const r = await rig();
    authState.userId = r.ownerId;
    const stale = await read(await post(r.divisionId, { size: 64, expectedOwed: 3 }));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("ONLINE_QUOTE_CHANGED");
    expect(OnlinePackageQuote.parse(stale.body.error?.quote)).toMatchObject({ size: 64, owed: PRICE[64] });
    expect((await written(r)).row.paid_at).toBeNull();
    const poor = await rig(0);
    authState.userId = poor.ownerId;
    const owed = OnlinePackageQuote.parse((await read(await get(poor.divisionId, "size=256"))).body.data);
    expect(owed.owed).toBe(16);
    const short = await read(await post(poor.divisionId, { size: 256, expectedOwed: owed.owed }));
    expect(short.status).toBe(402);
    expect(short.body.error?.code).toBe("ONLINE_CHESS_NO_CREDITS");
    expect(short.body.error).toMatchObject({ owed: 16, balance: owed.balance });
    expect(await written(poor), "nothing written, not even the month's grant").toMatchObject({ ledger: 0, row: { paid_at: null } });
  });

  it("the body is strict: the retired `addCameras`, an off-ladder size, a negative or fractional figure, a missing total — 400, nothing written", async () => {
    const r = await rig();
    authState.userId = r.ownerId;
    const bodies: [string, unknown][] = [
      ["a body carrying the retired `addCameras`", { size: 32, expectedOwed: PRICE[32], addCameras: true }],
      ["an off-ladder size", { size: 20, expectedOwed: PRICE[32] }],
      ["a size as a string", { size: "32", expectedOwed: PRICE[32] }],
      ["a negative expectedForfeited", { size: 32, expectedOwed: PRICE[32], expectedForfeited: -1 }],
      ["a fractional expectedOwed", { size: 32, expectedOwed: 1.5 }],
      ["no expectedOwed", { size: 32 }],
      ["cameras not a boolean", { size: 32, expectedOwed: PRICE[32], cameras: "yes" }],
      ["an expectedOwed above the dearest package", { size: 256, expectedOwed: 33 }],
      ["an expectedOwed below minus the dearest package", { size: 16, expectedOwed: -33 }],
    ];
    for (const [label, body] of bodies) {
      const res = await read(await post(r.divisionId, body));
      expect(res.status, label).toBe(400);
      expect(res.body.error?.code, label).toBe("VALIDATION");
    }
    const queries = ["size=20", "", "size=abc", "size=32&cameras=yes"];
    for (const q of queries) expect((await get(r.divisionId, q)).status, `?${q}`).toBe(400);
    expect(await written(r)).toMatchObject({ ledger: 1, row: { credits_paid: 0, paid_at: null } });
    expect(bodies.length + queries.length, "bad requests").toBe(13);
    // The positive pair: the same body with the answer as a boolean pays.
    expect((await post(r.divisionId, { size: 32, expectedOwed: PRICE[32], cameras: false })).status).toBe(200);
  });

  it("organisers only: a viewer and a stranger are refused on both doors and write nothing; an admin pays", async () => {
    const r = await rig();
    const stranger = await rig();
    const callers: [string, string, number][] = [
      ["viewer", await member(r.orgId, "viewer"), 403],
      ["another org's owner", stranger.ownerId, 401],
    ];
    for (const [label, userId, status] of callers) {
      authState.userId = userId;
      expect((await get(r.divisionId, "size=32")).status, `${label}: GET`).toBe(status);
      expect((await post(r.divisionId, { size: 32, expectedOwed: PRICE[32] })).status, `${label}: POST`).toBe(status);
    }
    expect(await written(r)).toMatchObject({ ledger: 1, row: { paid_at: null } });
    authState.userId = await member(r.orgId, "admin");
    expect((await get(r.divisionId, "size=32")).status).toBe(200);
    const paid = await read(await post(r.divisionId, { size: 32, expectedOwed: PRICE[32] }));
    expect(paid.status).toBe(200);
    expect(OnlinePackagePayResult.parse(paid.body.data).package.paidBy, "the admin who paid").toBe(authState.userId);
  });

  it("an admin whose seat is frozen (over the plan's member limit) is 402 members.max on both doors and pays nothing", async () => {
    // The route's WRITE scope is what refuses a frozen seat (doc 10 §2.4: an over-quota admin is read-only); the usecase's own
    // role check passes an admin, so this case is the only witness of the route's scope.
    const r = await rig();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value) values (${r.orgId}, 'members.max', 1)
      on conflict (org_id, feature_key) do update set int_value = 1, bool_value = null`;
    await invalidateOrgEntitlements(r.orgId);
    authState.userId = await member(r.orgId, "admin");
    for (const res of [await read(await get(r.divisionId, "size=32")), await read(await post(r.divisionId, { size: 32, expectedOwed: PRICE[32] }))]) {
      expect(res.status).toBe(402);
      expect(res.body.error?.code).toBe("PAYMENT_REQUIRED");
      expect(res.body.error?.feature_key).toBe("members.max");
    }
    expect(await written(r)).toMatchObject({ ledger: 1, row: { paid_at: null } });
    // The positive pair: the owner's seat is never frozen.
    authState.userId = r.ownerId;
    expect((await post(r.divisionId, { size: 32, expectedOwed: PRICE[32] })).status).toBe(200);
  });

  it("an API key with manage scope is refused on both doors (NEVER_KEY_ROUTES), and nothing is written", async () => {
    const r = await rig();
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'online-package route') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const owner = { orgId: r.orgId, via: "session" as const, userId: r.ownerId, role: "owner" as const, keyId: null };
    const { secret } = await createApiKey(owner, { name: `op-${suffix().slice(0, 6)}`, scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    for (const res of [await read(await get(r.divisionId, "size=32", bearer)), await read(await post(r.divisionId, { size: 32, expectedOwed: PRICE[32] }, bearer))]) {
      expect(res.status).toBe(403);
      expect(res.body.error?.message).toMatch(/cannot access this endpoint/);
    }
    expect(await written(r)).toMatchObject({ ledger: 1, row: { paid_at: null } });
  });
});
