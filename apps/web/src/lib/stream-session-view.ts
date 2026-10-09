// lib/stream-session-view.ts — the Phone tab's PURE view model (§9a "pure
// projections, strings via msg"). No fetching, no React: a function of the
// organiser projection + msg. Client-safe; the only @/server import is a TYPE,
// and lib/stream-destinations.ts has zero imports by design.
//
// The copy maps are TABLES (§9a "registry over branching"), each proven total
// by stream-session-view.test.ts against its source of truth:
//   FAIL_REASON_KEYS  — a session that EXISTS and failed. Total over the
//                       StreamFailReason enum: §6.4's three, the five
//                       Fly-lifecycle ones and the two timed exits
//                       (provision_timeout, admission_timeout). The test derives
//                       the count from StreamFailReason.options, so a reason
//                       added to the enum without copy reds.
//   CREATE_ERROR_KEYS — a create that was REFUSED (no row). Every refusal the
//                       organiser can act on (lane D amendment D1): 402
//                       no_credits, 409 overlay_required / active_session /
//                       target_in_use, 503 storage_exhausted /
//                       ingest_unavailable, 422 destination_not_allowed (a
//                       saved target the allowlist no longer admits), 402 plan
//                       refusals → plan_lacks_relay, and everything else →
//                       unknown. E5: storage lives ONLY here; no_credits lives
//                       in BOTH (a balance can pass create and be gone at live),
//                       and that asymmetry is the design, not an oversight.
import { fmtNumber } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import type {
  StreamEndReason, StreamFailReason, StreamLostCountdown, StreamPhone, StreamSessionCurrent,
} from "@/server/api-v1/schemas";

/** Prompt watch 4 closed: `live-score.tsx` exports no POLL_MS after W1's lift;
 *  the desk's LIVE_POLL_MS (20 s) is too slow for an organiser holding a
 *  phone at a QR code. One constant, here. */
export const STREAM_POLL_MS = 5_000;
export const BEAT_STALE_SECONDS = 45;

export type StreamSessionView = StreamSessionCurrent;

/** D3 (owner 2026-09-30): how long a live stream's destination may be not-receiving before the panel warns. The stream
 *  keeps running — a warning, never an ending; only `rejected` fails the session, and the server decides that. */
export const OUTPUT_WARNING_AFTER_MS = 30_000;

/** How long the destination has been in its current receiving / not-receiving period, as the SERVER measured it at the
 *  response (M6, B2 review): the browser's clock is never consulted, so a browser running ahead of the server cannot
 *  warn early and one running behind cannot warn late. At most one poll (STREAM_POLL_MS) stale, by construction. Null
 *  when there is no output to judge. */
export function outputElapsedMs(view: Pick<StreamSessionCurrent, "output">): number | null {
  return view.output ? view.output.elapsedMs : null;
}

/** D3: live, the destination not `ok`, for at least OUTPUT_WARNING_AFTER_MS of server-measured time. The HOLD — whether
 *  a D3 box shows at all; `d3Warning` says which. */
export function destinationWarning(view: Pick<StreamSessionCurrent, "state" | "output">): boolean {
  if (view.state !== "live" || !view.output || view.output.state === "ok") return false;
  return (outputElapsedMs(view) ?? 0) >= OUTPUT_WARNING_AFTER_MS;
}

/** The Signal path's "No signal" (§3.2): live, and the phone's ingest read is anything but `connected`. A NULL ingest (a
 *  failed provider read, N1) is not no-signal — nothing is decided on an unknown, the poll's own rule. One predicate for
 *  the chain's phone node and the D3 box, so the two cannot disagree. */
export function phoneNoSignal(view: Pick<StreamSessionCurrent, "state" | "ingest">): boolean {
  return view.state === "live" && view.ingest !== null && view.ingest.state !== "connected";
}

export type D3Box = "phone" | "destination";

/** I-1 (owner 2026-10-01, option a): WHICH box the D3 hold shows. Phone first — with no signal from the phone the
 *  destination cannot receive whatever its key, so the box points at the phone; only with the phone sending does it
 *  point at the stream key. Null when the hold has not been reached, and for no session at all. */
export function d3Warning(view: Pick<StreamSessionCurrent, "state" | "ingest" | "output"> | null): D3Box | null {
  if (!view || !destinationWarning(view)) return null;
  if (phoneNoSignal(view)) return "phone";
  return "destination";
}
export type PhoneTabState = "idle" | "provisioning" | "warming" | "live" | "ending" | "ended" | "failed";

export function phoneTabState(view: StreamSessionView | null): PhoneTabState {
  if (!view) return "idle";
  switch (view.state) {
    case "requested":
    case "provisioning": return "provisioning";
    case "warming": return "warming";
    case "live": return "live";
    case "ending": return "ending";
    case "completed": return "ended";
    case "failed": return "failed";
  }
}

export const STATE_PILL_KEYS: Record<PhoneTabState, MessageKey> = {
  idle: "stream.phone.state.idle",
  provisioning: "stream.phone.state.provisioning",
  warming: "stream.phone.state.warming",
  live: "stream.phone.state.live",
  ending: "stream.phone.state.ending",
  ended: "stream.phone.state.ended",
  failed: "stream.phone.state.failed",
};

