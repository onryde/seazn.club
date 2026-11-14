// apps/web/src/server/api-v1/capture-schemas.ts — the zod twins of docs/contracts/capture-*.json (spec §4, §6.3,
// §6.14). The JSON files are the cross-repo authority; capture-contract.test.ts pins parity both ways.
//
// Imports zod and nothing else: api-v1/schemas/ re-exports this file through a relative `.ts` specifier, and the
// standalone OpenAPI generator (scripts/openapi-gen.ts, bare `node --experimental-strip-types`) loads api-v1/schemas/.
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

/** W28 (2026-10-06): the pool's key, one capital letter (usecases/stages/generators.ts POOL_KEYS) — never its English name. */
export const CAPTURE_POOL_RE = /^[A-Z]$/;
/** W28: the engine's `RoundRole`, serialised verbatim — `kind`, plus `n` or `entrants` where the variant has one.
 *  `kind` is OPEN on the wire (no enum): a consumer shows nothing for a kind it does not know. */
export const CaptureStageRole = z.strictObject({
  kind: z.string().min(1),
  n: z.number().int().min(1).optional(),
  entrants: z.number().int().min(2).optional(),
});
/** W28: the match's place in its stage — the scheduler board's chip (`code`), its round role, its pool's key, and
 *  (2026-10-07; reshaped 2026-10-08) the `label` the phone shows verbatim, in the org's locale: division · pool word ·
 *  round, an absent part left out — "Round {n}" for a plain round, the long name for a final, third-place match or
 *  grand final, the chip otherwise. Over this max the pool word goes first, then the division, then the label. */
export const CAPTURE_STAGE_LABEL_MAX = 40;
export const CaptureStage = z.strictObject({
  code: z.string().min(1).max(8),
  role: CaptureStageRole,
  pool: z.string().regex(CAPTURE_POOL_RE).optional(),
  label: z.string().min(1).max(CAPTURE_STAGE_LABEL_MAX).optional(),
});
export type CaptureStage = z.infer<typeof CaptureStage>;

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
  /** W28: on the waiting shape and every session state; omitted, never null, when no code can be produced. */
  stage: CaptureStage.optional(),
};

export const CaptureWaiting = z.strictObject({ state: z.literal("waiting"), ...WaitingFields });
export type CaptureWaiting = z.infer<typeof CaptureWaiting>;

/** W26 (2026-10-05, superseding W15 and W21's RTMPS half): both credentials are on Cloudflare's own host, exactly as
 *  Cloudflare issues them — srt://live.cloudflare.com:778 and rtmps://live.cloudflare.com:443/live/ — in every
 *  environment; there is no custom ingest host. No host is pattern-checked here: capture enforces it (capture's
 *  owner, 2026-10-05: the app trusts only live.cloudflare.com, for SRT and RTMPS alike). */
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

/** D16, §6.4 / A18 (G0-c): `preferred` never names a null shape, so a `cred` whose `srt` is null rides with "rtmps".
 *  The published file states this in prose; a refine is not exported to JSON Schema, so the server enforces it here. */
const preferredNamesAShape = (v: { state: string; preferred?: string; cred?: CaptureCred }): boolean => v.cred?.srt !== null || v.preferred === "rtmps";
const PREFERRED_RULE = { path: ["preferred"], message: "cred.srt is null, so preferred must be \"rtmps\" (§6.4, A18)" };

export const CaptureSession = z.discriminatedUnion("state", [Warming, Live, Ending, Completed, Failed]).refine(preferredNamesAShape, PREFERRED_RULE);
export type CaptureSession = z.infer<typeof CaptureSession>;
export const CaptureDescriptor = z.discriminatedUnion("state", [CaptureWaiting, Warming, Live, Ending, Completed, Failed]).refine(preferredNamesAShape, PREFERRED_RULE);
export type CaptureDescriptor = z.infer<typeof CaptureDescriptor>;

/** The beat's `at`. R5 (final): any offset accepted; the server normalises to UTC; the phone sends Z. RFC 3339
 *  `date-time` (the published file's `format`) REQUIRES seconds, a fraction of any length optional; zod's iso.datetime
 *  without a precision also admits a minute-only `HH:MM`, and `precision` cannot say "seconds, any fraction". So a
 *  refine closes exactly that gap. A refine is not exported to JSON Schema, so the contract bytes do not move. */
