// Every door that seats a player in an ONLINE-play (Lichess) division asks the same question the board will: does this
// person hold a Lichess link that PLAYS (`lichessGrantPlays`)? Owner ruling 2026-10-25 put the answer on `createEntrants`
// and on self-registration; this file holds the REST of the doors to it, each driven through its REAL usecase against the
// real database (no door's gate is exercised through a stand-in):
//
//   patch            patchEntrant            roster replace
//   sync             syncEntrantRosterFromSquad
//   approve          approveRegistration     the organiser's approve (manual-approval division)
//   confirm          confirmRegistration     the organiser's confirm (waitlist override, free entry)
//   waive            confirmRegistrationWaived
//   mark-paid        markRegistrationPaidOffline
//   promote          promoteFromWaitlist     the organiser's explicit promote (a free, auto-approval division seats at once)
//   import           commitImport            the CSV import
//
// (the controller's "approval" and "waitlist promote" are `materialise`'s one seat write, reached by those six doors; the
// AUTOMATIC promotions - a withdrawal, the sweeps - are `online-seat-gate-waitlist.test.ts`; the two writers a team or pair division
// adds - assigning a solo sign-up to a team, and the submit's inline confirm of a whole roster - are `online-seat-gate-writers.test.ts`.
// Not asked, on purpose: the card webhook (the registrant has paid) and the join link (the joiner's own session link is asked first).)
//
// Each door gets the same sweep: a link that plays seats; an identity-only link is refused as RECONNECT; no link is refused as
// LINK, both naming the person and leaving the roster exactly as it was; an empty roster and a division that is not online
// are unaffected; a club not offered online chess is never asked for a link; and the SEQUENCE - refused, the player
// reconnects, the same call succeeds. The registration doors add the case the person-keyed read cannot see: a registrant
// whose Seazn person row does not exist yet (materialise creates it in the very transaction) and who plays must be seated.
//
// Expected answers are the two codes the registered gate declares (`entrants-lichess-refusal.ts` maps exactly these),
// the play bar is `lichessGrantPlays` seen through the seeds, and every sweep reports how many doors it ran.
//
// Boardgame only: the one sport that plays online (`supportsOnlinePlay`).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createEntrants, patchEntrant, syncEntrantRosterFromSquad } from "../entrants";
import { commitImport, createImport } from "../imports";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { approveRegistration, promoteFromWaitlist } from "../registration-approval";
import { confirmRegistration, confirmRegistrationWaived, markRegistrationPaidOffline } from "../registrations";
import { seedRegistration } from "./_registration-fixtures";
import { linkWithoutPlayConsent, reconnectLichess, seedOwner, seedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Targets: the player a door is asked to seat
// ---------------------------------------------------------------------------

type LinkKind = "plays" | "identity-only" | "none";
interface Target {
  kind: LinkKind;
  userId: string;
  lichessId: string;
  name: string;
  /** null: the user has an account (and link) but no person row in this org yet. */
  personId: string | null;
}

async function makeTarget(auth: AuthCtx, kind: LinkKind, withPerson: boolean): Promise<Target> {
  const name = `${kind === "plays" ? "Plays" : kind === "none" ? "Unlinked" : "Idonly"} ${randomUUID().slice(0, 8)}`;
  const lichessId = `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (withPerson) {
    const p = await seedPlayer(auth.orgId, name, lichessId, kind === "plays");
    if (kind === "identity-only") await linkWithoutPlayConsent(p, "identity-only");
    return { kind, userId: p.userId, lichessId, name, personId: p.personId };
  }
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${lichessId}-${randomUUID().slice(0, 6)}@t.local`}, ${name}, true, 'en') returning id`;
  if (kind === "plays") await reconnectLichess({ userId, lichessId });
  if (kind === "identity-only") await linkWithoutPlayConsent({ userId, lichessId }, "identity-only");
  return { kind, userId, lichessId, name, personId: null };
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

interface World {
  divisionId: string;
  /** Sets up the door for `target` (null: an empty roster) and returns the call. Re-callable: a refused call leaves nothing behind. */
  prepare(target: Target | null): Promise<() => Promise<unknown>>;
}
interface Door {
  name: string;
  /** The door seats an EXISTING person (a roster, a squad, a CSV match) - a registrant is the one that may not have a person row yet. */
  needsPerson: boolean;
  /** false: no chess division can be reached through this door any more. Chess takes individual players only (owner ruling
   *  2026-10-26, CHESS_INDIVIDUAL_ONLY) and the CSV import creates TEAM entrants, so a chess division refuses the file before
   *  any link is asked. The door still seats on another sport (the stale-setting sweep below). */
  onChess?: false;
  open(auth: AuthCtx, online: boolean): Promise<World>;
}

/** The "stale" describe at the end turns this on: `divisionFor` then builds a division of ANOTHER sport whose stored config still says
 *  `onlinePlay: lichess` (left behind by a sport that has since changed, or written around the API). Only boardgame plays online
 *  (`supportsOnlinePlay`), so such a division is not online and no door may ask its players for a link. */
let staleOnlineSetting = false;

async function divisionFor(auth: AuthCtx, online: boolean): Promise<{ id: string; slug: string; competitionId: string }> {
  const competition = await createCompetition(auth, {
    name: "Seat gate " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
    starts_on: "2026-12-01",
    ends_on: "2026-12-02",
  });
  if (staleOnlineSetting) {
    const other = await createDivision(auth, competition.id, {
      name: "Stale",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${other.id}`;
    return { id: other.id, slug: other.slug, competitionId: competition.id };
  }
  const division = await createDivision(auth, competition.id, {
    name: online ? "Online" : "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(online ? { onlinePlay: "lichess" } : {}), clock: { base: 600, increment: 5 } },
  });
  return { id: division.id, slug: division.slug, competitionId: competition.id };
}

