// The overlay page as the COMPOSITOR's render target (R2005; overlay templates spec 2026-10-15 §4.1–4.3, compositor
// spec 2026-10-14 §6). Pure and client-safe: the page's hooks (`use-compositor-signals.ts`, `use-programme-phase.ts`)
// own the timers and the network, and every rule they apply lives here, where a test can reach it without a browser.
//
// Everything below is OFF unless the URL carries `host=compositor` — the composed session's `overlayUrl`
// (`sessionFactsForJob`, R2004) is the only producer of it. An OBS browser source never sets it, so an OBS user sees,
// logs and fetches nothing new.
//
// THE SIGNALS ride F-001's console channel (compositor `_FINDINGS.md` F-001): CEF runs with
// `listen-for-js-signals=false` and C11 reads `cefconsole` log lines. `gstSendMsg` is never used — it accepts only
// `ready`/`eos`, and its js-signal mode hangs the compositor's `start()` and `set_state(NULL)` (F-001).
import { parseRelayPhaseReply, type PhaseChannel, type ProgrammePhaseWire } from "@/lib/relay-phase";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { sponsorMomentId, type SponsorStyle } from "@/lib/sponsor-plan";

/** The `host` query value that turns the compositor signals on (R2004 decision 5 builds the URL with it). */
export const COMPOSITOR_HOST = "compositor";

/** Is this `?host=` value the compositor's? A repeated `host` (an array) is not. */
export function isCompositorHost(value: unknown): boolean {
  return value === COMPOSITOR_HOST;
}

/** Compositor spec §6 ("Score feed stale: the page keeps the last state and signals `scoreStale` after 10 s"): the
 *  last SUCCESSFUL live-data update older than this is a stale score. Equal to the compositor's `cef_hang_after_ms`
 *  (five beats), so the two silences the compositor reads are one length. */
export const SCORE_STALE_AFTER_MS = 10_000;

/** Compositor Owed 18 (owner, 2026-10-18, "2 Ok"): the alive beat's period. The compositor's own
 *  `cef_alive_every_ms` (crates/domain/src/config.rs, C02) is the same 2 000; it counts `cef_hang_after_ms` (10 000) of
 *  silence after ready as a hang and restarts the page. */
export const OVERLAY_ALIVE_EVERY_MS = 2_000;

/** Spec §4.3: this many CONSECUTIVE loopback failures switch the page to fallback B (the overlay route's
 *  `programmePhase`, from the compositor's heartbeat). */
export const PHASE_LOOPBACK_FAILURES_TO_FALLBACK = 3;

/** Compositor `_FINDINGS.md` F-009, outcome (a): CEF 139 lets the page reach `http://127.0.0.1:7419` (the Private
 *  Network Access preflight is SENT, and not enforced), so the channel STARTS in loopback. Had Step 0 recorded outcome
 *  (c), "blocked", this would be `web` and the page would never fetch loopback. */
export const PHASE_CHANNEL_START: PhaseChannel = "loopback";

/** A loopback reply later than the long-poll's own hold plus this is a failure (the hook's AbortController). */
export const PHASE_REPLY_GRACE_MS = 2_000;

/** After a FAILED loopback request the hook waits this long before the next one, so a server that refuses instantly
 *  (connection refused while C12 binds, a 503 for a fifth concurrent poll) is not spent in three back-to-back requests
 *  in one millisecond. A success is followed at once — the long poll is its own pacing. */
export const PHASE_RETRY_AFTER_FAILURE_MS = 1_000;

/** F-001: the ready line C11 reads (`CefReady`). Logged ONCE. */
export const SIGNAL_READY = "seazn:ready";
/** Owed 18: the alive beat (`CefAlive`). The bare word — the design's optional `stale=0|1` suffix is not built: the
 *  score-stale signal stays its own edge-triggered line. */
export const SIGNAL_ALIVE = "seazn:alive";
/** The score-stale line (C11's `ScoreStale(bool)`). No compositor document pins this line's form (C11's row says only
 *  "a JS signal on the same channel as ready"); R2005 defines it here and records it for C11. */
export const scoreStaleSignal = (stale: boolean): string => `seazn:score-stale=${stale ? "true" : "false"}`;
/** Spec §4.3: which channel the page reads the phase from; C11 relays it and C07 puts it on the beat. */
export const phaseChannelSignal = (channel: PhaseChannel): string => `seazn:phase-channel=${channel}`;

/** Is the score stale at `now`, given the wall time of the last successful live-data update? Stale AT the threshold
 *  (`>=`): "older than 10 s" flips on the 10 000th millisecond, never one before it. */
export function isScoreStale(lastSuccessAt: number, now: number): boolean {
  return now - lastSuccessAt >= SCORE_STALE_AFTER_MS;
}

