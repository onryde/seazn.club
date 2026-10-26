import "server-only";
// The SEAT GATE for every door that puts a person on an ONLINE-play (Lichess) division's roster: the one question the
// board will ask later - does this person hold a Lichess link that PLAYS (`lichessGrantPlays`)? - asked at the moment
// they are seated, so the organiser is told to have the player reconnect now and not when the board turns them away.
//
// The verdict is not restated here. It is `assertPersonIdsLinkedForOnlinePlay` fed by the link readers in
// external-accounts.ts (`lichessLinkStatesByPerson` / `lichessLinkStatesByUser`, one predicate between them): the same two
// codes (`LICHESS_LINK_REQUIRED`, `LICHESS_RECONSENT_REQUIRED`), the same `extra.person_ids`, that `createEntrants` and the
// registration submit already refuse with. What this module owns is the PLUMBING every door repeated or would have:
//
//   1. WHETHER to ask at all. Only while the club is offered online chess (the PostHog flag `online-chess`: a remote call,
//      so asked here, before any transaction, and only when the scope is online as the pooled connection sees it) - a
//      club without the flag is never asked to link an account for a feature it cannot see. Not asked (`null`) is not the
//      same as said no (`false`): a division that turned online between this read and the transaction is held to the bar.
//   2. WHERE the links can be read. `user_external_accounts` is sealed from `app_user` (V451), so the link states are read
//      BEFORE the role drops (`withTenant`'s `privilegedPrelude`, `gate.tenant`) or, on a superuser transaction, by
//      `gate.load(tx)` - never through the pooled `sql` from inside a held transaction (a second connection: the pool
//      deadlock lib/db.ts documents).
//   3. WHO is asked about, per scope. A roster door names its people up front (person-keyed). A REGISTRATION door cannot:
//      the registrant's person row is created by `materialise` in the very transaction that seats them, so no map read
//      beforehand can hold it; its link is read by the registrant's USER (the account on `registration_players.user_id`;
//      for the SUBMITTER's own row, which carries none when they gave no date of birth, the account the cart was submitted
//      by - `submitterAccount`) and matched to the person once the transaction has made it.
//   4. The test itself, `assertRoster`: refuses when the division plays online (`divisionPlaysOnline`, read in the
//      caller's transaction) and one of the people is not in the map as playing.
//
// One gate serves ONE call: it carries the states its prelude read.
//
// THE DOORS that ask it (each driven through its real usecase in __tests__/online-seat-gate-*.test.ts):
//   a roster         patchEntrant, syncEntrantRosterFromSquad
//   a file           commitImport
//   a registrant     approveRegistration, confirmRegistration, confirmRegistrationWaived, markRegistrationPaidOffline, an explicit
//                    promoteFromWaitlist (all through `materialise`), and an AUTOMATIC promotion - a withdrawal, a sweep - which SKIPS the
//                    registrant it refuses (and writes `registration.promotion_skipped`) rather than failing the act that freed the spot
//   a placement      assignSoloSignUp (a solo sign-up put on a team whose entrant already exists)
//   the submit       the inline confirm of a free, auto-approval entry: everyone it seats but the submitter
// Two seat writers do NOT, on purpose, and a new one must say which side of this line it is on: the card webhook (the registrant has
// PAID - a 422 cannot take a payment back; the seat was asked about at submit and is asked again at the organiser's own doors), and the
// join link (`joinTeamEntry` asks the joiner's own session link before it writes, as the submit asks the submitter's).
import type postgres from "postgres";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { onlineChessOffered, type OnlineChessAsker } from "./external-play/online-chess-flag";
import {
  assertPersonIdsLinkedForOnlinePlay,
  isLichessRosterRefusal,
  lichessLinkStatesByPerson,
  lichessLinkStatesByUser,
  type LichessLinkState,
} from "./external-accounts";

type Db = Tx | postgres.Sql;
type States = ReadonlyMap<string, LichessLinkState>;
/** Looks the people up in what the prelude read: `null` when nothing was read (the scope was not online as the prelude saw it). */
type StatesFor = (tx: Tx, personIds: readonly string[]) => Promise<States | null>;

