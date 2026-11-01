import "server-only";
// W3 Task 9 — "Add late player" after pairing (spec 2026-10-31-format-matrix-w3-swiss-design.md §4, ruling 250; rules
// X-SW-12, X-SW-13, X-SW-14). Every arrival into a division whose Swiss is running comes through `admitSwissLateEntrant`,
// in the arriving write's own transaction: the organiser's Add (`createEntrants`), a confirmed registration and a
// waitlist promotion (`materialise`), an import (`executePlan`) and a reinstatement (`patchEntrant`). Which case it
// takes is the pure decision (`lib/swiss-late-entry.ts`); this file reads the stage, answers the decision's questions
// (what started, can the newcomer play the bye holder) and applies the answer:
//
//   (a) re-pair the unstarted round with the newcomer: its seats are cleared and the round is paired again through
//       `swissGen`, the one Pair. Every surviving row keeps its id, time and court; a board the odd→even field needs is
//       minted and placed in the round's next free slot. A deviation from FIDE C.04.2 4.4, by ruling 250.
//   (b) the newcomer plays the round's bye holder: the bye row goes, one board is added beside the round's boards, seated
//       with the engine's own colours. Nothing else is written.
//   (c) the newcomer's first round is the next one; nothing else is written.
//
// Each admission writes the entrant's first round (V484, scoped to the stage by V485) and one `swiss_late_entry` ledger
// row. An organiser's row is an Undo barrier (history.ts `isUndoBarrier`, design §10.8); an automatic one is not. A board
// (a)/(b) adds after a Pair is in no Pair's `seated_fixture_ids`, which is safe because that barrier refuses every Undo
// that would invert that Pair (or a Redo past it) — no step can clear the Pair's seats and strand the new board.
//
// An AUTOMATIC arrival never throws a refusal (X-SW-13, Review Focus 4): a payment that has already moved cannot be
// un-taken. With no round left, or the Swiss over, it is recorded as joining after the last round (`rounds + 1`).
import type postgres from "postgres";
import { pairKey, pairRound } from "@seazn/engine/scheduling";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ScheduleConfig, type LateEntryResult } from "@/server/api-v1/schemas";
import { decideSwissLateEntry, type LateEntryBoard } from "@/lib/swiss-late-entry";
import { isRootSwissStage } from "@/lib/open-entry-stages";
import { isSwissByeShellExtKey, mintSwissBoardExtKeys } from "@/lib/swiss-shell";
import { SWISS_PAIRINGS, type SwissPairingMode } from "@/lib/swiss-pairing";
import { resolveModule } from "@/server/engine-db";
import { forfeitPlayedFacts } from "@/server/engine-db/forfeit-played";
import { withTenant } from "@/lib/db";
import { swissRefusal } from "./swiss-refusal";
import { swissAddRoundState, swissBoardStartedSql } from "./swiss-rounds-admin";
import { OCCUPYING, afterScheduleWrite, courtVenueIds, divisionLockState } from "./schedule";
import {
  DECIDED,
  buildSwissHistory,
  clearSwissFixtureSeats,
  divisionHasStarted,
  lockSwissBoardAppends,
  refoldStageTable,
  swissActiveEntrants,
  swissGen,
  type SwissExistingFixture,
} from "./stages";

type Tx = postgres.TransactionSql;

export type { LateEntryResult };

/** Who brought the entrant in. Only `"organiser"` is an "Add late player" (an Undo barrier, and the only source that
 *  may re-pair or take the bye); every other source is an automatic arrival and takes case (c). */
export type LateEntrySource = "organiser" | "registration" | "waitlist" | "import" | "reinstate";

