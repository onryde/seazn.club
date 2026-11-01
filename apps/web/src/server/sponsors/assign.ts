import "server-only";
// server/sponsors/assign.ts — R4 sponsors on stream, S5: the overlay's `sponsorPlan` (spec 2026-10-27 §3.2), and the
// assignments that freeze it (plan P3). The production producer of the plan S6/S7 put on screen and S8 proves.
//
// EVERY POLL PLANS; FEW WRITE. The plan is the pure planner (S4 `planSponsors`) over the fixture's breaks (the fold's
// replay), the dial (the settings in force), the ticked cards (the card source), the operator log, and the fixture's
// persisted assignments. It is planned READ-ONLY first. Only when that plan hands a break its first card
// (`newAssignments`), or a stored assignment's break is PROVEN gone and it never aired, does the poll open a transaction.
// "Proven gone" (`undone`) needs a complete replay (R3) that reached the assignment's seq: the public door folds at a
// cached `last_seq` up to 30 s behind the relay door's, and its absence says nothing about a break the fresher door saw
// (fix round 1, I1 — `foldedThrough`). The transaction:
//   1. check the fixture is the org's (the database does not: V483 has no composite foreign keys);
//   2. take the org's rotation lock (`lockSponsorRotation`) — one rotation per org across all its matches (D14), so two
//      fixtures streaming at once never hand out one position, and two polls of one fixture never assign one break twice;
//   3. re-read the fixture's assignments and the org's max(position), and re-plan on them (another poll may have just
//      written the same break: the re-plan then has nothing new, and serves that poll's card);
//   4. insert the new rows (`on conflict do nothing`, positions from max + 1: F9), and delete the undone ones that have no
//      sponsor_airings row (one that aired is proof of play and stays);
//   5. commit, and serve the re-plan.
// A poll with nothing new takes no lock and writes nothing (Review Focus 1: every OBS viewer's poll lands here), and an
// aired undone row costs nothing either (`aired` rides the assignments read). A READ-ONLY poll (the console's preview,
// `?preview=1`) never writes: it plans with the org's real next position and serves the codes already minted.
//
// Outside the fold cache on purpose: the fold is per `last_seq`, the settings, the ticks and the assignments are not.
//
// NEVER FAILS THE OVERLAY. A planner refusal (`SponsorPlanInputError`) serves no plan and logs; the overlay loader
// catches anything else (load.ts). A short code that cannot be minted costs that card its link, never the plan.
import { sql, type Tx } from "@/lib/db";
import { breakKindOfMomentId } from "@/lib/sponsor-moment-id";
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
import { resolveStreamSettings, streamSettingsQuery, type StreamSettings } from "./stream-settings";

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

/** The break kind a break card's moment id names, or null for any other id - for S8's void-race fallback, which may
 *  refuse a start whose `breakKind` disagrees with its moment id's. The grammar's one authority is lib/sponsor-moment-id.ts. */
export { breakKindOfMomentId };

