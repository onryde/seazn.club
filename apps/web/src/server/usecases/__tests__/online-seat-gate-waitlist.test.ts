// A free, auto-approval division seats a waitlisted registrant the moment they are promoted - and a promotion is usually
// AUTOMATIC: a withdrawal, an expiry, a lapsed pay window frees a spot and the oldest waitlisted entry takes it, with no
// organiser in the loop. On an ONLINE-play division the seat has to answer to the seat gate's bar (a Lichess link that
// PLAYS), without ever stranding the spot or jamming the queue behind a registrant who cannot play yet.
//
// The ruling this file pins (decided here, from how promotion works - registrations.ts `promoteOldestWaitlisted`):
//   * SKIP TO THE NEXT. The registrant who cannot be seated stays WAITLISTED, in their place; the next-oldest who can play
//     is promoted instead. Nothing is thrown at the withdrawal / sweep that freed the spot (it is the registrant's or the
//     organiser's own act and must not fail for someone else's link), and the queue is never blocked on one person.
//   * HOLD-AND-NOTIFY was rejected: promoting the entry to `pending` without seating it strands it for ever on a free,
//     auto-approval division (`approveRegistration` refuses it - "nothing to approve manually" - and no payment will ever
//     confirm it; the RS010 defect `promoteWaitlistedRow` exists to prevent).
//   * A promotion that seats NOBODY (an entry fee to pay first, or manual approval) is not gated: its seat is gated where it
//     happens - the organiser's approve / mark-paid, covered in online-seat-gate-doors.test.ts.
//   * The organiser's EXPLICIT promote of one named entry is a door, not an automatic promotion: it refuses (doors file).
//
//   * A SKIP IS NOT SILENT: each one writes a `registration.promotion_skipped` audit row carrying the gate's own code (and mails
//     nobody), so an organiser can see who was passed over and why.
//   * The cheap net first: the gate's prelude already read the queue's links, so a registrant who cannot play is passed over BEFORE the
//     attempted seat (no entrant, no person, no savepoint); the savepoint stays under it for a seat the pre-filter let through.
//   * Only a gate refusal is skipped. Any other failure of the attempted seat fails the whole call.
//   * A promotion that would seat with no gate to ask refuses (fails closed): the settings can change between the read that decided
//     whether to open a gate and the read that decides whether to seat.
//
// Every case drives the real usecase against the real database; the sequence case is the one that matters most: the
// registrant who was skipped reconnects, and the very next freed spot takes them.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const flags = vi.hoisted(() => ({
  isServerFeatureEnabled: vi.fn<(flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) => Promise<boolean>>(),
}));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    isServerFeatureEnabled: (flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) =>
      flags.isServerFeatureEnabled(flag, distinctId, opts),
  };
});

