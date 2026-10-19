import "server-only";
// The seat (spec §5.2, §3.2). A player is seated only when the MEETING
// reports them present in a live session, and (T17B fix 2, D2) their current
// peer's own RealtimeKit report shows the camera granted and on — never on
// anything the client sends US. The POC gated check-in on a client-supplied
// camera boolean; that is forgeable and is on the do-not-copy list (§10).
// There is no parameter here a browser could set. (The peer report is
// client-uploaded telemetry too, read from the vendor — the accepted
// residual, spec §5.2.)
//
// D12: the window hangs off `stage_round_opens.opened_at` (read through
// round-open.ts, the one reader of the stamp), not `fixtures.scheduled_at`.
// "The window has not started" is its OWN refusal (`round_not_open`), not
// `window_closed`: the room says different things about the two.
import type postgres from "postgres";
import { answerBusy, boardPhase, gateClaim, lineActive, SeatLineBusy, type GateAsk } from "@/server/external-play/seat-line";
import { takeSeatAsk } from "@/server/external-play/seat-ask-limit";
import { boardOpenFor } from "@/server/external-play/round-open";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import type { GrantRefusal } from "@/server/external-play/types";
import { assertLichessConsentForPlay } from "../external-accounts";
import {
  RealtimeKitDeferred,
  RealtimeKitError,
  addParticipant,
  ensureMeeting,
  refreshParticipantToken,
  seatCameraEvidence,
  currentBudgetKey,
  type ParticipantToken,
  type SeatCamera,
} from "@/server/external-play/video/realtimekit";
import { CAMERA_EVIDENCE_BACKOFF_MS, CAMERA_EVIDENCE_DEADLINE_MS, type LineWire } from "@/components/public-site/match-room/room-snapshot";
import { countedCheckIns } from "./check-ins";
import {
  effectiveBridge,
  ensureBridgeRow,
  loadOnlinePlayFixture,
  loadSides,
  type OnlinePlayFixture,
  type Side,
  type SidePlayer,
} from "./guard";

/** Every reason a seat can be refused. The four camera refusals carry the
 *  caller's OWN participant token (controller ruling Q1, 2026-10-09): under
 *  `required` a player becomes live only by joining the meeting, so the token
 *  to join with must reach them BEFORE they are seated — a refusal that
 *  carried none would leave no way to ever be seated (and would drop the
 *  camera a starting one has just joined with). Every other refusal carries
 *  nothing. */
export const SEAT_REFUSAL_REASONS = [
  "camera_required",
  "camera_lost",
  // T17B fix 2 (D2): joined, the camera's own report not in yet — the room
  // re-asks; and the browser refused the camera.
  "camera_starting",
  "camera_blocked",
  "window_closed",
  "not_a_player",
  "round_not_open",
  // Spec §3.2.1: the round is open but THIS board's check-in batch has not opened yet.
  "checkin_not_open",
  // Spec §5.7: the platform's call budget is holding this claim in the check-in line; the answer carries `line`.
  "queued",
  "fixture_not_playable",
  "video_unavailable",
  // Fix round 2 (controller ruling): T2's play gate, asked by the seat.
  "lichess_link_required",
  "lichess_reconsent_required",
] as const;

/** The two seat refusals T2's play gate can produce — declared in the
 *  import-free external-play/types.ts (review I6), re-exported here. */
export type { GrantRefusal };

export type SeatResult =
  // `cameraRetry` (D21-fix-3): an OPTIONAL camera seated with no token because the platform's call budget was spent - and
  // for that alone. Absent on every other tokenless seat (camera Off, an organiser's override, a vendor outage, T9's
  // re-verify): those are final, and the room must not read a missing token as "ask again".
  | { seated: true; participant: ParticipantToken | null; cameraRetry?: true }
  // The camera refusals carry the caller's own token - except where there is none to hand: a `camera_starting` answered
  // to a browser that already holds this participant's (D21-fix-3, F1), one a deferral cut short (D21), and any answer to
  // T9's re-verify (`recheck`), which nobody joins with.
  //   `budgetDeferred` (spec §5.7.3): a `camera_starting` that the call budget cut short (RealtimeKitDeferred) and not a read
  //   that found the camera still coming up. claimRoomSeat turns it into `queued` for a stay not yet admitted.
  | { seated: false; reason: CameraRefusal; participant: ParticipantToken | null; budgetDeferred?: true }
  // The check-in line holds this claim (spec §5.7.3): no token, the position and the cadence to ask again.
  | { seated: false; reason: "queued"; participant: null; line: LineWire }
  | {
      seated: false;
      reason:
        | "window_closed"
        | "not_a_player"
        | "round_not_open"
        | "checkin_not_open"
        | "fixture_not_playable"
        | "video_unavailable"
        | GrantRefusal;
    };

/** The seat refusals that carry the caller's own participant token. */
export type CameraRefusal = "camera_required" | "camera_lost" | "camera_starting" | "camera_blocked";

type Video = {
  ensureMeeting: typeof ensureMeeting;
  addParticipant: typeof addParticipant;
  seatCameraEvidence: typeof seatCameraEvidence;
  refreshParticipantToken: typeof refreshParticipantToken;
};

/** Test seam only — T9 and the room pass no deps. */
export type PreflightDeps = {
  now?: Date;
  video?: Video;
  /** The check-in line's two test seams (seat-line.ts): `at` is the clock of the gate's whole decision (production passes
   *  nothing and the database's clock decides); `afterRead` runs inside the gate's transaction between its read and its decision. */
  line?: { at?: Date; afterRead?: () => void | Promise<void> };
};

