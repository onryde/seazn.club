// The Fair-play camera is priced before round 1 (spec 2026-11-23-online-chess-credits-design.md §3 decisions 5, 13, §7.6 "Camera policy
// save while frozen_at is null", P9, P19; plan Task 8): a camera policy save that turns cameras ON for a division whose package is
// PAID without cameras is refused 422 ONLINE_CAMERAS_NEED_UPGRADE (the division, its name and the difference), until the camera price
// is paid (the receipt's "Fair-play camera: Yes", Task 15); unpaid divisions take any policy (the quote follows: it derives cameras every
// time); turning cameras OFF here is never refused and returns nothing, and back ON is free once the camera price is paid (P19 - the
// receipt's No is the door that returns it). Once the package freezes the gate is not asked.
// REAL doors against a REAL database (skipped without DATABASE_URL).
//
// Where the expected numbers come from — never from the gate:
//   * Global Constraints' price table (16 → 1 / 2, 32 → 2 / 4, 64 → 4 / 8 credits without / with cameras): the difference `owed`
//     is the table's cameras column minus its plain column (32 → 2, 64 → 4). The REAL quote (`onlinePackageQuote` answered Yes)
//     is the cross-check: the gate says to pay exactly what the receipt will ask.
//
// FALSE PREMISE of the brief, recorded: there is NO stage-level and NO competition-level camera save in the product (the competition
// PATCH and the stage PATCH carry no camera field; `stages.camera_policy` and `competitions.camera_policy` have no writer, only a
// seed). The one door is the division save. The multi-division judgement is therefore proven on the shared helper itself
// (`divisionsNeedingCameraUpgrade`, which such a door will call after its write) with the competition floor set by SQL.
//
// single-sport: cameras exist for boardgame (online chess) only; a division that is not online is the other-case.
//
// Mutant table (each run once by hand; results in the commit message):
//   C1 the camera gate removed from the division save                               -> "paid without cameras: refused …"
//   C2 the helper ignores `cameras_paid` (a paid camera price still listed)         -> "after the camera answered Yes is paid …", the competition list
//   C3 the helper ignores `frozen_at`                                                -> "frozen (a round opened): the gate is not asked"
//   C4 the helper lists an UNPAID row                                                -> "an unpaid online division takes any policy"
//   C5 the gate asked on every camera save, not only on off -> on                    -> "the cameras stay on …"
//   C6 `owed` the camera price alone, not the difference                             -> "owed", the 16/64 differences
//   C7 the helper's list in the order read, not ascending by id                      -> "the competition-level judgement"
//   C8 the helper lists a division whose derived cameras are off                     -> the paid division that keeps its own policy off
//   C9 the helper takes no division locks                                            -> "one division lock per distinct id"
//   C10 a repeated id judged twice (no dedupe)                                        -> the lock count and the list
//   C11 the camera gate asked of a save that turns online play OFF (fix round 1, M-1)  -> "a save that turns online play OFF …"
//   C12 the camera gate skipped on every save that names online play (not only off)    -> "online play re-sent ON is still asked"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { ONLINE_PACKAGE_CODES, type OnlineSize } from "@/lib/online-chess-package";
import { patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { onlinePackageQuote, payOnlinePackage } from "@/server/usecases/online-package";
import { assertCamerasPaidFor, divisionsNeedingCameraUpgrade } from "@/server/usecases/online-package/format";
import { CAMERA_POLICY_CHANGED } from "@/server/external-play/camera-policy";
import {
  balance, buy, CLOCK, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg, packagesOf, pay, refusal, spendTheMonth, suffix, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** The camera column of the table minus the plain column: what adding cameras to a PAID size costs (Global Constraints). */
const cameraDifference = (size: OnlineSize): number => gcPrice(size, true) - gcPrice(size);

const storedPolicy = async (id: string) => (await sql<{ p: string | null }[]>`select camera_policy as p from divisions where id = ${id}`)[0]!.p;
const auditRows = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from competition_events where type = ${CAMERA_POLICY_CHANGED} and payload->>'divisionId' = ${id}`)[0]!.n;
const shape = (e: { status: number; code?: string; extra?: Record<string, unknown> }) => ({ status: e.status, code: e.code, extra: e.extra });

/** An org with bought credits, a competition and ONE online division paid at `size` without cameras. */
async function paidWithoutCameras(size: OnlineSize = 32): Promise<{ o: Org; competitionId: string; id: string; name: string }> {
  const o = await ocOrg();
  await spendTheMonth(o.orgId);
  await buy(o.orgId, 20);
  const competitionId = await ocCompetition(o);
  const d = await ocDivision(o, competitionId);
  await pay(o, d.id, size);
  const row = await liveOf(d.id);
  expect(row, "premise: paid at the size, cameras not paid").toMatchObject({ size, cameras_paid: false });
  expect(row.paid_at, "premise: paid").not.toBeNull();
  return { o, competitionId, id: d.id, name: d.name };
}

describe.skipIf(!HAS_DB)("an unpaid online division takes any policy, and the quote follows", () => {
  it("optional and required are saved; the price doubles (Global Constraints: 16 costs 1, 2 with cameras); off is saved", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    expect((await onlinePackageQuote(o.auth, d.id, 16)).price, "premise: 16 without cameras").toBe(gcPrice(16));
    let checked = 0;
    for (const policy of ["optional", "required"] as const) {
      await patchDivision(o.auth, d.id, { camera_policy: policy });
      expect(await storedPolicy(d.id), `${policy} saved`).toBe(policy);
      const q = await onlinePackageQuote(o.auth, d.id, 16);
      expect({ cameras: q.cameras, price: q.price, owed: q.owed }, policy).toEqual({ cameras: true, price: gcPrice(16, true), owed: gcPrice(16, true) });
      await patchDivision(o.auth, d.id, { camera_policy: "off" });
      expect((await onlinePackageQuote(o.auth, d.id, 16)).price, `${policy} then off: back to the plain price`).toBe(gcPrice(16));
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("a PAID division without cameras", () => {
  it("is refused ONLINE_CAMERAS_NEED_UPGRADE with this division, its name and the difference; nothing is written; the package still covers", async () => {
    const { o, id, name } = await paidWithoutCameras(32);
    const before = await liveOf(id);
    const ledger = await balance(o.orgId);
    expect(cameraDifference(32), "premise: the table's difference at 32").toBe(2);
    let checked = 0;
    for (const policy of ["optional", "required"] as const) {
      const err = await refusal(patchDivision(o.auth, id, { camera_policy: policy }));
      expect(shape(err), policy).toEqual({
        status: 422,
        code: ONLINE_PACKAGE_CODES.camerasNeedUpgrade,
        extra: { divisions: [{ id, name, owed: cameraDifference(32) }] },
      });
      expect(await storedPolicy(id), `${policy}: the policy was not written`).toBeNull();
      expect(await auditRows(id), `${policy}: no audit row of a change that did not happen`).toBe(0);
      expect(await liveOf(id), `${policy}: the package row is as it was`).toEqual(before);
      expect(await balance(o.orgId), `${policy}: no credits moved`).toEqual(ledger);
      checked += 1;
    }
    expect(checked).toBe(2);
    // The refusal is the receipt's: it asks for what the real quote answered Yes owes.
    expect((await onlinePackageQuote(o.auth, id, 32, true)).owed, "the gate says what the receipt will ask").toBe(cameraDifference(32));
    expect((await onlinePackageQuote(o.auth, id, 32)).covers, "and the paid package still covers the division").toBe(true);
  });

  it("the difference is the camera column minus the plain one, at every size (16 → 1, 64 → 4)", async () => {
    let checked = 0;
    for (const size of [16, 64] as const) {
      const { o, id } = await paidWithoutCameras(size);
      const err = await refusal(patchDivision(o.auth, id, { camera_policy: "required" }));
      expect(err.extra, `${size}`).toMatchObject({ divisions: [{ owed: cameraDifference(size) }] });
      expect(cameraDifference(size), `premise: the table's difference at ${size}`).toBe(size === 16 ? 1 : 4);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("turning cameras OFF is never refused, and back ON is refused again (nothing was paid)", async () => {
    const { o, id } = await paidWithoutCameras(32);
    await patchDivision(o.auth, id, { camera_policy: "off" });
    expect(await storedPolicy(id), "off is saved").toBe("off");
    const err = await refusal(patchDivision(o.auth, id, { camera_policy: "required" }));
    expect(err.code).toBe(ONLINE_PACKAGE_CODES.camerasNeedUpgrade);
    expect(await storedPolicy(id), "and still off").toBe("off");
  });

  it("a save that turns online play OFF is never asked about cameras: it is stored and the package is refunded in full (M-1)", async () => {
    const { o, id } = await paidWithoutCameras(32);
    const before = await liveOf(id);
    const ledger = await balance(o.orgId);
    // The premise: the camera save ALONE is refused on this division, so the gate is in play and the switch-off is what excuses it.
    expect((await refusal(patchDivision(o.auth, id, { camera_policy: "required" }))).code, "premise: cameras alone are refused").toBe(
      ONLINE_PACKAGE_CODES.camerasNeedUpgrade,
    );
    expect(await storedPolicy(id), "premise: the refused save wrote nothing").toBeNull();
    const playMode = async () => (await sql<{ mode: string | null }[]>`select config->>'onlinePlay' as mode from divisions where id = ${id}`)[0]!.mode;
    expect(await playMode(), "premise: the division plays online").toBe("lichess");

    await patchDivision(o.auth, id, { config: { variant: "classical", onlinePlay: "off", clock: CLOCK }, camera_policy: "required" });

    expect(await storedPolicy(id), "the policy was stored with the switch-off").toBe("required");
    expect(await playMode(), "online play is off (the stored config no longer says lichess)").not.toBe("lichess");
    const rows = await packagesOf(id);
    expect(rows, "the one package row stands, refunded").toHaveLength(1);
    expect(rows[0]!.refunded_at, "refunded").not.toBeNull();
    expect(rows[0]!.credits_refunded + rows[0]!.credits_forfeited, "in full: what was paid comes back").toBe(before.credits_paid);
    expect(before.credits_paid, "premise: what was paid is the table's price at 32").toBe(gcPrice(32));
    expect((await balance(o.orgId)).total, "the credits are back in the org's balance").toBe(ledger.total + gcPrice(32));
  });

  it("online play re-sent ON is still asked: only a switch-off excuses the camera gate", async () => {
    const { o, id } = await paidWithoutCameras(32);
    const before = await liveOf(id);
    const ledger = await balance(o.orgId);
    const err = await refusal(
      patchDivision(o.auth, id, { config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK }, camera_policy: "required" }),
    );
    expect(err.code).toBe(ONLINE_PACKAGE_CODES.camerasNeedUpgrade);
    expect(await storedPolicy(id), "the policy was not written").toBeNull();
    expect(await liveOf(id), "the package row is as it was").toEqual(before);
    expect(await balance(o.orgId), "no credits moved").toEqual(ledger);
  });

  it("an unrelated save of a paid division is never asked: a rename, a re-sent camera policy, a clear to inherit", async () => {
    const { o, id } = await paidWithoutCameras(32);
    await patchDivision(o.auth, id, { name: `Renamed ${suffix()}` });
    await patchDivision(o.auth, id, { camera_policy: null }); // the stored value again: not a change
    await patchDivision(o.auth, id, { camera_policy: "off" });
    await patchDivision(o.auth, id, { camera_policy: "off" }); // a re-send of the stored value
    await patchDivision(o.auth, id, { camera_policy: null }); // back to inherit: effective stays off
    expect(await storedPolicy(id)).toBeNull();
  });

  it("after the camera answered Yes is paid the policy save goes through, off and back on cost nothing more (P19)", async () => {
    const { o, id } = await paidWithoutCameras(32);
    const shown = await onlinePackageQuote(o.auth, id, 32, true);
    expect(shown.owed, "premise: the camera price is owed").toBe(cameraDifference(32));
    const paid = await payOnlinePackage(o.auth, id, { size: 32, expectedOwed: shown.owed, cameras: true });
    expect(paid.applied).toBe(true);
    expect((await liveOf(id)).cameras_paid, "cameras are paid").toBe(true);
    expect(await storedPolicy(id), "Task 15: the Yes wrote the division's setting in the payment").toBe("required");

    const credits = await balance(o.orgId);
    await patchDivision(o.auth, id, { camera_policy: "required" });
    expect(await storedPolicy(id)).toBe("required");
    await patchDivision(o.auth, id, { camera_policy: "off" });
    await patchDivision(o.auth, id, { camera_policy: "optional" });
    expect(await storedPolicy(id), "back on is free").toBe("optional");
    expect(await balance(o.orgId), "no credit moved through the saves").toEqual(credits);
    expect((await liveOf(id)).cameras_paid, "a paid camera price is never lowered").toBe(true);
  });

  it("a division that pays with the policy already on has paid the cameras: the policy save is free", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    await patchDivision(o.auth, d.id, { camera_policy: "required" });
    await pay(o, d.id, 32);
    expect((await liveOf(d.id)).cameras_paid, "premise: paid with cameras").toBe(true);
    await patchDivision(o.auth, d.id, { camera_policy: "off" });
    await patchDivision(o.auth, d.id, { camera_policy: "required" });
    expect(await storedPolicy(d.id)).toBe("required");
  });

  it("frozen (a round opened): the gate is not asked", async () => {
    const { o, id } = await paidWithoutCameras(32);
    expect((await refusal(patchDivision(o.auth, id, { camera_policy: "required" }))).code, "premise: refused while unfrozen").toBe(
      ONLINE_PACKAGE_CODES.camerasNeedUpgrade,
    );
    await freeze((await liveOf(id)).id);
    await patchDivision(o.auth, id, { camera_policy: "required" });
    expect(await storedPolicy(id)).toBe("required");
  });

  it("the cameras stay on: with the competition already on required (a state no door writes), loosening to optional is not a turn-on, off is allowed, and back on is refused", async () => {
    const { o, id, competitionId } = await paidWithoutCameras(32);
    await sql`update competitions set camera_policy = 'required' where id = ${competitionId}`;
    await patchDivision(o.auth, id, { camera_policy: "optional" }); // effective required → optional: on before and after
    expect(await storedPolicy(id)).toBe("optional");
    await patchDivision(o.auth, id, { camera_policy: "off" }); // never refused
    expect(await storedPolicy(id)).toBe("off");
    const err = await refusal(patchDivision(o.auth, id, { camera_policy: null })); // inherit: effective becomes required again
    expect(err.code).toBe(ONLINE_PACKAGE_CODES.camerasNeedUpgrade);
    expect(await storedPolicy(id), "the clear was not written").toBe("off");
  });

  it("a division that is not online has no package: any policy is saved", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { online: false });
    await patchDivision(o.auth, d.id, { camera_policy: "required" });
    expect(await storedPolicy(d.id)).toBe("required");
  });
});

