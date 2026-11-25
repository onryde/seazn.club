// The size as the entrant cap (Online Chess credits, Task 7; spec 2026-11-23-online-chess-credits-design.md §5.2, §7.6, P17, P18, §11):
// the package size an organiser chose (and may have paid for) is the division's online entrant cap, a THIRD line beside the plan's
// per-division cap and the platform's 256: min(plan cap, size, 256). The lowest line answers - the plan's own 402 where the plan is
// lowest (a plan/size tie goes to the plan), 422 ONLINE_SIZE_FULL {size, nextSize} where the size is, 422 ONLINE_DIVISION_FULL where
// 256 is (a size of 256 is the online cap itself). Every case drives a REAL door through its REAL usecase on a real migrated database;
// the package row is the one `createDivision` wrote at the size asked, never seeded. Skipped without DATABASE_URL.
//
// Where the expected numbers come from - never from the cap module or the leaf under test:
//   * the ladder 16 / 32 / 64 / 128 / 256 and the "next size up" of each are the spec's (§5.2, Global Constraints), typed below;
//   * the refusal code, status and its `size` / `nextSize` fields are the plan's Global Constraints (422 ONLINE_SIZE_FULL);
//   * every count is made by hand from the tables (`heldOf`), never by the cap module's own count;
//   * a plan cap is an entitlement override row, read back through the resolver as a premise.
//
// THE DOOR SWEEP: `ONLINE_SIZE_DOORS` (lib/online-chess-package.ts) names every door that reads the size. This file declares one driver
// per door and `it.each` runs the LIST, so a door added to the list with no driver fails by name, and a driver for a door that is not
// on the list fails the key-set test; each driver reports the checks it made and zero is a failure. The source scan that keeps the list
// complete (every `sizeForDoor(` call site belongs to a named door) is external-play/__tests__/online-entrant-cap.test.ts.
//
// Mutant table (each run once by hand against these tests; results are in the commit message):
//   S1  the size term dropped from `effectiveEntrantCap`           -> the add, sign-up, places-left, auto-promotion and capacity doors
//   S2  `createEntrants` reads the size BEFORE the division lock   -> "a door reads the size after taking the lock"
//   S3  the size dropped from the Reinstate guard                  -> the reinstate door
//   S4  the size dropped from the promote / confirm / waive check  -> the promote, confirm and waive doors
//   S5  the size dropped from the sign-up waitlist test            -> the sign-up door
//   S6  the size dropped from `onlineCapHoldsPromotion`            -> the auto-promotion door
//   S7  the capacity save does not read the size                   -> the capacity door
//   S8  places-left ignores the size                               -> the places-left door
//   S9  plan and size tie goes to the size, not the plan           -> "the plan wins a tie and a lower plan answers first"
//   S10 a frozen / paid package no longer caps                     -> "a frozen or paid package still caps at its size"
//   S11 a missing row throws instead of falling back               -> "a division with no live package row"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The flag (`online-chess`) asks PostHog unless ONLINE_CHESS_ALWAYS=1 forces it on; PostHog answers OFF here, so the override decides.
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});
const sentry = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn((err: unknown) => void sentry.captured.push(err)) };
});

import { sql } from "@/lib/db";
import { ONLINE_SIZES, ONLINE_SIZE_DOORS, type OnlineSize } from "@/lib/online-chess-package";
import { log } from "@/server/logger";
import { ONLINE_PACKAGE_MISSING } from "@/server/external-play/online-entrant-cap";
import { patchDivision } from "../divisions";
import { patchEntrant } from "../entrants";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { publicRegistrationInfo } from "../registrations/settings";
import { confirmRegistration, confirmRegistrationWaived, putRegistrationSettings, sweepRegistrations } from "../registrations";
import { promoteFromWaitlist, rejectRegistration, withdrawRegistration } from "../registration-approval";
import { buy, pay, type Org } from "../online-package/__tests__/_oc-rig";
import { SETTINGS_BASE, seedRegistration } from "./_registration-fixtures";
import {
  addMany, addOne, entrantRows, fillEntrants, heldOf, holdingDivisionLock, idsOf, outcomeOf, signUp, sizeRig, type SizeRig,
} from "./_online-size-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

