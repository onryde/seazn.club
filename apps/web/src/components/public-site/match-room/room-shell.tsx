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
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlural, useLocale, useT } from "@/components/i18n/dict-provider";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { remainingMs } from "./clock-math";
import { ClocksStrip } from "./clocks-strip";
import { RoomControls } from "./controls";
import { OwnTile } from "./own-tile";
import { PresencePill } from "./presence-pill";
import { CameraNotice } from "./camera-notice";
import { Checkin } from "./checkin";
import { GameOver } from "./game-over";
import { RoomHeader } from "./room-header";
import {
  CameraCard,
  CameraGaveUpNotice,
  CameraOffBanner,
  CameraReconnectingNotice,
  BackToFixture,
  ClosedCard,
  CreatingCard,
  MoveNoticeView,
  NotOpenedCard,
  OffForClubCard,
  RelinkCard,
  RevokedNotice,
  UnavailableCard,
  VideoDownCard,
} from "./room-cards";
import { HeldSeam } from "./room-seams";
import { roomScreen } from "./room-screen";
import { canMove, moveNotice, plyOf, type RoomState } from "./room-state";
import { formatCountdown, formatTimeOfDay, useServerNow } from "./room-time";
import { useRoom } from "./use-room";
import { joinOwnCamera } from "./camera-loader";
import { deliverCameraFault } from "./room-api";
import { useOpponentPresence, useOwnCamera } from "./use-own-camera";
import type { RoomGame, RoomSnapshot } from "./room-snapshot";
import type { RoomT } from "./room-copy";

const Board = dynamic(() => import("./board"), { ssr: false });

/** Re-claims after the camera comes up, before the server's own presence
 *  check sees it publishing (RealtimeKit's presence lags the join). */
const SEAT_RETRY_MS = 1_500;
const SEAT_RETRIES = 3;

function Clocks({
  game,
  snap,
  skewMs,
  onZero,
  held = false,
  seatOnHold = false,
  t,
}: {
  game: RoomGame;
  snap: RoomSnapshot;
  skewMs: number;
  onZero: () => void;
  /** A held board: the times are Lichess's and still shown, but nobody is
   *  told "your move" on a board the room takes no move on. */
  held?: boolean;
  /** Seam A: the viewer's seat is frozen; the clocks still run. */
  seatOnHold?: boolean;
  t: RoomT;
}) {
  const running = game.clockRunning && !game.over;
  const now = useServerNow(skewMs, running ? 100 : null);
  const asOf = game.clockAsOf ? Date.parse(game.clockAsOf) : 0;
  const ms = (colour: "white" | "black") =>
    remainingMs({
      baseMs: colour === "white" ? game.whiteMs : game.blackMs,
      asOfMs: asOf,
      nowMs: now ?? asOf,
      running: running && now !== null && game.turn === colour,
    });
  const toMoveLeft = ms(game.turn);
  useEffect(() => {
    if (running && now !== null && toMoveLeft <= 0) onZero();
  }, [running, now, toMoveLeft, onZero]);
  return (
    <ClocksStrip
      you={{ name: snap.you.name, colour: snap.you.colour, ms: ms(snap.you.colour) }}
      opponent={{ name: snap.opponent.name, colour: snap.opponent.colour, ms: ms(snap.opponent.colour) }}
      turn={game.turn}
      over={game.over || snap.result !== null || held}
      seatOnHold={seatOnHold}
      t={t}
    />
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
}: {
  initial: RoomSnapshot;
  token: string | null;
  /** This page's own path and query, where re-linking Lichess returns to. */
  selfPath: string;
}) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const room = useRoom(initial, token);
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
  const camera = useOwnCamera(participantToken, joinOwnCamera, stamp);
  // The pill reads this client's own meeting join (review I8): no server call.
  const presence = useOpponentPresence(camera, cameraOn ? snap.opponentPresence : null);

  // Re-entry with cameras on: the seat is already ours, but the participant
  // token only ever arrives in a seat answer — claim once, quietly, so the
  // camera rejoins (preflight re-seats a returning player).
  const reentered = useRef(false);
  useEffect(() => {
    if (reentered.current) return;
    reentered.current = true;
    if (cameraOn && snap.you.checkedIn && snap.result === null && snap.game?.over !== true && !snap.onlineChessOff) void room.claim();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  // Camera required: the seat was refused for want of a camera, the camera
  // has come up — take the seat again, a few times while presence catches up.
  const [retries, setRetries] = useState(0);
  const refusedForCamera =
    state.seat !== null && !state.seat.seated && (state.seat.reason === "camera_required" || state.seat.reason === "camera_lost");
  const { claim } = room;
  useEffect(() => {
    if (!refusedForCamera || camera.status !== "live" || state.pending !== null) return;
    if (retries >= SEAT_RETRIES) return;
    const id = setTimeout(() => {
      setRetries((n) => n + 1);
      void claim();
    }, SEAT_RETRY_MS);
    return () => clearTimeout(id);
  }, [refusedForCamera, camera.status, state.pending, retries, claim]);
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

  const tryAgain = useCallback(() => {
    setRetries(0);
    void claim();
  }, [claim]);

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
          relinkHref={relinkHref}
          locale={locale}
          t={t}
          plural={plural}
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
  t,
}: {
  snap: RoomSnapshot;
  camera: ReturnType<typeof useOwnCamera>;
  presence: boolean | null;
  t: RoomT;
}) {
  return (
    <div data-testid="room-tile-strip" className="order-5 flex min-w-0 items-center gap-2.5 md:flex-col md:items-stretch md:gap-3">
      <OwnTile policy={snap.cameraPolicy} stream={camera.stream} t={t} />
      {/* null is "unknown" — not joined, not settled, connection down: no
          pill rather than a "camera off" (review I4). */}
      {presence !== null ? <PresencePill name={snap.opponent.name} cameraLive={presence} t={t} /> : null}
    </div>
  );
}

