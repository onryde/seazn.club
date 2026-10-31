import "server-only";
// server/sponsors/assign.ts — R4 sponsors on stream, S5: the overlay's `sponsorPlan` (spec 2026-10-27 §3.2), and the
// assignments that freeze it (plan P3). The production producer of the plan S6/S7 put on screen and S8 proves.
//
// EVERY POLL PLANS; FEW WRITE. The plan is the pure planner (S4 `planSponsors`) over the fixture's breaks (the fold's
// replay), the dial (`resolveStreamSettings`), the ticked cards (the card source), the operator log, and the fixture's
// persisted assignments. It is planned READ-ONLY first. Only when that plan hands a break its first card
// (`newAssignments`), or a stored assignment's break is gone and it never aired (`undone`, R3: only from a complete
// replay), does the poll open a transaction:
//   1. check the fixture is the org's (the database does not: V483 has no composite foreign keys);
//   2. take the org's rotation lock (`lockSponsorRotation`) — one rotation per org across all its matches (D14), so two
//      fixtures streaming at once never hand out one position, and two polls of one fixture never assign one break twice;
//   3. re-read the fixture's assignments and the org's max(position), and re-plan on them (another poll may have just
//      written the same break: the re-plan then has nothing new, and serves that poll's card);
//   4. insert the new rows (`on conflict do nothing`, positions from max + 1: F9), and delete the undone ones that have no
//      sponsor_airings row (one that aired is proof of play and stays);
//   5. commit, and serve the re-plan.
// A poll with nothing new takes no lock and writes nothing (Review Focus 1: every OBS viewer's poll lands here).
//
// Outside the fold cache on purpose: the fold is per `last_seq`, the settings, the ticks and the assignments are not.
//
// NEVER FAILS THE OVERLAY. A planner refusal (`SponsorPlanInputError`) serves no plan and logs; the overlay loader
// catches anything else (load.ts). A short code that cannot be minted costs that card its link, never the plan.
import { sql, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import {
  planSponsors,
  SponsorPlanInputError,
  type BreakOpened,
  type PlanInput,
  type SponsorAssignment,
  type SponsorPlan,
  type SponsorPlanResult,
} from "@/lib/sponsor-plan";
import { activeSponsorCards, sponsorTiersOn, sponsorsTableCardSource, type SponsorCardSource } from "./card-source";
import { operatorLogFor } from "./operator-log";
import { drawShortCode, mintShortCode, shortCodesFor, type ShortCodeDraw } from "./short-codes";
import { resolveStreamSettings } from "./stream-settings";

/** The org's rotation lock: namespaced apart from the stream-credits money lock (`orgMoneyLockKey`, F8), so a sponsor
 *  poll never queues behind a money write. Lower-cased so two spellings of one org's uuid take ONE lock. hashtext is
 *  32-bit: a collision only serialises two unrelated writers, never lets two writers of one org run together. */
export function sponsorRotationLockKey(orgId: string): string {
  return `sponsor-rotation-org:${orgId.toLowerCase()}`;
}

/** Serialises every sponsor assignment write of one org, until the transaction ends. Taken before the re-read. */
export async function lockSponsorRotation(tx: Tx, orgId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${sponsorRotationLockKey(orgId)}))`;
}

/** A break card's moment id, as S5 mints it (`sponsorMomentId`, lib/sponsor-plan.ts): `<seq>:sponsor.<breakKind>`, seq
 *  a decimal integer with no leading zero, breakKind non-empty. */
const BREAK_MOMENT_ID = /^(?:0|[1-9][0-9]*):sponsor\.(.+)$/;

/** The inverse of `sponsorMomentId`: the break kind a break card's moment id names, or null for any other id (a scene
 *  carousel showing's `scene:<id>:<bucket>`, or anything malformed). For S8's void-race fallback, which may refuse a
 *  start whose `breakKind` disagrees with its moment id's. */
export function breakKindOfMomentId(momentId: string): string | null {
  return BREAK_MOMENT_ID.exec(momentId)?.[1] ?? null;
}

/** Where a fixture's sponsors come from: its org, and its division's competition. Null: no such fixture. */
export async function sponsorScopeOf(
  exec: Tx | typeof sql,
  fixtureId: string,
): Promise<{ orgId: string; competitionId: string | null } | null> {
  const [row] = await exec<{ org_id: string; competition_id: string | null }[]>`
    select f.org_id, d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  return row === undefined ? null : { orgId: row.org_id, competitionId: row.competition_id };
}

/** A write for a fixture that is not the org's (or the competition's), or an insert that lost a row under the lock.
 *  Both "cannot happen"; both refuse the write by name, and the transaction rolls back. */
export class SponsorAssignmentWriteError extends Error {
  override name = "SponsorAssignmentWriteError";
}

