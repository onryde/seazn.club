// The package half of the division SAVE (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.3, §7.4 item 2, §7.6; P14,
// P17; plan Task 6): the create door, the switch on and off, a size named on a save. REAL doors (`createDivision`,
// `patchDivision`, `payOnlinePackage`) against a REAL database (skipped without DATABASE_URL), each a tenant transaction as
// app_user with the package rows written in its privileged epilogue.
//
// Where the expected numbers come from — never from size.ts, quote.ts or the leaf's helpers:
//   * P14's default is "the smallest size that holds the places held" over the ladder 16/32/64/128/256 (Global Constraints):
//     none held → 16, 20 held → 32, 40 held → 64, typed here;
//   * the rounds each size includes are the Global Constraints' (16 → 6, 32 → 7, …, 256 → 10): 7 Swiss rounds need 32, 11
//     need more than any size;
//   * the plan caps are read from the catalogue as PREMISES only (community 64 ⇒ 128 is above it).
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`); the non-chess case is a refusal.
//
// Mutant table (each run once by hand; results in the commit message):
//   Z1 `effective.online_size` not deleted (a column that does not exist)   -> every patch naming a size
//   Z2 the re-send guard dropped (a stored lichess re-sent writes a row)    -> "re-sending onlinePlay lichess …"
//   Z3 the paid-row refusal dropped                                          -> "unpaid size change … a paid row refused"
//   Z4 the default computed as 16 regardless of places held                  -> "create … with entrants already, at sizeFor(held)"
//   Z5 the switch-off epilogue skipped (no refund, no delete)                -> "online off: …"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { createDivision, patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import {
  balance, buy, catalogue, CLOCK, divisionExists, expectBooks, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision,
  ocOrg, packageById, packagesOf, pay, refusal, seedEntrants, seedSwiss, spendTheMonth, suffix, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
  expect(await catalogue("community", "entrants.per_division.max"), "premise: community holds 64 a division, so 128 is above it").toBe(64);
  const pro = await catalogue("pro", "entrants.per_division.max");
  expect(pro === null || pro >= 256, "premise: pro allows every size").toBe(true);
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const ON = { variant: "classical", onlinePlay: "lichess", clock: CLOCK };
const OFF = { variant: "classical", onlinePlay: "off", clock: CLOCK };
const switchOn = (o: Org, id: string, extra: Record<string, unknown> = {}) => patchDivision(o.auth, id, { config: ON, ...extra });
const switchOff = (o: Org, id: string) => patchDivision(o.auth, id, { config: OFF });

describe.skipIf(!HAS_DB)("the create door writes the unpaid package (P14)", () => {
  it("create with onlinePlay lichess writes one unpaid row at 16; with entrants already, at sizeFor(held)", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    const d = await ocDivision(o, c);
    const rows = await packagesOf(d.id);
    expect(rows, "one row").toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 16, paid_at: null, frozen_at: null, refunded_at: null, credits_paid: 0, division_name: d.name });

    // A size named at create, and none for a division created off.
    const named = await ocDivision(o, c, { size: 64 });
    expect((await liveOf(named.id)).size).toBe(64);
    const off = await ocDivision(o, c, { online: false });
    expect(await packagesOf(off.id), "an over-the-board division has no package").toEqual([]);

    // "With entrants already": a division switched on while it holds places opens at the smallest size that holds them.
    let checked = 0;
    for (const [held, want] of [[20, 32], [40, 64]] as const) {
      const late = await ocDivision(o, c, { online: false });
      await seedEntrants(o.orgId, late.id, held);
      await switchOn(o, late.id);
      const live = await packagesOf(late.id);
      expect(live, `${held} held: one row`).toHaveLength(1);
      expect(live[0], `${held} held → ${want}`).toMatchObject({ size: want, paid_at: null });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("create refuses a size for a division that is not online, and one above the plan — and creates nothing", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    const name = `Nope ${suffix()}`;
    const err = await refusal(createDivision(o.auth, c, {
      name, sport_key: "boardgame", variant_key: "classical", config: { variant: "classical", clock: CLOCK }, online_size: 32,
    }));
    expect({ status: err.status, code: err.code, extra: err.extra }).toEqual({
      status: 422, code: ONLINE_PACKAGE_CODES.formatNotSupported, extra: { kind: null },
    });
    const community = await ocOrg("community");
    const cc = await ocCompetition(community);
    const e2 = await refusal(createDivision(community.auth, cc, {
      name, sport_key: "boardgame", variant_key: "classical", config: ON, online_size: 128,
    }));
    expect(e2).toBeInstanceOf(PaymentRequiredError);
    expect((e2 as PaymentRequiredError).featureKey).toBe("entrants.per_division.max");
    // The positive pair: 64 is within community's cap.
    const ok = await ocDivision(community, cc, { size: 64 });
    expect((await liveOf(ok.id)).size).toBe(64);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where name = ${name}`;
    expect(n, "neither refused create left a division").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("a save that names online play or a size", () => {
  it("re-sending onlinePlay lichess on a later save leaves the row untouched — unpaid and paid", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const d = await ocDivision(o, await ocCompetition(o));
    const before = await liveOf(d.id);
    await switchOn(o, d.id); // the Entrants and format saves re-send the whole config
    await patchDivision(o.auth, d.id, { name: `Renamed ${suffix()}` }); // and a save that names neither
    expect(await packagesOf(d.id), "the same one row, as it was").toEqual([before]);
    await pay(o, d.id, 32);
    const paid = await liveOf(d.id);
    await switchOn(o, d.id);
    await switchOn(o, d.id, { online_size: 32 }); // a re-send of the paid size: a no-op, never the paid refusal
    expect(await packagesOf(d.id)).toEqual([paid]);
    expect(await expectBooks(paid.id, "after the re-sends")).toBe(2);
  });

  it("unpaid size change: up, down, down below held refused; rounds need a size; a paid row refused by this door; frozen too", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const d = await ocDivision(o, await ocCompetition(o));
    const id = (await liveOf(d.id)).id;
    await sql`insert into registration_settings (division_id, org_id, enabled, capacity) values (${d.id}, ${o.orgId}, true, 50)`;
    const capacity = async () => (await sql<{ c: number | null }[]>`select capacity as c from registration_settings where division_id = ${d.id}`)[0]!.c;

    await patchDivision(o.auth, d.id, { online_size: 64 });
    expect((await liveOf(d.id))).toMatchObject({ id, size: 64, paid_at: null });
    expect(await capacity(), "50 fits in 64").toBe(50);
    await patchDivision(o.auth, d.id, { online_size: 32 });
    expect((await liveOf(d.id))).toMatchObject({ id, size: 32 });
    expect(await capacity(), "a stored capacity above the size is lowered to it (§7.4 item 2)").toBe(32);

    await seedEntrants(o.orgId, d.id, 20);
    const full = await refusal(patchDivision(o.auth, d.id, { online_size: 16 }));
    expect({ status: full.status, code: full.code, extra: full.extra }).toEqual({
      status: 422, code: ONLINE_PACKAGE_CODES.sizeFull, extra: { size: 16, nextSize: 32 },
    });
    // Back up to 64 (it holds the 20), so the size asked below differs from the row's: a re-send of the stored size is a no-op.
    await patchDivision(o.auth, d.id, { online_size: 64 });
    expect(await capacity(), "a capacity at or below the size is left").toBe(32);
    await seedSwiss(o.orgId, d.id, 7);
    const rounds = await refusal(patchDivision(o.auth, d.id, { online_size: 16 }));
    expect(rounds.code, "below the places held is judged first").toBe(ONLINE_PACKAGE_CODES.sizeFull);
    await seedSwiss(o.orgId, d.id, 1); // 8 rounds: 32 includes 7, 64 includes 8
    const need = await refusal(patchDivision(o.auth, d.id, { online_size: 32 }));
    expect({ status: need.status, code: need.code, extra: need.extra }).toEqual({
      status: 422, code: ONLINE_PACKAGE_CODES.roundsNeedSize, extra: { nextSize: 64 },
    });
    await seedSwiss(o.orgId, d.id, 3); // 11 rounds: more than 256's 10
    const max = await refusal(patchDivision(o.auth, d.id, { online_size: 256 }));
    expect({ status: max.status, code: max.code }).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.roundsAboveMax });
    expect((await liveOf(d.id)).size, "no refusal moved the row").toBe(64);
    // A re-send of the stored size is never refused, even with rounds it would not include now.
    await patchDivision(o.auth, d.id, { online_size: 64 });
    await sql`delete from stages where division_id = ${d.id}`;

    await pay(o, d.id, 32);
    const paid = await refusal(patchDivision(o.auth, d.id, { online_size: 64 }));
    expect({ status: paid.status, code: paid.code }).toEqual({ status: 409, code: "online_size_paid" });
    await freeze(id);
    const frozen = await refusal(patchDivision(o.auth, d.id, { online_size: 64 }));
    expect({ status: frozen.status, code: frozen.code }).toEqual({ status: 409, code: "online_size_frozen" });
    expect(await liveOf(d.id)).toMatchObject({ id, size: 32, credits_paid: gcPrice(32) });

    // Not online: a size is refused, and nothing is written.
    const off = await ocDivision(o, await ocCompetition(o), { online: false });
    const e = await refusal(patchDivision(o.auth, off.id, { online_size: 32 }));
    expect({ status: e.status, code: e.code }).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.formatNotSupported });
    expect(await packagesOf(off.id)).toEqual([]);
  });

  it("online off: paid → refunded row; unpaid → row deleted; frozen → left; on again → one new unpaid row at the default", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const c = await ocCompetition(o);

    // Unpaid: deleted, the division saved.
    const u = await ocDivision(o, c);
    const unpaid = await liveOf(u.id);
    const saved = await switchOff(o, u.id);
    expect((saved.config as Record<string, unknown>).onlinePlay, "the save landed").toBeUndefined();
    expect(await packageById(unpaid.id), "no 'closed, unpaid' row").toBeNull();

    // Paid: refunded in full, the row kept as history; on again a fresh unpaid row at the default, paid at the full price.
    const p = await ocDivision(o, c);
    await pay(o, p.id, 64);
    const paid = await liveOf(p.id);
    expect((await balance(o.orgId)).pack).toBe(10 - gcPrice(64));
    await switchOff(o, p.id);
    expect(await packageById(paid.id)).toMatchObject({ credits_refunded: gcPrice(64), division_id: p.id });
    expect((await packageById(paid.id))!.refunded_at).not.toBeNull();
    expect((await balance(o.orgId)).pack, "the 4 came back").toBe(10);
    await seedEntrants(o.orgId, p.id, 20);
    await switchOn(o, p.id);
    const fresh = await liveOf(p.id);
    expect(fresh.id).not.toBe(paid.id);
    expect(fresh, "20 held → 32, the earlier choice of 64 not remembered").toMatchObject({ size: 32, paid_at: null, credits_paid: 0 });
    const again = await pay(o, p.id, 32);
    expect(again.quote.owed, "the full price again").toBe(gcPrice(32));
    expect(await packagesOf(p.id), "the refunded row and the new one").toHaveLength(2);

    // Frozen: left as it is, and the switch-off still saves.
    const f = await ocDivision(o, c);
    await pay(o, f.id, 16);
    const held = await liveOf(f.id);
    await freeze(held.id);
    await switchOff(o, f.id);
    expect(await packageById(held.id)).toMatchObject({ credits_refunded: 0, refunded_at: null, credits_paid: gcPrice(16) });
    expect(await divisionExists(f.id)).toBe(true);
  });

  it("switching off is never flag-gated: the flag off, a paid division still switches off and is refunded", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    const paid = await liveOf(d.id);
    const was = process.env.ONLINE_CHESS_ALWAYS;
    delete process.env.ONLINE_CHESS_ALWAYS;
    forgetOnlineChessFlagCache();
    try {
      const on = await refusal(patchDivision(o.auth, (await ocDivisionOff(o)).id, { config: ON }));
      expect(on.code, "premise: the flag is off for this club").toBe("ONLINE_CHESS_DISABLED");
      await switchOff(o, d.id);
    } finally {
      process.env.ONLINE_CHESS_ALWAYS = was;
      forgetOnlineChessFlagCache();
    }
    expect(await packageById(paid.id)).toMatchObject({ credits_refunded: gcPrice(32) });
    expect((await balance(o.orgId)).pack).toBe(10);
  });
});

/** An over-the-board division, made while the flag is still on (the create door asks it only for an online one). */
async function ocDivisionOff(o: Org) {
  return ocDivision(o, await ocCompetition(o), { online: false });
}