interface SwissStage {
  id: string;
  seq: number;
  status: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/** The stages this file admits into: ROOT Swiss stages (`isRootSwissStage`, lib/open-entry-stages.ts — the one
 *  predicate the Start lock, this admission and the desk's client mirror all read). A Swiss fed by an earlier stage
 *  has a fixed qualified field, so nobody joins it late. The first one still running comes first (else the first,
 *  which is over). */
async function rootSwissStages(tx: Tx, divisionId: string): Promise<SwissStage[]> {
  const rows = await tx<SwissStage[]>`
    select id, seq, status, kind, progression, config from stages
    where division_id = ${divisionId} and kind = 'swiss'
    order by (status = 'complete'), seq`;
  return rows.filter(isRootSwissStage);
}

/** Whether the division holds a Swiss stage a late player can join — the Start lock's exemption (`createEntrants`). */
export async function hasRootSwissStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootSwissStages(tx, divisionId)).length > 0;
}

type StageRow = SwissExistingFixture & { started?: boolean };

const STAGE_ROW_COLS = (tx: Tx) => tx`
  f.id, f.ext_key, f.round_no, f.seq_in_round, f.status, f.home_entrant_id, f.away_entrant_id, f.outcome,
  f.scheduled_at, f.court_id, f.venue_id, f.schedule_locked`;

async function stageRows(tx: Tx, stageId: string): Promise<SwissExistingFixture[]> {
  return tx<SwissExistingFixture[]>`
    select ${STAGE_ROW_COLS(tx)} from fixtures f where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
}

/** Spec §4 "started", read on each row through THE predicate (`swissBoardStartedSql`, swiss-rounds-admin.ts — W3 T12
 *  moved it there whole so the rounds lock reads the same one): a score event, live, or decided (`fixtureHasResultSql`);
 *  (Review Focus 1) a board an online game stands behind (any `fixture_external_play` row); and decided other than the
 *  bye. A device link is NOT a start (ruling C5 re-ruled after the T9 review, I1): a link carries no opened or claimed
 *  marker, and printing a day's scorer sheets mints a never-expiring link for every printable board — counting one would
 *  switch case (a) off for the whole printed day. A link that was used has written a score event, which is a start
 *  already. */
async function stageRowsWithStarts(tx: Tx, stageId: string): Promise<StageRow[]> {
  return tx<StageRow[]>`
    select ${STAGE_ROW_COLS(tx)}, ${swissBoardStartedSql(tx, "f")} as started
    from fixtures f where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
}

const seatedRow = (f: SwissExistingFixture) =>
  f.home_entrant_id !== null && (isSwissByeShellExtKey(f.ext_key) || f.away_entrant_id !== null);

function toBoard(f: StageRow): LateEntryBoard {
  const isBye = isSwissByeShellExtKey(f.ext_key);
  return {
    id: f.id,
    round: f.round_no,
    seq: f.seq_in_round,
    extKey: f.ext_key,
    home: f.home_entrant_id,
    away: f.away_entrant_id,
    // Spec §4: "decided other than the bye" is started too — read by `swissBoardStartedSql` with the rest (W3 T12: one
    // authority, no second arm here).
    started: f.started === true,
    decided: DECIDED.has(f.status),
    isBye,
  };
}

/** Each seated entrant's place in a round (T9 review m2): the board row (it carries the time and the court), the opponent
 *  and the side (home or away — in chess, the colour). A player whose place differs after a re-pair is a changed one, even
 *  when the opponent is the same. A bye is just "bye": it holds no slot, so the row it sits in means nothing. */
function places(rows: readonly SwissExistingFixture[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of rows) {
    if (isSwissByeShellExtKey(f.ext_key)) {
      if (f.home_entrant_id !== null) out.set(f.home_entrant_id, "bye");
      continue;
    }
    if (f.home_entrant_id !== null && f.away_entrant_id !== null) {
      out.set(f.home_entrant_id, `${f.id}|${f.away_entrant_id}|home`);
      out.set(f.away_entrant_id, `${f.id}|${f.home_entrant_id}|away`);
    }
  }
  return out;
}

/** T9 review m1: the round-1 pairing override round 1's newest pairing row recorded — its Pair (`fixtures_generated`, a
 *  Redo's step row included: it copies the audit) or an earlier late entry that re-paired round 1 (case (a), which records
 *  the same `pairing`/`override` pair). Undefined: round 1 was paired in its own mode. Only a recognised mode is handed
 *  on — anything else is a row this code never wrote (history.ts `recordedPairingOverride`, the Redo's sibling). */