const REAL_VIDEO: Video = { ensureMeeting, addParticipant, seatCameraEvidence, refreshParticipantToken };

/** T2's assertLichessConsentForPlay as a seat reason: its two 422s map to
 *  `lichess_link_required` / `lichess_reconsent_required` (the codes T14's
 *  re-link screen is drawn on); anything else — a 503
 *  LICHESS_TOKEN_UNAVAILABLE, a database error — is not a consent refusal and
 *  propagates. T9 reuses it, so creation names the same two reasons. */
export async function playGrantRefusal(userId: string | null): Promise<GrantRefusal | null> {
  try {
    await assertLichessConsentForPlay(userId);
    return null;
  } catch (err) {
    if (err instanceof HttpError && err.code === "LICHESS_LINK_REQUIRED") return "lichess_link_required";
    if (err instanceof HttpError && err.code === "LICHESS_RECONSENT_REQUIRED") return "lichess_reconsent_required";
    throw err;
  }
}

/** Controller ruling Q2 (2026-10-09): a board is playable only while it is
 *  `scheduled` or `in_play`. A withdrawal leaves it `abandoned` (league
 *  expunge, measured) or walked over, and `loadOnlinePlayFixture` still loads
 *  those settled-open statuses because spectator and room views must — so the
 *  SEAT refuses them here, and T9 reuses this when a create leaves the queue. */
export function isPlayableFixtureStatus(status: string): boolean {
  return status === "scheduled" || status === "in_play";
}

/** Who is asking for a seat, and what they already have in hand.
 *
 *  D21-fix-3 (F1): `heldParticipantId` is the participant whose token the caller's browser already holds - the room sends
 *  the id it holds with every claim. A claim answered `camera_starting` (a camera still coming up) hands such a browser
 *  NO token: it keeps joining with the one it has, and a refresh is a vendor request the budget would rather spend on a
 *  read. A browser that holds none (a first visit, a reload) or another participant's (a re-pair moved the seat) is
 *  handed one on every answer. The id is a hint about what to SAVE, never an authority for anything: it is compared with
 *  the participant on file, so naming someone else's gets nothing and costs only the caller their own token.
 *
 *  D21-fix-3 (F2): `recheck` is T9's re-verify, immediately before it creates the game. Its answer is read by the server
 *  alone, so no token is ever handed (or minted) for it, and a pass of THIS participant's camera read within
 *  SEAT_RECHECK_TRUST_MS stands without asking the vendor again. */
export type SeatAsk = {
  fixtureId: string;
  personId: string;
  heldParticipantId?: string | null;
  recheck?: boolean;
  /** Spec §5.7.3: this claim came in through the `line` door (the caller's own stay is in line). When the gate then lets it
   *  SPEND, one `seat` ask is counted too, so nothing that can reach the vendor escapes the per-seat bound. */
  viaLine?: boolean;
};

/** D21-fix-3 (F2): how long a camera read as ON stands for T9's re-verify. Both players' check-ins read their camera, and
 *  creating the game then asked the vendor about both again (a token and three reads each) - the calls that, under the
 *  call budget, were deferred and stranded boards. Ten seconds covers the check-ins that arrive together; a board whose
 *  first player has waited longer is read afresh. THE COST, stated: a camera that goes dark inside the window is seated
 *  into a game it should not have started. The sweep's camera evidence catches it afterwards from the vendor's own peer
 *  reports - `camera_lost`, a flag the organiser decides on (spec §5.2, D10) - exactly as it catches a camera that goes
 *  dark one second after the game is created, which no re-verify can prevent. */
export const SEAT_RECHECK_TRUST_MS = 10_000;