export interface SeatGate {
  /** `withTenant`'s options for a door on a tenant transaction: the prelude that reads the links before the role drops. Empty when the club was
   *  asked and the flag said no (nothing to read, nothing to refuse). */
  readonly tenant: { privilegedPrelude?: (tx: Tx) => Promise<void> };
  /** The same read, for a door on a superuser transaction (`sql.begin`): call it first thing inside. */
  load(tx: Tx): Promise<void>;
  /** Refuses (422, with the people named) when `divisionId` plays online and any of `personIds` has no link that plays. Reads the division in `tx`,
   *  as the transaction sees it. Nothing to refuse for an empty roster, and a no-op for a club not offered online chess.
   *
   *  On a REGISTRATION gate the people named are the ones who EXIST once the refusal has rolled the transaction back: a person `materialise`
   *  minted a moment ago for this very seat is gone with it, and an id that points at nothing is not a name the organiser can find. */
  assertRoster(tx: Tx, divisionId: string, personIds: readonly string[]): Promise<void>;
}

/** The gate of a door that seats REGISTRANTS: it can also say, from what its prelude read and without trying the seat, whether an entry
 *  would be refused - what an automatic waitlist promotion asks to skip a registrant cheaply (see `promoteOldestWaitlisted`). */
export interface RegistrationSeatGate extends SeatGate {
  /** The refusal the seat of this entry would meet - the SAME verdict `assertRoster` gives, from the same function, over the entry's own
   *  players keyed by their account - or null when it would be seated (or when nothing was read: the flag said no, or the division is not
   *  online as the prelude saw it). A pre-filter, not the gate: `assertRoster` still judges the seat itself. */
  registrantRefusal(tx: Tx, registrationId: string): Promise<HttpError | null>;
}

interface Scope {
  /** Is the scope online right now, as `db` reads it? Run on the pool before the transaction, and again on the transaction's own connection. */
  probe(db: Db): Promise<boolean>;
  /** Reads the link states (privileged) and says how to look a person up in them. */
  read(db: Tx): Promise<StatesFor>;
  /** The seat being judged MAKES the person rows it judges (a registrant's, in the same transaction), so a refusal - which rolls them back -
   *  must not name them. Left off by the scopes whose people already exist, or are named by the caller's own keys (the import's placeholders). */
  mintsPersons?: boolean;
}

async function openGate(asker: OnlineChessAsker, scope: Scope): Promise<SeatGate> {
  const online = await scope.probe(sql);
  // Asked only for a scope that is online: PostHog is not consulted for an over-the-board division. `null` = not asked.
  const offered = online ? await onlineChessOffered(asker) : null;
  let statesFor: StatesFor | null = null;
  const load = async (tx: Tx): Promise<void> => {
    if (offered === false) return;
    statesFor = (await scope.probe(tx)) ? await scope.read(tx) : null;
  };
  return {
    tenant: offered === false ? {} : { privilegedPrelude: load },
    load,
    async assertRoster(tx, divisionId, personIds) {
      if (offered === false) return;
      const [division] = await tx<{ sport_key: string; config: unknown }[]>`
        select sport_key, config from divisions where id = ${divisionId}`;
      if (!division) throw new HttpError(404, "division not found");
      if (!divisionPlaysOnline(division)) return;
      try {
        // No states read (the division turned online after the prelude looked) is no answer: it refuses, like an unasked flag does.
        assertPersonIdsLinkedForOnlinePlay(statesFor ? await statesFor(tx, personIds) : null, personIds);
      } catch (err) {
        throw scope.mintsPersons && isLichessRosterRefusal(err) ? await refusalNamingSurvivors(tx, err) : err;
      }
    },
  };
}

/** `refusal` with `extra.person_ids` cut down to the people that were here BEFORE this transaction began: the ones the refusal's rollback
 *  leaves behind. A person is minted by the seat that is being refused (a registrant's row is made by `materialise`, in the same
 *  transaction), and `created_at` is the transaction's own `now()` for exactly those. */
async function refusalNamingSurvivors(tx: Tx, refusal: HttpError): Promise<HttpError> {
  const named = Array.isArray(refusal.extra?.person_ids) ? (refusal.extra.person_ids as string[]) : [];
  const survivors = new Set(
    named.length === 0
      ? []
      : (await tx<{ id: string }[]>`select id from persons where id = any(${named}) and created_at < now()`).map((p) => p.id),
  );
  return new HttpError(refusal.status, refusal.message, refusal.code, {
    ...refusal.extra,
    person_ids: named.filter((id) => survivors.has(id)),
  });
}

