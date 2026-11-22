import "server-only";
import { withTenant } from "@/lib/db";
import { log } from "@/server/logger";
import { fixtureBoardRef } from "../fed-seats";
import { completionEngineStatus, rowAwaitsSettle } from "../recorded-abandon";
import { ABANDONED_MATCHES_REASON } from "@/lib/abandoned-matches-refusal";
import { EngineError } from "@seazn/engine/core";
import {
  SETTLED_FIXTURE_STATUSES,
  completeBracketStage,
  isBracketStageComplete,
  isTableStageComplete,
  placementTable,
  type BracketFixture,
  type DivisionEvent,
} from "@seazn/engine/competition";
import { pinStageTableRules } from "../table-rules";
import type { Tx } from "./types";
import { loadStageInputs, toTableStage } from "./stage-inputs";
import { TABLE_KINDS, isBracketKind } from "./kinds";
import { rankWithStoredLots, writeSnapshot } from "./standings";
import { readBracketStage, unbeatenWithNoTitle } from "./bracket-stage";

// Append a division_event under the division lock, assigning a gapless per-
// division seq (doc 07 note 3). Returns the new seq. Callers that treat the
// event as the division watermark also bump divisions.seq (doc 07).
export async function appendDivisionEvent(
  tx: Tx,
  divisionId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}
  `;
  const seq = last + 1;
  await tx`
    insert into division_events (division_id, seq, type, payload)
    values (${divisionId}, ${seq}, ${type}, ${tx.json(payload as never)})
  `;
  return seq;
}

/** W4 T3 (X-CH-1, X-FR-4): what a bracket's deciding final crowned, as it crosses the wire. `finalists` of a vacant title are
 *  the deciding final's two seats (the engine's `{kind:"vacant"}` carries none - C7), `champion` / `winners` are the engine's. */
export type WireTitle =
  | { kind: "champion"; champion: string }
  | { kind: "joint"; winners: [string, string] }
  | { kind: "vacant"; finalists: string[] };

/** The `stage_completed` event as it crosses the wire and is stored. `finalRanks` stays entrant ids in rank order (the
 *  shape every API client, the bench, the matrix and the smoke suites read, so it is never replaced); `places` is the same
 *  list WITH its ranks - a shared place is two entries holding one rank (`[1, 2, 3, 3]`) - and `title` (bracket stages
 *  only) says what the final crowned. The engine's own event carries `FinalPlace[]` since 5.0.0. */
export type WireDivisionEvent =
  | Exclude<DivisionEvent, { type: "stage_completed" }>
  | { type: "stage_completed"; stageId: string; finalRanks: string[]; places: { entrantId: string; rank: number }[]; title?: WireTitle };

export function toWireEvent(ev: DivisionEvent, title?: WireTitle): WireDivisionEvent {
  return ev.type === "stage_completed"
    ? {
        type: "stage_completed",
        stageId: ev.stageId,
        finalRanks: ev.finalRanks.map((p) => p.entrantId),
        places: ev.finalRanks.map((p) => ({ entrantId: p.entrantId, rank: p.rank })),
        ...(title !== undefined ? { title } : {}),
      }
    : ev;
}

/** The wire title of a completed bracket. A vacant title names the two sides of the final both walked over: the latest-round
 *  settled final with `walkedOver: "both"` (the one `decidingFinal` reads), never the engine's shape (C7). */
function wireTitleOf(title: { kind: "champion"; champion: string } | { kind: "joint"; winners: readonly [string, string] } | { kind: "vacant" }, fixtures: readonly BracketFixture[]): WireTitle {
  if (title.kind === "champion") return { kind: "champion", champion: title.champion };
  if (title.kind === "joint") return { kind: "joint", winners: [title.winners[0], title.winners[1]] };
  const finals = fixtures.filter((f) => f.isFinal === true && f.walkedOver === "both").sort((a, b) => b.round - a.round);
  const final = finals[0];
  return { kind: "vacant", finalists: final === undefined ? [] : [final.home, final.away].filter((id): id is string => id !== undefined) };
}

export interface CompleteResult {
  completed: boolean;
  events: WireDivisionEvent[];
  /** W5 T17 (X-BD-4): set ONLY by the call that found the stage already complete (it writes nothing). `completeStage`
   *  (usecases/stages/completion.ts) decides what a repeat answers; `completed` stays true for it here, which is what every
   *  existing reader of this function's answer was written against. */
  already_complete?: true;
}

/**
 * If a stage's completion predicate holds (spec 05 §1), mark it complete, cache
 * its final placement snapshot(s), and record the structural division_events
 * (stage_completed + any rank-lock) — all under the division advisory lock and
 * idempotent (a re-run on an already-complete stage is a no-op).
 *
 * L3/#414 pass 2 — every stage kind now writes a placement snapshot on
 * completion, not just table stages: table kinds (league/group/swiss/
 * americano) snapshot per pool as before; bracket kinds (knockout/
 * double_elim/stepladder/page_playoff) rebuild BracketFixture[] from each
 * fixture's outcome + ext_key and snapshot bracketRanks() wrapped as a single
 * pool (placementTable); ladder snapshots config.ladder_order once every
 * challenge fixture is settled. seedNextStage (usecases/stages/carry-over.ts, pass 3)
 * reads these snapshots to qualify entrants into the next stage.
 */
export async function completeStageIfReady(
  orgId: string,
  stageId: string,
  opts: {
    /** W4 T6 (AN-2): a caller's last word on a BRACKET stage the engine would complete, asked under the division lock in
     *  this transaction before anything is written; a throw refuses the completion and rolls it back. The organiser's
     *  Complete (usecases/stages/completion.ts `completeStage`) refuses a bracket with a line still owed a result here. */
    beforeBracketComplete?: (tx: Tx) => Promise<void>;
  } = {},
): Promise<CompleteResult> {
  return withTenant(orgId, async (tx) => {
    const inputs = await loadStageInputs(tx, stageId);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + inputs.stage.division_id}))`;

    if (inputs.stage.status === "complete") return { completed: true, events: [], already_complete: true };

    const isTable = TABLE_KINDS.has(inputs.kind);
    let events: WireDivisionEvent[] = [];

    if (isTable) {
      // Completion reads no draw: it asks only whether every fixture is settled.
      const tableStage = toTableStage(inputs, new Map());
      if (!isTableStageComplete(tableStage, inputs.tableFixtures)) {
        // X-AB-5 (N2): a held match reads in play above, so it is what keeps the stage open. When it is the ONLY thing
        // left - every other match is settled - say so BY NAME, instead of the soft "not ready" an organiser reads as
        // "play something". Counterfactual: the same stage with the held matches counted settled would complete.
        const held = inputs.fixtures.filter((f) => rowAwaitsSettle(inputs.kind, f));
        if (held.length > 0) {
          const heldIds = new Set(held.map((f) => f.id));
          const onlyHeld = isTableStageComplete(
            tableStage,
            inputs.tableFixtures.map((f) => (heldIds.has(f.id) ? { ...f, status: "void" as const } : f)),
          );
          if (onlyHeld) {
            const abandoned = held.map((f) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round }));
            const named = abandoned.map((m) => `round ${m.round} match ${m.board}`).join(", ");
            throw new EngineError(
              "STAGE_NOT_READY",
              `stage has ${abandoned.length === 1 ? "a match" : "matches"} abandoned without a result - settle ${abandoned.length === 1 ? "it" : "them"} first: ${named}`,
              { stageId, reason: ABANDONED_MATCHES_REASON, abandoned },
            );
          }
        }
        return { completed: false, events: [] };
      }
      // X-TB-4: rank_lock carries the STORED order and drawn_at (PS-5b) — the second, stored pass's events.
      const completed = await rankWithStoredLots(tx, inputs);
      events = completed.events.map((e) => toWireEvent(e));
      for (const pool of completed.tables.pools) {
        await writeSnapshot(tx, stageId, pool.pool || null, pool.rows, inputs.division.seq, "roster");
      }
    } else if (inputs.kind === "ladder") {
      // Jul3/08 §6 — no table/bracket shape of its own: complete once every
      // challenge fixture is settled (SETTLED per the engine status — decided,
      // walkover or void), ranked by the ladder position players fought their
      // way into (usecases/scoring.ts swaps winner/loser on each decided
      // challenge). Zero fixtures ever issued is NOT complete — same as an
      // empty table stage (isTableStageComplete) — nothing has happened yet
      // to rank, and config.ladder_order isn't even set until the first
      // issueChallenge.
      const open = inputs.fixtures.some((f) => {
        // D-G1: an abandoned challenge nobody settled is still open (recorded-abandon.ts), not the void it used to read as.
        const status = completionEngineStatus(inputs.kind, f);
        return status === "scheduled" || status === "in_play";
      });
      if (inputs.fixtures.length === 0 || open) {
        return { completed: false, events: [] };
      }
      const finalRanks = inputs.stage.config?.ladder_order;
      if (finalRanks === undefined || finalRanks.length === 0) {
        // Defensive: issueChallenge always sets ladder_order before its first
        // fixture insert, so settled fixtures with no order is a data bug,
        // not a "not ready yet" — surface it instead of snapshotting nothing.
        throw new EngineError(
          "CONFIG_INVALID",
          `ladder stage ${stageId} has settled fixtures but no ladder_order`,
          { stageId },
        );
      }
      events = [
        { type: "stage_completed", stageId, finalRanks: [...finalRanks], places: finalRanks.map((entrantId, i) => ({ entrantId, rank: i + 1 })) },
      ];
      await writeSnapshot(tx, stageId, null, placementTable(finalRanks).rows, inputs.division.seq, "roster");
    } else if (isBracketKind(inputs.kind)) {
      const { bracketStage, bracketFixtures } = await readBracketStage(tx, inputs, stageId);

      const finals = bracketFixtures.filter((bf) => bf.isFinal === true);
      if (!isBracketStageComplete(bracketStage, bracketFixtures)) {
        // Engine 5.0.0 made completion stricter: EVERY fixture settled, not just the final (X-CH-7). The caller's named
        // refusal for the lines still owed (`beforeBracketComplete`: W4 T6 AN-2) used to run at the point the engine said
        // "complete" - the finals settled - and that point now answers false while a third-place line is open, so the
        // organiser would read a bare {completed:false} for a stage that is only waiting on that line. Run it at the same
        // point as before: every final settled. A final not yet settled keeps the soft answer (C4).
        if (finals.length > 0 && finals.every((bf) => SETTLED_FIXTURE_STATUSES.has(bf.status))) {
          await opts.beforeBracketComplete?.(tx);
        }
        return { completed: false, events: [] };
      }
      await opts.beforeBracketComplete?.(tx);
      // D-G1 guard. bracketRanks orders an entrant who never lost a settled fixture by elimination round −1: LAST.
      // Right for a departed entrant whose line the generator voided (F14, walkoverDepartedQualifiers); wrong for
      // anyone still in the field — an unbeaten field entrant who won no final means the deciding game decided
      // nobody, and the loop G review measured exactly that: an abandoned final ranked its two finalists 3rd and
      // 4th behind the semi-final losers. A recorded abandon now holds the stage open (completionEngineStatus), so
      // that path no longer reaches here. The one PRODUCT path W2a left (loop G re-review, probe P2; ruling D-G3) —
      // a stepladder qualifier departed before the draw, her final voided with her seated in it and the climber
      // seated into the void row — is gone too: W2b's generator stamps her seat dead instead (spec §5.4 corner 3,
      // X-WD-3), and the climber walks over it. Refuse, never snapshot a champion last.
      const unranked = unbeatenWithNoTitle(inputs, bracketFixtures);
      if (unranked.length > 0) {
        // W2b PF-9 / D11 (spec §5.4 corner 3): where the line that decided nobody still SEATS a departed entrant, the
        // refusal is named — which entrant, which match — so the organiser knows the one match to record. (A row
        // written before W2b, or by hand; the generator no longer seats a departed qualifier into an undecided line.)
        const stuck = bracketFixtures.find(
          (bf) =>
            bf.winner === undefined &&
            [bf.home, bf.away].some((id) => id !== undefined && unranked.includes(id)) &&
            [bf.home, bf.away].some((id) => id !== undefined && !inputs.field.has(id)),
        );
        if (stuck) {
          const departedId = [stuck.home, stuck.away].find((id) => id !== undefined && !inputs.field.has(id))!;
          const [named] = await tx<{ display_name: string }[]>`select display_name from entrants where id = ${departedId}`;
          const match = await fixtureBoardRef(tx, stuck.id);
          throw new EngineError(
            "STAGE_SEAT_DEPARTED",
            `bracket stage ${stageId}: fixture ${stuck.id} seats departed entrant ${departedId} and decided nobody — record that match's result`,
            {
              stageId,
              reason: "seat_departed",
              entrantId: departedId,
              fixtureId: stuck.id,
              entrant: named?.display_name ?? null,
              match,
            },
          );
        }
        throw new EngineError(
          "CONFIG_INVALID",
          `bracket stage ${stageId} would rank ${unranked.length} unbeaten entrant(s) still in the field last: its deciding game decided nobody`,
          { stageId, entrants: unranked },
        );
      }
      // completeBracketStage = bracketRanks (stage.ts — already handles
      // losers, third-place, DE-reset and page-playoff with no algorithm
      // change, per the pass-1 regression tests) + the stage_completed event.
      const completed = completeBracketStage(bracketStage, bracketFixtures);
      const wireTitle = wireTitleOf(completed.title, bracketFixtures);
      events = completed.events.map((e) => toWireEvent(e, wireTitle));
      await writeSnapshot(
        tx,
        stageId,
        null,
        placementTable(completed.finalRanks).rows,
        inputs.division.seq,
        "roster",
      );
    } else {
      // Unreachable: TABLE_KINDS ∪ {"ladder"} ∪ BRACKET_KINDS covers every
      // StageKind value (see the BRACKET_KINDS comment above). Guards a
      // future StageKind addition that forgets to extend this file, instead
      // of silently falling through with no snapshot written.
      throw new EngineError(
        "CONFIG_INVALID",
        `stage ${stageId} kind "${inputs.kind}" has no completion handler`,
        { stageId, kind: inputs.kind },
      );
    }

    // Persist the structural events, then mark the stage complete and advance
    // the division watermark to the last division_event seq.
    let lastSeq = inputs.division.seq;
    for (const ev of events) {
      lastSeq = await appendDivisionEvent(tx, inputs.stage.division_id, ev.type, ev);
    }
    // W2d T9 fix I1: a stage leaves pending by more doors than its two activation writers — a ladder challenge or an
    // ad-hoc fixture played on a stage nobody generated completes it straight from pending. Pin it before the status
    // write (idempotent: a stage pinned at activation keeps its first pin), so no started stage is ever unpinned.
    await pinStageTableRules(tx, stageId);
    await tx`update stages set status = 'complete' where id = ${stageId}`;
    await tx`update divisions set seq = ${lastSeq} where id = ${inputs.stage.division_id}`;
    log.info({ event: "stage_completed", stageId, kind: inputs.kind }, "stage_completed");

    return { completed: true, events };
  });
}