const HAS_SECONDS = /T\d{2}:\d{2}:\d{2}/;
const BeatAt = z.iso.datetime({ offset: true }).refine((s) => HAS_SECONDS.test(s), { message: "RFC 3339 date-time requires seconds" });

export const CaptureBeat = z.strictObject({
  code: Code,
  slot: z.number().int().min(0),
  phone: z.string().min(16).max(64),
  claim: z.enum(["new", "resume"]).nullable(),
  device: z.strictObject({ model: z.string().min(1).max(80) }).nullable(),
  sid: z.uuid().nullable(),
  at: BeatAt,
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
})
  // D16 (capture's field-by-field check, 2026-10-01): the cross-field rules. The published file stays byte-frozen and
  // a refine is not exported to JSON Schema, so ajv admits a breach and the server refuses it (422). Each rule raises
  // one issue on its own field; capture-contract.test.ts's ZOD_ONLY list holds one fixture per rule.
  .refine((b) => b.cause === null || b.sid !== null, { path: ["cause"], message: "cause rides only while a broadcast is held (a sid)" })
  .refine((b) => b.endReason === undefined || b.state === "ended", { path: ["endReason"], message: "endReason only with state \"ended\" (§6.3.2)" })
  .refine((b) => b.stopped === null || b.sid === null, { path: ["stopped"], message: "stopped only while sid is null (§6.3.2, capture RR3)" })
  // A claim rides only until the pairing's first 2xx; a rejoin follows a 2xx `live`. The two never meet.
  .refine((b) => b.claim === null || b.cause !== "rejoin", { path: ["cause"], message: "a claim never rides with cause \"rejoin\"" });
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

/** W27 (2026-10-06): `POST …/scoring-link` answers `{url}` — the match's Remote scoring link. The pattern is the agreed
 *  contract, verbatim: an https origin, `/score/`, and a device-link secret (`dl_` + 32 bytes as base64url). */
export const CAPTURE_SCORING_LINK_URL_RE = new RegExp("^https://[^/]+/score/dl_[A-Za-z0-9_-]{43}$");
export const CaptureScoringLinkOk = z.strictObject({ url: z.string().regex(CAPTURE_SCORING_LINK_URL_RE) });
export type CaptureScoringLinkOk = z.infer<typeof CaptureScoringLinkOk>;

// ---------------------------------------------------------------------------------------------------------------
// capture-record.v1 (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12): the record
// upload `POST …/codes/{code}/records`. The body is NDJSON and THIS line shape is ONE line.
// ---------------------------------------------------------------------------------------------------------------

/** §5: at most this many NON-EMPTY lines, and at most this many bytes, both measured on the DECOMPRESSED body. */
export const CAPTURE_RECORD_MAX_LINES = 1000;
export const CAPTURE_RECORD_MAX_BYTES = 1_048_576;

/** allow-list.json's plainWord (`^[A-Za-z0-9_.:-]{1,64}$`) or the scrub's mask `***`. */
const RecordWord = z.string().regex(/^([A-Za-z0-9_.:-]{1,64}|[*]{3})$/);
/** A public https URL with no userinfo, query or fragment, or the mask. */
const RecordPublicUrl = z.string().regex(new RegExp("^([Hh][Tt][Tt][Pp][Ss]://[^/?#@ \\t\\n\\v\\f\\r:]+(:[0-9]+)?(/[^?# \\t\\n\\v\\f\\r]*)?|[*]{3})$"));
const Scalar = [z.number(), z.boolean(), z.null()] as const;
const plain = () => z.union([RecordWord, ...Scalar]).optional();
const publicUrl = () => z.union([RecordPublicUrl, ...Scalar]).optional();
const text = () => z.union([z.string(), ...Scalar]).optional();
const scalar = () => z.union([...Scalar]).optional();

/** Capture's `modules/capture-engine/src/scrub/allow-list.json` at capture 2b4df80, class by class (§5). `kind` and
 *  `sid` and `tokenTag` are plain keys the line narrows below, as are four scalars (RECORD_NARROWED_SCALARS); a plain
 *  key named like one of the line's own keys is written `field_<key>`. A key capture adds is a contract bump here, in
 *  step with capture's change. */
