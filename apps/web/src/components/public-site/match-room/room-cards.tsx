// State cards 1–8 and the camera-off banner (card 9), as the owner-approved
// canvas draws them (States board, 2026-10-11): a card with an icon, a title,
// a body and, where the state has one, an action at the bottom.
import Link from "next/link";
import type { RoomT } from "./room-copy";
import { SeatWaitNote } from "./seat-wait-note";

const ICON = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  camera: (
    <>
      <path d="M3 7h12v10H3z" />
      <path d="M15 10l6-3v10l-6-3" />
    </>
  ),
  cameraOff: (
    <>
      <path d="M3 7h12v10H3z" />
      <path d="M15 10l6-3v10l-6-3" />
      <path d="M2 2l20 20" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 1-9 9" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6l12 12" />
    </>
  ),
} as const;

type IconName = keyof typeof ICON;
const ICON_COLOUR: Record<IconName, string> = {
  clock: "#7c3aed",
  camera: "#7c3aed",
  cameraOff: "#b45309",
  warning: "#b45309",
  spinner: "#7c3aed",
  lock: "#6b5b8a",
  blocked: "#6b5b8a",
};

// T17B fix 2 (D7): the hand on every button (Tailwind v4 preflight gives <button> the arrow); never on a disabled one.
const PRIMARY =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-[#7c3aed] px-4 text-[15px] font-semibold text-white no-underline disabled:cursor-not-allowed disabled:opacity-60";
const OUTLINE =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] border border-[#c9bdf0] bg-white px-4 text-[15px] font-semibold text-[#2e1065] no-underline disabled:cursor-not-allowed disabled:opacity-60";

export function StateCard({
  testId,
  icon,
  title,
  children,
  action,
}: {
  testId: string;
  icon: IconName | null;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="mx-auto flex min-h-[264px] w-full max-w-md flex-col gap-2.5 rounded-[14px] border border-[#e7e3f3] bg-[#fdfcf8] p-4 text-[#2e1065]"
    >
      {icon ? (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke={ICON_COLOUR[icon]}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {ICON[icon]}
        </svg>
      ) : null}
      <h1 className="m-0 text-[17px] font-semibold">{title}</h1>
      {children}
      {action ? <div className="mt-auto flex flex-col pt-2">{action}</div> : null}
    </section>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-sm leading-[1.45] text-[#4a3a6b]">{children}</p>;
}

/** 1 · Round not opened. */
export function NotOpenedCard({ t }: { t: RoomT }) {
  return (
    <StateCard testId="room-state-not-opened" icon="clock" title={t("externalPlay.room.state.notOpened.title")}>
      <Body>{t("externalPlay.room.state.notOpened.body")}</Body>
    </StateCard>
  );
}

/** Spec §6.1 (1): the round is open and this board's check-in group has not opened yet. `time` is the board's own opening,
 *  in the viewer's zone and rounded up to the minute, or null before mount (a time-of-day never renders on the server). */
export function BatchWaitCard({ time, t }: { time: string | null; t: RoomT }) {
  return (
    <StateCard testId="room-state-batch-wait" icon="clock" title={t("externalPlay.room.state.batchWait.title")}>
      {time !== null ? (
        <p data-testid="room-batch-wait-time" className="m-0 text-[22px] font-semibold leading-tight tabular-nums text-[#7c3aed]">
          {t("externalPlay.room.state.batchWait.time", { time })}
        </p>
      ) : null}
      <Body>{t("externalPlay.room.state.batchWait.body", { time: time ?? "" })}</Body>
    </StateCard>
  );
}

/** 2 · Camera required, and 3 · Camera dropped at check-in: Try again. */
export function CameraCard({
  dropped,
  busy,
  onRetry,
  seatWaitS = null,
  t,
}: {
  dropped: boolean;
  busy: boolean;
  onRetry: () => void;
  /** Spec §6.1 (3): whole seconds left of the seat door's 429 wait, or null. The button is shut for as long as it runs. */
  seatWaitS?: number | null;
  t: RoomT;
}) {
  return (
    <StateCard
      testId={dropped ? "room-state-camera-lost" : "room-state-camera-required"}
      icon={dropped ? "cameraOff" : "camera"}
      title={t(dropped ? "externalPlay.room.state.cameraLost.title" : "externalPlay.room.state.cameraRequired.title")}
      action={
        <button type="button" data-testid="room-state-retry" className={PRIMARY} disabled={busy || seatWaitS !== null} onClick={onRetry}>
          {t("externalPlay.room.state.tryAgain")}
        </button>
      }
    >
      <Body>{t(dropped ? "externalPlay.room.state.cameraLost.body" : "externalPlay.room.state.cameraRequired.body")}</Body>
      <SeatWaitNote remainingS={seatWaitS} t={t} />
    </StateCard>
  );
}

/** T17B fix 2 (D2) · The browser refused the camera. Try again cannot cure it — the refusal is on this page's
 *  connection — so the one action is to reload once the camera is allowed. */
export function CameraBlockedCard({ onReload, t }: { onReload: () => void; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-camera-blocked"
      icon="cameraOff"
      title={t("externalPlay.room.state.cameraBlocked.title")}
      action={
        <button type="button" data-testid="room-state-reload" className={PRIMARY} onClick={onReload}>
          {t("externalPlay.room.state.cameraBlocked.reload")}
        </button>
      }
    >
      <Body>{t("externalPlay.room.state.cameraBlocked.body")}</Body>
    </StateCard>
  );
}

/** 4 · Video service down: Check again. */
export function VideoDownCard({
  busy,
  onRetry,
  seatWaitS = null,
  t,
}: {
  busy: boolean;
  onRetry: () => void;
  /** Spec §6.1 (3): see CameraCard. */
  seatWaitS?: number | null;
  t: RoomT;
}) {
  return (
    <StateCard
      testId="room-state-video-down"
      icon="warning"
      title={t("externalPlay.room.state.videoDown.title")}
      action={
        <button type="button" data-testid="room-state-retry" className={OUTLINE} disabled={busy || seatWaitS !== null} onClick={onRetry}>
          {t("externalPlay.room.state.checkAgain")}
        </button>
      }
    >
      <Body>{t("externalPlay.room.state.videoDown.body")}</Body>
      <SeatWaitNote remainingS={seatWaitS} t={t} />
    </StateCard>
  );
}

/** 5 · Both in, game being created; Lichess busy carries its countdown. */
export function CreatingCard({ busyIn, t }: { busyIn: string | null; t: RoomT }) {
  return (
    <StateCard testId="room-state-creating" icon="spinner" title={t("externalPlay.room.state.bothIn.title")}>
      <Body>{t("externalPlay.room.state.bothIn.body")}</Body>
      {busyIn !== null ? (
        <div
          data-testid="room-state-busy"
          role="status"
          className="mt-auto rounded-[10px] bg-[#f3effc] px-3 py-2.5 text-[13px] leading-[1.4] text-[#4a3a6b]"
        >
          {t("externalPlay.room.state.busy", { time: busyIn })}
        </div>
      ) : null}
    </StateCard>
  );
}

/** 6 · Check-in closed. */
/** T17B fix 2 (D10): the organiser closed this board before any game (a No result, then voided). No game will be
 *  set up here; a replay — a Swiss re-pair — opens it here again, and the room keeps reading so it picks that up. */
export function BoardClosedCard({ fixtureHref, t }: { fixtureHref: string; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-board-closed"
      icon="lock"
      title={t("externalPlay.room.state.boardClosed.title")}
      action={
        <Link href={fixtureHref} className={OUTLINE} data-testid="room-back-to-fixture">
          {t("externalPlay.room.backToFixture")}
        </Link>
      }
    >
      <Body>{t("externalPlay.room.state.boardClosed.body")}</Body>
    </StateCard>
  );
}

export function ClosedCard({ closedAt, fixtureHref, t }: { closedAt: string | null; fixtureHref: string; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-closed"
      icon="lock"
      title={t("externalPlay.room.state.closed.title")}
      action={
        <Link href={fixtureHref} className={OUTLINE} data-testid="room-back-to-fixture">
          {t("externalPlay.room.backToFixture")}
        </Link>
      }
    >
      {closedAt !== null ? <Body>{t("externalPlay.room.state.closed.body", { time: closedAt })}</Body> : null}
    </StateCard>
  );
}

/** 7 · Not available to you (a stranger, a bad link, a finished board). */
export function UnavailableCard({ fixtureHref, t }: { fixtureHref: string | null; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-unavailable"
      icon="blocked"
      title={t("externalPlay.room.state.unavailable.title")}
      action={
        fixtureHref ? (
          <Link href={fixtureHref} className={OUTLINE} data-testid="room-back-to-fixture">
            {t("externalPlay.room.backToFixture")}
          </Link>
        ) : undefined
      }
    >
      <Body>{t("externalPlay.room.state.unavailable.body")}</Body>
    </StateCard>
  );
}

/** Fix round 4b · the organiser is re-pairing the round: the board names nobody for now. A wait on the organiser,
 *  like card 1 (its clock), with nothing for the player to do — the room reads on and moves by itself. */
export function RepairingCard({ t }: { t: RoomT }) {
  return (
    <StateCard testId="room-state-repairing" icon="clock" title={t("externalPlay.room.state.repairing.title")}>
      <Body>{t("externalPlay.room.state.repairing.body")}</Body>
    </StateCard>
  );
}

/** 8 · Lichess needs re-linking: the account page's own consent copy. */
export function RelinkCard({ relinkHref, t }: { relinkHref: string; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-relink"
      icon={null}
      title={t("settings.account.lichess.consent.title")}
      action={
        <a href={relinkHref} className={PRIMARY} data-testid="room-relink">
          {t("settings.account.lichess.consent.cta")}
        </a>
      }
    >
      <p className="m-0 text-xs leading-[1.45] text-[#4a3a6b]">{t("settings.account.lichess.consent.body")}</p>
      <p className="m-0 text-xs leading-[1.4] text-[#6b5b8a]">{t("settings.account.lichess.consent.scopes")}</p>
    </StateCard>
  );
}

/** 9 · Your camera off mid-game: a banner ABOVE the clocks; the board plays on. */
/** OUR safeguard took the camera out of the meeting and is re-joining
 *  (T14 re-review 3, I-1): the camera-off banner's amber, one line, no
 *  action — nothing here is the player's to fix, and nothing is "off". */
export function CameraReconnectingNotice({ t }: { t: RoomT }) {
  return (
    <div
      data-testid="room-camera-reconnecting"
      role="status"
      className="rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[13px] leading-[1.45] text-[#713f12]"
    >
      {t("externalPlay.room.state.cameraReconnecting")}
    </div>
  );
}

/** Re-joining kept failing (fix round 5, ruling 2): ours, and the way back
 *  is a reload — never "your camera is off". */
export function CameraGaveUpNotice({ onReload, t }: { onReload: () => void; t: RoomT }) {
  return (
    <div
      data-testid="room-camera-gave-up"
      role="status"
      className="flex flex-col gap-2.5 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12]"
    >
      <span className="text-[13px] leading-[1.45]">{t("externalPlay.room.state.cameraGaveUp.body")}</span>
      <button
        type="button"
        data-testid="room-camera-reload"
        onClick={onReload}
        className="min-h-11 cursor-pointer rounded-[10px] border-0 bg-[#713f12] text-[15px] font-semibold text-white"
      >
        {t("externalPlay.room.state.cameraGaveUp.reload")}
      </button>
    </div>
  );
}

export function CameraOffBanner({ onEnable, t }: { onEnable: () => void; t: RoomT }) {
  return (
    <div
      data-testid="room-camera-off"
      role="status"
      className="flex flex-col gap-2.5 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12]"
    >
      <span className="text-[15px] font-semibold">{t("externalPlay.room.state.cameraOff.title")}</span>
      <span className="text-[13px] leading-[1.45]">{t("externalPlay.room.state.cameraOff.body")}</span>
      <button
        type="button"
        data-testid="room-camera-on"
        onClick={onEnable}
        className="min-h-11 cursor-pointer rounded-[10px] border-0 bg-[#713f12] text-[15px] font-semibold text-white"
      >
        {t("externalPlay.room.state.cameraOff.cta")}
      </button>
    </div>
  );
}

// ── Seams A, B and C (owner-approved canvas, "Room states", 2026-10-12) ──

/** The canvas's line icons for the room states (24-unit grid, stroke 2). */
function LineIcon({ size, colour, className, children }: { size: number; colour: string; className?: string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colour}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}
const INFO = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </>
);
const OFFLINE = (
  <>
    <path d="M2 2l20 20" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0" />
    <path d="M5 12.9a10 10 0 0 1 5.2-2.8" />
    <path d="M19 12.9a10 10 0 0 0-2.3-1.6" />
    <path d="M12 20h.01" />
  </>
);
const RESTORED = (
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </>
);

/** T17B fix 2, D13: the side to move's clock is at zero and the game is not
 *  over — the room takes nothing more and says who settles it: Lichess (a live
 *  board; reconcile asks it, D11) or the organiser (a held board). Between the
 *  clocks and the controls, where the move notices sit. */
export function FlagNotice({ kind, className = "", t }: { kind: "lichess" | "organiser"; className?: string; t: RoomT }) {
  return (
    <div
      data-testid="room-flag-notice"
      data-kind={kind}
      role="status"
      aria-live="polite"
      className={`flex min-w-0 items-start gap-2.5 rounded-xl border border-[#c9bdf0] bg-[#f3effc] px-3 py-2.5 text-[#2e1065] ${className}`}
    >
      <LineIcon size={18} colour="#5b21b6" className="mt-px shrink-0">
        {ICON.clock}
      </LineIcon>
      <span className="min-w-0 text-sm font-semibold leading-[1.35]">
        {t(kind === "lichess" ? "externalPlay.room.flag.lichess" : "externalPlay.room.flag.organiser")}
      </span>
    </div>
  );
}

/** A · Your Lichess link was revoked: the amber notice with the one thing
 *  that is the player's to do — link Lichess again. */
/** A's notice. `otherAccount` (T14 re-review 5, I-2): the game is on another
 *  Lichess account than the one linked — nothing was revoked and no organiser
 *  was told, so the account's own line stands in for those words; the action
 *  (re-link) is the same. The line names the account the game IS on (re-review
 *  6, N-2): Lichess links whichever account the browser is signed in to. The
 *  name wraps anywhere, never truncates — it is what the player signs in with. */
export function RevokedNotice({ relinkHref, otherAccount = null, t }: { relinkHref: string; otherAccount?: string | null; t: RoomT }) {
  return (
    <div
      data-testid="room-revoked-notice"
      data-reason={otherAccount !== null ? "account" : "revoked"}
      role="status"
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12] md:gap-2 md:p-3.5"
    >
      {otherAccount !== null ? (
        <span data-testid="room-revoked-account" className="min-w-0 text-[15px] font-semibold leading-[1.35] [overflow-wrap:anywhere] md:text-base">
          {t("externalPlay.room.state.revoked.otherAccount", { username: otherAccount })}
        </span>
      ) : (
        <>
          <span className="text-[15px] font-semibold leading-[1.35] md:text-base">{t("externalPlay.room.state.revoked.title")}</span>
          <span className="text-[13px] leading-[1.45] md:text-sm">{t("externalPlay.room.state.revoked.body")}</span>
        </>
      )}
      <a
        href={relinkHref}
        data-testid="room-revoked-relink"
        className="mt-1 flex min-h-11 items-center justify-center rounded-[10px] bg-[#713f12] px-4 text-[15px] font-semibold text-white no-underline"
      >
        {t("externalPlay.room.state.revoked.relink")}
      </a>
    </div>
  );
}

/** A's slot for a seat hold the viewer did NOT cause (final re-review 2, R2-1): both seats frozen, or the
 *  opponent's change before a game existed. The held seam's own words — the board is with the organiser — in the
 *  room's neutral palette, not A's amber, and NO action: nothing here is the viewer's to do, and a re-link lifts no
 *  hold. Same box as A's notice, so the column and the aside keep their rhythm. */
export function SeatHeldNotice({ t }: { t: RoomT }) {
  return (
    <div
      data-testid="room-seat-held-notice"
      role="status"
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[#e7e3f3] bg-white p-3 text-[#2e1065] md:gap-2 md:p-3.5"
    >
      <span className="text-[15px] font-semibold leading-[1.35] md:text-base">{t("externalPlay.room.state.held.title")}</span>
      <span className="text-[13px] leading-[1.45] text-[#4a3a6b] md:text-sm">{t("externalPlay.room.state.held.body")}</span>
    </div>
  );
}

/** The room's way back to the fixture, as a full button (A, B). */
export function BackToFixture({ href, className = "", t }: { href: string; className?: string; t: RoomT }) {
  return (
    <Link href={href} className={`${OUTLINE} ${className}`} data-testid="room-back-to-fixture">
      {t("externalPlay.room.backToFixture")}
    </Link>
  );
}

/** B · Online chess off: one calm white card — no board, camera or clocks. */
export function OffForClubCard({ fixtureHref, t }: { fixtureHref: string; t: RoomT }) {
  return (
    <section
      data-testid="room-off-for-club"
      className="mx-auto mt-1 flex w-full min-w-0 max-w-[520px] flex-col gap-2.5 rounded-[14px] border border-[#e7e3f3] bg-white p-4 text-[#2e1065] md:mt-12 md:gap-3 md:p-7"
    >
      <LineIcon size={28} colour="#7c3aed" className="md:h-8 md:w-8">
        {INFO}
      </LineIcon>
      <h1 className="m-0 text-[17px] font-semibold leading-[1.35] md:text-xl">{t("externalPlay.room.state.offForClub.title")}</h1>
      <p className="m-0 text-sm leading-[1.45] text-[#4a3a6b] md:text-[15px] md:leading-normal">{t("externalPlay.room.state.offForClub.body")}</p>
      <BackToFixture href={fixtureHref} className="mt-1.5 md:mt-2 md:min-w-[200px] md:self-start" t={t} />
    </section>
  );
}

/** C1–C3 · The live room's move notices: offline and refused in amber, an
 *  invalid move as the purple inline line. `className` places it (order). */
export function MoveNoticeView({ kind, className = "", t }: { kind: "offline" | "refused" | "invalid" | "failed"; className?: string; t: RoomT }) {
  if (kind === "invalid") {
    return (
      <p
        data-testid="room-move-notice"
        data-kind="invalid"
        role="status"
        className={`m-0 flex min-h-9 min-w-0 items-center gap-2 rounded-[10px] bg-[#f3effc] px-3 py-2 text-[13px] leading-[1.4] text-[#4a3a6b] ${className}`}
      >
        <LineIcon size={16} colour="#5b21b6" className="shrink-0">
          {INFO}
        </LineIcon>
        <span className="min-w-0">{t("externalPlay.room.notice.invalid")}</span>
      </p>
    );
  }
  const offline = kind === "offline";
  if (kind === "failed") {
    // The generic C2 (notice routing ruling): C2's style and place, one line.
    return (
      <div
        data-testid="room-move-notice"
        data-kind="failed"
        role="status"
        className={`flex min-w-0 items-start gap-2.5 rounded-xl border border-[#f5d27a] bg-[#fef3c7] px-3 py-2.5 text-[#713f12] ${className}`}
      >
        <LineIcon size={18} colour="#713f12" className="mt-px shrink-0">
          {RESTORED}
        </LineIcon>
        <span className="min-w-0 text-sm font-semibold leading-[1.35]">{t("externalPlay.room.notice.failed")}</span>
      </div>
    );
  }
  return (
    <div
      data-testid="room-move-notice"
      data-kind={kind}
      role="status"
      className={`flex min-w-0 items-start gap-2.5 rounded-xl border border-[#f5d27a] bg-[#fef3c7] px-3 py-2.5 text-[#713f12] ${className}`}
    >
      <LineIcon size={18} colour="#713f12" className="mt-px shrink-0">
        {offline ? OFFLINE : RESTORED}
      </LineIcon>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold leading-[1.35]">
          {t(offline ? "externalPlay.room.notice.offline.title" : "externalPlay.room.notice.refused.title")}
        </span>
        <span className="text-[13px] leading-[1.4]">
          {t(offline ? "externalPlay.room.notice.offline.body" : "externalPlay.room.notice.refused.body")}
        </span>
      </div>
    </div>
  );
}
