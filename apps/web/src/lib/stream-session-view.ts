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
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { fmtNumber } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import type { StreamEndReason, StreamFailReason, StreamSessionCurrent } from "@/server/api-v1/schemas";

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
  max_duration: "stream.phone.ended.reason.max_duration",
};

/** Every create refusal the Phone tab tells apart (D1). `unknown` is the one a retry might fix. */
export const CREATE_ERROR_CODES = [
  "no_credits", "overlay_required", "active_session", "storage_exhausted", "ingest_unavailable",
  "target_in_use", "destination_not_allowed", "target_unreadable", "plan_lacks_relay", "unknown",
] as const;
export type CreateErrorCode = (typeof CREATE_ERROR_CODES)[number];

export const CREATE_ERROR_KEYS: Record<CreateErrorCode, MessageKey> = {
  no_credits: "stream.error.no_credits",
  overlay_required: "stream.error.overlay_required",
  active_session: "stream.error.active_session",
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
  "no_credits", "overlay_required", "active_session", "storage_exhausted", "ingest_unavailable", "target_in_use",
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

/** The paste code IS the QR payload — one contract, two carriers. */
export function qrText(qr: CaptureQrV1): string {
  return JSON.stringify(qr);
}