export async function seatPlayer(a: SeatAsk, deps: PreflightDeps = {}): Promise<SeatResult> {
  const now = deps.now ?? new Date();

  const f = await loadOnlinePlayFixture(a.fixtureId);
  // A fixture we do not serve and a caller who is not one of the two players
  // collapse to the SAME answer, so a probe cannot learn which check failed
  // (the same rule readMatchRoom follows, room.ts).
  if (!f) return { seated: false, reason: "not_a_player" };

  const { home, away } = await loadSides(f);
  const player: SidePlayer | undefined = [home, away].find((s) => s.personId === a.personId);
  // An empty side has `personId: null`; a null smuggled in as the caller's id
  // would otherwise "match" it.
  if (!player || player.personId === null) return { seated: false, reason: "not_a_player" };

  // Only now, to a confirmed player: a withdrawn or walked-over board.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return { seated: false, reason: "fixture_not_playable" };

  const open = await boardOpenFor(sql, a.fixtureId);
  if (!open) return { seated: false, reason: "round_not_open" };
  // The counted check-ins, read once and only when a question needs them: the closed window's protection, and the gate.
  let counted: ReturnType<typeof countedCheckIns> | null = null;
  const checkedIn = () => (counted ??= countedCheckIns(f, home, away, open.anchor));
  const phase = await boardPhase(
    now,
    { fixtureId: a.fixtureId, anchor: open.anchor },
    {
      personId: a.personId,
      facts: async () => {
        const ci = await checkedIn();
        return { own: ci[player.side], both: ci.home && ci.away };
      },
    },
  );
  // "before" with no stamp at all was answered above: round_not_open. A round that IS stamped but whose BOARD's window has
  // not opened (its batch is later, spec §3.2.1; or, in a test, a stamp in the future) is `checkin_not_open`: the room
  // says WHEN. It is refused before any vendor call, check-in or stay, so an early claim costs nothing. Never "closed".
  if (phase === "before") return { seated: false, reason: "checkin_not_open" };
  // DEADLINE_AFTER_MS is the deadline to be seated and have the game created, not a cap on
  // the game (spec §3.6): a seated player reloading mid-game comes back in. `boardPhase` (spec §5.7.8) also holds the window
  // open, until the board's cap, for a player the call budget is holding in the check-in line - they came in time.
  if (phase === "closed" && !isReentry(f, player)) return { seated: false, reason: "window_closed" };

  // T2's play gate (fix round 2, controller ruling): AFTER the checks above —
  // a board that cannot be played, a round not open or a window closed are
  // not cured by re-linking, so they answer first — and BEFORE any token is
  // minted, under EVERY camera policy (`off` seats with no video at all). A
  // seat is a promise that T9 can create the game and this player can move.
  const refused = await playGrantRefusal(player.userId);
  if (refused) return { seated: false, reason: refused };

  const policy = await fixtureCameraPolicy(a.fixtureId);
  if (policy === "off") {
    // No meeting is created. Zero video spend (spec §5.1).
    return { seated: true, participant: null };
  }

  // D11: an organiser has already proceeded without video on this fixture.
  // Read BEFORE any RealtimeKit call, because the whole point of the override
  // is that RealtimeKit may be the thing that is broken. It relaxes only the
  // camera: every refusal above still stands.
  const [bridge] = await sql<{ video_override_at: Date | null }[]>`
    select video_override_at from fixture_external_play where fixture_id = ${a.fixtureId}`;
  if (bridge?.video_override_at) return { seated: true, participant: null };

  const video = deps.video ?? REAL_VIDEO;
  if (policy === "optional") {
    // T9's re-verify (D21-fix-3): an optional camera never blocks a seat, and nobody joins with the answer - no vendor call.
    if (a.recheck) return { seated: true, participant: null };
    // Shown if the player grants camera; NEVER blocks a seat — not even when
    // RealtimeKit is down. The publisher is deliberately not asked: a question
    // whose answer is ignored is how a later refactor turns `optional` into
    // `required`.
    try {
      // Spec §5.7.1 (Q3, ruled): an optional claim YIELDS to the check-in line. While it is active in this bucket (a live
      // in-line stay or a live admitted stay) the claim makes no vendor call and answers the shape the budget already has:
      // seated, no tile yet, `cameraRetry`. The tile is a nicety, the seat is not.
      const budgetKey = currentBudgetKey();
      if (budgetKey !== null && (await lineActive({ budgetKey, at: deps.line?.at }))) {
        log.info({ fixtureId: a.fixtureId, orgId: f.orgId }, "seat: the check-in line is active; optional camera seated with no tile");
        return { seated: true, participant: null, cameraRetry: true };
      }
      const meeting = await video.ensureMeeting(a.fixtureId, player.side);
      return { seated: true, participant: await issuePlayerToken(a, player.side, meeting.meetingId, video) };
    } catch (err) {
      if (!(err instanceof RealtimeKitError)) throw err;
      // D21: a deferral (the call budget is spent) is not an outage, and is not reported as one.
      if (err instanceof RealtimeKitDeferred) {
        // Seated with no tile YET: the answer says so (`cameraRetry`), and the room asks for just the token on a back-off
        // (cameraTokenForSeat, D21-fix-3) - without it a seated answer ends the room's polling and the player would have
        // no camera until they reload. Not an outage (nothing is wrong at the vendor) and not worth Sentry - but not
        // silent either: this counts how often the platform's call budget costs a player their tile at the seat.
        log.info({ fixtureId: a.fixtureId, orgId: f.orgId }, "seat: RealtimeKit call budget spent; optional camera seated with no tile");
        return { seated: true, participant: null, cameraRetry: true };
      }
      reportOutage(err, f.orgId, a.fixtureId, policy);
      return { seated: true, participant: null };
    }
  }

  // Spec §5.7.3: the check-in line, on the `required` path only - after the window, the grant, `off`, the override and the
  // optional branch, and before the first vendor call. A T9 re-verify never reaches it.
  const line = await passTheLine(a, { f, home, away, player, anchor: open.anchor, checkedIn, now }, deps);
  if (line.held !== null) return line.held;

  try {
    const seat = await verifyRequiredSeat(a, player.side, now, video);
    // `budgetDeferred` is the claim's own word to claimRoomSeat that the BUDGET cut a GATED claim short (a stay to queue). A claim
    // that was never gated (a seated player's re-claim, T9's re-verify) has no stay, so the mark is dropped: it is "starting".
    if (!line.gated && !seat.seated && "budgetDeferred" in seat) {
      return { seated: false, reason: seat.reason, participant: seat.participant };
    }
    return seat;
  } catch (err) {
    // An outage (or an answer the adapter cannot read — T7 THROWS on those)
    // is the vendor's failure, never the player's camera: it is its own
    // reason, so neither the player nor the organiser is told "camera off",
    // and the organiser's D11 override is the way through. Anything that is
    // not a RealtimeKit failure (VIDEO_MEETING_ENDED, a database error)
    // propagates unchanged.
    if (!(err instanceof RealtimeKitError)) throw err;
    reportOutage(err, f.orgId, a.fixtureId, policy);
    return { seated: false, reason: "video_unavailable" };
  }
}