const RECORD_PLAIN_KEYS = [
  "action", "answer", "appVersion", "attempt", "cause", "claim", "count", "delivery", "endReason", "error", "exit",
  "failure", "field", "from", "host", "intent", "key", "field_kind", "lastEnd", "lock", "mode", "ms", "notReady", "op",
  "phase", "pickSource", "problem", "reason", "refusal", "result", "retryAfterS", "rootError", "route", "scene", "shed",
  "side", "site", "slot", "source", "startFailed", "state", "status", "tag", "to", "transport", "word",
] as const;
const RECORD_PUBLIC_URL_KEYS = ["url", "playbackUrl", "overlayUrl"] as const;
const RECORD_TEXT_KEYS = ["message", "problems"] as const;
const RECORD_SCALAR_KEYS = [
  "audioFps", "bandwidthBps", "camera", "counted", "dropped", "egressBps", "encodeListed", "exitAtMs", "failed", "gapMs",
  "gateBps", "granted", "headroom", "held", "intervalMs", "lagGrowthMs", "lagMs", "late", "listed", "lost",
  "minuteEpochMs", "msSinceAdvance", "ok", "on", "outageMs", "pickHeight", "pickWidth", "publishedMs", "rebaselined",
  "rebuilds", "refusedSid", "sameArea", "sendBufferMs", "sent", "sinceLastMs", "sound", "srtOffered", "stalledMs",
  "stopped", "suppressed", "target", "validated", "videoFps", "wasLive",
] as const;
/** Scalars the allow-list's own reasons narrow (capture ebac190): a size, a count and a wait — integers of at least 0 —
 *  and a yes/no. Capture writes them from typed fields (Kotlin Int/Long/Boolean, JS `TextEncoder` length), never null. */
const count = () => z.number().int().min(0).optional();
const RECORD_NARROWED_SCALARS = {
  bytes: count(), failures: count(), retryMs: count(), pickAspect16x9: z.boolean().optional(),
};
const keyed = <K extends string, T extends z.ZodType>(keys: readonly K[], make: () => T): Record<K, T> =>
  Object.fromEntries(keys.map((k) => [k, make()])) as Record<K, T>;

/** ONE NDJSON line (§5). `at` is the beat's `at`, byte for byte (R5); `level` absent means info; `sid` only what
 *  attribution can judge (a uuid, the mask, null); `tokenTag` eight lowercase hex digits, never masked. Strict: a line
 *  with any other key — a never key included, even masked — is refused by this shape, and the server DROPS it (owner
 *  ruling RL, 2026-10-12: a bad line is dropped, never the body refused). The secret-shaped rules run on top (S1–S5).
 *
 *  Review fix 2 (PR #943): zod's strict check SKIPS a key named `__proto__` (so the key cannot swap its result's
 *  prototype), and it skips it silently — such a line would pass, its value (any shape: a nested object escapes the
 *  string-only secret scan) still in the parsed input. JSON.parse writes `"__proto__"` as an OWN key, which ajv refuses
 *  like any key off the list; the preprocess refuses it here too, so the twin agrees with the file. It adds an issue
 *  and changes nothing, so toJSONSchema (input and output) is the object's own and the parity test is unchanged. */
const recordLineObject = z.strictObject({
  at: BeatAt,
  kind: RecordWord,
  level: z.enum(["debug", "info", "warn", "error", "***"]).optional(),
  ...keyed(RECORD_PLAIN_KEYS, plain),
  sid: z.union([z.uuid(), z.literal("***"), z.null()]).optional(),
  tokenTag: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  ...keyed(RECORD_PUBLIC_URL_KEYS, publicUrl),
  ...keyed(RECORD_TEXT_KEYS, text),
  ...keyed(RECORD_SCALAR_KEYS, scalar),
  ...RECORD_NARROWED_SCALARS,
});
export const CaptureRecordLine = z.preprocess((input, ctx) => {
  if (typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")) {
    ctx.addIssue({ code: "custom", message: "a key off the allow-list (__proto__)", input });
  }
  return input;
}, recordLineObject);
export type CaptureRecordLine = z.infer<typeof CaptureRecordLine>;

