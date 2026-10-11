import "server-only";
// ONE guard fronting every online-play entry point (chess Lichess
// external-play redesign, Task 7 — spec §6, §7.2). Replaces the
// pre-redesign `usecases/external-play.ts` (deleted this task; R1).
import { sql } from "@/lib/db";
import { mapBoardgameClockToLichess, type BoardgameClockInput } from "@/server/external-play/clock";
import type { ExternalPlayStatus, LichessClock, NeedsReason } from "@/server/external-play/types";
import { getFixtureState } from "@/server/usecases/fixtures";
import { roundOpenFor } from "@/server/external-play/round-open";
import { mintOrgOwnerAuth } from "./auth";

export type Side = "home" | "away";

export type SidePlayer = {
  side: Side;
  entrantId: string;
  displayName: string;
  personId: string | null;
  userId: string | null;
  lichess: { id: string; username: string } | null;
  recipients: { email: string; locale: string | null }[];
};

/** The revived (Date-typed) shape of a `fixture_external_play` row, as read
 *  through `loadOnlinePlayFixture`. A strict subset of the table's columns —
 *  `fixture_id`/`org_id`/`provider`/`last_polled_at`/`last_error`/
 *  `created_at`/`updated_at` are not modelled here; callers that need them
 *  read the table directly. */
export type BridgeRow = {
  status: ExternalPlayStatus;
  scheduled_at_basis: Date;
  challenge_id: string | null;
  white_side: Side | null;
  white_lichess_id: string | null;
  black_lichess_id: string | null;
  expires_at: Date | null;
  mint_claimed_at: Date | null;
  white_emailed_at: Date | null;
  black_emailed_at: Date | null;
  needs_reason: NeedsReason | null;
  started_at: Date | null;
  finished_at: Date | null;
  /** V436 — T10's move ledger: every move Lichess ACCEPTED, as UCI. */
  moves_uci: string[];
  move_count: number;
  last_move_at: Date | null;
  white_ms: number | null;
  black_ms: number | null;
  clock_increment_s: number | null;
  draw_offer_by: "white" | "black" | null;
  white_draw_offer_ply: number | null;
  black_draw_offer_ply: number | null;
  /** V436 (T11 fix round 1, ruling M7): the seat a `token_revoked` hold
   *  froze; null on any other row, and on a token_revoked hold whose seat
   *  nobody recorded (both frozen). */
  revoked_seat: "white" | "black" | "both" | null;
  /** V436 (T13 fix round 1, ruling I4): the move T10 is submitting — the
   *  ply it was sent at, the canonical UCI, and when — recorded BEFORE the
   *  Board API call, cleared once the ledger holds that ply. All or none. */
  pending_move_ply: number | null;
  pending_move_uci: string | null;
  pending_move_at: Date | null;
};

export type OnlinePlayFixture = {
  fixtureId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  competitionSlug: string;
  divisionSlug: string;
  /** `null` ⇒ the board has no start time (an unscheduled online Swiss round,
   *  controller ruling 2026-10-10). D12 hangs every window on the round's
   *  open, so a board needs no start time to be played; its bridge row's
   *  `scheduled_at_basis` is then the round's `opened_at`. */
  scheduledAt: Date | null;
  homeEntrantId: string;
  awayEntrantId: string;
  fixtureStatus: string;
  clock: LichessClock;
  bridge: BridgeRow | null;
};

/** `to_jsonb(ep)` over the table's columns — jsonb has no Date type, so every
 *  timestamptz column below arrives as an ISO string; `reviveBridge` below
 *  parses the `BridgeRow` subset back into `Date`. The extra columns
 *  (`fixture_id`, `org_id`, `provider`, `last_polled_at`, `last_error`,
 *  `created_at`, `updated_at`) ride along in the jsonb but are not read here. */
type RawBridge = {
  status: ExternalPlayStatus;
  scheduled_at_basis: string;
  challenge_id: string | null;
  white_side: Side | null;
  white_lichess_id: string | null;
  black_lichess_id: string | null;
  expires_at: string | null;
  mint_claimed_at: string | null;
  white_emailed_at: string | null;
  black_emailed_at: string | null;
  needs_reason: NeedsReason | null;
  started_at: string | null;
  finished_at: string | null;
  moves_uci: string[];
  move_count: number;
  last_move_at: string | null;
  white_ms: number | null;
  black_ms: number | null;
  clock_increment_s: number | null;
  draw_offer_by: "white" | "black" | null;
  white_draw_offer_ply: number | null;
  black_draw_offer_ply: number | null;
  revoked_seat: "white" | "black" | "both" | null;
  pending_move_ply: number | null;
  pending_move_uci: string | null;
  pending_move_at: string | null;
};