const divisionOnline = (divisionId: string) => async (db: Db): Promise<boolean> => {
  const [d] = await db<{ sport_key: string; config: unknown }[]>`select sport_key, config from divisions where id = ${divisionId}`;
  return d !== undefined && divisionPlaysOnline(d);
};

const personKeyed = (orgId: string, personIds: readonly string[] | undefined) => async (db: Tx): Promise<StatesFor> => {
  const states = await lichessLinkStatesByPerson(db, orgId, personIds);
  return async () => states;
};

/** A roster door on ONE division (`patchEntrant`, `syncEntrantRosterFromSquad`): people-keyed. `personIds` are the people the
 *  call names up front; omit them when the roster is only resolved inside the transaction (a squad), and the whole org is read. */
export function openRosterSeatGate(
  auth: Pick<AuthCtx, "orgId" | "userId">,
  scope: { divisionId: string; personIds?: readonly string[] },
): Promise<SeatGate> {
  return openGate(auth, { probe: divisionOnline(scope.divisionId), read: personKeyed(auth.orgId, scope.personIds) });
}

/** A door that may seat people on any division of the org, not known until the transaction plans it (the CSV import): the scope
 *  is online when ANY division of the org plays online, and the whole org's links are read. The SQL narrows by the stored
 *  setting; `divisionPlaysOnline` decides. */
export function openOrgSeatGate(auth: Pick<AuthCtx, "orgId" | "userId">): Promise<SeatGate> {
  const anyOnline = async (db: Db): Promise<boolean> => {
    const rows = await db<{ sport_key: string; config: unknown }[]>`
      select sport_key, config from divisions where org_id = ${auth.orgId} and config->>'onlinePlay' = 'lichess'`;
    return rows.some((d) => divisionPlaysOnline(d));
  };
  return openGate(auth, { probe: anyOnline, read: personKeyed(auth.orgId, undefined) });
}

/** A `registration_players` row as the registration gate reads it, with the account that SUBMITTED its cart. */
interface PlayerAccountRow {
  user_id: string | null;
  /** `registration_groups.user_id`: who was signed in when the cart was submitted. Not tied to a date of birth, as `user_id` is. */
  cart_user: string | null;
  no_dob: boolean;
  guardian_name: string | null;
  source: string;
  /** The row was consented in the very transaction that wrote it: `consent_at` is the transaction's own `now()`, as `created_at` is. */
  at_submit: boolean | null;
}

const accountColumns = (db: Db) => db`
  rp.user_id, g.user_id as cart_user, (rp.dob is null) as no_dob, rp.guardian_name, rp.source,
  (rp.consent_at = rp.created_at) as at_submit`;

/** The account to read a registrant's link by when their OWN row names none, or null when there is no such account.
 *
 *  `deriveLinkUserId` ties a self-registered player's row to the signed-in account only for an adult WITH a date of birth, so the
 *  submitter of a division that does not ask for one is untied - yet the submit asked THEIR session's link, and the cart remembers
 *  whose it was. This returns that account for exactly that row and no other:
 *    - `captain_entered`: not a joiner's own row (`self_joined`), not an organiser's placement;
 *    - consented in the submit's own transaction: a teammate the captain typed in has no consent yet, and one who claimed their spot did
 *      so later, in a transaction of their own - neither is the submitter, and the cart's account is not theirs;
 *    - no date of birth and no guardian: a minor, or an entry made on a guardian's behalf, is untied ON PURPOSE (the account is the
 *      guardian's, not the player's), and an adult with a date of birth who is untied was untied for a reason the row does not show. */
function submitterAccount(row: PlayerAccountRow): string | null {
  if (row.cart_user === null) return null;
  if (row.source !== "captain_entered") return null;
  if (row.at_submit !== true) return null;
  if (!row.no_dob) return null;
  if (row.guardian_name !== null) return null;
  return row.cart_user;
}

/** A REGISTRATION door (`materialise`: approve, confirm, waive, mark-paid, a promotion that seats; `assignSoloSignUp`). Keyed by the
 *  registrant's account, because their person row may not exist until `materialise` makes it (see the header). `registrationId`
 *  scopes the read to that one entry's players; omit it for a promotion that picks its own candidate (the division's waitlist is read).
 *  `auth` is who asked for the flag (an automatic promotion has no one: it is asked as the club, like the submit is).
 *
 *  The submit's inline confirm opens one too but never `load`s it: the entry does not exist until the submit's own transaction makes it,
 *  and the people it asks about are the teammates a captain typed in, who have no account to read. An UNREAD gate answers 'no link' for
 *  everyone it is asked about (`assertRoster`), which is the true answer for them. */
