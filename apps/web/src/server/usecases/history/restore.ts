import "server-only";
import { type FixtureSnapshot } from "@seazn/engine/history";
import { UUID_RE, liveCourt, venueOf } from "../court-restore-sql";
import { log } from "@/server/logger";
import { wireCrossFeeds } from "../stages";
import { DEPARTED_STATUSES } from "../entrants";
import type { Tx } from "./ledger";

// Review wave 1, finding 1 (scope cut 2026-08-18, owner-authorized: no prod
// backfill — there is no pre-cutover prod data — so this is a defensive
// guard for a dev/staging DB or a restored backup, not a live-data fix).
// `division_events` predates V374 for any division touched before the
// cutover, so a stored payload can still hold a free-text court label.
// `fixtures.court_id` is a real uuid column (V367); binding a non-uuid
// string as its query parameter raises Postgres 22P02 and aborts the WHOLE
// undo/redo transaction, not just the one fixture it names. Validate before
// the value ever reaches a query rather than let Postgres be the guard, so a
// single stale ledger row cannot break an unrelated transaction.
//
// `null`/`undefined` is a legitimate "no court" value and writes straight
// through. Anything else that isn't a real uuid is logged and the write is
// SKIPPED — `court_id` is left exactly as it already is, never overwritten
// with a guess (a null-write would itself destroy a possibly-valid current
// assignment the stale event knows nothing about).
type CourtWrite = { write: true; value: string | null } | { write: false };

export function resolveCourtWrite(value: unknown, context: Record<string, unknown>): CourtWrite {
  if (value === null || value === undefined) return { write: true, value: null };
  if (typeof value === "string" && UUID_RE.test(value)) return { write: true, value };
  log.warn(
    { ...context, court: value },
    "history: skipping non-uuid court in ledger event payload — court_id left untouched",
  );
  return { write: false };
}

const DEPARTED: string[] = [...DEPARTED_STATUSES];

/** The history events that delete fixture rows, each carrying them as they
 *  stood (`snapshotFixtures`) just before. */
export const DELETE_SIDE_EVENTS: ReadonlySet<string> = new Set(["fixtures_cleared", "pool_entrants_cleared"]);

/** The set of rows a snapshot holds, as one comparable key. */
export function snapshotIdKey(snapshot: unknown): string | undefined {
  if (!Array.isArray(snapshot)) return undefined;
  return (snapshot as FixtureSnapshot[])
    .map((f) => f.id)
    .sort()
    .join(",");
}

/** A restored seat: the entrant it held, AS DRAWN (review 2 of #857, I4,
 *  owner ruling), unless she is gone since.
 *  DELETED — the FK would refuse the insert (and a delete SET NULLs the seat
 *  of every live row, so an empty seat is what the row would hold had it
 *  never left).
 *  DEPARTED (withdrawn / disqualified, `DEPARTED_STATUSES`) — kept in her drawn
 *  seat, as the live rows keep her (a withdrawal before Start is a status
 *  flip). The ONE exception is a seat her own bye FED (`byeFedSeats`): the
 *  generator's third pass never carries a departed qualifier's bye into the
 *  next round (stages/, F14), so that seat restores EMPTY — its slot label
 *  is restored, so it still reads as its placeholder. */
const seatOf = (tx: Tx, entrantId: string | null | undefined, byeFedDeparted: boolean) =>
  byeFedDeparted
    ? tx`(select e.id from entrants e where e.id = ${entrantId ?? null} and e.status not in ${tx(DEPARTED)})`
    : tx`(select e.id from entrants e where e.id = ${entrantId ?? null})`;

/** The seats a settled line's award fed, as `fixture:slot:winner` — a bye (or
 *  any settled line) awarded to `winner` whose winner edge points at that
 *  seat. From the rows restored together only: an edge INTO a restored row
 *  from a row outside its snapshot was SET NULL by the delete. */
function byeFedSeats(snapshots: readonly FixtureSnapshot[]): Set<string> {
  const fed = new Set<string>();
  for (const r of snapshots) {
    const verdict = restoredVerdict(r);
    const winner = (verdict.outcome as { winner?: unknown } | null)?.winner;
    if (verdict.status === "scheduled" || typeof winner !== "string") continue;
    if (!r.winner_to_fixture || (r.winner_to_slot !== 1 && r.winner_to_slot !== 2)) continue;
    fed.add(`${r.winner_to_fixture}:${r.winner_to_slot}:${winner}`);
  }
  return fed;
}