describe.skipIf(!HAS_DB)("the competition-level judgement: divisionsNeedingCameraUpgrade over several divisions", () => {
  it("lists exactly the paid, unfrozen divisions without cameras that the policy now turns on — whole, ascending by id, with each difference", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 40);
    const c = await ocCompetition(o);
    const mk = async (size: OnlineSize) => ocDivision(o, c, { size });
    const paidA = await mk(16);
    const paidB = await mk(64);
    const unpaid = await mk(32);
    const withCameras = await mk(32);
    const frozen = await mk(32);
    const off = await ocDivision(o, c, { online: false });
    const keepsOff = await mk(16); // paid without cameras, and its own policy stays off under a competition that requires them
    await patchDivision(o.auth, keepsOff.id, { camera_policy: "off" });
    await pay(o, keepsOff.id, 16);
    await pay(o, paidA.id, 16);
    await pay(o, paidB.id, 64);
    await pay(o, frozen.id, 32);
    await freeze((await liveOf(frozen.id)).id);
    await patchDivision(o.auth, withCameras.id, { camera_policy: "required" });
    await pay(o, withCameras.id, 32);
    expect((await liveOf(withCameras.id)).cameras_paid, "premise: cameras paid").toBe(true);
    // The competition now requires cameras (no door writes this level: the seam a competition save will use).
    await sql`update competitions set camera_policy = 'required' where id = ${c}`;
    await sql`update divisions set camera_policy = null where id = ${withCameras.id}`;

    // Given DESCENDING by id, so an answer in the order given can never equal the ascending one the helper owes (two listed).
    const ids = [paidB.id, unpaid.id, off.id, frozen.id, withCameras.id, keepsOff.id, paidA.id].sort().reverse();
    const want = [
      { id: paidA.id, name: paidA.name, owed: cameraDifference(16) },
      { id: paidB.id, name: paidB.name, owed: cameraDifference(64) },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const listed = await sql.begin((tx) => divisionsNeedingCameraUpgrade(tx, ids));
    expect(listed, "exactly the two, ascending by id").toEqual(want);
    expect(ids.length, "divisions judged").toBe(7);
    expect(listed.length, "divisions listed").toBe(2);

    // The division lock of EVERY id is taken (the order every writer of several divisions uses): this transaction holds one
    // advisory lock per distinct division, and nothing else.
    const held = await sql.begin(async (tx) => {
      await divisionsNeedingCameraUpgrade(tx, [...ids, ...ids]);
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()`;
      return n;
    });
    expect(held, "one division lock per distinct id, a repeated id once").toBe(ids.length);

    // Each listed difference is what the real receipt asks.
    let checked = 0;
    for (const row of listed) {
      const size = row.id === paidA.id ? 16 : 64;
      expect((await onlinePackageQuote(o.auth, row.id, size, true)).owed, `${size}: the receipt's`).toBe(row.owed);
      checked += 1;
    }
    expect(checked).toBe(2);

    // Refused WHOLE: the assertion throws one error listing both, and it takes the ids in any order.
    const err = await refusal(sql.begin((tx) => assertCamerasPaidFor(tx, ids)) as Promise<void>);
    expect(shape(err)).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.camerasNeedUpgrade, extra: { divisions: want } });

    // The organiser upgrades one: the other is still listed alone. (A repeated id is judged once.)
    await payOnlinePackage(o.auth, paidA.id, { size: 16, expectedOwed: cameraDifference(16), cameras: true });
    expect(await sql.begin((tx) => divisionsNeedingCameraUpgrade(tx, [...ids, paidB.id]))).toEqual([want.find((w) => w.id === paidB.id)]);
    // The empty case: no ids, nothing listed, and the assertion passes.
    expect(await sql.begin((tx) => divisionsNeedingCameraUpgrade(tx, []))).toEqual([]);
    await sql.begin((tx) => assertCamerasPaidFor(tx, []));
  });
});