/** The give-up notice's way back: a fresh page joins afresh (fix round 5). */
const reloadPage = () => location.reload();

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
  relinkHref,
  locale,
  t,
  plural,
  reload = reloadPage,
}: {
  screen: ReturnType<typeof roomScreen>;
  state: RoomState;
  room: ReturnType<typeof useRoom>;
  camera: ReturnType<typeof useOwnCamera>;
  /** The opponent pill: true on camera, false camera off, null no pill. */
  presence?: boolean | null;
  busy: boolean;
  tryAgain: () => void;
  relinkHref: string;
  locale: string;
  t: RoomT;
  plural: ReturnType<typeof usePlural>;
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
  const timeOf = (iso: string | null) => (iso !== null && now !== null ? formatTimeOfDay(iso, locale) : null);
  const countdownTo = (iso: string | null) => (iso !== null && now !== null ? formatCountdown(Date.parse(iso) - now) : null);

  switch (screen.kind) {
    case "unavailable":
      return <UnavailableCard fixtureHref={snap.links.fixture} t={t} />;
    case "offForClub":
      return <OffForClubCard fixtureHref={snap.links.fixture} t={t} />;
    case "revoked": {
      // Seam A (owner-approved canvas): the frozen player's own board as it
      // stands — the clocks still running on Lichess, the board dimmed and
      // read-only, the amber notice and its one action, the way back, and
      // (owner tweak 2) the camera duty on the phone as on the desktop.
      const g = snap.game;
      return (
        <div data-testid="room-revoked" className="flex min-w-0 flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_288px] md:items-start md:gap-6">
          {cameraBanners}
          {g !== null ? (
            <div data-testid="room-clocks-strip" className="order-1 min-w-0 md:col-span-2">
              <Clocks game={g} snap={snap} skewMs={state.skewMs} onZero={() => void room.clockZero()} seatOnHold t={t} />
            </div>
          ) : null}
          {g !== null ? (
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
          ) : null}
          <aside data-testid="room-aside" className="flex min-w-0 flex-col gap-3 max-md:contents md:order-4">
            <div className="order-2 min-w-0">
              <RevokedNotice relinkHref={relinkHref} t={t} />
            </div>
            {policyOn ? <TileStrip snap={snap} camera={camera} presence={presence} t={t} /> : null}
            <BackToFixture href={snap.links.fixture} className="order-6" t={t} />
            {cameraDuty ? (
              <div className="order-7">
                <CameraNotice onHold t={t} />
              </div>
            ) : null}
          </aside>
        </div>
      );
    }
    case "relink":
      return <RelinkCard relinkHref={relinkHref} t={t} />;
    case "notOpened":
      return <NotOpenedCard t={t} />;
    case "cameraRequired":
    case "cameraLost":
      return <CameraCard dropped={screen.kind === "cameraLost"} busy={busy} onRetry={tryAgain} t={t} />;
    case "videoDown":
      return <VideoDownCard busy={busy} onRetry={tryAgain} t={t} />;
    case "creating":
      return <CreatingCard busyIn={screen.retryAt !== null ? countdownTo(screen.retryAt) : null} t={t} />;
    case "closed":
      return <ClosedCard closedAt={timeOf(snap.deadline)} fixtureHref={snap.links.fixture} t={t} />;
    case "checkin":
      return (
        <>
          {gaveUp !== null ? <div className="mb-3.5 md:mx-auto md:w-full md:max-w-md">{gaveUp}</div> : null}
          <Checkin
            snap={snap}
            closesIn={countdownTo(snap.deadline)}
            closesAt={timeOf(snap.deadline)}
            stream={camera.stream}
            cameraOn={camera.status === "live"}
            busy={busy}
            onCheckIn={() => void room.claim()}
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
          <Clocks game={g} snap={snap} skewMs={state.skewMs} onZero={() => void room.clockZero()} held t={t} />
          <div data-testid="room-board" data-ply={plyOf(g)} className="mx-auto w-full max-w-[560px]">
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
          <HeldSeam t={t} />
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
          <div data-testid="room-clocks-strip" className="order-1 min-w-0 md:col-span-2">
            <Clocks game={g} snap={snap} skewMs={state.skewMs} onZero={() => void room.clockZero()} t={t} />
          </div>
          <div data-testid="room-board" data-ply={plyOf(g)} className="order-3 mx-auto w-full min-w-0 max-w-[560px]">
            <Board
              fen={g.fen}
              orientation={snap.you.colour}
              lastMove={g.lastMove}
              movable={canMove(state)}
              syncKey={state.syncKey}
              onMove={(uci) => void room.act({ kind: "move", uci })}
              label={boardLabel(g, false, t)}
              t={t}
            />
          </div>
          <aside data-testid="room-aside" className="flex min-w-0 flex-col gap-3 max-md:contents md:order-4">
            {notice !== null ? <MoveNoticeView kind={notice} className={notice === "invalid" ? "order-4" : "order-2"} t={t} /> : null}
            {policyOn ? <TileStrip snap={snap} camera={camera} presence={presence} t={t} /> : null}
            <div data-testid="room-controls" className="order-6">
              <RoomControls
                ply={plyOf(g)}
                over={g.over}
                you={snap.you.colour}
                drawOfferBy={g.drawOfferBy}
                opponentName={snap.opponent.name}
                busy={busy}
                onAct={(a) => void room.act(a)}
                t={t}
              />
            </div>
            {cameraDuty ? (
              <div className="order-7">
                <CameraNotice t={t} />
              </div>
            ) : null}
          </aside>
        </div>
      );
    }
  }
}
