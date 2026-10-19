"use client";
// The match room (T14): one client island over the room's transport
// (use-room), the player's own camera (use-own-camera) and the screen
// decision (room-screen). Built to the owner-approved canvas (2026-10-11):
//
//   phone   header · [camera-off banner] · clocks · [C1/C2 notice] · board ·
//           [C3 notice] · tile+pill · controls · camera notice — one column,
//           explicit order;
//   ≥ md    header · clocks across both columns · board left (≤ 560px) ·
//           the move notice, tile, pill, controls and notice in a 288px aside.
//
// One DOM, branched at md (AGENTS.md "The phone composition"): the aside
// dissolves into the phone's column (`max-md:contents`) so each of its
// children takes its drawn place by `order-*`; on a desktop it is the right
// column again, in the same order. Seam A (the revoked seat) is built the
// same way. The board is chessground behind its licence loader, client-only.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlural, useLocale, useT } from "@/components/i18n/dict-provider";
import { lichessLinkStartHref, type LichessFailureCode, type LichessFlashCode } from "@/lib/lichess-link";
import { moverFlagAt, optimisticOwnMs, type OptimisticClock } from "./clock-math";
import { ClockBar, ClocksStrip } from "./clocks-strip";
import { SoundToggle, type SoundSwitch } from "./sound-toggle";
import { useClockFaces } from "./use-clock-faces";
import { RoomControls } from "./controls";
import { OwnTile } from "./own-tile";
import { PresencePill, type PresenceState } from "./presence-pill";
import { CameraNotice } from "./camera-notice";
import { Checkin } from "./checkin";
import { GameOver } from "./game-over";
import { RoomHeader } from "./room-header";
import { useRoomSounds, useSoundSwitch } from "./use-room-sounds";
import { useStripLichessParam } from "./use-strip-lichess-param";
import { heldFlashFrom, nextHeldFlash, onFlashScreen } from "./room-held-flash";
import {
  CameraBlockedCard,
  CameraCard,
  CameraGaveUpNotice,
  CameraOffBanner,
  CameraReconnectingNotice,
  BackToFixture,
  ClosedCard,
  BoardClosedCard,
  CreatingCard,
  FlagNotice,
  MoveNoticeView,
  BatchWaitCard,
  NotOpenedCard,
  NoAccountCard,
  OffForClubCard,
  RelinkCard,
  WrongAccountCard,
  RepairingCard,
  RevokedNotice,
  SeatHeldNotice,
  UnavailableCard,
  VideoDownCard,
} from "./room-cards";
import { HeldSeam } from "./room-seams";
import { cameraEnds, roomScreen } from "./room-screen";
import { canMove, cameraRetryDue, moveNotice, ownMeetingRetired, plyOf, type RoomState } from "./room-state";
import { lineOf } from "./line-view";
import { formatCountdown, formatPromisedTime, formatTimeOfDay, useFlagFallen, useServerNow } from "./room-time";
import { useRoom } from "./use-room";
import { joinOwnCamera } from "./camera-loader";
import { deliverCameraFault, deliverCameraReport } from "./room-api";
import { useOwnCamera } from "./use-own-camera";
import { HANDED } from "./camera-test";
import { useCameraTest } from "./use-camera-test";
import { isHandoverActive } from "./camera-handover";
import { useCameraHandover } from "./use-camera-handover";
import { CAMERA_EVIDENCE_MAX_POLLS, SEAT_RETRIES, SEAT_RETRY_MS, cameraEvidenceDelayMs, checkinClosesAt, type RoomGame, type RoomSnapshot } from "./room-snapshot";
import type { RoomT } from "./room-copy";

const Board = dynamic(() => import("./board"), { ssr: false });


/** The pair, side by side above the board: the result state (D24 keeps it as it was). */
function Clocks({
  game,
  snap,
  skewMs,
  onZero,
  t,
}: {
  game: RoomGame;
  snap: RoomSnapshot;
  skewMs: number;
  onZero: () => void;
  t: RoomT;
}) {
  const faces = useClockFaces({ game, snap, skewMs, optimistic: null, onZero });
  return (
    <ClocksStrip
      you={{ name: snap.you.name, colour: snap.you.colour, ms: faces[snap.you.colour] }}
      opponent={{ name: snap.opponent.name, colour: snap.opponent.colour, ms: faces[snap.opponent.colour] }}
      turn={game.turn}
      over={game.over || snap.result !== null}
      t={t}
    />
  );
}