/** P9: `R-` and 4 upper-case Crockford base32 characters (no I, L, O or U); up to 8 without a new version. */
export const CAPTURE_RECORD_REF_RE = /^R-[0-9A-HJKMNP-TV-Z]{4,8}$/;
const RecordCount = z.number().int().min(0).max(CAPTURE_RECORD_MAX_LINES);
/** 201: the bare `{ref, kept, dropped}` (RD: the app shows only the ref). */
export const CaptureRecordOk = z.strictObject({ ref: z.string().regex(CAPTURE_RECORD_REF_RE), kept: RecordCount, dropped: RecordCount });
export type CaptureRecordOk = z.infer<typeof CaptureRecordOk>;

/** Q2 (owner, 2026-10-12): the record's OWN refusal twin — `too_large` is a new word, and adding it to the shared
 *  CaptureRefusalCode would change every other capture contract. Never `replaced` (R4). */
export const CaptureRecordRefusalCode = z.enum(["code_ended", "not_a_stream_code", "too_large", "invalid", "rate_limited", "unavailable"]);
export type CaptureRecordRefusalCode = z.infer<typeof CaptureRecordRefusalCode>;
export const CaptureRecordRefusal = z.strictObject({ code: CaptureRecordRefusalCode, message: z.string() });
export type CaptureRecordRefusal = z.infer<typeof CaptureRecordRefusal>;

/** P8, the contract's `$defs.secretS2`–`secretS5`, which the server runs on every string value. Each skips the scrub's
 *  mask: `***` with no letter or digit after it. The parity test pins each pattern to the published bytes. */
export const CaptureRecordSecretS2 = z.string().regex(new RegExp("[Rr][Tt][Mm][Pp][Ss]?://[^\\s/?#]+/[^\\s/?#]+/(?!\\*\\*\\*(?![A-Za-z0-9]))[^\\s/?#]+"));
export const CaptureRecordSecretS3 = z.string().regex(new RegExp("\\b(?:[Ss][Tt][Rr][Ee][Aa][Mm][Ii][Dd]|[Pp][Aa][Ss][Ss][Pp][Hh][Rr][Aa][Ss][Ee])(?:=(?!\\*\\*\\*(?![A-Za-z0-9]))[^\\s&]+|\\s+[A-Za-z0-9._~+/=-]{16,})"));
export const CaptureRecordSecretS4 = z.string().regex(new RegExp("[A-Za-z][A-Za-z0-9+.-]*://(?:[^\\s/?#@:]*:)?(?!\\*\\*\\*@)[^\\s/?#@:]+@"));
export const CaptureRecordSecretS5 = z.string().regex(new RegExp("\\b[Bb][Ee][Aa][Rr][Ee][Rr]\\s+[A-Za-z0-9._~+/=-]{16,}"));

export const CaptureRefusalCode = z.enum([
  "code_ended", "not_a_stream_code", "already_live", "replaced", "no_destination", "no_credit", "not_entitled",
  "unavailable", "invalid", "rate_limited",
  // W27 (2026-10-06): the scoring link of a finalized or cancelled match — answered only by `…/scoring-link`.
  "match_finished",
]);
export type CaptureRefusalCode = z.infer<typeof CaptureRefusalCode>;
/** Every refusal: {code, message, ...extras}. Only already_live carries extras: {code, message, sid, startedBy}
 *  (unchanged by R5). */
export const CaptureRefusal = z.union([
  z.strictObject({ code: z.literal("already_live"), message: z.string(), sid: z.uuid(), startedBy: CaptureStartedBy }),
  z.strictObject({ code: CaptureRefusalCode.exclude(["already_live"]), message: z.string() }),
]);
export type CaptureRefusal = z.infer<typeof CaptureRefusal>;

// ---------------------------------------------------------------------------------------------------------------
// capture-matchday-day.v1 (capture S4 Match Day design 2026-11-07 §5, §9; MD-1 Task 3): a Match Day code's day read,
// `GET /match-day-code`. The md_ routes ride the v1 envelope: an answer is `data` in `{ok: true, data, requestId}`, a refusal is `error`
// in `{ok: false, error, requestId}`.
// ---------------------------------------------------------------------------------------------------------------

