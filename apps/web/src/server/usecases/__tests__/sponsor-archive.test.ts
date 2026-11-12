// Archive a sponsor, Task 3 (plan docs/superpowers/plans/2026-11-11-sponsor-archive.md; spec
// docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §6.2, §6.3, §8, §9): `archiveSponsor` and `unarchiveSponsor`, the
// refusal while a deal still holds the sponsor (409 `sponsor_has_current_deal`), and the two writes an archived sponsor refuses
// (409 `sponsor_archived`: `patchSponsor`, and `createDeal` before any invoice number is used).
//
// The state transitions, listed before the cases (TEST-STRATEGY):
//   no deals, not archived  -- archive   --> archived (archived_at stamped; nothing else written)        [empty case first]
//   archived                -- archive   --> archived, the FIRST archived_at kept                       [second call]
//   archived                -- unarchive --> not archived, every other column as before the archive     [the round trip]
//   not archived            -- unarchive --> unchanged                                                  [second call]
//   a deal §8 marks "yes"   -- archive   --> 409 sponsor_has_current_deal, nothing written               [each row, counted]
//   a deal §8 marks "no"    -- archive   --> archived, the deal untouched                                [each row, counted]
//   live -> End now; expired unpaid -> Write off / Mark paid  -- archive --> archived                   [§9's ways out]
//   archived                -- PATCH / Add deal --> 409 sponsor_archived; no deal row, no invoice number  [§9]
//   unarchived              -- Add deal  --> works, goes live, resolves publicly again                    [§9 "works normally"]
//   archive racing Add deal under the sponsor lock --> exactly one wins                                  [§9, both orders]
//
// Expected values come from the spec's tables (§8 blocking, §9 sequences), typed here, never from `blocksArchive`. Every case
// reads the STORED row back with the privileged connection, never only the usecase's answer.
//
// The public surfaces dropping an archived sponsor (resolveSponsors and the four other SQL readers) are Task 4's
// (server/sponsors/__tests__/archive-readers.test.ts): this file proves the row comes BACK onto the free strip and the competition
// page after an unarchive, and, for a Free org, that the archive takes it off the free strip.
//
// Sport-agnostic: no sport sweep (a sponsor's archive reads no sport).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@/lib/db";

// No path here may reach Stripe or the mail transport: an offline or complimentary deal has no Checkout session, and every refusal
// below comes before any. A call fails loudly instead of reaching the network.
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("sponsor-archive.test: no path here reaches Stripe");
  },
}));
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: vi.fn(async () => {
    throw new Error("sponsor-archive.test: no path here sends mail");
  }),
}));
/** Every invoice token the REAL createDeal minted (F9): read back by the REAL invoiceDocByToken. No case writes a hash. */
const minted = vi.hoisted(() => [] as { dealId: string; token: string }[]);
vi.mock("@/server/sponsors/invoice-doc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/sponsors/invoice-doc")>();
  return {
    ...orig,
    mintInvoiceToken: vi.fn(async (tx: Tx, dealId: string) => {
      const token = await orig.mintInvoiceToken(tx, dealId);
      minted.push({ dealId, token });
      return token;
    }),
  };
});

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { invoiceDocByToken } from "@/server/sponsors/invoice-doc";
import {
  ORIGIN,
  cleanUp,
  dealInput,
  rigOrg,
  rigPackage,
  rigSponsor,
  uniq,
  type RigOrg,
} from "@/server/sponsors/__tests__/_invoice-rig";
import {
  PatchSponsorInput,
  archiveSponsor,
  createSponsor,
  deleteSponsor,
  listSponsorRows,
  listSponsors,
  patchSponsor,
  reorderSponsors,
  resolveSponsors,
  unarchiveSponsor,
} from "../sponsors";
import { createDeal, endDealNow, markDealPaid, sweepSponsorDeals, writeOffDeal } from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  minted.length = 0;
});
afterAll(async () => {
  if (HAS_DB) await cleanUp();
});

// --- reads of the stored rows (privileged: never the usecase's own answer) -------------------------------------------------------

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
/** The stored `archived_at`, as an ISO string (null when not archived). */
const archivedAt = async (id: string): Promise<string | null> =>
  iso((await sql<{ archived_at: Date | null }[]>`select archived_at from sponsors where id = ${id}`)[0]?.archived_at ?? null);
/** The whole stored sponsor row, byte for byte (null once deleted). */
const rowBytes = async (id: string): Promise<string | null> =>
  (await sql<{ row: string }[]>`select to_jsonb(s)::text as row from sponsors s where s.id = ${id}`)[0]?.row ?? null;