function reviveBridge(raw: RawBridge): BridgeRow {
  return {
    status: raw.status,
    scheduled_at_basis: new Date(raw.scheduled_at_basis),
    challenge_id: raw.challenge_id,
    white_side: raw.white_side,
    white_lichess_id: raw.white_lichess_id,
    black_lichess_id: raw.black_lichess_id,
    expires_at: raw.expires_at === null ? null : new Date(raw.expires_at),
    mint_claimed_at: raw.mint_claimed_at === null ? null : new Date(raw.mint_claimed_at),
    white_emailed_at: raw.white_emailed_at === null ? null : new Date(raw.white_emailed_at),
    black_emailed_at: raw.black_emailed_at === null ? null : new Date(raw.black_emailed_at),
    needs_reason: raw.needs_reason,
    started_at: raw.started_at === null ? null : new Date(raw.started_at),
    finished_at: raw.finished_at === null ? null : new Date(raw.finished_at),
    // jsonb carries the array and the integers natively; only the timestamp
    // needs reviving.
    moves_uci: raw.moves_uci,
    move_count: raw.move_count,
    last_move_at: raw.last_move_at === null ? null : new Date(raw.last_move_at),
    white_ms: raw.white_ms,
    black_ms: raw.black_ms,
    clock_increment_s: raw.clock_increment_s,
    draw_offer_by: raw.draw_offer_by,
    white_draw_offer_ply: raw.white_draw_offer_ply,
    black_draw_offer_ply: raw.black_draw_offer_ply,
    revoked_seat: raw.revoked_seat,
    pending_move_ply: raw.pending_move_ply,
    pending_move_uci: raw.pending_move_uci,
    pending_move_at: raw.pending_move_at === null ? null : new Date(raw.pending_move_at),
  };
}

type LoadedRow = Omit<OnlinePlayFixture, "clock" | "bridge"> & {
  divisionConfig: unknown;
  bridge: RawBridge | null;
};

/**
 * THE guard. Every online-play entry point (lobby, resolve, resend, cron
 * sync/sweep, webhook, match room) loads through this — spec §6. Returns
 * `null` unless every predicate holds: boardgame sport, `onlinePlay:
 * 'lichess'` in the division config, the division has left setup/scheduled
 * (a fixture is not scoreable before then — `scoreEvent` would refuse it
 * anyway), the fixture has both entrants (a start time is NOT required —
 * D12 anchors the window on the round's open; ruling 2026-10-10), the fixture is not
 * finalized/cancelled, and the division's clock config maps onto a Lichess
 * clock (a legacy Bronstein/delay config is simply not online — Task 11's
 * settings save refuses saving one for an `onlinePlay: 'lichess'` division,
 * so this guard only ever sees it on an already-existing row).
 */
export async function loadOnlinePlayFixture(fixtureId: string): Promise<OnlinePlayFixture | null> {
  const [row] = await sql<LoadedRow[]>`
    select f.id as "fixtureId", o.id as "orgId", o.slug as "orgSlug", o.name as "orgName",
           c.slug as "competitionSlug", d.slug as "divisionSlug", f.scheduled_at as "scheduledAt",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           f.status as "fixtureStatus", d.config as "divisionConfig",
           case when ep.fixture_id is null then null else to_jsonb(ep) end as bridge
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.id = ${fixtureId}
       and d.sport_key = 'boardgame'
       and coalesce(d.config->>'onlinePlay', 'off') = 'lichess'
       and d.status not in ('setup', 'scheduled')
       and f.home_entrant_id is not null
       and f.away_entrant_id is not null
       and f.status not in ('finalized', 'cancelled')`;
  if (!row) return null;
  const cfg = row.divisionConfig as { clock?: BoardgameClockInput } | null;
  const clockMap = mapBoardgameClockToLichess(cfg?.clock);
  if (!clockMap.ok) return null; // settings save refuses this (Task 11); a legacy row is simply not online
  return {
    fixtureId: row.fixtureId,
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    competitionSlug: row.competitionSlug,
    divisionSlug: row.divisionSlug,
    scheduledAt: row.scheduledAt,
    homeEntrantId: row.homeEntrantId,
    awayEntrantId: row.awayEntrantId,
    fixtureStatus: row.fixtureStatus,
    clock: clockMap.clock,
    bridge: row.bridge ? reviveBridge(row.bridge) : null,
  };
}