export const FAIL_REASON_KEYS: Record<StreamFailReason, MessageKey> = {
  no_inbound_timeout: "stream.fail.no_inbound_timeout",
  target_rejected: "stream.fail.target_rejected",
  no_credits: "stream.fail.no_credits",
  // the timed exits every non-terminal state now owns (F18/F19/F23). Both are
  // organiser-visible: `provision_timeout` is a create that never came back, and
  // `admission_timeout` is a row that was inserted and never admitted (a crash
  // between the two halves of the admission transaction). Neither falls under
  // E5's "a key no code path can select" — both are producible.
  provision_timeout: "stream.fail.provision_timeout",
  admission_timeout: "stream.fail.admission_timeout",
  // the Fly machine lifecycle's reasons (plan §"Fly machine lifecycle")
  machine_create_failed: "stream.fail.machine_create_failed",
  machine_boot_timeout: "stream.fail.machine_boot_timeout",
  machine_exit_nonzero: "stream.fail.machine_exit_nonzero",
  machine_oom: "stream.fail.machine_oom",
  machine_crash: "stream.fail.machine_crash",
  // M10 (Task 14b review): the deployment has no relay, so a session left up from before was ended.
  relay_disabled: "stream.fail.relay_disabled",
};

/** How a COMPLETED session ended — shown as a chip in the ended state. */
export const END_REASON_KEYS: Record<StreamEndReason, MessageKey> = {
  stopped: "stream.phone.ended.reason.stopped",
  // Capture QR v2 (T6, spec §6.8.4 copy table): the three stops the phone and the automatic mode make.
  operator_stopped: "stream.phone.ended.reason.operator_stopped",
  auto_stopped: "stream.phone.ended.reason.auto_stopped",
  phone_lost: "stream.phone.ended.reason.phone_lost",
  max_duration: "stream.phone.ended.reason.max_duration",
};

/** Every create refusal the Phone tab tells apart (D1). `unknown` is the one a retry might fix. */
export const CREATE_ERROR_CODES = [
  "no_credits", "overlay_required", "active_session", "phone_not_paired", "phone_not_responding", "storage_exhausted", "ingest_unavailable",
  "target_in_use", "destination_not_allowed", "target_unreadable", "plan_lacks_relay", "unknown",
] as const;
export type CreateErrorCode = (typeof CREATE_ERROR_CODES)[number];

export const CREATE_ERROR_KEYS: Record<CreateErrorCode, MessageKey> = {
  no_credits: "stream.error.no_credits",
  overlay_required: "stream.error.overlay_required",
  active_session: "stream.error.active_session",
  // Capture QR v2 W5: no phone paired on the stream code (an expired code answers it too, B7 m-b).
  phone_not_paired: "stream.error.phone_not_paired",
  // Owner ruling 2026-10-09 (Option 1): a phone IS paired but has stopped answering (§6.9 silent) — wake it, don't rescan.
  phone_not_responding: "stream.error.phone_not_responding",
  storage_exhausted: "stream.error.storage_exhausted",
  ingest_unavailable: "stream.error.ingest_unavailable",
  // T3: the ONE holder-less "elsewhere" sentence; a holder with a match is named by `inUseText` (stream.inUse.*).
  target_in_use: "stream.error.target_in_use.unknown",
  destination_not_allowed: "stream.error.destination_not_allowed",
  target_unreadable: "stream.error.target_unreadable",
  plan_lacks_relay: "stream.error.plan_lacks_relay",
  unknown: "stream.error.unknown",
};

/** `target_in_use` without a match to name (the index race's `{ holder: null }`, or a holder whose fixture was deleted). */
const TARGET_IN_USE_ELSEWHERE_KEY: MessageKey = "stream.error.target_in_use.unknown";

/** The lower-case domain codes createSession puts on the wire VERBATIM (stream-sessions.ts `refuse`, `targetInUse`). */
const VERBATIM_CODES: readonly CreateErrorCode[] = [
  "no_credits", "overlay_required", "active_session", "phone_not_paired", "phone_not_responding", "storage_exhausted", "ingest_unavailable",
  "target_in_use",
];

/** The plan gates createSession refuses with `PaymentRequiredError(featureKey)` — read from the ONE authority the
 *  server's `refuse` throws from (lib/stream-plan-gates.ts, Task 13 review m5). Both mean "your plan, not your
 *  credits" — the Phone tab shows the UpgradeGate for either. The v1 envelope carries the key as
 *  `extra.feature_key`; its `extra.reason` is featureReason()'s human SENTENCE, never a machine code. */
const PLAN_GATE_FEATURES: readonly string[] = Object.values(RELAY_PLAN_GATES);

/** The `code` / `extra` split of an `ApiV1Error` (lib/client-v1.ts), read structurally — `null` for anything that never
 *  reached the server (a network TypeError, an abort, a non-object). Structural rather than `instanceof` so a test
 *  harness that mocks `@/lib/client-v1` with its own class cannot turn every refusal into `unknown`. */