// Every mail the usecases send, recorded and not sent: who got one is part of what a skip owes (nothing).
const mail = vi.hoisted(() => ({ sent: [] as { fn: string; to: unknown }[] }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" && name.startsWith("send")
        ? async (...args: unknown[]) => {
            mail.sent.push({ fn: name, to: (args[0] as { to?: unknown } | undefined)?.to });
            return true;
          }
        : value,
    ]),
  );
});
// The seat gate, with every roster it is asked to judge noted: what the pre-filter spares the seat shows as calls that never happen.
const seats = vi.hoisted(() => ({ rosters: [] as string[][] }));
vi.mock("../online-seat-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../online-seat-gate")>();
  return {
    ...actual,
    openRegistrationSeatGate: async (...args: Parameters<typeof actual.openRegistrationSeatGate>) => {
      const gate = await actual.openRegistrationSeatGate(...args);
      return {
        ...gate,
        assertRoster: (tx: Parameters<typeof gate.assertRoster>[0], divisionId: string, personIds: readonly string[]) => {
          seats.rosters.push([...personIds]);
          return gate.assertRoster(tx, divisionId, personIds);
        },
      };
    },
  };
});
// A failure that is NOT the gate's: the verdict function answers as itself for the first `skip` asks, then throws a plain Error the next
// `remaining` times it is asked, then answers as itself again. (`skip` aims the failure at the attempted seat rather than at the pre-filter's
// own read, which asks first.)
const poison = vi.hoisted(() => ({ skip: 0, remaining: 0 }));
vi.mock("../external-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-accounts")>();
  return {
    ...actual,
    assertPersonIdsLinkedForOnlinePlay: (...args: Parameters<typeof actual.assertPersonIdsLinkedForOnlinePlay>) => {
      if (poison.skip > 0) {
        poison.skip--;
      } else if (poison.remaining > 0) {
        poison.remaining--;
        throw new Error("boom: the link lookup failed (not a Lichess refusal)");
      }
      return actual.assertPersonIdsLinkedForOnlinePlay(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { openRegistrationSeatGate } from "../online-seat-gate";
import { promoteFromWaitlist } from "../registration-approval";
import { submitRegistrationGroup } from "../registration-submit";
import {
  loadSettings,
  promoteOldestWaitlisted,
  promoteWaitlistedRow,
  putRegistrationSettings,
  sweepRegistrations,
  withdrawRegistrationOrganiser,
} from "../registrations";
import { seedRegistration } from "./_registration-fixtures";
import { stubOutboxEnv } from "./_invite-mail";
import { linkWithoutPlayConsent, reconnectLichess, seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
afterEach(() => {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
  mail.sent.length = 0;
  seats.rosters.length = 0;
  poison.skip = 0;
  poison.remaining = 0;
});

type Kind = "plays" | "identity-only" | "none";
interface Rig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
}

async function rig(online: boolean, fee = 0): Promise<Rig> {
  const auth = await seedOwner();
  const competition = await createCompetition(auth, {
    name: "Waitlist gate " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2026-12-01",
    ends_on: "2026-12-02",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Online",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(online ? { onlinePlay: "lichess" } : {}), clock: { base: 600, increment: 5 } },
  });
  // The real producer of the settings, not a raw row.
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: fee,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    payment_method: "offline",
    approval: "auto",
    allow_free_agents: false,
  });
  return { auth, competitionId: competition.id, divisionId: division.id };
}

async function player(r: Rig, kind: Kind): Promise<SeedPlayer> {
  const p = await seedPlayer(r.auth.orgId, `${kind} ${randomUUID().slice(0, 8)}`, `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`, kind === "plays");
  if (kind === "identity-only") await linkWithoutPlayConsent(p, "identity-only");
  return p;
}

/** A registration for `p` in the given status (waitlisted rows hold no fee; a spot holder is a plain pending entry). */
async function enter(r: Rig, p: SeedPlayer | null, status: "waitlisted" | "pending"): Promise<string> {
  const { registration } = await seedRegistration(
    r.competitionId,
    r.divisionId,
    { fee_cents: 0, currency: "gbp", payment_method: "offline" },
    { status, displayName: "Entry " + randomUUID().slice(0, 6), contactEmail: `entry-${randomUUID().slice(0, 8)}@t.local` },
  );
  if (p) {
    await sql`
      insert into registration_players (registration_id, full_name, user_id, source)
      values (${registration.id}, 'Player', ${p.userId}, 'captain_entered')`;
  }
  return registration.id;
}

const statusOf = async (id: string): Promise<{ status: string; entrant_id: string | null }> =>
  (await sql<{ status: string; entrant_id: string | null }[]>`select status, entrant_id from registrations where id = ${id}`)[0]!;

/** The waitlist, in the order promotion takes it: `coalesce(waitlisted_at, created_at), id`. */
const queueOf = async (divisionId: string): Promise<string[]> =>
  (
    await sql<{ id: string }[]>`
      select id from registrations where division_id = ${divisionId} and status = 'waitlisted'
       order by coalesce(waitlisted_at, created_at), id`
  ).map((r) => r.id);

const seatedUsers = async (divisionId: string): Promise<string[]> =>
  (
    await sql<{ user_id: string }[]>`
      select p.user_id from entrants e join entrant_members em on em.entrant_id = e.id join persons p on p.id = em.person_id
       where e.division_id = ${divisionId} order by p.user_id`
  ).map((r) => r.user_id);

describe.skipIf(!HAS_DB)("an automatic waitlist promotion on an online division", () => {
  it("skips a registrant who cannot play and promotes the next one; the skipped keeps their place", async () => {
    const r = await rig(true);
    const [reconnect, unlinked, ok] = [await player(r, "identity-only"), await player(r, "none"), await player(r, "plays")];
    const [a, b, c] = [await enter(r, reconnect, "waitlisted"), await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];
    const holder = await enter(r, null, "pending");
    expect(await queueOf(r.divisionId), "premise: the queue is A, B, C").toEqual([a, b, c]);

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(holder)).status, "the withdrawal itself stands").toBe("withdrawn");
    expect((await statusOf(c)).status, "the next who can play is promoted").toBe("confirmed");
    expect((await statusOf(c)).entrant_id).not.toBeNull();
    expect(await seatedUsers(r.divisionId)).toEqual([ok.userId]);
    expect(await queueOf(r.divisionId), "the skipped two are still waitlisted, in their order").toEqual([a, b]);
  });

  it("the promotion email is queued on the outbox for the registrant who was promoted, and for nobody who was skipped", async () => {
    stubOutboxEnv();
    const r = await rig(true);
    try {
      const [reconnect, unlinked, ok] = [await player(r, "identity-only"), await player(r, "none"), await player(r, "plays")];
      const [a, b, c] = [await enter(r, reconnect, "waitlisted"), await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];
      const holder = await enter(r, null, "pending");

      await withdrawRegistrationOrganiser(r.auth, holder);
      expect((await statusOf(c)).status, "premise: C was promoted over the skipped A and B").toBe("confirmed");

      // The mail is queued after the commit, off the request path: wait for the one row, then for its first attempt to settle.
      const rowsOf = () =>
        sql<{ ref_id: string; recipient: string; status: string }[]>`
          select ref_id, recipient, status from email_outbox where kind = 'registration_promoted' and org_id = ${r.auth.orgId}`;
      await vi.waitFor(
        async () => {
          const rows = await rowsOf();
          if (rows.length !== 1) throw new Error(`${rows.length} registration_promoted row(s), waiting for 1`);
          if (rows[0]!.status === "queued" || rows[0]!.status === "sending") throw new Error(`the row is still ${rows[0]!.status}`);
        },
        { timeout: 10_000, interval: 50 },
      );
      const rows = await rowsOf();
      expect(rows, "exactly one promotion email for the whole withdrawal").toHaveLength(1);
      expect(rows[0]!.ref_id, "it is the promoted registration's").toBe(c);
      expect(rows[0]!.recipient, "and goes to the promoted registrant's address").toBe(await contactOf(c));
      expect(rows.map((x) => x.ref_id), "nothing is queued for the two who were skipped").not.toContain(a);
      expect(rows.map((x) => x.ref_id)).not.toContain(b);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await sql`delete from email_outbox where org_id = ${r.auth.orgId}`;
    }
  });

  it("nobody who can play: the withdrawal stands, the spot is simply not taken, the queue is untouched", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(holder)).status).toBe("withdrawn");
    expect(await queueOf(r.divisionId)).toEqual([a]);
    expect(await seatedUsers(r.divisionId)).toEqual([]);
  });

  it("the skipped registrant reconnects and the next freed spot takes them, ahead of the one who was promoted over them", async () => {
    const r = await rig(true);
    const [first, second] = [await player(r, "identity-only"), await player(r, "plays")];
    const [a, b] = [await enter(r, first, "waitlisted"), await enter(r, second, "waitlisted")];
    const [h1, h2] = [await enter(r, null, "pending"), await enter(r, null, "pending")];

    await withdrawRegistrationOrganiser(r.auth, h1);
    expect((await statusOf(b)).status, "premise: B was promoted over A").toBe("confirmed");
    expect((await statusOf(a)).status, "premise: A was skipped").toBe("waitlisted");

    await reconnectLichess(first);
    await withdrawRegistrationOrganiser(r.auth, h2);

    expect((await statusOf(a)).status).toBe("confirmed");
    expect((await statusOf(a)).entrant_id).not.toBeNull();
    expect((await seatedUsers(r.divisionId)).sort()).toEqual([first.userId, second.userId].sort());
  });

  it("the organiser's oldest-first promote skips the same way, and answers null when nobody can be seated", async () => {
    const r = await rig(true);
    const [unlinked, ok] = [await player(r, "none"), await player(r, "plays")];
    const [a, b] = [await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];

    const first = await promoteFromWaitlist(r.auth, r.divisionId);
    expect(first?.id, "B is promoted over the unlinked A").toBe(b);
    expect((await statusOf(a)).status).toBe("waitlisted");

    const second = await promoteFromWaitlist(r.auth, r.divisionId);
    expect(second, "only A is left and cannot be seated").toBeNull();
    expect(await queueOf(r.divisionId)).toEqual([a]);
  });

  it("an expired payment frees a spot: the sweep skips the registrant who cannot play, too", async () => {
    const r = await rig(true);
    const [unlinked, ok] = [await player(r, "none"), await player(r, "plays")];
    const [a, b] = [await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];
    // A card entry whose 48 h window has run out: the sweep expires it and the spot goes to the waitlist.
    const { registration: holder } = await seedRegistration(
      r.competitionId,
      r.divisionId,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { status: "pending", displayName: "Lapsed" },
    );
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${holder.group_id}`;

    await sweepRegistrations("https://example.test");

    expect((await statusOf(holder.id)).status, "premise: the sweep expired the holder").toBe("expired");
    expect((await statusOf(b)).status).toBe("confirmed");
    expect((await statusOf(a)).status).toBe("waitlisted");
    expect(await seatedUsers(r.divisionId)).toEqual([ok.userId]);
  });

  it("a promotion whose window lapsed frees its spot: the sweep's lapsing pass skips the registrant who cannot play, too", async () => {
    const r = await rig(true);
    const [unlinked, ok] = [await player(r, "none"), await player(r, "plays")];
    const [a, b] = [await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];
    // An entry promoted off the waitlist whose confirm-or-lose window has since run out: the pass puts it back and re-offers the spot.
    const lapsed = await enter(r, null, "pending");
    await sql`
      update registrations set promoted_at = now() - interval '2 hours', promotion_expires_at = now() - interval '1 hour'
       where id = ${lapsed}`;

    await sweepRegistrations("https://example.test");

    expect((await statusOf(lapsed)).status, "premise: the lapsing pass put the holder back on the waitlist").toBe("waitlisted");
    expect((await statusOf(b)).status).toBe("confirmed");
    expect((await statusOf(a)).status).toBe("waitlisted");
    expect(await seatedUsers(r.divisionId)).toEqual([ok.userId]);
  });

  it("a division that is not online promotes the oldest, link or no link", async () => {
    const r = await rig(false);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(a)).status).toBe("confirmed");
    expect(await seatedUsers(r.divisionId)).toEqual([unlinked.userId]);
  });

  it("a club that is not offered online chess promotes the oldest, link or no link", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const holder = await enter(r, null, "pending");
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(a)).status).toBe("confirmed");
    expect(flags.isServerFeatureEnabled, "the flag was asked, and said no").toHaveBeenCalledWith("online-chess", expect.any(String), {
      orgId: r.auth.orgId,
      fallback: false,
    });
  });

  it("a promotion that seats nobody (a fee to pay first) is not gated - the seat is gated where it happens", async () => {
    const r = await rig(true, 500);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    const promoted = await statusOf(a);
    expect(promoted.status, "promoted to pay").toBe("pending");
    expect(promoted.entrant_id, "and not seated").toBeNull();
  });
});

const contactOf = async (id: string): Promise<string> =>
  (
    await sql<{ contact_email: string }[]>`
      select g.contact_email from registrations r join registration_groups g on g.id = r.group_id where r.id = ${id}`
  )[0]!.contact_email;

/** The skips the audit ledger holds for the competition: who, and the gate's own code. Sorted by registration: the skips of ONE promotion are
 *  written in one transaction, so they share a timestamp and the ledger's uuid ids do not say which came first. */
const skipsOf = async (competitionId: string): Promise<{ registration: string; code: string | null; actor: string | null }[]> =>
  (
    await sql<{ payload: { registration_id: string; code: string | null }; actor_id: string | null }[]>`
      select payload, actor_id from competition_events
       where competition_id = ${competitionId} and type = 'registration.promotion_skipped'`
  )
    .map((e) => ({ registration: e.payload.registration_id, code: e.payload.code, actor: e.actor_id }))
    .sort((x, y) => x.registration.localeCompare(y.registration));

describe.skipIf(!HAS_DB)("a skipped registrant is on the record", () => {
  it("each skip writes a promotion_skipped row with the gate's own code, mails nobody, and a promotion that went through writes none", async () => {
    const r = await rig(true);
    const [reconnect, unlinked, ok] = [await player(r, "identity-only"), await player(r, "none"), await player(r, "plays")];
    const [a, b, c] = [await enter(r, reconnect, "waitlisted"), await enter(r, unlinked, "waitlisted"), await enter(r, ok, "waitlisted")];
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(c)).status, "premise: C took the spot").toBe("confirmed");
    expect(await skipsOf(r.competitionId), "A and B, with the code the gate gave each; no row for C").toEqual(
      [
        { registration: a, code: "LICHESS_RECONSENT_REQUIRED", actor: null },
        { registration: b, code: "LICHESS_LINK_REQUIRED", actor: null },
      ].sort((x, y) => x.registration.localeCompare(y.registration)),
    );
    // Nobody is notified of a skip: the registrants passed over, and the ones not, are told nothing by it.
    const skippedAddresses = [await contactOf(a), await contactOf(b)];
    expect(
      mail.sent.filter((m) => skippedAddresses.includes(m.to as string)),
      "no mail went to a skipped registrant",
    ).toEqual([]);
  });

  it("the SEQUENCE: every spot that passes a registrant is recorded against them again", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const [h1, h2] = [await enter(r, null, "pending"), await enter(r, null, "pending")];

    await withdrawRegistrationOrganiser(r.auth, h1);
    expect(await skipsOf(r.competitionId), "premise: one skip after one freed spot").toHaveLength(1);
    await withdrawRegistrationOrganiser(r.auth, h2);

    expect((await skipsOf(r.competitionId)).map((s) => s.registration), "a second freed spot passes them again").toEqual([a, a]);
  });

  it("an empty queue, or a queue of registrants who can all play, records nothing", async () => {
    const r = await rig(true);
    const empty = await enter(r, null, "pending");
    await withdrawRegistrationOrganiser(r.auth, empty);
    const ok = await player(r, "plays");
    await enter(r, ok, "waitlisted");
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect(await skipsOf(r.competitionId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the pre-filter spares the seat, and the savepoint is the net under it", () => {
  it("registrants who cannot play are passed over before any seat is attempted: the gate is only asked about the one who is seated", async () => {
    const r = await rig(true);
    const [unlinked, reconnect, ok] = [await player(r, "none"), await player(r, "identity-only"), await player(r, "plays")];
    const [a, b, c] = [await enter(r, unlinked, "waitlisted"), await enter(r, reconnect, "waitlisted"), await enter(r, ok, "waitlisted")];
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(c)).status, "premise: C is seated").toBe("confirmed");
    expect(await queueOf(r.divisionId), "premise: A and B were passed over and keep their place").toEqual([a, b]);
    expect(seats.rosters, "the seat gate judged ONE roster - C's - and never tried the seats of A and B").toEqual([[ok.personId]]);
  });

  it("a registrant the pre-filter cannot judge (an entry with no player rows) is still refused by the seat itself: the savepoint skips them and records it", async () => {
    const r = await rig(true);
    const ok = await player(r, "plays");
    // An entry with no registration_players row seats a person made from its display name - who has no account, so no link.
    const anonymous = await enter(r, null, "waitlisted");
    const c = await enter(r, ok, "waitlisted");
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(c)).status, "the next in line took the spot").toBe("confirmed");
    expect((await statusOf(anonymous)).status, "the anonymous entry keeps its place").toBe("waitlisted");
    expect(seats.rosters.length, "the seat WAS tried for the anonymous entry (the pre-filter had nothing to judge), then for C").toBe(2);
    expect(seats.rosters[1]).toEqual([ok.personId]);
    expect(await skipsOf(r.competitionId)).toEqual([{ registration: anonymous, code: "LICHESS_LINK_REQUIRED", actor: null }]);
    expect(await seatedUsers(r.divisionId), "and no person was left behind by the rolled-back attempt").toEqual([ok.userId]);
  });
});

describe.skipIf(!HAS_DB)("only the gate's refusal is skipped: any other failure fails the whole call", () => {
  it("a seat that fails for another reason fails the withdrawal that freed the spot, and nothing is promoted or skipped", async () => {
    const r = await rig(true);
    const anonymous = await enter(r, null, "waitlisted");
    const holder = await enter(r, null, "pending");
    // The pre-filter asks first (and passes the entry: it has no players to refuse); the failure is the SEAT's own ask, inside the savepoint.
    poison.skip = 1;
    poison.remaining = 1;

    await expect(withdrawRegistrationOrganiser(r.auth, holder)).rejects.toThrow(/boom: the link lookup failed/);

    expect(poison.remaining, "premise: the failure was raised and used").toBe(0);
    expect((await statusOf(holder)).status, "the withdrawal rolled back with it").toBe("pending");
    expect((await statusOf(anonymous)).status).toBe("waitlisted");
    expect(await skipsOf(r.competitionId), "a failure is not a skip").toEqual([]);
  });

  it("the same failure raised by the pre-filter's own read fails the call too, and the next attempt - the failure gone - promotes", async () => {
    const r = await rig(true);
    const ok = await player(r, "plays");
    const a = await enter(r, ok, "waitlisted");
    const holder = await enter(r, null, "pending");
    poison.remaining = 1;

    await expect(withdrawRegistrationOrganiser(r.auth, holder)).rejects.toThrow(/boom: the link lookup failed/);
    expect((await statusOf(a)).status, "premise: nothing was promoted by the failed call").toBe("waitlisted");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(a)).status).toBe("confirmed");
  });
});

describe.skipIf(!HAS_DB)("a promotion that would seat with no gate to ask fails closed", () => {
  it("promoteWaitlistedRow and promoteOldestWaitlisted refuse (409) rather than seat ungated, and leave the registrant waitlisted", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const settings = (await loadSettings(sql, r.divisionId))!;
    expect(settings.approval, "premise: these settings seat on promotion (free, auto)").toBe("auto");
    expect(settings.fee_cents).toBe(0);
    const [{ group_id: groupId }] = await sql<{ group_id: string }[]>`select group_id from registrations where id = ${a}`;

    const viaRow = await sql.begin((tx) => promoteWaitlistedRow(tx, a, groupId, settings)).then(
      () => null,
      (err: unknown) => err,
    );
    const viaQueue = await sql.begin((tx) => promoteOldestWaitlisted(tx, r.divisionId, settings)).then(
      () => null,
      (err: unknown) => err,
    );

    for (const got of [viaRow, viaQueue]) {
      expect(got).toBeInstanceOf(HttpError);
      expect((got as HttpError).status).toBe(409);
    }
    expect(await statusOf(a), "refused, nothing written: still waitlisted, no entrant").toEqual({ status: "waitlisted", entrant_id: null });
  });

  it("a promotion that seats nobody (a fee to pay first) needs no gate, as before", async () => {
    const r = await rig(true, 500);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const settings = (await loadSettings(sql, r.divisionId))!;
    const [{ group_id: groupId }] = await sql<{ group_id: string }[]>`select group_id from registrations where id = ${a}`;

    const promoted = await sql.begin((tx) => promoteWaitlistedRow(tx, a, groupId, settings));

    expect(promoted?.status).toBe("pending");
    expect((await statusOf(a)).entrant_id).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("what the pre-filter leaves to the promotion itself", () => {
  it("a waitlisted solo sign-up (free agent) seats nobody, so it is promoted whatever its link", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const solo = await enter(r, unlinked, "waitlisted");
    await sql`update registrations set free_agent = true where id = ${solo}`;
    const holder = await enter(r, null, "pending");

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect(await statusOf(solo), "confirmed, and seated nowhere: a solo sign-up has no roster of its own").toEqual({ status: "confirmed", entrant_id: null });
    expect(await skipsOf(r.competitionId), "and not recorded as a skip").toEqual([]);
  });

  it("settings that no longer seat on promotion (a fee set after the gate was opened) have nothing to refuse: the registrant is promoted to pay", async () => {
    const r = await rig(true);
    const unlinked = await player(r, "none");
    const a = await enter(r, unlinked, "waitlisted");
    const gate = await openRegistrationSeatGate({ divisionId: r.divisionId, auth: r.auth }); // opened while the division promotes straight into a seat
    const nowAFee = { ...(await loadSettings(sql, r.divisionId))!, fee_cents: 500 };

    const promoted = await sql.begin(async (tx) => {
      await gate.load(tx);
      return promoteOldestWaitlisted(tx, r.divisionId, nowAFee, undefined, gate);
    });

    expect(promoted?.id).toBe(a);
    expect(await statusOf(a)).toEqual({ status: "pending", entrant_id: null });
    expect(await skipsOf(r.competitionId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A registrant who submitted with no date of birth
// ---------------------------------------------------------------------------
// Their own row is untied from their account (`deriveLinkUserId`), but the cart remembers who was signed in and the submit asked that
// session's link: the promotion reads the same account the organiser's Approve does (online-seat-gate-writers.test.ts). Built by the REAL
// submit into a full division (capacity 1), so the entry is waitlisted by the producer and not by a hand-written row.

/** An account with a Lichess link of `kind` and NO person row (the seat makes the person). */
async function bareAccount(kind: Kind): Promise<SeedPlayer> {
  const lichessId = `w-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}@t.local`}, ${"Player " + lichessId}, true, 'en') returning id`;
  const p = { userId, lichessId, personId: "" } as SeedPlayer;
  if (kind === "plays") await reconnectLichess(p);
  if (kind === "identity-only") await linkWithoutPlayConsent(p, "identity-only");
  return p;
}