/** An emitter that passes a value on only when it differs from the last one it passed. The FIRST value always passes:
 *  the compositor holds `score_stale: None` until the page reports it (crates/domain/src/health.rs), so the page's first
 *  known value is itself the change from "unknown". */
export function changeOnly<T>(emit: (value: T) => void): (value: T) => void {
  let has = false;
  let last: T;
  return (value) => {
    if (has && Object.is(value, last)) return;
    has = true;
    last = value;
    emit(value);
  };
}

/** The phase channel (spec §4.3). `seq` is the newest loopback `seq` adopted; −1 until the first, so the endpoint's
 *  own `(waiting, 0)` — what C12 serves before any publish — is adopted rather than read as stale. */
export interface PhaseChannelState {
  channel: PhaseChannel;
  /** Consecutive loopback failures. */
  failures: number;
  phase: ProgrammePhaseWire | null;
  seq: number;
}

export type PhaseChannelEvent =
  | { type: "loopbackOk"; phase: ProgrammePhaseWire; seq: number }
  | { type: "loopbackFailed" }
  | { type: "webPhase"; phase: ProgrammePhaseWire | null };

export const PHASE_CHANNEL_INITIAL: PhaseChannelState = {
  channel: PHASE_CHANNEL_START,
  failures: 0,
  phase: null,
  seq: -1,
};

/**
 * The channel's one rule set. Each channel ignores the other's events. In `loopback`:
 *  - a reply with a NEWER `seq` is adopted and resets the failure count;
 *  - a reply whose `seq` is not newer is no new phase — it is what a long poll that ran out its hold answers (C12:
 *    "then 200 with the current value") — so it changes nothing but the failure count, which it resets: the endpoint
 *    answered, which is all a failure count measures;
 *  - `PHASE_LOOPBACK_FAILURES_TO_FALLBACK` consecutive failures switch to `web`.
 * `web` is STICKY for the page's life (a resolved spec ambiguity: §4.3 says when to switch, not whether to come back).
 * A CEF restart reloads the page, which tries loopback again, so there is no in-page flapping.
 * The page renders the phase it is given and debounces nothing (§4.3): C03 already applied the thresholds.
 */
export function phaseChannelStep(state: PhaseChannelState, event: PhaseChannelEvent): PhaseChannelState {
  switch (event.type) {
    case "loopbackOk": {
      if (state.channel !== "loopback") return state;
      if (event.seq <= state.seq) return state.failures === 0 ? state : { ...state, failures: 0 };
      return { ...state, failures: 0, phase: event.phase, seq: event.seq };
    }
    case "loopbackFailed": {
      if (state.channel !== "loopback") return state;
      const failures = state.failures + 1;
      return failures >= PHASE_LOOPBACK_FAILURES_TO_FALLBACK
        ? { ...state, channel: "web", failures }
        : { ...state, failures };
    }
    case "webPhase": {
      if (state.channel !== "web") return state;
      return state.phase === event.phase ? state : { ...state, phase: event.phase };
    }
  }
}

/** The loopback reply, validated before it reaches the reducer (review m12): `parseRelayPhaseReply` is the twin of the
 *  contract's `phaseReply` (STRICT: exactly `phase` and `seq`, a declared phase, a whole `seq` ≥ 0). Anything else —
 *  an undeclared phase, a negative `seq`, an extra key, not JSON at all — is a FAILURE, never a phase. */
export function phaseReplyEvent(body: unknown): PhaseChannelEvent {
  const reply = parseRelayPhaseReply(body);
  return reply === null ? { type: "loopbackFailed" } : { type: "loopbackOk", phase: reply.phase, seq: reply.seq };
}

/** The channel to announce, or null while nothing has settled: `loopback` once a loopback request has been ANSWERED,
 *  `web` once the page has fallen back. Logged once per value (`changeOnly`). */
