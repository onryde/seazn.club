import "server-only";
// Write the result (chess in-page board design §3.6, Task 12). A finished
// Lichess game becomes our fixture's result — a `boardgame.result` on the
// ledger, or a hold for the organiser — written under ORGANISER authority
// (`mintOrgOwnerAuth`): W2a's gate makes settle/forfeit/abandon
// organiser-only, and an owner passes it before and after it lands.
//
// T12 writes the ledger and, for a hold, the bridge row's
// `needs_organiser` + `needs_reason`. It NEVER writes the bridge's
// `finished` / `finished_at`: T11's reconcile calls this, then marks the
// bridge itself.
//
// A drawn game in a bracket (W2a, main V432; controller ruling R2, fix round
// 1) is written THROUGH the engine like any result, and the engine holds it:
// chess's bracket decider opens the tie-break (fixture in_play, awaiting its
// decider) — ship 1 cannot create a tie-break Lichess game, so T12 holds THAT
// for the organiser (tiebreak_owed); a fixture frozen without the decider
// folds to needs_decision, W2a's own hold. T12 never decides it either way.
//
// Mapping sources, in precedence order: spec §3.6's table; the controller's
// addendum 1 (cheat / variantEnd / unrecognised → organiser,
// insufficientMaterialClaim → draw); Lichess's own source where both are
// silent — lila 3747530a1 (modules/round/src/main/Finisher.scala,
// RoundAsyncActor.scala, Drawer.scala) and scalachess 2ab0a40 (Status.scala),
// read 2026-10-10, NOT measured.
import { createHash } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { boardgame, type BoardgameMethod } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { GameSnapshot, NeedsReason } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "./auth";
import { effectiveBridge, loadOnlinePlayFixture } from "./guard";
import { isPlayableFixtureStatus } from "./preflight";

/** The reasons a CALLER may hold a fixture for. Each is a V433/V435
 *  `needs_reason` (the `satisfies` keeps them inside NEEDS_REASONS); no
 *  no-show is among them — spec §3.6: a revoked token is not a no-show.
 *  `tiebreak_owed` is not a caller's to assert (R2): only a written draw
 *  whose fold then awaits its decider produces it. */
export const HOLD_REASONS = [
  "token_revoked",
  "provider_error",
  "double_walkover_blocked",
] as const satisfies readonly NeedsReason[];
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Holds only a snapshot produces: Lichess ruled a fair-play violation; a
 *  written bracket draw whose tie-break the engine opened. */
type SnapshotOnlyReason = "fair_play" | "tiebreak_owed";

export type ResultWrite =
  | { wrote: "decided" | "draw" | "aborted" | "forfeit" | "none" }
  | { wrote: "needs_organiser"; reason: HoldReason | SnapshotOnlyReason };

type Colour = "white" | "black";
type Disposition =
  | { kind: "none" }
  | { kind: "result"; winner: Colour | null; method: BoardgameMethod | undefined }
  | { kind: "hold"; reason: "aborted" | HoldReason | SnapshotOnlyReason; detail: string };

const NONE: ResultWrite = { wrote: "none" };

/** `AppendEventRequest.idempotency_key` is `max(200)` (api-v1/schemas.ts). */
const KEY_MAX = 200;

/** Deterministic, so a replay costs one ledger read and writes nothing: the
 *  `(fixture_id, idempotency_key)` unique index (V413) is the durable latch.
 *  The format is T11's brief's, `extplay:<fixtureId>:<gameId>:<status>`; an
 *  unrecognised status keys on Lichess's own word. A key over the cap (only a
 *  pathological game id) hashes its tail, staying deterministic. */
export function resultIdempotencyKey(fixtureId: string, snapshot: GameSnapshot): string {
  const status = snapshot.status === "unrecognised" ? `unrecognised=${snapshot.rawStatus}` : snapshot.status;
  const key = `extplay:${fixtureId}:${snapshot.gameId}:${status}`;
  if (key.length <= KEY_MAX) return key;
  const digest = createHash("sha256").update(JSON.stringify([snapshot.gameId, status])).digest("hex");
  return `extplay:${fixtureId}:sha256:${digest}`;
}

/** What the organiser reads in `last_error`. Built from the snapshot's
 *  status/winner/id only — never a token, never a body. */
function describeSnapshot(s: GameSnapshot): string {
  const status = s.status === "unrecognised" ? `unrecognised status "${s.rawStatus.slice(0, 64)}"` : `status ${s.status}`;
  return `lichess game ${s.gameId.slice(0, 32)}: ${status}, winner ${s.winner ?? "none"}`;
}