const member = (t: Target) => ({ person_id: t.personId!, is_captain: false, roles: [] });

async function seedSettings(
  divisionId: string,
  over: { entrant_kind?: "individual" | "team"; fee_cents?: number; approval?: "auto" | "manual" } = {},
): Promise<void> {
  await sql`
    insert into registration_settings (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
    values (${divisionId}, true, ${over.entrant_kind ?? "individual"}, ${over.fee_cents ?? 0}, 'offline', ${over.approval ?? "auto"}, false)
    on conflict (division_id) do update set entrant_kind = excluded.entrant_kind, fee_cents = excluded.fee_cents,
      approval = excluded.approval`;
}

/** A registration for `target` (an individual entry; null: a team entry with nobody on it) in the given status. */
async function seedEntry(
  competitionId: string,
  divisionId: string,
  target: Target | null,
  status: "pending" | "waitlisted",
  feeCents: number,
): Promise<string> {
  await sql`update registration_settings set entrant_kind = ${target === null ? "team" : "individual"} where division_id = ${divisionId}`;
  const { registration } = await seedRegistration(
    competitionId,
    divisionId,
    { fee_cents: feeCents, currency: "gbp", payment_method: "offline" },
    { status, displayName: target?.name ?? "Empty team" },
  );
  if (target) {
    await sql`
      insert into registration_players (registration_id, full_name, user_id, source)
      values (${registration.id}, ${target.name}, ${target.userId}, 'captain_entered')`;
  }
  return registration.id;
}

const registrationDoor = (
  name: string,
  cfg: {
    approval: "auto" | "manual";
    fee: number;
    status: "pending" | "waitlisted";
    call: (auth: AuthCtx, regId: string, divisionId: string) => Promise<unknown>;
  },
): Door => ({
  name,
  needsPerson: false,
  async open(auth, online) {
    const division = await divisionFor(auth, online);
    await seedSettings(division.id, { approval: cfg.approval, fee_cents: cfg.fee });
    return {
      divisionId: division.id,
      async prepare(target) {
        const regId = await seedEntry(division.competitionId, division.id, target, cfg.status, cfg.fee);
        return () => cfg.call(auth, regId, division.id);
      },
    };
  },
});