// ---------------------------------------------------------------------------
// Fixture snapshots (restore fidelity, 2026-09-23)
//
// Two history writes DELETE fixtures — undoing a generation (`fixtures_cleared`,
// snapshotted in `stepWrite`) and clearing a pool's entrants
// (`pool_entrants_cleared`, snapshotted in `clearPoolEntrants`) — and their
// inverses re-insert the snapshot raw. The snapshot used to carry nine
// columns, so a restored bracket came back without its ext_key, its V368
// round role, its placeholders, its feed edges (winners stopped advancing),
// its byes' awards and its fixture numbers: the schedule board fell back to
// R{n}, and a regeneration no longer recognised a single row.
//
// `snapshotFixtures` is the ONE read both destructive paths record and
// `restoreFixtures` the ONE writer both inverses use. Every column of
// `fixtures` is decided here:
//
//   KEPT
//   - The generator's structure: ext_key (regeneration is idempotent by it;
//     page-playoff round names read it), lane / is_final / third_place /
//     conditional (V368 round role), home/away_slot_label (TBD placeholders),
//     winner_to/loser_to fixture+slot (the feed edges), fixture_no (the
//     number printed on sheets — renumbered only when taken since).
//   - ...except an ext_key a LIVE row of the same stage holds by the time of
//     the restore. Rows are minted outside the ledger — the Swiss shell
//     top-up (stages/swiss-reconcile.ts reconcileSwissRoundShells) inserts `sw-rN-bK` shells
//     no undo ever removes — so the key can be taken again, and `(stage_id,
//     ext_key)` is unique: a raw restore raised 23505, and since every retry
//     replays the same snapshot, Undo was stuck for good. The restored row
//     comes back WITHOUT the key instead (logged). The live row keeps it
//     because it is the one the generator already recognises; the restored
//     row is a board the generator no longer claims — exactly what every
//     restored row was before this fix, now confined to the colliding one.
//   - status / outcome of a row that carried no score events — on such a row
//     they can only be the generator's own verdicts (a bye's award, a
//     departed qualifier's walkover or void) or 'scheduled' (see
//     `restoredVerdict`) — and, with them, finished_at (V430): when the row
//     entered the finished set. V430's insert trigger keeps a supplied stamp,
//     so a restored bye's award keeps the time it was really awarded; a
//     snapshot from before V430 carries none and the trigger stamps it.
//   - The schedule placement: scheduled_at, court_id (both kept before this),
//     schedule_locked, schedule_source — and venue_id, re-derived from the
//     restored court rather than stored (its writer's own rule).
//   - Identity: id, stage_id, division_id, pool_id, round_no, seq_in_round,
//     home/away_entrant_id (kept before this). org_id is re-derived by the
//     insert trigger from the stage — the same value.
//
//   ...AS FAR AS THE ROSTER STILL HOLDS IT. What was deleted since the
//   snapshot is never written back: a seat whose entrant was deleted restores
//   EMPTY with its placeholder label, as does a seat her own bye fed if she
//   has departed since (`seatOf`, F14; a departed entrant otherwise keeps her
//   drawn seats, as the live rows do); a deleted court restores as no court and no venue,
//   a deleted pool as no pool; a deleted stage's rows are skipped. Each of
//   these used to be a foreign-key failure — the whole Undo refused, and every
//   retry replayed the same snapshot.
//
//   NOT KEPT
//   - Play state whose evidence the delete cascaded away: the status/outcome
//     of a scored row (it returns 'scheduled', as it always did — a DECIDED
//     row never gets here, the results-guard blocks the undo) and
//     config_snapshot / config_snapshot_at (frozen at match start).
//   - Match-day setup, which history has never restored: `officials` is a
//     mirror of `fixture_officials` (officials.ts), whose rows the delete
//     cascaded — restoring the mirror would contradict the table — and
//     `stream_url` sits with lineups and device links, which cascade too.
//   - created_at (the row really is inserted again); venue / court_label
//     (legacy free text, superseded by venue_id / court_id); parent_fixture_id
//     (nothing in apps/web writes it).
//
// Feed edges INTO a restored row from a row outside its snapshot were SET NULL
// by the delete, and the snapshot (outgoing edges only) cannot carry them. The
// ones a stage DECLARES — `cross_feeds` — are re-derived after every restore
// by the generator's own `wireCrossFeeds`, which fills null edges only. That
// is what re-wires a multi-step restore: undo B then A, and A's snapshot is
// taken after B's delete nulled A→B, so A comes back without it; restoring B
// next re-derives it. Known residual: an INTRA-stage edge that a later,
// partial regeneration's feed pass wrote from an older row into one of its
// own new rows (stages/, "Second pass: feeds") is declared nowhere but that
// pass, so undoing that regeneration and restoring it does not re-wire it.
// ---------------------------------------------------------------------------