/** Every refusal word the md_ routes answer (the plan's Global Constraints), with its status. */
export const CaptureMatchdayRefusalCode = z.enum([
  "MD_UNKNOWN", "MD_WITHDRAWN", "MD_ENDED", "MD_NOT_OPEN", "MD_OUT_OF_SCOPE", "MD_NO_APPROVE", "MD_STALE", "MD_ALREADY",
  "MD_TIES",
]);
export type CaptureMatchdayRefusalCode = z.infer<typeof CaptureMatchdayRefusalCode>;
/** An instant the server writes with `toISOString()`: UTC, milliseconds, `Z`. */
const MdInstant = z.iso.datetime();
/** One match as the list shows it. */
export const CaptureMatchdayRow = z.strictObject({
  fixture_id: z.uuid(),
  sport_key: z.string().min(1),
  division_name: z.string(),
  round_label: z.string().min(1).nullable(),
  /** The match as the desk tags it: "SF·1", "F" for a round of one match, `R{n}` where no round is coded. */
  round_tag: z.string().min(1).nullable(),
  home: z.string().nullable(),
  away: z.string().nullable(),
  /** What the desk prints for a seat with no entrant ("Winner of Group A"); null when it has an entrant or no label. */
  home_slot: z.string().nullable(),
  away_slot: z.string().nullable(),
  status: z.enum(["upcoming", "in_play", "finished"]),
  scheduled_at: MdInstant.nullable(),
  /** The short score as the Match Day desk shows it in a row (`compactScore`, lib/match-day/view.ts): "1–1 · 14–9" while a set
   *  sport plays, "2–0" once finished, the sport's own headline otherwise. Never the engine's full headline. */
  summary: z.string().nullable(),
});
export const CaptureMatchdayApproval = z.strictObject({
  kind: z.enum(["swiss", "draw"]),
  stage_id: z.uuid(),
  division_name: z.string(),
  label: z.string(),
  /** Swiss: the round awaiting pairing; a draw: null (MD-1 fix M1, the controller's ruling). */
  round: z.number().int().min(1).nullable(),
  /** A draw whose source stages are all decided but not yet completed on the desk: listed, no button. Else null. */
  waiting: z.enum(["stage_complete"]).nullable(),
});
export const CaptureMatchdayCourt = z.strictObject({
  court_id: z.uuid(),
  court_name: z.string(),
  venue_name: z.string(),
  state: z.enum(["playing", "called", "free", "in_use_elsewhere"]),
  now: CaptureMatchdayRow.nullable(),
  next: z.array(CaptureMatchdayRow),
  finished: z.array(CaptureMatchdayRow),
});
export const CaptureMatchdayDay = z.strictObject({
  competition: z.strictObject({ id: z.uuid(), name: z.string() }),
  scope: z.strictObject({ kind: z.enum(["competition", "venue", "courts"]), label: z.string() }),
  day: z.iso.date(),
  tz: z.string().min(1),
  opens_at: MdInstant,
  expires_at: MdInstant,
  can_approve: z.boolean(),
  /** Task 8e (additive): whether the code may call a match to a court (capture-matchday-call.v1). */
  can_call: z.boolean(),
  courts: z.array(CaptureMatchdayCourt),
  no_court: z.array(CaptureMatchdayRow),
  online: z.array(CaptureMatchdayRow),
  approvals: z.array(CaptureMatchdayApproval),
});
export type CaptureMatchdayDay = z.infer<typeof CaptureMatchdayDay>;
/** Every md_ refusal, the envelope's `error`: one of the plan's MD_ words, a closed list (MD-1 fix M5). `opens_at` rides
 *  MD_NOT_OPEN only. The v1 envelope's own answers (429 RATE_LIMITED, 404 NOT_FOUND, 500 INTERNAL) are not md_ refusals
 *  and are outside this shape: the phone reads them by status, as on every v1 route. */
export const CaptureMatchdayRefusal = z.strictObject({
  code: CaptureMatchdayRefusalCode,
  message: z.string(),
  opens_at: MdInstant.optional(),
});
export type CaptureMatchdayRefusal = z.infer<typeof CaptureMatchdayRefusal>;

