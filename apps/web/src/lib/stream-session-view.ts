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
//   DESTINATION_REFUSAL_KEYS — which allowlist rule refused an ingest URL
//                       (D2), total over the validator's own DESTINATION_REFUSALS.
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { fmtNumber } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { DESTINATION_NOT_ALLOWED, DESTINATION_REFUSALS, type DestinationRefusal } from "@/lib/stream-destinations";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import type { StreamEndReason, StreamFailReason, StreamSessionCurrent } from "@/server/api-v1/schemas";

/** Prompt watch 4 closed: `live-score.tsx` exports no POLL_MS after W1's lift;
 *  the desk's LIVE_POLL_MS (20 s) is too slow for an organiser holding a
 *  phone at a QR code. One constant, here. */
export const STREAM_POLL_MS = 5_000;
export const BEAT_STALE_SECONDS = 45;

export type StreamSessionView = StreamSessionCurrent;
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

export function stepFor(state: PhoneTabState): 1 | 2 | 3 | 4 {
  switch (state) {
    case "idle": return 1;
    case "provisioning":
    case "warming": return 2;
    case "live":
    case "ending": return 3;
    case "ended":
    case "failed": return 4;
  }
}

export const STEP_KEYS = ["stream.phone.step1", "stream.phone.step2", "stream.phone.step3", "stream.phone.step4"] as const satisfies readonly [MessageKey, MessageKey, MessageKey, MessageKey];

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
  "target_in_use", "destination_not_allowed", "plan_lacks_relay", "unknown",
] as const;
export type CreateErrorCode = (typeof CREATE_ERROR_CODES)[number];

export const CREATE_ERROR_KEYS: Record<CreateErrorCode, MessageKey> = {
  no_credits: "stream.error.no_credits",
  overlay_required: "stream.error.overlay_required",
  active_session: "stream.error.active_session",
  storage_exhausted: "stream.error.storage_exhausted",
  ingest_unavailable: "stream.error.ingest_unavailable",
  target_in_use: "stream.error.target_in_use",
  destination_not_allowed: "stream.error.destination_not_allowed",
  plan_lacks_relay: "stream.error.plan_lacks_relay",
  unknown: "stream.error.unknown",
};

/** `target_in_use` without a court to name (the index race's `{ holder: null }`, or a holder fixture with no court). */
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
  if (w.code === "PAYMENT_REQUIRED" && PLAN_GATE_FEATURES.includes(w.extra.feature_key as string)) return "plan_lacks_relay";
  return "unknown";
}

export type CreateErrorHolder = { courtName: string | null; label: string };

/** Who holds the destination on a `target_in_use` (`extra.holder`, stream-sessions.ts `targetInUse`); `null` on the
 *  index-race variant `{ holder: null }`, on any other refusal, and on a holder without a label. */
export function createErrorHolder(err: unknown): CreateErrorHolder | null {
  const w = wireError(err);
  if (!w || w.code !== "target_in_use") return null;
  const h = w.extra.holder as { courtName?: unknown; label?: unknown } | null | undefined;
  if (typeof h !== "object" || h === null || typeof h.label !== "string") return null;
  return { courtName: typeof h.courtName === "string" ? h.courtName : null, label: h.label };
}

type Msg = (k: MessageKey, vars?: Record<string, string | number>) => string;

/** The refusal's sentence. `target_in_use` names the destination and the court holding it; without a court it says
 *  "another match" rather than render a hole. */
export function createErrorText(error: { code: CreateErrorCode; holder: CreateErrorHolder | null }, msg: Msg): string {
  if (error.code === "target_in_use") {
    const h = error.holder;
    return h?.courtName ? msg(CREATE_ERROR_KEYS.target_in_use, { destination: h.label, court: h.courtName }) : msg(TARGET_IN_USE_ELSEWHERE_KEY);
  }
  return msg(CREATE_ERROR_KEYS[error.code]);
}

/** D2: which allowlist rule refused an ingest URL — the client-side check (`destinationRefusal`) and the server's 422
 *  `DESTINATION_NOT_ALLOWED { rule }` share this one map. */
export const DESTINATION_REFUSAL_KEYS: Record<DestinationRefusal, MessageKey> = {
  scheme: "stream.target.refused.scheme",
  userinfo: "stream.target.refused.userinfo",
  ip_literal: "stream.target.refused.ip_literal",
  host: "stream.target.refused.host",
  port: "stream.target.refused.port",
  path: "stream.target.refused.path",
};

/** The rule off a 422 `DESTINATION_NOT_ALLOWED`, validated against the validator's own list — `null` for an unknown
 *  rule, another code, or an error that never reached the server. */
export function targetRefusalRule(err: unknown): DestinationRefusal | null {
  const w = wireError(err);
  if (!w || w.code !== DESTINATION_NOT_ALLOWED) return null;
  const rule = w.extra.rule;
  return (DESTINATION_REFUSALS as readonly unknown[]).includes(rule) ? (rule as DestinationRefusal) : null;
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
