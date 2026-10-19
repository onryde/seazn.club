"use client";
// SPIKE variant C (owner's pick) - the PHASE-ADAPTIVE round column of the Arbiter Panel. One slot, three jobs, by where the
// round is in a match day:
//   before   - Open round is the only action; one line of readiness, the earlier-round warning when there is one.
//   checkin  - the countdown is the hero (with "N of M checked in" and the round's +5 beside it), then ONLY the boards still
//              waiting, each with who has not arrived and Resend / +5 on its own row; boards past check-in are one count line.
//   playing  - a compact status ("Round 2 · 11 of 12 boards playing"); the Held / Flagged queue rises to the top; the next
//              round's Open round sits in the status card.
// Nothing forks logic: the press, its confirmation, Resend and "+5 min to the round" are `useOpenRound` (the Fixtures tab's
// OpenRoundControl, lifted into a hook), a board's "+5 min" is the arbiter panel's own `decisionRunner`, and the queue is the
// Fixtures tab's `ExternalPlayNeedsResultQueue`. This file only decides what is visible per phase.
//
// SPIKE_COPY: every string below that is not a dictionary key is English only; search "SPIKE_COPY".
import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { boardIsOver, type ArbiterBoard, type ArbiterRound } from "@/lib/arbiter-view";
import type { OpenRoundView } from "@/lib/open-round";
import { formatClock } from "@/components/public-site/match-room/clock-math";
import { ExternalPlayNeedsResultQueue } from "../external-play-needs-result-queue";
import { arbiterDecision, decisionRunner, initialArbiterDecision, type ArbiterDecisionAction, type ArbiterDecisionState } from "../arbiter-decision";
import { BUTTON_QUIET, CHIP_AMBER, MUTED, noticeSentence, SOFT, useFmt, type Fmt } from "../arbiter-flag-cards";
import { boardExtendOffer, extendBoardLabel, extendHelperLine, extendRoundLabel, extendWhyLine } from "../checkin-extend-ui";
import { OpenRoundConfirm, resendNoticeText, useOpenRound, type OpenRoundCtl } from "../desk/open-round-control";
import type { RoundPhase, SpikeRoundData } from "./spike-helpers";

const INK = "text-[#2e1065]";
const CLOCK_FACE = "[font-family:var(--font-barlow,var(--font-geist-sans))] font-semibold tabular-nums";
const PANEL = "min-w-0 rounded-xl border border-[#e7e3f3] bg-white";
const BUTTON_PRIMARY =
  "min-h-11 w-full cursor-pointer rounded-[10px] bg-[#7c3aed] px-3 text-[15px] font-semibold text-white hover:bg-[#5b21b6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed] disabled:cursor-not-allowed disabled:opacity-60";

const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

type Slugs = { org: string; comp: string; div: string };

export function SpikeRoundColumn({
  round,
  data,
  slugs,
  nowMs,
  phase,
}: {
  round: ArbiterRound | null;
  data: SpikeRoundData;
  slugs: Slugs;
  nowMs: number | null;
  phase: RoundPhase;
}) {
  const f = useFmt(nowMs);
  // The round to open next: the first one the division still has paired (the stage's lowest unopened).
  const toOpen = data.rounds.find((r) => r.state === "paired" && !(round !== null && r.stageId === round.stageId && r.roundNo === round.roundNo)) ?? null;
  const q = data.queue;
  const hasQueue = q.held.length + q.flagged.length + q.ownFlagged > 0;
  return (
    <div data-testid="spike-round-column" data-phase={phase} className="flex min-w-0 flex-col gap-3">
      {phase === "before" && (toOpen === null ? <NothingToOpen /> : <BeforeOpen view={toOpen} tz={data.tz} f={f} />)}
      {phase === "checkin" && round !== null && <SpikeCheckInHero />}
      {phase === "playing" && round !== null && <Playing round={round} next={toOpen} tz={data.tz} f={f} />}
      {/* The queue is the actionable thing while boards are being played, so it rises above the status; before that it waits below. */}
      <div className={`empty:hidden ${phase === "playing" && hasQueue ? "order-first" : "order-last"}`}>
        <ExternalPlayNeedsResultQueue held={q.held} flagged={q.flagged} ownFlagged={q.ownFlagged} slugs={slugs} stacked />
      </div>
    </div>
  );
}

function NothingToOpen() {
  return (
    <p data-testid="spike-c-none" className={`${PANEL} m-0 px-4 py-3 text-sm ${MUTED}`}>
      {/* SPIKE_COPY */}No round is paired yet.
    </p>
  );
}

