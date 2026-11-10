// Sponsor deals, Task 9 (plan 2026-11-07-sponsor-deals D5, D20, F1, F2, F3, F7, F19; spec §5.2, §5.3, §8a): the hourly sweep
// that ends a deal whose `ends_at` has passed (live OR open), ends a deal (live OR open: §8a says "a deal") scoped to a
// finished competition, and promotes the sponsor's next scheduled deal — over real Postgres, driven through the REAL producers (`createDeal`, `markDealPaid`,
// `sendDealInvoice`) and read back through the REAL consumer (`resolveSponsors`, the public strip).
//
// What is under test, and where each expected value comes from:
//   - the spec's rules, typed BELOW from §5.2 / §8a / F19 (never read back from the sweep): `ends_at` reached → ended
//     `expired`; a competition-scoped deal with NO `ends_at` ends when the competition's derived phase is `finished`
//     (`competition_finished`), by phase and never by the competition's stored date, whether it is live or still waiting to go
//     live (I1, controller ruling: an open deal's pay link must not outlive its competition); an open deal (draft, awaiting
//     payment or approval, scheduled) past its `ends_at` is ended too; a scheduled deal past its own `ends_at` is NEVER
//     promoted, by the sweep or by any other writer that ends the live deal (m1);
//   - the tier a promoted deal puts on its sponsor comes from the PACKAGE the test chose (partner then silver), not from a
//     constant in the sweep;
//   - Stripe is stubbed (`retrieve`, `expire`): the session rule is D14 / F3 / F37 — retrieve, expire only when open, a
//     completed session carried on over, a session that cannot be read or expired leaves the deal for the next run (`failed`);
//   - anti-vacuity: every non-empty case pins `checked` to the number of live and open deals it seeded, so a sweep that
//     examined nothing is a failure; the EMPTY case is the subject of its own test and is followed by the one that is not;
//   - the empty inputs: no deals, an org whose timezone is NULL (V305 allows it; every org here has none), a competition with
//     0 divisions (`setting_up` forever: a deal scoped to it never ends by phase, pinned so a change is a decision), a second
//     call (a no-op), a sweep scoped to no org.
// "Another sport" is not applicable (sponsors read no sport key); the substitute is the competition's own state: finished, in
// progress, and no divisions at all.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_test" })) }));
// `deferred` is Next's `after()`: here a queue the test flushes itself, so "a bust was deferred" is observable, not a race.
const h = vi.hoisted(() => ({ tails: [] as (() => Promise<unknown>)[], fired: [] as string[], deskFault: false, hook: null as null | ((competitionId?: string) => Promise<void>) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    h.tails.push(task);
  },
}));
vi.mock("@/server/public-site/revalidate", async (orig) => ({
  ...(await orig<typeof import("@/server/public-site/revalidate")>()),
  fireOrgRevalidate: (slug: string) => {
    h.fired.push(slug);
  },
}));

