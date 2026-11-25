"use client";

import { Fragment, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, Copy, ExternalLink, Info, RefreshCw, RotateCcw, TriangleAlert, X } from "lucide-react";
import { resolveTemplate } from "@/components/overlay/template-registry";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { ChannelSafetyNotice } from "@/components/v2/stream-channel-safety";
import { FixtureDestinationPicker } from "../fixture-destination-picker";
import { platformName } from "../stream-platform-mark";
import { YoutubeIcon } from "../youtube-icon";
import { ReplayCopyButton } from "../stream-replay-copy";
import { SeaznReplaysCard, type SeaznReplayActions } from "../seazn-replays-card";
import { REFUSAL_FOCUS_RING, focusRefusalBlock } from "../refusal-focus";
import { targetName, youtubeTargetLabel } from "../youtube-connect-panel";
import { D3Warning, PhoneStripView, SignalChain } from "../stream-signal-chain";
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage, SeaznQrPlaceholder } from "../seazn-qr-image";
import { OpenInAppHint, OpenInAppRow } from "../open-in-app";
import { ScoreLiveSummary } from "../stream-score-settings";
import type { MessageKey } from "@/lib/messages";
import type { Currency } from "@/lib/currency";
import { chainFor, phoneDot } from "@/lib/stream-chain";
import { effectiveStreamMode } from "@/lib/stream-settings";
import { seaznQrModules } from "@/lib/seazn-qr";
import { clientOrigin, streamAppLink } from "@/lib/open-in-app";
import { streamHintKey, streamHintNeeds } from "@/lib/open-in-app-hint";
import type { StreamPackSize } from "@/lib/stream-credit-packs";
import {
  END_REASON_KEYS,
  failReasonKey,
  canGoLive,
  createErrorText,
  d3Warning,
  autoDestinationOf,
  autoRefusalStrip,
  AUTO_WONT_START_KEY,
  autoSwitchNote,
  autoStopIsSeazn,
  autoStopLine,
  autoStopWait,
  elapsedLabel,
  healthChips,
  phoneDetails,
  phoneStrip,
  takeoverLineKey,
  takeoverNotice,
  phoneTabState,
  readyStateOf,
  restartLine,
  YOUTUBE_REFUSAL_FIX,
  youtubeRefusalOf,
  youtubeStatusLineOf,
  type YoutubeLink,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { fmtNumber, fmtTime } from "@/lib/format";
import { useStreamingHref } from "@/components/use-org-paths";
import { isYoutubeUrl, linkIsOneOfParts, replayRows } from "@/lib/youtube";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamPhone, StreamSessionCurrent } from "@/server/api-v1/schemas";
import type { StreamCreditSplit, CodeCard, TargetsState, CreateError, PhoneScore, CheckoutError } from "./types";
import { switchedOff, statePill, stopError, seatPausedNote } from "./shared";
import { creditsCard, shownSplit, balancePart, buyMorePart } from "./credits";

const LINK = "font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700";

export interface PhoneTabBodyProps {
  /** m12: scopes the picker's DOM id, so two mounted panels never share one. */
  fixtureId: string;
  view: StreamSessionView | null;
  /** Task 26: the Seazn replays card's Delete (useSeaznReplayActions) — which part is being deleted, which failed to, the parts
   *  deleted here, and the action. */
  replayActions: SeaznReplayActions;
  balance: number;
  /** Task 14b (R4): the page's split of the balance by bucket. Shown as "{m} free this month · {p} bought" under the
   *  chip only while the org holds free credits AND the split still adds up to `balance` — once a session's projection
   *  moves the balance, the page's split is stale and says nothing rather than something wrong. */
  split: StreamCreditSplit | null;
  /** Task 14b (R4): the plan's free match credits per month; the credits card's note names it. None below 1. */
  monthlyAllowance: number;
  /** W19: the server's phone-lost window in whole minutes (StreamPanelContext.phoneLostMinutes) — the `phone_lost` end
   *  chip names it. */
  phoneLostMinutes: number;
  /** PR-2 T10 (§7.1): the auto stop's delay in whole minutes (StreamPanelContext.autoStopMinutes) — the switch's caption
   *  and Live's read-only line name it. */
  autoStopMinutes: number;
  /** Task 34: the code's paste field and Copy show under the QR (StreamPanelContext.pasteCodeShown). Off, the QR is the card. */
  pasteCodeShown: boolean;
  /** PR-2 T10: the switch's flip while its save is in flight (what was asked), else null — the read model answers. */
  autoPending: boolean | null;
  /** PR-2 T10: the last flip did not save — the switch shows the server's answer again, and a line says so. */
  autoFailed: boolean;
  onToggleAuto: (on: boolean) => void;
  /** PR-2 T12 (§7.5): the takeover instant this viewer dismissed (null: none) — that takeover's notice stays hidden. */
  takeoverDismissedAt: string | null;
  onDismissTakeover: (at: string) => void;
  /** PR-2 T12: the venue zone — the takeover notice's time is on the row's clock. */
  tz: string;
  /** The org's destinations (T8): loading, a failed read (Retry), or the list — managed in Directory, picked here. */
  targets: TargetsState;
  busy: boolean;
  createError: CreateError | null;
  checkoutError: CheckoutError | null;
  selectedTargetId: string | null;
  /** Capture QR v2 §6.12: the `stream-phone` read model — null until a read has answered (or while every read fails). */
  phone: StreamPhone | null;
  /** The fixture's stream code, for the code card and "Show the code again". */
  code: CodeCard;
  /** "Show the code again" is open — the code is asked for only then (or with no phone). */
  codeOpen: boolean;
  now: Date;
  copied: boolean;
  showBuy: boolean;
  /** I1: the relay was refused (a create or a checkout: plan_lacks_relay) while a session is up — the switched-off state
   *  (I4) takes the buy slot. */
  planGate: boolean;
  /** m1: a stop that neither landed nor could be confirmed by a re-read. */
  stopFailed: boolean;
  /** N2: a checkout sheet is open — or still loading its chunk — so no tile may start a second Checkout Session. */
  checkoutOpen: boolean;
  /** P1: the currency the checkout will charge; the tiles quote in it. */
  currency: Currency;
  /** W23 (I-1): the RAW projection's restart allowance — null with no reuse window open. `free` is what admission would
   *  waive the credit for; at balance 0 it is what keeps Go live reachable instead of the forced chooser. */
  restart: StreamSessionCurrent["restart"];
  /** Owner 2026-10-30: the LATEST session's video on YouTube (`youtubeLinkOf` over the RAW projection, so Start another keeps it at
   *  Ready) — null with none: a pasted key, a failed broadcast, a disconnected channel, no session. The "On YouTube" card. */
  youtube: YoutubeLink | null;
  onSelectTarget: (id: string) => void;
  /** YouTube Connect T12: a refusal's "Use another destination" — the panel clears the refusal and bumps `pickerOpenSignal`, which
   *  opens the picker's list and focuses it. */
  onPickAnother: () => void;
  pickerOpenSignal: number;
  /** B8 re-review n-5: the last pick did not save — the picker shows the server's answer again, and a line says why. */
  pickFailed: boolean;
  /** Task 33e: the seat is paused (a 402 members.max stopped the panel's polls) — the one line saying why, above everything else.
   *  Optional: unset is "not paused", as every body built before this task. */
  seatPaused?: boolean;
  /** Re-read the destination list after a failed read. */
  onRetryTargets: () => void;
  onGoLive: () => void;
  /** Phase 0 (channel safety): the pre-Go-live notice is up. "Go live anyway" is `onGoLive` again (the panel skips the check while it is up). */
  safetyNotice: boolean;
  onDismissSafety: () => void;
  onStop: () => void;
  onCancel: () => void;
  onBuy: (pack: StreamPackSize) => void;
  onAgain: () => void;
  onCopy: () => void;
  onToggleCode: (open: boolean) => void;
  onReissue: () => void;
  onRetryCode: () => void;
  /** Task 34 fix round 1 (m1): the code's QR failed to encode (the code itself was answered) — its error line with Retry
   *  replaces the placeholder. `onRetryQr` re-encodes the same text; it never re-asks the server. */
  qrFailed: boolean;
  onRetryQr: () => void;
  onShowBuy: () => void;
  /** M2: a hand is on a credit tile (pointerenter, focus, touchstart) — warm the checkout sheet's chunk now. */
  onTileIntent: () => void;
  /** R2006 (Option C): the score — its availability, the stored mode, Ready's score card. */
  score: PhoneScore;
}