/** A row that carried no score events comes back with the status, outcome and
 *  finished_at it had. Every play-driven status is a fold of score events
 *  (engine-db/append-event.ts), so on an unscored row they can only be the
 *  generator's own — a bye's award, a departed qualifier's walkover or void
 *  (stages/ first pass) — or plain 'scheduled'. A scored row's evidence went
 *  with the delete's cascade, so it returns unplayed, as it always has.
 *  `scored` must be literally false: a snapshot from before it existed
 *  restores 'scheduled', as it always did. */
function restoredVerdict(s: FixtureSnapshot): {
  status: string;
  outcome: Record<string, unknown> | null;
  finishedAt: string | null;
} {
  if (s.scored === false) {
    return { status: s.status ?? "scheduled", outcome: s.outcome ?? null, finishedAt: s.finished_at ?? null };
  }
  return { status: "scheduled", outcome: null, finishedAt: null };
}

/** The one raw re-insert (`pool_entrants_restored` in execute(), and a
 *  snapshot-carrying `fixtures_generated` in stepWrite). Returns the ids it
 *  inserted — a row that already exists is left alone (`on conflict`).
 *
 *  P9 dispatch #9: the court goes through `resolveCourtWrite` — a stale
 *  pre-cutover snapshot's non-uuid court raised 22P02 and aborted the whole
 *  undo. There is no existing row to "leave untouched" the way an UPDATE can,
 *  so an unresolvable court inserts as null (logged). */