/** A bridge row minted for an OLDER `scheduled_at` than the fixture's
 *  current one (a reschedule happened after the mint) is stale — but ONLY a
 *  `pending` row with no challenge (fix round 1 ruling, 2026-10-10). A row
 *  that carries a `challenge_id` is NEVER stale, whatever its status: the game
 *  exists at Lichess, and a moved timetable cannot un-create it (D12 anchors
 *  the window on the round's open, not on `scheduled_at`). A
 *  `needs_organiser` row is not stale either — the organiser's void/resolve
 *  (T16) handles a late reschedule, never a silent reset. */
export function isStale(f: OnlinePlayFixture): boolean {
  const b = f.bridge;
  return (
    !!b &&
    b.status === "pending" &&
    b.challenge_id === null &&
    // A board with NO start time is never "rescheduled": its basis is the
    // round's open (ruling 2026-10-10). Only a move to a real time that
    // differs from the basis is a reschedule.
    f.scheduledAt !== null &&
    b.scheduled_at_basis.getTime() !== f.scheduledAt.getTime()
  );
}

/** Pure. The bridge a caller should act on — `null` for both "no bridge yet"
 *  and "the bridge on file is stale". */
export function effectiveBridge(f: OnlinePlayFixture): BridgeRow | null {
  return isStale(f) ? null : f.bridge;
}

/**
 * Writes only when `f`'s OWN snapshot judges the bridge stale. The SQL repeats
 * `isStale`'s `pending and challenge_id is null` — belt and suspenders against
 * a race: `f` is a snapshot, so if a game was recorded in the database after
 * `f` was read (T9 committed a create between the read and this call), the
 * UPDATE still refuses to touch it even though the stale caller's copy of `f`
 * does not know that yet.
 *
 * The claim (`mint_claimed_at`) is never touched: a pending row can be
 * mid-create in another process, and clearing its claim would hand the
 * create to a second claimant — two games at Lichess for one board.
 */
export async function resetStaleBridge(f: OnlinePlayFixture): Promise<void> {
  const at = f.scheduledAt;
  if (at === null || !isStale(f)) return;
  await sql`
    update fixture_external_play
       set scheduled_at_basis = ${at},
           white_side = null, white_lichess_id = null,
           black_lichess_id = null, expires_at = null,
           white_emailed_at = null, black_emailed_at = null,
           started_at = null, finished_at = null,
           last_error = null, updated_at = now()
     where fixture_id = ${f.fixtureId}
       and status = 'pending' and challenge_id is null
       and scheduled_at_basis <> ${at}`;
}

/** Idempotent — the first caller across every entry point creates the row;
 *  every other one is a no-op. */
export async function ensureBridgeRow(
  f: OnlinePlayFixture,
  opts: { basisIfUnopened?: Date } = {},
): Promise<void> {
  const basis = await bridgeBasis(f, opts);
  // Minted only while the fixture still seats the entrants `f` was read
  // with, under a SHARE lock on the fixture row. A Swiss seat clear
  // (stages.ts `clearSwissFixtureSeats`) locks the fixture rows FOR UPDATE
  // before it checks for games, so a mint racing it waits, then re-reads
  // the seats it cleared and writes nothing: no row — hence no claim, no
  // marker, no game — can appear behind a check that never saw one
  // (pre-review ruling 2026-10-10). Every caller's next write is
  // conditional on the row and reads 0 rows as lost/busy.
  await sql`
    insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis)
    select fx.id, ${f.orgId}::uuid, ${basis}::timestamptz
      from fixtures fx
     where fx.id = ${f.fixtureId}
       and fx.home_entrant_id = ${f.homeEntrantId}
       and fx.away_entrant_id = ${f.awayEntrantId}
       for share
    on conflict (fixture_id) do nothing`;
}

/** The basis a NEW bridge row is minted with: the board's start time, or —
 *  for a board with none — its round's `opened_at` (ruling 2026-10-10).
 *
 *  A NULL-time board in a round not yet opened has no basis. One writer
 *  legitimately mints a row then: the D11 video override, which an
 *  organiser may record before the open exactly as on a timed board (review
 *  M3). It passes `basisIfUnopened`; `attachToOpen` rebases such a row onto
 *  `opened_at` when the round opens, and the stale check ignores NULL-time
 *  boards, so the provisional value decides nothing. Every other writer runs
 *  only after the open, so reaching here without either is a broken premise,
 *  said loudly rather than left to a NOT NULL violation. */