// The competition desk is the real one, except while `deskFault` is set: then it throws, which is how a competition nobody can
// read reaches the sweep.
vi.mock("../competition-desk", async (orig) => {
  const real = await orig<typeof import("../competition-desk")>();
  return {
    ...real,
    getCompetitionDesk: async (...args: Parameters<typeof real.getCompetitionDesk>) => {
      if (h.deskFault) throw new Error("the desk cannot be read");
      const desk = await real.getCompetitionDesk(...args);
      await h.hook?.(args[1]); // "another writer acts between the sweep's read and its lock", when a test sets one
      return desk;
    },
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import { resolveSponsors } from "../sponsors";
import { competitionPhase, getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createDeal, endDealNow, finishedPackageCompetitions, markDealPaid, sweepSponsorDeals, type CreateDealInput } from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const ORIGIN = "https://sweep.test";
const MINUTE = 60_000;
const DAY = 86_400_000;
/** The sweep's answer when it found nothing to do: the keys and their order are the brief's interface. */
const NOTHING = { checked: 0, expired: 0, finished: 0, promoted: 0, failed: 0 };

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

beforeEach(() => {
  stubOutboxEnv();
  h.tails.length = 0;
  h.fired.length = 0;
  h.deskFault = false;
  h.hook = null;
  stripe.create.mockReset().mockImplementation(async () => ({
    id: `cs_${uniq()}`,
    url: `https://checkout.stripe.test/${uniq()}`,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
  }));
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => {
    await h.hook?.();
    return { id, status: "open" };
  });
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Org {
  orgId: string;
  slug: string;
  auth: AuthCtx;
}

/** A Pro org with a Connect account that can take charges (online deals), edited by a real user. Its timezone is NULL. */
async function org(): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`sweep-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const slug = `sweep-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Sweep ${s}`}, ${slug}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, slug, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

async function pkg(o: Org, tier: "partner" | "silver" = "partner"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${o.orgId}, ${`Pkg ${uniq()}`}, 25000, 'gbp', ${tier})
    returning id`;
  return row!.id;
}

/** A no-deal sponsor, live by hand (what "add a sponsor" leaves). */
async function sponsor(o: Org): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${`Acme ${uniq()}`}, 'partner', 'active') returning id`;
  return row!.id;
}

const input = (packageId: string, over: Partial<CreateDealInput> = {}): CreateDealInput => ({
  package_id: packageId,
  competition_id: null,
  payment_method: "complimentary",
  go_live: "immediate",
  sponsor_email: null,
  ends_on: null,
  end_current: false,
  ...over,
});

/** A deal through the real create. Complimentary + Straight away is live at once (or `scheduled` behind a live deal). */
async function deal(o: Org, sponsorId: string, packageId: string, over: Partial<CreateDealInput> = {}): Promise<string> {
  return (await createDeal(o.auth, sponsorId, input(packageId, over), ORIGIN)).deal.id;
}

/** An online When-paid deal through the real create: it sends its invoice, so it holds a Checkout session. */
async function onlineDeal(o: Org, sponsorId: string, packageId: string, over: Partial<CreateDealInput> = {}): Promise<string> {
  return deal(o, sponsorId, packageId, { payment_method: "online", go_live: "on_payment", sponsor_email: `pay-${uniq()}@test.local`, ...over });
}

/** The end date can only be set in the future through the API (422 `ends_on_in_past`), so the past is seeded in SQL. */
const endsAt = async (id: string, at: Date | null) => {
  await sql`update sponsor_orders set ends_at = ${at} where id = ${id}`;
};

interface DealRow {
  deal_status: string;
  ended_reason: string | null;
  ended_at: Date | null;
  live_at: Date | null;
  checkout_session_id: string | null;
  payment_status: string;
}
const row = async (id: string): Promise<DealRow> =>
  (await sql<DealRow[]>`
    select deal_status, ended_reason, ended_at, live_at, checkout_session_id, status as payment_status
      from sponsor_orders where id = ${id}`)[0]!;
const sponsorOf = async (id: string) =>
  (await sql<{ status: string; tier: string; competition_id: string | null }[]>`
    select status, tier, competition_id from sponsors where id = ${id}`)[0]!;
const bytes = async (id: string): Promise<string> =>
  (await sql<{ r: string }[]>`select to_jsonb(d)::text as r from sponsor_orders d where d.id = ${id}`)[0]!.r;
const sessionOf = async (id: string): Promise<string | null> => (await row(id)).checkout_session_id;
/** On the public strip (the org-wide read every public page makes). */
const listed = async (o: Org, sponsorId: string, competitionId?: string): Promise<boolean> =>
  (await resolveSponsors(o.orgId, competitionId)).some((s) => s.id === sponsorId);
/** Run the tail work `deferred` queued (the sweep's public-page bust), in order. */
const flushTails = async () => {
  const run = h.tails.splice(0);
  for (const t of run) await t();
};

type Phase = "finished" | "in_progress" | "no_divisions";
/** A competition in a known derived phase, built the way competition-desk.test.ts builds one (a real league whose fixtures are
 *  stored decided, or still scheduled). The phase is ASKED OF THE DESK here, so a rig that stopped producing the phase it is
 *  named for fails at its source, not as a vacuous sweep result. */
async function competition(o: Org, phase: Phase): Promise<string> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const comp = await createCompetition(o.auth, { ends_on: "2030-12-31", name: `Sweep Cup ${uniq()}`, visibility: "private", branding: {} });
  if (phase !== "no_divisions") {
    const division = await createDivision(o.auth, comp.id, {
      name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
    });
    await createEntrants(
      o.auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(o.auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    await generateStageFixtures(o.auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${division.id}`;
    if (phase === "finished") {
      await sql`update fixtures set status = 'decided' where division_id = ${division.id}`;
      await sql`update stages set status = 'complete' where id = ${stage!.id}`;
    }
  }
  const kind = competitionPhase(await getCompetitionDesk(o.auth, comp.id)).kind;
  if (phase === "finished") expect(kind, "the rig's premise: every division is finished").toBe("finished");
  else if (phase === "in_progress") expect(kind, "the rig's premise: a division still has unplayed fixtures").not.toBe("finished");
  else expect(kind, "the rig's premise: a competition with no divisions has not begun").toBe("setting_up");
  return comp.id;
}

/** The sweep over ONE org (the `orgIds` seam: the test DB is shared, so an unscoped count would read other suites' rows). */
const sweep = (o: Org, now = new Date()) => sweepSponsorDeals(now, { orgIds: [o.orgId] });

