// apps/web/src/server/api-v1/capture-schemas.ts — the zod twins of docs/contracts/capture-*.json (spec §4, §6.3,
// §6.14). The JSON files are the cross-repo authority; capture-contract.test.ts pins parity both ways.
//
// Imports zod and nothing else: schemas.ts re-exports this file through a relative `.ts` specifier, and the
// standalone OpenAPI generator (scripts/openapi-gen.ts, bare `node --experimental-strip-types`) loads schemas.ts.
// scripts/gen-capture-contracts.ts generates the JSON from these twins; it is kept for the next v-bump.
import { z } from "zod";

export const CAPTURE_CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;
const Code = z.string().regex(CAPTURE_CODE_RE);
const EpochS = z.number().int().min(1);
const PollSeconds = z.number().int().min(5).max(300);
const Url = z.url();

export const CaptureEndReason = z.enum([
  "stopped", "auto_stopped", "no_inbound_timeout", "target_rejected", "max_duration", "phone_lost", "failed",
]);
export type CaptureEndReason = z.infer<typeof CaptureEndReason>;
export const CaptureStartedBy = z.enum(["organiser", "automatic", "operator"]);
export type CaptureStartedBy = z.infer<typeof CaptureStartedBy>;
export const CaptureCause = z.enum(["organiser", "automatic", "operator", "rejoin"]);
export type CaptureCause = z.infer<typeof CaptureCause>;
export const CapturePhoneState = z.enum([
  "paired", "arming", "armed", "connecting", "publishing", "degraded", "reconnecting", "ended",
]);
export type CapturePhoneState = z.infer<typeof CapturePhoneState>;
export const CaptureNotReady = z.enum(["camera", "sound", "network", "held"]);
export type CaptureNotReady = z.infer<typeof CaptureNotReady>;
export const CaptureStartFailed = z.enum(["not-found", "cred-host", "config", "start-error"]);
export type CaptureStartFailed = z.infer<typeof CaptureStartFailed>;

const WaitingFields = {
  code: Code,
  label: z.string().min(1).max(200),
  venueTimezone: z.string().min(1).max(64),
  scheduledStart: EpochS.optional(),
  pollSeconds: PollSeconds,
  autoAllowed: z.boolean(),
  destinationName: z.string().min(1).max(80).nullable(),
  overlayUrl: Url.nullable(),
  heartbeatUrl: Url,
  startUrl: Url,
};

export const CaptureWaiting = z.strictObject({ state: z.literal("waiting"), ...WaitingFields });
export type CaptureWaiting = z.infer<typeof CaptureWaiting>;

/** W21: SRT is offered on srt://live.cloudflare.com:778 as Cloudflare issues it; RTMPS on the environment's live.*.
 *  No host is pattern-checked here: capture enforces the host per environment (G0-i, agreed 2026-10-01:
 *  cred.srt on exactly live.cloudflare.com or the env's live.*; RTMPS and every other URL strict live.*). */
export const CaptureCred = z.strictObject({
  srt: z.strictObject({
    url: z.string().min(1), streamId: z.string().min(1), passphrase: z.string().min(1),
    latencyMs: z.number().int().min(1),
  }).nullable(),
  rtmps: z.strictObject({ url: z.string().min(1), streamKey: z.string().min(1) }),
});
export type CaptureCred = z.infer<typeof CaptureCred>;

const SessionFields = {
  sid: z.uuid(),
  preferred: z.enum(["srt", "rtmps"]),
  playbackUrl: Url,
  holdWindowSeconds: z.strictObject({ srt: z.number().int().min(1).max(999), rtmps: z.number().int().min(1).max(999) }),
  maxDurationMinutes: z.number().int().min(1),
  warmingDeadline: EpochS,
  scoreUpdates: z.enum(["realtime", "polled"]),
  ...WaitingFields,
};

/** §6.3.1, per state (R5, A21): `cred` only in warming, live and ending (and only to the current phone, else
 *  absent); `endReason` present in ending, completed and failed, absent otherwise. A field from another state is
 *  refused, never ignored. */
const Warming = z.strictObject({ state: z.literal("warming"), ...SessionFields, cred: CaptureCred.optional() });
const Live = z.strictObject({ state: z.literal("live"), ...SessionFields, cred: CaptureCred.optional() });
const Ending = z.strictObject({ state: z.literal("ending"), ...SessionFields, cred: CaptureCred.optional(), endReason: CaptureEndReason });
const Completed = z.strictObject({ state: z.literal("completed"), ...SessionFields, endReason: CaptureEndReason });
const Failed = z.strictObject({ state: z.literal("failed"), ...SessionFields, endReason: CaptureEndReason });