/** Where a fixture's sponsors come from: its org, and its division's competition. Null: no such fixture. */
export async function sponsorScopeOf(
  exec: Tx | typeof sql,
  fixtureId: string,
): Promise<{ orgId: string; competitionId: string | null } | null> {
  const [row] = await exec<{ org_id: string; competition_id: string | null }[]>`
    select f.org_id, d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  return row === undefined ? null : { orgId: row.org_id, competitionId: row.competition_id };
}

/** The overlay's per-poll sponsor context in ONE statement (fix round 1, m5): the fixture's org, its division's
 *  competition, and the settings in force for it (the one settings rule, `streamSettingsQuery`, as a lateral). Every
 *  overlay poll pays it, sponsors or not. Null: no such fixture. */
export async function sponsorContextOf(
  exec: Tx | typeof sql,
  fixtureId: string,
): Promise<{ orgId: string; competitionId: string | null; settings: StreamSettings | null } | null> {
  const [row] = await exec<{ org_id: string; competition_id: string | null; enabled: boolean | null; frequency: StreamSettings["frequency"] | null }[]>`
    select f.org_id, d.competition_id, s.enabled, s.frequency
      from fixtures f
      join divisions d on d.id = f.division_id
      left join lateral (${streamSettingsQuery(exec, exec`f.org_id`, exec`d.competition_id`)}) s on true
     where f.id = ${fixtureId}`;
  if (row === undefined) return null;
  const settings = row.enabled === null || row.frequency === null ? null : { enabled: row.enabled, frequency: row.frequency };
  return { orgId: row.org_id, competitionId: row.competition_id, settings };
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
  aired: boolean;
}

/** A persisted assignment, and whether it ever aired (a sponsor_airings row for its moment: proof of play, never
 *  deleted). Read in the same statement so an aired undone row costs no second read on every poll (fix round 1, m7). */
export type StoredAssignment = SponsorAssignment & { aired: boolean };

/** The fixture's persisted (frozen) assignments, ascending seq. */
export async function assignmentsFor(exec: Tx | typeof sql, fixtureId: string, orgId: string): Promise<StoredAssignment[]> {
  const rows = await exec<AssignmentRow[]>`
    select sa.moment_id, sa.seq, sa.sponsor_id, sa.sponsor_name, sa.position, sa.source, sa.break_kind, sa.style, sa.hold_ms,
           sa.operator_choice_at,
           exists (select 1 from sponsor_airings s where s.fixture_id = sa.fixture_id and s.moment_id = sa.moment_id) as aired
      from sponsor_assignments sa
     where sa.fixture_id = ${fixtureId} and sa.org_id = ${orgId}
     order by sa.seq, sa.moment_id`;
  return rows.map((r) => ({
    aired: r.aired,
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
async function nextRotationPosition(exec: Tx | typeof sql, orgId: string): Promise<number> {
  const [row] = await exec<{ next: number }[]>`
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

const sponsorIdsOf = (assigned: readonly SponsorAssignment[]): string[] => [
  ...new Set(assigned.flatMap((a) => (a.sponsorId === null ? [] : [a.sponsorId]))),
];

/** Each card's short code (owner ruling R7), minted for a linkable sponsor that has none on this fixture yet — unless
 *  the poll is read-only, which serves only the codes already minted. */
async function withShortCodes(
  plan: NonNullable<SponsorPlan>,
  a: { fixtureId: string; orgId: string },
  draw: ShortCodeDraw | null,
): Promise<NonNullable<SponsorPlan>> {
  const { codes, unminted } = await shortCodesFor(sql, { ...a, sponsorIds: plan.cards.map((c) => c.sponsorId) });
  for (const sponsorId of unminted) {
    if (draw === null) break;
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
  /** The `last_seq` the breaks were folded at (the fold cache's key). A complete replay proves a break gone only up to
   *  here: an assignment past it was made by a fresher door and is never undone by this poll. Null: nothing folded. */
  foldedThrough: number | null;
  /** The settings in force, when the caller already read them (`sponsorContextOf`); absent ⇒ read here. */
  settings?: StreamSettings | null;
}

export interface LoadSponsorPlanDeps {
  source?: SponsorCardSource;
  /** The poll's clock, epoch ms (the planner's R2 freshness cut). */
  now?: number;
  draw?: ShortCodeDraw;
  /** The console's preview (`?preview=1`): plan, never write — no assignment, no delete, no short code. */
  readOnly?: boolean;
}

/**
 * The fixture's sponsor plan, writing the assignments it hands out (see the header). Null: no settings row in force,
 * rotation off, no card at all, or a planner refusal (logged). Throws only what the database throws, and
 * `SponsorAssignmentWriteError` (both: the overlay loader serves no plan and logs).
 */
export async function loadSponsorPlan(a: LoadSponsorPlanArgs, deps: LoadSponsorPlanDeps = {}): Promise<SponsorPlan> {
  const source = deps.source ?? sponsorsTableCardSource;
  const now = deps.now ?? Date.now();
  const readOnly = deps.readOnly === true;
  const settings = a.settings !== undefined ? a.settings : await resolveStreamSettings(sql, a.orgId, a.competitionId);
  // Off ⇒ nothing read past the settings: the ordinary overlay (no sponsors) pays one read. An undone assignment of a
  // fixture whose rotation is off stays until the rotation is on again; it holds a gap in the positions, nothing more.
  if (settings === null || !settings.enabled) return null;
  /** Undone AND provably so (I1): the replay reached the row's seq. Aired rows are proof of play and stay. */
  const deletable = (undone: readonly SponsorAssignment[], stored: readonly StoredAssignment[]): SponsorAssignment[] => {
    const aired = new Set(stored.filter((x) => x.aired).map((x) => x.momentId));
    return undone.filter((u) => a.foldedThrough !== null && u.seq <= a.foldedThrough && !aired.has(u.momentId));
  };
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
    const toDelete = deletable(result.undone, stored);
    if (readOnly) {
      // The preview: the card a writing poll would hand out, from the org's real next position. Nothing is written.
      if (result.newAssignments.length > 0) result = planSponsors(input(stored, assignedCards, await nextRotationPosition(sql, a.orgId)));
    } else if (result.newAssignments.length > 0 || toDelete.length > 0) {
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
        // Bounded by the fold's tip again (I1), on the RE-READ rows; whether one aired is the delete's own `not exists`.
        await deleteUndoneUnaired(tx, a, r.undone.filter((u) => a.foldedThrough !== null && u.seq <= a.foldedThrough).map((u) => u.momentId));
        return r;
      }) as SponsorPlanResult;
    }
  } catch (err) {
    if (!(err instanceof SponsorPlanInputError)) throw err;
    log.warn({ err: err.message, fixtureId: a.fixtureId, orgId: a.orgId }, "sponsor plan: the planner refused its input; serving no sponsor cards");
    return null;
  }
  if (result.plan === null) return null;
  return withShortCodes(result.plan, a, readOnly ? null : (deps.draw ?? drawShortCode));
}

export interface FixtureSponsorPlanArgs {
  fixtureId: string;
  breaks: readonly BreakOpened[];
  windowSeqs: readonly number[];
  complete: boolean;
  foldedThrough: number | null;
}

/** The overlay loader's entry: the fixture's context in one statement (`sponsorContextOf`), then its plan. Null: no
 *  such fixture, or rotation off — after that ONE statement. */
export async function loadFixtureSponsorPlan(a: FixtureSponsorPlanArgs, deps: LoadSponsorPlanDeps = {}): Promise<SponsorPlan> {
  const ctx = await sponsorContextOf(sql, a.fixtureId);
  if (ctx === null) return null;
  return loadSponsorPlan({ ...a, orgId: ctx.orgId, competitionId: ctx.competitionId, settings: ctx.settings }, deps);
}