describe.skipIf(!HAS_DB)("sweepSponsorDeals: the empty case, then the first real one", () => {
  it("empty first: an org with no deals, and one whose only deal has ended, checks nothing", async () => {
    const o = await org();
    expect(await sweep(o), "no deals").toEqual(NOTHING);

    const s = await sponsor(o);
    const id = await deal(o, s, await pkg(o));
    await endDealNow(o.auth, id);
    expect((await row(id)).deal_status, "premise: the only deal has ended").toBe("ended");
    expect(await sweep(o), "an ended deal is history: it is not examined").toEqual(NOTHING);
  });

  it("a sweep scoped to NO org checks nothing (the scope is a real filter, not a pass-through)", async () => {
    const o = await org();
    const id = await deal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    expect(await sweepSponsorDeals(new Date(), { orgIds: [] })).toEqual(NOTHING);
    expect((await row(id)).deal_status, "the expired deal was not touched").toBe("live");
  });

  it("a sweep scoped to another org leaves this org's expired deal alone, and the right one ends it", async () => {
    const o = await org();
    const other = await org();
    const id = await deal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    expect(await sweep(other)).toEqual(NOTHING);
    expect((await row(id)).deal_status).toBe("live");
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
  });

  it("two live deals, one past its end and one a day away: checked 2, expired 1, the first comes off the strip", async () => {
    const o = await org();
    const p = await pkg(o);
    const gone = await sponsor(o);
    const kept = await sponsor(o);
    const goneDeal = await deal(o, gone, p);
    const keptDeal = await deal(o, kept, p);
    const now = new Date();
    await endsAt(goneDeal, new Date(now.getTime() - MINUTE));
    await endsAt(keptDeal, new Date(now.getTime() + DAY));
    expect(await listed(o, gone), "premise: both are on the strip").toBe(true);
    expect(await listed(o, kept), "premise: both are on the strip").toBe(true);

    expect(await sweep(o, now)).toEqual({ ...NOTHING, checked: 2, expired: 1 });

    expect(await row(goneDeal)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    expect((await row(goneDeal)).ended_at, "ended_at is stamped").not.toBeNull();
    expect(await row(keptDeal)).toMatchObject({ deal_status: "live", ended_reason: null });
    expect(await listed(o, gone), "the expired sponsor is no longer listed").toBe(false);
    expect(await listed(o, kept), "the other still is").toBe(true);
    expect((await sponsorOf(gone)).status).toBe("inactive");
    expect((await sponsorOf(kept)).status).toBe("active");
  });

  it("the boundary: ends_at exactly now is expired; one millisecond later is not", async () => {
    const o = await org();
    const p = await pkg(o);
    const exact = await deal(o, await sponsor(o), p);
    const later = await deal(o, await sponsor(o), p);
    const now = new Date();
    await endsAt(exact, now);
    await endsAt(later, new Date(now.getTime() + 1));

    expect(await sweep(o, now)).toEqual({ ...NOTHING, checked: 2, expired: 1 });
    expect((await row(exact)).deal_status, "ends_at = now ends it (<=)").toBe("ended");
    expect((await row(later)).deal_status, "its twin a millisecond later stays live").toBe("live");
  });

  it("the second call is a no-op: the ended deal is not re-examined, the live one is byte-identical", async () => {
    const o = await org();
    const p = await pkg(o);
    const goneDeal = await deal(o, await sponsor(o), p);
    const keptDeal = await deal(o, await sponsor(o), p);
    const now = new Date();
    await endsAt(goneDeal, new Date(now.getTime() - MINUTE));
    await endsAt(keptDeal, new Date(now.getTime() + DAY));

    expect(await sweep(o, now)).toEqual({ ...NOTHING, checked: 2, expired: 1 });
    const [goneBytes, keptBytes] = [await bytes(goneDeal), await bytes(keptDeal)];
    expect(await sweep(o, now), "the second call: one live deal examined, nothing done").toEqual({ ...NOTHING, checked: 1 });
    expect(await bytes(goneDeal)).toBe(goneBytes);
    expect(await bytes(keptDeal)).toBe(keptBytes);
  });

  it("an org-wide deal with no end date is examined and left alone (nothing ends it but End now)", async () => {
    const o = await org();
    const id = await deal(o, await sponsor(o), await pkg(o));
    expect(await sweep(o, new Date(Date.now() + 3650 * DAY)), "ten years on, still live").toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("live");
  });
});

describe.skipIf(!HAS_DB)("sweepSponsorDeals: an OPEN deal past its end (F19) and the session rule (F3)", () => {
  it("awaiting payment, awaiting approval and an online invoice past their end are all ended `expired`; only the session is closed at Stripe", async () => {
    const o = await org();
    const p = await pkg(o);
    const awaitingPayment = await deal(o, await sponsor(o), p, { payment_method: "offline", go_live: "on_payment" });
    const awaitingApproval = await deal(o, await sponsor(o), p, { payment_method: "offline", go_live: "on_approval" });
    await markDealPaid(o.auth, awaitingApproval);
    const invoiced = await onlineDeal(o, await sponsor(o), p);
    const session = (await sessionOf(invoiced))!;
    expect(session, "premise: the online invoice holds a Checkout session").toMatch(/^cs_/);
    expect([(await row(awaitingPayment)).deal_status, (await row(awaitingApproval)).deal_status, (await row(invoiced)).deal_status]).toEqual([
      "awaiting_payment", "awaiting_approval", "awaiting_payment",
    ]);
    const past = new Date(Date.now() - MINUTE);
    for (const id of [awaitingPayment, awaitingApproval, invoiced]) await endsAt(id, past);
    stripe.retrieve.mockClear();

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 3, expired: 3 });

    for (const id of [awaitingPayment, awaitingApproval, invoiced]) expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    expect(stripe.retrieve, "one stored session read: the offline deals hold none").toHaveBeenCalledTimes(1);
    expect(stripe.retrieve.mock.calls[0]![0]).toBe(session);
    expect(stripe.expire, "the open session is expired, exactly once").toHaveBeenCalledTimes(1);
    expect(stripe.expire.mock.calls[0]![0]).toBe(session);
    expect(stripe.expire.mock.calls[0]![2], "keyed per session").toEqual({ idempotencyKey: `sponsor-session-expire-${session}` });
    expect(await sessionOf(invoiced), "an ended deal forgets its dead session").toBeNull();
    expect((await row(awaitingApproval)).payment_status, "money is not rewritten by the sweep").toBe("paid");
  });

  it("a session Stripe already calls expired is forgotten with no expire call", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(await sessionOf(id)).toBeNull();
  });

  it("a session already completed at Stripe is carried on over (the late payment lands on an ended deal): ended, never expired", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    const session = (await sessionOf(id))!;
    await endsAt(id, new Date(Date.now() - MINUTE));
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(stripe.expire, "money in flight is not closed").not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "expired", checkout_session_id: session });
  });

  it("a live online deal (Straight away, payment pending) past its end has its session closed too", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o), { go_live: "immediate" });
    expect((await row(id)).deal_status, "premise: live while its payment is awaited").toBe("live");
    const session = (await sessionOf(id))!;
    await endsAt(id, new Date(Date.now() - MINUTE));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(stripe.expire).toHaveBeenCalledTimes(1);
    expect(stripe.expire.mock.calls[0]![0]).toBe(session);
    expect(await row(id)).toMatchObject({ deal_status: "ended", checkout_session_id: null });
  });

  it("a session that cannot be closed leaves the deal for the next run (`failed`), and the sweep moves on to the next deal", async () => {
    const o = await org();
    const p = await pkg(o);
    const stuck = await onlineDeal(o, await sponsor(o), p);
    const fine = await deal(o, await sponsor(o), p, { payment_method: "offline", go_live: "on_payment" });
    const stuckSession = (await sessionOf(stuck))!;
    const past = new Date(Date.now() - MINUTE);
    await endsAt(stuck, past);
    await endsAt(fine, past);
    stripe.expire.mockImplementation(async () => {
      throw new Error("stripe is down");
    });

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, expired: 1, failed: 1 });
    expect(await row(stuck), "left as it was: still payable, still open").toMatchObject({ deal_status: "awaiting_payment", ended_reason: null, checkout_session_id: stuckSession });
    expect((await row(fine)).deal_status, "the other deal ended in the same run").toBe("ended");

    stripe.expire.mockReset().mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    expect(await sweep(o), "the next run finishes it").toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(await row(stuck)).toMatchObject({ deal_status: "ended", ended_reason: "expired", checkout_session_id: null });
  });

  it("a session Stripe cannot read at all is a failure for that deal, not an ended one", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    stripe.retrieve.mockImplementation(async () => {
      throw new Error("stripe is down");
    });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, failed: 1 });
    expect((await row(id)).deal_status).toBe("awaiting_payment");
    expect(stripe.expire, "nothing is expired on a session nobody could read").not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("sweepSponsorDeals: another writer acts between the sweep's read and its lock (the re-check, F2)", () => {
  it("a deal ended by someone else in between is left exactly as they left it (not re-ended, not counted)", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    h.hook = async () => {
      h.hook = null;
      await sql`update sponsor_orders set deal_status = 'ended', ended_at = now(), ended_reason = 'ended_now' where id = ${id}`;
    };
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).ended_reason, "End now's reason survives: the sweep did not overwrite it").toBe("ended_now");
  });

  it("an end date moved into the future in between spares the deal", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    h.hook = async () => {
      h.hook = null;
      await endsAt(id, new Date(Date.now() + DAY));
    };
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("awaiting_payment");
  });

  it("a Checkout session stored in between is never left payable on an ended deal: the deal is `failed` and untouched", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    h.hook = async () => {
      h.hook = null;
      await sql`update sponsor_orders set checkout_session_id = 'cs_minted_meanwhile' where id = ${id}`;
    };
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, failed: 1 });
    expect(await row(id)).toMatchObject({ deal_status: "awaiting_payment", checkout_session_id: "cs_minted_meanwhile" });
  });

  it("a finished competition's deal given an end date in between follows that date instead (the phase no longer decides it)", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    h.hook = async () => {
      h.hook = null;
      await endsAt(id, new Date(Date.now() + DAY));
    };
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("live");
  });
});

