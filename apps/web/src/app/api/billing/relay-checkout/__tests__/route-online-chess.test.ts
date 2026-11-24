// POST /api/billing/relay-checkout — the Online Chess half (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §7.6,
// §8.4; plan Task 10): a pack can be bought from a DIVISION, and by an org that is offered Online Chess but not phone streaming.
// DB-backed (skipped without DATABASE_URL): the org, its competition and its divisions are made through the REAL doors
// (`_oc-rig`), the entitlement gates run the real `hasFeature` over real override rows, the role is the real `org_members` row.
// Doubled: `requireUser` and `requireBillingOwner` (the cookie-resolved caller), `createRelayCheckout` (the Stripe call — NOTHING
// here touches Stripe, and billing is only ever tested against the sandbox), the buyer's currency, and the PostHog flag
// (`onlineChessOffered`, the one switch the cases below move; the vitest environment forces it ON for everyone, which would make
// every refusal here unreachable).
//
// Expected values come from the spec and the brief, typed here: the success URL's shape and the five sizes of the ladder are
// literals in this file, never read back from the route, `routes.ts` or the price leaf.
//
// Mutant table (each run once by hand; results in the commit message):
//   O1 chess gate        the Online Chess arm of the gate deleted (streaming refusals unconditional)  -> "streaming off + Online Chess offered sells"
//   O2 flag always asked ask the flag BEFORE the streaming gates                                       -> "the flag is not asked when streaming already admits"
//   O3 org of the division  drop `and o.id = ${orgId}` from the division lookup                         -> "a division of another org is a 404"
//   O4 organiser         delete the role check                                                          -> "a viewer and a payer who is no member are refused"
//   O5 landing           drop `&oc=pay`, reorder the params, or build the return from the body's slug   -> "returnTo division builds the division's own URL"
//   O6 size              `size` accepted as any number, or appended without the ladder                  -> "size comes only from the ladder"
//   O7 one return        the schema accepts divisionId beside fixtureId / returnTo settings             -> "exactly one return is named"
//   O8 competition scope read the gates for the org instead of the division's competition               -> "…and the gates read the division's competition"
//   O12 division flag    delete the division arm's own flag gate (streaming admitting is enough)         -> "the division return is behind the Online Chess flag, whatever streaming says"
//   O13 flag asked twice drop `chessOffered = true` (the streaming gates ask the flag again)             -> same test (asked once per request)
//   O14 flag only on refusal  the division arm's gate runs only when streaming refuses (the pre-fix shape) -> same test (flag off + streaming admits is 403)
import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { ocCompetition, ocDivision, ocOrg, type Org } from "@/server/usecases/online-package/__tests__/_oc-rig";
import { streamRig } from "@/server/relay/__tests__/_session-rig";

const { requireUserMock, requireBillingOwnerMock, createRelayCheckoutMock, preferredCurrencyMock, chess, featureAsks } = vi.hoisted(() => ({
  requireUserMock: vi.fn<() => Promise<{ id: string; email: string }>>(),
  requireBillingOwnerMock: vi.fn<() => Promise<{ orgId: string; subscriptionId: string }>>(),
  createRelayCheckoutMock: vi.fn(),
  preferredCurrencyMock: vi.fn(),
  /** The Online Chess flag, as the route's gate asks it: the switch, and everyone who asked. */
  chess: { on: false, asked: [] as { orgId: string; userId: string | null }[] },
  /** Every `hasFeature` the route made: org, key, the competition it was scoped to. */
  featureAsks: [] as { orgId: string; key: string; competitionId: string | undefined }[],
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: () => requireUserMock(),
}));
vi.mock("@/server/usecases/billing-manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/billing-manage")>()),
  requireBillingOwner: () => requireBillingOwnerMock(),
}));
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return {
    ...actual,
    hasFeature: (orgId: string, key: string, competitionId?: string) => {
      featureAsks.push({ orgId, key, competitionId });
      return actual.hasFeature(orgId, key, competitionId);
    },
  };
});
vi.mock("@/lib/relay-checkout", async (importOriginal) => ({
  createRelayCheckout: (args: unknown) => createRelayCheckoutMock(args),
  StreamPackPriceDriftError: (await importOriginal<typeof import("@/lib/relay-checkout")>()).StreamPackPriceDriftError,
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: (...args: unknown[]) => preferredCurrencyMock(...args) }));
vi.mock("@/server/usecases/external-play/online-chess-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/external-play/online-chess-flag")>()),
  onlineChessOffered: async (asker: { orgId: string; userId: string | null }) => {
    chess.asked.push({ orgId: asker.orgId, userId: asker.userId });
    return chess.on;
  },
}));

