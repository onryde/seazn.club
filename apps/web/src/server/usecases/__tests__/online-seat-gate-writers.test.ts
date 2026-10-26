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
import { assignSoloSignUp } from "../registration-assign";
import { submitRegistrationGroup, type SubmitGroupEntryInput } from "../registration-submit";
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
  // The REAL producer of the shape under test: a team (or pair) division. Solo sign-ups only exist on a team division.
  const saved = await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: kind,
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    approval: over.approval ?? "auto",
    allow_free_agents: kind === "team",
  });
  expect(saved.entrant_kind, "premise: the division saved as a " + kind + " division").toBe(kind);
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
  contact: { dob?: string | null } = { dob: ADULT },
): Promise<ReturnType<typeof submitRegistrationGroup>> {
  const entry: SubmitGroupEntryInput = {
    division_id: w.divisionId,
    entrant_kind: kind,
    team_name: kind === "team" ? "Seat Club " + randomUUID().slice(0, 6) : null,
    players: [
      { full_name: "Submitter " + submitter.lichessId, is_captain: true },
      ...Array.from({ length: mates }, (_, i) => ({ full_name: `Teammate ${i + 1} ${randomUUID().slice(0, 6)}` })),
    ],
    registering_self: true,
    self_player_index: 0,
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

describe.skipIf(!HAS_DB)("the writers file ran what it owes", () => {
  it("anti-vacuity: every writer ran every scenario", () => {
    expect([...ran.writers].sort()).toEqual(["assign", "submit"]);
    // assign: 10 scenarios above; submit: 5 per kind x 2 kinds + 2 (a captain with no date of birth, per kind) + 3.
    expect(ran.scenarios).toBe(10 + (5 * 2 + 2 + 3));
  });
});