async function roundOnePairingOverride(tx: Tx, divisionId: string, stageId: string): Promise<SwissPairingMode | undefined> {
  const [row] = await tx<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
     where division_id = ${divisionId} and payload->>'stage_id' = ${stageId} and payload->>'round' = '1'
       and (type = 'fixtures_generated' or (type = 'swiss_late_entry' and payload->>'case' = 'a'))
     order by seq desc limit 1`;
  if (row?.payload.override !== true) return undefined;
  return SWISS_PAIRINGS.find((m) => m === row.payload.pairing);
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * The first `(time, court)` a board added to `round` can take: the round's own distinct kick-off times (earliest first)
 * × the division's schedule-settings courts (in their configured order), the first pair no occupying fixture of ANY
 * division holds. Null when the round has no time, the division names no court, every pair is taken, or the division's
 * timetable is frozen — the new board is then left unscheduled for the organiser to place.
 */
export async function nextFreeRoundSlot(
  tx: Tx,
  divisionId: string,
  round: number,
  boardRows: readonly Pick<SwissExistingFixture, "round_no" | "scheduled_at" | "ext_key">[],
): Promise<{ scheduled_at: string; court_id: string } | null> {
  const times = [
    ...new Set(
      boardRows
        .filter((f) => f.round_no === round && !isSwissByeShellExtKey(f.ext_key) && f.scheduled_at !== null)
        .map((f) => iso(f.scheduled_at!)),
    ),
  ].sort();
  if (times.length === 0) return null;
  if ((await divisionLockState(tx, divisionId)).frozen) return null;
  const [settings] = await tx<{ config: unknown }[]>`select config from schedule_settings where division_id = ${divisionId}`;
  const parsed = ScheduleConfig.safeParse(settings?.config ?? {});
  const courts = parsed.success ? parsed.data.courts : [];
  if (courts.length === 0) return null;
  const taken = await tx<{ scheduled_at: Date; court_id: string }[]>`
    select scheduled_at, court_id from fixtures
    where court_id in ${tx(courts)} and scheduled_at in ${tx(times)} and status in ${tx(OCCUPYING)}`;
  const held = new Set(taken.map((t) => `${iso(t.scheduled_at)}|${t.court_id}`));
  for (const t of times) {
    for (const c of courts) if (!held.has(`${t}|${c}`)) return { scheduled_at: t, court_id: c };
  }
  return null;
}

async function appendLateEntryRow(
  tx: Tx,
  divisionId: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  // Under the `division:` lock the caller took. The division's token moves with the row; the watermark is NOT touched
  // (T5 carry): a barrier row that reset it would make the next Redo answer NOTHING_TO_REDO instead of the barrier's
  // named refusal.
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, 'swiss_late_entry', ${tx.json(payload as never)}, ${actorId})`;
  await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
}

async function stampFirstRound(tx: Tx, entrantId: string, stageId: string, round: number): Promise<void> {
  await tx`
    update entrants set swiss_first_round = ${round}, swiss_first_round_stage_id = ${stageId}
    where id = ${entrantId}`;
}

/**
 * Admit `entrantId` (already inserted, or just reinstated) into the division's running Swiss. Null when there is
 * nothing to do: the division has not started (C17 — before Start the pre-Start reshape keeps the job), it has no root
 * Swiss stage, or this entrant was admitted already (a webhook retry, a double submit). An organiser's refusal throws
 * (`SWISS_NO_ROUND_LEFT` 409 with `canAddRound`, `SWISS_OVER` 422) and rolls the caller's whole write back; an automatic
 * arrival never throws one.
 */
