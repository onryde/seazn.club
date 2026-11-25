import "server-only";
// W5 stress fix F3: a Reinstate (and the resume of a cut-off withdrawal) takes back what a cascade did to a leaver's table
// lines by VOIDING events: the expunge abandons, a legacy expunge, her `withdrew` walkovers. It voided them one at a time
// through `scoreEvent`, the full per-tap pipeline: a transaction, a table refold, a discipline fold, a news draft, a public
// cache DEL and pushes, for every line — on a 144-entrant league 143 lines, 2,711 transactions and 36 s for one Reinstate.
//
// `voidLineEvents` writes every void in ONE transaction, each through the one append path (`appendEventInTx`), so every line
// keeps its own `core.void` row in its ledger exactly as before (seq, `voids_event_id`, writer, recorder): every reader of
// the ledger (the fold, the pad, the referee view, `tableReinstateOwed`, history) sees the same rows. Then the after-commit
// work `scoreEvent` runs per event runs ONCE for the batch, and every consumer is still fed:
//   - the table: each touched stage refolds once (`refoldStageTable`, cause "roster", as the reverse's per-line refold did);
//   - seeding: each touched stage marks its dependent seed proposals stale once (`markDependentSeedProposalsStale`; a COMPLETE
//     stage's confirmed ones too, and the seats that empties join the one DEL, as `onDecided` does);
//   - discipline: one fold of the division's ledger (`refreshDiscipline` reads the division, not the line);
//   - news: each voided line's auto-drafts are stamped stale (`refreshNews`), only when the division auto-posts at all;
//   - player stats: one division refresh (`schedulePlayerStatsRefresh`);
//   - public caches and realtime: one DEL of every line's document plus the division's and the hub's, then a fixture push per
//     line and one division push (`invalidatePublicCache`, the same keys a score drops).
// Auto-advance stays the caller's (the reverse held it back per line before, and asks the stage once at its end).
import { EngineError } from "@seazn/engine/core";
import { divisionScoringClosed, DIVISION_GATE_REASON } from "@/lib/division-phase";
import { withTenant, type Tx } from "@/lib/db";
import { divisionMessages, fixtureMessage, publishFixtureUpdate } from "@/lib/realtime";
import { TABLE_CUT_DRIFT_KINDS } from "@/lib/table-cut-drift";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEventInTx, type CascadeWriter } from "@/server/engine-db/append-event";
import { log } from "@/server/logger";
import { broadcastWithMatchDay } from "./match-day-nudges";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";
import { invalidatePublicCache, refreshDiscipline, refreshNews } from "./scoring";
import { lockSwissBoardAppends, markDependentSeedProposalsStale, refoldStageTable } from "./stages";

type Stage = { id: string; kind: string; status: string };

/** One event to void on one line. */
export interface LineVoid {
  fixtureId: string;
  eventId: string;
}

export interface VoidLinesOptions {
  /** The server writer the voids are recorded under (append-event's W2b write guards read it). */
  writer: CascadeWriter;
  /** More writes for the SAME transaction, after the voids, under the `division:` lock it holds (a reverse's ledger rows). */
  alsoInTx?: (tx: Tx) => Promise<void>;
}

/**
 * Void `voids` (in the order given, per line) in one transaction, then run the after-commit work once. A target already voided
 * when the lock is held is skipped (a retry, or a writer that got there first), so it is safe to run again. Returns the line of
 * each void written, one entry per void.
 *
 * Lock order (`division:` -> stage seats -> `fixture:` -> `division-config:` -> rows): `division:` first, then every line's
 * append lock in sorted id order (`lockSwissBoardAppends`). A void of a line that FEEDS a match would take the stage-seat lock
 * after its fixture lock (`lockStageSeatsForVoid`), against that order — so a feeding line is refused by name, never written:
 * only table lines (a league, a group, a Swiss board), which feed nothing, come here.
 */