/** The ladder and the size above each rung: the spec's (§5.2), typed here. 256 has no next size. */
const LADDER = [16, 32, 64, 128, 256] as const;
const NEXT: Record<number, number> = { 16: 32, 32: 64, 64: 128, 128: 256 };

beforeAll(() => {
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** The refusal a door answers when the SIZE is the lowest line: 422 ONLINE_SIZE_FULL carrying the size and the next one up. */
const sizeFull = (size: number) => ({ kind: "refused", status: 422, code: "ONLINE_SIZE_FULL", extra: { size, nextSize: NEXT[size] } });
/** The refusal where 256 is the lowest line (a size of 256 IS the online cap): 422 ONLINE_DIVISION_FULL carrying the limit. */
const onlineFull = { kind: "refused", status: 422, code: "ONLINE_DIVISION_FULL", extra: { limit: 256 } };

const OK = { kind: "ok" };
const stored = async (divisionId: string): Promise<{ capacity: number | null }> =>
  (await sql<{ capacity: number | null }[]>`select capacity from registration_settings where division_id = ${divisionId}`)[0]!;

/** `n` is the check count a driver reports: zero is a failure (anti-vacuity). */
type Driver = () => Promise<number>;

// ─── The drivers: one per door of ONLINE_SIZE_DOORS ──────────────────────────────────────────────────────────────

const DRIVERS: Record<string, Driver> = {
  // createEntrants: the organiser adds an entrant (one, or a batch judged whole), at every size of the ladder.
  add_entrants: async () => {
    let checks = 0;
    for (const size of LADDER) {
      const r = await sizeRig({ size });
      await fillEntrants(r.division.id, size - 2);
      expect(await outcomeOf(() => addOne(r)), `size ${size}: the ${size - 1}th`).toMatchObject(OK);
      expect(await outcomeOf(() => addOne(r)), `size ${size}: the ${size}th is the last allowed`).toMatchObject(OK);
      expect(await heldOf(r.division.id), `size ${size}: full`).toBe(size);
      expect(await outcomeOf(() => addOne(r)), `size ${size}: the ${size + 1}th`).toEqual(size === 256 ? onlineFull : sizeFull(size));
      expect(await entrantRows(r.division.id), `size ${size}: the refused entrant was not written`).toBe(size);
      checks += 5;
    }
    // A batch is judged whole: 14 held + 3 would be 17 (nothing written); + 2 is exactly 16.
    const b = await sizeRig({ size: 16 });
    await fillEntrants(b.division.id, 14);
    expect(await outcomeOf(() => addMany(b, 3)), "14 + 3 = 17 at size 16").toEqual(sizeFull(16));
    expect(await entrantRows(b.division.id), "nobody written").toBe(14);
    expect(await outcomeOf(() => addMany(b, 2)), "14 + 2 = 16").toMatchObject(OK);
    expect(await entrantRows(b.division.id)).toBe(16);
    return checks + 4;
  },

  // Reinstate (patchEntrant back into the field): a departed entrant takes a place again, so it is judged like an add.
  reinstate: async () => {
    const r = await sizeRig({ size: 16 });
    await fillEntrants(r.division.id, 15);
    const gone = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, status)
      select ${r.division.id}, 'individual', 'Gone ' || g, case when g = 1 then 'withdrawn' else 'disqualified' end from generate_series(1, 2) g
      returning id`;
    const [first, second] = gone.map((g) => g.id);
    expect(await heldOf(r.division.id), "premise: 15 live, the two departed hold nothing").toBe(15);
    expect(await outcomeOf(() => patchEntrant(r.auth, first!, { status: "confirmed" })), "the 16th place").toMatchObject(OK);
    expect(await outcomeOf(() => patchEntrant(r.auth, second!, { status: "confirmed" })), "the 17th").toEqual(sizeFull(16));
    const [still] = await sql<{ status: string }[]>`select status from entrants where id = ${second!}`;
    expect(still!.status, "still disqualified: nothing written").toBe("disqualified");
    return 3;
  },

  // The public sign-up waits on the ordinary waitlist: the registrant is never told about a size, a plan or a credit.
  sign_up: async () => {
    let checks = 0;
    for (const size of [16, 32]) {
      const r = await sizeRig({ size: size as OnlineSize, approval: "auto" });
      await fillEntrants(r.division.id, size - 1);
      const last = await signUp(r);
      expect(last.status, `size ${size}: the ${size}th is confirmed`).toBe("confirmed");
      const over = await signUp(r);
      expect(over.status, `size ${size}: the ${size + 1}th waits`).toBe("waitlisted");
      const told = JSON.stringify(over.response);
      expect(told, "the registrant is told nothing of the size").not.toMatch(/ONLINE_SIZE|nextSize|credit/i);
      checks += 3;
    }
    // The sequence: a place frees, the next is confirmed, and it is full again.
    const r = await sizeRig({ size: 16, approval: "auto" });
    const held = await r.holders(15);
    expect((await signUp(r)).status, "the 16th").toBe("confirmed");
    expect((await signUp(r)).status, "the 17th").toBe("waitlisted");
    await r.withdrawHolder(held[0]!);
    expect((await signUp(r)).status, "after a withdrawal frees a place").toBe("confirmed");
    expect((await signUp(r)).status, "full again").toBe("waitlisted");
    expect(await heldOf(r.division.id)).toBe(16);
    return checks + 5;
  },

  // The organiser's Promote (named, and oldest-first), at the size.
  promote: async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(r.division.id, 15);
    const a = await r.waiting();
    expect((await promoteFromWaitlist(r.auth, r.division.id, { registrationId: a }))!.status, "the 16th place").toBe("pending");
    const b = await r.waiting();
    for (const confirmOverCapacity of [false, true]) {
      expect(
        await outcomeOf(() => promoteFromWaitlist(r.auth, r.division.id, { registrationId: b, confirmOverCapacity })),
        `named, confirmOverCapacity ${confirmOverCapacity}: the 17th`,
      ).toEqual(sizeFull(16));
    }
    expect(await r.statusOf(b), "still waitlisted: nothing written").toBe("waitlisted");
    expect(await outcomeOf(() => promoteFromWaitlist(r.auth, r.division.id, {})), "oldest-first refuses the same way").toEqual(sizeFull(16));
    // The empty case: a full division with nobody waiting is "nobody to promote", not a refusal.
    const empty = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(empty.division.id, 16);
    expect(await promoteFromWaitlist(empty.auth, empty.division.id, {}), "empty queue on a full division").toBeNull();
    return 6;
  },

  // Confirm: seating a waitlisted entry takes the same room check as Promote.
  confirm: async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(r.division.id, 15);
    const a = await r.waiting();
    expect(await outcomeOf(() => confirmRegistration(r.auth, a)), "the 16th").toMatchObject(OK);
    const b = await r.waiting();
    expect(await outcomeOf(() => confirmRegistration(r.auth, b)), "the 17th").toEqual(sizeFull(16));
    expect(await r.statusOf(b), "still waitlisted").toBe("waitlisted");
    return 3;
  },

  // Waive: confirm without payment, the same check.
  waive: async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(r.division.id, 15);
    const a = await r.waiting();
    expect(await outcomeOf(() => confirmRegistrationWaived(r.auth, a)), "the 16th").toMatchObject(OK);
    const b = await r.waiting();
    expect(await outcomeOf(() => confirmRegistrationWaived(r.auth, b)), "the 17th").toEqual(sizeFull(16));
    expect(await r.statusOf(b), "still waitlisted").toBe("waitlisted");
    return 3;
  },

  // The promotions a freed place triggers: a withdrawal, a rejection, an expiry. A place that is not really free promotes nobody.
  auto_promotion: async () => {
    let checks = 0;
    // A withdrawal at the size frees ONE place and promotes ONE registrant.
    const w = await sizeRig({ size: 16, approval: "manual" });
    const held = await w.holders(16);
    const waiting = await w.waiting();
    expect(await heldOf(w.division.id), "premise: full").toBe(16);
    await withdrawRegistration(w.auth, held[0]!);
    expect(await w.statusOf(waiting), "the freed place went to the waitlist").toBe("pending");
    expect(await heldOf(w.division.id), "full again, never past").toBe(16);
    checks += 3;
    // The organiser frees a place from the TABLE and fills it; the registrant then withdraws: the place is not freed twice.
    const t = await sizeRig({ size: 16, approval: "manual" });
    const [holder] = await t.holders(1);
    await fillEntrants(t.division.id, 15);
    const tw = await t.waiting();
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${holder!}`;
    await patchEntrant(t.auth, entrantId, { status: "withdrawn" });
    expect(await outcomeOf(() => addOne(t)), "the place is filled again").toMatchObject(OK);
    expect(await heldOf(t.division.id), "premise: 16 again").toBe(16);
    await withdrawRegistration(t.auth, holder!);
    expect(await t.statusOf(tw), "no place was freed: the waitlisted one stays").toBe("waitlisted");
    expect(await heldOf(t.division.id)).toBe(16);
    checks += 3;
    // A rejection frees a place: served with room, held back when the division is stored past its size.
    const room = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(room.division.id, 14);
    const [roomPending] = await pendingSignUps(room, 1);
    const roomWaiting = await room.waiting();
    await rejectRegistration(room.auth, roomPending!);
    expect(await room.statusOf(roomWaiting), "room: served").toBe("pending");
    const full = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(full.division.id, 16);
    const [fullPending] = await pendingSignUps(full, 1);
    const fullWaiting = await full.waiting();
    expect(await heldOf(full.division.id), "premise: stored past the size (17)").toBe(17);
    await rejectRegistration(full.auth, fullPending!);
    expect(await full.statusOf(fullPending!)).toBe("rejected");
    expect(await full.statusOf(fullWaiting), "full: not served").toBe("waitlisted");
    expect(await heldOf(full.division.id)).toBe(16);
    checks += 4;
    // An expiry frees a place: with room the waitlist is served; with the division already full it is not.
    const lapsed = async (rig: SizeRig): Promise<string> => {
      const { registration } = await seedRegistration(
        rig.competition.id, rig.division.id, { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
        { status: "pending", displayName: "Lapsed card" },
      );
      await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${registration.group_id}`;
      return registration.id;
    };
    const eroom = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(eroom.division.id, 14);
    const eroomLapsed = await lapsed(eroom);
    const eroomWaiting = await eroom.waiting();
    const efull = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(efull.division.id, 16);
    const efullLapsed = await lapsed(efull);
    const efullWaiting = await efull.waiting();
    await sweepRegistrations("https://example.test");
    expect(await eroom.statusOf(eroomLapsed), "premise: the sweep expired it").toBe("expired");
    expect(await eroom.statusOf(eroomWaiting), "room: served").toBe("pending");
    expect(await efull.statusOf(efullLapsed), "premise: the sweep expired it").toBe("expired");
    expect(await efull.statusOf(efullWaiting), "full: the waitlist is NOT served").toBe("waitlisted");
    return checks + 4;
  },

  // The online switch: turning online play on is judged against the size chosen with it (Task 6's assertSizeFits).
  online_switch: async () => {
    const r = await sizeRig({ size: null });
    await fillEntrants(r.division.id, 20);
    const config = { variant: "classical", clock: { base: 600, increment: 5 }, onlinePlay: "lichess" };
    expect(await outcomeOf(() => patchDivision(r.auth, r.division.id, { config, online_size: 16 } as never)), "20 held, size 16").toEqual(sizeFull(16));
    const [still] = await sql<{ online: string | null }[]>`select config->>'onlinePlay' as online from divisions where id = ${r.division.id}`;
    expect(still!.online, "still over the board: nothing written").toBeNull();
    expect(await outcomeOf(() => patchDivision(r.auth, r.division.id, { config, online_size: 32 } as never)), "20 held, size 32").toMatchObject(OK);
    expect(await r.sizeNow(), "the package opened at the size chosen").toBe(32);
    return 4;
  },

  // The registration capacity an organiser may promise.
  capacity_save: async () => {
    const save = (r: SizeRig, capacity: number | null) =>
      putRegistrationSettings(r.auth, r.division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity, approval: "auto", allow_free_agents: false } as never);
    let checks = 0;
    for (const [size, over] of [[16, 17], [32, 33], [64, 65], [128, 129]] as const) {
      const r = await sizeRig({ size });
      expect(await outcomeOf(() => save(r, size)), `size ${size}: a capacity of ${size}`).toMatchObject(OK);
      expect((await stored(r.division.id)).capacity).toBe(size);
      expect(await outcomeOf(() => save(r, over)), `size ${size}: a capacity of ${over}`).toEqual(sizeFull(size));
      expect((await stored(r.division.id)).capacity, "the refused save wrote nothing").toBe(size);
      expect(await outcomeOf(() => save(r, null)), `size ${size}: no capacity at all`).toMatchObject(OK);
      checks += 5;
    }
    // Over the board the size means nothing: a capacity of 200 saves on a division with no package.
    const otb = await sizeRig({ size: null });
    expect(await outcomeOf(() => save(otb, 200)), "over the board, 200").toMatchObject(OK);
    return checks + 1;
  },

  // The public register panel's places left: the room under min(plan, size, 256).
  places_left: async () => {
    const placesOf = async (r: SizeRig) =>
      (await publicRegistrationInfo(r.orgSlug, r.competition.slug)).divisions.find((d) => d.division_id === r.division.id)!;
    let checks = 0;
    for (const [size, held, left] of [[16, 5, 11], [32, 5, 27], [64, 60, 4], [256, 100, 156]] as const) {
      const r = await sizeRig({ size });
      await fillEntrants(r.division.id, held);
      expect((await placesOf(r)).remaining, `size ${size}, ${held} held`).toBe(left);
      checks += 1;
    }
    const full = await sizeRig({ size: 16 });
    await fillEntrants(full.division.id, 16);
    const fullInfo = await placesOf(full);
    expect(fullInfo.remaining, "full: 0").toBe(0);
    expect(fullInfo.closed_reason, "still open: it joins the waitlist").toBe("full");
    // Stored past the size (a division that held more before it was sized): reads as full, never negative.
    const past = await sizeRig({ size: 16 });
    await fillEntrants(past.division.id, 20);
    expect((await placesOf(past)).remaining, "20 held at size 16").toBe(0);
    // A capacity below the size still decides (the min): capacity 10, 5 held, size 16 leaves 5.
    const capped = await sizeRig({ size: 16 });
    await putRegistrationSettings(capped.auth, capped.division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity: 10, approval: "auto", allow_free_agents: false } as never);
    await capped.holders(5); // the capacity counts sign-ups (registrations), which hold their entrant: 5 of both
    expect((await placesOf(capped)).remaining, "capacity 10, 5 held").toBe(5);
    // Over the board there is no size to read: no capacity and no plan limit in play is no count at all.
    const otb = await sizeRig({ size: null, plan: null });
    await fillEntrants(otb.division.id, 5);
    expect((await placesOf(otb)).remaining, "over the board: no count").toBeNull();
    return checks + 5;
  },
};

/** `n` sign-ups let in and not yet entrants (pending, no entrant): on a manual-approval division they wait there for the organiser. */
async function pendingSignUps(r: SizeRig, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { registration } = await seedRegistration(
      r.competition.id, r.division.id, { fee_cents: 0, currency: "gbp", payment_method: "offline" }, { status: "pending", displayName: `Pending ${i + 1}` },
    );
    ids.push(registration.id);
  }
  return ids;
}

describe.skipIf(!HAS_DB)("the door sweep: every door of ONLINE_SIZE_DOORS reads the size", () => {
  it("anti-vacuity: the list is the ten doors of spec §7.6 and each has a driver, and no driver is for a door off the list", () => {
    // The ten doors, typed from the spec (§7.6: add and Reinstate, sign-up, promote / confirm / waive, the automatic promotions, the
    // online switch, the registration capacity and the places-left read).
    expect([...ONLINE_SIZE_DOORS].sort()).toEqual(
      ["add_entrants", "auto_promotion", "capacity_save", "confirm", "online_switch", "places_left", "promote", "reinstate", "sign_up", "waive"].sort(),
    );
    expect(ONLINE_SIZE_DOORS.length).toBeGreaterThan(0);
    expect(Object.keys(DRIVERS).sort(), "one driver per door").toEqual([...ONLINE_SIZE_DOORS].sort());
    expect([...ONLINE_SIZES], "premise: the ladder is the spec's").toEqual([...LADDER]);
  });

  it.each([...ONLINE_SIZE_DOORS])("door %s: the last place in, the next out, nothing written by the refusal", async (door) => {
    const driver = DRIVERS[door];
    expect(driver, `${door} has a driver`).toBeDefined();
    const checks = await driver!();
    expect(checks, `${door}: checks made (zero is a failure)`).toBeGreaterThan(0);
  }, 240_000);
});

// ─── The SEQUENCE: full -> refused -> move up -> allowed -> move down refused below held -> withdraw -> allowed ─────────

describe.skipIf(!HAS_DB)("the size moves with the money: refused at the size, allowed after a move up, a move down only to what is held", () => {
  it("16 full is refused; paying for 32 admits the 17th; 17 held refuses a move down to 16; one withdrawal later the move down goes through and the cap is 16 again", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    const org: Org = { orgId: r.orgId, auth: r.auth };
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 15);
    expect(await outcomeOf(() => addOne(r)), "the 16th").toMatchObject(OK);
    expect(await outcomeOf(() => addOne(r)), "the 17th, at size 16").toEqual(sizeFull(16));
    // Move UP: pay for 32. The same add is now admitted.
    const paid = await pay(org, r.division.id, 32);
    expect(paid.applied, "the payment applied").toBe(true);
    expect(await r.sizeNow(), "the row is at 32").toBe(32);
    expect(await outcomeOf(() => addOne(r)), "the 17th, at size 32").toMatchObject(OK);
    expect(await heldOf(r.division.id)).toBe(17);
    // Move DOWN below the places held: refused, and the row stays at 32.
    const refused = await outcomeOf(() => pay(org, r.division.id, 16));
    expect(refused, "17 held cannot be moved down to 16").toMatchObject({ kind: "refused", status: 409, code: "ONLINE_QUOTE_CHANGED" });
    expect(await r.sizeNow(), "still 32").toBe(32);
    // One entrant withdraws: 16 held, and the move down is allowed.
    const ids = await idsOf(r.division.id);
    await patchEntrant(r.auth, ids[0]!, { status: "withdrawn" });
    expect(await heldOf(r.division.id)).toBe(16);
    const down = await pay(org, r.division.id, 16);
    expect(down.applied, "the move down applied").toBe(true);
    expect(await r.sizeNow(), "the row is at 16").toBe(16);
    expect(await outcomeOf(() => addOne(r)), "and the cap is 16 again").toEqual(sizeFull(16));
    expect(await entrantRows(r.division.id), "nobody was removed by any of it").toBe(17); // 17 rows: the withdrawn one stays a row
  }, 120_000);
});

// ─── A frozen or paid package still caps ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a frozen or paid package still caps at its size, and a backfilled one that holds more reads as full", () => {
  it("unpaid, paid and frozen rows all cap at their size; a frozen row is never lifted by anything", async () => {
    // Paid: the row bought at 32 caps at 32.
    const paid = await sizeRig({ size: 16, approval: "manual" });
    await buy(paid.orgId, 40);
    await pay({ orgId: paid.orgId, auth: paid.auth }, paid.division.id, 32);
    await fillEntrants(paid.division.id, 32);
    expect(await outcomeOf(() => addOne(paid)), "paid at 32, 32 held").toEqual(sizeFull(32));
    // Frozen (a round opened): paid and then frozen at 32 still caps.
    await sql`update division_online_packages set frozen_at = now() where division_id = ${paid.division.id} and refunded_at is null`;
    expect(await outcomeOf(() => addOne(paid)), "paid and frozen at 32, 32 held").toEqual(sizeFull(32));
    // Frozen and unpaid is the grandfathered row of the backfill: its size caps too.
    const grandfathered = await sizeRig({ size: 16 });
    await fillEntrants(grandfathered.division.id, 16);
    await sql`update division_online_packages set frozen_at = created_at where division_id = ${grandfathered.division.id} and refunded_at is null`;
    expect(await outcomeOf(() => addOne(grandfathered)), "grandfathered at 16, 16 held").toEqual(sizeFull(16));
    expect(await heldOf(grandfathered.division.id), "nobody was removed").toBe(16);
  }, 120_000);

  it("a backfilled row that holds more than its size (256 with 257, 16 with 20) reads as full: nothing is added, and nobody is kicked out", async () => {
    const big = await sizeRig({ size: 256 });
    await fillEntrants(big.division.id, 257);
    expect(await outcomeOf(() => addOne(big)), "257 held at 256: the online cap's own refusal").toEqual(onlineFull);
    expect(await heldOf(big.division.id), "nobody kicked out").toBe(257);
    const small = await sizeRig({ size: 16 });
    await fillEntrants(small.division.id, 20);
    expect(await outcomeOf(() => addOne(small)), "20 held at 16").toEqual(sizeFull(16));
    expect(await heldOf(small.division.id), "nobody kicked out").toBe(20);
    // Departures bring it back under: 20 live, 5 withdrawn -> 15 live, room for one.
    const ids = await idsOf(small.division.id);
    for (const id of ids.slice(0, 5)) await patchEntrant(small.auth, id, { status: "withdrawn" });
    expect(await outcomeOf(() => addOne(small)), "15 live: the 16th").toMatchObject(OK);
    expect(await outcomeOf(() => addOne(small)), "16 live: the 17th").toEqual(sizeFull(16));
  }, 120_000);
});

// ─── The three lines: the plan wins a tie and a lower plan answers first ──────────────────────────────────────────────

describe.skipIf(!HAS_DB)("the plan wins a tie and a lower plan answers first (min of plan cap, size, 256)", () => {
  it("plan 96 / size 128: the 97th is the PLAN's refusal (402), never ONLINE_SIZE_FULL; plan 128 / size 128 is a tie the plan takes", async () => {
    const r = await sizeRig({ size: 128, plan: 96 });
    await fillEntrants(r.division.id, 95);
    expect(await outcomeOf(() => addOne(r)), "the 96th").toMatchObject(OK);
    expect(await outcomeOf(() => addOne(r)), "the 97th: the plan's own 402").toEqual({ kind: "plan" });
    const tie = await sizeRig({ size: 128, plan: 128 });
    await fillEntrants(tie.division.id, 128);
    expect(await outcomeOf(() => addOne(tie)), "128 at plan 128 / size 128: the plan answers the tie").toEqual({ kind: "plan" });
  }, 120_000);

  it("size 64 / plan 96 and an unlimited plan: the size is the lowest line, so ONLINE_SIZE_FULL answers", async () => {
    const r = await sizeRig({ size: 64, plan: 96 });
    await fillEntrants(r.division.id, 64);
    expect(await outcomeOf(() => addOne(r)), "the 65th at size 64 under a plan of 96").toEqual(sizeFull(64));
    const unlimited = await sizeRig({ size: 32, plan: null });
    await fillEntrants(unlimited.division.id, 32);
    expect(await outcomeOf(() => addOne(unlimited)), "the 33rd at size 32 on an unlimited plan").toEqual(sizeFull(32));
    const community = await sizeRig({ size: 64, plan: "community" });
    await fillEntrants(community.division.id, 64);
    expect(await outcomeOf(() => addOne(community)), "Community's 64 and a size of 64 tie: the plan").toEqual({ kind: "plan" });
  }, 120_000);

  it("the public sign-up under plan 96 / size 128 waits at 96, and under size 16 / plan 256 at 16: always the ordinary waitlist", async () => {
    const plan = await sizeRig({ size: 128, plan: 96, approval: "auto" });
    await fillEntrants(plan.division.id, 95);
    expect((await signUp(plan)).status, "the 96th").toBe("confirmed");
    expect((await signUp(plan)).status, "the 97th").toBe("waitlisted");
  }, 120_000);
});

// ─── A division with no live package row ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a division with no live package row falls back to today's cap, and says so (spec §7.6: logged and reported)", () => {
  it("online, no row: the plan and 256 judge it (the 17th is admitted), one error log and one Sentry report per door call; over the board and another sport log nothing", async () => {
    const r = await sizeRig({ size: 16 });
    await sql`delete from division_online_packages where division_id = ${r.division.id}`;
    await fillEntrants(r.division.id, 16);
    const logged = vi.spyOn(log, "error");
    sentry.captured.length = 0;
    try {
      expect(await outcomeOf(() => addOne(r)), "no row: the cap that held before the size existed").toMatchObject(OK);
      const reports = logged.mock.calls.filter((c) => c.some((a) => a === ONLINE_PACKAGE_MISSING));
      expect(reports.length, "the miss was logged at error level").toBe(1);
      expect(sentry.captured.length, "and reported to Sentry").toBe(1);
      expect(String((sentry.captured[0] as Error).message)).toBe(ONLINE_PACKAGE_MISSING);
      // Another sport (never online) and an over-the-board chess division read no size at any door: the miss is not logged for them.
      logged.mockClear();
      sentry.captured.length = 0;
      const otb = await sizeRig({ size: null });
      await fillEntrants(otb.division.id, 20);
      expect(await outcomeOf(() => addOne(otb)), "over the board, 21st").toMatchObject(OK);
      const badminton = await sizeRig({ sport: "badminton", size: null });
      await fillEntrants(badminton.division.id, 20);
      expect(await outcomeOf(() => addOne(badminton)), "badminton, 21st").toMatchObject(OK);
      expect(logged.mock.calls.filter((c) => c.some((a) => a === ONLINE_PACKAGE_MISSING)).length, "no log for a division with no size to read").toBe(0);
      expect(sentry.captured.length, "no report").toBe(0);
    } finally {
      logged.mockRestore();
    }
  }, 120_000);
});

// ─── Another sport / over the board: unaffected ───────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("over-the-board chess and another sport keep the plan's cap alone", () => {
  it("20 entrants are added to an over-the-board division and a badminton division at every door that counts, with no package row anywhere", async () => {
    for (const opts of [{ size: null }, { sport: "badminton" as const, size: null }]) {
      const r = await sizeRig(opts);
      await fillEntrants(r.division.id, 16);
      expect(await outcomeOf(() => addOne(r)), `${opts.sport ?? "boardgame"}: the 17th`).toMatchObject(OK);
      expect(await outcomeOf(() => addMany(r, 3)), `${opts.sport ?? "boardgame"}: a batch of 3`).toMatchObject(OK);
      const [{ n: packages }] = await sql<{ n: number }[]>`select count(*)::int as n from division_online_packages where division_id = ${r.division.id}`;
      expect(packages, "no package row for a division that does not play online").toBe(0);
      expect(await heldOf(r.division.id)).toBe(20);
    }
  }, 120_000);
});

// ─── A door reads the size after taking the division lock ───────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a door reads the size after taking the `division:` lock, never before it", () => {
  it("an add and a sign-up queued behind the lock see the size a payment raised WHILE they waited", async () => {
    const add = await sizeRig({ size: 16 });
    await fillEntrants(add.division.id, 16);
    const queuedAdd = await holdingDivisionLock(
      add.division.id,
      () => addOne(add),
      async () => void (await sql`update division_online_packages set size = 32 where division_id = ${add.division.id} and refunded_at is null`),
    );
    expect(queuedAdd.waited, "premise: the add queued behind the lock").toBe(true);
    expect(queuedAdd.outcome.status, "the add read the size the lock holder wrote: 32, so the 17th is admitted").toBe("fulfilled");
    expect(await heldOf(add.division.id)).toBe(17);

    const reg = await sizeRig({ size: 16, approval: "auto" });
    await fillEntrants(reg.division.id, 16);
    const queuedSignUp = await holdingDivisionLock(
      reg.division.id,
      () => signUp(reg),
      async () => void (await sql`update division_online_packages set size = 32 where division_id = ${reg.division.id} and refunded_at is null`),
    );
    expect(queuedSignUp.waited, "premise: the sign-up queued behind the lock").toBe(true);
    expect(queuedSignUp.outcome.status).toBe("fulfilled");
    expect((queuedSignUp.outcome as PromiseFulfilledResult<{ status: string }>).value.status, "room under 32: confirmed, not waitlisted").toBe("confirmed");
  }, 120_000);
});
