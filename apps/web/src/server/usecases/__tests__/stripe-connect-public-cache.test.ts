// Walk-fix A review m2 - a Connect charges flip expires the org's public pages. Real Postgres; skipped without DATABASE_URL.
//
// Whether card divisions can take entries (and so the hub's "Register" slot, its "registration opens once payment setup is
// finished" sentence, and each division's open state) is read from `organizations.stripe_charges_enabled`, which only
// `syncConnectAccount` writes. The hub document is cached under the org's public tag (`orgTag`, competition-hub.ts
// `pub-hub-v5`, REVALIDATE_FAST), and on Fly a suspended machine's cache clock does not run - 32 minutes of staleness was
// measured on stg (2026-10-14). So the sync must expire that tag itself when the flag changes, and only then: account.updated
// fires for every requirement change, and each bust also purges the CDN.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath: vi.fn() }));
vi.mock("@/lib/peer-revalidate", () => ({ broadcastRevalidate: vi.fn(async () => {}) }));
vi.mock("@/lib/cdn-purge", () => ({ purgeCdn: vi.fn(async () => {}) }));

import { sql } from "@/lib/db";
import { orgTag } from "@/server/public-site/cache-tags";
import { syncConnectAccount } from "../stripe-connect";
import { seedOrg } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** The fields syncConnectAccount reads, as Stripe sends them on account.updated. */
const account = (id: string, charges_enabled: boolean) =>
  ({
    id,
    charges_enabled,
    payouts_enabled: charges_enabled,
    default_currency: "gbp",
    requirements: { disabled_reason: charges_enabled ? null : "requirements.past_due", currently_due: [] },
  }) as unknown as Stripe.Account;

beforeEach(() => revalidateTag.mockClear());

describe.skipIf(!HAS_DB)("syncConnectAccount expires the org's public pages when card charging flips (walk-fix m2)", () => {
  it("off->on busts, a repeat sync does not, on->off busts again; an account no org holds busts nothing", async () => {
    const { orgId, orgSlug } = await seedOrg("pro");
    const acct = "acct_" + randomUUID().slice(0, 12);
    await sql`update organizations set stripe_account_id = ${acct}, stripe_charges_enabled = false where id = ${orgId}`;
    const busts = () => revalidateTag.mock.calls.filter(([tag]) => tag === orgTag(orgSlug));

    const steps: { label: string; charges: boolean; busts: number }[] = [
      { label: "off -> on", charges: true, busts: 1 },
      { label: "on again (second call, nothing changed)", charges: true, busts: 0 },
      { label: "on -> off", charges: false, busts: 1 },
      { label: "off again", charges: false, busts: 0 },
    ];
    let checked = 0;
    for (const s of steps) {
      revalidateTag.mockClear();
      await syncConnectAccount(account(acct, s.charges));
      const [row] = await sql<{ stripe_charges_enabled: boolean }[]>`select stripe_charges_enabled from organizations where id = ${orgId}`;
      expect(row!.stripe_charges_enabled, s.label).toBe(s.charges);
      expect(busts().length, s.label).toBe(s.busts);
      // Expired, not stale-while-revalidate: the next visitor must read the new state (fireOrgRevalidate's profile).
      for (const call of busts()) expect(call[1], s.label).toEqual({ expire: 0 });
      checked++;
    }
    expect(checked).toBe(steps.length);

    // Empty case: an account that belongs to no org here writes nothing and expires nothing.
    revalidateTag.mockClear();
    await syncConnectAccount(account("acct_" + randomUUID().slice(0, 12), true));
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