async function waitlistedSubmitter(r: Rig, who: SeedPlayer): Promise<string> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${r.auth.orgId}`;
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${r.competitionId}`;
  const res = await submitRegistrationGroup(
    { orgSlug, compSlug, sessionUserId: who.userId },
    {
      contact: { name: "Player " + who.lichessId, email: `${who.lichessId}@t.local` },
      privacy_consent: true,
      entries: [
        {
          division_id: r.divisionId,
          entrant_kind: "individual",
          team_name: null,
          players: [{ full_name: "Player " + who.lichessId }],
          registering_self: true,
          self_player_index: 0,
          answers: {},
        },
      ],
    },
  );
  const entry = res.entries[0]!;
  expect(entry.status, "premise: the division is full, so the real submit waitlisted the entry").toBe("waitlisted");
  const [row] = await sql<{ user_id: string | null }[]>`select user_id from registration_players where registration_id = ${entry.registration_id}`;
  expect(row!.user_id, "premise: no date of birth, so the player row is not tied to the account").toBeNull();
  return entry.registration_id;
}

async function fullRig(): Promise<Rig> {
  const r = await rig(true);
  // The public submit only finds a public competition.
  await sql`update competitions set visibility = 'public' where id = ${r.competitionId}`;
  await putRegistrationSettings(r.auth, r.divisionId, {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: 1,
    refund_lock_at: null,
    payment_method: "offline",
    approval: "auto",
    allow_free_agents: false,
  });
  return r;
}

