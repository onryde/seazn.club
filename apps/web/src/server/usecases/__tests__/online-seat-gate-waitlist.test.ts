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

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { promoteFromWaitlist } from "../registration-approval";
import { sweepRegistrations, withdrawRegistrationOrganiser } from "../registrations";
import { seedRegistration } from "./_registration-fixtures";
import { linkWithoutPlayConsent, reconnectLichess, seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
afterEach(() => {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
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
  await sql`
    insert into registration_settings (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
    values (${division.id}, true, 'individual', ${fee}, 'offline', 'auto', false)`;
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
    { status, displayName: "Entry " + randomUUID().slice(0, 6) },
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