/** The gate (spec §5.7.3) for a claim that reached it: `held` is `null` when the claim may spend (carry on to the camera), else
 *  the answer that holds it; `gated` says whether the claim met the gate at all. A claim is gated when the caller has no counted check-in yet (a reload or the camera's re-entry of a
 *  seated player is not an arrival), RealtimeKit is configured (there is no bucket otherwise), and it is not T9's re-verify. */
async function passTheLine(
  a: SeatAsk,
  w: {
    f: OnlinePlayFixture;
    home: SidePlayer;
    away: SidePlayer;
    player: SidePlayer;
    anchor: Parameters<typeof countedCheckIns>[3];
    checkedIn: () => ReturnType<typeof countedCheckIns>;
    /** The instant `seatPlayer` judged the window: the ARRIVAL of a new stay (seat-line.ts `arrivalOf`). */
    now: Date;
  },
  deps: PreflightDeps,
): Promise<{ held: SeatResult | null; gated: boolean }> {
  const through = { held: null, gated: false };
  if (a.recheck) return through;
  const budgetKey = currentBudgetKey();
  if (budgetKey === null || w.anchor === null) return through;
  const ci = await w.checkedIn();
  if (ci[w.player.side]) return through;
  const other = w.player.side === "home" ? w.away : w.home;
  const ask: GateAsk = {
    fixtureId: a.fixtureId,
    personId: a.personId,
    otherPersonId: other.personId,
    otherCounted: ci[other.side],
    budgetKey,
    anchor: w.anchor,
    at: deps.line?.at,
    arrival: w.now,
    afterRead: deps.line?.afterRead,
  };
  let answer;
  try {
    answer = await gateClaim(ask);
  } catch (err) {
    // The gate's ONE named refusal; anything else is a defect and propagates as itself.
    if (!(err instanceof SeatLineBusy)) throw err;
    answer = await answerBusy(ask, err.left);
  }
  if (answer.kind === "queued") return { held: { seated: false, reason: "queued", participant: null, line: answer.line }, gated: true };
  if (answer.kind === "camera_starting") return { held: { seated: false, reason: "camera_starting", participant: null }, gated: true };
  // Let through to spend: a claim that came in by the `line` door counts one `seat` ask too (spec §5.7.3, "Which door counts").
  if (a.viaLine) await takeSeatAsk({ fixtureId: a.fixtureId, personId: a.personId, route: "seat" }, { at: deps.line?.at });
  return { held: null, gated: true };
}

/** What the camera door answers (D21-fix-3): the caller's token if there is one to hand, and whether asking again can
 *  still bring one. `retry: true` only while an OPTIONAL camera's token is being held back by the platform's call budget. */
export type CameraToken = { participant: ParticipantToken | null; retry: boolean };

/**
 * D21-fix-3 (owner decision) - the token-only door for an OPTIONAL camera seated without one.
 *
 * A player seated under an optional camera when the platform's call budget was spent has `cameraRetry` on their seat
 * answer and no tile. The seat route is the wrong door to ask again by: every claim stamps a check-in, publishes the lobby
 * and may ask T9 for the game. This is the right one - the same seat, judged by the same rules, and then ONLY the token:
 *
 *   - only an OPTIONAL camera is ever asked again. Off has no camera; an organiser's override (D11) is the way round a
 *     vendor that may be broken; a vendor outage is final (retrying every tab's back-off would hammer a vendor that is
 *     down); and Required has its own door (its camera refusals carry the token). The policy is read FIRST, so a
 *     Required seat never reaches the vendor from here;
 *   - everything else is seatPlayer's, unchanged: a stranger, an abandoned board and a closed window are refused, and a
 *     refusal is `retry: false`;
 *   - each vendor request spends one token from the platform's bucket and a refused one spends none, so a spent budget
 *     costs nothing to ask about, and the work that did get through (the meeting made, the participant stored) is kept for
 *     the next ask.
 */
export async function cameraTokenForSeat(a: SeatAsk, deps: PreflightDeps = {}): Promise<CameraToken> {
  if ((await fixtureCameraPolicy(a.fixtureId)) !== "optional") return { participant: null, retry: false };
  // Not the caller's `recheck` or `heldParticipantId`: this door asks for a token, which is what a recheck never wants and
  // what a held id would only save.
  const seat = await seatPlayer({ fixtureId: a.fixtureId, personId: a.personId }, deps);
  if (!seat.seated) return { participant: null, retry: false };
  if (seat.participant) return { participant: seat.participant, retry: false };
  return { participant: null, retry: seat.cameraRetry === true };
}

/** Controller ruling I1 (fix round 1, amending Q1): after the window, a
 *  caller passes the window check only when ALL THREE hold. Every other check
 *  before and after it still applies — the camera included.
 *
 *  (a) they were seated on this fixture. Seats are re-verified on every claim
 *      and never stored as a pass (T9: "not a stored stamp"), so the durable
 *      record of a seat is the game T9 created immediately after seating both
 *      players through seatPlayer: it names the two Lichess accounts it seated,
 *      by colour. The caller's own account must be the one recorded for THEIR
 *      colour. This holds under every policy — Off and an overridden Required
 *      seat leave no video row at all, so a video row cannot be the record.
 *  (b) the game exists: T9 records the Lichess game id exactly when it
 *      creates one. A stale bridge (minted for an older timetable and never
 *      live) is not this fixture's game (`effectiveBridge`).
 *  (c) the game is not over (amended, fix round 2): that bridge is `ready`
 *      (T9's create + accept) or `live` (T10's first accepted move).
 *      `finished` and `needs_organiser` refuse. NOT `fixtures.status`: an
 *      online board stays `scheduled` for the whole game — `in_play` comes
 *      only from `core.start`, which T12 emits as it writes the result — and
 *      a board settled since is refused earlier as fixture_not_playable. */