export async function restoreFixtures(
  tx: Tx,
  divisionId: string,
  snapshots: readonly FixtureSnapshot[],
  eventType: string,
): Promise<string[]> {
  const jsonb = (value: Record<string, unknown> | null | undefined) =>
    value === null || value === undefined ? null : tx.json(value as never);
  const restored: FixtureSnapshot[] = [];
  // Insert order IS renumber order: a row whose number was taken gets the
  // trigger's max + 1, so rows go in by their original number and two that
  // both lost theirs keep their relative order. A legacy snapshot carries no
  // numbers at all, and the stable sort leaves its rows as they were.
  //
  // A row of a stage deleted since is skipped — nothing it could be restored
  // into, and the stage FK would refuse it (`deleteStage` appends a
  // non-reversible `stage_deleted`, so an older undo of that stage's
  // generation is still reachable behind it).
  const stageIds = [...new Set(snapshots.map((s) => s.stage_id!))];
  const liveStages = new Set(
    stageIds.length === 0
      ? []
      : (await tx<{ id: string }[]>`select id from stages where id in ${tx(stageIds)}`).map((r) => r.id),
  );
  const orphaned = snapshots.filter((s) => !liveStages.has(s.stage_id!));
  if (orphaned.length > 0) {
    log.warn(
      { divisionId, eventType, stageIds: [...new Set(orphaned.map((s) => s.stage_id))], fixtures: orphaned.length },
      "history: snapshot rows of a stage deleted since — skipped",
    );
  }
  const ordered = snapshots
    .filter((s) => liveStages.has(s.stage_id!))
    .sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0));
  const fed = byeFedSeats(ordered);
  const byeFed = (s: FixtureSnapshot, slot: 1 | 2, entrantId: string | null | undefined) =>
    entrantId != null && fed.has(`${s.id}:${slot}:${entrantId}`);
  for (const s of ordered) {
    const court = resolveCourtWrite(s.court, { divisionId, fixtureId: s.id, eventType });
    const courtId = court.write ? court.value : null;
    const verdict = restoredVerdict(s);
    // Everything the roster may have lost since resolves to what is live
    // (`seatOf`, `liveCourt`; a pool deleted since restores as none — the FK
    // is SET NULL, so no pool is a state the table already allows).
    // venue_id: derived from the court being restored (`venueOf`) — never
    // stored apart from the court it must agree with.
    // fixture_no: its own number unless something took it since, in which
    // case null lets the insert trigger hand out the next free one.
    // ext_key: its own key unless a live row of the stage holds it now (see
    // the KEPT list above) — then null, never a 23505 that sticks Undo.
    // Feed edges are written after every row is in (below): an edge may
    // point at a row later in this same list.
    // finished_at goes in as TEXT: a parameter the driver types as a
    // timestamp is serialised through a JS Date, which drops the
    // microseconds the snapshot read (`::text`) kept.
    const inserted = await tx<{ id: string; ext_key: string | null }[]>`
      insert into fixtures (id, stage_id, division_id, pool_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, court_id,
                            venue_id, schedule_locked, schedule_source, fixture_no,
                            ext_key, lane, is_final, third_place, conditional,
                            home_slot_label, away_slot_label, status, outcome, finished_at)
      values (${s.id}, ${s.stage_id!}, ${divisionId},
              (select p.id from pools p where p.id = ${s.pool_id ?? null}),
              ${s.round_no ?? 1}, ${s.seq_in_round ?? 1},
              ${seatOf(tx, s.home_entrant_id, byeFed(s, 1, s.home_entrant_id))},
              ${seatOf(tx, s.away_entrant_id, byeFed(s, 2, s.away_entrant_id))},
              ${s.at ?? null}, ${liveCourt(tx, courtId)}, ${venueOf(tx, courtId)},
              ${s.locked === true}, ${s.schedule_source ?? "none"},
              (select n.no from (select ${s.fixture_no ?? null}::int as no) n
                where not exists (select 1 from fixtures t
                                  where t.division_id = ${divisionId} and t.fixture_no = n.no)),
              (select k.key from (select ${s.ext_key ?? null}::text as key) k
                where not exists (select 1 from fixtures t
                                  where t.stage_id = ${s.stage_id!} and t.ext_key = k.key)),
              ${s.lane ?? null}, ${s.is_final === true},
              ${s.third_place === true}, ${s.conditional === true},
              ${jsonb(s.home_slot_label)}, ${jsonb(s.away_slot_label)},
              ${verdict.status}, ${jsonb(verdict.outcome)}, ${verdict.finishedAt}::text::timestamptz)
      on conflict (id) do nothing returning id, ext_key`;
    const [row] = inserted;
    if (row === undefined) continue;
    restored.push(s);
    if (s.ext_key && row.ext_key === null) {
      log.warn(
        { divisionId, fixtureId: s.id, extKey: s.ext_key, eventType },
        "history: a live fixture of this stage holds the restored row's ext_key — restored without it",
      );
    }
  }
  // An edge whose target no longer exists is dropped with its slot, never
  // written as a dangling id (the FK would refuse it).
  for (const s of restored) {
    if (!s.winner_to_fixture && !s.loser_to_fixture) continue;
    await tx`
      update fixtures set
        winner_to_fixture = (select t.id from fixtures t where t.id = ${s.winner_to_fixture ?? null}),
        winner_to_slot = (select ${s.winner_to_slot ?? null}::int from fixtures t
                          where t.id = ${s.winner_to_fixture ?? null}),
        loser_to_fixture = (select t.id from fixtures t where t.id = ${s.loser_to_fixture ?? null}),
        loser_to_slot = (select ${s.loser_to_slot ?? null}::int from fixtures t
                         where t.id = ${s.loser_to_fixture ?? null})
      where id = ${s.id}`;
  }
  // Edges INTO the restored rows that a stage declares (`cross_feeds`): the
  // generator's own re-derivation, null edges only — see the header above.
  await wireCrossFeeds(tx, divisionId);
  return restored.map((s) => s.id);
}