import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
/** The success URL's tail, from the brief: the division's Fixtures tab, the receipt opened, Stripe's own session placeholder. */
const TAIL = "tab=fixtures&oc=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}";
/** The ladder (decision 4): the only sizes `size` may name. Typed from the spec, not from the leaf. */
const LADDER = [16, 32, 64, 128, 256] as const;

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/billing/relay-checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  chess.on = false;
  chess.asked.length = 0;
  featureAsks.length = 0;
  setRelayDriversForTest(null);
});

/** Sign `userId` in as the billing owner of `orgId`; every Stripe call is a no-op that answers a client secret. */
function signIn(orgId: string, userId: string): void {
  requireUserMock.mockReset().mockResolvedValue({ id: userId, email: "buyer@test.local" });
  requireBillingOwnerMock.mockReset().mockResolvedValue({ orgId, subscriptionId: randomUUID() });
  createRelayCheckoutMock.mockReset().mockResolvedValue({ id: "cs_oc", client_secret: "cs_oc_secret_1" });
  preferredCurrencyMock.mockReset().mockResolvedValue("eur");
}

/** A user who is a member of `orgId` with `role`, or a bare user (a billing payer who is no member) when `role` is null. */
async function person(orgId: string, role: "owner" | "admin" | "viewer" | null): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`oc-checkout-${randomUUID().slice(0, 12)}@test.local`}, 'OC Buyer', true) returning id`;
  if (role !== null) await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${id}, ${role})`;
  return id;
}

