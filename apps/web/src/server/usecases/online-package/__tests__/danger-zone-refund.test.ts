// The danger zone's Online Chess read (spec 2026-11-23-online-chess-credits-design.md §11; final review m2 and Q7):
// `divisionPackageRefund` says what a refund of the division's paid, unfrozen package gives back and gives up NOW, and whether a
// DELETE would take it. The delete dialog shows the first; once the division has started, delete is refused and archive holds the
// package, so the archive copy sends the organiser to switch Online Chess off instead — and this file drives that promise through
// the real switch-off door. A PAID package a round has frozen reads as `{ frozen: true }` - no figure, only the fact, so the dialogs
// can say it is not refunded (Task 15 fix round 2, owner). REAL doors against a REAL database (skipped without DATABASE_URL).
//
// Expected numbers: the Global Constraints' price table (`gcPrice`), over buckets the case put there; and, for each case, the
// figure the read gave is checked against what the real door then gave back (never derived from the read's own arithmetic).
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   Z1 `onDelete` forced true (delete's rule dropped)                   -> "started: the delete would not refund …"
//   Z2 the frozen branch dropped from packageRefundPreview              -> "the empty cases …" (a frozen package shows a figure)
//   Z3 `back` = pack only (this month's included credits left out)      -> "this month's included credits come back …"
//   Z4 the other-org guard in packageRefundPreview dropped              -> "another org's paid package is never a figure …"
//   Z5 `onDelete` ignores archived_at                                   -> "paid, in setup: … archive keeps the figure …"
//   Z6 the frozen branch reads null (fix round 2: the dialogs went silent)  -> "the empty cases …" (paid and frozen), and
//      "the dialogs, rendered from the read" (paid and frozen)
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});
// The danger zone itself, rendered from this file's real read (fix round 2): its router and its DELETE are the only seams stubbed.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/client-v1")>()), apiV1: vi.fn() }));

