// The two seat writers the first sweep of the seat gate (online-seat-gate-doors.test.ts) left out as "unreachable":
//
//   assign   assignSoloSignUp -> joinExistingEntrant   an organiser places a pooled solo sign-up on a team that already exists
//   submit   submitRegistrationGroup                   a free, auto-approval entry confirms INLINE and seats its whole roster
//
// Both ARE reachable. `putRegistrationSettings` checks no entrant model (a team or pair division with solo sign-ups on can be
// saved for a boardgame division that plays online), so these tests build the division the way an organiser does - through
// `putRegistrationSettings`, never a raw settings row - and drive each writer through its real usecase against the real
// database: the settings are the real producer, the writer is the real consumer.
//
// Who is checked where, so no test here asserts a thing the code does not promise:
//   * the SUBMITTER is asked at submit by their own session link, before the transaction (`assertUserHasLichessForOnlinePlay`);
//     the seat gate adds everyone ELSE the inline confirm seats. A teammate typed in by the captain has no account to link, so a
//     team or pair of two on an online division is refused at submit, as `approveRegistration` refuses the very same entry.
//   * the solo sign-up an organiser places is asked by the account on the sign-up itself.
//
// Boardgame only: the one sport that plays online (`supportsOnlinePlay`). The sport sweep for the gate itself is in the doors file.
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
// Fire-and-forget mail, after the commit: not what these tests are about.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSoloSignUpAssignedEmail: vi.fn(async () => true),
}));
vi.mock("../registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../registrations")>()),
  inviteUnclaimedMembers: vi.fn(async () => undefined),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { loadSides } from "../external-play/guard";
import { playGrantRefusal } from "../external-play/preflight";
import { openRegistrationSeatGate } from "../online-seat-gate";
import { assignSoloSignUp } from "../registration-assign";
import { approveRegistration } from "../registration-approval";
import { joinTeamEntry, submitRegistrationGroup, type SubmitGroupEntryInput } from "../registration-submit";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { seedRegistration } from "./_registration-fixtures";
import { linkWithoutPlayConsent, reconnectLichess, seedOwner } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
afterEach(() => {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
});

const ran = { scenarios: 0, writers: new Set<string>() };
const count = (writer: string) => {
  ran.scenarios++;
  ran.writers.add(writer);
};

// ---------------------------------------------------------------------------
// The division, built the way an organiser builds it
// ---------------------------------------------------------------------------

type Kind = "team" | "pair" | "individual";
interface World {
  auth: AuthCtx;
  orgSlug: string;
  competitionId: string;
  compSlug: string;
  divisionId: string;
}

function inDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function world(kind: Kind, online: boolean, over: { approval?: "auto" | "manual" } = {}): Promise<World> {
  const auth = await seedOwner();
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    name: "Seat writers " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: inDays(60),
    ends_on: inDays(62),
  });
  const division = await createDivision(auth, competition.id, {
    name: online ? "Online" : "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(online ? { onlinePlay: "lichess" } : {}), clock: { base: 600, increment: 5 } },
  });
  // Chess takes individual players only (owner ruling 2026-10-26), so putRegistrationSettings refuses a team or pair
  // chess division (CHESS_INDIVIDUAL_ONLY). These tests are for the divisions saved BEFORE that ruling that still hold
  // the shape: the door code must keep reading them. So the row is made as an individual division through the real
  // writer, then moved to the legacy shape directly. Solo sign-ups only exist on a team division.
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    approval: over.approval ?? "auto",
    allow_free_agents: false,
  });
  await sql`
    update registration_settings
       set entrant_kind = ${kind}, allow_free_agents = ${kind === "team"}
     where division_id = ${division.id}`;
  const [saved] = await sql<{ entrant_kind: string }[]>`
    select entrant_kind from registration_settings where division_id = ${division.id}`;
  expect(saved?.entrant_kind, "premise: the division is stored as a " + kind + " division").toBe(kind);
  return { auth, orgSlug, competitionId: competition.id, compSlug: competition.slug, divisionId: division.id };
}

/** Takes the flag away from the club AFTER the division was built (building an online division is itself gated by the flag). */
function loseTheFlag(): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);
}

type LinkKind = "plays" | "identity-only" | "none";
interface Account {
  userId: string;
  lichessId: string;
  /** null: the account has no person row in the org yet - the one the seat creates. */
  personId: string | null;
}

async function account(w: World, kind: LinkKind, withPerson: boolean): Promise<Account> {
  const lichessId = `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}-${randomUUID().slice(0, 6)}@t.local`}, ${"Player " + lichessId}, true, 'en') returning id`;
  let personId: string | null = null;
  if (withPerson) {
    [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${w.auth.orgId}, ${"Player " + lichessId}, ${userId}) returning id`;
  }
  if (kind === "plays") await reconnectLichess({ userId, lichessId });
  if (kind === "identity-only") await linkWithoutPlayConsent({ userId, lichessId }, "identity-only");
  return { userId, lichessId, personId };
}