/** The press, its notice and its confirmation: shared by the "before" card and the playing card's "next round". */
function OpenPress({ view, tz, ctl, primary }: { view: OpenRoundView; tz: string; ctl: OpenRoundCtl; primary: boolean }) {
  const { state, dispatch } = ctl;
  return (
    <>
      {ctl.canPress && (
        <button
          type="button"
          data-testid="open-round-cta"
          disabled={state.busy !== null}
          onClick={() => dispatch({ type: "ask" })}
          className={primary ? BUTTON_PRIMARY : `${BUTTON_QUIET} w-full`}
        >
          {primary || view.press !== "open" ? ctl.cta : /* SPIKE_COPY */ `Open round ${view.roundNo}`}
        </button>
      )}
      {ctl.notice !== null && (
        <div role="status" data-testid="open-round-notice" className={`flex min-w-0 flex-col gap-0.5 text-sm ${SOFT}`}>
          {ctl.notice.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
        </div>
      )}
      <OpenRoundConfirm round={view} tz={tz} ctl={ctl} />
    </>
  );
}

// ── before: Open round is the only action ──────────────────────────────────

function BeforeOpen({ view, tz, f }: { view: OpenRoundView; tz: string; f: Fmt }) {
  const ctl = useOpenRound(view, tz);
  const headingId = `spike-c-before-${view.stageId}-${view.roundNo}`;
  return (
    <section aria-labelledby={headingId} data-testid="spike-c-before" className={`${PANEL} flex flex-col gap-3 p-4`}>
      <h2 id={headingId} className="m-0 text-[17px] font-semibold">
        {ctl.msg("runsheet.round.heading", { round: view.roundNo })}
      </h2>
      <p data-testid="spike-c-ready" className={`m-0 text-sm leading-[1.45] ${SOFT}`}>
        {/* SPIKE_COPY */}
        {`${count(view.pairings.length, "board", "boards")} paired · invites go to ${count(ctl.owed, "player", "players")}`}
      </p>
      {view.earlierInPlay.length > 0 && (
        <div role="note" data-testid="spike-c-earlier" className="flex flex-col gap-0.5 rounded-lg bg-[#fef3c7] px-3 py-2 text-[13px] leading-[1.45] text-[#713f12]">
          {view.earlierInPlay.map((e) => (
            <span key={e.roundNo}>{f.plural("runsheet.round.confirmEarlierInPlay", e.games, { round: e.roundNo })}</span>
          ))}
        </div>
      )}
      <OpenPress view={view} tz={tz} ctl={ctl} primary />
    </section>
  );
}

// ── check-in: the countdown in the side column, the waiting boards under the camera ──
// The two halves share ONE state (the press, Resend, the round's +5 and a board's +5), so they are two components reading one
// scope; `SpikeCheckInScope` wraps the whole screen and the arbiter panel places each half where the room is.

type CheckInScope = {
  round: ArbiterRound;
  view: OpenRoundView | null;
  ctl: OpenRoundCtl | null;
  nowMs: number | null;
  f: Fmt;
  dec: ArbiterDecisionState;
  dispatchDec: (a: ArbiterDecisionAction) => void;
  runner: ReturnType<typeof decisionRunner>;
  busy: boolean;
};
const CheckInContext = createContext<CheckInScope | null>(null);
const useCheckIn = (): CheckInScope => {
  const v = useContext(CheckInContext);
  if (v === null) throw new Error("SPIKE: a check-in part rendered outside SpikeCheckInScope");
  return v;
};

export function SpikeCheckInScope({
  round,
  view,
  tz,
  nowMs,
  children,
}: {
  round: ArbiterRound;
  view: OpenRoundView | null;
  tz: string;
  nowMs: number | null;
  children: ReactNode;
}) {
  return view === null ? (
    <ScopeBody round={round} view={null} ctl={null} nowMs={nowMs}>
      {children}
    </ScopeBody>
  ) : (
    <ScopeWithView round={round} view={view} tz={tz} nowMs={nowMs}>
      {children}
    </ScopeWithView>
  );
}

function ScopeWithView({ round, view, tz, nowMs, children }: { round: ArbiterRound; view: OpenRoundView; tz: string; nowMs: number | null; children: ReactNode }) {
  const ctl = useOpenRound(view, tz);
  return (
    <ScopeBody round={round} view={view} ctl={ctl} nowMs={nowMs}>
      {children}
    </ScopeBody>
  );
}

function ScopeBody({ round, view, ctl, nowMs, children }: { round: ArbiterRound; view: OpenRoundView | null; ctl: OpenRoundCtl | null; nowMs: number | null; children: ReactNode }) {
  const router = useRouter();
  const f = useFmt(nowMs);
  // A board's own "+5 min": the arbiter panel's runner on a reducer of this scope's own (as the Held / Flagged queue does), so its
  // answer shows on the row it was sent for.
  const [dec, dispatchDec] = useReducer(arbiterDecision, null, initialArbiterDecision);
  const runner = useMemo(
    () =>
      decisionRunner({
        dispatch: dispatchDec,
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
        overrideNote: "",
      }),
    [router],
  );
  const busy = (ctl?.state.busy ?? null) !== null || dec.busy !== null;
  const value = useMemo(() => ({ round, view, ctl, nowMs, f, dec, dispatchDec, runner, busy }), [round, view, ctl, nowMs, f, dec, runner, busy]);
  return <CheckInContext.Provider value={value}>{children}</CheckInContext.Provider>;
}

/** Who is at the board: a board past check-in has both players in; one still checking in has only who the loader counted. */
function seatsIn(b: ArbiterBoard): { white: boolean; black: boolean } {
  return b.state.kind === "checking_in" ? (b.checkedIn ?? { white: false, black: false }) : { white: true, black: true };
}

/** The side column's half: the countdown (with the round's +5 beside it), who has arrived, and the checked-in boards as one line. */
export function SpikeCheckInHero() {
  const { round, ctl, view, nowMs, f, busy } = useCheckIn();
  const waiting = round.boards.filter((b) => b.state.kind === "checking_in");
  const past = round.boards.length - waiting.length;
  const total = round.boards.length * 2;
  const arrived = round.boards.reduce((n, b) => n + (seatsIn(b).white ? 1 : 0) + (seatsIn(b).black ? 1 : 0), 0);
  // The countdown runs to the NEXT board closing (each board has its own deadline, extension included).
  const closings = waiting.flatMap((b) => (b.checkin === null ? [] : [Date.parse(b.checkin.deadlineAt)]));
  const next = nowMs === null ? null : closings.filter((t) => t > nowMs).sort((a, b) => a - b)[0];
  const closed = nowMs !== null && next === undefined;
  const remaining = nowMs !== null && next !== undefined && next !== null ? next - nowMs : null;
  const urgent = remaining !== null && remaining <= 60_000;
  const headingId = `spike-c-checkin-${round.stageId}-${round.roundNo}`;
  const pct = total === 0 ? 0 : Math.round((arrived / total) * 100);
  return (
    <section aria-labelledby={headingId} data-testid="spike-c-checkin" className={`${PANEL} flex min-w-0 flex-col gap-3 p-4`}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={headingId} className={`m-0 text-[13px] font-normal ${MUTED}`}>
          {/* SPIKE_COPY */}
          {closed ? `Round ${round.roundNo} check-in has closed` : `Round ${round.roundNo} check-in closes in`}
        </h2>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {!closed && (
            <p data-testid="spike-c-countdown" className={`m-0 text-[40px] leading-[1.05] ${CLOCK_FACE} ${urgent ? "text-[#b42318]" : INK}`}>
              {remaining === null ? "–:––" : formatClock(remaining)}
            </p>
          )}
          {ctl !== null && view !== null && ctl.offersExtend && (
            <button
              type="button"
              data-testid="open-round-extend-cta"
              disabled={busy}
              aria-busy={ctl.state.busy?.kind === "extend" || undefined}
              onClick={() => void ctl.runner.extend(view.stageId, view.roundNo)}
              className={`${BUTTON_QUIET} min-w-0 max-sm:grow`}
            >
              {ctl.state.busy?.kind === "extend" ? f.t("externalPlay.checkinExtend.busy") : extendRoundLabel(ctl.copy)}
            </button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p data-testid="spike-c-arrived" className={`m-0 text-sm font-semibold ${INK}`}>
          {/* SPIKE_COPY */}
          {`${arrived} of ${total} checked in`}
        </p>
        <div
          role="progressbar"
          aria-label="Players checked in"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={arrived}
          className="h-1.5 w-full overflow-hidden rounded-full bg-[#f3effc]"
        >
          <div className="h-full rounded-full bg-[#7c3aed]" style={{ width: `${pct}%` }} />
        </div>
        {past > 0 && (
          <p data-testid="spike-c-past" className={`m-0 text-[13px] ${MUTED}`}>
            {/* SPIKE_COPY */}
            {`${count(past, "other board is", "other boards are")} past check-in`}
          </p>
        )}
      </div>
      {ctl !== null && (ctl.offersExtend || ctl.extendLines !== null || ctl.why !== null) && (
        <div data-testid="open-round-extend" className="flex min-w-0 flex-col gap-1">
          {ctl.offersExtend && (
            <p data-testid="open-round-extend-helper" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
              {extendHelperLine(ctl.copy)} {ctl.plural("externalPlay.checkinExtend.roundHint", ctl.reach)}
            </p>
          )}
          {ctl.why !== null && (
            <p data-testid="open-round-extend-why" data-why={ctl.why.code} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
              {ctl.copy.t(ctl.why.key)}
            </p>
          )}
          <div role="status" data-testid="open-round-extend-notice" className={`flex min-w-0 flex-col gap-0.5 text-[13px] leading-[1.45] ${SOFT}`}>
            {(ctl.extendLines ?? []).map((line, i) => (
              <p key={i} className="m-0">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** The other half: only the boards still waiting, who has not arrived, with Resend and a board's +5 on that row. Under the camera on
 *  a tablet or desktop; directly under the countdown on a phone. */
export function SpikeCheckInWaiting() {
  const { round, view, ctl, nowMs, f, dec, dispatchDec, runner, busy } = useCheckIn();
  const waiting = round.boards.filter((b) => b.state.kind === "checking_in");
  return (
    <section data-testid="spike-c-waiting" aria-label="Boards still waiting" className={`${PANEL} min-w-0 overflow-hidden`}>
      <h3 className={`m-0 px-4 pt-3 pb-2 text-[13px] font-semibold ${SOFT}`}>
        {/* SPIKE_COPY */}
        {`Waiting on ${count(waiting.length, "board", "boards")}`}
      </h3>
      <ul className="m-0 flex min-w-0 list-none flex-col p-0">
        {waiting.map((b) => {
          const seats = seatsIn(b);
          const pairing = view?.pairings.find((p) => p.fixtureId === b.fixtureId) ?? null;
          const offer = boardExtendOffer(b.checkin, nowMs);
          const canExtend = offer !== null && offer.offered && b.checkin !== null;
          const why = offer !== null && offer.refusal !== null ? extendWhyLine(offer.refusal, f) : null;
          const resendNotice = ctl?.state.rowNotice?.fixtureId === b.fixtureId ? ctl.state.rowNotice.notice : null;
          const boardNotice = dec.notice?.boardId === b.fixtureId ? noticeSentence(dec.notice, f, false, b.checkin?.deadlineAt ?? null) : null;
          const hasActions = pairing?.canResend === true || canExtend;
          return (
            <li key={b.fixtureId} data-testid={`spike-c-waiting-${b.fixtureId}`} className="flex min-w-0 flex-col gap-2 border-t border-[#e7e3f3] px-4 py-3">
              <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
                <div className="flex min-w-0 flex-col gap-1.5 lg:flex-1">
                  <span className={`text-xs font-semibold ${MUTED}`}>{f.t("arbiter.boardNo", { n: b.boardNo })}</span>
                  {(["white", "black"] as const).map((seat) => (
                    <div key={seat} className="flex min-w-0 items-center justify-between gap-2 lg:justify-start lg:gap-3">
                      <span className={`min-w-0 truncate text-sm ${seats[seat] ? MUTED : `font-semibold ${INK}`}`}>{b[seat].name}</span>
                      {seats[seat] ? (
                        <span className={`shrink-0 text-xs ${MUTED}`}>{/* SPIKE_COPY */}Here</span>
                      ) : (
                        <span className={`${CHIP_AMBER} shrink-0 self-center`}>{/* SPIKE_COPY */}Not here yet</span>
                      )}
                    </div>
                  ))}
                </div>
                {hasActions && (
                  <div className="flex min-w-0 flex-wrap gap-2 lg:w-[270px] lg:shrink-0 lg:flex-nowrap">
                    {ctl !== null && pairing?.canResend === true && (
                      <button
                        type="button"
                        data-testid={`open-round-resend-${b.fixtureId}`}
                        disabled={busy}
                        onClick={() => void ctl.runner.resend(b.fixtureId)}
                        className={`${BUTTON_QUIET} min-w-0 grow`}
                      >
                        {ctl.msg("runsheet.round.resend")}
                      </button>
                    )}
                    {canExtend && b.checkin !== null && (
                      <button
                        type="button"
                        data-testid={`spike-c-extend-${b.fixtureId}`}
                        disabled={busy}
                        aria-busy={(dec.busy?.kind === "extend" && dec.busy.boardId === b.fixtureId) || undefined}
                        onClick={() => {
                          dispatchDec({ type: "select", boardId: b.fixtureId });
                          void runner.extend(b.fixtureId, b.boardNo);
                        }}
                        className={`${BUTTON_QUIET} min-w-0 grow`}
                      >
                        {dec.busy?.kind === "extend" && dec.busy.boardId === b.fixtureId ? f.t("externalPlay.checkinExtend.busy") : extendBoardLabel(b.checkin.extensionsLeft, f)}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {!canExtend && why !== null && <p className={`m-0 text-xs leading-[1.45] ${MUTED}`}>{why}</p>}
              {resendNotice !== null && ctl !== null && (
                <p role="status" data-testid="open-round-row-notice" className={`m-0 text-xs leading-[1.45] ${SOFT}`}>
                  {resendNoticeText(resendNotice, ctl.msg, ctl.plural)}
                </p>
              )}
              {boardNotice !== null && (
                <p role="status" data-testid="spike-c-row-notice" className={`m-0 text-xs leading-[1.45] ${SOFT}`}>
                  {boardNotice}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── before: the paired boards, in the room the empty panel leaves ──────────

/** What an Open round would invite, board by board, so the empty main area earns its room before anything is open. */
export function SpikePairingsPreview({ view }: { view: OpenRoundView }) {
  return (
    <section data-testid="spike-c-pairings" aria-label={`Round ${view.roundNo} boards`} className={`${PANEL} min-w-0 overflow-hidden`}>
      <h3 className={`m-0 px-4 pt-3 pb-2 text-[13px] font-semibold ${SOFT}`}>
        {/* SPIKE_COPY */}
        {`Round ${view.roundNo} boards`}
      </h3>
      <ul className="m-0 grid min-w-0 list-none grid-cols-1 p-0 xl:grid-cols-2">
        {view.pairings.map((pr) => (
          <li key={pr.fixtureId} className="flex min-w-0 flex-col gap-0.5 border-t border-[#e7e3f3] px-4 py-2.5">
            <span className={`text-xs font-semibold ${MUTED}`}>{`Board ${pr.boardNo}`}</span>
            <span className={`min-w-0 truncate text-sm ${INK}`}>
              {pr.whiteName} <span className={MUTED}>vs</span> {pr.blackName}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── playing: a compact status; the queue (above) is the work ───────────────

function Playing({ round, next, tz, f }: { round: ArbiterRound; next: OpenRoundView | null; tz: string; f: Fmt }) {
  const total = round.boards.length;
  const playing = round.boards.filter((b) => b.state.kind === "live" || b.state.kind === "starting").length;
  const held = round.boards.filter((b) => b.state.kind === "on_hold").length;
  const finished = round.boards.filter((b) => boardIsOver(b.state)).length;
  const allOver = finished === total;
  const headingId = `spike-c-playing-${round.stageId}-${round.roundNo}`;
  const aside = [held > 0 ? `${held} on hold` : null, finished > 0 && !allOver ? `${finished} finished` : null].filter((x): x is string => x !== null);
  return (
    <section aria-labelledby={headingId} data-testid="spike-c-playing" className={`${PANEL} flex flex-col gap-2 px-4 py-3`}>
      <h2 id={headingId} data-testid="spike-c-status" className="m-0 text-sm font-semibold">
        {/* SPIKE_COPY */}
        {allOver ? `Round ${round.roundNo} · all ${count(total, "board", "boards")} finished` : `Round ${round.roundNo} · ${playing} of ${count(total, "board", "boards")} playing`}
      </h2>
      {aside.length > 0 && <p className={`m-0 text-[13px] ${MUTED}`}>{aside.join(" · ")}</p>}
      {next !== null && <NextRound view={next} tz={tz} primary={allOver} f={f} />}
    </section>
  );
}

function NextRound({ view, tz, primary }: { view: OpenRoundView; tz: string; primary: boolean; f: Fmt }) {
  const ctl = useOpenRound(view, tz);
  return <OpenPress view={view} tz={tz} ctl={ctl} primary={primary} />;
}