function organiser(s: GameSnapshot, why: string): Disposition {
  return { kind: "hold", reason: "provider_error", detail: `${describeSnapshot(s)} — ${why}` };
}

const result = (winner: Colour | null, method: BoardgameMethod | undefined): Disposition => ({ kind: "result", winner, method });

/** Pure: what a snapshot asks us to do — THE status rulebook (the legacy
 *  map-result.ts table and its unused mapper were deleted in T12 fix round 1,
 *  M6: one source of truth). Exhaustive over the status union, so a status
 *  added to LICHESS_STATUSES does not compile until it is placed. Methods
 *  are the engine's `BoardgameMethod` names for what Lichess's status says
 *  happened; spec §3.6 names none. */
function dispositionOf(s: GameSnapshot): Disposition {
  switch (s.status) {
    // Spec §3.5: only a status other than created/started is terminal.
    case "created":
    case "started":
      return { kind: "none" };
    // §3.6 + M9: no result — an early resign lands here with no winner.
    // Finisher.noStart: a game that is not mandatory is ABORTED when nobody
    // makes the first move; NoStart is a mandatory game's form of the same
    // fact. Either way nobody played: the same hold, never a winner.
    case "aborted":
    case "noStart":
      return { kind: "hold", reason: "aborted", detail: `${describeSnapshot(s)} — no game was played` };
    // §3.6 "decided result, winner as reported". Mate and resign always
    // carry one (scalachess finishedWithWinner; Finisher) — a winnerless one
    // is not guessed.
    case "mate":
    case "resign":
      return s.winner
        ? result(s.winner, s.status === "mate" ? "checkmate" : "resign")
        : organiser(s, "a decisive status with no winner");
    // Finisher.outOfTime withholds the winner exactly when the side left on
    // the board has insufficient mating material: a DRAW, FIDE 6.9, which
    // the engine calls `insufficient`. A timeout is a WIN otherwise, never a
    // forfeit (§3.6: only a no-show is a forfeit).
    case "outoftime":
      return s.winner ? result(s.winner, "time") : result(null, "insufficient");
    // RoundAsyncActor ResignForce / DrawForce → Finisher.rageQuit(None): the
    // opponent left and the remaining player was given (or chose) a draw.
    // Lichess records no reason, so we record no method.
    case "timeout":
      return s.winner ? result(s.winner, "time") : result(null, undefined);
    // §3.6 draws; addendum 1: insufficientMaterialClaim ("the side that
    // cannot lose claims a draw", Status.scala) is a draw. None of the three
    // carries a winner at Lichess, so one that does is held.
    // `draw` records NO method (controller ruling, fix round 1): spec §3.6
    // names none, and Lichess's `draw` covers agreement, a threefold claim,
    // scalachess autoDraw (insufficient material, fifty moves, fivefold) and
    // a flag with a draw offer pending — no one method is true of them all.
    case "draw":
    case "stalemate":
    case "insufficientMaterialClaim": {
      if (s.winner) return organiser(s, "a drawn status with a winner");
      const method: Record<typeof s.status, BoardgameMethod | undefined> = {
        draw: undefined,
        stalemate: "stalemate",
        insufficientMaterialClaim: "insufficient",
      };
      return result(null, method[s.status]);
    }
    // Addendum 1: cheat → the organiser's FAIR-PLAY queue, under its own
    // reason (fix round 1, I2): Lichess has already ruled, and the winner it
    // reports is the innocent side. variantEnd → the organiser (ship 1 plays
    // standard only). The brief: unknownFinish → the organiser.
    case "cheat":
      return { kind: "hold", reason: "fair_play", detail: `${describeSnapshot(s)} — Lichess ended this game for a fair-play violation` };
    case "variantEnd":
      return organiser(s, "a variant ending in a standard game");
    case "unknownFinish":
      return organiser(s, "Lichess does not know why this game ended");
    // T3: a status Lichess added after 2026-10-09 — never a silent pass.
    case "unrecognised":
      return organiser(s, "a status we do not recognise");
    default: {
      const unplaced: never = s;
      throw new Error(`unplaced Lichess status ${JSON.stringify(unplaced)}`);
    }
  }
}

/** Hold the fixture for the organiser: ONE conditional UPDATE, which is both
 *  the hold and its idempotency. The first diagnosis stands until the
 *  organiser clears it (`needs_reason is null`), and a game whose result is
 *  already recorded (`finished`, T11) is never reopened. */