const DOORS: Door[] = [
  {
    name: "patch",
    needsPerson: true,
    async open(auth, online) {
      const division = await divisionFor(auth, online);
      const incumbent = await makeTarget(auth, "plays", true);
      const [entrant] = await createEntrants(auth, division.id, [
        { display_name: "Seat", kind: "individual", members: [member(incumbent)] },
      ]);
      return {
        divisionId: division.id,
        prepare: async (target) => () => patchEntrant(auth, entrant!.id, { members: target ? [member(target)] : [] }),
      };
    },
  },
  {
    name: "sync",
    needsPerson: true,
    async open(auth, online) {
      const division = await divisionFor(auth, online);
      const incumbent = await makeTarget(auth, "plays", true);
      const [{ id: teamId }] = await sql<{ id: string }[]>`
        insert into teams (org_id, name) values (${auth.orgId}, ${"Squad " + randomUUID().slice(0, 8)}) returning id`;
      await sql`insert into team_members (team_id, person_id, org_id) values (${teamId}, ${incumbent.personId}, ${auth.orgId})`;
      const [entrant] = await createEntrants(auth, division.id, [
        { display_name: "Seat", kind: "individual", team_id: teamId, members: [] },
      ]);
      return {
        divisionId: division.id,
        async prepare(target) {
          await sql`delete from team_members where team_id = ${teamId}`;
          if (target) await sql`insert into team_members (team_id, person_id, org_id) values (${teamId}, ${target.personId}, ${auth.orgId})`;
          return () => syncEntrantRosterFromSquad(auth, entrant!.id);
        },
      };
    },
  },
  registrationDoor("approve", { approval: "manual", fee: 0, status: "pending", call: (a, id) => approveRegistration(a, id) }),
  registrationDoor("confirm", { approval: "auto", fee: 0, status: "pending", call: (a, id) => confirmRegistration(a, id) }),
  registrationDoor("waive", { approval: "auto", fee: 0, status: "pending", call: (a, id) => confirmRegistrationWaived(a, id) }),
  registrationDoor("mark-paid", { approval: "auto", fee: 500, status: "pending", call: (a, id) => markRegistrationPaidOffline(a, id) }),
  registrationDoor("promote", {
    approval: "auto",
    fee: 0,
    status: "waitlisted",
    call: (a, id, divisionId) => promoteFromWaitlist(a, divisionId, { registrationId: id }),
  }),
  {
    name: "import",
    needsPerson: true,
    onChess: false,
    async open(auth, online) {
      const division = await divisionFor(auth, online);
      return {
        divisionId: division.id,
        async prepare(target) {
          const team = "T " + randomUUID().slice(0, 8);
          const csv = ["Team,Player", `${team},${target?.name ?? ""}`].join("\r\n");
          // Pinned: every row lands in the division under test, whatever the file says.
          const pinned = await createImport(auth, {
            filename: "roster.csv",
            contentType: "text/csv",
            buffer: Buffer.from(csv, "utf8"),
            pinDivision: { id: division.id, slug: division.slug },
          });
          expect(pinned.plan.issues.filter((i) => i.severity === "error"), "premise: the file plans without errors").toEqual([]);
          expect(pinned.plan.ops.some((op) => op.kind === "entrant.create"), "premise: the file creates an entrant").toBe(true);
          return () => commitImport(auth, pinned.importId, null);
        },
      };
    },
  },
];

/** The users of every person seated on any entrant of the division, sorted - what "the roster" is, for every door. */
async function rosterUsers(divisionId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string | null }[]>`
    select p.user_id from entrants e
      join entrant_members em on em.entrant_id = e.id
      join persons p on p.id = em.person_id
     where e.division_id = ${divisionId}`;
  return rows.map((r) => r.user_id ?? "(accountless)").sort();
}

const refusalOf = async (promise: Promise<unknown>): Promise<{ status?: number; code?: string; ids?: unknown }> => {
  const e = (await promise.then(
    () => null,
    (err: unknown) => err,
  )) as { status?: number; code?: string; extra?: { person_ids?: unknown } } | null;
  expect(e, "premise: it was refused").not.toBeNull();
  return { status: e!.status, code: e!.code, ids: e!.extra?.person_ids };
};

const DOOR_COUNT = 8;
const ran = { scenarios: 0, doors: new Set<string>() };

const CHESS_DOORS = DOORS.filter((d) => d.onChess !== false);