const refusalOf = async (promise: Promise<unknown>): Promise<{ status?: number; code?: string; ids?: unknown }> => {
  const e = (await promise.then(
    () => null,
    (err: unknown) => err,
  )) as { status?: number; code?: string; extra?: { person_ids?: unknown } } | null;
  expect(e, "premise: it was refused").not.toBeNull();
  return { status: e!.status, code: e!.code, ids: e!.extra?.person_ids };
};

// ---------------------------------------------------------------------------
// assign: assignSoloSignUp -> joinExistingEntrant
// ---------------------------------------------------------------------------

interface Placement {
  go: () => Promise<unknown>;
  /** The users of everyone seated on the team's entrant. */
  seated: () => Promise<string[]>;
  /** Roster rows the team entry holds (registration_players), assigned or not. */
  rosterRows: () => Promise<number>;
  targetId: string;
}

/** A team entry that is already materialised (so `joinExistingEntrant` is the writer that seats the newcomer) and a pooled solo
 *  sign-up for `who`. `materialised: false` leaves the team unconfirmed: the seat is then made later, by `materialise`. */
async function placement(w: World, who: Account, opts: { materialised?: boolean } = {}): Promise<Placement> {
  const settings = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
  const { registration: target } = await seedRegistration(w.competitionId, w.divisionId, settings, { status: "pending", displayName: "Team " + randomUUID().slice(0, 6) });
  if (opts.materialised ?? true) await confirmRegistration(w.auth, target.id);
  const { registration: solo } = await seedRegistration(w.competitionId, w.divisionId, settings, { status: "confirmed", displayName: "Solo " + randomUUID().slice(0, 6) });
  await sql`update registrations set free_agent = true where id = ${solo.id}`;
  await sql`
    insert into registration_players (registration_id, full_name, user_id, source, consent_status)
    values (${solo.id}, ${"Player " + who.lichessId}, ${who.userId}, 'captain_entered', 'granted')`;
  return {
    targetId: target.id,
    go: () => assignSoloSignUp(w.auth, { registration_id: solo.id, target_registration_id: target.id }),
    seated: async () =>
      (
        await sql<{ user_id: string | null }[]>`
          select p.user_id from registrations r join entrant_members em on em.entrant_id = r.entrant_id join persons p on p.id = em.person_id
           where r.id = ${target.id}`
      ).map((m) => m.user_id ?? "(accountless)"),
    rosterRows: async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from registration_players where registration_id = ${target.id}`)[0]!.n,
  };
}

describe.skipIf(!HAS_DB)("assign: placing a solo sign-up on a team that already exists seats them, so it asks the seat gate", () => {
  it("a link that plays is placed and seated", async () => {
    const w = await world("team", true);
    const who = await account(w, "plays", true);
    const p = await placement(w, who);
    expect(await p.seated(), "premise: the team entry is materialised and empty").toEqual([]);

    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    count("assign");
  });

  it("an identity-only link is refused as RECONNECT, names the person, and writes nothing", async () => {
    const w = await world("team", true);
    const who = await account(w, "identity-only", true);
    const p = await placement(w, who);

    const got = await refusalOf(p.go());

    expect(got).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED", ids: [who.personId] });
    expect(await p.seated()).toEqual([]);
    expect(await p.rosterRows(), "the roster row the placement inserted was rolled back with the seat").toBe(0);
    count("assign");
  });

  it("no link is refused as LINK, names the person, and writes nothing", async () => {
    const w = await world("team", true);
    const who = await account(w, "none", true);
    const p = await placement(w, who);

    const got = await refusalOf(p.go());

    expect(got).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED", ids: [who.personId] });
    expect(await p.seated()).toEqual([]);
    expect(await p.rosterRows()).toBe(0);
    count("assign");
  });

  it("the SEQUENCE: refused, the player reconnects, the same placement succeeds", async () => {
    const w = await world("team", true);
    const who = await account(w, "identity-only", true);
    const p = await placement(w, who);

    await refusalOf(p.go());
    expect(await p.seated(), "premise: refused, nobody seated").toEqual([]);
    await reconnectLichess(who);
    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    expect(await p.rosterRows(), "one roster row, not one per attempt").toBe(1);
    count("assign");
  });

  it("a second call after success is the idempotent no-op it always was (the gate is not asked again)", async () => {
    const w = await world("team", true);
    const who = await account(w, "plays", true);
    const p = await placement(w, who);
    await p.go();
    // The player's grant is withdrawn after the seat: the repeat answers 'already placed', it does not re-judge a seat they hold.
    await sql`delete from user_external_accounts where user_id = ${who.userId}`;

    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    count("assign");
  });

  it("a player with no person row yet (made by the placement itself) and no link is refused, and no person is left behind or named", async () => {
    const w = await world("team", true);
    const who = await account(w, "none", false);
    const p = await placement(w, who);

    const got = await refusalOf(p.go());

    expect(got.code).toBe("LICHESS_LINK_REQUIRED");
    expect(await sql`select 1 from persons where org_id = ${w.auth.orgId} and user_id = ${who.userId}`, "the refused call created no person").toHaveLength(0);
    expect(got.ids, "and so it names nobody: the person it would have named does not exist").toEqual([]);
    count("assign");
  });

  it("a player with no person row yet who plays is placed", async () => {
    const w = await world("team", true);
    const who = await account(w, "plays", false);
    const p = await placement(w, who);

    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    count("assign");
  });

  it("a team that is not materialised yet seats nobody now: the placement stands and the seat is asked when the team is confirmed", async () => {
    const w = await world("team", true);
    const who = await account(w, "none", true);
    const p = await placement(w, who, { materialised: false });

    await p.go();

    expect(await p.rosterRows(), "premise: the player is on the team's registration").toBe(1);
    expect(await p.seated(), "premise: and not yet seated anywhere").toEqual([]);
    const got = await refusalOf(confirmRegistration(w.auth, p.targetId));
    expect(got.code, "the confirm, which seats them, asks").toBe("LICHESS_LINK_REQUIRED");
    count("assign");
  });

  it("a team that is not materialised yet: a player who PLAYS is not refused when the team is confirmed, and is seated as their own account", async () => {
    const w = await world("team", true);
    const who = await account(w, "plays", true);
    const p = await placement(w, who, { materialised: false });

    await p.go();
    const [row] = await sql<{ user_id: string | null }[]>`select user_id from registration_players where registration_id = ${p.targetId}`;
    expect(row!.user_id, "premise: the placed row names the solo's account, so the confirm that seats them can read their link").toBe(who.userId);
    await confirmRegistration(w.auth, p.targetId);

    expect(await p.seated(), "seated on the account the solo signed up with").toEqual([who.userId]);
    count("assign");
  });

  it("a team that is not materialised yet: a player with an identity-only link is refused as RECONNECT when the team is confirmed", async () => {
    const w = await world("team", true);
    const who = await account(w, "identity-only", true);
    const p = await placement(w, who, { materialised: false });

    await p.go();
    const got = await refusalOf(confirmRegistration(w.auth, p.targetId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
    expect(await p.seated()).toEqual([]);
    count("assign");
  });

  it("a division that is not online asks for no link", async () => {
    const w = await world("team", false);
    const who = await account(w, "none", true);
    const p = await placement(w, who);

    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    count("assign");
  });

  it("a club that is not offered online chess is never asked for a link", async () => {
    const w = await world("team", true);
    const who = await account(w, "none", true);
    const p = await placement(w, who);
    loseTheFlag();

    await p.go();

    expect(await p.seated()).toEqual([who.userId]);
    expect(flags.isServerFeatureEnabled, "the flag was asked, and said no").toHaveBeenCalledWith("online-chess", expect.any(String), {
      orgId: w.auth.orgId,
      fallback: false,
    });
    count("assign");
  });
});

// ---------------------------------------------------------------------------
// submit: the inline confirm
// ---------------------------------------------------------------------------

const ADULT = "1990-01-01";

/** A cart of ONE entry from `submitter` (registering themself) and `mates` more players typed in by them. */
async function submit(
  w: World,
  kind: Kind,
  submitter: Account,
  mates: number,
  contact: { dob?: string | null; guardian_name?: string; guardian_consent?: boolean } = { dob: ADULT },
  /** `rosterless`: a team the captain enters without putting themselves on it (nobody on the roster; players join by the link). */
  opts: { rosterless?: boolean } = {},
): Promise<ReturnType<typeof submitRegistrationGroup>> {
  const entry: SubmitGroupEntryInput = {
    division_id: w.divisionId,
    entrant_kind: kind,
    team_name: kind === "team" ? "Seat Club " + randomUUID().slice(0, 6) : null,
    players: opts.rosterless
      ? []
      : [
          { full_name: "Submitter " + submitter.lichessId, is_captain: true },
          ...Array.from({ length: mates }, (_, i) => ({ full_name: `Teammate ${i + 1} ${randomUUID().slice(0, 6)}` })),
        ],
    registering_self: true,
    ...(opts.rosterless ? {} : { self_player_index: 0 }),
    answers: {},
  };
  return submitRegistrationGroup(
    { orgSlug: w.orgSlug, compSlug: w.compSlug, sessionUserId: submitter.userId },
    {
      contact: { name: "Submitter " + submitter.lichessId, email: `${submitter.lichessId}@t.local`, ...contact },
      privacy_consent: true,
      entries: [entry],
    },
  );
}

const writtenBy = async (w: World): Promise<{ registrations: number; groups: number; entrants: number }> => ({
  registrations: (await sql<{ n: number }[]>`select count(*)::int as n from registrations where division_id = ${w.divisionId}`)[0]!.n,
  groups: (await sql<{ n: number }[]>`select count(*)::int as n from registration_groups where competition_id = ${w.competitionId}`)[0]!.n,
  entrants: (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${w.divisionId}`)[0]!.n,
});