function isReentry(f: OnlinePlayFixture, player: SidePlayer): boolean {
  const game = effectiveBridge(f);
  if (game === null || game.challenge_id === null) return false; // (b)
  if (game.status !== "ready" && game.status !== "live") return false; // (c)
  if (game.white_side === null || player.lichess === null) return false; // (a)
  const seatedAccount = game.white_side === player.side ? game.white_lichess_id : game.black_lichess_id;
  return seatedAccount === player.lichess.id; // (a)
}

/** `required`: seated only when the player's own meeting (D16: one per player) reports this participant joined to
 *  a live session and not left AND its current peer's own report shows the
 *  camera granted and on (T17B fix 2, D2: `seatCameraEvidence`; the preset
 *  enforces nothing — measured). Re-asked on EVERY claim, which is what makes
 *  seatPlayer the freshness check T9 runs immediately before creating a game.
 *
 *  Until the report holds the evidence the answer is `camera_starting`, for
 *  CAMERA_EVIDENCE_DEADLINE_MS from the peer's join; past it, the camera
 *  refusal. A peer-report read that FAILS is waited out the same way and then
 *  rethrown — the outage path (`video_unavailable`), never a seat. A browser
 *  that refused the camera is `camera_blocked` at once.
 *
 *  D21 — the vendor's budget. Re-asked on every claim, except that a camera still STARTING is read on the back-off
 *  schedule (readSlot), not on every claim: a claim between reads is answered from what the last read found, judged
 *  against THIS claim's clock, so the answer never flaps either side of a read. And a request the platform's call budget
 *  refuses is `camera_starting` too — "we could not look", never "no camera" and never an outage. */
async function verifyRequiredSeat(a: SeatAsk, side: Side, now: Date, video: Video): Promise<SeatResult> {
  try {
    // T9's re-verify of a player who never joined: nothing was ever read for them and nobody will join with a token. D16:
    // their meeting is made on their own first arrival, so a re-verify must not make one - it would spend a vendor call, and
    // a row, on a player who is not there. Judged BEFORE `ensureMeeting`.
    if (a.recheck && (await storedPlayerParticipant(sql, { fixtureId: a.fixtureId, side, personId: a.personId })) === null) {
      return { seated: false, reason: "camera_required", participant: null };
    }
    const meeting = await video.ensureMeeting(a.fixtureId, side);
    const have = await playerParticipant(a, side, meeting.meetingId, video, !a.recheck);
    // A participant that vanished between the check above and this read (its meeting was retired): the same answer.
    if (have === null) return { seated: false, reason: "camera_required", participant: null };
    const { participantId, minted } = have;

    // D21-fix-3 (F1): ask the cache FIRST and spend a token LAST. A participant this very claim made cannot have been
    // joined by a peer - nobody had its token - so there is no camera to read: the answer is the way in, and the claim
    // costs the vendor the mint and nothing else.
    const verdict: SeatVerdict =
      minted !== null ? { seated: false, reason: "camera_required" } : await judgeSeat(a, { fixtureId: a.fixtureId, participantId }, meeting.meetingId, now, video);

    if (verdict.seated === false && verdict.reason === "video_unavailable") return verdict;
    // T9's re-verify is read by the server alone: no token, nobody joins with it.
    if (a.recheck) return { ...verdict, participant: null };
    // A camera still starting, asked by a browser that holds this participant's token: it keeps joining with it. Every
    // other answer carries the token - a seat, a refused camera, and a browser that holds none - refreshed NOW, after the
    // verdict, so a claim the budget cut short (or one the cache answered) has spent nothing on it.
    if (verdict.seated === false && verdict.reason === "camera_starting" && a.heldParticipantId === participantId) {
      return { ...verdict, participant: null };
    }
    const participant = minted ?? (await video.refreshParticipantToken({ meetingId: meeting.meetingId, participantId }));
    return { ...verdict, participant };
  } catch (err) {
    // D21: the call budget refused a request.
    if (err instanceof RealtimeKitDeferred) {
      // The only trace a deferral leaves: the request was never made and the player is told "starting". One line a
      // claim, so how often the platform's call budget holds a check-in back can be counted (D22).
      log.info({ fixtureId: a.fixtureId }, "seat: RealtimeKit call budget spent; the seat answered camera_starting, the player asks again");
      // No token: a deferral can only come before the claim has one - the mint is the claim's own token, and the refresh
      // runs only after a verdict (a claim that minted makes no read, so a deferral never meets a minted token).
      return { seated: false, reason: "camera_starting", participant: null, budgetDeferred: true };
    }
    throw err;
  }
}

/** What the camera's evidence says, before any token is attached to it. */
type SeatVerdict =
  | { seated: true }
  | { seated: false; reason: CameraRefusal }
  | { seated: false; reason: "video_unavailable" };

/** The camera's verdict for a participant that has been on file since an earlier claim: a read the cache allows, or the
 *  cache's word. May throw: a RealtimeKit failure (the outage path), a deferral (the budget). */