const CHIP = "rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700";
/** Owner direction 2026-11-14: the live YouTube status line's look per tone (`YOUTUBE_STATUS_LINES` in lib/stream-session-view.ts decides
 *  the tone). The same emerald / amber / slate vocabulary as the restart line and the takeover notice; the icon repeats what the words
 *  say, so colour is never the only carrier. */
const YOUTUBE_STATUS_LOOK = {
  emerald: { text: "text-emerald-800", icon: "text-emerald-600", Icon: Check },
  amber: { text: "text-amber-800", icon: "text-amber-600", Icon: TriangleAlert },
  slate: { text: "text-slate-600", icon: "text-slate-500", Icon: Info },
} as const;

/** §3.3 Live (mockup state 3): the tab's Stop stream — full width at every width, the same solid red. */
const STOP_STREAM =
  "btn min-h-12 w-full bg-red-600 text-base font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50";
/** Spec §3.2: ended and failed keep their summary and failure boxes, in the new frame's card. */
const SUMMARY_CARD = "mt-4 space-y-3 rounded-lg bg-white p-4 ring-1 ring-purple-100";

/** §8a option A (Stepper) + §8b option A (Three tiles) — values from the sheet. Pure. */
export function PhoneTabBody(p: PhoneTabBodyProps) {
  const msg = useMsg();
  const streamingHref = useStreamingHref();
  const msgPlural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const state = phoneTabState(p.view);
  // The chooser opens either because the org cannot start without credits (FORCED — there is nothing behind it to go
  // back to), or because the organiser asked for it from "Buy more" — mid-session included. A plan refusal (I1) takes
  // its slot: buying is exactly what the plan refused. I-1: NOT forced when the restart is free — admission waives the
  // credit inside the fixture's reuse window, so balance 0 is no reason to withhold Go live. A match that is over (C5) has
  // nothing to start, so it never forces the chooser either.
  //
  // Capture QR v2 §6.12: the Ready row off the two projections, and a LEGACY session (C-1: open, no pairing — it opened
  // before stream codes) is drawn as the panel was: no phone strip, no code, the §3.2 chain.
  const ready = readyStateOf(p.phone, p.view);
  const legacy = p.phone?.legacy ?? false;
  // Court stream: the court whose phone streams this match, when the read model names one. Its line stands where the code does.
  const court = p.phone?.court ?? null;
  // R2006 (Option C): what Go live — and the automatic start — will stream: the score unless the organiser chose Camera
  // only, or this deployment cannot run it. The server's own rule (`effectiveStreamMode`), never a second copy.
  const scoreMode = effectiveStreamMode(p.score.stored, p.score.available);
  const matchOver = state === "idle" && ready === "code_ended";
  const forced = state === "idle" && p.balance < 1 && !p.restart?.free && !matchOver;
  const buyCard = !p.planGate && (forced || p.showBuy);
  // B3: an idle org with no credits sees the heading and the credits card ONLY — a "Ready" pill and a three-step
  // stepper promise a stream it cannot start.
  const creditsOnly = forced && !p.planGate;
  // Task 14b (R4): the chip stays the TOTAL; the split is its footnote, and only when there is something to SPLIT — both
  // buckets held (review M2, controller ruling). One bucket alone is the chip's own number said twice.
  const split = shownSplit(p.split, p.balance);
  // m12: §8a's ending row — "every control disabled" while the last seconds flush.
  const frozen = state === "ending";
  const stopFailure = p.stopFailed ? stopError(msg, state) : null;
  const targetList = p.targets.status === "ok" ? p.targets.list : [];
  const selected = targetList.find((t) => t.id === p.selectedTargetId);
  // A target_in_use refusal whose holder still has a page to open (T8): the Open Match link.
  const inUseHolder = p.createError?.code === "target_in_use" ? p.createError.holder : null;
  // §3.2: the Signal path is drawn to the session's destination, or — with none — to the picked one. Neither (credits
  // only, a list loading, failed or empty) draws no chain: a path to nowhere says nothing. Ended and failed draw none.
  // A court-streamed match goes to its court link's channel (the server overrides the body's target, O9), so before a session the
  // path and a refusal name THAT channel — never the panel's own pick, which is not drawn and is not where the match goes.
  const courtTarget = court ? { kind: "youtube" as const, label: court.targetLabel } : null;
  const chainTarget = p.view ? p.view.target : courtTarget ?? selected ?? null;
  const capture = legacy ? undefined : { phone: p.phone?.phone ?? null, countdown: p.view?.countdown ?? null };
  const drawn =
    !creditsOnly && !matchOver && chainTarget
      ? {
          to: chainTarget,
          chain: chainFor(p.view, { destInUse: state === "idle" && p.createError?.code === "target_in_use", capture }),
        }
      : null;
  // Option B rev 2: the phone's one message, in a strip under the chain (caret on the Phone node). Go live names it.
  // PR-2 (§7.4): credits only (B3) still says why an automatic start did not begin — the refusal alone; the tiles are its
  // remedy, so the strip offers no second Buy credits.
  // B4 fix round 1 (I-2): the automatic start's refusal is stored as one of the column's few words; read against the destination the
  // server resolved for it (a connected channel, with its own live state) it says the real reason.
  const autoDest = autoDestinationOf(p.phone, targetList);
  const strip = matchOver ? null : creditsOnly ? autoRefusalStrip(p.phone, autoDest) : phoneStrip(p.phone, p.view, autoDest);
  const stripBuy = buyCard ? undefined : p.onShowBuy;
  // PR-2 T12 (§7.5): the takeover notice — the server's 30 minutes, this viewer's dismissal, the button to press first
  // (Stop live, Cancel while waiting). Only where Revoke & reissue is in reach (the fold or the code card): not credits
  // only, a match over, a legacy session, Ending (B7 review M-1: the fold is not drawn there), or the ended and failed cards.
  const takeover =
    legacy || creditsOnly || matchOver || state === "ending" || state === "ended" || state === "failed"
      ? null
      : takeoverNotice(p.phone, state, p.takeoverDismissedAt);
  const stripId = `stream-why-${p.fixtureId}`;
  // D3: the server-measured 30 s (M6) — a warning under the chain; the stream keeps running. I-1: phone first. §6.12:
  // the phone's sentence gives way to the strip while it shows the countdown or the paused reason.
  const d3 = d3Warning(p.view);
  const warned = d3 === "phone" && strip !== null ? null : d3;
  // Ended and failed are summary cards that carry their own (visible) pill.
  const summary = state === "ended" || state === "failed";
  const pickerId = `stream-target-${p.fixtureId}`;
  const inUseId = `stream-in-use-${p.fixtureId}`;
  const refusalId = `stream-youtube-refusal-${p.fixtureId}`;
  // Mockup state 5: a target_in_use refusal at Ready is drawn on the picker — the red field, the box under it, and Go
  // live held. The hold lifts when the destination is freed (a fresh list read), when the organiser picks a DIFFERENT
  // destination, or on a reload; re-picking the held one is a no-op (the picker saves nothing for the selected row).
  const inUseBox = state === "idle" && !buyCard && p.createError?.code === "target_in_use";
  // YouTube Connect T12 (spec §6.2, owner's Option B): a Go live that YouTube (or the channel's own state) refused is drawn at
  // Ready where Go live was — the reason, "nothing was started or charged", and the fix that fits the cause — with the picker's
  // field red above it. Only where the Ready block is drawn; anywhere else the refusal falls to the generic line at the bottom.
  const ytRefusal = state === "idle" && !buyCard && !matchOver && p.createError ? youtubeRefusalOf(p.createError.code) : null;
  const ytRefusalBox = ytRefusal !== null;
  // Spec §3.1: "Uses 1 Seazn credit · {n} credits · Buy more" (renamed 2026-11-23) — three parts, never one interpolated sentence (word order and
  // plural agreement differ by locale). "Uses 1 Seazn credit" only while Go live is the action under it and the start would
  // spend one (not inside the reuse window, I-1). The balance keeps the plural key's own text (`stream.phone.credits.*`
  // — the mockup's "9 left" reads "9 credits": a plan decision, the plural key is what keeps every locale grammatical);
  // the monthly/bought split is its `title`, and a visually hidden copy keeps it for screen readers.
  // §6.12 (rev 2): inside the reuse window the restart line above Go live says it — "1 credit" is said once.
  const usesShown = state === "idle" && !buyCard && p.restart === null;
  const creditParts: ReactNode[] = [];
  if (usesShown) creditParts.push(<span key="uses">{msg("stream.credits.uses")}</span>);
  if (p.balance >= 1) creditParts.push(balancePart(msg, p.balance, split));
  if (p.balance >= 1 && !p.planGate) creditParts.push(buyMorePart(msg, { expanded: p.showBuy, disabled: frozen || p.seatPaused === true, paused: p.seatPaused, onClick: p.onShowBuy }));
  const creditsLine =
    !creditsOnly && creditParts.length > 0 ? (
      <p data-testid="stream-credits-line" className="mt-2 text-center text-xs text-slate-600">
        {creditParts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden>{" · "}</span>}
            {part}
          </Fragment>
        ))}
      </p>
    ) : null;

  // W23: "Free restarts used (n of 3)" above Go live (and on the ended card) — emerald below the limit, amber at it.
  const restart = restartLine(p.restart);
  const restartEl = restart ? (
    <p
      data-testid="stream-restart"
      data-tone={restart.tone}
      className={`flex items-start gap-1.5 text-xs ${restart.tone === "emerald" ? "text-emerald-800" : "text-amber-800"}`}
    >
      <RotateCcw
        aria-hidden
        className={`mt-px h-3.5 w-3.5 shrink-0 ${restart.tone === "emerald" ? "text-emerald-600" : "text-amber-600"}`}
        strokeWidth={1.8}
      />
      <span>{msg(restart.key, restart.vars)}</span>
    </p>
  ) : null;

  // §6.12 (Option B rev 2): the code's QR, its paste code with Copy beneath it at every width, and Revoke & reissue —
  // the card's own content at Ready with no phone, and the body of "Show the code again" otherwise. The QR and the paste
  // code both carry a live tok: `ph-no-capture` on each (the QR's is `sensitive`). A finished match has no reissue (the
  // route refuses it, 422). Task 34: the paste code and Copy only where the server shows them (`pasteCodeShown`: dev, e2e
  // and smoke); stg and prod show the QR alone.
  // The code's error line with Retry: the ask refused (`stream-code-*`), or the answered code's QR failed to encode
  // (`stream-qr-*`, Task 34 fix round 1 m1). One look and one sentence; each Retry does its own thing.
  const codeError = (testId: string, retryTestId: string, onRetry: () => void) => (
    <div data-testid={testId} role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700">
      <span>{msg("stream.code.error")}</span>
      <button type="button" data-testid={retryTestId} onClick={onRetry} className="btn btn-ghost min-h-11 md:min-h-10">
        {msg("stream.dest.retry")}
      </button>
    </div>
  );
  // "Open in app" for the code this card holds (Android phones only; elsewhere the card is as it was). Its link is the
  // QR's own text. Not drawn under a plan refusal. The line below the button names what the page knows is missing.
  const origin = clientOrigin();
  const codeHint = streamHintKey(
    streamHintNeeds({
      sessionOpen: state === "provisioning" || state === "warming" || state === "live" || state === "ending",
      selectedTargetId: p.selectedTargetId,
      balance: p.balance,
      freeRestart: Boolean(p.restart?.free),
    }),
  );
  const codeInner = (
    <>
      {p.code.status === "ok" && !p.planGate && (
        <OpenInAppRow className="mt-2" href={origin === null ? null : streamAppLink(origin, p.code.text)}>
          <OpenInAppHint hint={codeHint} />
        </OpenInAppRow>
      )}
      <div className="mt-2">
        {p.code.status === "ok" ? (
          p.code.image ? (
            <SeaznQrImage testId="stream-qr" sensitive qr={p.code.image} alt={msg("stream.phone.qr.alt")} maxSize={PHONE_HANDOVER_QR_MAX_PX} />
          ) : p.qrFailed ? (
            codeError("stream-qr-error", "stream-qr-retry", p.onRetryQr)
          ) : (
            // The QR's own square and caption line, so the card keeps its size when the symbol lands (review m-7).
            <SeaznQrPlaceholder maxSize={PHONE_HANDOVER_QR_MAX_PX} modules={seaznQrModules(p.code.text)} />
          )
        ) : p.code.status === "error" ? (
          codeError("stream-code-error", "stream-code-retry", p.onRetryCode)
        ) : (
          <SeaznQrPlaceholder maxSize={PHONE_HANDOVER_QR_MAX_PX} modules={null} />
        )}
      </div>
      {p.code.status === "ok" && p.pasteCodeShown && (
        <div data-testid="stream-qr-field" className="relative mt-2 w-full">
          <input
            data-testid="stream-qr-text"
            readOnly
            aria-label={msg("stream.phone.qr.field")}
            value={p.code.text}
            onFocus={(e) => e.currentTarget.select()}
            className="ph-no-capture h-11 w-full rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 outline-none focus:ring-2 focus:ring-purple-200"
          />
          <button type="button" data-testid="stream-qr-copy" onClick={p.onCopy} className="btn btn-ghost mt-1.5 h-11 w-full text-xs">
            {p.copied ? <Check aria-hidden className="h-3.5 w-3.5 text-green-600" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            <span aria-live="polite">{p.copied ? msg("stream.phone.qr.copied") : msg("stream.phone.qr.copy")}</span>
          </button>
        </div>
      )}
      {!p.phone?.finished && (
        <div className="mt-1 flex justify-center">
          <button
            type="button"
            data-testid="stream-code-reissue"
            disabled={p.code.status === "loading"}
            onClick={p.onReissue}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-red-700 underline decoration-red-300 underline-offset-2 hover:decoration-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {msg("stream.code.reissue")}
          </button>
        </div>
      )}
    </>
  );
  // Ready, paired (or silent): the card folds to one line. Ruling A (carry 3): Reissue is the organiser's remedy for a
  // stranger who scanned the code, so the same line stays while the session waits and while it is live.
  // The dot is the Phone node's and the strip's statement too (B8 re-review ruling): one fact, `phoneDot`.
  const facts = p.phone?.phone ?? null;
  const dot = phoneDot({ phone: facts, countdown: capture?.countdown ?? null });
  const codeDisclosure = (
    <details
      data-testid="stream-code-disclosure"
      open={p.codeOpen}
      onToggle={(e) => p.onToggleCode(e.currentTarget.open)}
      className="group min-w-0 rounded-lg bg-white ring-1 ring-purple-100"
    >
      {/* flex-wrap: on a narrow card "Show the code again" drops to its own line before "Paired · Pixel 8" would
          truncate (a label sized to its content, capped at the row, wraps the next item instead of shrinking). */}
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          data-tone={dot}
          className={`h-2 w-2 shrink-0 rounded-full ${
            dot === "lime" ? "bg-[var(--mk-lime)] ring-1 ring-lime-600" : dot === "amber" ? "bg-amber-400" : "bg-slate-300"
          }`}
        />
        {facts && (
          // PR-2 T12 (§7.5, Option A): "Paired · Pixel 8" — the model the phone named, truncating first on a narrow card.
          <span data-testid="stream-code-paired" className="min-w-0 max-w-[calc(100%-1rem)] truncate">
            <span className="font-medium text-slate-800">{msg("stream.code.paired")}</span>
            {facts.model !== null && (
              <>
                <span aria-hidden className="text-slate-400">
                  {" · "}
                </span>
                <span className="text-slate-700">{facts.model}</span>
              </>
            )}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-1 font-medium text-purple-700 underline decoration-purple-300 underline-offset-2">
          {msg("stream.code.showAgain")}
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          strokeWidth={1.8}
        />
      </summary>
      {p.codeOpen && <div className="px-3 pb-3">{codeInner}</div>}
    </details>
  );

  // Court stream (spec 2026-11-14 §5.2; plan Task 13): where the code card and its fold would be, ONE line - whose phone streams the
  // match. The Paired fold's own row (white card, purple ring, the Phone node's dot from `phoneDot`, 44 px, wrapping rather than cutting
  // a court's name), minus the code: nothing to scan or show here - the court's code is the desk's, on Match Day. No new tokens.
  const courtLine = court ? (
    <p
      data-testid="stream-court-line"
      className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-purple-100"
    >
      <span
        aria-hidden
        data-tone={dot}
        className={`h-2 w-2 shrink-0 rounded-full ${
          dot === "lime" ? "bg-[var(--mk-lime)] ring-1 ring-lime-600" : dot === "amber" ? "bg-amber-400" : "bg-slate-300"
        }`}
      />
      <span className="min-w-0 break-words font-medium text-slate-800">{msg("stream.courtStreamed", { court: court.name })}</span>
    </p>
  ) : null;
  const codeSlot = courtLine ?? codeDisclosure;

  // Owner 2026-10-30: the match's video on YouTube — one more card where the Paired card is (Ready's right column, under it; after it
  // in the waiting and live stacks; inside the ended and failed cards). Laid out as the Paired card's own row: what it is on the left,
  // the link on the right, wrapping under it on a narrow card. The link is styled as "Manage destinations" and wears the external-link
  // icon, not YouTube's: the spec's Branding names the only two places the logo appears (a channel row, Watch replay).
  const youtubeCard = p.youtube ? (
    <div data-testid="stream-youtube-link-card" data-live={p.youtube.live ? "true" : "false"} className="min-w-0 rounded-lg bg-white ring-1 ring-purple-100">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm">
        <p data-testid="stream-youtube-link-status" className="min-w-0 font-medium text-slate-800">
          {msg(p.youtube.live ? "stream.youtube.link.live" : "stream.youtube.link.ended")}
        </p>
        <a
          data-testid="stream-youtube-link"
          href={p.youtube.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${LINK} inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0`}
        >
          {msg("streaming.youtube.replay.open")}
          <ExternalLink aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
        </a>
      </div>
    </div>
  ) : null;

  // Owner direction 2026-11-14: the ONE line about the live session's YouTube side, next to the video card - what YouTube says of the
  // broadcast and its stream (live and receiving / not live / live with no video), or that a pasted key has no status to give. It is
  // the server's word (`youtubeStatus`); `youtubeStatusLineOf` says whether it shows (live only) and in which tone. No word yet (YouTube
  // is first read a minute after go-live), no line - never a placeholder.
  const youtubeStatusLine = youtubeStatusLineOf(p.view);
  const statusLook = youtubeStatusLine ? YOUTUBE_STATUS_LOOK[youtubeStatusLine.tone] : null;
  const youtubeStatusEl = youtubeStatusLine && statusLook ? (
    <p
      data-testid="stream-youtube-live-status"
      data-status={youtubeStatusLine.status}
      data-tone={youtubeStatusLine.tone}
      role="status"
      className={`flex min-w-0 items-start gap-1.5 px-1 text-xs ${statusLook.text}`}
    >
      <statusLook.Icon aria-hidden className={`mt-px h-3.5 w-3.5 shrink-0 ${statusLook.icon}`} strokeWidth={1.8} />
      <span className="min-w-0">{msg(youtubeStatusLine.key)}</span>
    </p>
  ) : null;

  // PR-2 T10 (§7.1, Option A states 1–2): the switch under the picker — the whole row is the control (44 px), its caption
  // (the server's delay) only while on. Checked is the read model's `auto.enabled`, or the flip in flight.
  const autoOn = p.autoPending ?? p.phone?.auto?.enabled ?? false;
  const autoTitleId = `stream-auto-title-${p.fixtureId}`;
  const autoHintId = `stream-auto-hint-${p.fixtureId}`;
  // Owner-approved 2026-10-08: the note under the switch while it is on — why it will not start for this match (the server's
  // latch, final review I-1), else the paired phone in Operator (the beat's mode). One line, the latch first.
  const autoNote = autoSwitchNote(p.phone, autoOn);
  const autoNoteId = autoNote?.kind === "wontStart" ? `stream-auto-wont-start-${p.fixtureId}` : `stream-auto-operator-${p.fixtureId}`;
  // R2006 (Option C): while on, the switch says what the automatic start will stream — the same mode Go live shows.
  const autoModeId = `stream-auto-mode-${p.fixtureId}`;
  const autoDescribedBy = [autoHintId, autoModeId, ...(autoNote ? [autoNoteId] : [])].join(" ");
  const autoSwitch = (
    <div data-testid="stream-auto" className="mt-3">
      <button
        type="button"
        role="switch"
        data-testid="stream-auto-switch"
        aria-checked={autoOn}
        aria-labelledby={autoTitleId}
        aria-describedby={autoOn ? autoDescribedBy : undefined}
        disabled={p.autoPending !== null}
        onClick={() => p.onToggleAuto(!autoOn)}
        className="flex min-h-11 w-full items-start gap-3 rounded-lg bg-white p-3 text-left ring-1 ring-purple-100 disabled:cursor-wait"
      >
        <span
          aria-hidden
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${autoOn ? "bg-[#1a1033]" : "bg-slate-300"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] motion-reduce:transition-none ${autoOn ? "left-[22px]" : "left-0.5"}`}
          />
        </span>
        <span className="min-w-0">
          <span id={autoTitleId} className="block text-sm font-medium text-slate-800">
            {msg("stream.auto.switch")}
          </span>
          {autoOn && (
            <span id={autoHintId} data-testid="stream-auto-hint" className="mt-0.5 block text-xs text-slate-600">
              {msgPlural("stream.auto.switchHint", p.autoStopMinutes, { count: p.autoStopMinutes })}
            </span>
          )}
        </span>
      </button>
      {autoOn && (
        <p id={autoModeId} data-testid="stream-auto-mode" data-mode={scoreMode} className="mt-1 flex gap-1.5 px-1 text-xs text-slate-600">
          <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={1.8} />
          <span className="min-w-0">{msg(scoreMode === "composed" ? "stream.auto.startsWithScore" : "stream.auto.startsCameraOnly")}</span>
        </p>
      )}
      {autoNote && (
        <p
          id={autoNoteId}
          data-testid={autoNote.kind === "wontStart" ? "stream-auto-wont-start" : "stream-auto-operator"}
          data-reason={autoNote.kind === "wontStart" ? autoNote.reason : undefined}
          className="mt-1 flex gap-1.5 px-1 text-xs text-amber-800"
        >
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.8} />
          <span className="min-w-0">{msg(autoNote.kind === "wontStart" ? AUTO_WONT_START_KEY[autoNote.reason] : "stream.auto.operatorHint")}</span>
        </p>
      )}
      {p.autoFailed && (
        <p data-testid="stream-auto-error" role="alert" className="mt-1 text-sm text-red-700">
          {msg("stream.error.failed")}
        </p>
      )}
    </div>
  );
  // §7.1: Live's read-only line — only when the server says §7.3 will stop this session (B7 review M-3), the server's delay.
  const autoLive = state === "live" && autoStopLine(p.phone, state);
  const autoWait = autoStopWait(p.phone, p.autoStopMinutes);
  const autoSeazn = autoStopIsSeazn(p.phone);
  // R2006 (Option C): Ready's score card — the style picker and Score timing while the score is on; one line once the
  // organiser chose Camera only; nothing where the score cannot stream (the reason sits above Go live instead).
  const scoreBlock = !p.score.available ? null : scoreMode === "composed" ? (
    <div data-testid="stream-score" className="min-w-0 rounded-lg bg-white p-3 ring-1 ring-purple-100">
      {court ? (p.score.courtEditor ?? p.score.editor) : p.score.editor}
    </div>
  ) : (
    <p data-testid="stream-camera-only" className="min-w-0 rounded-lg bg-white px-3 py-2.5 text-sm text-slate-700 ring-1 ring-purple-100">
      <span className="font-medium text-slate-800">{msg("stream.mode.cameraOnlyTitle")}</span> {msg("stream.mode.cameraOnlyBody")}
    </p>
  );
  // R2006: a running SCORE session's own style and timing (its create copied them) — read-only, and the honest line that
  // its destination is not watched yet (Owed 26: the chain's destination node is neutral for the same reason).
  const liveOverlay = p.view?.mode === "composed" ? p.view.overlay : null;
  // §7.4 "behind a tap" (Q-D): the phone's data used and app version, after the runner's chips in Details (Live/Ending).
  const extraChips = phoneDetails(p.phone);

  // T8: only a LOADED, non-empty list can start — `targetList` is empty while the read is pending or failed, so a failed or pending
  // read offers nothing to stream to, and neither does a selection left over from before. Mockup state 5: a destination another
  // match holds cannot start until it is picked again or freed. §6.12 (W5): and only with a phone paired and answering.
  // Court device check (finding B): a court match has no picker and streams to its court's channel, so no pick is owed there —
  // a match whose court phone is paired (Automatic or Operator, latched or not) can always be started by hand.
  const goLiveDisabled = p.seatPaused === true || p.busy || (!p.selectedTargetId && !court) || targetList.length === 0 || inUseBox || !canGoLive(ready);
  const refusalFix = ytRefusal ? YOUTUBE_REFUSAL_FIX[ytRefusal] : null;
  const refusalBlock =
    ytRefusal && p.createError ? (
      // Focus goes to the BLOCK when it appears (it replaced the Go live the organiser had just pressed): the block commits while the
      // start is still in flight, so Try again is disabled then — focusing a button would land on a different one. One Tab reaches the first
      // enabled action. The key makes each refusal — another code, or the same one after Try again — focus again (refusal-focus.tsx).
      <div
        key={ytRefusal}
        ref={focusRefusalBlock}
        tabIndex={-1}
        id={refusalId}
        data-testid="stream-youtube-refusal"
        data-code={ytRefusal}
        data-fix={refusalFix ?? undefined}
        role="alert"
        className={`min-w-0 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm text-red-800 ${REFUSAL_FOCUS_RING}`}
      >
        {(courtTarget ?? selected) && (
          <p className="flex gap-2 font-semibold">
            <CircleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.8} />
            <span data-testid="stream-youtube-refusal-title" className="min-w-0 [overflow-wrap:anywhere]">
              {msg("stream.youtube.refused.title", { label: youtubeTargetLabel(msg, (courtTarget ?? selected)!.label) })}
            </span>
          </p>
        )}
        <p data-testid="stream-create-error" className="mt-1">
          {createErrorText(p.createError, msg)}
        </p>
        <p data-testid="stream-youtube-refusal-note" className="mt-1">
          {msg("stream.youtube.refused.nothing")}
        </p>
        {refusalFix === "reconnect" && (
          <a
            data-testid="stream-youtube-reconnect"
            href={streamingHref}
            target="_blank"
            rel="noopener"
            className="btn btn-primary mt-3 min-h-12 w-full text-base"
          >
            {msg("stream.youtube.refused.reconnect")}
            <ExternalLink aria-hidden className="h-4 w-4" strokeWidth={1.8} />
          </a>
        )}
        {refusalFix === "retry" && (
          <button type="button" data-testid="stream-youtube-retry" disabled={goLiveDisabled} aria-disabled={p.seatPaused ? true : undefined} onClick={p.onGoLive} className="btn btn-primary mt-3 min-h-12 w-full text-base">
            {msg("stream.youtube.refused.retry")}
          </button>
        )}
        <button
          type="button"
          data-testid="stream-youtube-pick-another"
          onClick={p.onPickAnother}
          className="mt-1.5 inline-flex min-h-11 w-full items-center justify-center text-sm font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:decoration-red-700"
        >
          {msg("stream.youtube.refused.pickAnother")}
        </button>
      </div>
    ) : null;

  return (
    // P5: the root marker the chooser's Close looks Buy more up from.
    <div data-phone-body>
      {p.seatPaused && seatPausedNote(msg)}
      {/* T9b (spec §3.1): no heading and no visible pill — the Signal path below says the state, and the ended and failed
          cards carry the pill themselves. Here it stays for assistive tech (aria-live announces each change). Credits only
          (B3) has no state to announce. */}
      {!creditsOnly && !summary && statePill(msg, state, true)}

      {/* §3.2 (T9a): the Signal path replaces §8a's stepper — one drawing at every width; only its destination label
          moves (under its node at ≥ 768, its own line below). None at all while credits-only (B3). */}
      {drawn?.chain && (
        <SignalChain chain={drawn.chain} destination={{ kind: drawn.to.kind, label: youtubeTargetLabel(msg, drawn.to.label) }}>
          {strip && <PhoneStripView id={stripId} strip={strip} caret onBuy={stripBuy} buyDisabled={p.seatPaused} />}
        </SignalChain>
      )}
      {/* No chain to point at (no destination yet): the strip still says what the phone needs, without its caret. */}
      {!drawn?.chain && strip && <PhoneStripView id={stripId} strip={strip} caret={false} onBuy={stripBuy} buyDisabled={p.seatPaused} />}
      {warned && p.view && <D3Warning cause={warned} kind={p.view.target.kind} />}
      {takeover && (
        // §7.5 (Option A 9a/9b): an inline amber strip with its own X — the time on the venue's clock.
        <div data-testid="stream-takeover" role="status" className="mt-3 flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert aria-hidden className="mt-px h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.8} />
          <p data-testid="stream-takeover-text" className="min-w-0 flex-1">
            {takeover.model !== null
              ? msg(takeoverLineKey(takeover.act, true), { model: takeover.model, time: fmtTime(p.tz, takeover.at) })
              : msg(takeoverLineKey(takeover.act, false), { time: fmtTime(p.tz, takeover.at) })}
          </p>
          <button
            type="button"
            data-testid="stream-takeover-dismiss"
            aria-label={msg("stream.takeover.dismiss")}
            onClick={() => p.onDismissTakeover(takeover.at)}
            className="-my-1 -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md text-amber-700 hover:bg-amber-100 md:h-8 md:w-8"
          >
            <X aria-hidden className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {(p.view?.fixtureDecided || p.view?.fixtureHeld) && (state === "live" || state === "ending") && (
        // W2a loop R, M2: a held fixture arms the automatic stop too (ruling D-M1), so it warns with its own words —
        // "Match decided" would be false while the winner awaits the settle.
        <p
          data-testid={p.view.fixtureHeld ? "stream-held-chip" : "stream-decided-chip"}
          className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800"
        >
          {msg(p.view.fixtureHeld ? "stream.phone.held" : "stream.phone.decided")}
        </p>
      )}

      {p.planGate && (
        // I1: the refusal where the buy card goes — the switched-off state (I4), never a priced upgrade.
        <div data-testid="stream-plan-gate" className="mt-3 min-w-0">
          {switchedOff(msg)}
        </div>
      )}

      {matchOver && (
        // §6.12 "Code ended": the match is over and its code with it — no QR and no Go live.
        <p data-testid="stream-match-over" className="mt-4 text-sm text-slate-700">
          {msg("stream.phone.matchOver")}
        </p>
      )}

      {state === "idle" && !buyCard && !matchOver && (
        // Option B rev 2 (§6.12): the destination; the code card beside it from 768 (370 px, equal columns from 1024),
        // below it on a phone; then the restart line, Go live and the credits line under the picker.
        // R2006 (Option C, owner-approved mock): the score card spans both columns between that row and Go live.
        <div
          data-testid="stream-ready"
          className={`mt-4 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_370px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] ${
            scoreBlock ? "md:grid-rows-[auto_auto_1fr]" : "md:grid-rows-[auto_1fr]"
          }`}
        >
          <div className="min-w-0 md:col-start-1 md:row-start-1">
            {/* A court-streamed match streams to the court link's channel and the server ignores any other (O9), so no pick is offered:
                only a failed read keeps its Retry, because Go live still needs the list it loads. */}
            {!court && (<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              {p.targets.status === "ok" && targetList.length > 0 ? (
                <label htmlFor={pickerId} className="text-sm font-medium text-slate-800">
                  {msg("stream.dest.label")}
                </label>
              ) : (
                <span className="text-sm font-medium text-slate-800">{msg("stream.dest.label")}</span>
              )}
              {/* D1: destinations are added, renamed and removed in Directory only — never inline here. */}
              <a
                data-testid="stream-manage-destinations"
                href={streamingHref}
                target="_blank"
                rel="noopener"
                className={`${LINK} inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0`}
              >
                {msg("stream.dest.manage")}
                <ExternalLink aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
              </a>
            </div>)}
            {p.targets.status === "error" ? (
              <div data-testid="stream-dest-load-error" role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-red-700">
                <span>{msg("stream.dest.loadError")}</span>
                <button type="button" data-testid="stream-dest-retry" onClick={p.onRetryTargets} className="btn btn-ghost min-h-11 md:min-h-10">
                  {msg("stream.dest.retry")}
                </button>
              </div>
            ) : court ? null : p.targets.status === "ok" && targetList.length === 0 ? (
              <p data-testid="stream-dest-empty" className="mt-1 text-sm text-slate-600">
                {msg("stream.dest.empty")}
              </p>
            ) : p.targets.status === "ok" ? (
              // Owner's Option B (YouTube Connect T12): a custom list — what each destination IS and how it is, before Go live.
              <div className="mt-1 min-w-0">
                <FixtureDestinationPicker
                  id={pickerId}
                  targets={targetList}
                  selectedId={p.selectedTargetId}
                  onSelect={p.onSelectTarget}
                  invalid={inUseBox || ytRefusalBox}
                  describedBy={inUseBox ? inUseId : ytRefusalBox ? refusalId : undefined}
                  openSignal={p.pickerOpenSignal}
                />
              </div>
            ) : null}
            {p.pickFailed && (
              <p data-testid="stream-pick-error" role="alert" className="mt-1 text-sm text-red-700">
                {msg("stream.dest.pickFailed")}
              </p>
            )}
            {inUseBox && p.createError && (
              // §3.3 / mockup state 5: the refusal sits under the picker it is about, with the holder's page beside it.
              <div id={inUseId} role="alert" className="mt-2 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <CircleAlert aria-hidden className="h-5 w-5 shrink-0" strokeWidth={1.8} />
                <p className="min-w-0">
                  <span data-testid="stream-create-error">{createErrorText(p.createError, msg)}</span>
                  {inUseHolder?.href && inUseHolder.matchNo !== null && (
                    <>
                      {" "}
                      <a
                        data-testid="stream-in-use-open"
                        href={inUseHolder.href}
                        className="inline-flex min-h-11 items-center font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:decoration-red-700 md:min-h-0"
                      >
                        {msg("stream.inUse.open", { match: msg("breadcrumb.match", { no: inUseHolder.matchNo }) })}
                      </a>
                    </>
                  )}
                </p>
              </div>
            )}
            {/* A court match starts and stops by the court's Stream switch, which the desk owns: this switch writes a flag nothing
                reads for it, so it is not drawn. */}
            {!court && autoSwitch}
          </div>
          <div
            className={`min-w-0 space-y-3 md:col-start-2 md:row-start-1 ${scoreBlock ? "" : "md:row-span-2"} ${ready === "no_phone" ? "" : "md:mt-6"}`}
          >
            {ready === "no_phone" && !court ? (
              <div data-testid="stream-code-card" className="min-w-0 rounded-lg bg-white p-3 ring-1 ring-purple-100">
                <p className="text-sm font-semibold text-slate-900">{msg("stream.code.scan")}</p>
                {codeInner}
              </div>
            ) : (
              codeSlot
            )}
            {/* Owner 2026-10-30: under the Paired (or code) card — the next child, so on a phone it stacks right after it. */}
            {youtubeCard}
          </div>
          {scoreBlock && <div className="min-w-0 md:col-span-2 md:row-start-2">{scoreBlock}</div>}
          <div className={`min-w-0 space-y-4 md:col-start-1 ${scoreBlock ? "md:row-start-3" : "md:row-start-2"}`}>
            {restartEl}
            <div>
              {!p.score.available && (
                // Owner ruling (Option C): the score cannot stream here — one line, and Go live still streams the camera.
                <p data-testid="stream-score-unavailable" className="mb-2 flex gap-1.5 text-xs text-slate-600">
                  <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={1.8} />
                  <span className="min-w-0">{msg("stream.mode.unavailable")}</span>
                </p>
              )}
              {!refusalBlock && p.safetyNotice && <ChannelSafetyNotice busy={p.busy} onGoAnyway={p.onGoLive} onCancel={p.onDismissSafety} />}
              {refusalBlock ?? (
                <button
                  type="button"
                  data-testid="stream-go-live"
                  data-mode={scoreMode}
                  // `goLiveDisabled` (above): only a loaded, non-empty list, a free destination and a phone answering can start.
                  disabled={goLiveDisabled}
                  aria-disabled={p.seatPaused ? true : undefined}
                  aria-describedby={strip ? stripId : undefined}
                  onClick={p.onGoLive}
                  className="btn btn-primary min-h-12 w-full text-base"
                >
                  {msg("stream.phone.goLive")}
                </button>
              )}
              {p.score.available && (
                // Option C: the secondary choice is a small link under the ONE Go live — Camera only, or the score back.
                <div className="flex justify-center">
                  <button
                    type="button"
                    data-testid="stream-mode-toggle"
                    data-to={scoreMode === "composed" ? "passthrough" : "composed"}
                    disabled={p.busy}
                    onClick={() => p.score.onMode(scoreMode === "composed" ? "passthrough" : "composed")}
                    className={`${LINK} inline-flex min-h-11 items-center text-sm disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9`}
                  >
                    {msg(scoreMode === "composed" ? "stream.mode.cameraOnly" : "stream.mode.addScore")}
                  </button>
                </div>
              )}
              {p.score.modeFailed && (
                <p data-testid="stream-mode-error" role="alert" className="mt-1 text-center text-sm text-red-700">
                  {msg("stream.mode.saveFailed")}
                </p>
              )}
              {!refusalBlock && creditsLine}
            </div>
          </div>
        </div>
      )}

      {(state === "provisioning" || state === "warming") && (
        // §6.12 Waiting: no QR (the phone is already paired) — the strip above says what it waits for, then the far
        // cadence's line (§6.6) while the phone is on it, and Cancel. (A legacy session has no phone facts at all —
        // stream-phone.ts serves `phone: null` with `legacy: true` — so the line needs no legacy test of its own.)
        <div data-testid="stream-waiting" className="mt-4 space-y-3">
          {p.phone?.phone?.farPoll && (
            <p data-testid="stream-poll-far" className="text-xs text-slate-600">
              {msg("stream.phone.pollFar")}
            </p>
          )}
          <button
            type="button"
            data-testid="stream-cancel"
            disabled={p.busy}
            onClick={p.onCancel}
            className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
          >
            {msg("stream.phone.cancel")}
          </button>
          {!legacy && codeSlot}
          {youtubeCard}
        </div>
      )}

      {(state === "live" || state === "ending") && p.view && (
        // §3.3 Live (mockup state 3): On air and the elapsed time, a full-width Stop, then the closed Details.
        <div className="mt-4 space-y-4">
          {autoLive && (
            <p data-testid="stream-auto-live" className="text-xs text-slate-600">
              {autoWait.unit === "seconds"
                ? msgPlural("stream.auto.liveLineSeconds", autoWait.count, { count: autoWait.count })
                : autoSeazn
                  ? msgPlural("stream.auto.seaznLine", autoWait.count, { count: autoWait.count })
                  : msgPlural("stream.auto.liveLine", autoWait.count, { count: autoWait.count })}
            </p>
          )}
          {state === "live" ? (
            <div className="grid items-center gap-3 md:grid-cols-[auto_1fr] md:gap-6">
              <div className="flex items-center gap-3 md:flex-col md:items-start md:gap-0.5">
                <span data-testid="stream-on-air" className="text-xs font-medium uppercase tracking-wide text-slate-600">
                  {msg("stream.onAir")}
                </span>
                <span data-testid="stream-elapsed" className="font-mono text-3xl font-semibold tabular-nums text-slate-900">
                  {elapsedLabel(p.view.startedAt, p.now)}
                </span>
              </div>
              <button type="button" data-testid="stream-stop" disabled={p.busy} onClick={p.onStop} className={STOP_STREAM}>
                {msg("stream.phone.stop")}
              </button>
            </div>
          ) : (
            <p data-testid="stream-ending" className="text-xs text-slate-600">
              {msg("stream.phone.ending", { destination: targetName(msg, p.view.target) })}
            </p>
          )}
          {state === "live" && p.view.mode === "composed" && (
            <div className="space-y-2">
              <p data-testid="stream-live-unmonitored" className="flex gap-1.5 text-xs text-slate-600">
                <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={1.8} />
                <span className="min-w-0">{msg("stream.live.deliveryUnmonitored", { platform: platformName(msg, p.view.target.kind) })}</span>
              </p>
              {liveOverlay && (
                <ScoreLiveSummary
                  templateLabel={msg(resolveTemplate(liveOverlay.themeId, p.score.sportKey).labelKey as MessageKey)}
                  delayMs={liveOverlay.delayMs}
                />
              )}
            </div>
          )}
          {/* §3.3 (T9a): the health chips are Details — closed by default; the chain above carries the state. */}
          <details data-testid="stream-details" className="group rounded-lg border border-slate-200 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.8} />
              {msg("stream.details")}
            </summary>
            <div data-testid="stream-health" className="flex flex-wrap gap-2 px-3 pb-3">
              {healthChips(p.view, msg, p.now, locale).map((c, i) => (
                <span
                  key={i}
                  data-testid="stream-health-chip"
                  className={`rounded-md px-2 py-1 text-[11px] ${
                    c.stale ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {c.text}
                </span>
              ))}
              {extraChips.map((c) =>
                c.kind === "dataUsed" ? (
                  <span key="data" data-testid="stream-phone-data-used" className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
                    {msg("stream.phone.dataUsed", { n: fmtNumber(locale, c.mb, { maximumFractionDigits: 1 }) })}
                  </span>
                ) : (
                  <span key="app" data-testid="stream-phone-app-version" className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
                    {msg("stream.phone.appVersion", { version: c.version })}
                  </span>
                ),
              )}
            </div>
          </details>
          {!legacy && state === "live" && codeSlot}
          {youtubeCard}
          {youtubeStatusEl}
        </div>
      )}

      {state === "ended" && p.view && (
        <div data-testid="stream-ended" className={SUMMARY_CARD}>
          {statePill(msg, state)}
          <div className="flex flex-wrap gap-1">
            {/* P6: `startedAt` is stamped only when a session goes live (relay/domain/session.ts), so an ended one
                without it never went live — a Cancel on the QR, a camera that never connected. "Duration 0:00" read
                as a broadcast that happened; this says what did. */}
            {p.view.startedAt === null ? (
              <span data-testid="stream-ended-never-live" className={CHIP}>
                {msg("stream.phone.ended.neverLive")}
              </span>
            ) : (
              <span data-testid="stream-ended-duration" className={CHIP}>
                {msg("stream.phone.ended.duration", {
                  duration: elapsedLabel(p.view.startedAt, p.view.endedAt ? new Date(p.view.endedAt) : p.now),
                })}
              </span>
            )}
            {/* D3: only when THIS session's consume still stands — a restart inside the reuse window, or a refunded
                consume, used nothing, and the chip must not claim it did. */}
            {p.view.creditUsed && (
              <span data-testid="stream-credit-used" className={CHIP}>
                {msg("stream.phone.ended.credits")}
              </span>
            )}
            {/* P7: never live ⇒ the chip above is the whole story. Its end reason ("Stopped by you", on a Cancel from the
                QR) only restated what the organiser had just done, as a second chip for one fact. */}
            {p.view.endReason && p.view.startedAt !== null && (
              <span data-testid="stream-end-reason" className={CHIP}>
                {/* W19: `phone_lost` names the window the server ended it by — its own number, never one typed into the
                    copy. The other reasons carry no placeholder and ignore it. */}
                {msg(END_REASON_KEYS[p.view.endReason], { minutes: p.phoneLostMinutes })}
              </span>
            )}
          </div>
          {restartEl}
          {/* Seazn-hosted video (Task 25): the fixture's Seazn replays and their state (it draws nothing when there is none). */}
          <SeaznReplaysCard fixtureId={p.fixtureId} replays={p.view.seaznReplays} actions={p.replayActions} />
          {(() => {
            // YouTube Connect T16 (O6): the after-match area lists the match's replay PARTS (a restart makes a second broadcast),
            // then the club's own link when it is not one of them. With no parts it is the single row it always was.
            const parts = p.view.replayParts;
            const rows = replayRows(p.view.replayUrl, parts);
            if (rows.length === 0) return null;
            return (
              // Owner's Option B (YouTube Connect T12): the replay is a row — when it ran, then Watch replay and Copy link. A YouTube
              // destination's link wears the official icon (inside the link, so the mark is clickable and leads to YouTube).
              <div data-testid="stream-replay-row" className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
                {p.view.startedAt !== null && (
                  <p data-testid="stream-replay-times" className="text-sm text-slate-700">
                    {(() => {
                      const when = p.view.endedAt
                        ? msg("stream.replay.times", { start: fmtTime(p.tz, p.view.startedAt), end: fmtTime(p.tz, p.view.endedAt) })
                        : msg("stream.replay.timesOpen", { start: fmtTime(p.tz, p.view.startedAt) });
                      // These are the LATEST session's times (the view is the last session's). Beside one replay that is just when the
                      // match ran; beside several parts it would read as the whole match's, so it says what it is.
                      return parts.length > 1 ? msg("stream.replay.latestSession", { times: when }) : when;
                    })()}
                  </p>
                )}
                {rows.map((row) => (
                  <div key={row.key} data-testid="stream-replay-item" className="min-w-0 space-y-1">
                    {/* A part is labelled only when there are two or more: one part is just the replay. */}
                    {row.partNo !== null && parts.length > 1 && (
                      <p data-testid="stream-replay-part" className="text-sm font-semibold text-slate-900">
                        {msg("streaming.youtube.part", { n: row.partNo })}
                      </p>
                    )}
                    {/* A broadcast that is PRIVATE on YouTube stays on this list - it is the organiser's own replay - but the public match
                        page never shows it (owner ruling 2026-10-28), so say so beside it. Its number counts every complete broadcast. */}
                    {row.private && (
                      <p data-testid="stream-replay-private" className="text-sm text-slate-600">
                        {msg("streaming.youtube.replay.private")}
                      </p>
                    )}
                    <div className="flex flex-col gap-2 md:flex-row">
                      <a
                        data-testid="stream-replay"
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-ghost min-h-11 w-full gap-2.5 md:min-h-10 md:w-auto"
                      >
                        {/* The mark follows the LINK, not the destination: a club's own stream_url is never overwritten with YouTube's. */}
                        {isYoutubeUrl(row.url) && <YoutubeIcon size="sm" />}
                        {/* Told apart by words as well as by the mark: beside the match's replay parts, the club's own link says what it is
                            (its existing "Your stream link" copy) instead of a second "Watch replay". With no parts it is the row it always was. */}
                        {row.partNo === null && parts.length > 0 ? msg("stream.url.label") : msg("stream.phone.replay")}
                      </a>
                      <ReplayCopyButton url={row.url} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          {/* Owner 2026-10-30: the match's video — until its broadcast completes and Watch replay above links it (the same video is
              never linked twice: `linkIsOneOfParts`, the rule the replay row and the public page apply). */}
          {p.youtube && !linkIsOneOfParts(p.youtube.url, p.view.replayParts) && youtubeCard}
          <div className="flex flex-col gap-2 md:flex-row">
            <button
              type="button"
              data-testid="stream-again"
              onClick={p.onAgain}
              className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
            >
              {msg("stream.phone.again")}
            </button>
          </div>
        </div>
      )}

      {state === "failed" && p.view && (
        <div data-testid="stream-failed" className={SUMMARY_CARD}>
          {statePill(msg, state)}
          <p
            data-testid="stream-fail-reason"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-800"
          >
            {/* m11: V410's fail_reason is a nullable text column with no CHECK — a row with none is not a machine crash. */}
            {msg(failReasonKey(p.view))}
          </p>
          {youtubeCard}
          <button
            type="button"
            data-testid="stream-retry"
            onClick={p.onAgain}
            className="btn btn-primary min-h-11 w-full md:min-h-10 md:w-auto"
          >
            {msg("stream.phone.retry")}
          </button>
        </div>
      )}

      {/* m1: D14's unreadable stop or cancel — only while the session is still up (the guard is `stopError`'s own). */}
      {stopFailure && <div className="mt-3">{stopFailure}</div>}

      {/* A refused create — in whatever state the refusal left the tab. An in-use refusal at Ready is under the picker. */}
      {p.createError && !inUseBox && !ytRefusalBox && (
        <p data-testid="stream-create-error" role="alert" className="mt-3 text-xs text-red-700">
          {createErrorText(p.createError, msg)}
        </p>
      )}
      {/* T8: the holding match's page, when it still has one — a deleted fixture has neither a number nor a page. */}
      {!inUseBox && inUseHolder?.href && inUseHolder.matchNo !== null && (
        <a data-testid="stream-in-use-open" href={inUseHolder.href} className={`${LINK} inline-flex min-h-11 items-center text-xs md:min-h-0`}>
          {msg("stream.inUse.open", { match: msg("breadcrumb.match", { no: inUseHolder.matchNo }) })}
        </a>
      )}

      {/* Spec §3.1: the credits are one line. At Ready it sits under Go live (above); in a session it closes the tab, where
          Buy more stays a mid-match top-up. */}
      {!(state === "idle" && !buyCard) && creditsLine}
      {buyCard &&
        creditsCard(msg, locale, {
          currency: p.currency,
          monthlyAllowance: p.monthlyAllowance,
          tilesDisabled: p.busy || frozen || p.checkoutOpen || p.seatPaused === true,
          paused: p.seatPaused,
          checkoutError: p.checkoutError,
          closable: p.showBuy && !forced,
          closeDisabled: frozen,
          rootMarker: "[data-phone-body]",
          onBuy: p.onBuy,
          onShowBuy: p.onShowBuy,
          onTileIntent: p.onTileIntent,
        })}

    </div>
  );
}
