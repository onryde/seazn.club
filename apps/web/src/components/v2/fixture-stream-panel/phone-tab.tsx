"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { captureQrV2Text, type CaptureQrV2 } from "@/lib/capture-qr";
import { apiV1 } from "@/lib/client-v1";
import { isSeatFrozenError } from "@/lib/seat-frozen";
import { fetchChannelSafety, needsChannelCheck } from "@/components/v2/stream-channel-safety";
import { useSeaznReplayActions } from "../seazn-replays-card";
import { channelStatus } from "../youtube-connect-panel";
import { useSharedPhoneSession } from "../stream-session-provider";
import { useTabReturn } from "../use-tab-return";
import type { Currency } from "@/lib/currency";
import { effectiveStreamMode } from "@/lib/stream-settings";
import { renderSeaznQr, type SeaznQr } from "@/lib/seazn-qr";
import {
  PRESENCE_WATCH_START,
  STREAM_POLL_MS,
  TARGET_REMOVED,
  isW5Refusal,
  presenceAfterRefusal,
  readClearsW5,
  type PresenceWatch,
  closeCodeOnPair,
  streamPairSeen,
  type PairSeen,
  createErrorCode,
  seaznRefinedCode,
  createErrorHolder,
  createErrorIsNotFound,
  readyStateOf,
  youtubeRefusalOf,
  youtubeLinkOf,
} from "@/lib/stream-session-view";
import { YOUTUBE_REFUSAL_REMEDY, type YoutubeRefusalCode } from "@/lib/youtube";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamPhone, StreamTarget } from "@/server/api-v1/schemas";
import type { StreamCreditSplit, CodeCard, TargetsState, CreateError, PhoneScore } from "./types";
import { switchedOff } from "./shared";
import { useCreditCheckout } from "./credits";
import { PhoneTabBody } from "./phone-tab-body";

/** True when stream code `a` was issued AFTER `b` (both ISO instants off the same server). An instant that does not
 *  parse falls back to "they differ" — the safe reading, since the card then re-asks rather than trusts a code it
 *  cannot order. Exported for its test. */
export function codeIsNewer(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a !== b : x > y;
}

// ─── The Phone tab (Streaming R1, lane D) ─────────────────────────────────────────────────────────────────────────────
// §8a option A ("Stepper") and §8b option A ("Three tiles"), values from `_THEMES.md`. Three pieces, each tested where
// it CAN be in a node harness: `PhoneTab` (the container — fetch, poll and every action), `PhoneTabBody` (pure: every
// state is a function of its props). Destinations are managed on the Streaming page (T8, D1): the tab only PICKS one
// (and saves it as the fixture's pre-pick, capture QR v2 §6.7.3), and links there. The code card's QR is painted at
// `PHONE_HANDOVER_QR_MAX_PX` — §8a's `QR size` cap, shared with Remote scoring's QR (`seazn-qr-image.tsx`).

/** Has the fact a `fix_destination` YouTube refusal reported been put right, as this fresh list reads it? A dead grant (`reconnect_needed`)
 *  is mended the moment the connection reads `connected` — whatever its `liveState`: a reconnect resets that to `unknown` until a health
 *  check has run since the token changed (server/youtube/connections.ts `liveStateOf`), so waiting for `enabled` would keep the block
 *  over a channel the organiser had just reconnected. The other two (not enabled for live, restricted) are about the channel's live
 *  state, which only a clean check (`enabled`, tone `ok`) can mend. */
export function youtubeRefusalIsStale(refusal: YoutubeRefusalCode, y: NonNullable<StreamTarget["youtube"]>): boolean {
  return refusal === "youtube_reconnect_needed" ? y.status === "connected" : channelStatus(y).tone === "ok";
}

/** One ask of the read model: its sequence number, the answer (null on any failure), and whether the failure was a paused seat. */
type PhoneAnswer = { seq: number; got: StreamPhone | null; frozen: boolean };

/**
 * The Phone tab's container: fetch + poll + actions. Everything visible is `PhoneTabBody`, so the node harness renders
 * every state without a network. The session itself — its reads, its poll and its stop — is `usePhoneSession`.
 */