export async function voidLineEvents(
  auth: AuthCtx,
  divisionId: string,
  voids: readonly LineVoid[],
  opts: VoidLinesOptions,
): Promise<string[]> {
  if (voids.length === 0 && opts.alsoInTx === undefined) return [];
  const lineIds = [...new Set(voids.map((v) => v.fixtureId))];
  const { written, touched } = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    if (lineIds.length === 0) {
      await opts.alsoInTx!(tx);
      return { written: [] as string[], touched: [] as Stage[] };
    }
    const [division] = await tx<{ status: string }[]>`select status from divisions where id = ${divisionId}`;
    if (division === undefined) throw new Error(`voidLineEvents: division ${divisionId} not found`);
    // The scoring door's division gate (scoring.ts `assertEntitledToScore`), asked once: every line is this division's.
    if (divisionScoringClosed(division.status)) {
      throw new EngineError("WRONG_PHASE", "division has not started — scoring is closed", {
        divisionStatus: division.status,
        reason: DIVISION_GATE_REASON.notStarted,
      });
    }
    const lines = await tx<{ id: string; division_id: string; stage_id: string; feeds: boolean }[]>`
      select id, division_id, stage_id, (winner_to_fixture is not null or loser_to_fixture is not null) as feeds
        from fixtures where id in ${tx(lineIds)}`;
    for (const id of lineIds) {
      const line = lines.find((l) => l.id === id);
      if (line === undefined) throw new Error(`voidLineEvents: line ${id} not found`);
      if (line.division_id !== divisionId) throw new Error(`voidLineEvents: line ${id} is not division ${divisionId}'s`);
      if (line.feeds) throw new Error(`voidLineEvents: line ${id} feeds another match — only table lines are voided here`);
    }
    await lockSwissBoardAppends(tx, lineIds);
    // Under the locks: which targets still stand, and each line's ledger tip.
    const targets = await tx<{ id: string; fixture_id: string; voided: boolean }[]>`
      select e.id, e.fixture_id,
             exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id) as voided
        from score_events e where e.id in ${tx(voids.map((v) => v.eventId))}`;
    const tips = await tx<{ fixture_id: string; seq: number }[]>`
      select fixture_id, max(seq)::int as seq from score_events where fixture_id in ${tx(lineIds)} group by fixture_id`;
    const tip = new Map(tips.map((t) => [t.fixture_id, t.seq]));
    const out: string[] = [];
    for (const id of [...lineIds].sort()) {
      for (const v of voids.filter((x) => x.fixtureId === id)) {
        const target = targets.find((t) => t.id === v.eventId);
        if (target === undefined || target.fixture_id !== id) throw new Error(`voidLineEvents: event ${v.eventId} is not line ${id}'s`);
        if (target.voided) continue;
        const r = await appendEventInTx(tx, auth.orgId, id, tip.get(id) ?? 0, {
          type: "core.void",
          payload: { event_id: v.eventId },
          voids: v.eventId,
          recordedBy: auth.userId,
          writer: opts.writer,
        });
        tip.set(id, r.appended.seq);
        target.voided = true;
        out.push(id);
      }
    }
    if (opts.alsoInTx !== undefined) await opts.alsoInTx(tx);
    const stageIds = [...new Set(lines.filter((l) => out.includes(l.id)).map((l) => l.stage_id))];
    const touched = stageIds.length === 0 ? [] : await tx<Stage[]>`select id, kind, status from stages where id in ${tx(stageIds)}`;
    return { written: out, touched };
  });
  if (written.length > 0) await afterVoids(auth, divisionId, [...new Set(written)], touched);
  return written;
}

/** The after-commit work of a batch, once (see the head of this file). Best-effort like `scoreEvent`'s hooks: the voids already
 *  stand, so a hook that fails is logged by name and never fails the write; the public caches always go last. */
async function afterVoids(auth: AuthCtx, divisionId: string, lines: readonly string[], stages: readonly Stage[]): Promise<void> {
  const emptied: string[] = [];
  try {
    schedulePlayerStatsRefresh(auth.orgId, { divisionId });
    for (const stage of stages) {
      try {
        await refoldStageTable(auth.orgId, { id: stage.id, kind: stage.kind }, "skip");
      } catch (err) {
        log.error({ err, event: "standings_recompute_failed", stageId: stage.id }, "void-lines: a stage's table did not refold after the voids (the voids stand)");
      }
      try {
        // `onDecided`'s two branches: a COMPLETE league or group answers with its confirmed proposals too (W5 T11, X-CUT-4).
        const confirmedToo = TABLE_CUT_DRIFT_KINDS.has(stage.kind) && stage.status === "complete";
        emptied.push(...(await markDependentSeedProposalsStale(auth, stage.id, confirmedToo ? { includeConfirmed: true } : {})));
      } catch (err) {
        log.error({ err, event: "seed_proposals_stale_mark_failed", stageId: stage.id }, "void-lines: dependent seed proposals were not marked stale (the voids stand)");
      }
    }
    try {
      await refreshDiscipline(auth, lines[0]!);
    } catch (err) {
      log.error({ err, event: "discipline_refresh_failed", divisionId }, "void-lines: the discipline fold did not run after the voids (the voids stand)");
    }
    const [div] = await withTenant(auth.orgId, (tx) => tx<{ auto_posts: boolean }[]>`select auto_posts from divisions where id = ${divisionId}`);
    // `refreshNews` stamps an undecided line's auto-drafts stale; it does nothing for a division that does not auto-post.
    if (div?.auto_posts) for (const id of lines) await refreshNews(auth, id);
  } finally {
    await invalidatePublicCache(
      auth.orgId,
      lines[0]!,
      true,
      // Push nudges T0.2/T2.3: every line's push, the division's and the open Match Day codes' go out in ONE broadcast (it was 1 + N POSTs).
      (scope) => {
        broadcastWithMatchDay(scope?.matchDay, [...lines.map((id) => fixtureMessage(id, "event")), ...(scope ? divisionMessages(scope.divisionId, "score") : [])], "score");
      },
      [...lines.slice(1), ...emptied.filter((id) => !lines.includes(id))],
    ).catch((err: unknown) => {
      log.error({ err, divisionId }, "void-lines: public cache invalidation failed (the voids stand)");
      for (const id of lines) void publishFixtureUpdate(id, "event");
    });
  }
}