describe.skipIf(!HAS_DB)("sweepSponsorDeals: promotion, and a scheduled deal past its own end is never promoted (F19)", () => {
  it("promotion after expiry: the scheduled deal goes live and the sponsor takes ITS tier (the package's, not the old deal's)", async () => {
    const o = await org();
    const s = await sponsor(o);
    const a = await deal(o, s, await pkg(o, "partner"));
    const b = await deal(o, s, await pkg(o, "silver"));
    expect((await row(b)).deal_status, "premise: a second deal queues behind the live one").toBe("scheduled");
    expect((await sponsorOf(s)).tier, "premise: the sponsor shows the live deal's tier").toBe("partner");
    await endsAt(a, new Date(Date.now() - MINUTE));
    await endsAt(b, new Date(Date.now() + DAY));

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, expired: 1, promoted: 1 });

    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    const promoted = await row(b);
    expect(promoted.deal_status).toBe("live");
    expect(promoted.live_at, "live_at is stamped by the promotion").not.toBeNull();
    expect(await sponsorOf(s)).toMatchObject({ status: "active", tier: "silver" });
    expect(await listed(o, s), "the sponsor stays on the strip across the swap").toBe(true);
  });

  it("a scheduled deal past its own end is ended `expired` and never live (live_at stays null); the sponsor is reset", async () => {
    const o = await org();
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p);
    const b = await deal(o, s, p);
    expect((await row(b)).deal_status, "premise").toBe("scheduled");
    const past = new Date(Date.now() - MINUTE);
    await endsAt(a, past);
    await endsAt(b, past);

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, expired: 2 });

    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    expect(await row(b)).toMatchObject({ deal_status: "ended", ended_reason: "expired", live_at: null });
    expect(await sponsorOf(s)).toMatchObject({ status: "inactive", tier: "partner", competition_id: null });
    expect(await listed(o, s)).toBe(false);
  });

  it("the queue is walked: live A and scheduled B past their ends, scheduled C not -> B expired unpromoted, C promoted", async () => {
    const o = await org();
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p);
    const b = await deal(o, s, p);
    const c = await deal(o, s, p);
    const past = new Date(Date.now() - MINUTE);
    await endsAt(a, past);
    await endsAt(b, past);
    await endsAt(c, new Date(Date.now() + DAY));

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 3, expired: 2, promoted: 1 });
    expect((await row(b)).live_at, "B was never live").toBeNull();
    expect((await row(c)).deal_status).toBe("live");
    expect(await sponsorOf(s)).toMatchObject({ status: "active" });
  });

  it("a past-end scheduled deal whose session cannot be read does not hold the live deal up: the live deal ends, nothing is promoted, the next run ends the other", async () => {
    const o = await org();
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p); // live, session-less
    const b = await onlineDeal(o, s, p, { go_live: "immediate" }); // scheduled behind A, holds a session
    expect((await row(b)).deal_status, "premise: B is scheduled and payable").toBe("scheduled");
    expect(await sessionOf(b), "premise: B holds a session").toMatch(/^cs_/);
    const past = new Date(Date.now() - MINUTE);
    await endsAt(a, past);
    await endsAt(b, past);
    stripe.retrieve.mockImplementation(async () => {
      throw new Error("stripe is down");
    });

    expect(await sweep(o), "B cannot be read (failed); A ends and apply does not promote B").toEqual({ ...NOTHING, checked: 2, expired: 1, failed: 1 });
    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    expect(await row(b), "B is left exactly as it was, never live").toMatchObject({ deal_status: "scheduled", live_at: null });
    expect(await sponsorOf(s), "hidden behind the open deal, not left showing A").toMatchObject({ status: "inactive" });
    expect(await listed(o, s)).toBe(false);

    stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(await row(b)).toMatchObject({ deal_status: "ended", ended_reason: "expired", live_at: null });
    expect(await sponsorOf(s), "the last open deal ended: the sponsor is reset").toMatchObject({ status: "inactive", tier: "partner", competition_id: null });
  });

  it("m1: End now on the live deal skips a scheduled deal already past its own end and promotes the next one; the next sweep ends the skipped one", async () => {
    const o = await org();
    const s = await sponsor(o);
    const a = await deal(o, s, await pkg(o, "partner"));
    const b = await deal(o, s, await pkg(o, "partner")); // head of the queue, about to be past its end
    const c = await deal(o, s, await pkg(o, "silver")); // behind it, a day from its end
    expect([(await row(b)).deal_status, (await row(c)).deal_status], "premise: both queue behind A").toEqual(["scheduled", "scheduled"]);
    await endsAt(b, new Date(Date.now() - MINUTE));
    await endsAt(c, new Date(Date.now() + DAY));

    await endDealNow(o.auth, a);

    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "ended_now" });
    expect(await row(b), "the past-end deal at the head is passed over").toMatchObject({ deal_status: "scheduled", live_at: null });
    const promoted = await row(c);
    expect(promoted.deal_status, "the next one goes live").toBe("live");
    expect(promoted.live_at).not.toBeNull();
    expect(await sponsorOf(s), "the sponsor takes C's tier, not B's").toMatchObject({ status: "active", tier: "silver" });

    expect(await sweep(o), "B (open) and C (live): only B is due").toEqual({ ...NOTHING, checked: 2, expired: 1 });
    expect(await row(b)).toMatchObject({ deal_status: "ended", ended_reason: "expired", live_at: null });
    expect((await row(c)).deal_status, "C stays live").toBe("live");
    expect(await sponsorOf(s)).toMatchObject({ status: "active", tier: "silver" });
  });

  it("m1: End now with ONLY a past-end scheduled deal behind it promotes nothing: the sponsor is hidden until the sweep ends it", async () => {
    const o = await org();
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p);
    const b = await deal(o, s, p);
    await endsAt(b, new Date(Date.now() - MINUTE));

    await endDealNow(o.auth, a);

    expect(await row(b)).toMatchObject({ deal_status: "scheduled", live_at: null });
    expect(await sponsorOf(s), "an open deal waits: inactive, not reset").toMatchObject({ status: "inactive" });
    expect(await listed(o, s)).toBe(false);
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect(await row(b)).toMatchObject({ deal_status: "ended", ended_reason: "expired", live_at: null });
  });

  it("F2: the sweep and a console End now on the sponsor's other deal at the same moment both commit (no deadlock), and nothing is left live", async () => {
    const o = await org();
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p);
    const b = await deal(o, s, p);
    await endsAt(a, new Date(Date.now() - MINUTE));
    await endsAt(b, new Date(Date.now() + DAY));

    const [swept] = await Promise.all([sweep(o), endDealNow(o.auth, b)]);

    expect(swept.failed, "no 40P01, no refusal").toBe(0);
    expect((await row(a)).deal_status).toBe("ended");
    expect((await row(b)).deal_status).toBe("ended");
    expect(await sponsorOf(s)).toMatchObject({ status: "inactive" });
  });
});