export async function admitSwissLateEntrant(
  tx: Tx,
  auth: AuthCtx | null,
  divisionId: string,
  entrantId: string,
  source: LateEntrySource,
): Promise<LateEntryResult | null> {
  // T9 review m7: most arrivals land in a division with no running Swiss (setup, or another format) and must not queue on
  // its lock, so both questions are read BEFORE it. Started is one-way (no write moves a division back from active or
  // completed), so a "started" read here stays true under the lock; the stage itself is re-read under it below. A Start
  // racing the unlocked read is benign: the read says "not started" only while Start has not committed, and the entrant
  // then stands exactly as one added just before Start (C17: unstamped, so in round 1's field) — the state a locked read
  // gives too, when the arrival takes the lock first.
  if (!(await hasRootSwissStage(tx, divisionId)) || !(await divisionHasStarted(tx, divisionId))) return null;
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  // A division holding two root Swiss stages admits into the first one still running (else the first, which is over).
  const [stage] = await rootSwissStages(tx, divisionId);
  if (!stage) return null;
  const automatic = source !== "organiser";
  const actorId = auth?.userId ?? null;

  const rounds = stage.config.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new EngineError("CONFIG_INVALID", "swiss stage requires config.rounds >= 1", { stageId: stage.id });
  }

  // The latest seated round's boards take the scoring append lock BEFORE "started" is read (the one lock order:
  // `division:` → `fixture:`, stages.ts `lockSwissBoardAppends`): a first event in flight either commits first and is
  // seen below, or waits and finds the round already re-paired.
  // An automatic arrival never reads "started" (it takes (c) whatever the round), so it waits on no scorer.
  const plain = await stageRows(tx, stage.id);
  const seatedRounds = plain.filter(seatedRow).map((f) => f.round_no);
  const latest = seatedRounds.length === 0 ? null : Math.max(...seatedRounds);
  if (latest !== null && !automatic) {
    await lockSwissBoardAppends(tx, plain.filter((f) => f.round_no === latest).map((f) => f.id));
  }
  const rows = await stageRowsWithStarts(tx, stage.id);

  // Over: the stage is complete, or a later stage of the division (its knockout) has a started fixture. W3 T12 (ruling
  // C11): read off THE "Add a round" predicate, which also answers the refusal's `canAddRound` below — for the field Add a
  // round will see, which never holds this arrival (a refusal rolls its insert back).
  const addRound = await swissAddRoundState(tx, { ...stage, division_id: divisionId }, { excluding: entrantId });
  const swissOver = addRound.over;

  // Admitted already: this stage stamped the entrant, or wrote a ledger row for them. A reinstatement is a NEW arrival
  // (the Reinstate ruling): whatever an earlier admission recorded, the rounds they were away for are missed.
  let alreadyAdmitted = false;
  if (source !== "reinstate") {
    const [stamped] = await tx`
      select 1 from entrants
      where id = ${entrantId} and swiss_first_round is not null and swiss_first_round_stage_id = ${stage.id}`;
    const [logged] = await tx`
      select 1 from division_events
      where division_id = ${divisionId} and type = 'swiss_late_entry'
        and payload->>'stage_id' = ${stage.id} and payload->>'entrant_id' = ${entrantId}
      limit 1`;
    alreadyAdmitted = stamped !== undefined || logged !== undefined;
  }

  // Case (b)'s question, asked only by the decision's rule 6 (never for an automatic arrival): the two have not met
  // (W3 T7's `played`), and the engine's own colour rules accept the pair — the PUBLIC `pairRound` over the two, its
  // private `colourLegal`/`assignColours` reached the one way they can be without an engine change. Legal iff it returns
  // exactly one pairing, and that pairing IS the board (home = White); non-chess puts the upper standing, the holder,
  // at home.
  // The reads it needs are made up front (async); the judgement itself runs inside the callback, so an arrival the
  // decision settles earlier never builds the history at all.
  const bye = latest === null ? undefined : rows.find((f) => f.round_no === latest && isSwissByeShellExtKey(f.ext_key));
  let byePairing: { home: string; away: string } | null = null;
  let canPlayBye: (holder: string) => boolean = () => false;
  if (!automatic && latest !== null && bye?.home_entrant_id) {
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    const sportModule = resolveModule(division!.sport_key, division!.module_version);
    // W3 T7: every two-seated forfeit's "was anything played", read in THIS transaction — `buildSwissHistory` refuses a
    // forfeit it has no fact for, never guesses.
    const facts = await forfeitPlayedFacts(
      tx,
      rows.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null),
      sportModule,
    );
    // The field as round `latest` would hold it with the newcomer in it.
    const field = (await swissActiveEntrants(tx, divisionId, stage.id)).map((e) =>
      e.id === entrantId ? { ...e, swiss_first_round: latest } : e,
    );
    const active = new Set(field.map((e) => e.id));
    canPlayBye = (holder) => {
      // T9 review I2: a holder who has LEFT is no opponent. A withdrawal after the round was paired keeps the bye seated
      // and its point awarded (`forfeited` is a played status for the cascade, lib/table-withdrawal.ts), so the bye row is
      // still there — but taking it would delete a departed player's point and seat a board against someone gone home.
      // Case (c) instead: nothing moves.
      if (!active.has(holder)) return false;
      const hist = buildSwissHistory(rows, field, facts);
      if (hist.played.has(pairKey(holder, entrantId))) return false;
      const paired = pairRound(
        [
          { entrantId: holder, score: hist.score.get(holder) ?? 0, rank: 1 },
          { entrantId, score: 0, rank: 2 },
        ],
        { played: hist.played, colours: hist.colours, byes: hist.byes },
        { chess: stage.config.chess === true },
      );
      if (paired.pairings.length !== 1) return false;
      byePairing = paired.pairings[0]!;
      return true;
    };
  }

  const decision = decideSwissLateEntry({
    boards: rows.map(toBoard),
    rounds,
    swissOver,
    automatic,
    alreadyAdmitted,
    canPlayBye,
    newcomer: entrantId,
  });

  const recordC = async (round: number): Promise<LateEntryResult> => {
    await stampFirstRound(tx, entrantId, stage.id, round);
    await appendLateEntryRow(tx, divisionId, { stage_id: stage.id, entrant_id: entrantId, case: "c", round, source }, actorId);
    return { entrant_id: entrantId, stage_id: stage.id, case: "c", round };
  };

  switch (decision.kind) {
    case "noop":
      return null;
    case "refused":
      if (!automatic) throw swissRefusal(decision.code, { canAddRound: addRound.canAddRound });
      // X-SW-13 / Review Focus 4: the arrival stands, recorded as joining after the last round (the desk lists it so;
      // an added round seats it).
      return recordC(rounds + 1);
    case "next_round":
      return recordC(decision.firstRound);
    case "repair":
      return repairRound(tx, { divisionId, stage, entrantId, round: decision.round, rows, source, actorId });
    case "take_bye": {
      // The decision returns take_bye only through canPlayBye, which is true only with a pairing for this holder.
      const pairing = byePairing as { home: string; away: string } | null;
      if (pairing === null || bye === undefined) {
        throw new EngineError("CONFIG_INVALID", "swiss late entry: the bye case has no pairing", { stageId: stage.id });
      }
      return takeBye(tx, { divisionId, stage, entrantId, round: decision.round, rows, bye, pairing, source, actorId });
    }
  }
}