function wireError(err: unknown): { code: string; extra: Record<string, unknown> } | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, extra } = err as { code?: unknown; extra?: unknown };
  if (typeof code !== "string") return null;
  return { code, extra: typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : {} };
}

export function createErrorCode(err: unknown): CreateErrorCode {
  const w = wireError(err);
  if (!w) return "unknown";
  if (VERBATIM_CODES.includes(w.code as CreateErrorCode)) return w.code as CreateErrorCode;
  if (w.code === DESTINATION_NOT_ALLOWED) return "destination_not_allowed";
  if (w.code === TARGET_UNREADABLE) return "target_unreadable";
  if (w.code === "PAYMENT_REQUIRED" && PLAN_GATE_FEATURES.includes(w.extra.feature_key as string)) return "plan_lacks_relay";
  return "unknown";
}

/** I1 (B4 review): a Go live answered 404 whose chosen destination a re-read of the list no longer holds — removed in
 *  Directory while this tab stayed open. Never a wire code: D2 keeps the archived target on the EXISTING not-found shape
 *  (a code-less 404, as a gone fixture is), so the Phone tab decides it after that re-read, not `createErrorCode`. */
export const TARGET_REMOVED = "target_removed" as const;
/** Every create refusal the Phone tab can show: the wire's (`CreateErrorCode`) plus the one it decides itself. */
export type CreateFailureCode = CreateErrorCode | typeof TARGET_REMOVED;

/** A create answered 404, read structurally off the `ApiV1Error` (`status`) — `false` for anything else, including an
 *  error that never reached the server. */
export function createErrorIsNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

export type CreateErrorHolder = {
  courtName: string | null; label: string; matchNo: number | null; href: string | null; state: "live" | "waiting";
};

/** Who holds the destination on a `target_in_use` (`extra.holder`, stream-sessions.ts `targetInUse`); `null` on the
 *  index-race variant `{ holder: null }`, on any other refusal, and on a holder without a label. A holder with no
 *  `state` (a pre-T3 server) reads "live": that server refused only for a destination already on air. */
export function createErrorHolder(err: unknown): CreateErrorHolder | null {
  const w = wireError(err);
  if (!w || w.code !== "target_in_use") return null;
  const h = w.extra.holder as { courtName?: unknown; label?: unknown; matchNo?: unknown; href?: unknown; state?: unknown } | null | undefined;
  if (typeof h !== "object" || h === null || typeof h.label !== "string") return null;
  return {
    courtName: typeof h.courtName === "string" ? h.courtName : null,
    label: h.label,
    matchNo: typeof h.matchNo === "number" ? h.matchNo : null,
    href: typeof h.href === "string" ? h.href : null,
    state: h.state === "waiting" ? "waiting" : "live",
  };
}

type Msg = (k: MessageKey, vars?: Record<string, string | number>) => string;

/** Spec §3.3 — "{label} is {live|waiting for a phone} on Match {n} · {court}. Stop it there or pick another
 *  destination." The match is the locale's own `breadcrumb.match`, never a server string (plan premise 10). No match
 *  number (the holder's fixture was deleted) reads the one "elsewhere" sentence, never "Match null". */
export function inUseText(msg: Msg, h: CreateErrorHolder): string {
  if (h.matchNo === null) return msg(TARGET_IN_USE_ELSEWHERE_KEY);
  const matchOnly = msg("breadcrumb.match", { no: h.matchNo });
  const match = h.courtName ? msg("stream.inUse.matchCourt", { match: matchOnly, court: h.courtName }) : matchOnly;
  return msg(h.state === "live" ? "stream.inUse.live" : "stream.inUse.waiting", { label: h.label, match });
}

/** The refusal's sentence. `target_in_use` names the destination, the match and its court (`inUseText`); without a
 *  holder it says "another match" rather than render a hole. */
export function createErrorText(error: { code: CreateFailureCode; holder: CreateErrorHolder | null }, msg: Msg): string {
  if (error.code === "target_in_use") return error.holder ? inUseText(msg, error.holder) : msg(TARGET_IN_USE_ELSEWHERE_KEY);
  if (error.code === TARGET_REMOVED) return msg("stream.error.target_removed");
  return msg(CREATE_ERROR_KEYS[error.code]);
}

export const INGEST_STATE_KEYS: Record<"connected" | "disconnected" | "unknown", MessageKey> = {
  connected: "stream.health.ingest.connected",
  disconnected: "stream.health.ingest.disconnected",
  unknown: "stream.health.ingest.unknown",
};

/** C6: the first chip is the INGEST STATE as the port reported it — passthrough only: the server reads the ingest for
 *  passthrough alone (stream-sessions.ts `currentSession`), so a composed session's `ingest` is always null and an
 *  "unknown" chip there would be a permanent false alarm. fps / Mbps / beat chips exist only once a heartbeat has
 *  arrived. The beat age is clamped at 0: `lastBeatAt` is the server's clock and `now` the browser's.
 *
 *  m1 (Task 13 review): each heartbeat field is OPTIONAL on the relay's wire (`RelayHeartbeat`), so an absent one is
 *  stored NULL — and a NULL is not a zero. A missing fps / bitrate omits its chip rather than claim "0 fps"; a missing
 *  beat says so in its own words ("no beat yet") instead of "beat 0 s ago", and stays stale (amber). A real 0 is a
 *  reading and still shows. m2: the bitrate is formatted in the ACTIVE locale (a decimal comma in es/fr/nl). */