import { sql } from "@/lib/db";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import uiEn from "@/dictionaries/en/ui.json";
import {
  archiveDivision, deleteDivision, divisionPackageRefund, patchDivision, restoreDivision, type DivisionPackageRefund,
} from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import {
  CLOCK, backdateOrgLedger, balance, buy, expectLeafPrices, freeze, freezeGrandfathered, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg, packageById,
  pay, refusal, spendTheMonth, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** The read's figure, where the case has just pinned it to a paid, unfrozen package's (a frozen or absent read is a failure here). */
function figureOf(r: DivisionPackageRefund | null): { back: number; forfeited: number } {
  if (r === null || r.frozen === true) throw new Error(`expected a refund figure, the read was ${JSON.stringify(r)}`);
  return r;
}

/** An org whose month is spent down to `left` included credits, holding `pack` bought credits. */
async function moneyOrg(pack: number, left = 0): Promise<Org> {
  const o = await ocOrg();
  await spendTheMonth(o.orgId, left);
  await buy(o.orgId, pack);
  return o;
}

describe.skipIf(!HAS_DB)("divisionPackageRefund: what the danger zone says a refund gives back", () => {
  it("paid, in setup: the figure is what the delete then gives back; archive keeps the figure but takes the delete away; a second read after the delete is null", async () => {
    const o = await moneyOrg(20);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 128);
    expect((await balance(o.orgId)).pack, "premise: the package drew bought credits only").toBe(20 - gcPrice(128));

    const shown = await divisionPackageRefund(o.auth, d.id);
    expect(shown).toEqual({ back: gcPrice(128), forfeited: 0, onDelete: true });
    // Archive holds the package (§11 "Division archived"): the same credits, but no delete takes them (a purge waits 30 days).
    await archiveDivision(o.auth, d.id);
    expect(await divisionPackageRefund(o.auth, d.id), "archived").toEqual({ back: gcPrice(128), forfeited: 0, onDelete: false });
    await restoreDivision(o.auth, d.id);
    expect(await divisionPackageRefund(o.auth, d.id), "restored").toEqual(shown);

    const p = await liveOf(d.id);
    await deleteDivision(o.auth, d.id);
    expect((await balance(o.orgId)).pack, "the delete gave back exactly the figure shown").toBe(20 - gcPrice(128) + figureOf(shown).back);
    expect(await packageById(p.id)).toMatchObject({ credits_refunded: figureOf(shown).back, credits_forfeited: figureOf(shown).forfeited });
    expect(await divisionPackageRefund(o.auth, d.id), "the second read: the division and its live package are gone").toBeNull();
  });

  it("the empty cases: no package (over the board), unpaid, unpaid-and-frozen — nothing to show; paid and frozen — no figure, only `frozen`", async () => {
    const o = await moneyOrg(10);
    const c = await ocCompetition(o);
    let checked = 0;
    const otb = await ocDivision(o, c, { online: false });
    expect(await divisionPackageRefund(o.auth, otb.id), "over the board: no package").toBeNull();
    checked += 1;
    const unpaid = await ocDivision(o, c);
    expect((await liveOf(unpaid.id)).paid_at, "premise: an unpaid package").toBeNull();
    expect(await divisionPackageRefund(o.auth, unpaid.id), "unpaid: deleted with no money").toBeNull();
    checked += 1;
    const frozen = await ocDivision(o, c);
    await pay(o, frozen.id, 16);
    // The positive pair before the freeze: the same division shows a figure while it is unfrozen.
    expect(await divisionPackageRefund(o.auth, frozen.id), "paid, before the freeze").toEqual({ back: gcPrice(16), forfeited: 0, onDelete: true });
    await freeze((await liveOf(frozen.id)).id);
    expect(await divisionPackageRefund(o.auth, frozen.id), "paid and frozen: a round opened, never refunded (P7) - and the dialogs say so")
      .toEqual({ frozen: true });
    checked += 1;
    // Frozen but never paid (V560's backfill froze divisions that had opened a round before packages existed): no money was paid, so
    // there is nothing to say "is not refunded" about.
    const grandfathered = await ocDivision(o, c);
    await freezeGrandfathered((await liveOf(grandfathered.id)).id);
    expect((await liveOf(grandfathered.id)).frozen_at, "premise: frozen").not.toBeNull();
    expect(await divisionPackageRefund(o.auth, grandfathered.id), "unpaid and frozen: nothing to show").toBeNull();
    checked += 1;
    expect(checked).toBe(4);
  });

  it("started: the delete would not refund (it is refused) — switching Online Chess off gives back exactly the figure shown", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    const p = await liveOf(d.id);
    // Started (Start moves a division out of setup; the precondition, not a seam under test).
    await sql`update divisions set status = 'active' where id = ${d.id}`;
    const shown = await divisionPackageRefund(o.auth, d.id);
    expect(shown).toEqual({ back: gcPrice(32), forfeited: 0, onDelete: false });
    const refused = await refusal(deleteDivision(o.auth, d.id));
    expect(refused.code, "premise: delete is refused once the division has started").toBe("DIVISION_HAS_RESULTS");
    expect((await balance(o.orgId)).pack, "nothing came back from the refused delete").toBe(10 - gcPrice(32));

    // The copy's promise: switch Online Chess off (the Division rules save), and the credits come back.
    await patchDivision(o.auth, d.id, { config: { variant: "classical", onlinePlay: "off", clock: CLOCK } });
    expect((await balance(o.orgId)).pack, "switching off gave back exactly the figure shown").toBe(10 - gcPrice(32) + figureOf(shown).back);
    expect(await packageById(p.id)).toMatchObject({ credits_refunded: figureOf(shown).back, credits_forfeited: 0 });
    expect(await divisionPackageRefund(o.auth, d.id), "after the switch-off: nothing left to refund").toBeNull();
  });

  it("this month's included credits come back; an earlier month's included credits are the figure that does not", async () => {
    // This month: 1 included credit left and 20 bought, so a 32 draws 1 included and the rest bought (monthly first).
    const price = gcPrice(32);
    expect(price, "premise: the 32 costs more than the one included credit").toBeGreaterThan(1);
    const now = await moneyOrg(20, 1);
    const a = await ocDivision(now, await ocCompetition(now));
    await pay(now, a.id, 32);
    expect(await balance(now.orgId), "premise: 1 included and the rest bought were drawn").toMatchObject({ monthly: 0, pack: 20 - (price - 1) });
    expect(await divisionPackageRefund(now.auth, a.id), "same month: everything comes back").toEqual({ back: price, forfeited: 0, onDelete: true });

    // The same payment, then the month turns: the included credit is an earlier month's, and only the bought ones come back.
    const then = await moneyOrg(20, 1);
    const b = await ocDivision(then, await ocCompetition(then));
    await pay(then, b.id, 32);
    await backdateOrgLedger(then.orgId);
    const shown = await divisionPackageRefund(then.auth, b.id);
    expect(shown).toEqual({ back: price - 1, forfeited: 1, onDelete: true });
    const p = await liveOf(b.id);
    await deleteDivision(then.auth, b.id);
    expect(await packageById(p.id), "the delete gave back and gave up exactly what was shown")
      .toMatchObject({ credits_refunded: figureOf(shown).back, credits_forfeited: figureOf(shown).forfeited });
  });

  it("another org's paid package is never a figure: a named 500 (the page proves its division first)", async () => {
    const victim = await moneyOrg(10);
    const d = await ocDivision(victim, await ocCompetition(victim));
    await pay(victim, d.id, 16);
    const attacker = await ocOrg();
    const err = await refusal(divisionPackageRefund(attacker.auth, d.id));
    expect({ status: err.status, code: err.code }).toEqual({ status: 500, code: "online_package_not_of_org" });
    // The positive pair: its own org reads it.
    expect(await divisionPackageRefund(victim.auth, d.id)).toEqual({ back: gcPrice(16), forfeited: 0, onDelete: true });
    // Frozen too: "a round has opened" is a fact about another org's division, never told to this one.
    await freeze((await liveOf(d.id)).id);
    const frozenErr = await refusal(divisionPackageRefund(attacker.auth, d.id));
    expect({ status: frozenErr.status, code: frozenErr.code }).toEqual({ status: 500, code: "online_package_not_of_org" });
    expect(await divisionPackageRefund(victim.auth, d.id)).toEqual({ frozen: true });
  });
});