interface ApplyCtx {
  divisionId: string;
  stage: SwissStage;
  entrantId: string;
  round: number;
  rows: readonly SwissExistingFixture[];
  source: LateEntrySource;
  actorId: string | null;
}

/** Case (a): clear the round's seats, then pair it again with the newcomer in its field — `swissGen`, the one Pair. */
async function repairRound(tx: Tx, ctx: ApplyCtx): Promise<LateEntryResult> {
  const { divisionId, stage, entrantId, round } = ctx;
  const inRound = ctx.rows.filter((f) => f.round_no === round);
  const before = places(inRound);
  const beforeIds = new Set(inRound.map((f) => f.id));
  // The append locks are held (taken over the latest seated round before "started" was read). The clear itself refuses
  // a board a live online game stands behind (409 ONLINE_GAME_EXISTS) — "started" already sent any board with a bridge
  // row to (b)/(c), so that is a second guard, never the decider.
  await clearSwissFixtureSeats(tx, [...beforeIds]);
  await stampFirstRound(tx, entrantId, stage.id, round);
  const existing = await stageRows(tx, stage.id);
  const active = await swissActiveEntrants(tx, divisionId, stage.id);
  // T9 review m1 (the sibling of the T8 review's P1): a re-pair of round 1 replays the mode the organiser paired it with.
  const override = round === 1 ? await roundOnePairingOverride(tx, divisionId, stage.id) : undefined;
  const gen = await swissGen(tx, stage.id, divisionId, stage.config, active, existing, override);
  if (gen.round !== round) {
    // swissGen pairs the lowest unseated round; this round is the latest seated one and every earlier round stays
    // seated, so it is this one. Anything else is a broken premise — refused before the commit, by name.
    throw new EngineError("CONFIG_INVALID", "swiss late entry: the re-pair reached another round", {
      stageId: stage.id,
      round,
      paired: gen.round,
    });
  }
  const after = (await stageRows(tx, stage.id)).filter((f) => f.round_no === round);
  // A board the odd→even field needed (`reconcileSwissRoundShells` mints it) takes the round's next free slot.
  const minted = after.filter((f) => !beforeIds.has(f.id) && !isSwissByeShellExtKey(f.ext_key));
  let newBoard: LateEntryResult["new_board"];
  for (const f of minted) {
    const slot = await nextFreeRoundSlot(tx, divisionId, round, after);
    if (slot) await placeBoard(tx, f.id, slot);
    newBoard = { fixture_id: f.id, scheduled: slot !== null };
  }
  const now = places(after);
  const changed = [...before.keys()].filter((id) => id !== entrantId && now.get(id) !== before.get(id)).sort();
  await appendLateEntryRow(
    tx,
    divisionId,
    {
      stage_id: stage.id,
      entrant_id: entrantId,
      case: "a",
      round,
      source: ctx.source,
      changed_entrant_ids: changed,
      seated_fixture_ids: gen.seatedIds,
      // The Pair's own audit pair (stages.ts `swissAudit`): a later re-pair of round 1 replays an override from here.
      ...(gen.pairing !== null ? { pairing: gen.pairing, override: override !== undefined && override !== gen.defaultPairing } : {}),
      // A re-pair of round 1 re-draws it with the newcomer in the field (T8 review n1): later rounds read this order.
      ...(gen.drawSeed !== null ? { draw_seed: gen.drawSeed } : {}),
      ...(gen.drawOrder !== null ? { draw_order: gen.drawOrder } : {}),
      ...(gen.colourLot !== null ? { colour_lot: gen.colourLot } : {}),
    },
    ctx.actorId,
  );
  return {
    entrant_id: entrantId,
    stage_id: stage.id,
    case: "a",
    round,
    repaired: { changed_entrant_ids: changed },
    ...(newBoard ? { new_board: newBoard } : {}),
  };
}