describe.skipIf(!HAS_DB)("sweepSponsorDeals: a finished competition (spec §8a: the phase, not the date)", () => {
  it("a live deal scoped to a competition with every division finished, no end date, ends `competition_finished` (org timezone NULL)", async () => {
    const o = await org();
    expect(
      (await sql<{ timezone: string | null }[]>`select timezone from organizations where id = ${o.orgId}`)[0]!.timezone,
      "premise: the org has no timezone (V305 allows NULL)",
    ).toBeNull();
    const comp = await competition(o, "finished");
    const s = await sponsor(o);
    const id = await deal(o, s, await pkg(o), { competition_id: comp });
    expect(await listed(o, s, comp), "premise: on the competition's strip").toBe(true);

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });

    expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished" });
    expect(await listed(o, s, comp)).toBe(false);
    expect(await sponsorOf(s)).toMatchObject({ status: "inactive", competition_id: null });
  });

  it("its positive pair: a competition with a division still to play leaves its deal alone", async () => {
    const o = await org();
    const comp = await competition(o, "in_progress");
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("live");
  });

  it("zero divisions: a competition with none is setting up forever, so its deal never ends by phase (pinned)", async () => {
    const o = await org();
    const comp = await competition(o, "no_divisions");
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status, "the empty set is not 'every division finished'").toBe("live");
    // Accepted: End now still works on it.
    await endDealNow(o.auth, id);
    expect((await row(id)).ended_reason).toBe("ended_now");
  });

  it("moving the competition's dates moves the end: a finished competition whose end date is now far in the future still ends the deal", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    await sql`update competitions set ends_on = (current_date + 3650) where id = ${comp}`;
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });
    expect((await row(id)).ended_reason).toBe("competition_finished");
  });

  it("and its twin: an unfinished competition whose end date is long past does NOT end the deal (the date never ends it)", async () => {
    const o = await org();
    const comp = await competition(o, "in_progress");
    await sql`update competitions set ends_on = '2020-01-01' where id = ${comp}`;
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("live");
  });

  it("a deal that HAS an end date follows that date, not the competition's phase", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const id = await deal(o, await sponsor(o), await pkg(o), { competition_id: comp });
    await endsAt(id, new Date(Date.now() + DAY));
    h.deskFault = true; // the desk is never read for a deal that has an end date: reading it would count a failure
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    h.deskFault = false;
    expect((await row(id)).deal_status, "ends_at is in the future: still live though the competition is finished").toBe("live");
    await endsAt(id, new Date(Date.now() - MINUTE));
    expect(await sweep(o), "the same deal, its date passed").toEqual({ ...NOTHING, checked: 1, expired: 1 });
    expect((await row(id)).ended_reason, "ended by its date, so `expired`, not `competition_finished`").toBe("expired");
  });

  it("I1 (spec §8a, \"a deal\"): an awaiting-payment online deal on a finished competition is ended `competition_finished` and its Checkout session is expired", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const s = await sponsor(o);
    const id = await onlineDeal(o, s, await pkg(o), { competition_id: comp });
    const session = (await sessionOf(id))!;
    expect((await row(id)).deal_status, "premise: still waiting for its payment").toBe("awaiting_payment");
    expect(session, "premise: it holds a payable Checkout session").toMatch(/^cs_/);
    stripe.retrieve.mockClear();

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });

    expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished", live_at: null, checkout_session_id: null });
    expect(stripe.retrieve.mock.calls.map((c) => c[0]), "the stored session is read once").toEqual([session]);
    expect(stripe.expire, "and closed, so the pay link can no longer take money").toHaveBeenCalledTimes(1);
    expect(stripe.expire.mock.calls[0]![0]).toBe(session);
    expect(stripe.expire.mock.calls[0]![2]).toEqual({ idempotencyKey: `sponsor-session-expire-${session}` });
    expect(await sponsorOf(s), "the last open deal ended: the sponsor is reset").toMatchObject({ status: "inactive", tier: "partner", competition_id: null });
    expect(await sweep(o), "the second call finds nothing left").toEqual(NOTHING);
  });

  it("I1: an awaiting-approval deal and a session-less awaiting-payment deal on a finished competition end too, with no Stripe call", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const p = await pkg(o);
    const offline = await deal(o, await sponsor(o), p, { competition_id: comp, payment_method: "offline", go_live: "on_payment" });
    const approval = await deal(o, await sponsor(o), p, { competition_id: comp, payment_method: "offline", go_live: "on_approval" });
    await markDealPaid(o.auth, approval);
    expect([(await row(offline)).deal_status, (await row(approval)).deal_status], "premise: both wait").toEqual(["awaiting_payment", "awaiting_approval"]);
    stripe.retrieve.mockClear();

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, finished: 2 });

    for (const id of [offline, approval]) expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished", live_at: null });
    expect(stripe.retrieve, "neither holds a session").not.toHaveBeenCalled();
    expect(stripe.expire).not.toHaveBeenCalled();
    expect((await row(approval)).payment_status, "money is not rewritten by the sweep").toBe("paid");
  });

  it("I1's negative pair: the same open online deal on a competition still in play, or with no divisions at all, is left alone and its session untouched", async () => {
    const o = await org();
    const p = await pkg(o);
    const inPlay = await onlineDeal(o, await sponsor(o), p, { competition_id: await competition(o, "in_progress") });
    const empty = await onlineDeal(o, await sponsor(o), p, { competition_id: await competition(o, "no_divisions") });
    const orgWide = await onlineDeal(o, await sponsor(o), p); // no competition at all: nothing to finish
    stripe.retrieve.mockClear();

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 3 });

    for (const id of [inPlay, empty, orgWide]) expect((await row(id)).deal_status, "still waiting for its payment").toBe("awaiting_payment");
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(await sessionOf(inPlay)).toMatch(/^cs_/);
  });

  it("I1: an open deal with an end date follows that date, not the finished competition's phase (the desk is not read for it)", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o), { competition_id: await competition(o, "finished") });
    await endsAt(id, new Date(Date.now() + DAY));
    h.deskFault = true;
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect((await row(id)).deal_status).toBe("awaiting_payment");
  });

  it("I1: a competition whose desk cannot be read fails its OPEN deal too: left as it was, its session untouched", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o), { competition_id: await competition(o, "finished") });
    stripe.retrieve.mockClear();
    h.deskFault = true;
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, failed: 1 });
    h.deskFault = false;
    expect((await row(id)).deal_status, "an unreadable phase is not 'finished'").toBe("awaiting_payment");
    expect(stripe.retrieve).not.toHaveBeenCalled();
  });

  it("I1: a session Stripe already completed is carried on over: the open deal ends `competition_finished`, the late payment lands on the ended deal", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o), { competition_id: await competition(o, "finished") });
    const session = (await sessionOf(id))!;
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });
    expect(stripe.expire, "money in flight is not closed").not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished", checkout_session_id: session });
  });

  it("I1: a session that cannot be closed leaves the open deal for the next run (`failed`); the next run ends it", async () => {
    const o = await org();
    const id = await onlineDeal(o, await sponsor(o), await pkg(o), { competition_id: await competition(o, "finished") });
    stripe.expire.mockImplementation(async () => {
      throw new Error("stripe is down");
    });
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, failed: 1 });
    expect((await row(id)).deal_status, "a payable link is never left on an ended deal").toBe("awaiting_payment");
    stripe.expire.mockReset().mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });
    expect(await row(id)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished", checkout_session_id: null });
  });

  it("I1: a scheduled deal behind a live org-wide deal that expires, on a finished competition, ends `competition_finished` and is never promoted", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p); // org-wide, live
    const b = await deal(o, s, p, { competition_id: comp }); // scheduled behind it
    expect((await row(b)).deal_status, "premise").toBe("scheduled");
    await endsAt(a, new Date(Date.now() - MINUTE));

    expect(await sweep(o), "A expires, B finishes; promoted stays 0").toEqual({ ...NOTHING, checked: 2, expired: 1, finished: 1 });

    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    expect(await row(b), "B was never live").toMatchObject({ deal_status: "ended", ended_reason: "competition_finished", live_at: null });
    expect(await sponsorOf(s)).toMatchObject({ status: "inactive", tier: "partner", competition_id: null });
    expect(await listed(o, s, comp)).toBe(false);
  });

  it("I1: a live and a scheduled deal both on the finished competition end in one run, the scheduled one never promoted on the way", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p, { competition_id: comp }); // live
    const b = await deal(o, s, p, { competition_id: comp }); // scheduled behind it
    expect([(await row(a)).deal_status, (await row(b)).deal_status], "premise").toEqual(["live", "scheduled"]);

    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, finished: 2 });

    expect(await row(a)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished" });
    expect((await row(b)).live_at, "B was never live").toBeNull();
    expect(await row(b)).toMatchObject({ deal_status: "ended", ended_reason: "competition_finished" });
  });

  it("I1: a scheduled deal on an unfinished competition is promoted when the live one ends, as before (its positive pair)", async () => {
    const o = await org();
    const comp = await competition(o, "in_progress");
    const s = await sponsor(o);
    const p = await pkg(o);
    const a = await deal(o, s, p);
    const b = await deal(o, s, p, { competition_id: comp });
    await endsAt(a, new Date(Date.now() - MINUTE));
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, expired: 1, promoted: 1 });
    expect((await row(b)).deal_status).toBe("live");
  });

  it("a competition whose desk cannot be read fails its deal (left live) and the sweep goes on; the next run ends it", async () => {
    const o = await org();
    const p = await pkg(o);
    const fine = await deal(o, await sponsor(o), p);
    await endsAt(fine, new Date(Date.now() - MINUTE));
    const scoped = await deal(o, await sponsor(o), p, { competition_id: await competition(o, "finished") });

    h.deskFault = true;
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 2, expired: 1, failed: 1 });
    expect((await row(fine)).deal_status, "the other deal ended in the same run").toBe("ended");
    expect((await row(scoped)).deal_status, "an unreadable phase is not 'finished'").toBe("live");

    h.deskFault = false;
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1, finished: 1 });
    expect((await row(scoped)).ended_reason).toBe("competition_finished");
  });
});