async function judgeSeat(a: SeatAsk, mine: SeatRead, meetingId: string, now: Date, video: Video): Promise<SeatVerdict> {
  const [prior] = await sql<{ last_publisher_seen_at: Date | null; seat_reads: number }[]>`
    select last_publisher_seen_at, seat_reads from fixture_video_participants
     where fixture_id = ${mine.fixtureId} and participant_id = ${mine.participantId}`;

  // D21-fix-3 (F2): T9's re-verify trusts a pass read a moment ago, without a vendor call - provided no later read has
  // left a not-yet verdict outstanding (`seat_reads > 0`: the camera restarted since). The pass is the stamp the seat
  // itself wrote when it read the camera ON; a trusted pass writes nothing, so it can never make itself younger.
  if (
    a.recheck &&
    prior?.last_publisher_seen_at != null &&
    prior.seat_reads === 0 &&
    Math.abs(now.getTime() - prior.last_publisher_seen_at.getTime()) <= SEAT_RECHECK_TRUST_MS
  ) {
    return { seated: true };
  }

  let camera: SeatCamera;
  let cached = false;
  if (await claimEvidenceRead(mine, now)) {
    camera = await video.seatCameraEvidence({ meetingId, participantId: mine.participantId });
    await recordEvidence(mine, camera);
  } else {
    camera = await cachedEvidence(mine, now);
    cached = true;
  }

  if (camera.state === "blocked") return { seated: false, reason: "camera_blocked" };
  if (camera.state === "starting" || camera.state === "unreadable") {
    // Waited from the peer's OWN join; a vendor clock ahead of ours is a
    // negative wait, which is still inside it.
    const waited = now.getTime() - camera.since.getTime();
    if (waited < CAMERA_EVIDENCE_DEADLINE_MS) return { seated: false, reason: "camera_starting" };
    // Past the deadline an unreadable report is an outage. A claim answered from the cache says so without reporting it
    // again: the read that found it already did.
    if (camera.state === "unreadable") {
      if (cached) return { seated: false, reason: "video_unavailable" };
      throw camera.error;
    }
  }
  if (camera.state === "on") {
    await sql`
      update fixture_video_participants set last_publisher_seen_at = ${now}
       where fixture_id = ${mine.fixtureId} and participant_id = ${mine.participantId}`;
    return { seated: true };
  }
  // `last_publisher_seen_at` is EVIDENCE — when this participant was last verified live — and a player's own claim never
  // seats on it: every such claim re-asks the meeting (or the cache of the last read, which keeps only the two not-yet
  // verdicts, never a pass). The ONE reader that seats on it is T9's re-verify (`recheck`, top of this function): inside
  // SEAT_RECHECK_TRUST_MS of the stamp, and with no later read outstanding (`seat_reads = 0`), it stands without a vendor
  // call (D21-fix-3, F2; the cost is stated at SEAT_RECHECK_TRUST_MS). Nothing clears it. Clearing it on a loss (the
  // brief's design) made a repeat claim with the camera still off answer camera_required, telling a player who HAD passed
  // that they never had.
  const hadPassed = prior?.last_publisher_seen_at != null;
  return { seated: false, reason: hadPassed ? "camera_lost" : "camera_required" };
}

type SeatRead = { fixtureId: string; participantId: string };

/** Claim the right to read this participant's camera at the vendor, in ONE statement so that claims racing each other —
 *  two tabs, T9's freshness check beside a poll, two machines — make one read between them. Allowed when no starting
 *  verdict is outstanding (`seat_reads = 0`: anything definite clears it) or the back-off for the reads so far has
 *  passed. A claim whose clock is BEHIND the stamp is allowed too: a stamp from a machine with a fast clock must not hold
 *  the player off for longer than the wait itself. The wait is the room's own schedule (cameraEvidenceDelayMs's table).
 *
 *  D21-fix (review I1): a cached STARTING verdict is only ever a reason to say "not yet" — it must never become the
 *  basis of a refusal. Past the deadline measured from the cached peer's join, that peer's report is no longer what the
 *  player is: the camera may have come on, or a reload may have made a new peer whose own deadline has barely started.
 *  So once `seat_read_since + deadline` has passed, the wait shrinks to the schedule's FIRST step (a refused player who
 *  presses Check in again reads at most once a second, and always gets a fresh answer), where it would otherwise have
 *  run to the last (8 s). Within the deadline nothing changes: the schedule above. */
async function claimEvidenceRead(r: SeatRead, now: Date): Promise<boolean> {
  const steps = CAMERA_EVIDENCE_BACKOFF_MS as unknown as number[];
  const got = await sql`
    update fixture_video_participants
       set seat_read_at = ${now}::timestamptz, seat_reads = seat_reads + 1
     where fixture_id = ${r.fixtureId} and participant_id = ${r.participantId}
       and (seat_reads = 0
            or ${now}::timestamptz < seat_read_at
            or ${now}::timestamptz >= seat_read_at + (
                 case when seat_read_state = 'starting'
                           and ${now}::timestamptz >= seat_read_since + (${CAMERA_EVIDENCE_DEADLINE_MS}::int * interval '1 millisecond')
                      then ${steps[0]!}::int
                      else (${sql.array(steps)}::int[])[least(seat_reads, ${steps.length})]
                 end * interval '1 millisecond'))
    returning 1`;
  return got.length > 0;
}

/** What a read found, kept for the claims that come before the next is allowed. Only the two NOT-YET verdicts are kept;
 *  anything definite clears the cache, so a seat — or its loss — is never answered from the past. */