/** A slot the system chose is an `auto` placement (T9 review m9; V214 `schedule_source`), as Start's sweep writes it —
 *  never `manual`, which is the organiser's hand. */
async function placeBoard(tx: Tx, fixtureId: string, slot: { scheduled_at: string; court_id: string }): Promise<void> {
  const venues = await courtVenueIds(tx);
  await tx`
    update fixtures set scheduled_at = ${slot.scheduled_at}, court_id = ${slot.court_id},
                        venue_id = ${venues.get(slot.court_id) ?? null}, schedule_source = 'auto'
    where id = ${fixtureId}`;
}

/** Case (b): the bye row goes; one board joins the round, seated as the engine paired the two. Nothing else moves. */
async function takeBye(
  tx: Tx,
  ctx: ApplyCtx & { bye: SwissExistingFixture; pairing: { home: string; away: string } },
): Promise<LateEntryResult> {
  const { divisionId, stage, entrantId, round, bye, pairing } = ctx;
  const inRound = ctx.rows.filter((f) => f.round_no === round);
  const boards = inRound.filter((f) => !isSwissByeShellExtKey(f.ext_key));
  // A bye holds no evidence (W3 T3: its frozen cfg is exempt), so it goes like any shell.
  await tx`delete from fixtures where id = ${bye.id}`;
  // m2 / R2: the key is the round's largest board index + 1 (`mintSwissBoardExtKeys`) — never `boards + 1`, which a
  // re-pack's gap (b1, b2, b4) would collide with under `fixtures_stage_ext_key_idx`.
  const [extKey] = mintSwissBoardExtKeys(round, inRound.map((f) => f.ext_key), 1);
  const seq = Math.max(0, ...boards.map((f) => f.seq_in_round)) + 1;
  const slot = await nextFreeRoundSlot(tx, divisionId, round, boards);
  const venues = slot ? await courtVenueIds(tx) : null;
  const [row] = await tx<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, ext_key, home_entrant_id, away_entrant_id,
                          status, outcome, scheduled_at, court_id, venue_id, schedule_source)
    values (${stage.id}, ${divisionId}, ${round}, ${seq}, ${extKey!}, ${pairing.home}, ${pairing.away},
            'scheduled', null, ${slot?.scheduled_at ?? null}, ${slot?.court_id ?? null},
            ${slot ? (venues!.get(slot.court_id) ?? null) : null}, ${slot ? "auto" : "none"})
    returning id`;
  await stampFirstRound(tx, entrantId, stage.id, round);
  const holder = bye.home_entrant_id!;
  await appendLateEntryRow(
    tx,
    divisionId,
    {
      stage_id: stage.id,
      entrant_id: entrantId,
      case: "b",
      round,
      source: ctx.source,
      bye_holder_id: holder,
      fixture_id: row!.id,
      removed_bye_fixture_id: bye.id,
    },
    ctx.actorId,
  );
  return {
    entrant_id: entrantId,
    stage_id: stage.id,
    case: "b",
    round,
    bye_holder_id: holder,
    new_board: { fixture_id: row!.id, scheduled: slot !== null },
  };
}

/**
 * After the arriving write COMMITS (the refold and the push open their own transactions and take the division lock): a
 * re-pair (a) or a taken bye (b) moved seats, so the division's public pages and the moved round's fixtures are told,
 * then the stage's table is refolded (a bye award is gone, or re-placed). Best-effort past the commit: the late entry
 * stands whatever a refold says, as a Generate's does.
 */
export async function afterSwissLateEntry(
  orgId: string,
  divisionId: string,
  competitionId: string,
  results: readonly (LateEntryResult | null | undefined)[],
): Promise<void> {
  const moved = results.filter((r): r is LateEntryResult => r != null && (r.case === "a" || r.case === "b"));
  if (moved.length === 0) return;
  const rounds = [...new Map(moved.map((r) => [`${r.stage_id}|${r.round}`, r])).values()];
  const fixtureIds = await withTenant(orgId, async (tx) => {
    const ids: string[] = [];
    for (const r of rounds) {
      const rows = await tx<{ id: string }[]>`select id from fixtures where stage_id = ${r.stage_id} and round_no = ${r.round}`;
      ids.push(...rows.map((f) => f.id));
    }
    return ids;
  });
  afterScheduleWrite(divisionId, competitionId, "schedule", fixtureIds);
  // T9 review m4: the one post-write refold (`refoldStageTable`, Pair next's and a roster delete's), best-effort and logged
  // inside. `"drop"`: a re-pair can take away the round's only result — the bye award — and the table it leaves must not
  // outlive it. (`afterScheduleWrite` above already revalidated the division's public pages.)
  for (const stageId of new Set(moved.map((r) => r.stage_id))) {
    await refoldStageTable(orgId, { id: stageId, kind: "swiss" }, "drop");
  }
}