export function settledChannel(state: PhaseChannelState, loopbackAnswered: boolean): PhaseChannel | null {
  if (state.channel === "web") return "web";
  return loopbackAnswered ? "loopback" : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// R4 sponsors on stream, S7 — proof of play (spec 2026-10-27 §3.6). Same channel as the ready line: at
// `host=compositor` only, a sponsor moment ENTERING `hold` logs a start line and LEAVING `out` logs an end line; the
// compositor (SC1) validates each, buffers them and sends them on its next heartbeat as `airings`, where S8 records
// them. Until SC1's reader ships, the live compositor logs each line as an unknown page signal at WARN — noise, never a
// failure (preflight row 19).
// ---------------------------------------------------------------------------------------------------------------------

export const SIGNAL_SPONSOR_START = "seazn:sponsor:start";
export const SIGNAL_SPONSOR_END = "seazn:sponsor:end";
/** Spec §3.6: the compositor's reader takes "bounded JSON ≤ 512 bytes". Counted in UTF-8 BYTES, the reader's unit. */
export const SPONSOR_LINE_MAX_BYTES = 512;

/** Spec §3.6, verbatim and in its order. The compositor adds `kind`; the page never sends it. */
const START_KEYS = ["momentId", "cardId", "style", "source", "breakKind", "at"] as const;
const END_KEYS = ["momentId", "at", "cutShort"] as const;

/** Ruling R5: the page sends `scene` for a carousel showing and `rotation` for every break card — the server (S8)
 *  takes the real source (rotation or operator) for a non-scene start from `sponsor_assignments`. */
export type SponsorLineSource = "rotation" | "scene";

export interface SponsorStartBody {
  momentId: string;
  cardId: string;
  style: SponsorStyle;
  source: SponsorLineSource;
  /** Null for a carousel showing: a scene is not a break. */
  breakKind: string | null;
  at: string;
}
export interface SponsorEndBody {
  momentId: string;
  at: string;
  cutShort: boolean;
}

/** A line the compositor's reader would refuse: a key set other than the spec's, or a body past the byte bound. */
export class SponsorLineError extends Error {
  override name = "SponsorLineError";
}

/** One proof-of-play line: the signal, one space, the body as JSON with exactly the spec's keys in the spec's order.
 *  Throws `SponsorLineError` rather than emit a line the reader would drop. */
export function sponsorLine(kind: "start" | "end", body: object): string {
  const want: readonly string[] = kind === "start" ? START_KEYS : END_KEYS;
  const got = Object.keys(body);
  if (got.length !== want.length || !want.every((k) => Object.hasOwn(body, k))) {
    throw new SponsorLineError(`${kind} line: keys ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  const values = body as Record<string, unknown>;
  const json = JSON.stringify(Object.fromEntries(want.map((k) => [k, values[k]])));
  const size = new TextEncoder().encode(json).length;
  if (size > SPONSOR_LINE_MAX_BYTES) throw new SponsorLineError(`${kind} line: ${size} bytes, over ${SPONSOR_LINE_MAX_BYTES}`);
  return `${kind === "start" ? SIGNAL_SPONSOR_START : SIGNAL_SPONSOR_END} ${json}`;
}

/** What the tracker reads of the moment queue (`MomentQueueState`): who is on air, in which phase, and which sponsor
 *  ids ran short. Structural, so this pure module does not import the component tree. */
export interface SponsorQueueView {
  current: OverlayMoment | null;
  phase: "in" | "hold" | "out";
  cutShort: readonly string[];
}

/**
 * The queue's proof-of-play lines for one committed state (preflight row 17: a pure helper, so the rule is testable
 * without a browser). `onAir` is the sponsor moment id whose START line has been logged and whose END has not.
 *  - The tracked card is no longer current ⇒ ONE end line, `cutShort` read off the queue (a score cut, a skip, an undo).
 *  - A sponsor moment is current in `hold` and not yet tracked ⇒ ONE start line.
 * A card the queue cut while it was still folding IN never reached `hold`, so it logs no start and therefore no end
 * (S6 addendum). Re-feeding the same state logs nothing (a second poll is not a second showing). `source` is always
 * `rotation` here (R5).
 */
export function sponsorQueueLines(
  onAir: string | null,
  view: SponsorQueueView,
  at: string,
): { onAir: string | null; lines: string[] } {
  const lines: string[] = [];
  const m = view.current;
  const sponsor = m !== null && m.graphic === "sponsor" && m.sponsor !== undefined ? m.sponsor : null;
  // S6: the queue's id for a sponsor moment (`${seq}:${kind}`, kind `sponsor.<breakKind>`) IS S4's sponsorMomentId.
  const currentId = m !== null && sponsor !== null ? sponsorMomentId(m.seq, sponsor.breakKind) : null;
  let tracked = onAir;
  if (tracked !== null && tracked !== currentId) {
    const end: SponsorEndBody = { momentId: tracked, at, cutShort: view.cutShort.includes(tracked) };
    lines.push(sponsorLine("end", end));
    tracked = null;
  }
  if (tracked === null && currentId !== null && sponsor !== null && view.phase === "hold") {
    const start: SponsorStartBody = {
      momentId: currentId,
      cardId: sponsor.cardId,
      style: sponsor.style,
      source: "rotation",
      breakKind: sponsor.breakKind,
      at,
    };
    lines.push(sponsorLine("start", start));
    tracked = currentId;
  }
  return { onAir: tracked, lines };
}
