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
//      beforehand can hold it; its link is read by the registrant's USER (the account on `registration_players.user_id`)
//      and matched to the person once the transaction has made it.
//   4. The test itself, `assertRoster`: refuses when the division plays online (`divisionPlaysOnline`, read in the
//      caller's transaction) and one of the people is not in the map as playing.
//
// One gate serves ONE call: it carries the states its prelude read.
import type postgres from "postgres";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { onlineChessOffered, type OnlineChessAsker } from "./external-play/online-chess-flag";
import {
  assertPersonIdsLinkedForOnlinePlay,
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
   *  as the transaction sees it. Nothing to refuse for an empty roster, and a no-op for a club not offered online chess. */
  assertRoster(tx: Tx, divisionId: string, personIds: readonly string[]): Promise<void>;
}

interface Scope {
  /** Is the scope online right now, as `db` reads it? Run on the pool before the transaction, and again on the transaction's own connection. */
  probe(db: Db): Promise<boolean>;
  /** Reads the link states (privileged) and says how to look a person up in them. */
  read(db: Tx): Promise<StatesFor>;
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
      // No states read (the division turned online after the prelude looked) is no answer: it refuses, like an unasked flag does.
      assertPersonIdsLinkedForOnlinePlay(statesFor ? await statesFor(tx, personIds) : null, personIds);
    },
  };
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

/** A REGISTRATION door (`materialise`: approve, confirm, waive, mark-paid, a promotion that seats). Keyed by the registrant's
 *  account, because their person row may not exist until `materialise` makes it (see the header). `registrationId` scopes the
 *  read to that one entry's players; omit it for a promotion that picks its own candidate, and the division's waitlist is read.
 *  `auth` is who asked for the flag (an automatic promotion has no one: it is asked as the club, like the submit is). */
export async function openRegistrationSeatGate(scope: {
  divisionId: string;
  registrationId?: string;
  auth?: Pick<AuthCtx, "orgId" | "userId">;
}): Promise<SeatGate> {
  const [division] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${scope.divisionId}`;
  // A division that is not there is not online: no flag is asked, nothing is read, and the door's own lookup answers 404.
  const orgId = scope.auth?.orgId ?? division?.org_id ?? "";
  return openGate(scope.auth ?? { orgId, userId: null }, {
    probe: divisionOnline(scope.divisionId),
    read: async (db) => {
      const players = await db<{ user_id: string }[]>`
        select distinct rp.user_id
          from registration_players rp
          join registrations r on r.id = rp.registration_id
         where r.org_id = ${orgId} and r.division_id = ${scope.divisionId}
           and ${scope.registrationId === undefined ? db`r.status = 'waitlisted'` : db`r.id = ${scope.registrationId}`}
           and rp.user_id is not null`;
      const byUser = await lichessLinkStatesByUser(
        db,
        players.map((p) => p.user_id),
      );
      return async (tx, personIds) => {
        const people = await tx<{ id: string; user_id: string | null }[]>`
          select id, user_id from persons where id = any(${[...personIds]})`;
        return new Map(
          people.flatMap((p): [string, LichessLinkState][] => {
            const state = p.user_id === null ? undefined : byUser.get(p.user_id);
            return state === undefined ? [] : [[p.id, state]];
          }),
        );
      };
    },
  });
}