export async function bridgeBasis(f: OnlinePlayFixture, opts: { basisIfUnopened?: Date } = {}): Promise<Date> {
  if (f.scheduledAt !== null) return f.scheduledAt;
  const opened = (await roundOpenFor(sql, f.fixtureId))?.roundOpenedAt ?? opts.basisIfUnopened ?? null;
  if (opened === null) {
    throw new Error(`bridgeBasis: fixture ${f.fixtureId} has no start time and its round is not open`);
  }
  return opened;
}

type SideRow = {
  displayName: string;
  personId: string | null;
  userId: string | null;
  email: string | null;
  locale: string | null;
  externalUserId: string | null;
  username: string | null;
};

/**
 * The PR's `loadSide` SQL, widened: `p.id as "personId"` and `p.merged_into
 * is null` (a tombstoned person is not a valid identity), plus a left join
 * onto `user_external_accounts` for the Lichess identity. Unlike the old
 * `loadSide` (which INNER-joined `entrant_members`/`persons` and returned
 * `null` for an entrant it could not resolve), every join here is LEFT: the
 * new `SidePlayer` always carries a `displayName` (sourced from `entrants`,
 * not from a joined `persons` row), even for an unrostered entrant or one
 * whose sole member is a merge tombstone with no live replacement.
 * `personId`/`userId`/`lichess` resolve only when exactly one member person
 * has a linked user — several linked members is not a chess seat (the old
 * code's own rule: never silently pick one). `recipients` stays broad — every
 * member's linked email, not just the one resolved seat.
 */
async function loadSide(side: Side, entrantId: string): Promise<SidePlayer> {
  const rows = await sql<SideRow[]>`
    select e.display_name as "displayName",
           p.id as "personId", p.user_id as "userId",
           u.email, u.locale,
           uea.external_user_id as "externalUserId", uea.username
      from entrants e
      left join entrant_members em on em.entrant_id = e.id
      left join persons p on p.id = em.person_id and p.merged_into is null
      left join users u on u.id = p.user_id
      left join user_external_accounts uea on uea.user_id = p.user_id and uea.provider = 'lichess'
     where e.id = ${entrantId}
     order by em.person_id`;
  const displayName = rows[0]?.displayName ?? entrantId;
  const withUser = rows.filter(
    (r): r is SideRow & { personId: string; userId: string } => r.personId !== null && r.userId !== null,
  );
  const distinctPersonIds = [...new Set(withUser.map((r) => r.personId))];
  const solo =
    distinctPersonIds.length === 1 ? withUser.find((r) => r.personId === distinctPersonIds[0]) : undefined;
  return {
    side,
    entrantId,
    displayName,
    personId: solo?.personId ?? null,
    userId: solo?.userId ?? null,
    lichess:
      solo?.externalUserId !== undefined && solo?.externalUserId !== null
        ? { id: solo.externalUserId, username: solo.username ?? solo.externalUserId }
        : null,
    recipients: rows
      .filter((r): r is SideRow & { email: string } => r.email !== null)
      .map((r) => ({ email: r.email, locale: r.locale })),
  };
}

export async function loadSides(f: OnlinePlayFixture): Promise<{ home: SidePlayer; away: SidePlayer }> {
  const [home, away] = await Promise.all([
    loadSide("home", f.homeEntrantId),
    loadSide("away", f.awayEntrantId),
  ]);
  return { home, away };
}

type FoldedBoardgameState = { colorOfHome?: "W" | "B" | null };

/** `colorOfHome` off the folded `match_states.state` (same cache
 *  `getFixtureState` reads for the pad) — `undefined`/`null`/no fold at all
 *  reads as White-on-home, because that is Swiss's own default (chess.md
 *  §2, `packages/engine/src/scheduling/swiss.ts:42`: "home: EntrantId //
 *  chess: White") and the boardgame module's `init` agrees (`colorOfHome:
 *  cfg.colors ? "W" : null` — colours-on is itself the schema default, so a
 *  fresh fold before any pairing card already reads "W", never null). */
function asColorOfHome(state: unknown): "W" | "B" | null {
  if (state === null || typeof state !== "object") return null;
  const value = (state as FoldedBoardgameState).colorOfHome;
  return value === "W" || value === "B" ? value : null;
}

/** Which side has White — home unless a `boardgame.pairing` card recorded
 *  Black on home. */
export async function whiteSideOf(f: OnlinePlayFixture): Promise<Side> {
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, f.fixtureId);
  return asColorOfHome(state.state) === "B" ? "away" : "home";
}
