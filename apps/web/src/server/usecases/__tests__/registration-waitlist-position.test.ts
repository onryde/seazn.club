// Registration redesign B3 T13: a waitlisted entry's place in the queue, ONE order everywhere.
//
// Before this task the product told a registrant their place in line from orders that were not the queue's own: the organiser list
// and the public status API counted by `(created_at, id)`, while promotion (`promoteOldestWaitlisted`) takes the queue by
// `coalesce(waitlisted_at, created_at), id` (V378/RS007: a promotion that lapses rejoins the TAIL). The two disagree for exactly the
// entry that was promoted and lapsed back. The status page showed no place at all, and the confirmation mail said only "Waitlisted".
//
// Every surface is read for every entry here - the status page's view (`groupById`), the organiser list (`listRegistrations`), the
// public status API (`publicRegistrationStatus`) and the confirmation mail (`buildCartMail`, the producer `notifySubmitted` renders) -
// and judged against two oracles that are not the position code: the owner ruling on a lapse (it rejoins the tail), and the order
// promotion ITSELF takes the queue in, read by calling the real `promoteOldestWaitlisted` until it runs dry inside a transaction that
// is rolled back (the queue is observed, never changed).
//
// Sport: not applicable - registration is sport-agnostic (plan Global Constraints).
import { afterEach, describe, expect, it, vi } from "vitest";