describe.skipIf(!HAS_DB)("a waitlisted submitter with no date of birth", () => {
  it("is promoted and seated when they hold a link that plays (the pre-filter and the seat both read their cart's account)", async () => {
    const r = await fullRig();
    const holder = await enter(r, null, "pending");
    const who = await bareAccount("plays");
    const entry = await waitlistedSubmitter(r, who);

    await withdrawRegistrationOrganiser(r.auth, holder);

    expect((await statusOf(entry)).status).toBe("confirmed");
    expect((await statusOf(entry)).entrant_id).not.toBeNull();
    expect(await skipsOf(r.competitionId), "and not recorded as a skip").toEqual([]);
  });

  it("is skipped, with the gate's own code, once their link is gone - and takes the spot after they reconnect", async () => {
    const r = await fullRig();
    const [h1, h2] = [await enter(r, null, "pending"), await enter(r, null, "pending")];
    const who = await bareAccount("plays");
    const entry = await waitlistedSubmitter(r, who);
    await sql`delete from user_external_accounts where user_id = ${who.userId}`;

    await withdrawRegistrationOrganiser(r.auth, h1);
    expect((await statusOf(entry)).status, "premise: the spot is not theirs while they cannot play").toBe("waitlisted");
    expect(await skipsOf(r.competitionId)).toEqual([{ registration: entry, code: "LICHESS_LINK_REQUIRED", actor: null }]);
    await reconnectLichess(who);
    await withdrawRegistrationOrganiser(r.auth, h2);

    expect((await statusOf(entry)).status).toBe("confirmed");
  });
});