interface AssignmentRow {
  moment_id: string;
  seq: number;
  sponsor_id: string | null;
  sponsor_name: string;
  position: number | null;
  source: SponsorAssignment["source"];
  break_kind: string;
  style: SponsorAssignment["style"];
  hold_ms: number;
  operator_choice_at: Date | null;
}

/** The fixture's persisted (frozen) assignments, ascending seq. */
export async function assignmentsFor(exec: Tx | typeof sql, fixtureId: string, orgId: string): Promise<SponsorAssignment[]> {
  const rows = await exec<AssignmentRow[]>`
    select moment_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms, operator_choice_at
      from sponsor_assignments
     where fixture_id = ${fixtureId} and org_id = ${orgId}
     order by seq, moment_id`;
  return rows.map((r) => ({
    momentId: r.moment_id,
    seq: r.seq,
    sponsorId: r.sponsor_id,
    sponsorName: r.sponsor_name,
    position: r.position,
    source: r.source,
    breakKind: r.break_kind,
    style: r.style,
    holdMs: r.hold_ms,
    operatorChoiceAt: r.operator_choice_at === null ? null : r.operator_choice_at.toISOString(),
  }));
}

/** The org's next free rotation position: max(position) + 1, gaps allowed (F9); 0 for an org with none. */
async function nextRotationPosition(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx<{ next: number }[]>`
    select coalesce(max(position), -1) + 1 as next from sponsor_assignments where org_id = ${orgId} and position is not null`;
  return Number(row!.next);
}

/** Inserts the planner's new assignments, each with its sponsor's name snapshot (S3 ruling). Under the rotation lock no
 *  row can conflict; one that does anyway (a writer that skipped the lock) is refused, never dropped silently — the plan
 *  served would name a card the table does not hold. */