describe.skipIf(!HAS_DB)("sweepSponsorDeals: the public page (F1: the sweep defers its bust)", () => {
  it("an org with ended deals is revalidated once, by slug, as tail work; an org with nothing to end is not", async () => {
    const o = await org();
    const quiet = await org();
    const p = await pkg(o);
    const [a, b] = [await deal(o, await sponsor(o), p), await deal(o, await sponsor(o), p)];
    await endsAt(a, new Date(Date.now() - MINUTE));
    await endsAt(b, new Date(Date.now() - MINUTE));
    await deal(quiet, await sponsor(quiet), await pkg(quiet));
    h.fired.length = 0;
    h.tails.length = 0;

    expect(await sweepSponsorDeals(new Date(), { orgIds: [o.orgId, quiet.orgId] })).toEqual({ ...NOTHING, checked: 3, expired: 2 });
    expect(h.fired, "deferred: nothing fires inside the sweep itself").toEqual([]);
    expect(h.tails.length, "one tail task for the one org that changed").toBe(1);
    await flushTails();
    expect(h.fired).toEqual([o.slug]);
  });

  it("a sweep that ends nothing queues no tail work", async () => {
    const o = await org();
    await deal(o, await sponsor(o), await pkg(o));
    h.tails.length = 0;
    expect(await sweep(o)).toEqual({ ...NOTHING, checked: 1 });
    expect(h.tails).toEqual([]);
  });

  it("the default (no org scope) sweeps every org: this org's expired deal is ended", async () => {
    const o = await org();
    const id = await deal(o, await sponsor(o), await pkg(o));
    await endsAt(id, new Date(Date.now() - MINUTE));
    const out = await sweepSponsorDeals();
    expect(out.checked).toBeGreaterThanOrEqual(1);
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await row(id)).ended_reason).toBe("expired");
  });
});