// The sweep below is GLOBAL (every org's due rows), so whatever another file left due may reach these seams through it.
const stripeMock = vi.hoisted(() => ({
  stripe: {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
    refunds: { create: vi.fn() },
  },
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { registrationEmail } from "@/lib/email";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  groupById,
  listRegistrations,
  promoteOldestWaitlisted,
  promotionSeats,
  publicRegistrationStatus,
  putRegistrationSettings,
  sweepRegistrations,
  waitlistRegistration,
  withdrawRegistrationPublic,
  type RegistrationSettingsRow,
} from "../registrations";
import { buildCartMail } from "../registrations/mail";
import { createDivision } from "../divisions";
import { SETTINGS_BASE, seedRegistration, seedSecondEntry, stripeRig, type SeedRegistrationResult } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://test.local";

afterEach(() => {
  vi.clearAllMocks();
});

/** The order promotion takes this division's waitlist in: the real `promoteOldestWaitlisted`, called until it finds nobody, inside a
 *  transaction that is then rolled back. The engine's own queue, read without changing it. */
async function promotionOrder(divisionId: string, settings: RegistrationSettingsRow): Promise<string[]> {
  // A promotion that seats needs a seat gate; these rigs charge a fee, so none is needed and none is opened.
  expect(promotionSeats(settings), "premise: a promotion here seats nobody (a fee is owed)").toBe(false);
  const picked: string[] = [];
  const rollback = new Error("roll back the promotion-order read");
  await sql
    .begin(async (tx) => {
      for (;;) {
        const row = await promoteOldestWaitlisted(tx, divisionId, settings);
        if (!row) break;
        picked.push(row.id);
        if (picked.length > 25) throw new Error("promotionOrder: the queue never ran dry");
      }
      throw rollback;
    })
    .catch((err: unknown) => {
      if (err !== rollback) throw err;
    });
  return picked;
}

type Surfaces = { status: number | null; list: number | null; publicApi: number | null; mail: number | null };

/** One entry's place as every surface states it. Entries are told apart in the mail by their (unique) display name. */
async function surfacesOf(owner: AuthCtx, divisionId: string, e: SeedRegistrationResult): Promise<Surfaces> {
  const id = e.registration.id;
  const view = await groupById(e.registration.group_id, e.access_token);
  const status = view.entries.find((x) => x.id === id);
  const row = (await listRegistrations(owner, divisionId, null)).find((x) => x.id === id);
  const publicApi = await publicRegistrationStatus(id, e.access_token);
  const mail = await buildCartMail(e.registration.group_id, ORIGIN, e.access_token);
  const line = mail?.args.entries.find((x) => x.displayName === e.registration.display_name);
  expect(status, "the status page lists the entry").toBeDefined();
  expect(row, "the organiser list lists the entry").toBeDefined();
  expect(line, "the mail lists the entry").toBeDefined();
  return {
    status: status!.waitlist_position,
    list: row!.waitlist_position,
    publicApi: publicApi.position,
    mail: line!.waitlistPosition as number | null,
  };
}

const same = (n: number | null): Surfaces => ({ status: n, list: n, publicApi: n, mail: n });

/** Every surface agrees with the order promotion takes the queue in, for every entry given. Returns how many WAITLISTED entries were
 *  judged (a caller pins it: zero judged would make "they agree" vacuous). */
async function expectOneOrder(
  owner: AuthCtx,
  divisionId: string,
  settings: RegistrationSettingsRow,
  entries: SeedRegistrationResult[],
): Promise<number> {
  const order = await promotionOrder(divisionId, settings);
  let judged = 0;
  for (const e of entries) {
    const at = order.indexOf(e.registration.id);
    const expected = at === -1 ? null : at + 1;
    expect(await surfacesOf(owner, divisionId, e), `${e.registration.display_name}: every surface states promotion's place`).toEqual(
      same(expected),
    );
    if (expected !== null) judged += 1;
  }
  expect(judged, "every entry promotion would take was judged").toBe(order.length);
  return judged;
}

/** A waitlisted entry with a unique name, its place in time pinned (days ago) so the queue order is not left to statement timing. */
type DivisionSettings = Awaited<ReturnType<typeof putRegistrationSettings>>;

async function waiting(
  rig: { competition: { id: string }; division: { id: string }; settings: DivisionSettings },
  name: string,
  daysAgo: number,
  divisionId = rig.division.id,
  settings: DivisionSettings = rig.settings,
): Promise<SeedRegistrationResult> {
  const e = await seedRegistration(rig.competition.id, divisionId, settings, {
    status: "waitlisted",
    displayName: `${name} ${Math.random().toString(36).slice(2, 7)}`,
    contactName: "Dana Contact",
  });
  await sql`update registrations set created_at = now() - make_interval(hours => ${daysAgo * 24}) where id = ${e.registration.id}`;
  return e;
}

const statusOf = async (id: string) =>
  (await sql<{ status: string; waitlisted_at: Date | null }[]>`select status, waitlisted_at from registrations where id = ${id}`)[0]!;

describe.skipIf(!HAS_DB)("one waitlist order everywhere: the place every surface states is the place promotion takes", () => {
  it("after a lapse puts an entry back on the tail: the one behind it is #1, the lapsed one #2, and promotion takes #1 next", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const a = await waiting(rig, "A", 3);
    const b = await waiting(rig, "B", 2);
    const c = await waiting(rig, "C", 1);
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [a, b, c]), "three waiting").toBe(3);
    expect(await surfacesOf(rig.owner, rig.division.id, a), "before the lapse A waits longest").toEqual(same(1));

    // A is promoted by the real queue, its pay window passes, and the real sweep puts it back on the waitlist.
    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, rig.division.id, rig.settings));
    expect(promoted?.id, "premise: the queue promotes A, the longest waiter").toBe(a.registration.id);
    await sql`update registrations set promotion_expires_at = now() - interval '1 minute' where id = ${a.registration.id}`;
    await sweepRegistrations(ORIGIN);
    const lapsed = await statusOf(a.registration.id);
    expect(lapsed.status, "premise: the real sweep lapsed A back onto the waitlist").toBe("waitlisted");
    expect(lapsed.waitlisted_at, "premise: the lapse stamped when A rejoined").not.toBeNull();
    expect((await statusOf(b.registration.id)).status, "premise: the freed place went to B, next in line").toBe("pending");

    // The owner ruling (V378/RS007): a lapsed promotion rejoins the TAIL. C has waited since before A rejoined, so C is first.
    // A's own created_at is the OLDEST of all, which is exactly what a (created_at, id) count got wrong.
    expect(await surfacesOf(rig.owner, rig.division.id, c), "C, waiting since before A rejoined").toEqual(same(1));
    expect(await surfacesOf(rig.owner, rig.division.id, a), "A, back on the tail").toEqual(same(2));
    expect(await surfacesOf(rig.owner, rig.division.id, b), "B is no longer waiting").toEqual(same(null));
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [a, b, c]), "two still waiting").toBe(2);

    // And the queue's next pick is the entry every surface called #1. The one left moves up to #1.
    const next = await sql.begin((tx) => promoteOldestWaitlisted(tx, rig.division.id, rig.settings));
    expect(next?.id, "promotion takes #1").toBe(c.registration.id);
    expect(await surfacesOf(rig.owner, rig.division.id, a), "A moves up").toEqual(same(1));
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [a, b, c]), "one still waiting").toBe(1);
  });

  it("two waiting, the first promoted: the second becomes #1; a second promotion empties the queue and nobody has a place", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const a = await waiting(rig, "A", 2);
    const b = await waiting(rig, "B", 1);
    expect(await surfacesOf(rig.owner, rig.division.id, a)).toEqual(same(1));
    expect(await surfacesOf(rig.owner, rig.division.id, b)).toEqual(same(2));

    const first = await sql.begin((tx) => promoteOldestWaitlisted(tx, rig.division.id, rig.settings));
    expect(first?.id, "premise: the longest waiter is promoted").toBe(a.registration.id);
    expect(await surfacesOf(rig.owner, rig.division.id, b), "the second becomes #1").toEqual(same(1));
    expect(await surfacesOf(rig.owner, rig.division.id, a), "a promoted entry has no place in line").toEqual(same(null));
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [a, b])).toBe(1);

    const second = await sql.begin((tx) => promoteOldestWaitlisted(tx, rig.division.id, rig.settings));
    expect(second?.id, "the second call promotes the one left").toBe(b.registration.id);
    // The empty queue: promotion finds nobody, and no surface states a place for anyone.
    expect(await promotionOrder(rig.division.id, rig.settings), "the queue is empty").toEqual([]);
    expect(await surfacesOf(rig.owner, rig.division.id, a)).toEqual(same(null));
    expect(await surfacesOf(rig.owner, rig.division.id, b)).toEqual(same(null));
  });

  it("a withdrawal ahead moves you up, and the withdrawn entry has no place", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const a = await waiting(rig, "A", 2);
    const b = await waiting(rig, "B", 1);
    expect(await surfacesOf(rig.owner, rig.division.id, b), "B starts second").toEqual(same(2));

    await withdrawRegistrationPublic(a.registration.id, a.access_token);
    expect((await statusOf(a.registration.id)).status, "premise: A withdrew").toBe("withdrawn");
    // A waiting entry held no place, so its withdrawal frees none and promotes nobody: B is still waiting, now first.
    expect((await statusOf(b.registration.id)).status, "premise: nobody was promoted").toBe("waitlisted");
    expect(await surfacesOf(rig.owner, rig.division.id, b), "B moves up").toEqual(same(1));
    expect(await surfacesOf(rig.owner, rig.division.id, a), "a withdrawn entry has no place").toEqual(same(null));
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [a, b])).toBe(1);
  });

  it("a solo sign-up the organiser put on the waitlist holds a place too, because promotion takes it in turn", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    // A pending solo sign-up, older than the team below; the organiser's own action moves it to the waitlist.
    const solo = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, {
      displayName: `Solo ${Math.random().toString(36).slice(2, 7)}`,
      contactName: "Sam Solo",
    });
    await sql`update registrations set free_agent = true, created_at = now() - interval '3 days' where id = ${solo.registration.id}`;
    await waitlistRegistration(rig.owner, solo.registration.id);
    expect((await statusOf(solo.registration.id)).status, "premise: the organiser waitlisted the solo sign-up").toBe("waitlisted");
    const team = await waiting(rig, "Team", 1);

    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [solo, team]), "both waiting").toBe(2);
    expect(await surfacesOf(rig.owner, rig.division.id, solo), "the solo sign-up, waiting longer").toEqual(same(1));
    expect(await surfacesOf(rig.owner, rig.division.id, team)).toEqual(same(2));
  });

  it("another division's waitlist does not count, however long it has waited", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const other = await createDivision(rig.owner, rig.competition.id, {
      name: `Other ${Math.random().toString(36).slice(2, 7)}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const otherSettings = await putRegistrationSettings(rig.owner, other.id, {
      ...SETTINGS_BASE,
      payment_method: "stripe",
      fee_cents: 500,
    });
    const elsewhere = await waiting(rig, "Elsewhere", 9, other.id, otherSettings);
    const here = await waiting(rig, "Here", 1);

    expect(await surfacesOf(rig.owner, rig.division.id, here), "first in its own division").toEqual(same(1));
    expect(await surfacesOf(rig.owner, other.id, elsewhere), "first in its own division").toEqual(same(1));
    expect(await expectOneOrder(rig.owner, rig.division.id, rig.settings, [here]), "this division").toBe(1);
    expect(await expectOneOrder(rig.owner, other.id, otherSettings, [elsewhere]), "the other division").toBe(1);
  });

  it("an entry that is not waiting has no place, on every surface, and a division with nobody waiting has an empty queue", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const pending = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, {
      displayName: `Pending ${Math.random().toString(36).slice(2, 7)}`,
    });
    const confirmed = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, {
      displayName: `Confirmed ${Math.random().toString(36).slice(2, 7)}`,
      status: "confirmed",
    });
    expect(await promotionOrder(rig.division.id, rig.settings), "nobody is waiting").toEqual([]);
    let judged = 0;
    for (const e of [pending, confirmed]) {
      expect(await surfacesOf(rig.owner, rig.division.id, e), e.registration.display_name).toEqual(same(null));
      judged += 1;
    }
    expect(judged, "anti-vacuity: both entries judged").toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the confirmation mail states a waiting entry's place honestly, from the same place", () => {
  it("a single waiting entry: 'On the waiting list — position #2, not charged now'", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    await waiting(rig, "Ahead", 2);
    const me = await waiting(rig, "Me", 1);
    const mail = (await buildCartMail(me.registration.group_id, ORIGIN, me.access_token))!;
    expect(mail.args.entries.map((e) => e.waitlistPosition), "the producer carries the place").toEqual([2]);
    const dict = await getDictionary(mail.locale, "emails");
    const label = t(dict, "registration.entryStatusWaitlistedPosition", { position: 2 });
    expect(label, "the owner's wording, typed").toBe("On the waiting list — position #2, not charged now");
    const { text } = await registrationEmail(mail.args, mail.locale);
    expect(text).toContain(t(dict, "registration.textSingleStatus", { status: label }));
  });

  it("a cart: the waiting line carries its own division's place, the place-holding line none", async () => {
    const rig = await stripeRig({ feeCents: 500 });
    const second = await createDivision(rig.owner, rig.competition.id, {
      name: `Second ${Math.random().toString(36).slice(2, 7)}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const secondSettings = await putRegistrationSettings(rig.owner, second.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500 });
    // One older entry waits in the SECOND division; the cart's first entry holds a place in the first.
    await waiting(rig, "Ahead", 5, second.id, secondSettings);
    const cart = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, {
      displayName: `Holder ${Math.random().toString(36).slice(2, 7)}`,
      contactName: "Dana Contact",
    });
    const waitingName = `Waiter ${Math.random().toString(36).slice(2, 7)}`;
    const waiter = await seedSecondEntry(cart.registration.group_id, second.id, 0, waitingName, "waitlisted");

    const mail = (await buildCartMail(cart.registration.group_id, ORIGIN, cart.access_token))!;
    expect(
      mail.args.entries.map((e) => [e.displayName, e.waitlistPosition]),
      "each line's place, from the same source as the status page",
    ).toEqual([
      [cart.registration.display_name, null],
      [waitingName, 2],
    ]);
    const view = await groupById(cart.registration.group_id, cart.access_token);
    expect(view.entries.find((e) => e.id === waiter.id)?.waitlist_position, "the status page agrees").toBe(2);
    const dict = await getDictionary(mail.locale, "emails");
    const { text } = await registrationEmail(mail.args, mail.locale);
    const label = t(dict, "registration.entryStatusWaitlistedPosition", { position: 2 });
    expect(text).toContain(t(dict, "registration.entryLineNoFee", { displayName: waitingName, divisionName: second.name, status: label }));
  });
});