export const CaptureSession = z.discriminatedUnion("state", [Warming, Live, Ending, Completed, Failed]);
export type CaptureSession = z.infer<typeof CaptureSession>;
export const CaptureDescriptor = z.discriminatedUnion("state", [CaptureWaiting, Warming, Live, Ending, Completed, Failed]);
export type CaptureDescriptor = z.infer<typeof CaptureDescriptor>;

export const CaptureBeat = z.strictObject({
  code: Code,
  slot: z.number().int().min(0),
  phone: z.string().min(16).max(64),
  claim: z.enum(["new", "resume"]).nullable(),
  device: z.strictObject({ model: z.string().min(1).max(80) }).nullable(),
  sid: z.uuid().nullable(),
  at: z.iso.datetime({ offset: true }),   // R5 (final): any offset accepted; the server normalises to UTC; the phone sends Z
  state: CapturePhoneState,
  cause: CaptureCause.nullable(),
  notReady: CaptureNotReady.nullable(),
  startFailed: CaptureStartFailed.nullable(),
  stopped: z.uuid().nullable(),
  mode: z.enum(["automatic", "operator"]),
  transport: z.enum(["srt", "rtmps"]).nullable(),
  bitrateKbps: z.number().int().min(0).max(100_000).nullable(),
  delivery: z.enum(["ok", "stalled", "unknown"]),
  deliveredLagS: z.number().min(0).max(99_999).nullable(),
  audioOk: z.boolean().nullable(),
  battery: z.strictObject({
    percent: z.number().int().min(0).max(100), charging: z.boolean(),
    drainPctPerHour: z.number().min(0).max(1000).nullable(),
  }).nullable(),
  thermal: z.number().int().min(0).max(6).nullable(),
  dataUsedMB: z.number().min(0).max(1_000_000).nullable(),
  appVersion: z.string().min(1).max(40),
  endReason: z.literal("operator-stopped").optional(),
});
export type CaptureBeat = z.infer<typeof CaptureBeat>;

/** R5 (final, capture agreed 2026-10-01): the beat answer is a discriminated union on `state`.
 *  Common fields: required on waiting, go-live, live and over; optional on replaced and taken.
 *  go-live: sid + startedBy. live: sid, NO startedBy. over: sid + endReason. replaced/taken: no sid, no startedBy,
 *  no endReason, and an optional `device` (G0-e, for the panel; the phone ignores it). */
const AnswerCommon = z.strictObject({
  label: z.string().min(1).max(200),
  scheduledStart: EpochS.nullable(),
  autoAllowed: z.boolean(),
  destinationName: z.string().min(1).max(80).nullable(),
  overlayUrl: Url.nullable(),
  pollSeconds: PollSeconds,
});
const AnswerDevice = z.strictObject({ model: z.string().min(1).max(80) });

export const CaptureBeatAnswer = z.discriminatedUnion("state", [
  AnswerCommon.extend({ state: z.literal("waiting") }),
  AnswerCommon.extend({ state: z.literal("go-live"), sid: z.uuid(), startedBy: CaptureStartedBy }),
  AnswerCommon.extend({ state: z.literal("live"), sid: z.uuid() }),
  AnswerCommon.extend({ state: z.literal("over"), sid: z.uuid(), endReason: CaptureEndReason }),
  AnswerCommon.partial().extend({ state: z.literal("replaced"), device: AnswerDevice.optional() }),
  AnswerCommon.partial().extend({ state: z.literal("taken"), device: AnswerDevice.optional() }),
]);
export type CaptureBeatAnswer = z.infer<typeof CaptureBeatAnswer>;
// Every branch must stay strict after .extend()/.partial(): each branch's `answer-tampered-<state>.json` (one extra
// key) is refused. That is the guard, not this comment.

export const CaptureStartBody = z.strictObject({ phone: z.string().min(16).max(64) });
export type CaptureStartBody = z.infer<typeof CaptureStartBody>;
export const CaptureStartOk = z.strictObject({ sid: z.uuid() });
export type CaptureStartOk = z.infer<typeof CaptureStartOk>;

export const CaptureRefusalCode = z.enum([
  "code_ended", "not_a_stream_code", "already_live", "replaced", "no_destination", "no_credit", "not_entitled",
  "unavailable", "invalid", "rate_limited",
]);
export type CaptureRefusalCode = z.infer<typeof CaptureRefusalCode>;
/** Every refusal: {code, message, ...extras}. Only already_live carries extras: {code, message, sid, startedBy}
 *  (unchanged by R5). */
export const CaptureRefusal = z.union([
  z.strictObject({ code: z.literal("already_live"), message: z.string(), sid: z.uuid(), startedBy: CaptureStartedBy }),
  z.strictObject({ code: CaptureRefusalCode.exclude(["already_live"]), message: z.string() }),
]);
export type CaptureRefusal = z.infer<typeof CaptureRefusal>;
