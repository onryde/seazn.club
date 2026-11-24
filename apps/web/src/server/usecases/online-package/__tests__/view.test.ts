// The Division rules strip's read of a division's Online Chess package (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6;
// plan Task 11): what the "Players, up to" select, its price line and the format refusal are drawn from, in ONE server read so the
// page and the quote cannot judge different facts. Runs against a REAL migrated database and is skipped without DATABASE_URL.
//
// Where the expected numbers come from - never from view.ts: the sizes and prices are the Global Constraints' table (`gcPrice`,
// checked against the leaf by `expectLeafPrices`), places held and rounds are what the test SEEDED, the plan cap is the catalogue's
// own row, and the balance is what the test BOUGHT less what the real payment door took.
//
// single-sport: Online Chess is boardgame only (online-play.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { onlinePackageView } from "../view";
import {
  balance, buy, catalogue, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg, pay, seedEntrants, seedStageKind,
  seedSwiss, spendTheMonth, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(async () => {
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

/** An org holding exactly `credits` bought credits (this month's included ones spent), with a competition and an online division. */
async function setup(credits: number, opts: { online?: boolean } = {}): Promise<{ o: Org; competitionId: string; divisionId: string }> {
  const o = await ocOrg();
  await spendTheMonth(o.orgId, 0);
  if (credits > 0) await buy(o.orgId, credits);
  const competitionId = await ocCompetition(o);
  const d = await ocDivision(o, competitionId, { online: opts.online });
  return { o, competitionId, divisionId: d.id };
}
const view = (s: { o: Org; competitionId: string; divisionId: string }) =>
  onlinePackageView({ orgId: s.o.orgId, competitionId: s.competitionId, divisionId: s.divisionId });

describe.skipIf(!HAS_DB)("onlinePackageView: the strip's facts about a division's package", () => {
  it("an online division with an unpaid package: its size, the places held, the rounds, the stage kinds and the balance", async () => {
    const s = await setup(7);
    await seedEntrants(s.o.orgId, s.divisionId, 3);
    await seedSwiss(s.o.orgId, s.divisionId, 5);
    const v = await view(s);
    expect(v.stored).toEqual({ size: 16, paid: null, frozen: false }); // P14: the default is the smallest size, 16, for 3 places held
    expect(v.held).toBe(3);
    expect(v.rounds).toBe(5);
    expect(v.stageKinds).toEqual(["swiss"]);
    expect(v.cameras).toBe(false);
    expect(v.balance).toBe(7);
    expect(v.planCap).toBe(await catalogue("pro", "entrants.per_division.max"));
  });

  it("the empty case: a division with no stage and no entrant reads zero places, zero rounds and no stage kind", async () => {
    const s = await setup(0);
    const v = await view(s);
    expect({ held: v.held, rounds: v.rounds, kinds: v.stageKinds, balance: v.balance }).toEqual({ held: 0, rounds: 0, kinds: [], balance: 0 });
    expect(v.stored).toEqual({ size: 16, paid: null, frozen: false });
  });

  it("a division that does not play online has no stored package", async () => {
    const s = await setup(5, { online: false });
    const v = await view(s);
    expect(v.stored).toBeNull();
    expect(v.balance).toBe(5);
  });

  it("stage kinds come back in stage order, every kind the division holds (the format refusal reads them)", async () => {
    const s = await setup(0);
    await seedSwiss(s.o.orgId, s.divisionId, 4);
    await seedStageKind(s.o.orgId, s.divisionId, "knockout");
    await seedStageKind(s.o.orgId, s.divisionId, "league");
    expect((await view(s)).stageKinds).toEqual(["swiss", "knockout", "league"]);
  });

  it("a PAID package: the size paid for, whether its cameras were, and the balance after the payment", async () => {
    const s = await setup(9);
    await pay(s.o, s.divisionId, 32);
    const v = await view(s);
    expect(v.stored).toEqual({ size: 32, paid: { size: 32, camerasPaid: false }, frozen: false });
    expect(v.balance).toBe(9 - gcPrice(32));
    expect((await balance(s.o.orgId)).total).toBe(9 - gcPrice(32)); // premise: the real ledger agrees
  });

  it("a FROZEN package reads frozen, its paid state kept", async () => {
    const s = await setup(9);
    await pay(s.o, s.divisionId, 16);
    await freeze((await liveOf(s.divisionId)).id);
    expect((await view(s)).stored).toEqual({ size: 16, paid: { size: 16, camerasPaid: false }, frozen: true });
  });

  it("cameras follow the division's effective camera policy (P9), never the paid state", async () => {
    const s = await setup(0);
    expect((await view(s)).cameras).toBe(false);
    await patchDivision(s.o.auth, s.divisionId, { camera_policy: "optional" });
    expect((await view(s)).cameras).toBe(true);
    await patchDivision(s.o.auth, s.divisionId, { camera_policy: "off" });
    expect((await view(s)).cameras).toBe(false);
  });

  it("the plan cap is the plan's: a community org reads 64, not the pro org's", async () => {
    const o = await ocOrg("community");
    const competitionId = await ocCompetition(o);
    const d = await ocDivision(o, competitionId);
    const v = await onlinePackageView({ orgId: o.orgId, competitionId, divisionId: d.id });
    expect(v.planCap).toBe(await catalogue("community", "entrants.per_division.max"));
    expect(v.planCap).toBe(64); // typed from the spec (community holds 64 a division)
  });

  it("a division of another org is not found, and nothing about it is read", async () => {
    const mine = await setup(0);
    const other = await setup(0);
    await expect(onlinePackageView({ orgId: other.o.orgId, competitionId: other.competitionId, divisionId: mine.divisionId })).rejects.toMatchObject({ status: 404 });
  });
});