async function recordEvidence(r: SeatRead, camera: SeatCamera): Promise<void> {
  if (camera.state === "starting" || camera.state === "unreadable") {
    // A read that finds a DIFFERENT peer than the last one (the player reloaded, so `since` is a new join) is the first
    // read of that peer: the schedule starts again at its first step (D21-fix, I1). Left to run on, a reload after a
    // refusal inherited the old peer's count and waited out its eight seconds for a camera that came up in one.
    await sql`
      update fixture_video_participants
         set seat_read_state = ${camera.state},
             seat_reads = case when seat_read_since is distinct from ${camera.since}::timestamptz then 1 else seat_reads end,
             seat_read_since = ${camera.since}
       where fixture_id = ${r.fixtureId} and participant_id = ${r.participantId}`;
    return;
  }
  await sql`
    update fixture_video_participants
       set seat_reads = 0, seat_read_at = null, seat_read_state = null, seat_read_since = null
     where fixture_id = ${r.fixtureId} and participant_id = ${r.participantId}`;
}

/** The last read's verdict, for a claim that was not allowed to make its own. Nothing recorded yet means the read that
 *  holds the slot has not finished (a claim racing it, or one a deferral cut short): not yet, judged from this claim's
 *  own clock, so it neither seats nor refuses. */
async function cachedEvidence(r: SeatRead, now: Date): Promise<SeatCamera> {
  const [row] = await sql<{ state: string | null; since: Date | null }[]>`
    select seat_read_state as state, seat_read_since as since from fixture_video_participants
     where fixture_id = ${r.fixtureId} and participant_id = ${r.participantId}`;
  // D21-fix (review m5): the claim that was refused a read updated no row, and "no row" is the other thing that reads as
  // zero rows - the participant is GONE (the board was re-paired and its meeting retired, R2-2, between the token and
  // this claim). Answering `starting` for it would hold the player at "checking" for ever; the seat is asked again.
  if (!row) throw meetingReplaced(r.fixtureId);
  if (row.state === "unreadable" && row.since) {
    return { state: "unreadable", since: row.since, error: new RealtimeKitError(503, "unavailable", "the peer report could not be read (cached)") };
  }
  return { state: "starting", since: row.since ?? now };
}

/** THE one place a player's RealtimeKit participant is found or made - and with it the reuse-versus-regenerate policy,
 *  which lives here and nowhere else.
 *
 *  ONE participant per player per fixture: the first claim mints it (its
 *  token comes with it, `minted`); every later claim - a reload, a second tab, T9's
 *  freshness check - finds that same participant, so peer discovery stays on one
 *  `user_id`, and REGENERATES a token for it only when its answer needs one (issuePlayerToken; verifyRequiredSeat decides
 *  after the verdict). Measured 2026-10-09
 *  (rtk-token-regen.log): a regenerated token is a different JWT and does not
 *  invalidate the earlier one, so a second tab does not knock out the first.
 *  Tokens are never stored: a token at rest is a token to leak.
 *
 *  (fixture_id, person_id) is deliberately NOT unique (V451: a second camera
 *  angle is config, not a migration), so two first claims racing (two tabs)
 *  are serialised on the meeting row instead: mint OUTSIDE any transaction
 *  (an open transaction across an HTTP call holds the lock for the round
 *  trip), then, under a short `for update` on the meeting row, store ours
 *  only if nobody stored one first. The loser's minted participant is never
 *  stored and never handed out; the loser finds the winner's (`minted` is null for it).
 *
 *  `mint: false` (T9's re-verify): a player with no participant is `null` - nothing is minted, because nobody would
 *  join with the token. */
type HaveParticipant = { participantId: string; minted: ParticipantToken | null };
async function playerParticipant(a: SeatAsk, side: Side, meetingId: string, video: Video, mint: true): Promise<HaveParticipant>;
async function playerParticipant(a: SeatAsk, side: Side, meetingId: string, video: Video, mint: boolean): Promise<HaveParticipant | null>;
async function playerParticipant(a: SeatAsk, side: Side, meetingId: string, video: Video, mint: boolean): Promise<HaveParticipant | null> {
  const stored = await storedPlayerParticipant(sql, { fixtureId: a.fixtureId, side, personId: a.personId });
  if (stored) return { participantId: stored, minted: null };
  if (!mint) return null;

  const minted = await video.addParticipant({ meetingId, subject: a.personId, preset: "player" });
  const kept = await sql.begin(async (tx) => {
    // R2-2: the mint ran outside any transaction, so the board may have been re-paired, or its meeting retired,
    // while it did. A participant is stored only on the meeting it was minted on, made for the pairing the board
    // has NOW, for a person still in that pairing — never an earlier pairing's player in a new pairing's room, and
    // never a participant id of a retired meeting under its successor's row.
    //
    // D16 (§5.6.5, the review's I3): the person is pinned to THIS row's side entrant. The `in (home, away)` this replaces
    // accepted either side, and a person moved to the OTHER entrant by a roster edit - the pairing untouched, so `samePair`
    // still holds - would have been stored in the side they had left. The two guards refuse different races and neither
    // covers the other: `samePair` is the only one that refuses a re-pair which keeps the claimant on their own side and
    // changes the other side's entrant; the pin is the only one that refuses the roster edit.
    const [m] = await tx<{ meeting_id: string; samePair: boolean; onBoard: boolean }[]>`
      select m.meeting_id,
             (m.home_entrant_id, m.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as "samePair",
             exists (select 1 from entrant_members em
                      where em.person_id = ${a.personId}
                        and em.entrant_id = case m.side when 'home' then f.home_entrant_id else f.away_entrant_id end) as "onBoard"
        from fixture_video_meetings m join fixtures f on f.id = m.fixture_id
       where m.fixture_id = ${a.fixtureId} and m.side = ${side}
         for update of m`;
    if (!m || m.meeting_id !== meetingId || !m.samePair || !m.onBoard) throw meetingReplaced(a.fixtureId);
    const winner = await storedPlayerParticipant(tx, { fixtureId: a.fixtureId, side, personId: a.personId });
    if (winner) return winner;
    await tx`
      insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
      values (${a.fixtureId}, ${side}, ${a.personId}, 'player', ${minted.participantId})`;
    return minted.participantId;
  });
  return { participantId: kept, minted: kept === minted.participantId ? minted : null };
}