/** The people seated on the entry's entrant, with the account each is tied to (null: untied). */
const seatedPeople = async (registrationId: string): Promise<{ id: string; full_name: string; user_id: string | null }[]> =>
  sql<{ id: string; full_name: string; user_id: string | null }[]>`
    select p.id, p.full_name, p.user_id
      from registrations r join entrant_members em on em.entrant_id = r.entrant_id join persons p on p.id = em.person_id
     where r.id = ${registrationId} order by p.full_name`;

const seatedAfterSubmit = async (registrationId: string): Promise<{ status: string; people: number }> => {
  const [r] = await sql<{ status: string; people: number }[]>`
    select r.status, (select count(*)::int from entrant_members em where em.entrant_id = r.entrant_id) as people
      from registrations r where r.id = ${registrationId}`;
  return r!;
};

describe.skipIf(!HAS_DB)("submit: the inline confirm seats the whole roster, so it asks the seat gate about everyone it seats", () => {
  for (const kind of ["team", "pair"] as const) {
    describe(kind, () => {
      it("a captain whose teammate has no account is refused as LINK; nothing is written", async () => {
        const w = await world(kind, true);
        const captain = await account(w, "plays", false);

        const got = await refusalOf(submit(w, kind, captain, 1));

        expect(got.status).toBe(422);
        expect(got.code).toBe("LICHESS_LINK_REQUIRED");
        expect(await writtenBy(w), "the whole submit rolled back: no entry, no cart, no entrant").toEqual({ registrations: 0, groups: 0, entrants: 0 });
        count("submit");
      });

      it("the refusal names only people who still exist after it (the roster it refused was minted inside the transaction it rolled back)", async () => {
        const w = await world(kind, true);
        const captain = await account(w, "plays", false);

        const got = await refusalOf(submit(w, kind, captain, 1));

        expect(got.ids, "key present, and empty: nobody the refusal could name survived it").toEqual([]);
        count("submit");
      });

      it("a division that is not online seats the same roster", async () => {
        const w = await world(kind, false);
        const captain = await account(w, "plays", false);

        const res = await submit(w, kind, captain, 1);

        expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "confirmed", people: 2 });
        count("submit");
      });

      it("a club that is not offered online chess seats the same roster", async () => {
        const w = await world(kind, true);
        const captain = await account(w, "plays", false);
        loseTheFlag();

        const res = await submit(w, kind, captain, 1);

        expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "confirmed", people: 2 });
        expect(flags.isServerFeatureEnabled).toHaveBeenCalledWith("online-chess", expect.any(String), { orgId: w.auth.orgId, fallback: false });
        count("submit");
      });

      it("manual approval seats nobody at submit, so there is nothing to ask yet (the approve door asks, in the doors file)", async () => {
        const w = await world(kind, true, { approval: "manual" });
        const captain = await account(w, "plays", false);

        const res = await submit(w, kind, captain, 1);

        expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "pending", people: 0 });
        count("submit");
      });
    });
  }

  it("a team of ONE - just the captain, who holds the link the submit already asked for - is seated", async () => {
    const w = await world("team", true);
    const captain = await account(w, "plays", false);

    const res = await submit(w, "team", captain, 0);

    expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "confirmed", people: 1 });
    const users = await sql<{ user_id: string | null }[]>`
      select p.user_id from registrations r join entrant_members em on em.entrant_id = r.entrant_id join persons p on p.id = em.person_id
       where r.id = ${res.entries[0]!.registration_id}`;
    expect(users.map((u) => u.user_id), "and the seat is the captain's own account").toEqual([captain.userId]);
    count("submit");
  });

  for (const kind of ["individual", "team"] as const) {
    it(`${kind}: a captain who holds a link but gave no date of birth is seated - the submit asked their session link, and the gate asks only about the others`, async () => {
      const w = await world(kind, true);
      const captain = await account(w, "plays", false);

      const res = await submit(w, kind, captain, 0, { dob: null });

      const [player] = await sql<{ user_id: string | null }[]>`select user_id from registration_players where registration_id = ${res.entries[0]!.registration_id}`;
      expect(player!.user_id, "premise: without a date of birth the player row is NOT tied to the account (deriveLinkUserId)").toBeNull();
      expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "confirmed", people: 1 });
      expect((await seatedPeople(res.entries[0]!.registration_id)).map((p) => p.user_id), "and the seat ties the person to the account the board will read").toEqual([captain.userId]);
      count("submit");
    });
  }

  it("the SEQUENCE: the refused team re-submits as the captain alone and is seated; the refusal left no half-cart behind", async () => {
    const w = await world("team", true);
    const captain = await account(w, "plays", false);

    await refusalOf(submit(w, "team", captain, 1));
    expect((await writtenBy(w)).registrations, "premise: refused, nothing written").toBe(0);
    const res = await submit(w, "team", captain, 0);

    expect(await seatedAfterSubmit(res.entries[0]!.registration_id)).toEqual({ status: "confirmed", people: 1 });
    expect(await writtenBy(w), "exactly one entry, one cart, one entrant").toEqual({ registrations: 1, groups: 1, entrants: 1 });
    count("submit");
  });

  it("a captain with no link of their own is still turned away first, by the submit's own question about the submitter", async () => {
    const w = await world("team", true);
    const captain = await account(w, "none", false);

    const got = await refusalOf(submit(w, "team", captain, 0));

    expect(got.code).toBe("LICHESS_LINK_REQUIRED");
    expect(await writtenBy(w)).toEqual({ registrations: 0, groups: 0, entrants: 0 });
    count("submit");
  });
});