async function override(orgId: string, key: string, value: boolean): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${key}, ${value}, 'task-10 route test')`;
  await invalidateOrgEntitlements(orgId);
}

interface Scene { o: Org; compId: string; divisionId: string; orgSlug: string; compSlug: string; divSlug: string }
/** An org (a pro owner) with one online division, and the slugs the success URL is built from. */
async function scene(): Promise<Scene> {
  const o = await ocOrg();
  const compId = await ocCompetition(o);
  const d = await ocDivision(o, compId);
  const [s] = await sql<{ orgSlug: string; compSlug: string; divSlug: string }[]>`
    select o.slug as "orgSlug", c.slug as "compSlug", d.slug as "divSlug"
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
     where d.id = ${d.id}`;
  return { o, compId, divisionId: d.id, ...s! };
}

const lastArgs = () => createRelayCheckoutMock.mock.calls.at(-1)![0] as { orgId: string; fixtureId?: string; size: number; returnUrl: string; currency?: string };

describe.skipIf(!HAS_DB)("the checkout gate: phone streaming OR Online Chess (§7.6 'Checkout route')", () => {
  it("streaming off + Online Chess offered sells; neither refuses with the streaming code it always answered; the streaming-first order is unchanged", async () => {
    type Case = { name: string; setup: "relayOff" | "overlayOff" | "noRelayDeployment" | "streamingOn"; chess: boolean; status: number; code?: string };
    const cases: Case[] = [
      { name: "relay switched off, chess on", setup: "relayOff", chess: true, status: 200 },
      { name: "relay switched off, chess off", setup: "relayOff", chess: false, status: 402, code: "plan_lacks_relay" },
      { name: "overlay switched off, chess on", setup: "overlayOff", chess: true, status: 200 },
      { name: "overlay switched off, chess off", setup: "overlayOff", chess: false, status: 402, code: "plan_lacks_overlay" },
      { name: "deployment cannot stream, chess on", setup: "noRelayDeployment", chess: true, status: 200 },
      { name: "deployment cannot stream, chess off", setup: "noRelayDeployment", chess: false, status: 503, code: "ingest_unavailable" },
      { name: "streaming on, chess off", setup: "streamingOn", chess: false, status: 200 },
      { name: "streaming on, chess on", setup: "streamingOn", chess: true, status: 200 },
    ];
    let checked = 0;
    for (const c of cases) {
      const rig = await streamRig();
      if (c.setup === "relayOff") await override(rig.orgId, "streaming.relay", false);
      if (c.setup === "overlayOff") await override(rig.orgId, "streaming.overlay", false);
      const userId = await person(rig.orgId, "owner");
      signIn(rig.orgId, userId);
      chess.on = c.chess;
      chess.asked.length = 0;
      if (c.setup === "noRelayDeployment") setRelayDriversForTest(disabledRelayDrivers());
      try {
        // both ways a pack is bought without a division: from Settings, and from a fixture's Stream panel
        for (const body of [{ orgId: rig.orgId, pack: 5, returnTo: "settings" }, { orgId: rig.orgId, pack: 5, fixtureId: rig.fixtureIds[0]! }]) {
          createRelayCheckoutMock.mockClear();
          const res = await post(body);
          expect([c.name, res.status], c.name).toEqual([c.name, c.status]);
          if (c.code) expect(await res.json(), c.name).toMatchObject({ ok: false, code: c.code });
          expect(createRelayCheckoutMock, `${c.name}: Stripe is reached only by a sale`).toHaveBeenCalledTimes(c.status === 200 ? 1 : 0);
        }
      } finally {
        setRelayDriversForTest(null);
      }
      if (c.setup === "streamingOn") {
        expect(chess.asked, `${c.name}: streaming already admits, so the flag is not asked (no PostHog call on the common path)`).toEqual([]);
      } else {
        // asked only once streaming refused, for the BUYER (the pair PostHog is asked with), once per request
        expect(chess.asked, `${c.name}: asked for the org and the buyer, once per request`).toEqual([
          { orgId: rig.orgId, userId },
          { orgId: rig.orgId, userId },
        ]);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every case was judged").toBe(cases.length);
  });
});

describe.skipIf(!HAS_DB)("returnTo: \"division\" — the division's own page, organisers only (§7.6, §8.4)", () => {
  // The division return is behind the Online Chess flag (the first test below proves it); every other case here is about the
  // return itself, so the flag is on.
  beforeEach(() => { chess.on = true; });

  it("the division return is behind the Online Chess flag, whatever streaming says: flag off is a 403 ONLINE_CHESS_DISABLED before any lookup, streaming on or off; flag on sells; it is asked once", async () => {
    const s = await scene();
    signIn(s.o.orgId, s.o.auth.userId!);
    const body = { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId };
    // a club that streams (the pro org's streaming gates all admit) but is not offered Online Chess
    chess.on = false;
    chess.asked.length = 0;
    let res = await post(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "ONLINE_CHESS_DISABLED" });
    expect(createRelayCheckoutMock, "Stripe is never reached").not.toHaveBeenCalled();
    expect(chess.asked, "asked once, for the org and the buyer").toEqual([{ orgId: s.o.orgId, userId: s.o.auth.userId }]);
    // the same refusal before the division is looked up: an unknown division id is the flag's 403, not a 404
    res = await post({ ...body, divisionId: randomUUID() });
    expect(res.status, "the flag is asked before the division is looked up").toBe(403);
    // …and with streaming switched off too, the answer is the flag's (the new door is Online Chess's), not the streaming refusal
    await override(s.o.orgId, "streaming.relay", false);
    res = await post(body);
    expect([res.status, (await res.json()).code]).toEqual([403, "ONLINE_CHESS_DISABLED"]);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
    // the positive pair: flag on, same body, streaming still off — sells, and the flag was asked once
    chess.on = true;
    chess.asked.length = 0;
    res = await post(body);
    expect(res.status).toBe(200);
    expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);
    expect(chess.asked, "asked once per request even when streaming refused (the gate remembers its answer)").toEqual([{ orgId: s.o.orgId, userId: s.o.auth.userId }]);
  });

  it("builds the division's own URL — Fixtures tab, receipt open, Stripe's session placeholder — and appends `size` only from the ladder", async () => {
    const s = await scene();
    signIn(s.o.orgId, s.o.auth.userId!);
    const base = `/o/${s.orgSlug}/c/${s.compSlug}/d/${s.divSlug}?${TAIL}`;
    expect(s.divSlug, "premise: the slug is not the id, so a URL built from the id cannot pass").not.toContain(s.divisionId);

    const res = await post({ orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { client_secret: "cs_oc_secret_1" } });
    const first = lastArgs();
    expect(first.orgId, "the RESOLVED org").toBe(s.o.orgId);
    expect(first.fixtureId, "a division purchase has no fixture").toBeUndefined();
    expect(first.size, "the PACK (credits), not the division's size").toBe(5);
    expect(first.currency).toBe("eur");
    expect(new URL(first.returnUrl).pathname + new URL(first.returnUrl).search.replaceAll("%7B", "{").replaceAll("%7D", "}")).toBe(base);
    expect(first.returnUrl.endsWith(base), "the whole tail, in order").toBe(true);
    expect(first.returnUrl).not.toContain("size=");

    // the sizes of the ladder ride in the return address (an upgrade's target), each once, last
    let sized = 0;
    for (const size of LADDER) {
      createRelayCheckoutMock.mockClear();
      expect((await post({ orgId: s.o.orgId, pack: 20, returnTo: "division", divisionId: s.divisionId, size })).status).toBe(200);
      expect(lastArgs().returnUrl.endsWith(`${base}&size=${size}`), `size ${size}`).toBe(true);
      sized += 1;
    }
    expect(sized).toBe(LADDER.length);

    // a second checkout from the same division is the same shape (nothing is kept between returns), and another division of
    // the same org lands on ITS page
    createRelayCheckoutMock.mockClear();
    expect((await post({ orgId: s.o.orgId, pack: 1, returnTo: "division", divisionId: s.divisionId })).status).toBe(200);
    expect(lastArgs().returnUrl.endsWith(base)).toBe(true);
    const second = await ocDivision(s.o, s.compId);
    const [two] = await sql<{ slug: string }[]>`select slug from divisions where id = ${second.id}`;
    expect(two!.slug, "premise: a different division has a different slug").not.toBe(s.divSlug);
    createRelayCheckoutMock.mockClear();
    expect((await post({ orgId: s.o.orgId, pack: 1, returnTo: "division", divisionId: second.id })).status).toBe(200);
    expect(lastArgs().returnUrl.endsWith(`/o/${s.orgSlug}/c/${s.compSlug}/d/${two!.slug}?${TAIL}`)).toBe(true);
  });

  it("a division of another org is a 404 and opens nothing — the ownership check is the org in the body, resolved by the caller (never a redirect to someone else's page)", async () => {
    const mine = await scene();
    const theirs = await scene();
    signIn(mine.o.orgId, mine.o.auth.userId!);
    let checked = 0;
    for (const divisionId of [theirs.divisionId, randomUUID()]) {
      const res = await post({ orgId: mine.o.orgId, pack: 5, returnTo: "division", divisionId });
      expect([divisionId === theirs.divisionId ? "another org's" : "unknown", res.status]).toEqual([divisionId === theirs.divisionId ? "another org's" : "unknown", 404]);
      expect(createRelayCheckoutMock).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(2);
    // the positive pair: the same caller, their own division
    expect((await post({ orgId: mine.o.orgId, pack: 5, returnTo: "division", divisionId: mine.divisionId })).status).toBe(200);
    expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);
    // and naming the OTHER org in the body is still a 400, whatever division it carries
    createRelayCheckoutMock.mockClear();
    expect((await post({ orgId: theirs.o.orgId, pack: 5, returnTo: "division", divisionId: theirs.divisionId })).status).toBe(400);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("only an organiser of the division's org may start it — a viewer and a payer who is no member are refused (403, before Stripe); an owner and an admin sell", async () => {
    const s = await scene();
    const body = { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId };
    const roles = [
      { who: "owner", role: "owner" as const, status: 200 },
      { who: "admin", role: "admin" as const, status: 200 },
      { who: "viewer", role: "viewer" as const, status: 403 },
      { who: "a payer who is no member", role: null, status: 403 },
    ];
    let checked = 0;
    for (const r of roles) {
      signIn(s.o.orgId, await person(s.o.orgId, r.role));
      const res = await post(body);
      expect([r.who, res.status]).toEqual([r.who, r.status]);
      expect(createRelayCheckoutMock, r.who).toHaveBeenCalledTimes(r.status === 200 ? 1 : 0);
      checked += 1;
    }
    expect(checked).toBe(roles.length);
  });

  it("size comes only from the ladder — 0, 8, 48, 512, a string, a float and null are 400 and open nothing", async () => {
    const s = await scene();
    signIn(s.o.orgId, s.o.auth.userId!);
    const bad: unknown[] = [0, 8, 15, 17, 48, 255, 257, 512, -16, 16.5, "64", "16", null, true];
    let checked = 0;
    for (const size of bad) {
      const res = await post({ orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId, size });
      expect([JSON.stringify(size), res.status]).toEqual([JSON.stringify(size), 400]);
      checked += 1;
    }
    expect(checked).toBe(bad.length);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
    // the positive pair: the same body with a size ON the ladder opens a checkout, so the 400s above are the size's doing
    expect((await post({ orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId, size: 64 })).status).toBe(200);
    expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);
  });

  it("exactly one return is named — a division id beside a fixture or `settings`, a division return without its division, and `size` on any other return are 400", async () => {
    const s = await scene();
    signIn(s.o.orgId, s.o.auth.userId!);
    const rig = await streamRig();
    const bodies: Record<string, unknown>[] = [
      { orgId: s.o.orgId, pack: 5, returnTo: "division" },
      { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: "not-a-uuid" },
      { orgId: s.o.orgId, pack: 5, returnTo: "settings", divisionId: s.divisionId },
      { orgId: s.o.orgId, pack: 5, fixtureId: rig.fixtureIds[0]!, divisionId: s.divisionId },
      { orgId: s.o.orgId, pack: 5, fixtureId: rig.fixtureIds[0]!, returnTo: "division", divisionId: s.divisionId },
      { orgId: s.o.orgId, pack: 5, returnTo: "settings", size: 64 },
      { orgId: s.o.orgId, pack: 5, fixtureId: rig.fixtureIds[0]!, size: 64 },
      { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId, credits: 500 },
      { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId, returnUrl: "https://example.test/x" },
    ];
    let checked = 0;
    for (const body of bodies) {
      const res = await post(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      checked += 1;
    }
    expect(checked).toBe(bodies.length);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("the division return meets the streaming gates only to lift them: streaming off and Online Chess offered sells — and the gates read the division's competition", async () => {
    const s = await scene();
    await override(s.o.orgId, "streaming.relay", false);
    signIn(s.o.orgId, s.o.auth.userId!);
    const body = { orgId: s.o.orgId, pack: 5, returnTo: "division", divisionId: s.divisionId };
    expect((await post(body)).status).toBe(200);
    expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);

    // O8: the gates read the DIVISION'S competition (an Event Pass grants for the competition it was bought for), exactly as the
    // fixture arm reads its fixture's — the asks the route made name it, for both streaming keys.
    featureAsks.length = 0;
    expect((await post(body)).status).toBe(200);
    const streaming = featureAsks.filter((a) => a.key === "streaming.overlay" || a.key === "streaming.relay");
    expect(streaming.map((a) => a.key).sort()).toEqual(["streaming.overlay", "streaming.relay"]);
    for (const a of streaming) expect([a.key, a.orgId, a.competitionId]).toEqual([a.key, s.o.orgId, s.compId]);
  });
});
