import "server-only";
import { type FixtureSnapshot } from "@seazn/engine/history";
import { HttpError } from "@/lib/errors";
import { liveCourt, venueBack, venueWith } from "../court-restore-sql";
import { refuseOwnFormatLoss } from "../fixture-override-guards";
import { FIXTURE_DELETED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "../external-play/cancel-invites";
import { slotTaker, unplayed, type Tx } from "./ledger";
import { resolveCourtWrite, restoreFixtures } from "./restore";

// Execute one history event against the fixture tables. Undo/redo of a
// fixtures_generated with no snapshots re-runs the deterministic generator.
//
// R10e: returns the ids of the fixtures its own statements wrote (each one
// `returning id`), so a caller publishes exactly those, never the payload's
// list — a row the `unplayed` filter skipped was not changed.
export async function execute(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
  /** Filled in: did a delete remove a fixture that carried score events? */
  effects: { scoredFixtureRemoved: boolean } = { scoredFixtureRemoved: false },
): Promise<string[]> {
  const p = event.payload;
  const written: string[] = [];
  const wrote = (rows: readonly { id: string }[]) => {
    for (const row of rows) written.push(row.id);
  };
  switch (event.type) {
    // P9 pass 3a: `court`/`.court` on every payload below is a `courts.id`
    // now (schedule/move.ts's `moveFixture`/`applySchedule` write it that way —
    // see their own comments on `schedule_edited`/`schedule_applied`), so
    // every replay here writes `court_id`, never the legacy `court_label`.
    // This is the fix the dispatch's regression targets: undo/redo used to
    // write a STALE FREE-TEXT LABEL back into `court_label` while `court_id`
    // sat untouched — a real defect (the two columns silently disagreeing
    // after a restore), not merely a rename.
    case "schedule_applied":
    case "schedule_shifted": {
      const moves =
        (p.moves as { fixture: string; to: { at: string | null; court: string | null; venue?: unknown } }[]) ?? [];
      for (const m of moves) {
        const court = resolveCourtWrite(m.to.court, { divisionId, fixtureId: m.fixture, eventType: event.type });
        if (court.write) {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${m.to.at}, court_id = ${liveCourt(tx, court.value)},
                                                             venue_id = ${venueBack(tx, court.value, m.to)}
                   where id = ${m.fixture} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
        } else {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${m.to.at}
                   where id = ${m.fixture} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
        }
      }
      break;
    }
    case "schedule_edited": {
      const to = p.to as { at: string | null; court: string | null; venue?: unknown; locked?: boolean };
      const court = resolveCourtWrite(to.court, { divisionId, fixtureId: p.fixture, eventType: event.type });
      if (court.write) {
        wrote(await tx<{ id: string }[]>`
          update fixtures set scheduled_at = ${to.at}, court_id = ${liveCourt(tx, court.value)},
                              venue_id = ${venueBack(tx, court.value, to)},
                              schedule_locked = coalesce(${to.locked ?? null}, schedule_locked)
          where id = ${p.fixture as string} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
      } else {
        wrote(await tx<{ id: string }[]>`
          update fixtures set scheduled_at = ${to.at},
                              schedule_locked = coalesce(${to.locked ?? null}, schedule_locked)
          where id = ${p.fixture as string} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
      }
      break;
    }
    case "schedule_cleared": {
      for (const s of (p.cleared as FixtureSnapshot[]) ?? []) {
        // The venue goes with a court; a venue held with no court stays.
        wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = null, court_id = null,
                                                           venue_id = case when court_id is null then venue_id end
                 where id = ${s.id} and ${unplayed(tx)} returning id`);
      }
      break;
    }
    case "schedule_restored": {
      for (const s of (p.restored as FixtureSnapshot[]) ?? []) {
        const court = resolveCourtWrite(s.court, { divisionId, fixtureId: s.id, eventType: event.type });
        if (court.write) {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${s.at ?? null}, court_id = ${liveCourt(tx, court.value)},
                                                             venue_id = ${venueWith(tx, court.value)}
                   where id = ${s.id} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
        } else {
          wrote(await tx<{ id: string }[]>`update fixtures set scheduled_at = ${s.at ?? null}
                   where id = ${s.id} and ${unplayed(tx)} and ${slotTaker(tx)} returning id`);
        }
      }
      break;
    }
    case "fixtures_cleared":
    case "pool_entrants_cleared": {
      const ids =
        event.type === "fixtures_cleared"
          ? ((p.fixture_ids as string[]) ?? [])
          : ((p.fixtures as FixtureSnapshot[]) ?? []).map((s) => s.id);
      if (ids.length > 0) {
        // `scored`: whether the fixture carried score events, which cascade away
        // with it. Every part of a data-modifying WITH reads the same snapshot,
        // so the outer select still sees the rows its delete removes. The
        // caller refreshes the division's player stats when one did.
        // W2c Task 14: the snapshot does not carry a match's own format, so the delete is refused by name instead —
        // over exactly the rows it removes.
        await refuseOwnFormatLoss(tx, tx`id in ${tx(ids)} and ${unplayed(tx)}`);
        const removed = await tx<{ id: string; scored: boolean }[]>`
          with gone as (
            delete from fixtures where id in ${tx(ids)} and ${unplayed(tx)} returning id
          )
          select gone.id, exists (select 1 from score_events se where se.fixture_id = gone.id) as scored
          from gone`;
        // Phase 3 wave 1 (G-1): the chess invites still queued for the boards just deleted end with them (`fixture_deleted`). Named
        // from the rows the delete returned - an unplayed filter above may have spared some - and ended in this same transaction.
        await cancelBoardInvites(tx, removed.map((row) => row.id), FIXTURE_DELETED_REASON);
        wrote(removed);
        if (removed.some((row) => row.scored)) effects.scoredFixtureRemoved = true;
      }
      break;
    }
    case "pool_entrants_restored": {
      // The raw re-insert of `clearPoolEntrants`'s snapshot — see
      // `restoreFixtures` for what comes back and the court guard.
      written.push(...(await restoreFixtures(tx, divisionId, (p.fixtures as FixtureSnapshot[]) ?? [], event.type)));
      break;
    }
    case "fixtures_generated": {
      // Deterministic generator re-run (idempotent by ext_key) — marker set
      // by the caller; actual regeneration happens outside this tx.
      break;
    }
    default:
      throw new HttpError(500, `no executor for history event '${event.type}'`);
  }
  return written;
}