// Batch F review m4 (controller ruling): a package whose competition has FINISHED is not sold. The sweep would end such a deal
// within the hour (the competition-finished rule above) and expire its emailed pay link, so `createDeal` refuses it up front,
// 409 `competition_finished`, by the SAME authority the sweep uses (the derived phase, `competitionPhase(getCompetitionDesk)`),
// before anything is written or minted. The rig is the sweep's own (`competition(o, phase)`, asked of the desk). Expected
// values: the ruling's code and status; "nothing written" is read back from the tables, "nothing minted" from the Stripe stub.
describe.skipIf(!HAS_DB)("createDeal refuses a package whose competition has finished (batch F review m4)", () => {
  /** A package for ONE competition (the sweep's `pkg` is for the whole org). */
  async function compPkg(o: Org, competitionId: string): Promise<string> {
    const [r] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${o.orgId}, ${competitionId}, ${`Cup Pkg ${uniq()}`}, 25000, 'gbp', 'partner') returning id`;
    return r!.id;
  }
  const dealsOf = async (sponsorId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where sponsor_id = ${sponsorId}`)[0]!.n;

  it("a finished competition's package: 409 competition_finished, online or not, twice in a row - no deal, no Checkout, the sponsor untouched", async () => {
    const o = await org();
    const comp = await competition(o, "finished");
    const p = await compPkg(o, comp);
    const s = await sponsor(o);
    let refused = 0;
    for (const over of [
      { competition_id: comp, payment_method: "online", go_live: "on_payment", sponsor_email: `pay-${uniq()}@test.local` },
      { competition_id: comp, payment_method: "online", go_live: "on_payment", sponsor_email: `pay-${uniq()}@test.local` }, // a second call
      { competition_id: comp }, // complimentary, straight away
    ] as Partial<CreateDealInput>[]) {
      await expect(createDeal(o.auth, s, input(p, over), ORIGIN)).rejects.toMatchObject({ status: 409, code: "competition_finished" });
      refused++;
    }
    expect(refused).toBe(3);
    expect(await dealsOf(s), "nothing written").toBe(0);
    expect(stripe.create, "nothing minted").not.toHaveBeenCalled();
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(await sponsorOf(s), "the sponsor is as the club left it").toMatchObject({ status: "active", tier: "partner", competition_id: null });
    expect(await listed(o, s), "and still on the public strip").toBe(true);
  });

  it("its positive pairs: the same kind of package sells while its competition is in progress, and on one with no divisions yet (counted)", async () => {
    const o = await org();
    let sold = 0;
    for (const phase of ["in_progress", "no_divisions"] as const) {
      const comp = await competition(o, phase);
      const s = await sponsor(o);
      const id = await onlineDeal(o, s, await compPkg(o, comp), { competition_id: comp });
      expect((await row(id)).deal_status, phase).toBe("awaiting_payment");
      sold++;
    }
    expect(sold).toBe(2);
    expect(stripe.create).toHaveBeenCalledTimes(2);
  });

  it("a package for the whole org is not asked about any competition: it sells, and the desk is never read for it", async () => {
    const o = await org();
    await competition(o, "finished"); // the org HAS a finished competition; the package is not for it
    h.deskFault = true; // reading the desk now throws, so a read would fail the create
    const id = await deal(o, await sponsor(o), await pkg(o));
    expect((await row(id)).deal_status).toBe("live");
  });

  it("a competition whose phase cannot be read sells nothing: the create fails before any row or Checkout (never a guess)", async () => {
    const o = await org();
    const comp = await competition(o, "in_progress");
    const p = await compPkg(o, comp);
    const s = await sponsor(o);
    h.deskFault = true;
    await expect(
      createDeal(o.auth, s, input(p, { competition_id: comp, payment_method: "online", go_live: "on_payment", sponsor_email: `pay-${uniq()}@test.local` }), ORIGIN),
    ).rejects.toThrow("the desk cannot be read");
    expect(await dealsOf(s)).toBe(0);
    expect(stripe.create).not.toHaveBeenCalled();
  });
});