// ---------------------------------------------------------------------------
// approve: the submitter whose own row carries no account
// ---------------------------------------------------------------------------
//
// `deriveLinkUserId` ties the submitter's own row to their account only for an adult WITH a date of birth; without one the row's
// `user_id` is null, though the cart (`registration_groups.user_id`) still remembers who signed in and the submit asked THAT session's
// link. On a manual-approval division the organiser's Approve is the first time the row is seated, so the gate must read the
// submitter's link by the cart's account - and only for the submitter's own row: not for a teammate, not for a joiner, not for a row
// the submit left untied on purpose (a minor, a guardian's entry). Every scenario below is built by the real submit (and the real
// join link), never by writing the rows by hand.

const withdrawLink = async (a: Account): Promise<void> => {
  await sql`delete from user_external_accounts where user_id = ${a.userId}`;
};

const submitterPremises = async (registrationId: string, submitter: Account): Promise<void> => {
  const rows = await sql<{ user_id: string | null; cart_user: string | null }[]>`
    select rp.user_id, g.user_id as cart_user
      from registration_players rp join registrations r on r.id = rp.registration_id join registration_groups g on g.id = r.group_id
     where rp.registration_id = ${registrationId}`;
  expect(rows, "premise: the entry holds the submitter's one row").toHaveLength(1);
  expect(rows[0]!.user_id, "premise: without a date of birth the row is NOT tied to the account (deriveLinkUserId)").toBeNull();
  expect(rows[0]!.cart_user, "premise: but the cart remembers who was signed in").toBe(submitter.userId);
  expect(await seatedAfterSubmit(registrationId), "premise: manual approval seats nobody at submit").toEqual({ status: "pending", people: 0 });
};