export function PhoneTab({
  fixtureId,
  orgId,
  streamBalance,
  streamSplit,
  monthlyAllowance,
  currency,
  phoneLostMinutes,
  autoStopMinutes,
  pasteCodeShown,
  tz,
  score,
}: {
  fixtureId: string;
  orgId: string;
  streamBalance: number;
  streamSplit: StreamCreditSplit | null;
  monthlyAllowance: number;
  currency: Currency;
  /** W19: the server's phone-lost window (StreamPanelContext.phoneLostMinutes), handed to the body untouched. */
  phoneLostMinutes: number;
  /** PR-2 T10: the auto stop's delay (StreamPanelContext.autoStopMinutes), handed to the body untouched. */
  autoStopMinutes: number;
  /** Task 34: the paste field and Copy show (StreamPanelContext.pasteCodeShown), handed to the body untouched. */
  pasteCodeShown: boolean;
  /** PR-2 T12: the venue zone — the takeover notice's clock, as the row's. */
  tz: string;
  /** R2006: the score's availability, the stored mode and Ready's score card (the panel's). */
  score: PhoneScore;
}) {
  const msg = useMsg();
  // T9b: the page's ONE session (StreamSessionProvider, mounted by the console) — the Stream button's dot reads it too.
  const session = useSharedPhoneSession(fixtureId);
  const { view, shown, state, read, setBusy } = session;
  // Task 26: the organiser's Delete on a Seazn replay part — the house confirm, the route, then this session's own read.
  const replayActions = useSeaznReplayActions(fixtureId, read);
  // The provider read `current` when the PAGE loaded; opening the tab reads it again, as opening it always did — an idle
  // page does not poll, so a session started elsewhere since then shows now rather than at the next reload. Only when a
  // read had ALREADY landed: a session still on its first read (the page just loaded, or no provider at all) is about to
  // answer, and a second request would only race it.
  const loadedAtOpen = useRef(session.loaded);
  useEffect(() => {
    if (loadedAtOpen.current) void read().catch(() => {});
  }, [read]);
  const [targets, setTargets] = useState<TargetsState>({ status: "loading" });
  // Bumped by Retry: re-runs the list's read.
  const [targetsTry, setTargetsTry] = useState(0);
  // A LOUD read (the mount, Retry, another org) shows "loading", never the last answer — decided here, in render, from
  // the read's identity: a new (org, try) resets the list to loading in the same render that asks for it, instead of an
  // effect setting it after the paint.
  const targetsRead = `${orgId}|${targetsTry}`;
  const [targetsReadFor, setTargetsReadFor] = useState(targetsRead);
  if (targetsReadFor !== targetsRead) {
    setTargetsReadFor(targetsRead);
    setTargets({ status: "loading" });
  }
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<CreateError | null>(null);
  // Phase 0 (channel safety): the pre-Go-live notice is up; the next Go live tap ("Go live anyway") proceeds with no second check.
  const [safetyNotice, setSafetyNotice] = useState(false);
  // A ref, not state: a second tap landing before `busy` has flushed must not ask again (one tap = one read, 1 quota unit each).
  const safetyInFlight = useRef(false);
  // The purchase: the chooser, its one Checkout Session, the embedded sheet and a plan refusal (C22 / D12) — the ONE
  // copy the flag-off credits section uses too (B8 re-review item 2).
  const { checkoutError, setCheckoutError, checkoutSecret, planGate, setPlanGate, showBuy, setShowBuy, onBuy, onTileIntent, sheet } =
    useCreditCheckout({ orgId, fixtureId, setBusy });
  // m2: the server refused a create for want of credits — the page's balance is stale, so this tab reads 0 until the
  // next page load (a checkout return is one).
  const [noCredits, setNoCredits] = useState(false);
  const [copied, setCopied] = useState(false);

  // One read of the org's destinations. LOUD (the mount, Retry) shows the read in flight, never the last answer; QUIET
  // (I1: the organiser came back from Directory, or a Go live found its destination gone) keeps the picker on screen
  // until the answer, and a quiet read that fails keeps a list already shown. Each read takes a sequence number: only
  // the NEWEST read's answer — list or failure — lands (m2), so a slow older read never overwrites a newer one.
  // Resolves to the list it applied, or null (failed, or superseded).
  const listSeq = useRef(0);
  const listInFlight = useRef(false);
  // §6.7.3 / §17.13 (B8 review I-1, controller ruling): ONE selection — what the picker shows is what Go live sends and
  // what n1 and the in-use lift act on. Until the organiser picks in this tab it FOLLOWS the server's answer, the read
  // model's `destination` (`fixtureStreamTarget`: the target the phone's own start opens on), shown only while the list
  // holds it — so the organiser sees what the phone would stream to. Nothing is chosen here (no "the first in the list"),
  // and opening the panel writes nothing. After a pick it is the pick; a pick removed in Directory is CLEARED, never
  // swapped for another destination, until the next pick (B4 re-review n1) — the server answers the same (a saved choice
  // archived is none). Every answer settles against the state as it is THEN (the refs), not as it was when it was asked.
  const selectedRef = useRef<string | null>(null);
  const pickedHere = useRef(false);
  // B8 re-review n-5: the last pick's save failed — the picker went back to the server's answer, and says so.
  const [pickFailed, setPickFailed] = useState(false);
  // YouTube Connect T12: each "Use another destination" on a YouTube refusal bumps this; the picker opens on the change.
  const [pickerOpenSignal, setPickerOpenSignal] = useState(0);
  const serverPick = useRef<string | null>(null);
  const listShown = useRef<StreamTarget[] | null>(null);
  const settleSelection = useCallback((): string | null => {
    const list = listShown.current;
    let next: string | null = null;
    if (list !== null && list.length === 0) {
      // Nothing left to stand by: a later list follows the server again (which keeps a removed choice as none).
      pickedHere.current = false;
    } else if (list !== null) {
      const want = pickedHere.current ? selectedRef.current : serverPick.current;
      next = want !== null && list.some((t) => t.id === want) ? want : null;
    }
    selectedRef.current = next;
    setSelectedTargetId(next);
    return next;
  }, []);
  // The ask and the landing are two halves so an effect can start a read without setting state: `askTargets` only
  // takes the sequence number and asks; `landTargets` is what sets state, from the answer's own callback.
  const askTargets = useCallback(async (): Promise<{ seq: number; list: StreamTarget[] | null }> => {
    const seq = ++listSeq.current;
    listInFlight.current = true;
    try {
      // created_at order (listStreamTargets), so the first is the org's oldest destination.
      return { seq, list: await apiV1<StreamTarget[]>(`/api/v1/orgs/${orgId}/stream-targets`) };
    } catch {
      return { seq, list: null };
    }
  }, [orgId]);
  const landTargets = useCallback(
    ({ seq, list }: { seq: number; list: StreamTarget[] | null }, loud: boolean): StreamTarget[] | null => {
      try {
        if (seq !== listSeq.current) return null;
        if (list === null) {
          // Spec §3.3: an unreadable list is an ERROR with Retry — never "none" (the silent catch this replaces).
          setTargets((cur) => (loud || cur.status !== "ok" ? { status: "error" } : cur));
          return null;
        }
        setTargets({ status: "ok", list });
        listShown.current = list;
        const next = settleSelection();
        // A destination another match held (`target_in_use`) that this read finds FREE — or gone — no longer explains
        // anything: the hold is lifted and Go live may try again. One still held keeps it. Judged on the SHOWN selection,
        // and only here, where the list's `inUse` is fresh.
        const shownTarget = next === null ? undefined : list.find((t) => t.id === next);
        setCreateError((e) => (e?.code === "target_in_use" && !shownTarget?.inUse ? null : e));
        // YouTube Connect T12 (fix round 1, I2): a refusal that was about the CHANNEL's own state (a dead grant, not yet enabled for
        // live, restricted — `fix_destination`) goes stale once the fix is made elsewhere: the organiser reconnected on the Streaming
        // page and came back, and this read finds the channel healthy (or the destination gone). Judged on the SHOWN selection, here
        // where the list is fresh. A refusal that is still true (the channel still reads unhealthy) stays, and so does every
        // retry-class one (quota, ten live, YouTube silent): those carry their own Try again.
        setCreateError((e) => {
          const refusal = e === null ? null : youtubeRefusalOf(e.code);
          if (refusal === null || YOUTUBE_REFUSAL_REMEDY[refusal] !== "fix_destination") return e;
          return shownTarget?.youtube && !youtubeRefusalIsStale(refusal, shownTarget.youtube) ? e : null;
        });
        // B5 review m-2: an EMPTY list has nothing to "pick another" from — the empty state (No destinations yet + Manage)
        // says what to do, and a "removed" line kept past it would later sit beside an enabled Go live.
        if (list.length === 0) setCreateError((e) => (e?.code === TARGET_REMOVED ? null : e));
        return list;
      } finally {
        if (seq === listSeq.current) listInFlight.current = false;
      }
    },
    [settleSelection],
  );
  const readTargets = useCallback(
    async (loud: boolean): Promise<StreamTarget[] | null> => landTargets(await askTargets(), loud),
    [askTargets, landTargets],
  );
  // The mount and each Retry: a loud read. No cleanup is owed — another org's read (a new `askTargets`) takes a newer
  // sequence number, so the old answer is dropped by the rule above, and React ignores a set after unmount.
  useEffect(() => {
    void askTargets().then((answer) => landTargets(answer, true));
  }, [askTargets, landTargets, targetsTry]);
  // Capture QR v2 §6.12: the phone's read model, polled every STREAM_POLL_MS while the tab is open — beside the session's
  // own poll, which idles at Ready. A failed read keeps the last answer (the next poll tries again); the first answer, or
  // its failure, is what lets the body render — a Ready state drawn before it would flash "no phone" at a paired one.
  // B8 review m-4: each read takes a sequence number, and only the NEWEST read's answer lands — an older poll answering
  // after a newer read (the reissue's, a tab return's) never puts stale facts back on screen.
  const [phone, setPhone] = useState<StreamPhone | null>(null);
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  // Task 33e: the read model's last ask was refused 402 members.max (the seat is paused). The session's own pause is `session.seatFrozen`.
  const [phoneFrozen, setPhoneFrozen] = useState(false);
  // Either read refused: the panel says why (the body's line) and keeps what it already shows.
  const seatPaused = session.seatFrozen || phoneFrozen;
  const phoneSeq = useRef(0);
  // "Show the code again" is open (the stream code, below). Task 35 (owner 2026-11-24): a phone pairing closes it ONCE, from
  // the landed read (`closeCodeOnPair` over `streamPairSeen`): a phone where there was none, or another phone taking the slot.
  // A re-poll of the same pairing leaves it as the organiser set it, so opened again it stays open. `pairSeen` is the last
  // landed read's pairing (null before the first: the fold is not drawn until it lands, and it starts closed).
  const [codeOpen, setCodeOpen] = useState(false);
  const pairSeen = useRef<PairSeen>(null);
  // Owner ruling 2026-10-09 ("A"): a Go live refused for want of a phone clears on the first present answer to a read
  // sent after the refusal (`readClearsW5`); the watch lives in a ref so the interval's callback never reads a stale one.
  const presence = useRef<PresenceWatch>(PRESENCE_WATCH_START);
  // Ask and land are two halves (as for the destination list): `askPhone` takes the sequence number and asks, and sets
  // nothing; `landPhone` is what sets state, from the answer's own callback — so the mount effect starts a read
  // without calling a state setter, and the poll and the actions read through `readPhone`.
  const askPhone = useCallback(async (): Promise<PhoneAnswer> => {
    const seq = ++phoneSeq.current;
    try {
      return { seq, got: await apiV1<StreamPhone>(`/api/v1/fixtures/${fixtureId}/stream-phone`), frozen: false };
    } catch (err) {
      // transient — the poll asks again; except a paused seat (Task 33e: 402 members.max), which no ask can mend — it stops the poll
      return { seq, got: null, frozen: isSeatFrozenError(err) };
    }
  }, [fixtureId]);
  const landPhone = useCallback(
    ({ seq, got, frozen }: PhoneAnswer) => {
      try {
        if (seq === phoneSeq.current && (frozen || got !== null)) setPhoneFrozen(frozen);
        if (got === null || seq !== phoneSeq.current) return;
        setPhone(got);
        const seen = streamPairSeen(got);
        if (closeCodeOnPair(pairSeen.current, seen)) setCodeOpen(false);
        pairSeen.current = seen;
        if (readClearsW5(presence.current, { seq, present: got.phone?.present === true })) {
          setCreateError((e) => (e !== null && isW5Refusal(e.code) ? null : e));
        }
        const answer = got.destination?.id ?? null;
        // B8 final re-review n-6: "couldn't save" is news only while the server's answer is the one it was said beside —
        // an answer that CHANGES (saved from another device or tab) retires it. A poll answering the same keeps it.
        if (answer !== serverPick.current) setPickFailed(false);
        serverPick.current = answer;
        settleSelection();
      } finally {
        setPhoneLoaded(true);
      }
    },
    [settleSelection],
  );
  const readPhone = useCallback(async () => landPhone(await askPhone()), [askPhone, landPhone]);
  useEffect(() => {
    void askPhone().then(landPhone);
  }, [askPhone, landPhone]);
  // Task 33e: a paused seat is refused every ask, so the poll stops (the answer on screen stays); the tab return below is its
  // one re-check, and a read that lands clears the pause and starts the poll again.
  useEffect(() => {
    if (phoneFrozen) return;
    const id = setInterval(() => void readPhone(), STREAM_POLL_MS);
    return () => clearInterval(id);
  }, [readPhone, phoneFrozen]);

  // PR-2 T10 (§7.1): the switch writes `PUT …/stream-settings { autoStream }` — the switch ALONE (the route writes only the
  // fields a PUT names, so the pick is untouched) — then reads the read model again: its `auto.enabled` is the answer the
  // switch shows. While the save is in flight the switch shows what was asked (`autoPending`), and is held; a failed save
  // goes back to the server's answer and says so. The PUT's own answer is never shown (its `targetId` is the SAVED pick,
  // not the destination the phone would stream to).
  const [autoPending, setAutoPending] = useState<boolean | null>(null);
  const [autoFailed, setAutoFailed] = useState(false);
  const onToggleAuto = async (on: boolean) => {
    setAutoPending(on);
    setAutoFailed(false);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { autoStream: on } });
      await readPhone();
    } catch {
      setAutoFailed(true);
    } finally {
      setAutoPending(null);
    }
  };

  // PR-2 T12 (§7.5): the takeover notice's X — remembered per takeover INSTANT for this fixture, in this browser only (a
  // per-viewer convenience: a storage that refuses, or a private window, just shows the notice again next time).
  const dismissKey = `seazn.stream.takeoverDismissed.${fixtureId}`;
  const [takeoverDismissedAt, setTakeoverDismissedAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(dismissKey);
    } catch {
      return null;
    }
  });
  const onDismissTakeover = (at: string) => {
    setTakeoverDismissedAt(at);
    try {
      localStorage.setItem(dismissKey, at);
    } catch {
      // the dismissal holds for this view; nothing else depends on it
    }
  };

  // I1: "Manage destinations" opens Directory in a NEW tab, so coming back never remounts this one — the return re-reads
  // the list, while the picker is up, and the read model with it: the destination the server would now stream to (one
  // added, or the choice archived) is what the picker shows. A real return fires focus AND visibilitychange: a read
  // already in flight answers both.
  const onTabReturn = useCallback(() => {
    if (listInFlight.current) return;
    void readTargets(false);
    void readPhone();
  }, [readTargets, readPhone]);
  // Task 33e: also while paused with a session on screen — the one re-check the pause is owed (the seat may have been freed).
  useTabReturn(onTabReturn, state === "idle" || seatPaused);

  // B8 review I-2: the PHONE starts sessions too (T8's start), and `current` rests at Ready — so the read model names the
  // fixture's open session, and one the shared session does not hold is read from `current`, ONCE per id. Otherwise the
  // organiser would watch "Paired · Go live" while the phone is warming, and Go live would meet `active_session`. A read
  // that fails is asked again on the next answer of the read model.
  const openSid = phone?.session?.id ?? null;
  const readForSid = useRef<string | null>(null);
  useEffect(() => {
    if (openSid === null || openSid === view?.id || readForSid.current === openSid) return;
    readForSid.current = openSid;
    void read().catch(() => {
      readForSid.current = null;
    });
  }, [openSid, view?.id, phone, read]);

  const ready = readyStateOf(phone, shown);
  const legacy = phone?.legacy ?? false;
  // Court stream (spec 2026-11-14 §5.2): a match its court's phone streams has no code of its own to show — the read model names
  // the court instead, and the panel neither asks for a code nor mints one (the server refuses the mint too: court_streamed).
  const court = phone?.court ?? null;

  // The stream code (§6.1): asked for LAZILY — when Ready has no phone (the card shows it), or when the organiser opens
  // "Show the code again". Never for a legacy session or a match that is over (ensure answers 422 there). The QR is
  // rendered CLIENT-SIDE from the answer — never in page HTML — and the answer is never cached (`private, no-store`).
  type Code = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ok"; qr: CaptureQrV2; issuedAt: string };
  const [code, setCode] = useState<Code>({ status: "idle" });
  // `askCode` only asks (and sets nothing); the answer is landed by `landCode`, from its own callback — which is how the
  // effect below starts an ask without calling a state setter. `ensureCode` is the event-handler form (Retry): it shows
  // the ask in flight first.
  const askCode = useCallback(async (): Promise<{ qr: CaptureQrV2; issuedAt: string } | null> => {
    try {
      const got = await apiV1<{ qr: CaptureQrV2; issuedAt: string }>(`/api/v1/fixtures/${fixtureId}/stream-code`, { method: "POST" });
      return { qr: got.qr, issuedAt: got.issuedAt };
    } catch {
      return null;
    }
  }, [fixtureId]);
  const landCode = useCallback((got: { qr: CaptureQrV2; issuedAt: string } | null) => {
    setCode(got === null ? { status: "error" } : { status: "ok", qr: got.qr, issuedAt: got.issuedAt });
  }, []);
  const ensureCode = useCallback(async () => {
    if (court !== null) return;
    setCode({ status: "loading" });
    landCode(await askCode());
  }, [askCode, landCode, court]);
  const wantCode = phoneLoaded && court === null && !legacy && ready !== "code_ended" && (ready === "no_phone" ? state === "idle" : codeOpen);
  // The read model names the code the server holds NOW. One the card does not show — reissued from another tab, or the
  // shown one ended (expired) on a match no longer finished (C5) — is asked for again, ONCE per such answer, so a stale
  // read can never spin the ensure.
  const codeSeen = phone?.code ? `${phone.code.issuedAt}|${phone.code.state === "ended" ? "ended" : "open"}` : null;
  // A shown code the read model has moved past is stale: reissued from another tab it is already REVOKED, and an ended
  // one on a match still going is dead. One predicate for the card (it draws `loading` for a stale code — a revoked code
  // must never stay scannable, with "Reissue" enabled, until the new one lands) and for the re-ask below. "Moved past"
  // is ORDERED: a read model that names an OLDER code than the card holds is only lagging (the answer to our own
  // reissue or re-ask lands before the next poll does), and blanking a fresh code until the poll catches up would be a
  // spinner the organiser did nothing to deserve.
  const codeStale =
    code.status === "ok" &&
    !!phone?.code &&
    (codeIsNewer(phone.code.issuedAt, code.issuedAt) || (phone.code.state === "ended" && !phone.finished && !codeIsNewer(code.issuedAt, phone.code.issuedAt)));
  const askedFor = useRef<string | null>(null);
  // The FIRST ask is in flight (a poll can re-run the effect before it answers). While it is, `code` is still `idle`
  // — and the card already draws `idle` as loading, so no state needs setting to show the ask.
  const firstAskOpen = useRef(false);
  useEffect(() => {
    if (!wantCode) return;
    if (code.status === "idle") {
      if (firstAskOpen.current) return;
      firstAskOpen.current = true;
      askedFor.current = codeSeen;
      void askCode().then((got) => {
        firstAskOpen.current = false;
        landCode(got);
      });
      return;
    }
    if (!codeStale || codeSeen === null || askedFor.current === codeSeen) return;
    askedFor.current = codeSeen;
    // The card already draws `loading` for the stale code (derived, above); the answer replaces it — a new code, or the
    // error card when the ask is refused.
    void askCode().then(landCode);
  }, [wantCode, code.status, codeStale, codeSeen, askCode, landCode]);
  const codeText = code.status === "ok" ? captureQrV2Text(code.qr) : null;
  const [codeImage, setCodeImage] = useState<{ text: string; qr: SeaznQr } | null>(null);
  // Task 34 fix round 1 (m1): the text whose encode FAILED (null: none) and Retry's nonce. Where the paste code is hidden
  // (stg, prod) a failed encode is otherwise a placeholder pulsing forever. Re-asking the server answers the SAME code, so
  // `codeText` would not change and the encode would not re-run: the nonce re-runs it.
  const [qrFailedFor, setQrFailedFor] = useState<string | null>(null);
  const [encodeTry, setEncodeTry] = useState(0);
  useEffect(() => {
    if (!codeText) return;
    let cancelled = false;
    // An SVG: it scales, and the box decides the painted size (snapped to whole device px per module, §8a).
    void renderSeaznQr(codeText)
      .then((qr) => {
        if (!cancelled) setCodeImage({ text: codeText, qr });
      })
      .catch(() => {
        // The code's error line with Retry takes the placeholder's place (PhoneTabBody `qrFailed`).
        if (!cancelled) setQrFailedFor(codeText);
      });
    return () => {
      cancelled = true;
    };
  }, [codeText, encodeTry]);
  const onRetryQr = () => {
    setQrFailedFor(null);
    setEncodeTry((n) => n + 1);
  };
  const codeCard: CodeCard =
    code.status === "ok" && !codeStale
      ? { status: "ok", text: codeText!, image: codeImage && codeImage.text === codeText ? codeImage.qr : null }
      : code.status === "error"
        ? { status: "error" }
        : { status: "loading" };

  // Revoke & reissue (§6.12): the house confirm, danger tone. The old code stops at once (a phone already streaming keeps
  // its session — ruling A: the remedy for a stranger who scanned it); the answer IS the new code.
  const confirm = useConfirm();
  const onReissue = async () => {
    const ok = await confirm({
      title: msg("stream.code.reissue.confirm.title"),
      body: msg("stream.code.reissue.confirm.body"),
      confirmLabel: msg("stream.code.reissue.confirm.button"),
      tone: "danger",
      size: "touch",
    });
    if (!ok) return;
    setCode({ status: "loading" });
    try {
      const got = await apiV1<{ qr: CaptureQrV2; issuedAt: string }>(`/api/v1/fixtures/${fixtureId}/stream-code/reissue`, { method: "POST" });
      setCode({ status: "ok", qr: got.qr, issuedAt: got.issuedAt });
    } catch {
      setCode({ status: "error" });
    }
    void readPhone();
  };

  // C1: with a session, the projection's `balance` is the fresher number. With NO session there is no projection at
  // all, so the server-resolved one is the only source — unless the server has since refused for want of credits (m2).
  const balance = view ? view.balance : noCredits ? 0 : streamBalance;

  const onGoLive = async () => {
    // Court device check (2026-11-19, finding B): a court-streamed match goes to its court link's channel whatever the body names
    // (O9, `createSession`), and its panel draws no picker — so it needs no pick of its own. With none (the match's own saved
    // choice archived, say) it sends any listed destination; the server streams to the court's channel regardless.
    const chosen = selectedTargetId ?? (court !== null && targets.status === "ok" ? (targets.list[0]?.id ?? null) : null);
    if (!chosen) return;
    // Phase 0 (channel safety): ONE check per Go live tap, for a YouTube Connect destination only, and never for a court-streamed match
    // (its stream goes to the court link's channel, a connection this panel does not hold, so the picked row says nothing about it). The
    // notice is non-blocking: while it is up, the next tap is "Go live anyway" and goes straight through. A failed read goes live.
    const checked = targets.status === "ok" ? targets.list.find((t) => t.id === chosen) : undefined;
    if (!safetyNotice && court === null && needsChannelCheck(checked)) {
      if (safetyInFlight.current) return;
      safetyInFlight.current = true;
      setBusy(true);
      let verdict: Awaited<ReturnType<typeof fetchChannelSafety>>;
      try {
        verdict = await fetchChannelSafety(orgId, checked!.youtube!.connectionId);
      } finally {
        safetyInFlight.current = false;
      }
      if (verdict?.warn) {
        setSafetyNotice(true);
        setBusy(false);
        return;
      }
    }
    setSafetyNotice(false);
    await startLive(chosen);
  };

  const startLive = async (chosen: string) => {
    setBusy(true);
    setCreateError(null);
    try {
      // R2006 (Option C): the mode the tab SHOWS — the score unless the organiser chose Camera only or this deployment
      // cannot run it (the same rule the phone's start and the automatic start resolve, `effectiveStreamMode`) — and,
      // for the score, the style the picker shows and the timing Score timing shows (m2: carried, so Go live never races
      // the timing's own save — the session copies what the organiser saw).
      const mode = effectiveStreamMode(score.stored, score.available);
      await apiV1(`/api/v1/fixtures/${fixtureId}/stream-sessions`, {
        method: "POST",
        json:
          mode === "composed"
            ? { mode, targetId: chosen, ...(score.template !== null ? { themeId: score.template } : {}), overlayDelayMs: score.delayMs }
            : { mode, targetId: chosen },
      });
      // n-6: the start saved its destination — a pick that did not save is no longer news, at Ready after it either.
      setPickFailed(false);
    } catch (err) {
      const code = seaznRefinedCode(createErrorCode(err), targets.status === "ok" ? targets.list.find((t) => t.id === chosen)?.kind : undefined);
      // D12: "your plan, not your credits" is the upgrade surface, never a retry sentence.
      if (code === "plan_lacks_relay") {
        setPlanGate(true);
        setBusy(false);
        return;
      }
      // Task 33e follow-up: the seat was paused after this tab loaded (the polls had not been refused yet). The panel's seat line is the
      // whole answer (no second sentence), Go live and Buy more go off, and the read model's poll stops; nothing is re-read.
      if (code === "seat_paused") {
        setPhoneFrozen(true);
        setBusy(false);
        return;
      }
      // m2: "no credits" is answered where it is asked — the chooser opens, at the balance the server just reported.
      if (code === "no_credits") {
        setNoCredits(true);
        setShowBuy(true);
      }
      // I1: a 404 may be the destination removed in Directory while this tab stayed open (D2 answers an archived target
      // with the plain not-found shape). The list is read again: gone from it → say so, and the stale choice is cleared
      // (n1: never another destination in its place); still listed → the 404 was about something else, the generic
      // refusal.
      const reread = createErrorIsNotFound(err) ? await readTargets(false) : null;
      const removed = reread !== null && !reread.some((t) => t.id === chosen);
      // m-2: removed and NOTHING left — the empty state is the whole answer; "pick another" would point at nothing.
      if (!(removed && reread.length === 0)) {
        setCreateError({ code: removed ? TARGET_REMOVED : code, holder: createErrorHolder(err) });
        // "A": a W5 refusal is news that there was no phone — only a read asked from here on may clear it.
        presence.current = presenceAfterRefusal(presence.current, code, phoneSeq.current);
      }
    }
    // Either way the server's state is the answer: the new session, or — after a refusal — whatever is there (an
    // `active_session` refusal's running session IS the explanation; a dismissed card stays dismissed).
    await read().catch(() => {});
    setBusy(false);
  };

  const onCopy = async () => {
    if (!codeText) return;
    try {
      await navigator.clipboard.writeText(codeText);
    } catch {
      return; // a browser that refuses the clipboard leaves the field selectable; nothing was taken
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // I1: a plan refusal REPLACES the tab only when there is nothing to protect. With a session up, Stop (and Cancel)
  // must survive it — the body renders the gate in the buy slot instead.
  if (planGate && state === "idle") return switchedOff(msg);
  if (!session.loaded || !phoneLoaded) {
    return (
      <p data-testid="stream-loading" role="status" aria-busy="true" className="text-xs text-slate-600">
        <span aria-hidden>…</span>
        <span className="sr-only">{msg("stream.phone.loading")}</span>
      </p>
    );
  }
  return (
    <>
      <PhoneTabBody
        fixtureId={fixtureId}
        view={shown}
        replayActions={replayActions}
        balance={balance}
        targets={targets}
        busy={session.busy}
        createError={createError}
        checkoutError={checkoutError}
        selectedTargetId={selectedTargetId}
        phone={phone}
        code={codeCard}
        codeOpen={codeOpen}
        now={session.now}
        copied={copied}
        showBuy={showBuy}
        planGate={planGate}
        stopFailed={session.stopFailed}
        checkoutOpen={checkoutSecret !== null}
        currency={currency}
        split={streamSplit}
        monthlyAllowance={monthlyAllowance}
        phoneLostMinutes={phoneLostMinutes}
        autoStopMinutes={autoStopMinutes}
        pasteCodeShown={pasteCodeShown}
        autoPending={autoPending}
        autoFailed={autoFailed}
        onToggleAuto={(on) => void onToggleAuto(on)}
        takeoverDismissedAt={takeoverDismissedAt}
        onDismissTakeover={onDismissTakeover}
        tz={tz}
        // I-1: off the RAW view, not `shown` — Start another / Try again dismiss the card, and the fixture's reuse window
        // is exactly what the next start is asking about. No session ever → nothing consumed → no window (W23).
        restart={view?.restart ?? null}
        // Owner 2026-10-30: off the RAW view as well — the match's video stays linked at Ready after Start another.
        youtube={youtubeLinkOf(view)}
        pickFailed={pickFailed}
        seatPaused={seatPaused}
        // n1: a pick is the organiser's own answer — the refusal that was about the previous choice (removed, held by
        // another match, or refused by YouTube — T12) goes with it. Any other refusal stays until the next attempt. (The hold needs no reset: a picked
        // selection only empties again through another removal, which holds it again.)
        onSelectTarget={(id) => {
          pickedHere.current = true;
          selectedRef.current = id;
          setSelectedTargetId(id);
          setSafetyNotice(false);
          setCreateError((e) => (e && (e.code === TARGET_REMOVED || e.code === "target_in_use" || youtubeRefusalOf(e.code) !== null) ? null : e));
          setPickFailed(false);
          // §6.7.3: the picker writes the fixture's pre-pick on change — what the phone's own start streams to. A PICK is
          // the only write: opening the panel, or following the server's answer, saves nothing (I-1).
          // B8 re-review n-5: the save is what keeps the phone's start in agreement with the picker (§17.13), so a failure
          // is not swallowed. If this pick is still the selection, the picker goes back to the server's answer — what the
          // phone streams to — and says the pick did not save. A failure for a pick already replaced is moot.
          void apiV1(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { targetId: id } }).catch(() => {
            if (!pickedHere.current || selectedRef.current !== id) return;
            pickedHere.current = false;
            settleSelection();
            setPickFailed(true);
          });
        }}
        onPickAnother={() => {
          setCreateError(null);
          setPickerOpenSignal((n) => n + 1);
        }}
        pickerOpenSignal={pickerOpenSignal}
        onRetryTargets={() => setTargetsTry((n) => n + 1)}
        onGoLive={() => void onGoLive()}
        safetyNotice={safetyNotice}
        onDismissSafety={() => setSafetyNotice(false)}
        onStop={() => {
          setCreateError(null);
          void session.stop();
        }}
        // Cancel on the QR asks nothing while nothing is on air — `cancel` re-reads first and confirms if it now is.
        onCancel={() => {
          setCreateError(null);
          void session.cancel();
        }}
        onBuy={(pack) => void onBuy(pack)}
        onAgain={() => {
          session.dismiss();
          setCreateError(null);
          setCheckoutError(null);
        }}
        onCopy={() => void onCopy()}
        onToggleCode={setCodeOpen}
        onReissue={() => void onReissue()}
        onRetryCode={() => void ensureCode()}
        qrFailed={codeCard.status === "ok" && qrFailedFor === codeCard.text}
        onRetryQr={onRetryQr}
        // Buy more and the chooser's Close (B6) are one toggle; either way a refusal from the last attempt goes.
        onShowBuy={() => {
          setShowBuy((v) => !v);
          setCheckoutError(null);
        }}
        onTileIntent={onTileIntent}
        score={score}
      />
      {sheet}
    </>
  );
}