export async function writeAssignments(
  tx: Tx,
  a: { fixtureId: string; orgId: string },
  rows: readonly SponsorAssignment[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map((r) => ({
    fixture_id: a.fixtureId,
    moment_id: r.momentId,
    org_id: a.orgId,
    seq: r.seq,
    sponsor_id: r.sponsorId,
    sponsor_name: r.sponsorName,
    position: r.position,
    source: r.source,
    break_kind: r.breakKind,
    style: r.style,
    hold_ms: r.holdMs,
    operator_choice_at: r.operatorChoiceAt,
  }));
  const inserted = await tx`
    insert into sponsor_assignments ${tx(values, "fixture_id", "moment_id", "org_id", "seq", "sponsor_id", "sponsor_name",
      "position", "source", "break_kind", "style", "hold_ms", "operator_choice_at")}
    on conflict do nothing
    returning moment_id`;
  if (inserted.length !== rows.length) {
    throw new SponsorAssignmentWriteError(
      `sponsor assignments: ${rows.length - inserted.length} of ${rows.length} rows conflicted under the rotation lock`,
    );
  }
  return inserted.length;
}

/** Deletes these undone assignments of the fixture, except any that aired (a sponsor_airings row for the moment). */
async function deleteUndoneUnaired(tx: Tx, a: { fixtureId: string; orgId: string }, momentIds: readonly string[]): Promise<number> {
  if (momentIds.length === 0) return 0;
  const deleted = await tx`
    delete from sponsor_assignments sa
     where sa.fixture_id = ${a.fixtureId} and sa.org_id = ${a.orgId} and sa.moment_id = any(${momentIds as string[]}::text[])
       and not exists (select 1 from sponsor_airings s where s.fixture_id = sa.fixture_id and s.moment_id = sa.moment_id)
    returning sa.moment_id`;
  return deleted.length;
}

/** The undone assignments that never aired. No read when there are none. */
async function unaired(exec: Tx | typeof sql, fixtureId: string, undone: readonly SponsorAssignment[]): Promise<SponsorAssignment[]> {
  if (undone.length === 0) return [];
  const aired = await exec<{ moment_id: string }[]>`
    select moment_id from sponsor_airings
     where fixture_id = ${fixtureId} and moment_id = any(${undone.map((u) => u.momentId)}::text[])`;
  const airedIds = new Set(aired.map((r) => r.moment_id));
  return undone.filter((u) => !airedIds.has(u.momentId));
}

const sponsorIdsOf = (assigned: readonly SponsorAssignment[]): string[] => [
  ...new Set(assigned.flatMap((a) => (a.sponsorId === null ? [] : [a.sponsorId]))),
];

/** Each card's short code (owner ruling R7), minted for a linkable sponsor that has none on this fixture yet. */
async function withShortCodes(
  plan: NonNullable<SponsorPlan>,
  a: { fixtureId: string; orgId: string },
  draw: ShortCodeDraw,
): Promise<NonNullable<SponsorPlan>> {
  const { codes, unminted } = await shortCodesFor(sql, { ...a, sponsorIds: plan.cards.map((c) => c.sponsorId) });
  for (const sponsorId of unminted) {
    try {
      const code = await mintShortCode({ ...a, sponsorId }, draw);
      if (code !== null) codes.set(sponsorId, code);
    } catch (err) {
      log.warn({ err, fixtureId: a.fixtureId, sponsorId }, "sponsor plan: no short code minted; the card shows no link");
    }
  }
  return {
    ...plan,
    cards: plan.cards.map((c) => {
      const shortCode = codes.get(c.sponsorId);
      return shortCode === undefined ? c : { ...c, shortCode };
    }),
  };
}

export interface LoadSponsorPlanArgs {
  fixtureId: string;
  orgId: string;
  competitionId: string | null;
  /** The whole fixture's natural breaks, ascending seq (`DerivedReplay.breaks`). */
  breaks: readonly BreakOpened[];
  /** The `recent` window's seqs. */
  windowSeqs: readonly number[];
  /** `DerivedReplay.breaksComplete`: false (a refusal part-way, a fold that fell back, no fold) ⇒ nothing is undone (R3). */
  complete: boolean;
}

export interface LoadSponsorPlanDeps {
  source?: SponsorCardSource;
  /** The poll's clock, epoch ms (the planner's R2 freshness cut). */
  now?: number;
  draw?: ShortCodeDraw;
}

/**
 * The fixture's sponsor plan, writing the assignments it hands out (see the header). Null: no settings row in force,
 * rotation off, no card at all, or a planner refusal (logged). Throws only what the database throws, and
 * `SponsorAssignmentWriteError` (both: the overlay loader serves no plan and logs).
 */
export async function loadSponsorPlan(a: LoadSponsorPlanArgs, deps: LoadSponsorPlanDeps = {}): Promise<SponsorPlan> {
  const source = deps.source ?? sponsorsTableCardSource;
  const now = deps.now ?? Date.now();
  const settings = await resolveStreamSettings(sql, a.orgId, a.competitionId);
  // Off ⇒ nothing read past the settings: the ordinary overlay (no sponsors) pays one read. An undone assignment of a
  // fixture whose rotation is off stays until the rotation is on again; it holds a gap in the positions, nothing more.
  if (settings === null || !settings.enabled) return null;
  const [cards, tiered, stored] = await Promise.all([
    source.cardsFor(a.orgId, { competitionId: a.competitionId }),
    sponsorTiersOn(a.orgId, a.competitionId),
    assignmentsFor(sql, a.fixtureId, a.orgId),
  ]);
  const [assignedCards, operatorLog] = await Promise.all([
    activeSponsorCards(sql, a.orgId, sponsorIdsOf(stored), tiered),
    operatorLogFor(sql, a.fixtureId),
  ]);
  const input = (assigned: SponsorAssignment[], assignedNow: PlanInput["assignedCards"], nextPosition: number): PlanInput => ({
    breaks: a.breaks,
    windowSeqs: a.windowSeqs,
    settings,
    cards,
    assignedCards: assignedNow,
    assigned,
    operatorLog,
    nextPosition,
    now,
    complete: a.complete,
  });

  let result: SponsorPlanResult;
  try {
    // Read-only. `nextPosition` 0 stands in: a position only names WHO takes a new break, never WHETHER one is taken, and
    // a plan with new breaks is planned again under the lock with the real one — so this plan is served only when it
    // assigns nothing, and then no position appears in it.
    result = planSponsors(input(stored, assignedCards, 0));
    const toDelete = await unaired(sql, a.fixtureId, result.undone);
    if (result.newAssignments.length > 0 || toDelete.length > 0) {
      result = await sql.begin(async (tx) => {
        const scope = await sponsorScopeOf(tx, a.fixtureId);
        if (scope === null || scope.orgId !== a.orgId || scope.competitionId !== a.competitionId) {
          throw new SponsorAssignmentWriteError(`sponsor assignments: fixture ${a.fixtureId} is not org ${a.orgId}'s (competition ${a.competitionId})`);
        }
        await lockSponsorRotation(tx, a.orgId);
        const fresh = await assignmentsFor(tx, a.fixtureId, a.orgId);
        const freshCards = await activeSponsorCards(tx, a.orgId, sponsorIdsOf(fresh), tiered);
        const r = planSponsors(input(fresh, freshCards, await nextRotationPosition(tx, a.orgId)));
        await writeAssignments(tx, a, r.newAssignments);
        await deleteUndoneUnaired(tx, a, r.undone.map((u) => u.momentId));
        return r;
      }) as SponsorPlanResult;
    }
  } catch (err) {
    if (!(err instanceof SponsorPlanInputError)) throw err;
    log.warn({ err: err.message, fixtureId: a.fixtureId, orgId: a.orgId }, "sponsor plan: the planner refused its input; serving no sponsor cards");
    return null;
  }
  if (result.plan === null) return null;
  return withShortCodes(result.plan, a, deps.draw ?? drawShortCode);
}