/**
 * T17B fix 2, D24 (owner): while the game is LIVE the board's column is the opponent's clock, the board, the player's
 * clock — by VIEWER, never by colour (the board is already turned to the player's side). Each bar is the board's
 * width: on a phone `className` carries the board's own max width. The sound switch sits in the player's bar. The
 * board (with its own `order-*`) is the child; on a phone this column dissolves into the room's flex column
 * (`contents`) so every piece takes its drawn place by `order`, and on a desktop it is the left column.
 */
function PlayColumn({
  game,
  snap,
  skewMs,
  optimistic,
  onZero,
  held = false,
  seatOnHold = false,
  sound,
  barClassName = "",
  t,
  children,
}: {
  game: RoomGame;
  snap: RoomSnapshot;
  skewMs: number;
  optimistic: OptimisticClock | null;
  onZero: () => void;
  /** A held board: the times are Lichess's and still shown, but nobody is told "your move". */
  held?: boolean;
  /** Seam A: the viewer's seat is frozen; the clocks still run. */
  seatOnHold?: boolean;
  sound: SoundSwitch | null;
  barClassName?: string;
  t: RoomT;
  children: React.ReactNode;
}) {
  const faces = useClockFaces({ game, snap, skewMs, optimistic, onZero });
  const over = game.over || snap.result !== null || held;
  return (
    <div data-testid="room-play-column" className="contents md:mx-auto md:flex md:w-full md:max-w-[560px] md:min-w-0 md:flex-col md:gap-3">
      <ClockBar
        side="opponent"
        who={{ name: snap.opponent.name, colour: snap.opponent.colour, ms: faces[snap.opponent.colour] }}
        turn={game.turn}
        over={over}
        className={`order-1 ${barClassName}`}
        t={t}
      />
      {children}
      <ClockBar
        side="you"
        who={{ name: snap.you.name, colour: snap.you.colour, ms: faces[snap.you.colour] }}
        turn={game.turn}
        over={over}
        seatOnHold={seatOnHold}
        sound={sound ? <SoundToggle sound={sound} t={t} /> : null}
        className={`order-4 ${barClassName}`}
        t={t}
      />
    </div>
  );
}

function boardLabel(game: RoomGame, over: boolean, t: RoomT): string {
  if (over) return t("externalPlay.room.board.final");
  return t(game.turn === "white" ? "externalPlay.room.board.whiteToMove" : "externalPlay.room.board.blackToMove");
}