// The same authority, for the console: the Packages tab hides Send invoice on a package whose competition has finished. The page
// asks `finishedPackageCompetitions` which of the org's ACTIVE packages' competitions have finished.
describe.skipIf(!HAS_DB)("finishedPackageCompetitions: the finished competitions of the org's active packages (batch F review m4)", () => {
  async function compPkg(o: Org, competitionId: string, active = true): Promise<void> {
    await sql`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier, active)
      values (${o.orgId}, ${competitionId}, ${`Cup Pkg ${uniq()}`}, 25000, 'gbp', 'partner', ${active})`;
  }

  it("empty first: an org with no packages, and one with only a whole-org package, has none (and reads no desk)", async () => {
    const o = await org();
    h.deskFault = true; // any desk read would throw
    expect(await finishedPackageCompetitions(o.orgId)).toEqual([]);
    await pkg(o);
    expect(await finishedPackageCompetitions(o.orgId)).toEqual([]);
  });

  it("a finished competition's active package is listed once; in progress, no divisions, a retired package's and another org's are not", async () => {
    const o = await org();
    const finished = await competition(o, "finished");
    const retiredOnly = await competition(o, "finished");
    const running = await competition(o, "in_progress");
    const fresh = await competition(o, "no_divisions");
    await compPkg(o, finished);
    await compPkg(o, finished); // two packages, one competition: listed once
    await compPkg(o, retiredOnly, false);
    await compPkg(o, running);
    await compPkg(o, fresh);
    const other = await org();
    await compPkg(other, await competition(other, "finished"));
    expect(await finishedPackageCompetitions(o.orgId)).toEqual([finished]);
  });

  it("a competition whose phase cannot be read is not listed (the create's own guard still refuses it), and the read does not throw", async () => {
    const o = await org();
    await compPkg(o, await competition(o, "finished"));
    h.deskFault = true;
    expect(await finishedPackageCompetitions(o.orgId)).toEqual([]);
  });

  it("batch G New-4: the desks are read in parallel - every one in flight at once - and the answer keeps the id order though they finish in reverse", async () => {
    const o = await org();
    const ids = [await competition(o, "finished"), await competition(o, "in_progress"), await competition(o, "finished")];
    for (const id of ids) await compPkg(o, id);
    const sorted = [...ids].sort(); // the read's own order (`order by competition_id`): lowercase hex uuids sort the same in JS
    const N = ids.length;
    const parked = new Map<string, () => void>();
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    // A barrier: each desk read parks until all N are parked, then they are let go in REVERSE id order, staggered, so they
    // finish in reverse. A sequential read never brings the rest, so each parked read lets itself go after 300ms, alone.
    h.hook = async (competitionId) => {
      seen.push(competitionId!);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        parked.set(competitionId!, resolve);
        if (parked.size === N) [...sorted].reverse().forEach((id, i) => setTimeout(() => parked.get(id)?.(), i * 25));
        else setTimeout(resolve, 300);
      });
      inFlight--;
    };
    const got = await finishedPackageCompetitions(o.orgId);
    h.hook = null;
    expect(seen.sort(), "one desk read per competition").toEqual(sorted);
    expect(maxInFlight, "every desk read in flight at once").toBe(N);
    expect(got, "the finished two, in id order - not in the order their reads finished").toEqual(sorted.filter((id) => id !== ids[1]));
    expect(got).toHaveLength(2);
  });
});