describe.skipIf(!HAS_DB)("every door that seats a player on an online division holds them to the seat gate's bar", () => {
  for (const door of CHESS_DOORS) {
    describe(door.name, () => {
      it("a link that plays seats the player", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "plays", true);

        await (await world.prepare(target))();

        expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
        ran.scenarios++;
        ran.doors.add(door.name);
      });

      it("an identity-only link is refused as RECONNECT, names the person, and changes nothing", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "identity-only", true);
        const before = await rosterUsers(world.divisionId);

        const got = await refusalOf((await world.prepare(target))());

        expect(got).toEqual({ status: 422, code: "LICHESS_RECONSENT_REQUIRED", ids: [target.personId] });
        expect(await rosterUsers(world.divisionId), "the refused call wrote nothing").toEqual(before);
        ran.scenarios++;
      });

      it("no link is refused as LINK, names the person, and changes nothing", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "none", true);
        const before = await rosterUsers(world.divisionId);

        const got = await refusalOf((await world.prepare(target))());

        expect(got).toEqual({ status: 422, code: "LICHESS_LINK_REQUIRED", ids: [target.personId] });
        expect(await rosterUsers(world.divisionId)).toEqual(before);
        ran.scenarios++;
      });

      it("an empty roster is unaffected", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);

        await (await world.prepare(null))();

        expect(await rosterUsers(world.divisionId)).toEqual([]);
        ran.scenarios++;
      });

      it("a division that is not online asks for no link", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, false);
        const target = await makeTarget(auth, "none", true);

        await (await world.prepare(target))();

        expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
        ran.scenarios++;
      });

      it("refused, the player reconnects, and the same call seats them", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "identity-only", true);
        const go = await world.prepare(target);

        await refusalOf(go());
        expect(await rosterUsers(world.divisionId), "premise: refused, nobody seated").not.toContain(target.userId);
        await reconnectLichess(target);
        await go();

        expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
        ran.scenarios++;
      });

      it.skipIf(door.needsPerson)("a player who plays but has no person row yet (created in the same transaction) is seated", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "plays", false);

        await (await world.prepare(target))();

        expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
        ran.scenarios++;
      });

      it.skipIf(door.needsPerson)("a player with no link and no person row yet is refused as LINK, and no person is left behind", async () => {
        const auth = await seedOwner();
        const world = await door.open(auth, true);
        const target = await makeTarget(auth, "none", false);

        const got = await refusalOf((await world.prepare(target))());

        expect(got.status).toBe(422);
        expect(got.code).toBe("LICHESS_LINK_REQUIRED");
        const left = await sql`select 1 from persons where org_id = ${auth.orgId} and user_id = ${target.userId}`;
        expect(left, "the refused call created no person").toHaveLength(0);
        expect(got.ids, "and so names nobody: the person it would have named does not exist").toEqual([]);
        ran.scenarios++;
      });

      describe("a club that is not offered online chess", () => {
        afterEach(() => {
          vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
          forgetOnlineChessFlagCache();
          flags.isServerFeatureEnabled.mockReset();
        });

        it("is never asked for a link", async () => {
          const auth = await seedOwner();
          // Built with the flag on (turning online play on is itself gated by it), then the club loses the flag.
          const world = await door.open(auth, true);
          const target = await makeTarget(auth, "none", true);
          const go = await world.prepare(target);
          vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
          forgetOnlineChessFlagCache();
          flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);

          await go();

          expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
          expect(flags.isServerFeatureEnabled, "the flag was asked, and said no").toHaveBeenCalledWith("online-chess", expect.any(String), {
            orgId: auth.orgId,
            fallback: false,
          });
          ran.scenarios++;
        });
      });
    });
  }

  it("anti-vacuity: every door ran every scenario it owes", () => {
    expect(DOORS.map((d) => d.name).sort()).toEqual(["approve", "confirm", "import", "mark-paid", "patch", "promote", "sync", "waive"]);
    expect(DOORS).toHaveLength(DOOR_COUNT);
    expect(CHESS_DOORS.map((d) => d.name).sort(), "the import is the one door a chess division can no longer be reached through").toEqual(
      DOORS.map((d) => d.name).filter((n) => n !== "import").sort(),
    );
    expect([...ran.doors].sort()).toEqual(CHESS_DOORS.map((d) => d.name).sort());
    // 7 scenarios for every door that needs a person, 9 for the registration doors (plus the two no-person-row ones), 1 more each for the flag-off case.
    const personal = CHESS_DOORS.filter((d) => d.needsPerson).length;
    const registrations = CHESS_DOORS.length - personal;
    expect(ran.scenarios).toBe(personal * 7 + registrations * 9);
  });
});

