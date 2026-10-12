// State cards 1–8 and the camera-off banner (card 9), as the owner-approved
// canvas draws them (States board, 2026-10-11): a card with an icon, a title,
// a body and, where the state has one, an action at the bottom.
import Link from "next/link";
import type { RoomT } from "./room-copy";

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

const PRIMARY =
  "flex min-h-11 items-center justify-center rounded-[10px] border-0 bg-[#7c3aed] px-4 text-[15px] font-semibold text-white no-underline disabled:opacity-60";
const OUTLINE =
  "flex min-h-11 items-center justify-center rounded-[10px] border border-[#c9bdf0] bg-white px-4 text-[15px] font-semibold text-[#2e1065] no-underline disabled:opacity-60";

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

/** 2 · Camera required, and 3 · Camera dropped at check-in: Try again. */
export function CameraCard({
  dropped,
  busy,
  onRetry,
  t,
}: {
  dropped: boolean;
  busy: boolean;
  onRetry: () => void;
  t: RoomT;
}) {
  return (
    <StateCard
      testId={dropped ? "room-state-camera-lost" : "room-state-camera-required"}
      icon={dropped ? "cameraOff" : "camera"}
      title={t(dropped ? "externalPlay.room.state.cameraLost.title" : "externalPlay.room.state.cameraRequired.title")}
      action={
        <button type="button" data-testid="room-state-retry" className={PRIMARY} disabled={busy} onClick={onRetry}>
          {t("externalPlay.room.state.tryAgain")}
        </button>
      }
    >
      <Body>{t(dropped ? "externalPlay.room.state.cameraLost.body" : "externalPlay.room.state.cameraRequired.body")}</Body>
    </StateCard>
  );
}

/** 4 · Video service down: Check again. */
export function VideoDownCard({ busy, onRetry, t }: { busy: boolean; onRetry: () => void; t: RoomT }) {
  return (
    <StateCard
      testId="room-state-video-down"
      icon="warning"
      title={t("externalPlay.room.state.videoDown.title")}
      action={
        <button type="button" data-testid="room-state-retry" className={OUTLINE} disabled={busy} onClick={onRetry}>
          {t("externalPlay.room.state.checkAgain")}
        </button>
      }
    >
      <Body>{t("externalPlay.room.state.videoDown.body")}</Body>
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
        className="min-h-11 rounded-[10px] border-0 bg-[#713f12] text-[15px] font-semibold text-white"
      >
        {t("externalPlay.room.state.cameraOff.cta")}
      </button>
    </div>
  );
}
