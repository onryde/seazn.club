import "server-only";
import { EngineError, playRecorded } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { anchorOfRow, boardExtraSql, boardRankSql } from "@/server/external-play/round-open";
import { type BoardAnchor } from "@/server/external-play/window";
import { boardPhase } from "@/server/external-play/seat-line";
import { getFixtureState, listEvents } from "../../fixtures";
import { scoreEvent } from "../../scoring";
import { mintOrgOwnerAuth } from "../auth";
import { ensureBridgeRow, loadOnlinePlayFixture, loadSides, whiteSideOf, type OnlinePlayFixture } from "../guard";
import { closeBridgeIfUnplayable } from "../bridge-close";
import { holdForOrganiser, holdRefusedNoShow } from "../result";
import { checkIns } from "../room";
import { PLAYABLE_STATUSES, anchorIfClosedNow, codeOf, gameMayBeOnFile, orgScope, playableWindow, type BridgeFacts, type Pass } from "./pass";

// ─── Job 0: a fixture no longer playable closes its bridge (T16 fix round 1, I1)
//
// A fixture decided on the scoring pad, settled, walked over or voided by a
// withdrawal, or cancelled ends our interest in its online game, whatever its
// bridge row reads. Reconcile closed only the ready/live rows it was handed,
// and job 4 hands it no HELD row of such a fixture, so a held board under a
// decided fixture was orphaned: out of the queue (which lists playable
// fixtures only), and "needs the organiser" on the public page for ever. Every
// non-finished row of an unplayable fixture is closed here, every tick — which
// also heals a settle that wrote its result and crashed before its close
// (review M2). First, so no later job acts on a board that is over.

export async function unplayableCandidates(pass: Pass): Promise<{ fixtureId: string }[]> {
  return sql<{ fixtureId: string }[]>`
    select ep.fixture_id as "fixtureId"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
     where ep.status <> 'finished'
       and f.status not in ${sql(PLAYABLE_STATUSES as string[])}
       ${orgScope(pass)}
     order by ep.fixture_id`;
}

export async function closeUnplayable(pass: Pass, c: { fixtureId: string }): Promise<void> {
  if (await closeBridgeIfUnplayable(c.fixtureId, pass.now)) pass.report.bridgesClosed++;
}

// ─── Job 1: the deadline no-show ───────────────────────────────────────────────
//
// A board is a no-show candidate only when its round was OPENED (inner join),
// the fixture is still playable (T8's predicate — never needs_decision, never a
// withdrawn or settled board), and no game is — or may be — on file (above):
// no bridge row, or a `pending` one with no challenge. The window is then
// judged per board, and the guard loads it. A sent create past the deadline
// is held for the organiser (I3), never ruled a no-show: a game may exist.

/** The sweep's no-show forfeit's idempotency key, per fixture. */
const NO_SHOW_KEY_PREFIX = "extplay-noshow:";

type NoShowCandidate = BridgeFacts & { fixtureId: string; openedAt: Date; anchor: BoardAnchor };

export async function noShowCandidates(pass: Pass): Promise<NoShowCandidate[]> {
  // Millisecond stamps, as a JS Date holds them, so the I3 takeover compares
  // like with like whatever precision a writer used.
  const rows = await sql<(Omit<NoShowCandidate, "anchor"> & { rank: number; extraMs: number; staggered: boolean })[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt", o.staggered, ${boardRankSql(sql)} as rank, ${boardExtraSql(sql)} as "extraMs",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId",
           date_trunc('milliseconds', ep.create_sent_at) as "createSentAt",
           date_trunc('milliseconds', ep.mint_claimed_at) as "mintClaimedAt"
      from fixtures f
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.status in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.fixture_id is null or (ep.status = 'pending' and ep.challenge_id is null))
       -- Review M3: the sweep's own no-show is in the ledger (or was, and an
       -- organiser voided it): never asked for again.
       and not exists (select 1 from score_events se
                        where se.fixture_id = f.id and se.idempotency_key = ${NO_SHOW_KEY_PREFIX} || f.id::text)
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
  return rows.map((r) => ({ ...r, anchor: anchorOfRow(r) }));
}