/** The caller's token for their participant: the one a first claim minted, else a regenerated one. */
async function issuePlayerToken(a: SeatAsk, side: Side, meetingId: string, video: Video): Promise<ParticipantToken> {
  const have = await playerParticipant(a, side, meetingId, video, true);
  return have.minted ?? video.refreshParticipantToken({ meetingId, participantId: have.participantId });
}

/** R2-2: the board was re-paired, or its meeting replaced, while this seat minted a participant. Nothing was stored;
 *  the seat is asked again (a player no longer on the board is then refused as not_a_player). */
function meetingReplaced(fixtureId: string): HttpError {
  return new HttpError(409, `the video meeting for fixture ${fixtureId} changed while seating — try again`, "VIDEO_MEETING_REPLACED");
}

// The privileged client or one of its transactions (the round-open.ts shape).
type AnySql = postgres.TransactionSql | postgres.Sql;

/** The ONE rule for which participant is a person's on a board (R2-2's lock check and R3-1's snapshot read it). D16: a
 *  person's participant is in THEIR side's meeting, so it is found by `(fixture, side)` and person - never by person alone,
 *  which would name the opponent's meeting's participant for a person who somehow had one on each. */
export async function storedPlayerParticipant(
  db: AnySql,
  a: { fixtureId: string; side: Side; personId: string },
): Promise<string | null> {
  const [row] = await db<{ participant_id: string }[]>`
    select participant_id from fixture_video_participants
     where fixture_id = ${a.fixtureId} and side = ${a.side} and person_id = ${a.personId} and preset = 'player'
     order by created_at, id
     limit 1`;
  return row?.participant_id ?? null;
}

/** A RealtimeKit failure the seat absorbs (as video_unavailable, or as no
 *  tile under `optional`) is still reported — never swallowed silently. The
 *  adapter's messages never carry a token or a response body (T7). */
function reportOutage(err: RealtimeKitError, orgId: string, fixtureId: string, policy: string): void {
  captureError(err, {
    orgId,
    route: "external-play/preflight",
    extra: { fixtureId, policy, status: err.status, code: err.code },
  });
}

/** D11. RealtimeKit unavailable under `required`: an organiser may proceed
 *  without video on one fixture, and the record says who did and why. A video
 *  vendor outage must not cancel a tournament — and must not be silent.
 *
 *  ONE record (controller addendum 2): `fixture_external_play.video_override_at`
 *  is what the seat reads; the who and why live only in `online_chess_audit`
 *  (kind `video_override`), never also in competition_events. Both are written
 *  in one transaction, so a stamp never exists without its record.
 *
 *  Idempotent and FIRST-WRITER-WINS: the reason on the record is the one given
 *  when the decision was actually taken, not whatever a later click re-sent.
 *
 *  Authorisation is the CALLER's: the organiser route (T16) resolves
 *  `actorUserId` from an authorised session. This function trusts it. */
export async function organiserOverrideVideo(a: {
  fixtureId: string;
  actorUserId: string;
  note: string;
}): Promise<void> {
  const note = a.note.trim();
  if (note === "") {
    throw new HttpError(422, "an override needs a reason", "OVERRIDE_NOTE_REQUIRED");
  }
  const f = await loadOnlinePlayFixture(a.fixtureId);
  if (!f) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  // The override exists for ONE situation: video required, RealtimeKit down,
  // on a board still being played. Anywhere else it would be a "proceeded
  // without video" record for a board that never needed video, or is over.
  // Both refusals come before anything is written.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) {
    throw new HttpError(409, "this match can no longer be played", "FIXTURE_NOT_PLAYABLE");
  }
  if ((await fixtureCameraPolicy(a.fixtureId)) !== "required") {
    throw new HttpError(409, "video is not required for this match", "VIDEO_NOT_REQUIRED");
  }
  // Before the open, exactly as on a timed board (review M3): a board with no
  // start time has no basis yet, so its row is minted on a provisional one
  // that the open rebases (invite.ts attachToOpen).
  await ensureBridgeRow(f, { basisIfUnopened: new Date() });
  await sql.begin(async (tx) => {
    // Lock order: the fixture BEFORE the bridge row — the order every seat
    // clear and rebuild takes (stages.ts lockBoardsRefusingOnlineGames). The
    // audit insert below takes KEY SHARE on the fixture; with the bridge row
    // locked first, a clear holding the fixture would deadlock this.
    await tx`select id from fixtures where id = ${a.fixtureId} for share`;
    const claimed = await tx<{ fixture_id: string }[]>`
      update fixture_external_play
         set video_override_at = now(), updated_at = now()
       where fixture_id = ${a.fixtureId} and video_override_at is null
       returning fixture_id`;
    if (claimed.length === 0) return; // already overridden — the first record stands
    await tx`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
      values (${f.orgId}, ${a.fixtureId}, 'video_override', ${a.actorUserId}, ${note})`;
  });
}