// ---------------------------------------------------------------------------------------------------------------
// capture-matchday-open.v1 (capture S4 Match Day design §6, §9.4; MD-1 Task 4): POST /match-day-code/fixtures/{id}/scoring-link
// ---------------------------------------------------------------------------------------------------------------

/** The open's 200: the match's own scoring link (the capture phone's pattern, `CAPTURE_SCORING_LINK_URL_RE`) and the
 *  sport whose pad it opens, or "the match is over" (finalized or cancelled), with nothing else. A match outside the
 *  code's scope is the refusal 403 MD_OUT_OF_SCOPE, never a 200. */
export const CaptureMatchdayOpen = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link"), url: z.string().regex(CAPTURE_SCORING_LINK_URL_RE), sport_key: z.string().min(1) }),
  z.strictObject({ kind: z.literal("finished") }),
]);
export type CaptureMatchdayOpen = z.infer<typeof CaptureMatchdayOpen>;

// ---------------------------------------------------------------------------------------------------------------
// capture-matchday-approval.v1 (capture S4 Match Day design §7, §9.5; MD-1 Task 6):
// GET|POST /match-day-code/approvals/{kind}/{stageId}
// ---------------------------------------------------------------------------------------------------------------

/** One pairing or drawn match as the review shows it: its place, and its sides' names (`away` null on a bye, or a
 *  knockout match whose other seat is fed from elsewhere). */
const CaptureMatchdayApprovalRow = z.strictObject({
  label: z.string().min(1),
  home: z.string(),
  away: z.string().nullable(),
});
/** The review (GET): what the server computed, read-only, and the `hash` (and, for a Swiss round, the `round`) the approve
 *  hands back. `ties`: a draw with a tie only the web desk can resolve, which the phone cannot approve. */
export const CaptureMatchdayApprovalReview = z.strictObject({
  kind: z.enum(["swiss", "draw"]),
  stage_id: z.uuid(),
  division_name: z.string(),
  round: z.number().int().min(1).nullable(),
  rows: z.array(CaptureMatchdayApprovalRow),
  hash: z.string().min(1).max(128),
  ties: z.boolean(),
});
export type CaptureMatchdayApprovalReview = z.infer<typeof CaptureMatchdayApprovalReview>;
/** The approve's body (POST): the review's `hash`, and for a Swiss round its `round` (a draw sends none, or null). */
export const CaptureMatchdayApprovalRequest = z.strictObject({
  hash: z.string().min(1).max(128),
  round: z.number().int().min(1).nullable().optional(),
});
export type CaptureMatchdayApprovalRequest = z.infer<typeof CaptureMatchdayApprovalRequest>;
/** The approve's 200: approved, by this request. A second phone's approve is the refusal MD_ALREADY, never this. */
export const CaptureMatchdayApprovalOk = z.strictObject({ ok: z.literal(true) });
export type CaptureMatchdayApprovalOk = z.infer<typeof CaptureMatchdayApprovalOk>;

// ---------------------------------------------------------------------------------------------------------------
// capture-matchday-call.v1 (Task 8e, owner 2026-11-13): a Match Day code calls a match to a court.
// GET /match-day-code/courts/{courtId}/candidates, POST|DELETE /match-day-code/fixtures/{fixtureId}/call
// ---------------------------------------------------------------------------------------------------------------

/** The call routes' refusal words: the door's four, MD_OUT_OF_SCOPE, and the call's own two. Its own list, so the day read's,
 *  the open's and the approvals' contracts are unchanged by it. */