describe.skipIf(!HAS_DB)("the dialogs, rendered from the read (fix round 2): what the organiser is told, per package state", () => {
  const en = uiEn as Record<string, string>;
  const credits = (base: string, n: number) => en[`${base}.${n === 1 ? "one" : "other"}`]!.replaceAll("{count}", String(n));
  /** Every money sentence the danger zone can say, as fragments (the count-free head of each plural). */
  const MONEY = [en["danger.refundedLabel"]!, en["danger.onlineFrozen"]!, ...["one", "other"].flatMap((f) => [
    en[`danger.onlineRefund.${f}`]!.split("{count}")[0]!, en[`danger.archiveOnline.${f}`]!.split("{count}")[0]!,
  ])];
  const zone = (o: Org, divisionId: string, packageRefund: DivisionPackageRefund | null) =>
    renderIsland(DivisionDangerZone, { divisionId, divisionName: "Open", orgSlug: o.orgId, compSlug: "c", packageRefund });
  type Zone = ReturnType<typeof zone>;
  const body = (z: Zone, confirmKey: "danger.deleteConfirm" | "danger.archiveConfirm"): string => {
    const dialog = z.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en[confirmKey]);
    if (!dialog) throw new Error(`${confirmKey} dialog not found`);
    return textOf(propsOf(dialog).children as ReactNode);
  };
  /** The refused DELETE of a started division, as the real door answers it, landing in the dialog (it pivots to archive). */
  async function pivot(z: Zone, o: Org, divisionId: string): Promise<void> {
    const refused = await refusal(deleteDivision(o.auth, divisionId));
    expect(refused.code, "premise: the real delete refuses a started division").toBe("DIVISION_HAS_RESULTS");
    vi.mocked(apiV1).mockRejectedValueOnce(new ApiV1Error(refused.message, 409, "DIVISION_HAS_RESULTS", { archive: true }));
    const dialog = z.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en["danger.deleteConfirm"])!;
    (propsOf(dialog).onConfirm as () => void)();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(propsOf(z.tree().find((el: ReactElement) => propsOf(el).confirmLabel === en["danger.archiveConfirm"])!).open, "it pivoted").toBe(true);
  }

  it("paid and unfrozen, started: the archive dialog and the pivot say the read's credits can still come back, led by why; the delete dialog promises nothing", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    await sql`update divisions set status = 'active' where id = ${d.id}`;
    const read = await divisionPackageRefund(o.auth, d.id);
    expect(read, "the read: the price table's 32, nothing forfeited, no delete").toEqual({ back: gcPrice(32), forfeited: 0, onDelete: false });
    const back = figureOf(read).back;
    const z = zone(o, d.id, read);
    for (const f of MONEY) expect(body(z, "danger.deleteConfirm"), `delete: ${f}`).not.toContain(f);
    expect(body(z, "danger.archiveConfirm")).toContain(credits("danger.archiveOnline", back));
    expect(body(z, "danger.archiveConfirm")).not.toContain(en["danger.onlineFrozen"]);
    await pivot(z, o, d.id);
    const p = body(z, "danger.archiveConfirm");
    expect(p).toContain(en["danger.suggestArchive"]);
    expect(p.indexOf(credits("danger.archiveOnline", back)), "the money line follows the results sentence").toBeGreaterThan(p.indexOf(en["danger.suggestArchive"]!));
  });

  it("paid and frozen (a round has opened): the delete dialog, the archive dialog and the pivot say it is not refunded, and nothing else about money", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 16);
    await sql`update divisions set status = 'active' where id = ${d.id}`;
    await freeze((await liveOf(d.id)).id);
    const read = await divisionPackageRefund(o.auth, d.id);
    expect(read).toEqual({ frozen: true });
    const z = zone(o, d.id, read);
    const others = MONEY.filter((f) => f !== en["danger.onlineFrozen"]);
    let checked = 0;
    for (const key of ["danger.deleteConfirm", "danger.archiveConfirm"] as const) {
      expect(body(z, key), key).toContain(en["danger.onlineFrozen"]);
      for (const f of others) expect(body(z, key), `${key}: ${f}`).not.toContain(f);
      checked += 1;
    }
    await pivot(z, o, d.id);
    expect(body(z, "danger.archiveConfirm")).toContain(en["danger.suggestArchive"]);
    expect(body(z, "danger.archiveConfirm")).toContain(en["danger.onlineFrozen"]);
    checked += 1;
    expect(checked).toBe(3);
  });

  it("no package, or unpaid: no money line in either dialog", async () => {
    const o = await moneyOrg(10);
    const c = await ocCompetition(o);
    let checked = 0;
    for (const d of [await ocDivision(o, c, { online: false }), await ocDivision(o, c)]) {
      const read = await divisionPackageRefund(o.auth, d.id);
      expect(read).toBeNull();
      const z = zone(o, d.id, read);
      for (const key of ["danger.deleteConfirm", "danger.archiveConfirm"] as const) {
        for (const f of MONEY) expect(body(z, key), `${key}: ${f}`).not.toContain(f);
      }
      checked += 1;
    }
    expect(checked, "over the board, unpaid").toBe(2);
  });
});