describe.skipIf(!HAS_DB)("approve: a submitter who holds a link but gave no date of birth is seated by it", () => {
  for (const kind of ["individual", "team"] as const) {
    it(`${kind}: the organiser's Approve seats them`, async () => {
      const w = await world(kind, true, { approval: "manual" });
      const submitter = await account(w, "plays", false);
      const res = await submit(w, kind, submitter, 0, { dob: null });
      const regId = res.entries[0]!.registration_id;
      await submitterPremises(regId, submitter);

      await approveRegistration(w.auth, regId);

      expect(await seatedAfterSubmit(regId)).toEqual({ status: "confirmed", people: 1 });
      // The gate and the board are one authority: the person Approve seated is the one the BOARD's own reader (`loadSides`, then T2's
      // play-grant check) finds a playing Lichess link for. A seat the gate allowed and the board then turned away is the defect.
      const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${regId}`;
      const { home } = await loadSides({ homeEntrantId: entrantId, awayEntrantId: entrantId });
      expect(home.userId, "the board resolves the seated person to the submitter's account").toBe(submitter.userId);
      expect(home.lichess, "and to their Lichess link").toEqual({ id: submitter.lichessId, username: submitter.lichessId });
      expect(await playGrantRefusal(home.userId), "which plays").toBeNull();
      count("approve-submitter");
    });
  }

  it("the link they held is the one asked: withdrawn after the submit, Approve refuses as LINK and seats nobody", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;
    await withdrawLink(submitter);

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(await seatedAfterSubmit(regId), "refused: still waiting, nobody seated").toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("an identity-only link (the play grant withdrawn) is refused as RECONNECT, not waved through as 'linked'", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;
    await withdrawLink(submitter);
    await linkWithoutPlayConsent(submitter, "identity-only");

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_RECONSENT_REQUIRED" });
    expect(await seatedAfterSubmit(regId)).toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("the SEQUENCE: refused with no link, the player reconnects, the same Approve seats them", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;
    await withdrawLink(submitter);

    await refusalOf(approveRegistration(w.auth, regId));
    await reconnectLichess(submitter);
    await approveRegistration(w.auth, regId);

    expect(await seatedAfterSubmit(regId)).toEqual({ status: "confirmed", people: 1 });
    count("approve-submitter");
  });

  it("a pair: the captain's link does not stand in for a teammate the captain typed in", async () => {
    const w = await world("pair", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const regId = (await submit(w, "pair", captain, 1, { dob: null })).entries[0]!.registration_id;

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(await seatedAfterSubmit(regId), "nobody seated: the teammate has no link").toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("a pair whose teammate claims their spot through the join link (an adult with a date of birth, their own link) is seated whole", async () => {
    const w = await world("pair", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const mate = await account(w, "plays", false);
    const res = await submit(w, "pair", captain, 1, { dob: null });
    const regId = res.entries[0]!.registration_id;
    const [slot] = await sql<{ id: string; full_name: string }[]>`
      select id, full_name from registration_players where registration_id = ${regId} and consent_status = 'pending'`;
    await joinTeamEntry(
      { sessionUserId: mate.userId },
      { join_code: res.entries[0]!.join_code!, player_id: slot!.id, player: { full_name: slot!.full_name, dob: ADULT }, privacy_consent: true },
    );

    await approveRegistration(w.auth, regId);

    expect(await seatedAfterSubmit(regId)).toEqual({ status: "confirmed", people: 2 });
    count("approve-submitter");
  });

  it("a pair whose teammate claimed WITHOUT a date of birth and has since lost their link is refused: the captain's link is not theirs", async () => {
    const w = await world("pair", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const mate = await account(w, "plays", false);
    const res = await submit(w, "pair", captain, 1, { dob: null });
    const regId = res.entries[0]!.registration_id;
    const [slot] = await sql<{ id: string; full_name: string }[]>`
      select id, full_name from registration_players where registration_id = ${regId} and consent_status = 'pending'`;
    await joinTeamEntry(
      { sessionUserId: mate.userId },
      { join_code: res.entries[0]!.join_code!, player_id: slot!.id, player: { full_name: slot!.full_name }, privacy_consent: true },
    );
    const rows = await sql<{ user_id: string | null; consent_status: string }[]>`select user_id, consent_status from registration_players where id = ${slot!.id}`;
    expect(rows[0], "premise: the claimed row is granted and, with no date of birth, untied - the captain's own row's shape").toEqual({ user_id: null, consent_status: "granted" });
    await withdrawLink(mate);

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(await seatedAfterSubmit(regId)).toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("a team whose joiner (a new roster row, no date of birth) has since lost their link is refused: the captain's link is not theirs", async () => {
    const w = await world("team", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const joiner = await account(w, "plays", false);
    // The roster is empty at submit: a boardgame team seats ONE player, and the join link's new-row path only opens while there is room.
    const res = await submit(w, "team", captain, 0, { dob: null }, { rosterless: true });
    const regId = res.entries[0]!.registration_id;
    await joinTeamEntry(
      { sessionUserId: joiner.userId },
      { join_code: res.entries[0]!.join_code!, player: { full_name: "Joiner " + joiner.lichessId }, privacy_consent: true },
    );
    const rows = await sql<{ source: string; user_id: string | null }[]>`
      select source, user_id from registration_players where registration_id = ${regId}`;
    expect(rows, "premise: the joiner's is the one row, and it is not tied to an account (no date of birth)").toEqual([{ source: "self_joined", user_id: null }]);
    await withdrawLink(joiner);

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(await seatedAfterSubmit(regId)).toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("a minor registered by a signed-in, linked guardian is refused: the guardian's link is not the child's", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const guardian = await account(w, "plays", false);
    const regId = (await submit(w, "individual", guardian, 0, { dob: "2015-03-01", guardian_name: "Guardian " + guardian.lichessId, guardian_consent: true }))
      .entries[0]!.registration_id;

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    expect(await seatedAfterSubmit(regId)).toEqual({ status: "pending", people: 0 });
    count("approve-submitter");
  });

  it("a guardian named on a submitter with no date of birth is refused too: the row was untied on purpose", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const guardian = await account(w, "plays", false);
    const regId = (await submit(w, "individual", guardian, 0, { dob: null, guardian_name: "Guardian " + guardian.lichessId, guardian_consent: true }))
      .entries[0]!.registration_id;
    const [row] = await sql<{ user_id: string | null; dob: string | null; guardian_name: string | null }[]>`
      select user_id, dob::text as dob, guardian_name from registration_players where registration_id = ${regId}`;
    expect(row, "premise: no date of birth, a guardian on the row, untied").toMatchObject({ user_id: null, dob: null, guardian_name: expect.any(String) });

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    count("approve-submitter");
  });

  it("an adult WITH a date of birth who was untied by a guardian tick is refused too: only a missing date of birth is the gap", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: ADULT, guardian_consent: true })).entries[0]!.registration_id;
    const [row] = await sql<{ user_id: string | null; dob: string | null; guardian_name: string | null }[]>`
      select user_id, dob::text as dob, guardian_name from registration_players where registration_id = ${regId}`;
    expect(row, "premise: a date of birth, no guardian name, and still untied (the guardian tick)").toEqual({ user_id: null, dob: ADULT, guardian_name: null });

    const got = await refusalOf(approveRegistration(w.auth, regId));

    expect(got).toMatchObject({ status: 422, code: "LICHESS_LINK_REQUIRED" });
    count("approve-submitter");
  });

  it("a person is matched to an account only through the entries the gate was opened for, not through a row of some other entry", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const inScope = await account(w, "plays", false);
    const other = await account(w, "plays", false);
    const regId = (await submit(w, "individual", inScope, 0, { dob: null })).entries[0]!.registration_id;
    await withdrawLink(inScope);
    // The in-scope entry also names `other`'s account (a tied teammate row), so the gate reads `other`'s link - which plays.
    await sql`
      insert into registration_players (registration_id, full_name, user_id, source, consent_status)
      values (${regId}, 'Tied teammate', ${other.userId}, 'captain_entered', 'granted')`;
    // A person who is stamped only on the submitter-shaped row of ANOTHER entry, whose cart is `other`'s.
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${w.auth.orgId}, 'Elsewhere') returning id`;
    const { registration: elsewhere } = await seedRegistration(
      w.competitionId,
      w.divisionId,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" },
      { status: "pending", displayName: "Elsewhere " + randomUUID().slice(0, 6) },
    );
    await sql`update registration_groups set user_id = ${other.userId} where id = ${elsewhere.group_id}`;
    await sql`
      insert into registration_players (registration_id, full_name, person_id, source, consent_status, consent_at)
      values (${elsewhere.id}, 'Elsewhere', ${person!.id}, 'captain_entered', 'granted', now())`;
    const gate = await openRegistrationSeatGate({ divisionId: w.divisionId, registrationId: regId, auth: w.auth });

    const got = await refusalOf(
      sql.begin(async (tx) => {
        await gate.load(tx);
        await gate.assertRoster(tx, w.divisionId, [person!.id]);
      }),
    );

    expect(got.code, "the other entry's cart is not the gate's to lend: nothing in the entries it was opened for names this person").toBe("LICHESS_LINK_REQUIRED");
    count("approve-submitter");
  });

  it("a division that is not online asks nothing of the submitter", async () => {
    const w = await world("individual", false, { approval: "manual" });
    const submitter = await account(w, "none", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;

    await approveRegistration(w.auth, regId);

    expect(await seatedAfterSubmit(regId)).toEqual({ status: "confirmed", people: 1 });
    count("approve-submitter");
  });
});

// ---------------------------------------------------------------------------
// approve: the tie stops at the submitter's own row
// ---------------------------------------------------------------------------
//
// The seat ties the person it makes for the submitter's own row to the cart's account, on an online division, so the board (which reads a
// link by the PERSON's account) agrees with the gate. Nobody else is tied by it. Seen with the club's flag off, where the gate asks nothing
// and so lets every one of these rows through: the only thing left to see is who the seat tied.

describe.skipIf(!HAS_DB)("approve: the seat ties the submitter's own person to their account, and no one else's", () => {
  it("a pair: the captain is tied; the teammate the captain typed in is not", async () => {
    const w = await world("pair", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const regId = (await submit(w, "pair", captain, 1, { dob: null })).entries[0]!.registration_id;
    loseTheFlag();

    await approveRegistration(w.auth, regId);

    const people = await seatedPeople(regId);
    expect(people.map((p) => p.user_id).sort(), "premise: both seated, one tied").toEqual([captain.userId, null].sort());
    expect(people.find((p) => p.full_name.startsWith("Submitter"))!.user_id, "the tied one is the captain's own").toBe(captain.userId);
    count("approve-tie");
  });

  it("a pair whose teammate claimed their spot WITHOUT a date of birth: the claimed teammate is not tied to the captain's account", async () => {
    const w = await world("pair", true, { approval: "manual" });
    const captain = await account(w, "plays", false);
    const mate = await account(w, "plays", false);
    const res = await submit(w, "pair", captain, 1, { dob: null });
    const regId = res.entries[0]!.registration_id;
    const [slot] = await sql<{ id: string; full_name: string }[]>`
      select id, full_name from registration_players where registration_id = ${regId} and consent_status = 'pending'`;
    await joinTeamEntry(
      { sessionUserId: mate.userId },
      { join_code: res.entries[0]!.join_code!, player_id: slot!.id, player: { full_name: slot!.full_name }, privacy_consent: true },
    );
    loseTheFlag();

    await approveRegistration(w.auth, regId);

    const people = await seatedPeople(regId);
    expect(people.find((p) => p.full_name === slot!.full_name)!.user_id, "the claimed teammate's person is untied: not the captain's account").toBeNull();
    expect(people.find((p) => p.full_name.startsWith("Submitter"))!.user_id).toBe(captain.userId);
    count("approve-tie");
  });

  it("a minor registered by a signed-in guardian is not tied to the guardian's account", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const guardian = await account(w, "plays", false);
    const regId = (await submit(w, "individual", guardian, 0, { dob: "2015-03-01", guardian_name: "Guardian " + guardian.lichessId, guardian_consent: true }))
      .entries[0]!.registration_id;
    loseTheFlag();

    await approveRegistration(w.auth, regId);

    expect((await seatedPeople(regId)).map((p) => p.user_id)).toEqual([null]);
    count("approve-tie");
  });

  it("an entry with a guardian named and no date of birth is not tied either", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const guardian = await account(w, "plays", false);
    const regId = (await submit(w, "individual", guardian, 0, { dob: null, guardian_name: "Guardian " + guardian.lichessId, guardian_consent: true }))
      .entries[0]!.registration_id;
    loseTheFlag();

    await approveRegistration(w.auth, regId);

    expect((await seatedPeople(regId)).map((p) => p.user_id)).toEqual([null]);
    count("approve-tie");
  });

  it("a division that is not played online keeps the old behaviour: the submitter's person is not tied", async () => {
    const w = await world("individual", false, { approval: "manual" });
    const submitter = await account(w, "none", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;

    await approveRegistration(w.auth, regId);

    expect((await seatedPeople(regId)).map((p) => p.user_id)).toEqual([null]);
    count("approve-tie");
  });

  it("an account that already holds a person in the club is seated AS that person: one person per account, no duplicate, no unique-index error", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", true);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;

    await approveRegistration(w.auth, regId);

    const people = await seatedPeople(regId);
    expect(people.map((p) => p.id), "seated as the person the account already held").toEqual([submitter.personId]);
    const holders = await sql`select 1 from persons where org_id = ${w.auth.orgId} and user_id = ${submitter.userId} and lane = 'player' and merged_into is null`;
    expect(holders, "and no second person holds the account").toHaveLength(1);
    count("approve-tie");
  });

  it("a row that names its OWN account keeps it: the cart's account does not override it", async () => {
    const w = await world("individual", true, { approval: "manual" });
    const submitter = await account(w, "plays", false);
    const named = await account(w, "plays", false);
    const regId = (await submit(w, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;
    // The row now names an account of its own (as a claim would leave it) while it still has the submitter's shape.
    await sql`update registration_players set user_id = ${named.userId} where registration_id = ${regId}`;

    await approveRegistration(w.auth, regId);

    expect((await seatedPeople(regId)).map((p) => p.user_id), "seated on the account the row names").toEqual([named.userId]);
    count("approve-tie");
  });

  it("the SEQUENCE: the same account's second entry, in the same club, is seated as the same person", async () => {
    const w1 = await world("individual", true, { approval: "manual" });
    const submitter = await account(w1, "plays", false);
    const first = (await submit(w1, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;
    await approveRegistration(w1.auth, first);
    const [{ id: firstPerson }] = await seatedPeople(first);
    // A second division in the SAME competition of the same club.
    const second = await createDivision(w1.auth, w1.competitionId, {
      name: "Second online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
    });
    await putRegistrationSettings(w1.auth, second.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [], opens_at: null, closes_at: null, capacity: null,
      refund_lock_at: null, approval: "manual", allow_free_agents: false,
    });
    const w2: World = { ...w1, divisionId: second.id };
    const secondReg = (await submit(w2, "individual", submitter, 0, { dob: null })).entries[0]!.registration_id;

    await approveRegistration(w2.auth, secondReg);

    expect((await seatedPeople(secondReg)).map((p) => p.id), "the same person, not a second one").toEqual([firstPerson]);
    count("approve-tie");
  });
});

describe.skipIf(!HAS_DB)("the writers file ran what it owes", () => {
  it("anti-vacuity: every writer ran every scenario", () => {
    expect([...ran.writers].sort()).toEqual(["approve-submitter", "approve-tie", "assign", "submit"]);
    // assign: 12 scenarios above; submit: 5 per kind x 2 kinds + 2 (a captain with no date of birth, per kind) + 3;
    // approve-submitter: 2 (individual, team) + 3 (link withdrawn, identity-only, sequence) + 3 (pair: typed-in mate, claimed with a date of
    // birth, claimed without) + 1 (joiner) + 3 (minor, guardian on no-dob, guardian tick on adult) + 1 (a person matched through another entry's row) + 1 (not online).
    // approve-tie: 8 (the captain, a claimed teammate, a minor, a guardian on no date of birth, a division not online, an account that already holds a person, a row naming its own account, the second entry).
    expect(ran.scenarios).toBe(12 + (5 * 2 + 2 + 3) + (2 + 3 + 3 + 1 + 3 + 1 + 1) + 8);
  });
});