export function RoomShell({
  initial,
  token,
  selfPath,
  grantRefused = false,
  lichessFlash = null,
}: {
  initial: RoomSnapshot;
  token: string | null;
  /** This page's own path and query, where re-linking Lichess returns to. */
  selfPath: string;
  /** Final review P10: Lichess said, as this page loaded, that the player's grant no longer plays — the re-link
   *  screen shows at once (room.ts `roomGrantDowngraded`, asked by the page). */
  grantRefused?: boolean;
  /** Owner staging test 2026-10-19: how the Lichess link the player just tried went - the `?lichess=<code>` the page
   *  read (lib/lichess-link.ts). Said on the link / re-link card; the parameter is then taken out of the address bar. */
  lichessFlash?: LichessFlashCode | null;
}) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const room = useRoom(initial, token, grantRefused);
  // The outcome is HELD while the page lives: the address bar loses `lichess=` as soon as it has been read, and a refresh
  // of the server page (the stripped address) must not take the sentence off the card it was read for. Only a failure is
  // held, and only for as long as its card stands (room-held-flash.ts): a `linked` landing, or a failure the screen has
  // since moved on from, must never show above a LATER revoke / re-consent card. Adjusted below, once the screen is known.
  const [held, setHeld] = useState(() => heldFlashFrom(lichessFlash));
  useStripLichessParam();
  const { state } = room;
  const snap = state.snap;
  const cameraOn = snap.cameraPolicy !== "off";
  const participantToken = cameraOn ? (state.seat?.participant?.authToken ?? null) : null;
  // Our guard's gap (I-1) is stamped on the caller's OWN seat, by its id.
  const participantId = cameraOn ? (state.seat?.participant?.participantId ?? null) : null;
  const fixtureId = snap.fixtureId;
  const stamp = useCallback(
    (s: "start" | "end") =>
      participantId === null ? Promise.resolve() : deliverCameraFault(fixtureId, token, { state: s, participantId }),
    [participantId, fixtureId, token],
  );
  // The participant id rides along (R3-1): a token for ANOTHER participant is another meeting, and the camera moves.
  // T17B fix 2 (D8a): at the result or the closed card the camera leaves its meeting, and the camera light goes off.
  // D16 (§5.6.3): the camera also reports its own state, for the OPPONENT's pill; a seat in no meeting reports nothing.
  const report = useCallback(
    (s: "live" | "off", heartbeat: boolean) =>
      participantId === null ? Promise.resolve() : deliverCameraReport(fixtureId, token, { state: s, heartbeat }),
    [participantId, fixtureId, token],
  );
  const camera = useOwnCamera(participantToken, joinOwnCamera, stamp, participantId, cameraEnds(state), report);
  // D16: the pill is the opponent's OWN report, relayed by the server: a field of the snapshot, no meeting to read.
  const presence = cameraOn ? snap.opponentCamera : null;
  // T17B fix 2 (D19): move sounds, and their switch (D24: drawn in the player's own clock bar).
  const sound = useSoundSwitch();
  useRoomSounds(state, sound.on);
  // D24: the switch lives in the player's own clock bar, handed to it as a prop.
  const soundSwitch = useMemo<SoundSwitch>(() => ({ on: sound.on, onToggle: sound.toggle }), [sound.on, sound.toggle]);

  // Re-entry with cameras on: the seat is already ours, but the participant
  // token only ever arrives in a seat answer — claim once, quietly, so the
  // camera rejoins (preflight re-seats a returning player).
  const reentered = useRef(false);
  useEffect(() => {
    if (reentered.current) return;
    reentered.current = true;
    if (cameraOn && snap.you.checkedIn && snap.result === null && snap.game?.over !== true && !snap.onlineChessOff && !snap.boardClosed) void room.claim();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  // Camera required: the seat was refused for want of a camera, the camera
  // has come up — take the seat again, a few times while presence catches up.
  // The budget is per participant (R3-1): the camera's join into a NEW meeting
  // (a re-pair's retire moved the seat) gets its own SEAT_RETRIES.
  const [retry, setRetry] = useState<{ for: string | null; n: number }>({ for: null, n: 0 });
  const retries = retry.for === participantId ? retry.n : 0;
  const refusedForCamera =
    state.seat !== null && !state.seat.seated && (state.seat.reason === "camera_required" || state.seat.reason === "camera_lost");
  const { claim } = room;
  useEffect(() => {
    if (!refusedForCamera || camera.status !== "live" || state.pending !== null) return;
    if (retries >= SEAT_RETRIES) return;
    const id = setTimeout(() => {
      setRetry({ for: participantId, n: retries + 1 });
      void claim();
    }, SEAT_RETRY_MS);
    return () => clearTimeout(id);
  }, [refusedForCamera, camera.status, state.pending, retries, participantId, claim]);

  // Final re-review 3, R3-1: the meeting this room's camera joined was retired under the player — a re-pair's
  // newcomer ended it, or a re-open of the round did (m3: the N-2 re-open drops the round's game-less meetings), and
  // its participants went with its row (ownMeetingRetired reads the server's word). Re-claim
  // the seat ONCE per change, quietly, as the re-entry does: the answer's token moves the camera to the new meeting.
  // A refused re-claim leaves the server's answer as it was, so nothing is asked again until that answer changes.
  const retiredKey = ownMeetingRetired(state) ? `${state.seat?.participant?.participantId ?? ""}>${snap.ownParticipantId ?? ""}` : null;
  const reclaimedFor = useRef<string | null>(null);
  useEffect(() => {
    if (retiredKey === null || reclaimedFor.current === retiredKey) return;
    reclaimedFor.current = retiredKey;
    void claim();
  }, [retiredKey, claim]);
  // T17B fix 2 (D2): the seat answered `camera_starting` — joined, the camera's own report not in yet. Re-ask on the
  // back-off schedule (D21: 1, 2, 4, 8 s — a read is four vendor calls, so the wait grows; cameraEvidenceDelayMs is
  // the server's minimum interval too): it is not a terminal card, and the server ends the wait at its deadline. The room's own
  // bound (CAMERA_EVIDENCE_MAX_POLLS, per participant like the retry budget) only stops a disagreeing clock from
  // polling for ever; past it the check-in button is offered again.
  const [startPolls, setStartPolls] = useState<{ for: string | null; n: number }>({ for: null, n: 0 });
  const polls = startPolls.for === participantId ? startPolls.n : 0;
  const cameraStarting = state.seat !== null && !state.seat.seated && state.seat.reason === "camera_starting";
  const checkingCamera = cameraStarting && polls < CAMERA_EVIDENCE_MAX_POLLS;
  useEffect(() => {
    if (!checkingCamera || state.pending !== null) return;
    // `polls` re-asks are done, so the answer in hand is read number polls + 1 (the one that started the wait was 1):
    // the wait is the schedule's step after it.
    const id = setTimeout(() => {
      setStartPolls({ for: participantId, n: polls + 1 });
      void claim();
    }, cameraEvidenceDelayMs(polls + 1));
    return () => clearTimeout(id);
  }, [checkingCamera, state.pending, polls, participantId, claim]);

  // While the camera is coming up and the seat is still being retried, the
  // player stays on the check-in; card 2/3 is for a camera that will not come.
  // Recovering is OUR guard re-joining (I-1), and a give-up is ours too (fix
  // round 5): never the camera-required card — the check-in says reload.
  const cameraSettling =
    camera.status === "joining" ||
    camera.status === "recovering" ||
    camera.status === "gave_up" ||
    (camera.status === "live" && retries < SEAT_RETRIES);
  const screen = roomScreen(state, { cameraSettling });
  // Render-phase adjustment (the sanctioned adjust-state-on-change pattern): the held outcome follows the screen.
  const onCard = onFlashScreen(screen.kind);
  const nextHeld = nextHeldFlash(held, onCard);
  if (nextHeld !== held) setHeld(nextHeld);
  const flash = onCard ? nextHeld.code : null;

  const tryAgain = useCallback(() => {
    setRetry({ for: participantId, n: 0 });
    setStartPolls({ for: participantId, n: 0 });
    void claim();
  }, [participantId, claim]);

  const relinkHref = lichessLinkStartHref(snap.orgSlug, selfPath);
  const busy = state.pending !== null;

  return (
    <div data-testid="match-room" data-screen={screen.kind} className="flex min-h-screen min-w-0 flex-col bg-[#fdfcf8] text-[#2e1065]">
      <RoomHeader snap={snap} t={t} />
      <main className="mx-auto flex w-full min-w-0 max-w-[1040px] flex-1 flex-col px-4 pb-4 pt-3 md:p-6">
        <Screen
          screen={screen}
          state={state}
          room={room}
          camera={camera}
          presence={presence}
          busy={busy}
          tryAgain={tryAgain}
          checkingCamera={checkingCamera}
          startBudgetSpent={cameraStarting && !checkingCamera}
          relinkHref={relinkHref}
          selfPath={selfPath}
          lichessFlash={flash}
          locale={locale}
          t={t}
          plural={plural}
          sound={soundSwitch}
        />
      </main>
      <p className="px-4 pb-3 text-center text-[11px] text-[#6b5b8a] md:px-8">{t("externalPlay.room.pieceCredit")}</p>
    </div>
  );
}

/** The player's own tile and the opponent's pill (any camera policy). */
function TileStrip({
  snap,
  camera,
  presence,
  handover,
  cameraPending = false,
  t,
}: {
  snap: RoomSnapshot;
  camera: ReturnType<typeof useOwnCamera>;
  presence: PresenceState | null;
  /** D23: a quick check-in can reach the board before the SDK's video does — the cover follows the tile. */
  handover: ReturnType<typeof useCameraHandover>;
  /** D21-fix-3: an optional camera seated with no token because the platform's call budget was spent, and the room is
   *  asking again (cameraRetryDue). The tile says so in the words it already has for a camera on its way - never "camera
   *  off", never an error: nothing is wrong, the token is late. */
  cameraPending?: boolean;
  t: RoomT;
}) {
  const covering = isHandoverActive(handover.view) ? handover.view : null;
  return (
    <div data-testid="room-tile-strip" className="order-6 flex min-w-0 items-center gap-2.5 md:flex-col md:items-stretch md:gap-3">
      <OwnTile
        policy={snap.cameraPolicy}
        stream={camera.stream}
        onFrame={covering !== null ? handover.onSdkFrame : undefined}
        videoRef={handover.register}
        frozen={covering?.frame ?? null}
        connecting={covering?.status === "connecting" || cameraPending}
        t={t}
      />
      {/* null is "unknown" — not joined, not settled, connection down: no
          pill rather than a "camera off" (review I4). */}
      {presence !== null ? <PresencePill name={snap.opponent.name} state={presence} t={t} /> : null}
    </div>
  );
}

/** The give-up notice's way back: a fresh page joins afresh (fix round 5). */
const reloadPage = () => location.reload();

/** D23-fix-2: the only screens a hand-over's cover may stand across — the check-in it is born on, the live board it
 *  follows the tile into (a quick check-in beats the SDK's video), and the creating card between the two. On every other
 *  screen — a seam, a card, the result — no tile is coming up for the player, and a cover left standing would resurface
 *  on re-entry as a false "Connecting your camera…". Listed by what it KEEPS, so a screen added later ends it by default. */
const HANDOVER_KEPT_BY_SCREEN: readonly string[] = ["checkin", "live", "creating"];

// Exported for its first-paint test (room-shell.test.tsx): the camera-off
// banner reads the camera hook, which a server render never runs.
export function Screen({
  screen,
  state,
  room,
  camera,
  presence = null,
  busy,
  tryAgain,
  checkingCamera = false,
  startBudgetSpent = false,
  relinkHref,
  selfPath = null,
  lichessFlash = null,
  locale,
  t,
  plural,
  sound = null,
  reload = reloadPage,
}: {
  screen: ReturnType<typeof roomScreen>;
  state: RoomState;
  room: ReturnType<typeof useRoom>;
  camera: ReturnType<typeof useOwnCamera>;
  /** The opponent pill: true on camera, false camera off, null no pill. */
  presence?: PresenceState | null;
  busy: boolean;
  tryAgain: () => void;
  /** T17B fix 2 (D2): the room is re-asking a seat answered `camera_starting`. */
  checkingCamera?: boolean;
  /** D23-fix: the seat answered `camera_starting` and the room's own poll budget on it is spent — nothing left to wait for. */
  startBudgetSpent?: boolean;
  relinkHref: string;
  /** This page's own path and query (the personal link included): where "Switch account" signs back in to. Absent ⇒ the
   *  room's canonical path, which a session identity reads without the link. */
  selfPath?: string | null;
  /** How the Lichess link the player just tried FAILED (`?lichess=`, held by the shell - room-held-flash.ts): said on card 8
   *  and on seam A's notice, the two places that offer the link again. Nothing else draws it, and a success never is one. */
  lichessFlash?: LichessFailureCode | null;
  locale: string;
  t: RoomT;
  plural: ReturnType<typeof usePlural>;
  /** D24: the move-sounds switch, drawn in the player's own clock bar on a live board; none without one. */
  sound?: SoundSwitch | null;
  /** The give-up notice's Reload (a test seam; the page reloads). */
  reload?: () => void;
}) {
  const snap = state.snap;
  // Re-joining gave up (fix round 5): wherever the player is, the one way back.
  const gaveUp = snap.cameraPolicy !== "off" && camera.status === "gave_up" ? <CameraGaveUpNotice onReload={reload} t={t} /> : null;
  const policyOn = snap.cameraPolicy !== "off";
  // The camera DUTY is the required policy's (review I3): under `optional`
  // nobody is told to keep a camera on, or that it is off.
  const cameraDuty = snap.cameraPolicy === "required";
  const cameraDown = cameraDuty && (camera.status === "off" || camera.status === "failed");
  // Above the clocks on a board the player sits at (live, and Seam A).
  const cameraBanners = (
    <>
      {cameraDown ? (
        <div className="order-0 md:col-span-2">
          <CameraOffBanner onEnable={camera.status === "off" ? camera.enable : tryAgain} t={t} />
        </div>
      ) : null}
      {/* OUR guard re-joining (I-1): honest copy, never "camera off". */}
      {policyOn && camera.status === "recovering" ? (
        <div className="order-0 md:col-span-2">
          <CameraReconnectingNotice t={t} />
        </div>
      ) : null}
      {gaveUp !== null ? <div className="order-0 md:col-span-2">{gaveUp}</div> : null}
    </>
  );
  const now = useServerNow(state.skewMs, 1_000);
  // T17B fix 2, D15: the on-page camera test before Check in, camera "required" only. A seat answer that carried a
  // participant token means the SDK has the camera (or is taking it): the test is then over — handed — and never asks.
  const meetingJoined = state.seat?.participant != null;
  const cameraTestOn = snap.cameraPolicy === "required" && !snap.you.checkedIn && !meetingJoined;
  const camTest = useCameraTest(cameraTestOn);
  // T17B fix 2, D23: Check in stops the test camera before the seat is asked for; the tile shows the preview's last
  // frame (kept BEFORE the stop — a stopped track draws black) until the SDK's own video has painted.
  const handover = useCameraHandover();
  const { begin: keepFrame } = handover;
  const testView = camTest.view;
  const testHandOver = camTest.onHandOver;
  const handOver = useCallback(() => {
    // Only a PROVEN preview is on show to keep: a retried Check in (already handed) has the SDK's camera there.
    if (testView.status === "live") keepFrame();
    testHandOver();
  }, [testView.status, keepFrame, testHandOver]);
  // D23-fix m2: the words end when the room knows the camera is not coming, not only on the SDK's frame or the clock —
  // a frozen "Connecting your camera…" over a failed camera, a held board or a result is a false statement. Level
  // triggered (the cover being up is a dependency), so the order of the two facts never matters.
  const { end: endHandover } = handover;
  const handoverActive = isHandoverActive(handover.view);
  // D23-fix-2 (a): nothing is in flight — no seat call out, no camera_starting poll, and no camera on its way (joining,
  // recovering or live; or idle with a meeting's token in hand, about to join). A claim that failed leaves exactly this
  // (seat null, pending cleared, camera idle), and the words used to stand for the full 60 s with the button enabled.
  const cameraComing =
    camera.status === "joining" ||
    camera.status === "recovering" ||
    camera.status === "live" ||
    (camera.status === "idle" && meetingJoined);
  const nothingInFlight = !busy && !checkingCamera && !cameraComing;
  useEffect(() => {
    if (!handoverActive) return;
    if (camera.status === "failed" || camera.status === "gave_up") endHandover("failed");
    else if (!HANDOVER_KEPT_BY_SCREEN.includes(screen.kind)) endHandover("left");
    else if (startBudgetSpent) endHandover("budget");
    else if (nothingInFlight) endHandover("idle");
  }, [handoverActive, camera.status, screen.kind, startBudgetSpent, nothingInFlight, endHandover]);
  // T17B fix 2, D13: the side to move's clock at zero, the game not over — the board and every action lock.
  const flagFallen = useFlagFallen(snap.game === null ? null : moverFlagAt(snap.game), state.skewMs);
  // D24 (re-review I2): the flag is read off the SERVER's numbers, but while the player's own MOVE is in flight their face
  // is the guess (the clock as the drop left it, plus the increment) — "Time's up" over a face reading 0:09.6 contradicts
  // itself, and a move dropped in time is not a clock at zero. The lock stands down while that move is out; a refusal
  // clears it and the server's number is the face again, so the lock reapplies (and the clock-zero report with it:
  // use-clock-faces). Only a move: a resign or an offer in flight is locked as ever.
  // The stand-down is the guess's own life: the move is out (`movePending`) AND, after its answer, until the re-read puts
  // the ply on the ledger (the guess still on the face, `ownGuess`) — "one POST plus a re-read", the review's own span.
  const movePending = state.pending?.kind === "act" && state.pending.action.kind === "move";
  const ownGuess =
    snap.game === null ? null : optimisticOwnMs({ optimistic: state.optimistic, game: snap.game, resultWritten: snap.result !== null, nowMs: now });
  const flagged = flagFallen && !movePending && ownGuess === null;
  const timeOf = (iso: string | null) => (iso !== null && now !== null ? formatTimeOfDay(iso, locale) : null);
  // Spec §6.1 (2): a `queued` seat answer is the check-in card with the line in it.
  const queued = lineOf(state.seat);
  const countdownTo = (iso: string | null) => (iso !== null && now !== null ? formatCountdown(Date.parse(iso) - now) : null);

  switch (screen.kind) {
    case "unavailable":
      return <UnavailableCard fixtureHref={snap.links.fixture} t={t} />;
    case "noAccount":
      return <NoAccountCard fixtureHref={snap.links.fixture} t={t} />;
    case "repairing":
      return <RepairingCard t={t} />;
    case "offForClub":
      return <OffForClubCard fixtureHref={snap.links.fixture} t={t} />;
    case "revoked":
    case "seatHeld": {
      // Seam A (owner-approved canvas): the frozen player's own board as it
      // stands — the clocks still running on Lichess, the board dimmed and
      // read-only, the amber notice and its one action, the way back, and
      // (owner tweak 2) the camera duty on the phone as on the desktop.
      // R2-1: a hold the viewer did not cause keeps the layout, with the
      // neutral notice in A's slot and no action.
      const g = snap.game;
      const mine = screen.kind === "revoked";
      return (
        <div data-testid={mine ? "room-revoked" : "room-seat-held"} className="flex min-w-0 flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_288px] md:items-start md:gap-6">
          {cameraBanners}
          {g !== null ? (
            <PlayColumn
              game={g}
              snap={snap}
              skewMs={state.skewMs}
              optimistic={null}
              onZero={() => void room.clockZero()}
              seatOnHold
              sound={sound}
              barClassName="max-md:mx-auto max-md:w-full max-md:max-w-[240px]"
              t={t}
            >
              <div
                data-testid="room-board"
                data-ply={plyOf(g)}
                data-on-hold="true"
                className="order-3 mx-auto w-full min-w-0 max-w-[240px] opacity-50 [filter:grayscale(0.35)] md:max-w-[560px]"
              >
                <Board
                  fen={g.fen}
                  orientation={snap.you.colour}
                  lastMove={g.lastMove}
                  movable={false}
                  syncKey={state.syncKey}
                  onMove={() => {}}
                  label={t("externalPlay.room.board.seatOnHold")}
                  t={t}
                />
              </div>
            </PlayColumn>
          ) : null}
          <aside data-testid="room-aside" className="flex min-w-0 flex-col gap-3 max-md:contents md:order-4">
            <div className="order-2 min-w-0">
              {mine ? <RevokedNotice relinkHref={relinkHref} otherAccount={snap.otherAccount} flash={lichessFlash} t={t} /> : <SeatHeldNotice t={t} />}
            </div>
            {policyOn ? <TileStrip snap={snap} camera={camera} presence={presence} handover={handover} cameraPending={cameraRetryDue(state)} t={t} /> : null}
            <BackToFixture href={snap.links.fixture} className="order-7" t={t} />
            {cameraDuty ? (
              <div className="order-8">
                <CameraNotice onHold t={t} />
              </div>
            ) : null}
          </aside>
        </div>
      );
    }
    case "relink":
      return <RelinkCard relinkHref={relinkHref} flash={lichessFlash} t={t} />;
    case "wrongAccount":
      return <WrongAccountCard name={snap.you.name} email={screen.viewerEmail} next={selfPath ?? `${snap.links.fixture}/play`} t={t} />;
    case "notOpened":
      return <NotOpenedCard t={t} />;
    case "batchWait":
      return <BatchWaitCard time={snap.opensAt !== null && now !== null ? formatPromisedTime(snap.opensAt, locale) : null} t={t} />;
    case "cameraRequired":
    case "cameraLost":
      return <CameraCard dropped={screen.kind === "cameraLost"} busy={busy} onRetry={tryAgain} seatWaitS={room.seatWaitS ?? null} t={t} />;
    case "cameraBlocked":
      return <CameraBlockedCard onReload={reload} t={t} />;
    case "videoDown":
      return <VideoDownCard busy={busy} onRetry={tryAgain} seatWaitS={room.seatWaitS ?? null} t={t} />;
    case "creating":
      return <CreatingCard busyIn={screen.retryAt !== null ? countdownTo(screen.retryAt) : null} t={t} />;
    case "closed":
      return <ClosedCard closedAt={timeOf(snap.deadline)} fixtureHref={snap.links.fixture} t={t} />;
    case "boardClosed":
      return <BoardClosedCard fixtureHref={snap.links.fixture} t={t} />;
    case "checkin":
      return (
        <>
          {gaveUp !== null ? <div className="mb-3.5 md:mx-auto md:w-full md:max-w-md">{gaveUp}</div> : null}
          <Checkin
            snap={snap}
            closesIn={countdownTo(checkinClosesAt(snap))}
            closesAt={timeOf(checkinClosesAt(snap))}
            stream={camera.stream}
            cameraOn={camera.status === "live"}
            busy={busy}
            checkingCamera={checkingCamera}
            cameraTest={cameraDuty && !snap.you.checkedIn ? { ...camTest, view: meetingJoined ? HANDED : camTest.view, onHandOver: handOver } : null}
            handover={handover}
            cameraPending={cameraRetryDue(state)}
            line={queued === null ? null : { wire: queued, closesAt: timeOf(queued.closesAt), left: state.lineLeft }}
            seatWaitS={room.seatWaitS ?? null}
            onCheckIn={tryAgain}
            t={t}
            plural={plural}
          />
        </>
      );
    case "over": {
      const g = snap.game;
      return (
        <GameOver
          snap={snap}
          clocks={g ? <Clocks game={g} snap={snap} skewMs={state.skewMs} onZero={() => {}} t={t} /> : null}
          board={
            g ? (
              <div data-testid="room-board" className="mx-auto w-full max-w-[560px]">
                <Board
                  fen={g.fen}
                  orientation={snap.you.colour}
                  lastMove={g.lastMove}
                  movable={false}
                  syncKey={state.syncKey}
                  onMove={() => {}}
                  label={boardLabel(g, true, t)}
                  t={t}
                />
              </div>
            ) : null
          }
          t={t}
        />
      );
    }
    case "held": {
      // The board as it truly is: the clocks Lichess is running, the
      // position, nothing movable, and the seam saying why (review I2).
      const g = snap.game!;
      return (
        <div data-testid="room-held" className="flex min-w-0 flex-col gap-3 md:mx-auto md:w-full md:max-w-[560px]">
          <PlayColumn
            game={g}
            snap={snap}
            skewMs={state.skewMs}
            optimistic={null}
            onZero={() => void room.clockZero()}
            held
            sound={sound}
            t={t}
          >
            <div data-testid="room-board" data-ply={plyOf(g)} className="order-3 mx-auto w-full min-w-0 max-w-[560px]">
              <Board
                fen={g.fen}
                orientation={snap.you.colour}
                lastMove={g.lastMove}
                movable={false}
                syncKey={state.syncKey}
                onMove={() => {}}
                label={boardLabel(g, false, t)}
                t={t}
              />
            </div>
          </PlayColumn>
          <div className="order-5">{flagged ? <FlagNotice kind="organiser" t={t} /> : <HeldSeam t={t} />}</div>
        </div>
      );
    }
    case "live": {
      const g = snap.game!;
      // C1–C3 (Seams C): the error the room already records, as the live
      // board's notice — amber above the board, the purple line under it.
      const notice = moveNotice(state);
      return (
        <div className="flex min-w-0 flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_288px] md:items-start md:gap-6">
          {cameraBanners}
          <PlayColumn
            game={g}
            snap={snap}
            skewMs={state.skewMs}
            optimistic={state.optimistic}
            onZero={() => void room.clockZero()}
            held={flagged}
            sound={sound}
            t={t}
          >
            <div data-testid="room-board" data-ply={plyOf(g)} className="order-3 mx-auto w-full min-w-0 max-w-[560px]">
              <Board
                fen={g.fen}
                orientation={snap.you.colour}
                lastMove={g.lastMove}
                movable={canMove(state) && !flagged}
                syncKey={state.syncKey}
                onMove={(uci) => void room.act({ kind: "move", uci })}
                label={boardLabel(g, false, t)}
                t={t}
              />
            </div>
          </PlayColumn>
          <aside data-testid="room-aside" className="flex min-w-0 flex-col gap-3 max-md:contents md:order-4">
            {flagged ? (
              <FlagNotice kind="lichess" className="order-2" t={t} />
            ) : notice !== null ? (
              <MoveNoticeView kind={notice} className={notice === "invalid" ? "order-5" : "order-2"} t={t} />
            ) : null}
            {policyOn ? <TileStrip snap={snap} camera={camera} presence={presence} handover={handover} cameraPending={cameraRetryDue(state)} t={t} /> : null}
            <div data-testid="room-controls" className="order-7">
              <RoomControls
                ply={plyOf(g)}
                over={g.over}
                you={snap.you.colour}
                drawOfferBy={g.drawOfferBy}
                opponentName={snap.opponent.name}
                busy={busy}
                locked={flagged}
                onAct={(a) => void room.act(a)}
                t={t}
              />
            </div>
            {cameraDuty ? (
              <div className="order-8">
                <CameraNotice t={t} />
              </div>
            ) : null}
          </aside>
        </div>
      );
    }
  }
}