async function hold(
  fixtureId: string,
  reason: "aborted" | HoldReason | SnapshotOnlyReason,
  detail: string | null,
): Promise<"held" | "finished"> {
  const rows = await sql<{ fixture_id: string }[]>`
    update fixture_external_play
       set status = 'needs_organiser', needs_reason = ${reason}, last_error = ${detail}, updated_at = now()
     where fixture_id = ${fixtureId} and needs_reason is null and status <> 'finished'
     returning fixture_id`;
  if (rows.length > 0) return "held";
  const [row] = await sql<{ status: string }[]>`
    select status from fixture_external_play where fixture_id = ${fixtureId}`;
  // Every caller acts on a game it found on this row, so a missing row is a
  // caller bug — refused by name rather than reported as held.
  if (!row) throw new HttpError(404, "no online game on file for this fixture", "NO_ONLINE_GAME");
  return row.status === "finished" ? "finished" : "held";
}

/** The non-snapshot half: a fixture that cannot produce a result at all goes
 *  to the organiser queue with its own reason. Called by T10's `unauthorized`
 *  caller and by T13's double-walkover refusal. Answers `none` when the
 *  game's result is already recorded. `reason` is the caller's diagnosis; an
 *  EARLIER one on the row stands (the queue shows the first). */
export async function holdForOrganiser(a: { fixtureId: string; reason: HoldReason }): Promise<ResultWrite> {
  // The union is the contract, and a cast must not smuggle a no-show past it.
  if (!(HOLD_REASONS as readonly string[]).includes(a.reason)) {
    throw new HttpError(500, `not a hold reason: ${JSON.stringify(a.reason)}`, "HOLD_REASON_UNKNOWN");
  }
  return (await hold(a.fixtureId, a.reason, null)) === "finished"
    ? NONE
    : { wrote: "needs_organiser", reason: a.reason };
}

function answerFor(d: Disposition & { kind: "result" }): ResultWrite {
  return { wrote: d.winner === null ? "draw" : "decided" };
}