export function healthChips(view: StreamSessionView, msg: Msg, now: Date, locale: string): { text: string; stale: boolean }[] {
  const chips: { text: string; stale: boolean }[] = [];
  if (view.mode === "passthrough") chips.push({ text: msg(INGEST_STATE_KEYS[view.ingest?.state ?? "unknown"]), stale: false });
  if (view.health) {
    const { fps, bitrateKbps, lastBeatAt } = view.health;
    if (typeof fps === "number") chips.push({ text: msg("stream.health.fps", { n: fps }), stale: false });
    if (typeof bitrateKbps === "number") {
      const mbps = fmtNumber(locale, bitrateKbps / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      chips.push({ text: msg("stream.health.bitrate", { n: mbps }), stale: false });
    }
    if (lastBeatAt) {
      const beatAgo = Math.max(0, Math.floor((now.getTime() - new Date(lastBeatAt).getTime()) / 1000));
      chips.push({ text: msg("stream.health.beat", { s: beatAgo }), stale: beatAgo >= BEAT_STALE_SECONDS });
    } else {
      chips.push({ text: msg("stream.health.beat.none"), stale: true });
    }
  }
  return chips;
}

export function elapsedLabel(startedAt: string | null, now: Date): string {
  const total = startedAt ? Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Capture QR v2 §6.12 (T11) — the Ready states, signed off as Option B rev 2. Every function here is a reading of the
// server's two projections (`current` and the `stream-phone` read model); none consults a clock. The countdown above all
// is rendered AS GIVEN (carry: "never compute a countdown in the panel").
// ---------------------------------------------------------------------------------------------------------------------

/** §6.12's rows, as the panel's body switches on them. */
export const READY_STATES = ["no_phone", "paired", "silent", "waiting", "live", "ended", "code_ended"] as const;
export type ReadyState = (typeof READY_STATES)[number];

/** C5: "This match is over" needs the FIXTURE finished AND no live code — a reverted result clears `finished` while the
 *  expired code stays ended (and Ready may mint again); a code still FINISHING inside the grace is not over yet. */
export function matchOver(phone: StreamPhone | null): boolean {
  return phone !== null && phone.finished && (phone.code === null || phone.code.state === "ended");
}

/**
 * §6.12's row for the panel. A session in flight is its own row whatever the phone says (requested, provisioning and
 * warming wait; live and ending are live; completed and failed are the summary cards). With no session: the match over
 * (C5), else the phone — none, present (paired) or not answering (silent, §6.9). The EMPTY case — nothing read yet —
 * is no_phone, which never offers Go live.
 */
export function readyStateOf(phone: StreamPhone | null, session: StreamSessionCurrent | null): ReadyState {
  if (session) {
    switch (session.state) {
      case "requested":
      case "provisioning":
      case "warming": return "waiting";
      case "live":
      case "ending": return "live";
      case "completed":
      case "failed": return "ended";
    }
  }
  if (matchOver(phone)) return "code_ended";
  if (!phone?.phone) return "no_phone";
  return phone.phone.present ? "paired" : "silent";
}

/** §6.12: Go live is enabled ONLY with a phone paired and answering — W5's own gate on the server (`phone_not_paired`, or
 *  `phone_not_responding` for a paired phone gone silent since the panel's last read, owner ruling 2026-10-09). */
export const canGoLive = (state: ReadyState): boolean => state === "paired";

/** W5's two answers (§6.7.1; owner ruling 2026-10-09, Option 1): no phone on the code, or a paired phone gone silent. */
export const W5_REFUSAL_CODES = ["phone_not_paired", "phone_not_responding"] as const satisfies readonly CreateErrorCode[];
export const isW5Refusal = (code: string): boolean => (W5_REFUSAL_CODES as readonly string[]).includes(code);

/**
 * Owner ruling 2026-10-09 ("A"): a Go live refused for want of a phone (either W5 answer) is retired by the first
 * PRESENT answer to a phone read sent after the refusal — the phone the sentence asked for has arrived. Every other
 * refusal keeps its own rules. The watch is the newest read already sent when the last W5 refusal landed
 * (`refusedAtRead`, the panel's read sequence number):
 *  - a W5 refusal is itself news that there was no phone to stream from, whatever the panel last read, so a present
 *    answer read before the click never retires it;
 *  - only an answer to a read SENT after the refusal counts: one already in flight when the click was refused says
 *    nothing about that click.
 * A later present answer may say "clear" again; by then no W5 error is pending (the first one retired it, and a new W5
 * refusal moves the watch), and the panel only ever clears a W5 error.
 */
export type PresenceWatch = { refusedAtRead: number };
export const PRESENCE_WATCH_START: PresenceWatch = { refusedAtRead: 0 };
export function presenceAfterRefusal(watch: PresenceWatch, code: string, newestRead: number): PresenceWatch {
  return isW5Refusal(code) ? { refusedAtRead: newestRead } : watch;
}
/** Whether this landed phone read retires a pending W5 error: it reads present, and it was sent after the refusal. */
export function readClearsW5(watch: PresenceWatch, read: { seq: number; present: boolean }): boolean {
  return read.present && read.seq > watch.refusedAtRead;
}

/** O5 (§6.12, ruled 2026-10-01): why a live phone that still beats sends no video. */
export type ReconnectReason = "camera" | "sound" | "network" | "held" | "weak";
export const RECONNECT_REASON_KEYS: Record<ReconnectReason, MessageKey> = {
  camera: "stream.phone.paused.camera",
  sound: "stream.phone.paused.sound",
  network: "stream.phone.paused.network",
  held: "stream.phone.paused.held",
  weak: "stream.phone.paused.weak",
};

/** §6.12's O5 mapping: the latest beat's `notReady` (camera, sound, network, held) outranks its state; otherwise
 *  `degraded` or `reconnecting` is a weak connection; anything else (publishing included) carries no reason. */
export function reconnectReasonOf(phone: StreamPhone["phone"]): ReconnectReason | null {
  if (!phone) return null;
  if (phone.notReady) return phone.notReady;
  if (phone.state === "degraded" || phone.state === "reconnecting") return "weak";
  return null;
}

/** Each (kind, reason) pair the wire's union declares — distributed per member, never the cross product. */
type CountdownCombo = StreamLostCountdown extends infer C
  ? C extends { kind: infer K extends string; reason: infer R extends string }
    ? `${K}.${R}`
    : never
  : never;

/** W24: one sentence per end the countdown can name — keyed by the wire's own (kind, reason). */
export const COUNTDOWN_KEYS = {
  "warming.no_inbound_timeout": "stream.phone.countdown.warming.no_inbound_timeout",
  "warming.phone_lost": "stream.phone.countdown.warming.phone_lost",
  "live.phone_lost": "stream.phone.countdown.live.phone_lost",
} as const satisfies Record<CountdownCombo, MessageKey>;

export function countdownKey(c: StreamLostCountdown): MessageKey {
  return COUNTDOWN_KEYS[`${c.kind}.${c.reason}` as keyof typeof COUNTDOWN_KEYS];
}

/**
 * A server-measured duration in the viewer's locale, short: "9 min, 15 sec" (en), "9 min y 15 s" (es). Whole seconds,
 * floored; zero units dropped; zero itself is "0 sec". Built from `Intl.NumberFormat` units joined by `Intl.ListFormat`
 * (type "unit") — what `Intl.DurationFormat` prints, without needing it: lib/format.ts's `fmtDuration` keeps to the same
 * universally supported pair, and rounds to whole minutes, which a countdown cannot.
 */
export function durationLabel(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const unit = (value: number, u: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(value);
  const parts: string[] = [];
  if (h > 0) parts.push(unit(h, "hour"));
  if (m > 0) parts.push(unit(m, "minute"));
  if (sec > 0 || parts.length === 0) parts.push(unit(sec, "second"));
  return new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(parts);
}

/** The strip under the chain (Option B rev 2): its tone and icon, an optional bold lead, and a sentence. A countdown
 *  body carries the server's two durations, verbatim, for the panel to format.
 *  PR-2 (§7.4, Option A — owner-approved 2026-10-07): the lead may carry ONE value (`leadVars`: whole seconds, a percent, or
 *  a reason's own key), the strip may carry the phone's info LINE (`line`: the health line, or the phone's model and mode),
 *  and an auto-start refusal its REMEDY. Each is absent, never null, when it has nothing to say. */
export type PhoneStrip = {
  tone: "slate" | "amber";
  icon: "phone" | "alert" | "clock" | "pause";
  lead: MessageKey | null;
  leadVars?: { s: number } | { n: number } | { reason: MessageKey };
  body: { key: MessageKey; elapsedMs?: number; remainingMs?: number } | null;
  line?: PhoneLinePart[];
  remedy?: AutoRefusalRemedy;
};

// ---------------------------------------------------------------------------------------------------------------------
// PR-2 (spec §7.1, §7.4, §7.5) — Option A. Every verdict below is the SERVER's: the amber reason is `phone.health`
// (domain/phone-health.ts, W9's priority), "Phone not ready" is `notReadyShown` (the R-2 debounce, beat-confirmed), the
// refusal is `auto.refusal` (served only while the automatic start could still fire), the takeover's age is
// `lastTakeover.elapsedMs`. Nothing here compares a reading with a threshold or a server stamp with the browser's clock.
// ---------------------------------------------------------------------------------------------------------------------

type PhoneFacts = NonNullable<StreamPhone["phone"]>;
type HealthReason = NonNullable<PhoneFacts["health"]>;
type NotReadyReason = NonNullable<PhoneFacts["notReady"]>;
type AutoRefusal = NonNullable<NonNullable<StreamPhone["auto"]>["refusal"]>;
export type AutoRefusalRemedy = "buy" | "manage";

/** One part of the strip's info line, joined " · " by the panel. A null reading has NO part (FP14): never "0 Mbps", never
 *  "null". `model` is the phone's own name for itself, verbatim; the rest are the panel's words in the viewer's locale. */
export type PhoneLinePart =
  | { kind: "phone" }
  | { kind: "model"; text: string }
  | { kind: "mode"; mode: NonNullable<PhoneFacts["mode"]> }
  | { kind: "battery"; percent: number; charging: boolean }
  | { kind: "bitrate"; kbps: number }
  | { kind: "heard"; elapsedMs: number }
  | { kind: "waiting" };

/** §7.4's amber sentences, keyed by the domain's own reasons (`Record` keeps it total: a new reason is a tsc error). */
export const HEALTH_KEYS: Record<HealthReason, MessageKey> = {
  not_responding: "stream.phone.health.not_responding",
  stalled: "stream.phone.health.stalled",
  hot: "stream.phone.health.hot",
  battery_low: "stream.phone.health.battery_low",
};

/** §7.4's "Phone not ready: {reason}" words — held reads "turn the phone sideways". */
export const NOT_READY_KEYS: Record<NotReadyReason, MessageKey> = {
  camera: "stream.phone.notReady.reason.camera",
  sound: "stream.phone.notReady.reason.sound",
  network: "stream.phone.notReady.reason.network",
  held: "stream.phone.notReady.reason.held",
};

/** §7.4: "Automatic start couldn't begin: {reason}" — the reason is the MANUAL refusal's own sentence wherever the panel
 *  has one, so a refusal reads the same whichever start met it. */
// B7 review M-6: the reasons are their OWN keys — they follow "…couldn't begin:" in a sentence, so es/fr/nl open them in
// lower case, which the manual refusals (sentences of their own) must not. In English they read as the manual ones do.
export const AUTO_REFUSAL_KEYS: Record<AutoRefusal, MessageKey> = {
  no_credit: "stream.auto.refusal.no_credit",
  no_destination: "stream.auto.refusal.no_destination",
  not_entitled: "stream.auto.refusal.not_entitled",
  destination_in_use: "stream.auto.refusal.destination_in_use",
  unavailable: "stream.auto.refusal.unavailable",
};

/** §7.4: "the same remedies as the manual refusals (Buy credits, Manage destinations)" — the two that have one. */
export const AUTO_REFUSAL_REMEDY: Record<AutoRefusal, AutoRefusalRemedy | undefined> = {
  no_credit: "buy",
  no_destination: "manage",
  not_entitled: undefined,
  destination_in_use: undefined,
  unavailable: undefined,
};

/** §7.4: "Phone · 78% charging · 2.4 Mbps · heard 4 s ago" — the read model's readings and the server's `elapsedMs`. */
export function healthLine(f: PhoneFacts): PhoneLinePart[] {
  const parts: PhoneLinePart[] = [{ kind: "phone" }];
  const { battery, bitrateKbps } = f.beat;
  if (battery !== null) parts.push({ kind: "battery", percent: battery.percent, charging: battery.charging });
  if (bitrateKbps !== null) parts.push({ kind: "bitrate", kbps: bitrateKbps });
  parts.push({ kind: "heard", elapsedMs: f.elapsedMs });
  return parts;
}

const modelPart = (f: PhoneFacts): PhoneLinePart[] => (f.model !== null ? [{ kind: "model", text: f.model }] : []);
const modePart = (f: PhoneFacts): PhoneLinePart[] => (f.mode !== null ? [{ kind: "mode", mode: f.mode }] : []);

/** §7.4 + §7.5 at Ready (Option A state 1): "Pixel 8 · Operator". */
const identityLine = (f: PhoneFacts): PhoneLinePart[] => [...modelPart(f), ...modePart(f)];

/** Option A states 3a–3e: "Automatic · Pixel 8 · Waiting for the phone's video". */
const waitingLine = (f: PhoneFacts): PhoneLinePart[] => [...modePart(f), ...modelPart(f), { kind: "waiting" }];

/** The automatic start's refusal as a strip — null with no read model, no settings row, or no refusal served. The server
 *  serves a refusal only while the automatic start could still fire, so its presence alone is the verdict. */
export function autoRefusalStrip(phone: StreamPhone | null): PhoneStrip | null {
  const refusal = phone?.auto?.refusal ?? null;
  if (refusal === null) return null;
  const remedy = AUTO_REFUSAL_REMEDY[refusal];
  return {
    tone: "amber", icon: "alert", lead: "stream.auto.refused", leadVars: { reason: AUTO_REFUSAL_KEYS[refusal] }, body: null,
    ...(remedy ? { remedy } : {}),
  };
}

/** Why a WAITING phone has not sent video, when the server confirmed one: the phone's own start failed (`startFailed`),
 *  else a not-ready reason held past the R-2 debounce (`notReadyShown` — never the raw, flapping `notReady`). */
function waitingWhy(f: PhoneFacts): Pick<PhoneStrip, "lead" | "leadVars"> | null {
  if (f.startFailed !== null) return { lead: "stream.phone.startFailed" };
  if (f.notReadyShown && f.notReady !== null) return { lead: "stream.phone.notReady.line", leadVars: { reason: NOT_READY_KEYS[f.notReady] } };
  return null;
}

/** §7.4 live: the server's amber reason over the health line, or the line alone. A not-responding phone's readings are
 *  stale, so its sentence (which names the silence) stands alone. A battery_low verdict always has its reading (the
 *  domain requires one); were it ever missing, the sentence that names no number is shown — never "(0%)". */
function liveHealthStrip(f: PhoneFacts): PhoneStrip {
  const reason = f.health;
  if (reason === null) return { tone: "slate", icon: "phone", lead: null, body: null, line: healthLine(f) };
  if (reason === "not_responding") {
    return { tone: "amber", icon: "alert", lead: HEALTH_KEYS[reason], leadVars: { s: Math.floor(f.elapsedMs / 1000) }, body: null };
  }
  if (reason === "battery_low") {
    const battery = f.beat.battery;
    return battery === null
      ? { tone: "amber", icon: "alert", lead: "stream.phone.health.batteryLowBare", body: null, line: healthLine(f) }
      : { tone: "amber", icon: "alert", lead: HEALTH_KEYS[reason], leadVars: { n: battery.percent }, body: null, line: healthLine(f) };
  }
  return { tone: "amber", icon: "alert", lead: HEALTH_KEYS[reason], body: null, line: healthLine(f) };
}

/** §7.5: "for 30 min after a takeover" — judged on the server's `lastTakeover.elapsedMs` (T12), never the browser's clock. */
export const TAKEOVER_NOTICE_MS = 30 * 60_000;

/** Which of the panel's own buttons the takeover notice tells the organiser to press BEFORE Revoke & reissue: Stop while
 *  live, Cancel while the session waits (the button those states show — owner ruling 2026-10-08, B7 review M-2), and
 *  neither with no session (Revoke alone). */
export type TakeoverAct = "stop" | "cancel" | null;
const TAKEOVER_ACT: Record<PhoneTabState, TakeoverAct> = {
  idle: null, provisioning: "cancel", warming: "cancel", live: "stop", ending: null, ended: null, failed: null,
};

/** §7.5's notice: shown while the latest takeover is younger than 30 min on the server's clock and the viewer has not
 *  dismissed THIS takeover (its instant); `act` names the button to press first (`TAKEOVER_ACT`). */
export function takeoverNotice(
  phone: StreamPhone | null, state: PhoneTabState, dismissedAt: string | null,
): { at: string; model: string | null; act: TakeoverAct } | null {
  const t = phone?.lastTakeover ?? null;
  if (t === null || t.elapsedMs >= TAKEOVER_NOTICE_MS || t.at === dismissedAt) return null;
  return { at: t.at, model: t.model, act: TAKEOVER_ACT[state] };
}

/** The notice's sentence key: with or without the model, naming `act`'s button. */
export function takeoverLineKey(act: TakeoverAct, withModel: boolean): MessageKey {
  if (act === "stop") return withModel ? "stream.takeover.lineLive" : "stream.takeover.lineLiveNoModel";
  if (act === "cancel") return withModel ? "stream.takeover.lineWaiting" : "stream.takeover.lineWaitingNoModel";
  return withModel ? "stream.takeover.line" : "stream.takeover.lineNoModel";
}

/** §7.1: Live's read-only "Automatic: stops about N minutes after the result" — only while live, and only when the SERVER
 *  says §7.3 will stop this session (`auto.stopApplies`, B7 review M-3: the switch on, the session's phone automatic — A4
 *  — and the session created before any result, A15). The tick's own facts and predicate, never re-derived here. */
export function autoStopLine(phone: StreamPhone | null, state: PhoneTabState): boolean {
  return state === "live" && phone?.auto?.stopApplies === true;
}

/** Owner-approved 2026-10-08: under the switch, while it is ON and the paired phone (the beat's `mode`) is in Operator —
 *  the phone will not start on its own, so the organiser is told where to change it. Hidden with no phone, a phone in
 *  Automatic (or with no mode reported yet), or the switch off. `autoOn` is the switch as the panel shows it. */
export function autoOperatorHint(phone: StreamPhone | null, autoOn: boolean): boolean {
  return autoOn && phone?.phone?.mode === "operator";
}

/** Why automatic start will not run again in this match (`auto.wontStart`, the server's latch — final review I-1). */
export type AutoWontStartReason = NonNullable<NonNullable<StreamPhone["auto"]>["wontStart"]>;
/** Each latch's line. A Record over the served enum, so a latch the server adds without copy here fails tsc. */
export const AUTO_WONT_START_KEY: Record<AutoWontStartReason, MessageKey> = {
  stopped: "stream.auto.wontStart.stopped",
  already_streamed: "stream.auto.wontStart.already_streamed",
  already_started: "stream.auto.wontStart.already_started",
};
/** The note under the switch (final review I-1, owner 2026-10-08, option A): ONE line, only while the switch is ON. A latch
 *  the server names (`auto.wontStart`) outranks the Operator hint — the switch will not start this match at all, and the
 *  phone's mode would not change that. Else the Operator hint (`autoOperatorHint`), else nothing. */
export type AutoSwitchNote = { kind: "wontStart"; reason: AutoWontStartReason } | { kind: "operator" } | null;
export function autoSwitchNote(phone: StreamPhone | null, autoOn: boolean): AutoSwitchNote {
  if (!autoOn) return null;
  const reason = phone?.auto?.wontStart ?? null;
  if (reason !== null) return { kind: "wontStart", reason };
  return autoOperatorHint(phone, autoOn) ? { kind: "operator" } : null;
}

/** §7.4 "behind a tap" (FP22, owner ruling Q-D): the Details disclosure's phone data — data used and the app version, each
 *  omitted when null. The disclosure itself exists only in Live/Ending, so neither shows while merely paired. */
export function phoneDetails(phone: StreamPhone | null): ({ kind: "dataUsed"; mb: number } | { kind: "appVersion"; version: string })[] {
  const f = phone?.phone ?? null;
  if (f === null) return [];
  const out: ({ kind: "dataUsed"; mb: number } | { kind: "appVersion"; version: string })[] = [];
  if (f.beat.dataUsedMB !== null) out.push({ kind: "dataUsed", mb: f.beat.dataUsedMB });
  if (f.appVersion !== null) out.push({ kind: "appVersion", version: f.appVersion });
  return out;
}

/**
 * Which message the strip shows, from the two projections. None for a LEGACY session (C-1: today's panel), for a paired
 * phone, for the summary cards and for a match that is over (its own line, not the phone's).
 *  - no phone → "Pair a phone first…" (slate); silent → "The phone stopped checking in…" (amber);
 *  - waiting → "Waiting for the phone's video", and once the server sends the warming countdown, its sentence (amber);
 *  - live → the countdown when the server sends one; otherwise, while the input is not connected, the phone's O5 reason
 *    (the phone still beats, so W19 cannot fire and there is no countdown — O5); otherwise nothing.
 * `session.countdown` is the ONLY source of a countdown: an input that is down is not one (mutant: render it whenever
 * the input is down → the O5 case reds).
 */
export function phoneStrip(phone: StreamPhone | null, session: StreamSessionCurrent | null): PhoneStrip | null {
  if (phone?.legacy) return null;
  const state = readyStateOf(phone, session);
  const facts = phone?.phone ?? null;
  const timed = (c: StreamLostCountdown) => ({ key: countdownKey(c), elapsedMs: c.elapsedMs, remainingMs: c.remainingMs });
  switch (state) {
    case "no_phone": return { tone: "slate", icon: "phone", lead: null, body: { key: "stream.phone.pairFirst" } };
    case "silent": return { tone: "amber", icon: "alert", lead: null, body: { key: "stream.phone.silent" } };
    case "waiting": {
      const countdown = session?.countdown ?? null;
      // PR-2 §7.4 (Option A 3a–3e): the server-confirmed reason leads; a countdown about a LOST phone keeps its own strip
      // (the phone's last word is stale), any other countdown is the sentence under the lead, else the phone's line.
      const why = facts && countdown?.reason !== "phone_lost" ? waitingWhy(facts) : null;
      if (why && facts) {
        return countdown
          ? { tone: "amber", icon: "alert", ...why, body: timed(countdown) }
          : { tone: "amber", icon: "alert", ...why, body: null, line: waitingLine(facts) };
      }
      return countdown
        ? { tone: "amber", icon: "clock", lead: "stream.phone.waitingVideo", body: timed(countdown) }
        : { tone: "slate", icon: "clock", lead: "stream.phone.waitingVideo", body: null };
    }
    case "live": {
      if (session?.countdown) return { tone: "amber", icon: "clock", lead: null, body: timed(session.countdown) };
      if (session && phoneNoSignal(session)) {
        const reason = reconnectReasonOf(facts);
        return reason ? { tone: "amber", icon: "pause", lead: null, body: { key: RECONNECT_REASON_KEYS[reason] } } : null;
      }
      // PR-2 §7.4: the input is up (or unread) — the phone-health line, amber when the SERVER names a reason. Live only:
      // `ending` (also this row) is the last seconds flushing, with nothing to act on.
      return session?.state === "live" && facts ? liveHealthStrip(facts) : null;
    }
    case "paired": {
      // PR-2: an automatic start the server refused (and could still retry) takes the strip; else the phone's identity
      // (§7.5 model, §7.4 mode) — none when the phone named neither, as before.
      const refused = autoRefusalStrip(phone);
      if (refused) return refused;
      const line = facts ? identityLine(facts) : [];
      return line.length > 0 ? { tone: "slate", icon: "phone", lead: null, body: null, line } : null;
    }
    case "ended":
    case "code_ended": return null;
  }
}

/** W23: the restart line above Go live (and on the Ended card) — emerald below the limit, amber at it with the credit
 *  suffix. Null while no reuse window is open. The numbers are the server's allowance, never a count kept here. */
export function restartLine(
  restart: StreamSessionCurrent["restart"],
): { tone: "emerald" | "amber"; key: MessageKey; vars: { used: number; limit: number } } | null {
  if (!restart) return null;
  const vars = { used: restart.used, limit: restart.limit };
  return restart.free
    ? { tone: "emerald", key: "stream.restart.used", vars }
    : { tone: "amber", key: "stream.restart.usedCredit", vars };
}