export async function openRegistrationSeatGate(scope: {
  divisionId: string;
  registrationId?: string;
  auth?: Pick<AuthCtx, "orgId" | "userId">;
}): Promise<RegistrationSeatGate> {
  const [division] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${scope.divisionId}`;
  // A division that is not there is not online: no flag is asked, nothing is read, and the door's own lookup answers 404.
  const orgId = scope.auth?.orgId ?? division?.org_id ?? "";
  // What the prelude read, by account. Held for `registrantRefusal`; null until a `load` reads it.
  const held: { byUser: ReadonlyMap<string, LichessLinkState> | null } = { byUser: null };
  const gate = await openGate(scope.auth ?? { orgId, userId: null }, {
    mintsPersons: true,
    probe: divisionOnline(scope.divisionId),
    read: async (db) => {
      const entries = await db<{ id: string }[]>`
        select r.id from registrations r
         where r.org_id = ${orgId} and r.division_id = ${scope.divisionId}
           and ${scope.registrationId === undefined ? db`r.status = 'waitlisted'` : db`r.id = ${scope.registrationId}`}`;
      const entryIds = entries.map((e) => e.id);
      // Every account the entries' players, or their carts, name. A cart's account is read for the submitter's own row (`submitterAccount`).
      const accounts = await db<{ user_id: string }[]>`
        select rp.user_id from registration_players rp where rp.registration_id = any(${entryIds}::uuid[]) and rp.user_id is not null
        union
        select g.user_id from registrations r join registration_groups g on g.id = r.group_id
         where r.id = any(${entryIds}::uuid[]) and g.user_id is not null`;
      const read = await lichessLinkStatesByUser(
        db,
        accounts.map((p) => p.user_id),
      );
      held.byUser = read;
      return async (tx, personIds) => {
        // A person is matched to an account by its own `user_id`; one that has none (made by `materialise` for a row that has none) by
        // the row it was made from, which `materialise` stamped on `person_id` before it asked.
        const people = await tx<(PlayerAccountRow & { person_id: string; person_user: string | null })[]>`
          select p.id as person_id, p.user_id as person_user, ${accountColumns(tx)}
            from persons p
            left join registration_players rp on rp.person_id = p.id and rp.registration_id = any(${entryIds}::uuid[])
            left join registrations r on r.id = rp.registration_id
            left join registration_groups g on g.id = r.group_id
           where p.id = any(${[...personIds]})`;
        const accountOf = new Map<string, string>();
        for (const p of people) {
          const account = p.person_user ?? submitterAccount(p);
          if (account !== null && !accountOf.has(p.person_id)) accountOf.set(p.person_id, account);
        }
        return new Map(
          [...accountOf].flatMap(([personId, account]): [string, LichessLinkState][] => {
            const state = read.get(account);
            return state === undefined ? [] : [[personId, state]];
          }),
        );
      };
    },
  });
  return {
    ...gate,
    async registrantRefusal(tx, registrationId) {
      const read = held.byUser;
      if (read === null) return null;
      // The entry's own players, each keyed by the account on its row - the same people `materialise` resolves to persons.
      const players = await tx<(PlayerAccountRow & { id: string })[]>`
        select rp.id, ${accountColumns(tx)}
          from registration_players rp
          join registrations r on r.id = rp.registration_id
          left join registration_groups g on g.id = r.group_id
         where rp.registration_id = ${registrationId}
         order by rp.created_at, rp.id`;
      const states = new Map(
        players.flatMap((p): [string, LichessLinkState][] => {
          const account = p.user_id ?? submitterAccount(p);
          const state = account === null ? undefined : read.get(account);
          return state === undefined ? [] : [[p.id, state]];
        }),
      );
      try {
        assertPersonIdsLinkedForOnlinePlay(
          states,
          players.map((p) => p.id),
        );
        return null;
      } catch (err) {
        if (isLichessRosterRefusal(err)) return err;
        throw err;
      }
    },
  };
}