async function ledgerHolds(fixtureId: string, key: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one from score_events where fixture_id = ${fixtureId} and idempotency_key = ${key} limit 1`;
  return rows.length > 0;
}

/** The engine's own "a tie-break is owed": the fold awaits its decider
 *  (boardgame.awaitingDecider — phase "tiebreak"). Every caller asks it of a
 *  PLAYABLE fixture only, which is the kernel `deciderPending`'s other half
 *  ("nothing has decided it"): a settle or a tie-break result moves the
 *  fixture to decided first (append-event's status derivation). */
function tiebreakPending(fs: { state: unknown }): boolean {
  return fs.state != null && boardgame.awaitingDecider?.(fs.state as never) === true;
}

/** After a written draw: where did the engine put it? A tie-break the
 *  engine opened is held for the organiser; anything else (a decided draw,
 *  W2a's needs_decision, a fixture since settled) is the draw it is. Also
 *  run on a replay, so a hold a crash lost between the two writes is
 *  restored — and a tie-break recorded since answers plain `draw`. */
async function afterDraw(s: GameSnapshot, fixtureId: string, auth: Awaited<ReturnType<typeof mintOrgOwnerAuth>>): Promise<ResultWrite> {
  const fs = await getFixtureState(auth, fixtureId);
  if (!isPlayableFixtureStatus(fs.status) || !tiebreakPending(fs)) return { wrote: "draw" };
  if ((await hold(fixtureId, "tiebreak_owed", `${describeSnapshot(s)} — a drawn game in a bracket: the tie-break is owed`)) === "finished") {
    return NONE;
  }
  return { wrote: "needs_organiser", reason: "tiebreak_owed" };
}

function phaseOf(state: unknown): string {
  if (state === null || state === undefined) return "pre"; // no event yet
  const phase = (state as { phase?: unknown }).phase;
  return typeof phase === "string" ? phase : "unknown";
}

async function attempt(
  s: GameSnapshot,
  fixtureId: string,
  d: Exclude<Disposition, { kind: "none" }>,
): Promise<ResultWrite> {
  const key = resultIdempotencyKey(fixtureId, s);
  // 1. A replay: this snapshot's result is already on the ledger — even if
  //    an organiser has since voided it, which then stands. A replayed draw
  //    re-reads where the engine put it (afterDraw).
  if (d.kind === "result" && (await ledgerHolds(fixtureId, key))) {
    if (d.winner !== null) return answerFor(d);
    const f = await loadOnlinePlayFixture(fixtureId);
    return f ? afterDraw(s, fixtureId, await mintOrgOwnerAuth(f.orgId)) : answerFor(d);
  }

  // 2. The fixture we serve, and THIS game on it.
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) {
    log.warn({ fixtureId, gameId: s.gameId }, "lichess result: not an online fixture we serve — nothing written");
    return NONE;
  }
  const b = effectiveBridge(f);
  if (!b || b.challenge_id !== s.gameId) {
    log.warn(
      { fixtureId, gameId: s.gameId, onFile: b?.challenge_id ?? null },
      "lichess result: the snapshot is not the game on file — nothing written",
    );
    return NONE;
  }
  // 3. Settled through another path — a withdrawal, a void, a result by
  //    hand. A game nothing ended at Lichess (T10 review carry: a mid-game
  //    withdrawal makes no Lichess call) runs on and arrives here later; the
  //    organiser's decision stands, so nothing is written or held.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) {
    log.info({ fixtureId, gameId: s.gameId, fixtureStatus: f.fixtureStatus }, "lichess result: fixture already settled — nothing written");
    return NONE;
  }
  // …or a level result the organiser entered on the pad, its tie-break now
  // pending: the fixture still reads in_play, but its decision is the
  // organiser's (review §4.1 — this used to reach the phase check and raise
  // FOLD_STATUS_MISMATCH on every reconcile).
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, fixtureId);
  if (tiebreakPending(state)) {
    log.info({ fixtureId, gameId: s.gameId }, "lichess result: a level result is already recorded, its tie-break pending — nothing written");
    return NONE;
  }

  if (d.kind === "hold") {
    if ((await hold(fixtureId, d.reason, d.detail)) === "finished") return NONE;
    return d.reason === "aborted" ? { wrote: "aborted" } : { wrote: "needs_organiser", reason: d.reason };
  }

  // 4. The winning ENTRANT, from the colours T9 recorded with the game —
  //    never a fresh read of the pairing, never a guess.
  let winner: string | null = null;
  if (d.winner !== null) {
    if (b.white_side === null) {
      await hold(fixtureId, "provider_error", `${describeSnapshot(s)} — the game on file has no recorded colour`);
      return { wrote: "needs_organiser", reason: "provider_error" };
    }
    const whiteIsHome = b.white_side === "home";
    winner = (d.winner === "white") === whiteIsHome ? f.homeEntrantId : f.awayEntrantId;
  }

  // 5. Start the fold if nothing has (boardgame refuses a result in `pre`,
  //    boardgame.ts decideResult), then the result, keyed.
  const phase = phaseOf(state.state);
  let seq = state.last_seq;
  if (phase === "pre") {
    await scoreEvent(auth, fixtureId, { expected_seq: seq, type: "core.start", payload: {} });
    seq += 1;
  } else if (phase !== "live") {
    // append-event.ts derives the status FROM the fold, so a playable status
    // means `pre`, `live` or a pending tie-break (answered above). Anything
    // else is a damaged row: refuse by name.
    throw new HttpError(
      500,
      `fixture ${fixtureId} reads ${f.fixtureStatus} but its fold is in phase "${phase}"`,
      "FOLD_STATUS_MISMATCH",
    );
  }
  await scoreEvent(auth, fixtureId, {
    expected_seq: seq,
    type: "boardgame.result",
    payload: d.method === undefined ? { winner } : { winner, method: d.method },
    idempotency_key: key,
  });
  return d.winner === null ? afterDraw(s, fixtureId, auth) : answerFor(d);
}

/** Map a terminal snapshot onto the fixture. Non-terminal ⇒ `none`, nothing
 *  read. A repeat call writes nothing and answers what the first one did. */
export async function writeResultFrom(snapshot: GameSnapshot, fixtureId: string): Promise<ResultWrite> {
  const d = dispositionOf(snapshot);
  if (d.kind === "none") return NONE;
  try {
    return await attempt(snapshot, fixtureId, d);
  } catch (err) {
    // Two reconciles of one game (game_end and the sweep) can both read
    // phase `pre`: the loser's un-keyed core.start meets a moved tip. Re-read
    // ONCE — the replay check or the started fold then answers it. A second
    // conflict is a real contention and is raised.
    if (!(err instanceof EngineError && err.code === "SEQ_CONFLICT")) throw err;
    return attempt(snapshot, fixtureId, d);
  }
}