export const CaptureMatchdayCallRefusalCode = z.enum([
  "MD_UNKNOWN", "MD_WITHDRAWN", "MD_ENDED", "MD_NOT_OPEN", "MD_OUT_OF_SCOPE", "MD_NO_CALL", "MD_CALL_REFUSED",
]);
export type CaptureMatchdayCallRefusalCode = z.infer<typeof CaptureMatchdayCallRefusalCode>;
/** Why a call, its preview or its Undo was refused: the desk's own refusal, in the phone's words. */
export const CaptureMatchdayCallReason = z.enum([
  "not_candidate_court", "player_busy", "court_busy", "started", "not_ready", "not_called", "frozen", "not_code_call",
]);
export type CaptureMatchdayCallReason = z.infer<typeof CaptureMatchdayCallReason>;
/** A call refusal: MD_CALL_REFUSED carries its `reason` (and, for some, a name); every other word is the day read's shape. */
export const CaptureMatchdayCallRefusal = z.union([
  z.strictObject({
    code: z.literal("MD_CALL_REFUSED"),
    message: z.string(),
    reason: CaptureMatchdayCallReason,
    person_name: z.string().optional(),
    court_name: z.string().nullable().optional(),
  }),
  z.strictObject({
    code: CaptureMatchdayCallRefusalCode.exclude(["MD_CALL_REFUSED"]),
    message: z.string(),
    opens_at: MdInstant.optional(),
  }),
]);
export type CaptureMatchdayCallRefusal = z.infer<typeof CaptureMatchdayCallRefusal>;
/** A match that could start on the court now, as the desk's free-court panel offers it. */
export const CaptureMatchdayCandidate = z.strictObject({
  match: CaptureMatchdayRow,
  source: z.enum(["this_court", "other_court", "no_court"]),
  from_court_name: z.string().nullable(),
  /** True for an other_court candidate whose match is called onto that court and not started; false otherwise. */
  called: z.boolean(),
  /** True when the match is the first match queued on `from_court_name`'s court, that court's very next; false for a later match of its queue, for a this_court or no_court candidate and for a called match. A court's very next match counts even when a side of it is still to be decided (the first ready match behind it is false). */
  first_in_queue: z.boolean(),
  planned_at: MdInstant.nullable(),
  waiting_minutes: z.number().int().min(0),
  behind_minutes: z.number().int().min(0),
  blocked: z.strictObject({ kind: z.literal("player_busy"), person_name: z.string(), court_name: z.string().nullable() }).nullable(),
});
export const CaptureMatchdayCandidates = z.strictObject({
  court_id: z.uuid(),
  court_name: z.string(),
  candidates: z.array(CaptureMatchdayCandidate),
});
export type CaptureMatchdayCandidates = z.infer<typeof CaptureMatchdayCandidates>;
/** The call's body: the court, and whether this is the preview (writes nothing) or the call. */
export const CaptureMatchdayCallRequest = z.strictObject({ court_id: z.uuid(), preview: z.boolean() });
export type CaptureMatchdayCallRequest = z.infer<typeof CaptureMatchdayCallRequest>;
const CaptureMatchdayCallWarning = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pushes_later"), count: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal("rest_gap"), person_name: z.string(), minutes: z.number().int().min(0), min_rest: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal("past_day_end"), court_name: z.string(), until: MdInstant }),
  z.strictObject({ kind: z.literal("crosses_closure"), court_name: z.string(), from: MdInstant, until: MdInstant }),
  z.strictObject({ kind: z.literal("court_closed"), court_name: z.string(), until: MdInstant.nullable(), since: MdInstant.nullable() }),
]);
/** The preview's 200 (`preview: true`): the desk's knock-on, nothing written. */
export const CaptureMatchdayCallPreview = z.strictObject({
  shifts: z.array(
    z.strictObject({
      fixture_id: z.uuid(),
      label: z.string(),
      round_label: z.string().min(1),
      planned_at: MdInstant,
      estimated_at: MdInstant,
    }),
  ),
  warnings: z.array(CaptureMatchdayCallWarning),
});
export type CaptureMatchdayCallPreview = z.infer<typeof CaptureMatchdayCallPreview>;
/** The call's 200 (`preview: false`). */
export const CaptureMatchdayCallOk = z.strictObject({ fixture_id: z.uuid(), court_id: z.uuid(), called_at: MdInstant });
export type CaptureMatchdayCallOk = z.infer<typeof CaptureMatchdayCallOk>;
/** The Undo call's 200: where the match is back to (nulls: it had no court, or no time). */
export const CaptureMatchdayUndoOk = z.strictObject({
  fixture_id: z.uuid(),
  court_id: z.uuid().nullable(),
  scheduled_at: MdInstant.nullable(),
});
export type CaptureMatchdayUndoOk = z.infer<typeof CaptureMatchdayUndoOk>;