/** The stored sponsor row as an object (null once deleted). */
const stored = async (id: string): Promise<Record<string, unknown> | null> =>
  (await sql<{ row: Record<string, unknown> }[]>`select to_jsonb(s) as row from sponsors s where s.id = ${id}`)[0]?.row ?? null;
/** Every deal of a sponsor, byte for byte, in a fixed order. */
const dealsBytes = async (sponsorId: string): Promise<string[]> =>
  (await sql<{ row: string }[]>`
    select to_jsonb(d)::text as row from sponsor_orders d where d.sponsor_id = ${sponsorId} order by d.created_at, d.id`).map((r) => r.row);
const dealCount = async (sponsorId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where sponsor_id = ${sponsorId}`)[0]!.n;
/** The org's invoice counter (null: no number was ever allocated). */
const lastNumber = async (orgId: string): Promise<number | null> =>
  (await sql<{ last_number: number }[]>`select last_number from sponsor_invoice_counters where org_id = ${orgId}`)[0]?.last_number ?? null;

/** What a call refused with: the HttpError's status and code. A call that succeeded answers `no_refusal`, so a labelled expect
 *  names the case that let it through. */
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number | undefined; code: string | undefined }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status, code: e.code };
  }
  return { status: undefined, code: "no_refusal" };
}
/** The words a call refused with (reaches the v1 envelope's `message` and the logs); null when it did not refuse. */
async function refusalMessage(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}
const NO_REFUSAL = { status: undefined, code: "no_refusal" };
const HAS_CURRENT_DEAL = { status: 409, code: "sponsor_has_current_deal" };
const ARCHIVED = { status: 409, code: "sponsor_archived" };

/** The token in effect for a deal: the last one the real producers minted. */
function tokenOf(dealId: string): string {
  const mine = minted.filter((m) => m.dealId === dealId);
  expect(mine.length, `premise: a token minted for ${dealId}`).toBeGreaterThan(0);
  return mine.at(-1)!.token;
}

// --- deal rows in a given state (coherent with sponsor_orders' CHECKs; sponsor-lock.test.ts's shapes) ----------------------------

type Deal = Record<string, string | number | boolean | Date | null>;
const T0 = new Date("2026-01-15T10:00:00.000Z");
/** An online deal on the rig's org-wide package, awaiting payment. `over` changes it. */
function deal(o: RigOrg, packageId: string, sponsorId: string, over: Deal = {}): Deal {
  return {
    org_id: o.orgId, package_id: packageId, sponsor_name: "Acme", sponsor_email: "billing@acme.test",
    amount_cents: 25000, currency: "gbp", status: "pending", sponsor_id: sponsorId,
    deal_status: "awaiting_payment", payment_method: "online", go_live: "on_payment",
    tier: "partner", includes_on_stream: false, package_name: "Partner", competition_id: null,
    ended_at: null, ended_reason: null,
    ...over,
  };
}
async function insertDeal(row: Deal): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
  return r!.id;
}
const LIVE: Deal = { deal_status: "live", status: "paid", paid_at: T0, live_at: T0 };
const ENDED: Deal = { deal_status: "ended", ended_at: T0, ended_reason: "ended_now" };
/** An offline deal that went live and ended unpaid for `reason`: §8's "ended and endedStillDue". */
const stillDue = (reason: string): Deal => ({
  deal_status: "ended", ended_at: T0, ended_reason: reason, payment_method: "offline", go_live: "immediate", live_at: T0,
});

/** Spec §8, every row marked "yes", typed from the table (never from blocksArchive). §8's "scheduled (paid or unpaid)" is two rows,
 *  and pre-flight ruling P2 puts `competition_finished` beside `expired` as the second still-due reason: nine rows. */
const BLOCKING: [string, Deal][] = [
  ["draft", { deal_status: "draft" }],
  ["awaiting_payment (offline)", { deal_status: "awaiting_payment", payment_method: "offline" }],
  ["awaiting_approval (paid)", { deal_status: "awaiting_approval", status: "paid", paid_at: T0, go_live: "on_approval" }],
  ["scheduled, paid", { deal_status: "scheduled", status: "paid", paid_at: T0 }],
  ["scheduled, unpaid (offline, immediate)", { deal_status: "scheduled", payment_method: "offline", go_live: "immediate" }],
  ["live, paid", LIVE],
  ["live, parked by a dispute", { ...LIVE, parked_at: T0, disputed_at: T0, dispute_id: `dp_parked_${uniq()}` }],
  ["ended still due: offline, went live, unpaid, expired", stillDue("expired")],
  ["ended still due: offline, went live, unpaid, competition_finished (P2)", stillDue("competition_finished")],
];
/** Spec §8, every row marked "no" (D17 and P2's written_off among them). */
const SETTLED: [string, Deal][] = [
  ["ended_now (the club cancelled)", ENDED],
  ["refunded", { ...ENDED, ended_reason: "refunded", status: "refunded", paid_at: T0, live_at: T0, payment_intent_id: `pi_rf_${uniq()}` }],
  ["written_off (P2: the club gave the money up)", { ...stillDue("written_off"), written_off_at: T0 }],
  ["dispute_lost", { ...ENDED, ended_reason: "dispute_lost", status: "refunded", paid_at: T0, live_at: T0, disputed_at: T0,
    dispute_id: `dp_lost_${uniq()}`, payment_intent_id: `pi_dl_${uniq()}` }],
  ["ended, paid", { ...ENDED, ended_reason: "expired", status: "paid", paid_at: T0, live_at: T0 }],
  ["ended, offline, unpaid, never went live", { ...stillDue("expired"), live_at: null, go_live: "on_payment" }],
  ["ended, online, unpaid, expired (its link is gone)", { ...ENDED, ended_reason: "expired", go_live: "immediate", live_at: T0 }],
  ["ended, paid, open dispute (D17)", { ...ENDED, status: "paid", paid_at: T0, live_at: T0, disputed_at: T0,
    dispute_id: `dp_open_${uniq()}`, payment_intent_id: `pi_od_${uniq()}` }],
  ["legacy order", { ...ENDED, ended_reason: "legacy", status: "paid", paid_at: T0 }],
  ["complimentary, ended", { ...ENDED, payment_method: "complimentary", status: "none", go_live: "immediate", live_at: T0 }],
];

/** A competition of the org (raw row: no plan gate, no sport). */
async function competitionOf(orgId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Archive Cup', ${`archive-cup-${uniq()}`}) returning id`;
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("archive and unarchive: the round trip (spec §9)", () => {
  it("empty first: a sponsor with no deals archives; the default list omits it; ?archived=1 lists it with archived_at", async () => {
    const o = await rigOrg();
    const s = await rigSponsor(o);
    const keep = await rigSponsor(o);
    expect(await dealCount(s.id), "premise: no deals").toBe(0);
    expect(await archivedAt(s.id), "premise: not archived").toBeNull();

    const answer = await archiveSponsor(o.auth, s.id);
    const at = await archivedAt(s.id);
    expect(at, "the stored row is stamped").not.toBeNull();
    expect(iso(answer.archived_at), "the answer carries the stored stamp").toBe(at);

    for (const [label, read] of [
      ["listSponsors (GET /sponsors)", (opts?: { includeArchived?: boolean }) => listSponsors(o.auth, opts)],
      ["listSponsorRows (the console)", (opts?: { includeArchived?: boolean }) => listSponsorRows(o.orgId, opts)],
    ] as const) {
      const byDefault = (await read()).map((r) => r.id);
      expect(byDefault, `${label}: the default omits the archived row`).not.toContain(s.id);
      expect(byDefault, `${label}: and keeps the unarchived one (positive pair)`).toContain(keep.id);
      const all = await read({ includeArchived: true });
      expect(iso(all.find((r) => r.id === s.id)?.archived_at), `${label}: includeArchived lists it, stamped`).toBe(at);
      expect(all.find((r) => r.id === keep.id)?.archived_at, `${label}: an unarchived row says null`).toBeNull();
    }
  });

  it("a second archive answers the first archived_at, unchanged", async () => {
    const o = await rigOrg();
    const s = await rigSponsor(o);
    await archiveSponsor(o.auth, s.id);
    const first = await archivedAt(s.id);
    const bytes = await rowBytes(s.id);
    // A re-stamp in a later transaction would read a later now(): wait past the clock's resolution so it cannot tie.
    await new Promise((r) => setTimeout(r, 20));
    const second = await archiveSponsor(o.auth, s.id);
    expect(await archivedAt(s.id), "the stored stamp is the first one").toBe(first);
    expect(iso(second.archived_at), "the answer is the first stamp").toBe(first);
    expect(await rowBytes(s.id), "nothing else written").toBe(bytes);
  });

  it("archive → unarchive → archive: each succeeds; after the unarchive every column but archived_at equals the pre-archive snapshot", async () => {
    const o = await rigOrg();
    const compId = await competitionOf(o.orgId);
    // Every column the brief names off its default, so an archive or unarchive that touched one is seen.
    const [{ id }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, url, logo_path, poster_path, tier, display_order, status, click_count, on_stream)
      values (${o.orgId}, ${compId}, 'Harbour Bank', 'https://harbour.example/', 'logos/harbour.png', 'https://cdn.example/harbour.png',
              'gold', 7, 'active', 42, true)
      returning id`;
    const without = (row: Record<string, unknown> | null): Record<string, unknown> =>
      Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => k !== "archived_at"));
    const snapshot = without(await stored(id));
    // The brief's list (poster_path unconditional: pre-flight P3), each a real column of the snapshot.
    const NAMED = ["status", "tier", "competition_id", "on_stream", "display_order", "click_count", "logo_path", "url", "name",
      "placement_from_deal_id", "poster_path"];
    expect(Object.keys(snapshot), "anti-vacuity: the snapshot holds every named column").toEqual(expect.arrayContaining(NAMED));
    expect(Object.keys(snapshot).length, "and more than archived_at alone").toBeGreaterThanOrEqual(NAMED.length);

    await archiveSponsor(o.auth, id);
    expect(await archivedAt(id), "archived").not.toBeNull();
    expect(without(await stored(id)), "archive writes archived_at only").toEqual(snapshot);

    const back = await unarchiveSponsor(o.auth, id);
    expect(await archivedAt(id), "unarchived").toBeNull();
    expect(back.archived_at, "the answer says so").toBeNull();
    expect(without(await stored(id)), "unarchive restores the sponsor as it was").toEqual(snapshot);

    await archiveSponsor(o.auth, id);
    expect(await archivedAt(id), "archives again").not.toBeNull();
    expect(without(await stored(id))).toEqual(snapshot);
  });

  it("unarchive of a sponsor that is not archived answers it unchanged (and a second unarchive too)", async () => {
    const o = await rigOrg();
    const s = await rigSponsor(o);
    const bytes = await rowBytes(s.id);
    const answer = await unarchiveSponsor(o.auth, s.id);
    expect(answer.id).toBe(s.id);
    expect(answer.archived_at).toBeNull();
    expect(await rowBytes(s.id), "nothing written").toBe(bytes);

    await archiveSponsor(o.auth, s.id);
    await unarchiveSponsor(o.auth, s.id);
    const afterFirst = await rowBytes(s.id);
    await unarchiveSponsor(o.auth, s.id);
    expect(await rowBytes(s.id), "a second unarchive writes nothing").toBe(afterFirst);
    expect(await archivedAt(s.id)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("what holds a sponsor from Archive (spec §8, D9)", () => {
  it("each blocking deal state refuses 409 sponsor_has_current_deal and writes nothing (count reported)", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    let checked = 0;
    for (const [label, over] of BLOCKING) {
      const s = await rigSponsor(o);
      await insertDeal(deal(o, pkg.id, s.id, over));
      const bytes = await rowBytes(s.id);
      const dealBytes = await dealsBytes(s.id);
      expect(await refusal(() => archiveSponsor(o.auth, s.id)), label).toEqual(HAS_CURRENT_DEAL);
      expect(await archivedAt(s.id), `${label}: archived_at stays null`).toBeNull();
      expect(await rowBytes(s.id), `${label}: the sponsor is untouched`).toBe(bytes);
      expect(await dealsBytes(s.id), `${label}: and its deal`).toEqual(dealBytes);
      checked++;
    }
    expect(checked, "anti-vacuity: every §8 'yes' row").toBe(BLOCKING.length);
    expect(BLOCKING.length, "§8's yes rows: 7 states, scheduled twice, still-due twice (P2)").toBe(9);
  });

  it("each settled deal state archives, and the deal is untouched (count reported)", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    let checked = 0;
    for (const [label, over] of SETTLED) {
      const s = await rigSponsor(o);
      await insertDeal(deal(o, pkg.id, s.id, over));
      const dealBytes = await dealsBytes(s.id);
      expect(await refusal(() => archiveSponsor(o.auth, s.id)), label).toEqual(NO_REFUSAL);
      expect(await archivedAt(s.id), `${label}: archived`).not.toBeNull();
      expect(await dealsBytes(s.id), `${label}: the deal is kept as it was`).toEqual(dealBytes);
      checked++;
    }
    expect(checked, "anti-vacuity: every §8 'no' row").toBe(SETTLED.length);
    expect(SETTLED.length).toBe(10);
  });

  it("after End now the same sponsor archives; its deals, invoice_number and invoice_token_hash are unchanged", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const s = await rigSponsor(o);
    // The real producer: an offline deal that goes live at once, numbered, its invoice token minted (F9).
    const { deal: live } = await createDeal(o.auth, s.id, dealInput(pkg.id, { go_live: "immediate" }), ORIGIN);
    expect(live.deal_status, "premise: live").toBe("live");
    expect(await refusal(() => archiveSponsor(o.auth, s.id)), "a live deal holds it").toEqual(HAS_CURRENT_DEAL);

    await endDealNow(o.auth, live.id);
    const [cols] = await sql<{ invoice_number: number | null; invoice_token_hash: Buffer | null; ended_reason: string }[]>`
      select invoice_number, invoice_token_hash, ended_reason from sponsor_orders where id = ${live.id}`;
    expect(cols!.ended_reason, "premise: ended now").toBe("ended_now");
    expect(cols!.invoice_number, "premise: numbered").not.toBeNull();
    expect(cols!.invoice_token_hash, "premise: its invoice link exists").not.toBeNull();
    const before = await dealsBytes(s.id);

    expect(await refusal(() => archiveSponsor(o.auth, s.id)), "End now let it go").toEqual(NO_REFUSAL);
    expect(await archivedAt(s.id)).not.toBeNull();
    expect(await dealsBytes(s.id), "every deal column kept, the invoice number and token hash among them").toEqual(before);
  });

  it("an offline deal ended 'expired' unpaid: 409; Write off (or Mark paid); then archive succeeds (count reported)", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const today = new Date().toISOString().slice(0, 10); // the rig org has no timezone: UTC
    let checked = 0;
    for (const [settle, act] of [
      ["Write off", writeOffDeal],
      ["Mark paid", markDealPaid],
    ] as const) {
      const s = await rigSponsor(o);
      const { deal: d } = await createDeal(o.auth, s.id, dealInput(pkg.id, { go_live: "immediate", ends_on: today }), ORIGIN);
      // The real producer of `expired`: the hourly sweep, after the deal's last day.
      await sweepSponsorDeals(new Date(Date.now() + 3 * 86_400_000), { orgIds: [o.orgId] });
      const [ended] = await sql<{ deal_status: string; ended_reason: string; status: string; live_at: Date | null }[]>`
        select deal_status, ended_reason, status, live_at from sponsor_orders where id = ${d.id}`;
      expect(ended, `${settle}: premise: ended expired, unpaid, after going live`).toMatchObject({
        deal_status: "ended", ended_reason: "expired", status: "pending",
      });
      expect(ended!.live_at, `${settle}: premise: it went live`).not.toBeNull();

      expect(await refusal(() => archiveSponsor(o.auth, s.id)), `${settle}: money still owed holds it`).toEqual(HAS_CURRENT_DEAL);
      await act(o.auth, d.id);
      expect(await refusal(() => archiveSponsor(o.auth, s.id)), `${settle}: settled, it archives`).toEqual(NO_REFUSAL);
      expect(await archivedAt(s.id), settle).not.toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("records stay: invoices, delete rules (spec §9, D3, D7)", () => {
  it("with invoices: archived, invoiceDocByToken(token) still answers the doc; delete is still 409 sponsor_has_deal_history", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const s = await rigSponsor(o);
    const { deal: d } = await createDeal(o.auth, s.id, dealInput(pkg.id), ORIGIN);
    await endDealNow(o.auth, d.id);
    const token = tokenOf(d.id);
    const doc = await invoiceDocByToken(token);
    expect(doc, "premise: the invoice opens before the archive").not.toBeNull();

    await archiveSponsor(o.auth, s.id);
    expect(await archivedAt(s.id), "premise: archived").not.toBeNull();
    expect(await invoiceDocByToken(token), "the invoice is a record: it opens as it did").toEqual(doc);

    expect(await refusal(() => deleteSponsor(o.auth, s.id)), "a numbered invoice is history").toEqual({
      status: 409, code: "sponsor_has_deal_history",
    });
    expect(await archivedAt(s.id), "the sponsor stays, still archived").not.toBeNull();
    expect(await dealCount(s.id)).toBe(1);

    // Final review m2: the refusal's own words give the dictionaries' and OpenAPI's advice. Ending a deal never made a sponsor with
    // history deletable, so "end its deals instead" sent the reader down a dead end.
    const said = await refusalMessage(() => deleteSponsor(o.auth, s.id));
    expect(said, "premise: the delete refused with a message").not.toBeNull();
    expect(said).toMatch(/archive it instead$/);
    expect(said).not.toMatch(/end its deals/);
  });

  it("without invoices: a sponsor with only an ended complimentary deal archives, and can still be deleted", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const s = await rigSponsor(o);
    const { deal: d } = await createDeal(o.auth, s.id, dealInput(pkg.id, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
    expect(d.invoice_number, "premise: complimentary takes no number").toBeNull();
    await endDealNow(o.auth, d.id);
    await archiveSponsor(o.auth, s.id);
    expect(await archivedAt(s.id), "archived").not.toBeNull();

    expect(await refusal(() => deleteSponsor(o.auth, s.id)), "no history: Delete's rules are unchanged").toEqual(NO_REFUSAL);
    expect(await rowBytes(s.id), "the sponsor is gone").toBeNull();
    expect(await dealCount(s.id), "with its deal").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("an archived sponsor refuses writes (spec D10, D11)", () => {
  it("an archived sponsor: createDeal is 409 sponsor_archived; no sponsor_orders row; sponsor_invoice_counters.last_number unchanged (count reported)", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    // The counter exists first (another sponsor's numbered deal), so "unchanged" is a number, not an absence.
    const other = await rigSponsor(o);
    await createDeal(o.auth, other.id, dealInput(pkg.id), ORIGIN);
    const before = await lastNumber(o.orgId);
    expect(before, "premise: one number used").toBe(1);
    minted.length = 0;

    const s = await rigSponsor(o);
    await archiveSponsor(o.auth, s.id);
    let checked = 0;
    for (const method of ["offline", "complimentary"] as const) {
      const body = dealInput(pkg.id, { payment_method: method, go_live: "immediate" });
      expect(await refusal(() => createDeal(o.auth, s.id, body, ORIGIN)), method).toEqual(ARCHIVED);
      expect(await dealCount(s.id), `${method}: no deal row`).toBe(0);
      expect(await lastNumber(o.orgId), `${method}: no invoice number used`).toBe(before);
      checked++;
    }
    expect(checked).toBe(2);
    expect(minted, "no invoice token minted").toEqual([]);
    expect(await archivedAt(s.id), "still archived").not.toBeNull();
  });

  it("the early check answers first (D10: before the online checks and any Stripe work): an online create with no billing email is 409 sponsor_archived; unarchived, the same body is 422 sponsor_email_required", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const s = await rigSponsor(o);
    const body = dealInput(pkg.id, { payment_method: "online", sponsor_email: null });
    await archiveSponsor(o.auth, s.id);
    expect(await refusal(() => createDeal(o.auth, s.id, body, ORIGIN)), "archived").toEqual(ARCHIVED);
    await unarchiveSponsor(o.auth, s.id);
    expect(await refusal(() => createDeal(o.auth, s.id, body, ORIGIN)), "positive pair: the body's own refusal").toEqual({
      status: 422, code: "sponsor_email_required",
    });
    expect(await dealCount(s.id)).toBe(0);
  });

  it("an archived sponsor: PATCH {name} is 409 sponsor_archived and the name is unchanged; unarchived, the same PATCH applies", async () => {
    const o = await rigOrg();
    const s = await rigSponsor(o);
    await archiveSponsor(o.auth, s.id);
    const bytes = await rowBytes(s.id);
    expect(await refusal(() => patchSponsor(o.auth, s.id, { name: "Renamed Ltd" }))).toEqual(ARCHIVED);
    expect(await rowBytes(s.id), "nothing written").toBe(bytes);

    await unarchiveSponsor(o.auth, s.id);
    await expect(patchSponsor(o.auth, s.id, { name: "Renamed Ltd" })).resolves.toMatchObject({ name: "Renamed Ltd" });
    expect((await stored(s.id))!.name).toBe("Renamed Ltd");
  });

  // Review M1. The console's reorder sends EVERY id of the list it shows, and the Sponsors tab lists archived rows too, so a
  // reorder naming an archived sponsor is the ordinary case, not an attack: it must succeed and leave that row where it was
  // (unarchive is exact, spec §9), while the active rows it names still move. An unknown id stays a 422 (sponsors.test.ts).
  it("reorder: an archived row named in a reorder keeps its display_order (and every other column); the active rows still move; unarchived, it moves too", async () => {
    const o = await rigOrg();
    const a = await rigSponsor(o, `Alder ${uniq()}`);
    const b = await rigSponsor(o, `Birch ${uniq()}`);
    const x = await rigSponsor(o, `Xylem ${uniq()}`);
    await sql`update sponsors set display_order = 7 where id = ${x.id}`;
    const without = (row: Record<string, unknown> | null): Record<string, unknown> =>
      Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => k !== "archived_at"));
    const order = async (id: string): Promise<number> =>
      (await sql<{ display_order: number }[]>`select display_order from sponsors where id = ${id}`)[0]!.display_order;
    const snapshot = without(await stored(x.id));
    expect(snapshot.display_order, "premise: off the default").toBe(7);

    await archiveSponsor(o.auth, x.id);
    const archivedBytes = await rowBytes(x.id);
    expect(await refusal(() => reorderSponsors(o.auth, { ids: [b.id, x.id, a.id] })), "the reorder succeeds").toEqual(NO_REFUSAL);
    expect(await rowBytes(x.id), "the archived row is not written at all").toBe(archivedBytes);
    expect([await order(b.id), await order(a.id)], "the active rows take their positions (0 and 2)").toEqual([0, 2]);

    await unarchiveSponsor(o.auth, x.id);
    expect(without(await stored(x.id)), "unarchive is exact: display_order 7 and every other column as before").toEqual(snapshot);

    await reorderSponsors(o.auth, { ids: [x.id, a.id, b.id] });
    expect([await order(x.id), await order(a.id), await order(b.id)], "unarchived, the same row moves like any other").toEqual([0, 1, 2]);
  });

  it("PATCH {archived_at: null} is 400 empty patch, and the sponsor stays archived (no back door)", async () => {
    const o = await rigOrg();
    const s = await rigSponsor(o);
    await archiveSponsor(o.auth, s.id);
    const at = await archivedAt(s.id);
    // The route parses the body first; archived_at is in no write schema, so it is stripped.
    const parsed = PatchSponsorInput.parse({ archived_at: null });
    expect(parsed, "stripped").toEqual({});
    expect(await refusal(() => patchSponsor(o.auth, s.id, parsed))).toMatchObject({ status: 400 });
    expect(await archivedAt(s.id), "still archived, same stamp").toBe(at);
  });

  it("unarchived: createDeal works and, immediate, goes live; resolveSponsors carries it again", async () => {
    const o = await rigOrg();
    const pkg = await rigPackage(o);
    const s = await rigSponsor(o);
    await sql`update sponsors set status = 'inactive' where id = ${s.id}`;
    await archiveSponsor(o.auth, s.id);
    await unarchiveSponsor(o.auth, s.id);
    const { deal: d } = await createDeal(o.auth, s.id, dealInput(pkg.id, { go_live: "immediate" }), ORIGIN);
    expect(d.deal_status, "goes live by its rule").toBe("live");
    expect((await stored(s.id))!.status, "the deal put its sponsor live").toBe("active");
    expect((await resolveSponsors(o.orgId)).map((r) => r.id), "shown publicly").toContain(s.id);
  });
});

describe.skipIf(!HAS_DB)("every plan, and only the org's own sponsors (spec D25, §9)", () => {
  it("Free org (no sponsors.tiers): archive and unarchive work; the archive takes the row off the free strip, the unarchive puts it back, a leftover Title row as partner", async () => {
    const o = await rigOrg({ plan: "community" });
    const partner = await createSponsor(o.auth, { name: `Corner Shop ${uniq()}`, tier: "partner", status: "active" });
    const [{ id: titleId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${`Old Title ${uniq()}`}, 'title', 'active') returning id`;
    let checked = 0;
    for (const id of [partner.id, titleId]) {
      expect(await refusal(() => archiveSponsor(o.auth, id)), "archive is ungated").toEqual(NO_REFUSAL);
      expect(await archivedAt(id)).not.toBeNull();
      const archivedStrip = (await resolveSponsors(o.orgId, undefined, { tiered: false })).map((r) => r.id);
      expect(archivedStrip, "archived: off the free strip (Task 4's filter)").not.toContain(id);
      expect(archivedStrip.length, "premise: the other row is still on it").toBe(1);
      expect(await refusal(() => unarchiveSponsor(o.auth, id)), "and so is unarchive").toEqual(NO_REFUSAL);
      expect(await archivedAt(id)).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
    const strip = await resolveSponsors(o.orgId, undefined, { tiered: false });
    expect(strip.find((r) => r.id === partner.id), "the free strip regains the row").toBeDefined();
    expect(strip.find((r) => r.id === titleId)?.tier, "the resolver's collapse is unchanged").toBe("partner");
  });

  it("Event Pass org: archive and unarchive work on the pass's competition sponsor", async () => {
    const o = await rigOrg({ plan: "community" });
    const compId = await competitionOf(o.orgId);
    await sql`insert into competition_passes (competition_id, org_id) values (${compId}, ${o.orgId})`;
    await invalidateOrgEntitlements(o.orgId);
    // The pass lifts sponsors.tiers on its own competition (the premise: the create is allowed there).
    const gold = await createSponsor(o.auth, { name: `Pass Gold ${uniq()}`, tier: "gold", competition_id: compId, status: "active" });
    const snapshot = await rowBytes(gold.id);
    expect(await refusal(() => archiveSponsor(o.auth, gold.id))).toEqual(NO_REFUSAL);
    expect(await archivedAt(gold.id)).not.toBeNull();
    expect(await refusal(() => unarchiveSponsor(o.auth, gold.id))).toEqual(NO_REFUSAL);
    expect(await rowBytes(gold.id), "as it was").toBe(snapshot);
    expect((await resolveSponsors(o.orgId, compId)).find((r) => r.id === gold.id)?.tier, "back on its competition, gold").toBe("gold");
  });

  it("another org's sponsor: archive and unarchive are 404, and its archived_at is unchanged; an unknown id is 404 too", async () => {
    const o = await rigOrg();
    const them = await rigOrg();
    const live = await rigSponsor(them);
    const archived = await rigSponsor(them);
    await archiveSponsor(them.auth, archived.id);
    const stamp = await archivedAt(archived.id);
    let checked = 0;
    for (const [label, call, id, want] of [
      ["archive theirs", archiveSponsor, live.id, null],
      ["unarchive theirs", unarchiveSponsor, archived.id, stamp],
      ["archive an unknown id", archiveSponsor, randomUUID(), null],
      ["unarchive an unknown id", unarchiveSponsor, randomUUID(), null],
    ] as const) {
      expect(await refusal(() => call(o.auth, id)), label).toMatchObject({ status: 404 });
      expect(await archivedAt(id), `${label}: archived_at unchanged`).toBe(want);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

/** The backends waiting on a lock held by any of `pids` (exact: a wait on anything else is not counted). */
const blockedBy = async (pids: number[]): Promise<number[]> =>
  (await sql<{ pid: number }[]>`
    select pid from pg_stat_activity
     where datname = current_database() and pg_blocking_pids(pid) && ${pids}::int[]`).map((r) => r.pid);
async function untilBlocked(pids: number[], n: number, label: string): Promise<number[]> {
  const deadline = Date.now() + 15_000;
  let found: number[] = [];
  while (Date.now() < deadline && (found = await blockedBy(pids)).length < n) await new Promise((r) => setTimeout(r, 25));
  expect(found.length, label).toBe(n);
  return found;
}

describe.skipIf(!HAS_DB)("archive racing Add deal under the sponsor lock (spec §9; sponsor-lock.test.ts's F16 witness)", () => {
  // A deal writer holds the sponsor lock (F2); both calls queue on it in a known order, and the row lock is granted first come,
  // first served. Whichever goes second must see the first's commit: never an archived sponsor with a deal, never neither.
  for (const first of ["archive", "add deal"] as const) {
    it(`${first} queued first: exactly one wins (the archive XOR the deal)`, async () => {
      const o = await rigOrg();
      const pkg = await rigPackage(o);
      const s = await rigSponsor(o);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let holderPid = 0;
      let ready!: () => void;
      const holding = new Promise<void>((r) => (ready = r));
      const holder = sql.begin(async (tx) => {
        await tx`select 1 from sponsors where id = ${s.id} for update`;
        holderPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
        ready();
        await gate;
      });
      holder.catch(() => undefined);
      // Both calls never reject (`refusal` catches), and both are awaited in `finally` too: a call still in flight must not
      // write after the suite's cleanup has run.
      const calls: Promise<unknown>[] = [];
      try {
        await holding;
        const archive = () => refusal(() => archiveSponsor(o.auth, s.id));
        const add = () => refusal(() => createDeal(o.auth, s.id, dealInput(pkg.id), ORIGIN));
        const a = first === "archive" ? archive() : add();
        calls.push(a);
        const [firstPid] = await untilBlocked([holderPid], 1, `${first} waits on the holder's sponsor lock`);
        const b = first === "archive" ? add() : archive();
        calls.push(b);
        await untilBlocked([holderPid, firstPid!], 2, "the second call queues behind it");
        release();
        await holder;
        const [ra, rb] = await Promise.all([a, b]);
        const isArchived = (await archivedAt(s.id)) !== null;
        const hasDeal = (await dealCount(s.id)) > 0;
        expect(isArchived !== hasDeal, `exactly one wins (archived ${isArchived}, deal ${hasDeal})`).toBe(true);
        if (first === "archive") {
          expect(ra, "the archive went first").toEqual(NO_REFUSAL);
          expect(rb, "the deal, re-checked under the lock, is refused").toEqual(ARCHIVED);
          expect(await lastNumber(o.orgId), "and used no invoice number").toBeNull();
        } else {
          expect(ra, "the deal went first").toEqual(NO_REFUSAL);
          expect(rb, "the archive, reading the deals under the lock, is refused").toEqual(HAS_CURRENT_DEAL);
        }
      } finally {
        release();
        await holder.catch(() => undefined);
        await Promise.all(calls);
      }
    });
  }
});