export async function noShow(pass: Pass, cand: NoShowCandidate): Promise<void> {
  // Cheap, lock-free first look: the candidate's own anchor. A board still inside its window needs no lock; one past it is
  // re-read under the window lock (an extension may have landed since the candidate query).
  if (pass.now.getTime() < playableWindow(cand.anchor).deadline.getTime()) return;
  if (gameMayBeOnFile(pass, cand)) return;
  const fresh = await anchorIfClosedNow(pass, cand.fixtureId);
  if (fresh === null) return;
  const c: NoShowCandidate = { ...cand, anchor: fresh.anchor };
  const { deadline } = playableWindow(c.anchor);
  // THE guard (spec §6): online play still on, a boardgame, both entrants.
  // An organiser who switched online play off after the open has taken the
  // board back to the table.
  const f = await loadOnlinePlayFixture(c.fixtureId);
  if (!f) return;
  const { home, away } = await loadSides(f);
  const came = await checkIns(f, home, away, c.anchor);
  // Spec §5.7.8 - the check-in line's skip, with its `not_started` hold, under ONE cap: a board with a PROTECTED player on either
  // side (the call budget was holding them in line; they arrived in time) is not judged until the board's cap, and nor is a
  // board whose two players both came while its create is still owed (T9 can still recover a sent create there, so the
  // unknown-create hold waits for the cap too). At the cap, and after, it is judged normally.
  const held = await boardPhase(fresh.now, { fixtureId: c.fixtureId, anchor: c.anchor }, { personId: null, facts: { own: false, both: came.home && came.away } });
  if (held === "open") return;
  if (c.createSentAt !== null) {
    await holdUnknownCreate(pass, c, deadline);
    return;
  }
  if (came.home && came.away) {
    // Controller ruling C2 (spec §3.2; §9's deadlineReason): both players
    // came and no game was made — a create Lichess throttled to the end, or
    // one that never landed. Not a no-show, and not a board to leave silent:
    // a stuck board blocks the next round. The organiser's, as not_started.
    await ensureBridgeRow(f);
    const held = await holdForOrganiser({
      fixtureId: f.fixtureId,
      reason: "not_started",
      detail: `sweep: both players checked in, no game was made by the deadline (${deadline.toISOString()})`,
    });
    if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
    return;
  }
  const by = !came.home && !came.away ? "both" : !came.home ? f.homeEntrantId : f.awayEntrantId;
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, f.fixtureId);
  // RB3 (controller ruling 2026-10-13): never a walkover over a Start. W2b admits a chess walkover after the Start
  // (ruling 118: the Start is play), so the engine would take it — the sweep must not ask. The board is left open,
  // the arbiter's. Read AFTER the seq the forfeit is written at: a Start landing in between is seen here, and one
  // landing after makes the write SEQ_CONFLICT — refused, never a walkover over it.
  const ledger = await listEvents(auth, f.fixtureId, 0);
  if (playRecorded(ledger.map((e) => ({ id: e.id, type: e.type, voids: e.voids_event_id })), boardgame)) {
    // Rebase review M-1: not silent. A Start with a player absent at the deadline (an organiser who tapped Start on
    // the pad before anyone came) would otherwise read live for ever with nobody playing. Held ONCE for the
    // organiser as the no-show it is — the hold takes the board out of this job's candidates — and counted.
    await ensureBridgeRow(f);
    const held = await holdRefusedNoShow({
      fixtureId: f.fixtureId,
      absent: await absentColour(f, by),
      detail: "sweep: absent at the deadline, but play is recorded (a Start on the ledger) — never walked over",
    });
    if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
    return;
  }
  try {
    await scoreEvent(auth, f.fixtureId, {
      expected_seq: state.last_seq,
      type: "core.forfeit",
      payload: { by, reason: "walkover" },
      idempotency_key: `${NO_SHOW_KEY_PREFIX}${f.fixtureId}`,
    });
  } catch (err) {
    // T12's hold needs a row to hold; a board the open never attached has none.
    await ensureBridgeRow(f);
    // W2b D19 (append-event.ts assertW2bWriteGuards; packages/engine
    // core/errors.ts DOUBLE_WALKOVER_NO_NEXT_MATCH): a double walkover on a
    // bracket line that feeds no next match (a final, a last rung, a
    // third-place match) has nowhere for "nobody advances" to go, and is
    // refused. An expected outcome, not an error: the board stays open and
    // goes to the organiser's queue (RB2). Read by CODE, never the message.
    if (by === "both" && err instanceof EngineError && err.code === "DOUBLE_WALKOVER_NO_NEXT_MATCH") {
      const held = await holdForOrganiser({ fixtureId: f.fixtureId, reason: "double_walkover_blocked" });
      if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
      return;
    }
    await refusedNoShow(pass, f, by, err);
    return;
  }
  pass.report.noShows++;
}