// A division of another sport that still carries `onlinePlay: lichess` is NOT online (`divisionPlaysOnline` answers by sport as well as by
// setting): every door seats an unlinked player there, and none asks the flag. The NEGATIVE pair of the sweep above - without it a gate that
// read the stored setting alone would pass every positive test in this file.
describe.skipIf(!HAS_DB)("a division of another sport with a stale onlinePlay setting is not online: every door seats ungated", () => {
  const staleRan = new Set<string>();
  beforeAll(() => {
    staleOnlineSetting = true;
  });
  afterAll(() => {
    staleOnlineSetting = false;
  });

  for (const door of DOORS) {
    it(door.name, async () => {
      const auth = await seedOwner();
      const world = await door.open(auth, true);
      const [division] = await sql<{ sport_key: string; config: { onlinePlay?: string } }[]>`
        select sport_key, config from divisions where id = ${world.divisionId}`;
      expect(division!.config.onlinePlay, "premise: the stored setting still says online").toBe("lichess");
      expect(division!.sport_key, "premise: and the sport is not one that plays online").not.toBe("boardgame");
      const target = await makeTarget(auth, "none", true);

      await (await world.prepare(target))();

      expect(await rosterUsers(world.divisionId)).toEqual([target.userId]);
      staleRan.add(door.name);
    });
  }

  it("anti-vacuity: every door ran", () => {
    expect([...staleRan].sort()).toEqual(DOORS.map((d) => d.name).sort());
    expect(staleRan.size).toBe(DOOR_COUNT);
  });
});

// The import is the one door whose callers read a FILE, so its refusal answers in file rows. It used to ask the seat gate's question
// (a link that plays) of every player the file seats on an online division; since the owner ruling of 2026-10-26 chess divisions take
// individual players only and the CSV import creates TEAM entrants, so the file is refused for that, on every line, before any link is
// asked (and whatever the players' links are). The gate's own questions stay covered through the other seven doors above.
describe.skipIf(!HAS_DB)("the CSV import into an online chess division is refused as a team import, naming the file rows", () => {
  const refusalPayload = async (promise: Promise<unknown>): Promise<{ code?: string; person_ids?: unknown; rows?: unknown }> => {
    const e = (await promise.then(
      () => null,
      (err: unknown) => err,
    )) as { code?: string; extra?: { person_ids?: unknown; rows?: unknown } } | null;
    expect(e, "premise: the import was refused").not.toBeNull();
    return { code: e!.code, person_ids: e!.extra?.person_ids, rows: e!.extra?.rows };
  };

  it("rows are every line of the file; no link is asked; nothing is written; linking the players changes nothing", async () => {
    const auth = await seedOwner();
    const division = await divisionFor(auth, true);
    const unlinked = await makeTarget(auth, "none", true);
    const plays = await makeTarget(auth, "plays", true);
    const created = `Brand New ${randomUUID().slice(0, 8)}`; // no person row: the file itself would create them
    const tag = randomUUID().slice(0, 6);
    // Line 1 is the header (import-parse.ts: "header is line 1"), so the players are on lines 2, 3 and 4.
    const csv = ["Team,Player", `A ${tag},${unlinked.name}`, `B ${tag},${created}`, `C ${tag},${plays.name}`].join("\r\n");
    const pinned = await createImport(auth, {
      filename: "roster.csv",
      contentType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
      pinDivision: { id: division.id, slug: division.slug },
    });
    expect(
      pinned.plan.issues.filter((i) => i.severity === "error").map((i) => i.code),
      "the plan already says so, on each of the three lines (the wizard shows it before commit)",
    ).toEqual(["CHESS_INDIVIDUAL_ONLY", "CHESS_INDIVIDUAL_ONLY", "CHESS_INDIVIDUAL_ONLY"]);

    const first = await refusalPayload(commitImport(auth, pinned.importId, null));
    expect(first.code).toBe("CHESS_INDIVIDUAL_ONLY");
    expect(first.person_ids, "no player is named: no link was asked").toBeUndefined();
    expect(first.rows, "every line of the file").toEqual([2, 3, 4]);
    expect(await rosterUsers(division.id), "nothing was written").toEqual([]);
    expect(
      await sql`select 1 from persons where org_id = ${auth.orgId} and full_name = ${created}`,
      "the refused file created nobody",
    ).toHaveLength(0);

    // The SEQUENCE: the unlinked player links; the same file is refused the same way - the link was never the reason.
    await reconnectLichess({ userId: unlinked.userId, lichessId: unlinked.lichessId });
    const second = await refusalPayload(commitImport(auth, pinned.importId, null));
    expect(second.code).toBe("CHESS_INDIVIDUAL_ONLY");
    expect(second.rows).toEqual([2, 3, 4]);
  });
});