/** Review M3: any other refusal of the forfeit is a failure — the board is
 *  re-examined next pass — until the SAME refusal has come back
 *  NO_SHOW_REFUSALS_BEFORE_HOLD passes running: then it is persistent, and
 *  the board goes to the organiser as the no-show it is instead of failing
 *  every 5 minutes for ever. Counted on the bridge's `last_error` (a
 *  different refusal restarts it); the hold replaces the marker. */
export const NO_SHOW_REFUSALS_BEFORE_HOLD = 3;
const NO_SHOW_REFUSED_MARKER = "noshow:refused:";

/** The colour (or both) a no-show's `by` names — the RECORDED colours (a pairing card may put Black on home). */
async function absentColour(f: OnlinePlayFixture, by: string): Promise<"white" | "black" | "both"> {
  if (by === "both") return "both";
  return (by === f.homeEntrantId ? "home" : "away") === (await whiteSideOf(f)) ? "white" : "black";
}

async function refusedNoShow(pass: Pass, f: OnlinePlayFixture, by: string, err: unknown): Promise<void> {
  const code = codeOf(err);
  const prefix = `${NO_SHOW_REFUSED_MARKER}${code} n=`;
  const [row] = await sql<{ n: number }[]>`
    update fixture_external_play
       set last_error = ${prefix} || (case when starts_with(coalesce(last_error, ''), ${prefix})
                                           then coalesce(substring(last_error from length(${prefix}) + 1)::int, 0)
                                           else 0 end + 1)::text,
           updated_at = now()
     where fixture_id = ${f.fixtureId} and status = 'pending' and challenge_id is null
    returning substring(last_error from length(${prefix}) + 1)::int as n`;
  if (!row || row.n < NO_SHOW_REFUSALS_BEFORE_HOLD) throw err;
  const held = await holdRefusedNoShow({
    fixtureId: f.fixtureId,
    absent: await absentColour(f, by),
    detail: `sweep: the no-show forfeit was refused ${row.n} passes running (${code})`,
  });
  if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
}

/** Ruling I3: a create T9 sent and never recorded, past the deadline. T9's
 *  claim is taken over FIRST, conditionally on the very row judged: a record
 *  T9 lands meanwhile (a ready game) wins and nothing is held, and so does a
 *  release that PROVED nothing exists (a 429 clears the marker — then it is
 *  a board with no game, the next pass's no-show or not_started). After the
 *  takeover no T9 write can land (each is conditional on its own claim) and
 *  no new claim can be taken (T9 refuses past the deadline before claiming). */
async function holdUnknownCreate(pass: Pass, c: NoShowCandidate, deadline: Date): Promise<void> {
  // The CAS is the claim alone, T9's own discipline: every T9 write (record,
  // hold, release) is conditional on its claim and clears it, so a claim we
  // saw still standing means nothing of T9's landed — and a claim we saw
  // null means nothing of T9's can (it holds no claim, and takes none past
  // the deadline). A status or marker condition here would be one no write
  // can reach without moving the claim first.
  const taken = await sql`
    update fixture_external_play set mint_claimed_at = null, updated_at = now()
     where fixture_id = ${c.fixtureId}
       and date_trunc('milliseconds', mint_claimed_at) is not distinct from ${c.mintClaimedAt}
    returning fixture_id`;
  if (taken.length === 0) return;
  const held = await holdForOrganiser({
    fixtureId: c.fixtureId,
    reason: "create_outcome_unknown",
    detail:
      `sweep: a create was sent at ${c.createSentAt!.toISOString()} and never recorded; ` +
      `past the deadline (${deadline.toISOString()}) and any hold the check-in line had on the board, nothing can recover it`,
  });
  if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
}
