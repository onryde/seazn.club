// The capture QR v2 phone↔web contract (spec 2026-10-01 §4, §6.2, §6.3, §6.14, §17.5; PR-1 T1).
//
// docs/contracts/capture-*.json are the cross-repo authority: the capture app vendors them byte for byte. The zod
// twins (server/api-v1/capture-schemas.ts, and CaptureQrV2 in lib/capture-qr.ts) mirror them. This file pins:
//   * each contract's sha256 — a change is a deliberate bump that moves the constant in the same commit;
//   * structural parity, file ↔ z.toJSONSchema(twin), per union branch matched by `state`;
//   * every hand-written fixture: `valid*` parses, `invalid-*` / `tampered*` / `wrong-version` is refused — by the zod
//     twin AND by the published JSON bytes under ajv (draft 2020-12, formats asserted), so the vendored file is proven
//     behaviourally, not only structurally;
//   * every enum, typed here from the spec's literal lists (§6.3.1–§6.3.4), against the file and the twin;
//   * the per-state field matrices (R5 final, A21), TYPED HERE FROM THE SPEC'S TEXT (§6.3.1, §17.5) — the rulebook,
//     never read off the twin — run against BOTH the twin (through the fixtures) and the JSON file (structurally);
//   * optional-versus-null, `at`'s offset, strictness surviving .extend()/.partial(), W26's hosts, QR v2 (with
//     capture's optional `exp`, which this server never sends), and 409;
//   * W27 (2026-10-06): the scoring-link route's contract — its {phone} body, its 200 {url} and every refusal it
//     answers, `match_finished` among them — and W28: the descriptor's optional `stage` on every state, its bounds
//     (code 1..8, pool ^[A-Z]$), and `role.kind` as an OPEN string whose prose lists every kind the engine declares.
//   * the record upload's contract (capture-record.v1, design APPROVED by the owner 2026-10-12): its twins (the line, the
//     201, its own refusal and the secret-shaped rules S2–S5) join the parity test and the fixture sweep like every
//     other file, its keys are checked against capture's allow-list typed here, and the tripwire holds every
//     record-named export of capture-schemas.ts to the parity list.
// Every sweep counts what it checked, and the counts are pinned: a skipped cell, branch or fixture fails the run.
//
// Pure — no DB. One "sport" on purpose: the contract reads no sport (the capture surface is sport-agnostic).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as CS from "../capture-schemas";
import * as S from "../schemas";
import { CaptureQrV2, captureQrV2Text, parseCaptureQrV2 } from "@/lib/capture-qr";
import type { RoundRole } from "@seazn/engine/competition";

type Json = Record<string, unknown>;
type Twin = z.ZodType;

const CONTRACTS = resolve(import.meta.dirname, "../../../../../../docs/contracts");
const FIXTURES = resolve(CONTRACTS, "fixtures");
const contractText = (file: string): string => readFileSync(resolve(CONTRACTS, file), "utf8");
const contract = (file: string): Json => JSON.parse(contractText(file)) as Json;
const fixture = (dir: string, name: string): Json =>
  JSON.parse(readFileSync(resolve(FIXTURES, dir, `${name}.json`), "utf8")) as Json;
const parses = (twin: Twin, value: unknown): boolean => twin.safeParse(value).success;
const without = (o: Json, key: string): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** `shasum -a 256 docs/contracts/<file>`. A contract change is a DELIBERATE bump: it moves its constant here in the
 *  same commit, and capture re-vendors the file. */
const SHA256: Record<string, string> = {
  "capture-qr.v2.json": "3292e33f84b693e5def6048012f6653ca7e31e1573fda3901da4fe67a62c5d43",
  "capture-descriptor.v1.json": "5c9b09c422b092671ad3a842b02e5c18902c92fc290cbc562c91033555955b8b",
  "capture-beat.v1.json": "e14329132400d45cd38e03b19cf85189fe35acb0b8b9a51e7ca98879fe07c736",
  "capture-start.v1.json": "012d6e3851e84d0ce659ad23449fa91b61f0d20cfac1e58f2ccbc7cbb0742bae",
  "capture-scoring-link.v1.json": "f0f1188655f3ca83b3e42ce7fedd6f6210a3a141b0bcf02fa250eb2448b1c85f",
  "capture-record.v1.json": "213f766043b7682f198cc98da13e93995b6602e46533ecf60c78bf562aebd6f8",
};

// ---------------------------------------------------------------------------------------------------------------
// The rulebook, typed from the spec's text.
// ---------------------------------------------------------------------------------------------------------------
type Cell = "required" | "optional" | "forbidden";
const REQ: Cell = "required", OPT: Cell = "optional", NO: Cell = "forbidden";

/** §17.5: "The common fields are label, scheduledStart: epoch-s | null, autoAllowed, destinationName: string | null,
 *  overlayUrl: string | null and pollSeconds." */
const COMMON = ["label", "scheduledStart", "autoAllowed", "destinationName", "overlayUrl", "pollSeconds"] as const;
const COMMON_NULLABLE = new Set<string>(["scheduledStart", "destinationName", "overlayUrl"]);
const ANSWER_FIELDS = ["sid", "startedBy", "endReason", "device", ...COMMON] as const;
type AnswerField = (typeof ANSWER_FIELDS)[number];
const answerRow = (sid: Cell, startedBy: Cell, endReason: Cell, device: Cell, common: Cell): Record<AnswerField, Cell> => ({
  sid, startedBy, endReason, device, ...(Object.fromEntries(COMMON.map((f) => [f, common])) as Record<(typeof COMMON)[number], Cell>),
});
/** §17.5's table, row for row (absent = forbidden). */
const ANSWER_MATRIX: Record<string, Record<AnswerField, Cell>> = {
  waiting: answerRow(NO, NO, NO, NO, REQ),
  "go-live": answerRow(REQ, REQ, NO, NO, REQ),
  live: answerRow(REQ, NO, NO, NO, REQ),
  over: answerRow(REQ, NO, REQ, NO, REQ),
  replaced: answerRow(NO, NO, NO, OPT, OPT),
  taken: answerRow(NO, NO, NO, OPT, OPT),
};

/** §6.3.1's session shape, the fields the waiting shape lacks; §17.5: "endReason is required on ending, completed and
 *  failed, and absent on warming and live; cred is optional on warming, live and ending, and absent on completed and
 *  failed." */
const SESSION_ONLY = ["sid", "preferred", "playbackUrl", "holdWindowSeconds", "maxDurationMinutes", "warmingDeadline", "scoreUpdates"] as const;
const DESCRIPTOR_FIELDS = ["cred", "endReason", "stage", ...SESSION_ONLY] as const;
type DescriptorField = (typeof DESCRIPTOR_FIELDS)[number];
/** W28 (2026-10-06): "Optional field `stage` on EVERY descriptor shape, the waiting one included" — so it is optional
 *  in every row, never a column of its own. */
const descriptorRow = (cred: Cell, endReason: Cell, session: Cell): Record<DescriptorField, Cell> => ({
  cred, endReason, stage: OPT, ...(Object.fromEntries(SESSION_ONLY.map((f) => [f, session])) as Record<(typeof SESSION_ONLY)[number], Cell>),
});
const DESCRIPTOR_MATRIX: Record<string, Record<DescriptorField, Cell>> = {
  waiting: descriptorRow(NO, NO, NO),
  warming: descriptorRow(OPT, NO, REQ),
  live: descriptorRow(OPT, NO, REQ),
  ending: descriptorRow(OPT, REQ, REQ),
  completed: descriptorRow(NO, REQ, REQ),
  failed: descriptorRow(NO, REQ, REQ),
};

/** §6.8.4 / plan Global Constraints: the wire end reasons. */
const WIRE_END_REASONS = ["stopped", "auto_stopped", "no_inbound_timeout", "target_rejected", "max_duration", "phone_lost", "failed"];
/** §6.1: "12 characters of lowercase Crockford base32" — Crockford's alphabet drops i, l, o and u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** §6.3.2's body, word for word: the beat request's closed vocabularies (the `| null` is the field's, not a value). */
const SPEC_BEAT = {
  claim: ["new", "resume"],
  state: ["paired", "arming", "armed", "connecting", "publishing", "degraded", "reconnecting", "ended"],
  cause: ["organiser", "automatic", "operator", "rejoin"],
  notReady: ["camera", "sound", "network", "held"],
  startFailed: ["not-found", "cred-host", "config", "start-error"],
  mode: ["automatic", "operator"],
  transport: ["srt", "rtmps"],
  delivery: ["ok", "stalled", "unknown"],
  endReason: ["operator-stopped"],
};
/** §6.3.3 / §6.3.4: `startedBy?: "organiser" | "automatic" | "operator"`, on go-live and on 409 already_live. */
const SPEC_STARTED_BY = ["organiser", "automatic", "operator"];
/** §6.3.3's answer `state`. */
const SPEC_ANSWER_STATES = ["waiting", "go-live", "live", "over", "replaced", "taken"];
/** §6.3.1's descriptor: `state` across the waiting and session shapes, `preferred`, `scoreUpdates`. */
const SPEC_DESCRIPTOR = {
  state: ["waiting", "warming", "live", "ending", "completed", "failed"],
  preferred: ["srt", "rtmps"],
  scoreUpdates: ["realtime", "polled"],
};
/** §6.3.1 and §6.3.4 name eight refusal words with their statuses. The bare `422` and `429` got their words in the T1
 *  brief (`invalid`, `rate_limited`): coined there, so the OG1 hand-off note asks capture to confirm them (review G-2).
 *  `503` is ALWAYS `unavailable` — a cause such as an unexpected ingest host goes in `message` or the log, never in
 *  `code` (review G-1). */
const SPEC_REFUSALS: Record<string, number> = {
  already_live: 409, replaced: 409, no_destination: 409, no_credit: 402, not_entitled: 403, unavailable: 503,
  code_ended: 401, not_a_stream_code: 404, invalid: 422, rate_limited: 429,
};
/** W27 (§6.3.5, the 2026-10-06 brief's own table): the refusals `POST …/scoring-link` answers, with their statuses.
 *  `not_entitled` is 402 here (a plan gate) where the start answers 403 — the agreed contract, not a typo. */
const SPEC_SCORING_LINK_REFUSALS: Record<string, number> = {
  code_ended: 401, not_a_stream_code: 404, replaced: 409, match_finished: 409, not_entitled: 402, unavailable: 503,
  invalid: 422, rate_limited: 429,
};
/** Every refusal word on the capture wire: the start's ten and W27's `match_finished`. */
const SPEC_REFUSAL_CODES = [...new Set([...Object.keys(SPEC_REFUSALS), ...Object.keys(SPEC_SCORING_LINK_REFUSALS)])];
/** W27: "The URL must match `^https://[^/]+/score/dl_[A-Za-z0-9_-]{43}$`" — the brief's text. */
const SPEC_SCORING_LINK_URL = "^https://[^/]+/score/dl_[A-Za-z0-9_-]{43}$";
/** W28: `role.kind` is the engine's `RoundRole["kind"]`. Typed against the engine's own declaration: a kind the engine
 *  adds or drops fails typecheck here until this list moves, and the test then demands the published prose lists it. */
const ROLE_KINDS: Record<RoundRole["kind"], true> = {
  round_of: true, quarter_final: true, semi_final: true, final: true, winners_final: true, losers_round: true,
  losers_final: true, grand_final: true, grand_final_reset: true, third_place: true, qualifier1: true, eliminator: true,
  qualifier2: true, rung: true, plain_round: true,
};
/** §6.3.1's statuses for GET codes/{code}: 401, 404, 422, 429, 503 — never 409, 402, 403 (no start runs there). */
const SPEC_DESCRIPTOR_REFUSALS = ["code_ended", "not_a_stream_code", "invalid", "rate_limited", "unavailable"];

/** D16 (capture's field-by-field check, 2026-10-01): cross-field rules the server enforces in the twin. A refine is not
 *  exported to JSON Schema, so ajv ADMITS each of these fixtures; only the twin refuses them (a 422). Each names its
 *  valid sibling, from which it differs in `field` alone. Controller ruling 2026-10-01: the published contract STATES
 *  every rule the server enforces (one source of truth), so `stated` lists, per rule, the field descriptions that must
 *  carry it — the vendoring repo reads the rule there, and a rule whose prose is dropped fails the run. */
type Stated = [field: string, text: string];
const ZOD_ONLY: Record<string, { sibling: string; field: string; file: string; twin: Twin; stated: Stated[] }> = {
  "capture-beat.v1/beat-invalid-cause-without-sid": { sibling: "beat-valid", field: "cause", file: "capture-beat.v1.json", twin: S.CaptureBeat,
    stated: [["cause", "only while sid is non-null"]] },
  "capture-beat.v1/beat-invalid-endReason-not-ended": { sibling: "beat-valid-publishing", field: "endReason", file: "capture-beat.v1.json", twin: S.CaptureBeat,
    stated: [["endReason", "only with state \"ended\""]] },
  "capture-beat.v1/beat-invalid-stopped-with-sid": { sibling: "beat-valid-publishing", field: "stopped", file: "capture-beat.v1.json", twin: S.CaptureBeat,
    stated: [["stopped", "only while sid is null"]] },
  "capture-beat.v1/beat-invalid-claim-with-rejoin": { sibling: "beat-valid-resume", field: "cause", file: "capture-beat.v1.json", twin: S.CaptureBeat,
    stated: [["cause", "never \"rejoin\" on a claim beat"], ["claim", "never together with cause \"rejoin\""]] },
  "capture-descriptor.v1/invalid-srt-null-preferred-srt": { sibling: "valid-live-srt-null", field: "preferred", file: "capture-descriptor.v1.json", twin: S.CaptureDescriptor,
    stated: [["preferred", "\"rtmps\" whenever cred.srt is null"]] },
};

// ---------------------------------------------------------------------------------------------------------------
// Structural helpers.
// ---------------------------------------------------------------------------------------------------------------
const PROSE = new Set(["$schema", "$id", "title", "description"]);
/** `RegExp.prototype.source` writes every `/` as `\/` (so the source can sit between slashes), and zod's
 *  `toJSONSchema` publishes the source. In an ECMA-262 pattern `\/` and `/` are the same character, so a `pattern`
 *  is compared with that escape undone on both sides — only an UNescaped backslash's `\/` (an even run before it). */
const unescapeSlashes = (pattern: string): string => pattern.replace(/(?<!\\)((?:\\\\)*)\\\//g, "$1/");
/** Drops the prose keys at every level (never a property NAMED like one), sorts `required` and `enum`. */
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (node === null || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (PROSE.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, normalise(s)]));
    else if ((k === "required" || k === "enum") && Array.isArray(v)) out[k] = [...(v as string[])].sort();
    else if (k === "pattern" && typeof v === "string") out[k] = unescapeSlashes(v);
    else out[k] = normalise(v);
  }
  return out;
}
/** Both directions of the twin. Output mode writes `additionalProperties: false` for a STRIPPING z.object as well as a
 *  strict one, so on its own it cannot see a branch that silently drops an unknown key (found by mutant M8 in T1);
 *  input mode writes it only for a strict object. The contract must equal both. */
const IO = ["output", "input"] as const;
const zodJson = (twin: Twin, io: (typeof IO)[number]): Json => z.toJSONSchema(twin, { target: "draft-2020-12", io }) as Json;
const rootOf = (file: Json): Json => without(file, "$defs");
const defOf = (file: Json, name: string): Json => (file.$defs as Record<string, Json>)[name]!;
/** A `oneOf` keyed by each branch's `properties.state.const`. */
function branchesByState(node: Json): Record<string, Json> {
  const branches = node.oneOf as Json[];
  expect(Array.isArray(branches), "a oneOf").toBe(true);
  const out: Record<string, Json> = {};
  for (const b of branches) {
    const state = ((b.properties as Record<string, Json>).state as Json).const as string;
    expect(out[state], `two branches for state ${state}`).toBeUndefined();
    out[state] = b;
  }
  return out;
}
/** Every node at a dotted property path, through properties / anyOf / oneOf — the same walk the generator does. */
function nodesAt(node: unknown, path: string[]): Json[] {
  if (node === null || typeof node !== "object") return [];
  const n = node as Json;
  if (path.length === 0) return [n];
  const viaUnions = [...((n.anyOf as Json[]) ?? []), ...((n.oneOf as Json[]) ?? [])].flatMap((b) => nodesAt(b, path));
  const props = n.properties as Json | undefined;
  const next = props?.[path[0]!];
  return [...viaUnions, ...(next === undefined ? [] : nodesAt(next, path.slice(1)))];
}
/** A node's closed values, sorted: its `enum`, its `const`, or its anyOf/oneOf members' — `null` dropped (whether a
 *  field admits null is the optional-versus-null test's question). A node that closes nothing yields []. */
function enumOf(node: Json): string[] {
  const own = node.enum !== undefined ? (node.enum as unknown[]) : node.const !== undefined ? [node.const] : [];
  const members = [...((node.anyOf as Json[] | undefined) ?? []), ...((node.oneOf as Json[] | undefined) ?? [])].flatMap(enumOf);
  return [...own, ...members].filter((v) => v !== null).map(String).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The file → twin map, and the fixture directories' routing.
// ---------------------------------------------------------------------------------------------------------------
const QR = "capture-qr.v2.json", DESCRIPTOR = "capture-descriptor.v1.json", BEAT = "capture-beat.v1.json", START = "capture-start.v1.json";
const SCORING = "capture-scoring-link.v1.json";
// capture-record.v1 — design approved 2026-10-12 (spec 2026-10-12-capture-record-upload-design.md), twinned by the
// implementing PR: the line, the 201, its own refusal (Q2) and the secret-shaped rules S2–S5.
const RECORD = "capture-record.v1.json", RECORD_DIR = "capture-record.v1";
/** The record file's `$defs`, exactly: the two answers and the secret-shaped rules S2–S5 the server runs. */
const RECORD_DEFS = ["ok", "refusal", "secretS2", "secretS3", "secretS4", "secretS5", "secretShaped"];
/** Each file's `$defs`, exactly. */
const DEFS: Record<string, string[]> = {
  [QR]: [], [DESCRIPTOR]: ["refusal"], [BEAT]: ["answer"], [START]: ["ok", "refusal"], [SCORING]: ["ok", "refusal"], [RECORD]: RECORD_DEFS,
};
/** The record's twins, by the shape they mirror: the parity test compares each, and the tripwire holds every
 *  record-named zod export of capture-schemas.ts to exactly this list. `secretShaped` is the union of S2–S5 by `$ref`,
 *  checked structurally (a zod union inlines its members). */
const RECORD_TWINS: [pointer: string, twin: Twin, exportName: string][] = [
  ["", S.CaptureRecordLine, "CaptureRecordLine"],
  ["#/$defs/ok", S.CaptureRecordOk, "CaptureRecordOk"],
  ["#/$defs/refusal", S.CaptureRecordRefusal, "CaptureRecordRefusal"],
  ["#/$defs/secretS2", S.CaptureRecordSecretS2, "CaptureRecordSecretS2"],
  ["#/$defs/secretS3", S.CaptureRecordSecretS3, "CaptureRecordSecretS3"],
  ["#/$defs/secretS4", S.CaptureRecordSecretS4, "CaptureRecordSecretS4"],
  ["#/$defs/secretS5", S.CaptureRecordSecretS5, "CaptureRecordSecretS5"],
];

/** Per directory: its contract file; [file prefix, twin, the shape's pointer in that file], first match wins; and the
 *  exact fixture count (never 0). */
type Route = [prefix: string, twin: Twin, pointer: "" | "#/$defs/refusal" | "#/$defs/answer" | "#/$defs/ok"];
const DIRS: Record<string, { file: string; routes: Route[]; count: number }> = {
  "capture-qr.v2": { file: QR, routes: [["", CaptureQrV2, ""]], count: 12 },
  "capture-descriptor.v1": { file: DESCRIPTOR, routes: [["refusal-", S.CaptureRefusal, "#/$defs/refusal"], ["", S.CaptureDescriptor, ""]], count: 52 },
  "capture-beat.v1": { file: BEAT, routes: [["beat-", S.CaptureBeat, ""], ["answer-", S.CaptureBeatAnswer, "#/$defs/answer"]], count: 40 },
  "capture-start.v1": { file: START, routes: [["request-", S.CaptureStartBody, ""], ["ok-", S.CaptureStartOk, "#/$defs/ok"], ["", S.CaptureRefusal, "#/$defs/refusal"]], count: 18 },
  "capture-scoring-link.v1": { file: SCORING, routes: [["request-", S.CaptureStartBody, ""], ["ok-", S.CaptureScoringLinkOk, "#/$defs/ok"], ["", S.CaptureRefusal, "#/$defs/refusal"]], count: 17 },
  [RECORD_DIR]: { file: RECORD, routes: [["line-", S.CaptureRecordLine, ""], ["ok-", S.CaptureRecordOk, "#/$defs/ok"], ["", S.CaptureRecordRefusal, "#/$defs/refusal"]], count: 63 },
};

// ---------------------------------------------------------------------------------------------------------------
// capture-record.v1's rulebook, typed from the spec and from capture's allow-list.
// ---------------------------------------------------------------------------------------------------------------
/** Per fixture prefix: the shape's pointer and the exact count (never 0). `line-` is ONE NDJSON line (the root). */
const RECORD_ROUTES: [prefix: string, pointer: "" | "#/$defs/ok" | "#/$defs/refusal", count: number][] = [
  ["line-", "", 49], ["ok-", "#/$defs/ok", 6], ["", "#/$defs/refusal", 8],
];
/** Capture's `modules/capture-engine/src/scrub/allow-list.json` at capture 2b4df80 (ebac190's lists plus the seven
 *  scalars its reasons tag R-990P), list for list: the rulebook the record's keys come from, typed here and never read
 *  off the contract. A key added on capture's side is a contract bump here (the spec's §Body). */
const ALLOW_LIST = {
  reserved: ["at", "kind", "level"],
  plain: ["action", "answer", "appVersion", "attempt", "cause", "claim", "count", "delivery", "endReason", "error", "exit",
    "failure", "field", "from", "host", "intent", "key", "kind", "lastEnd", "lock", "mode", "ms", "notReady", "op", "phase",
    "pickSource", "problem", "reason", "refusal", "result", "retryAfterS", "rootError", "route", "scene", "shed", "side",
    "sid", "site", "slot", "source", "startFailed", "state", "status", "tag", "to", "tokenTag", "transport", "word"],
  publicUrl: ["url", "playbackUrl", "overlayUrl"],
  text: ["message", "problems"],
  never: ["tok", "token", "code", "passphrase", "streamKey", "streamId", "bearer", "authorization"],
  scalars: ["audioFps", "bandwidthBps", "bytes", "camera", "counted", "dropped", "egressBps", "encodeListed", "exitAtMs",
    "failed", "failures", "gapMs", "gateBps", "granted", "headroom", "held", "intervalMs", "lagGrowthMs", "lagMs", "late",
    "listed", "lost", "minuteEpochMs", "msSinceAdvance", "ok", "on", "outageMs", "pickAspect16x9", "pickHeight", "pickWidth",
    "publishedMs", "rebaselined", "rebuilds", "refusedSid", "retryMs", "sameArea", "sendBufferMs", "sent", "sinceLastMs",
    "sound", "srtOffered", "stalledMs", "stopped", "suppressed", "target", "validated", "videoFps", "wasLive"],
};
/** The seven scalars capture 2b4df80's allow-list tags R-990P (owner-approved 2026-10-26), each with the class its
 *  reason states: all seven are the generic scalar class — a number, a boolean or null, nothing narrower — so
 *  `sendBufferMs` may be negative (−336 has been seen on a real SRT link) and none is in NARROWED_SCALARS. */
const R990P_KEYS = ["bandwidthBps", "dropped", "egressBps", "gateBps", "lost", "sendBufferMs", "target"];
/** The scalars the allow-list's own REASONS narrow (as its reason narrows tokenTag), typed from capture's writers at
 *  ebac190 and the coordinator's relay of the capture team's answer (2026-10-12): `bytes` is `record.send`'s
 *  `TextEncoder` length, `failures` a Kotlin Int count, `retryMs` `Rejoin.delayAfter`'s Long, `pickAspect16x9` a
 *  Kotlin Boolean — none ever null. */
const NARROWED_SCALARS: Record<string, "count" | "boolean"> = { bytes: "count", failures: "count", retryMs: "count", pickAspect16x9: "boolean" };
/** The spec's answer table (§Answers): every refusal POST …/records answers, with its status. Never `replaced` (R4). */
const SPEC_RECORD_REFUSALS: Record<string, number> = {
  code_ended: 401, not_a_stream_code: 404, too_large: 413, invalid: 422, rate_limited: 429, unavailable: 503,
};
/** The secret-shaped rules (spec §5, S1–S5): each `line-secret-*` fixture is a line the file's shape ADMITS and the
 *  server DROPS on one rule (owner ruling RL, 2026-10-12: dropped, never the body refused), which the root description states in these words. S2–S5 are also the file's own
 *  `$defs.secretS<n>`; S1 needs the Bearer, so it is prose only, and its vector assumes this Bearer (the route's test
 *  sends it). */
const RECORD_SENDING_TOK = "fake-tok-0000000000000";
const RECORD_SERVER_ONLY: Record<string, [rule: "S1" | "S2" | "S3" | "S4" | "S5", stated: string]> = {
  "line-secret-sending-tok": ["S1", "S1 the Bearer token that sent the record"],
  "line-secret-ingest-url": ["S2", "S2 an RTMP(S) URL that carries a stream key"],
  "line-secret-srt-streamid": ["S3", "S3 a streamid or passphrase value"],
  "line-secret-streamid-space": ["S3", "S3 a streamid or passphrase value"],
  "line-secret-userinfo": ["S4", "S4 a URL with userinfo"],
  "line-secret-bearer": ["S5", "S5 a Bearer credential"],
};
/** Review fix 1 (PR #943): rules on a line's TEXT, which no JSON Schema can state because a parser has already applied
 *  them — a key named twice (JSON.parse keeps the LAST value, so a first, secret-shaped value would pass a screen of
 *  the parsed object). Each entry: the premise its fixture's raw text must meet, typed here (a count of one key's
 *  occurrences, never the server's own scanner), and the words the root states. */
const RECORD_SERVER_TEXT_RULES: Record<string, [premise: (text: string) => boolean, stated: string]> = {
  "line-server-duplicate-key": [(t) => t.split('"message":').length - 1 === 2, "names any key twice"],
};
/** A fixture's bytes, as the server would read them off the wire. */
const rawFixture = (dir: string, name: string): string => readFileSync(resolve(FIXTURES, dir, `${name}.json`), "utf8");
/** Review fix 1 (2026-10-12): every rule skips the scrub's mask, so capture's OWN scrubbed output is admitted. Each
 *  near miss is a `line-valid-*` line whose `message` carries a credential masked in place (`***`): it trips no rule,
 *  and the same line with the mask replaced by a credential trips exactly the rule named here. The srt one is
 *  capture's vectors.json case 22, output verbatim. */
const RECORD_NEAR_MISS: Record<string, "S2" | "S3" | "S4" | "S5"> = {
  "line-valid-scrubbed-rtmps-key": "S2",
  "line-valid-scrubbed-srt-passphrase": "S3",
  "line-valid-scrubbed-userinfo": "S4",
  "line-valid-scrubbed-bearer": "S5",
  // Re-review fix 1: the mask with punctuation after it, as prose leaves it.
  "line-valid-scrubbed-rtmps-key-period": "S2",
  "line-valid-scrubbed-rtmps-key-comma": "S2",
  "line-valid-scrubbed-rtmps-key-quoted": "S2",
  "line-valid-scrubbed-streamid-paren": "S3",
  // Re-review fix 2: capture's vector 24 output (no `=`, a space, the mask).
  "line-valid-scrubbed-streamid-space": "S3",
};
/** Every name capture-schemas.ts exports at runtime: the 23 before the record, then the record's own (its seven
 *  twins in RECORD_TWINS, its refusal words, its ref pattern and its two limits). */
const CAPTURE_SCHEMAS_EXPORTS = [
  "CAPTURE_CODE_RE", "CAPTURE_POOL_RE", "CAPTURE_SCORING_LINK_URL_RE", "CAPTURE_STAGE_LABEL_MAX", "CaptureBeat",
  "CaptureBeatAnswer", "CaptureCause", "CaptureCred", "CaptureDescriptor", "CaptureEndReason", "CaptureNotReady",
  "CapturePhoneState", "CaptureRefusal", "CaptureRefusalCode", "CaptureScoringLinkOk", "CaptureSession", "CaptureStage",
  "CaptureStageRole", "CaptureStartBody", "CaptureStartFailed", "CaptureStartOk", "CaptureStartedBy", "CaptureWaiting",
  // capture-record.v1 (2026-10-12).
  "CAPTURE_RECORD_MAX_BYTES", "CAPTURE_RECORD_MAX_LINES", "CAPTURE_RECORD_REF_RE", "CaptureRecordLine", "CaptureRecordOk",
  "CaptureRecordRefusal", "CaptureRecordRefusalCode", "CaptureRecordSecretS2", "CaptureRecordSecretS3",
  "CaptureRecordSecretS4", "CaptureRecordSecretS5",
];

/** The published bytes as a validator sees them: ajv 2020-12, strict, formats ASSERTED (uuid, uri, date-time) — the
 *  stricter of the two readings a vendoring repo may take, so a fixture the file admits only with formats off fails. */
function fileValidator(): (file: string, pointer: string, value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of Object.keys(SHA256)) ajv.addSchema(JSON.parse(contractText(file)) as Json);
  return (file, pointer, value) => {
    const validate = ajv.getSchema(`https://seazn.club/contracts/${file}${pointer}`);
    expect(validate, `${file}${pointer}: ajv resolves the shape`).toBeDefined();
    return validate!(value) as boolean;
  };
}

describe("capture contracts (docs/contracts/capture-*.json)", () => {
  it("each of the six contracts is checksummed (the cross-repo drift gate)", () => {
    let checked = 0;
    for (const [file, sha] of Object.entries(SHA256)) {
      expect(createHash("sha256").update(contractText(file)).digest("hex"), file).toBe(sha);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("v1 is gone, and every published capture contract is twinned — the record included since its route landed (W4, §6.13; W27; 2026-10-12)", () => {
    expect(existsSync(resolve(CONTRACTS, "capture-qr.v1.json")), "the v1 contract").toBe(false);
    expect(existsSync(resolve(FIXTURES, "capture-qr.v1")), "the v1 fixtures").toBe(false);
    const files = readdirSync(CONTRACTS).filter((f) => f.startsWith("capture-")).sort();
    expect(files).toEqual(Object.keys(SHA256).sort());
    const dirs = readdirSync(FIXTURES).filter((f) => f.startsWith("capture-")).sort();
    expect(dirs).toEqual(Object.keys(DIRS).sort());
    // Every contract has its fixture directory in DIRS, the record's among them: no contract is left without a twin.
    expect(Object.values(DIRS).map((d) => d.file)).toContain(RECORD);
    expect(Object.keys(SHA256).filter((f) => !Object.values(DIRS).some((d) => d.file === f))).toEqual([]);
    expect(Object.keys(DIRS)).toHaveLength(6);
  });

  it("schemas.ts re-exports every twin by identity, never a re-typed copy", () => {
    const names = Object.keys(CS);
    expect(names.length, "capture-schemas.ts exports nothing").toBeGreaterThan(0);
    let checked = 0;
    for (const name of names) {
      expect((S as Record<string, unknown>)[name], name).toBe((CS as Record<string, unknown>)[name]);
      checked++;
    }
    // The brief's interface list (T1) — the names later tasks import.
    for (const name of ["CAPTURE_CODE_RE", "CaptureEndReason", "CaptureStartedBy", "CaptureCause", "CapturePhoneState",
      "CaptureNotReady", "CaptureStartFailed", "CaptureWaiting", "CaptureSession", "CaptureDescriptor", "CaptureBeat",
      "CaptureBeatAnswer", "CaptureStartBody", "CaptureStartOk", "CaptureRefusal", "CaptureRefusalCode",
      // W27 / W28 (2026-10-06).
      "CaptureScoringLinkOk", "CaptureStage",
      // capture-record.v1 (2026-10-12): the names the records route and its use-case import.
      "CaptureRecordLine", "CaptureRecordOk", "CaptureRecordRefusal", "CaptureRecordRefusalCode",
      "CAPTURE_RECORD_MAX_LINES", "CAPTURE_RECORD_MAX_BYTES"]) {
      expect(names, name).toContain(name);
    }
    expect(checked).toBe(names.length);
  });

  it("parity: each file (and each $def) equals z.toJSONSchema of its twin, as output AND as input, unions compared branch by branch on `state`", () => {
    const qr = contract(QR), desc = contract(DESCRIPTOR), beat = contract(BEAT), start = contract(START), scoring = contract(SCORING);
    const record = contract(RECORD);
    let defsChecked = 0;
    for (const [file, json] of [[QR, qr], [DESCRIPTOR, desc], [BEAT, beat], [START, start], [SCORING, scoring], [RECORD, record]] as const) {
      expect(Object.keys((json.$defs as Json | undefined) ?? {}).sort(), `${file} $defs`).toEqual([...DEFS[file]!].sort());
      expect(json.$id, `${file} $id`).toBe(`https://seazn.club/contracts/${file}`);
      expect(json.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      defsChecked++;
    }
    expect(defsChecked).toBe(6);

    const whole: [string, Json, Twin][] = [
      [QR, rootOf(qr), CaptureQrV2],
      [`${DESCRIPTOR}#/$defs/refusal`, defOf(desc, "refusal"), S.CaptureRefusal],
      [BEAT, rootOf(beat), S.CaptureBeat],
      [START, rootOf(start), S.CaptureStartBody],
      [`${START}#/$defs/ok`, defOf(start, "ok"), S.CaptureStartOk],
      [`${START}#/$defs/refusal`, defOf(start, "refusal"), S.CaptureRefusal],
      [SCORING, rootOf(scoring), S.CaptureStartBody],
      [`${SCORING}#/$defs/ok`, defOf(scoring, "ok"), S.CaptureScoringLinkOk],
      [`${SCORING}#/$defs/refusal`, defOf(scoring, "refusal"), S.CaptureRefusal],
      // capture-record.v1: the line (the root), the 201, its own refusal and the four secret-shaped rules.
      ...RECORD_TWINS.map(([pointer, twin]): [string, Json, Twin] =>
        [`${RECORD}${pointer}`, pointer === "" ? rootOf(record) : defOf(record, pointer.slice("#/$defs/".length)), twin]),
    ];
    let wholeChecked = 0;
    for (const io of IO) {
      for (const [name, file, twin] of whole) {
        expect(normalise(file), `${name} (${io})`).toEqual(normalise(zodJson(twin, io)));
        wholeChecked++;
      }
    }
    expect(RECORD_TWINS).toHaveLength(7);
    expect(wholeChecked).toBe((9 + 7) * 2);
    // secretShaped is the union of S2–S5 by $ref, each once, in order — so "secret-shaped" is exactly the four twins.
    const shaped = defOf(record, "secretShaped");
    expect(shaped.type).toBe("string");
    expect(shaped.anyOf).toEqual(["secretS2", "secretS3", "secretS4", "secretS5"].map((d) => ({ $ref: `#/$defs/${d}` })));
    // The slash unescape is the only liberty the normaliser takes with a pattern, and it is sound: each record pattern
    // with a `/` in it compiles to the same RegExp source either way.
    let slashed = 0;
    for (const [pointer, twin] of RECORD_TWINS.filter(([p]) => p.startsWith("#/$defs/secret"))) {
      const filePattern = defOf(record, pointer.slice("#/$defs/".length)).pattern as string;
      expect(new RegExp(filePattern).source, pointer).toBe((zodJson(twin, "output").pattern as string));
      if (filePattern.includes("/")) slashed++;
    }
    // S2 and S4 in their `://`, S3 and S5 in their token class `[…+/=-]`.
    expect(slashed, "every secret rule carries a `/`").toBe(4);

    const unions: [string, Json, Twin, string[]][] = [
      [DESCRIPTOR, rootOf(desc), S.CaptureDescriptor, Object.keys(DESCRIPTOR_MATRIX)],
      [`${BEAT}#/$defs/answer`, defOf(beat, "answer"), S.CaptureBeatAnswer, Object.keys(ANSWER_MATRIX)],
    ];
    for (const io of IO) {
      for (const [name, file, twin, states] of unions) {
        const zod = zodJson(twin, io);
        // Everything beside the branches agrees too (nothing but prose, which the normaliser drops).
        expect(normalise(without(file, "oneOf")), `${name} (${io}): beside oneOf`).toEqual(normalise(without(zod, "oneOf")));
        const fileBranches = branchesByState(file), zodBranches = branchesByState(zod);
        expect(Object.keys(fileBranches).sort(), `${name}: the file's states`).toEqual([...states].sort());
        expect(Object.keys(zodBranches).sort(), `${name} (${io}): the twin's states`).toEqual([...states].sort());
        let branches = 0;
        for (const state of states) {
          expect(normalise(fileBranches[state]), `${name} [${state}] (${io})`).toEqual(normalise(zodBranches[state]));
          branches++;
        }
        expect(branches, `${name} (${io}): branches compared`).toBe(6);
      }
    }
  });

  it("fixtures: every valid* is admitted, every invalid-* / tampered* / wrong-version is refused — by the twin AND by the published file under ajv, counted per directory", () => {
    const fileAdmits = fileValidator();
    let total = 0, byFile = 0, zodOnlySeen = 0;
    for (const [dir, { file, routes, count }] of Object.entries(DIRS)) {
      const names = readdirSync(resolve(FIXTURES, dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
      let checked = 0;
      for (const name of names) {
        const route = routes.find(([prefix]) => name.startsWith(prefix));
        expect(route, `${dir}/${name}: no twin routes this fixture`).toBeDefined();
        const [prefix, twin, pointer] = route!;
        const kind = name.slice(prefix.length);
        const value = fixture(dir, name);
        let admitted: boolean;
        if (/^valid(-.+)?$/.test(kind)) admitted = true;
        else if (/^(invalid-.+|tampered(-.+)?|wrong-version)$/.test(kind)) admitted = false;
        // A record `line-secret-*` vector: the line shape (twin AND file) admits it; only the server's S1–S5 refuse it,
        // which the record's own tests below prove rule by rule.
        else if (dir === RECORD_DIR && prefix === "line-" && /^secret-.+$/.test(kind)) admitted = true;
        // A record `line-server-*` fixture: its PARSED value is a good line (both shapes admit it); the server reads the
        // line's TEXT and drops it on a rule no schema can state (review fix 1: a key named twice).
        else if (dir === RECORD_DIR && prefix === "line-" && /^server-.+$/.test(kind)) admitted = true;
        else expect.fail(`${dir}/${name}: neither valid* nor invalid-*/tampered*/wrong-version`);
        expect(parses(twin, value), `${dir}/${name}: the twin ${admitted ? "admits" : "refuses"} it`).toBe(admitted);
        // A ZOD_ONLY fixture breaks a rule the file states in prose only: ajv ADMITS it, and only the twin refuses it.
        const zodOnly = `${dir}/${name}` in ZOD_ONLY;
        if (zodOnly) {
          expect(admitted, `${dir}/${name}: a ZOD_ONLY fixture is a refusal`).toBe(false);
          zodOnlySeen++;
        }
        const fileVerdict = zodOnly ? true : admitted;
        expect(fileAdmits(file, pointer, value), `${dir}/${name}: ${file}${pointer} ${fileVerdict ? "admits" : "refuses"} it`).toBe(fileVerdict);
        byFile++;
        checked++;
      }
      expect(checked, `${dir}: fixtures checked`).toBeGreaterThan(0);
      expect(checked, `${dir}: fixtures checked`).toBe(count);
      total += checked;
    }
    expect(total).toBe(12 + 52 + 40 + 18 + 17 + 63);
    expect(byFile, "fixtures checked against the published bytes").toBe(total);
    // Every ZOD_ONLY entry names a fixture that exists and was swept (a stale entry would excuse nothing, silently).
    expect(zodOnlySeen, "ZOD_ONLY fixtures swept").toBe(Object.keys(ZOD_ONLY).length);
    expect(zodOnlySeen).toBe(5);
  });

  it("D16 cross-field rules (zod-only): each ZOD_ONLY fixture differs from a valid sibling in ONE field, and the twin refuses it on that field alone; the file STATES each rule in its field prose", () => {
    const fileAdmits = fileValidator();
    let checked = 0;
    let statements = 0;
    for (const [key, { sibling, field, file, twin, stated }] of Object.entries(ZOD_ONLY)) {
      const [dir, name] = key.split("/") as [string, string];
      const bad = fixture(dir, name), good = fixture(dir, sibling);
      const differing = [...new Set([...Object.keys(bad), ...Object.keys(good)])].filter((k) => JSON.stringify(bad[k]) !== JSON.stringify(good[k]));
      expect(differing, `${key}: premise — differs from ${sibling} in ${field} alone`).toEqual([field]);
      expect(parses(twin, good), `${key}: premise — ${sibling} parses`).toBe(true);
      expect(fileAdmits(file, "", good), `${key}: premise — the file admits ${sibling}`).toBe(true);
      const result = twin.safeParse(bad);
      expect(result.success, `${key}: the twin refuses it`).toBe(false);
      // Exactly one issue, raised on the rule's own field: the refusal is the refine, not some other guard.
      expect(result.error?.issues.map((i) => i.path.join(".")), key).toEqual([field]);
      expect(fileAdmits(file, "", bad), `${key}: the file states this rule in prose only, so ajv admits it`).toBe(true);
      // One source of truth: the rule is written where the vendoring repo reads the field (every node of it).
      for (const [prop, text] of stated) {
        const nodes = nodesAt(rootOf(contract(file)), [prop]);
        expect(nodes.length, `${key}: ${file} has ${prop}`).toBeGreaterThan(0);
        for (const node of nodes) expect(node.description, `${key}: ${file} ${prop} states the rule`).toContain(text);
        statements += nodes.length;
      }
      checked++;
    }
    expect(checked).toBe(5);
    // beat cause 1 + endReason 1 + stopped 1 + (cause 1 + claim 1) + the descriptor's preferred on 5 session states.
    expect(statements).toBe(10);
    // CaptureSession (the session-only union later tasks import) carries the same A18 rule as the descriptor.
    const srtNull = fixture("capture-descriptor.v1", "valid-live-srt-null");
    expect(parses(S.CaptureSession, srtNull), "session: srt null with rtmps").toBe(true);
    expect(S.CaptureSession.safeParse(fixture("capture-descriptor.v1", "invalid-srt-null-preferred-srt")).error?.issues.map((i) => i.path.join(".")), "session: srt null with srt").toEqual(["preferred"]);
  });

  it("enums: every closed vocabulary in the files and the twins is the spec's literal list (§6.3.1–§6.3.4)", () => {
    const beat = rootOf(contract(BEAT)), answer = defOf(contract(BEAT), "answer"), desc = rootOf(contract(DESCRIPTOR));
    // [what, the file's shape, the twin, property, the spec's list, nodes expected, union the nodes' values?]
    const owed: [string, Json, Twin, string, string[], number, boolean][] = [
      ...Object.entries(SPEC_BEAT).map(([prop, list]): [string, Json, Twin, string, string[], number, boolean] =>
        [`beat ${prop}`, beat, S.CaptureBeat, prop, list, 1, false]),
      ["answer state", answer, S.CaptureBeatAnswer, "state", SPEC_ANSWER_STATES, 6, true],
      ["answer startedBy (go-live only)", answer, S.CaptureBeatAnswer, "startedBy", SPEC_STARTED_BY, 1, false],
      ["descriptor state", desc, S.CaptureDescriptor, "state", SPEC_DESCRIPTOR.state, 6, true],
      ["descriptor preferred (5 session states)", desc, S.CaptureDescriptor, "preferred", SPEC_DESCRIPTOR.preferred, 5, false],
      ["descriptor scoreUpdates (5 session states)", desc, S.CaptureDescriptor, "scoreUpdates", SPEC_DESCRIPTOR.scoreUpdates, 5, false],
      ...[START, DESCRIPTOR, SCORING].flatMap((file): [string, Json, Twin, string, string[], number, boolean][] => [
        [`${file} refusal code`, defOf(contract(file), "refusal"), S.CaptureRefusal, "code", SPEC_REFUSAL_CODES, 2, true],
        [`${file} refusal startedBy (already_live only)`, defOf(contract(file), "refusal"), S.CaptureRefusal, "startedBy", SPEC_STARTED_BY, 1, false],
      ]),
    ];
    let nodes = 0;
    for (const [what, fileShape, twin, prop, list, expectedNodes, union] of owed) {
      for (const [side, shape] of [["file", fileShape], ["twin", zodJson(twin, "output")]] as const) {
        const found = nodesAt(shape, [prop]).map(enumOf);
        expect(found, `${what} (${side}): nodes`).toHaveLength(expectedNodes);
        if (union) expect([...new Set(found.flat())].sort(), `${what} (${side})`).toEqual([...list].sort());
        else for (const values of found) expect(values, `${what} (${side})`).toEqual([...list].sort());
        nodes += found.length;
      }
    }
    // 9 beat + answer 6 + 1 + descriptor 6 + 5 + 5 + refusal (2 + 1) × 3 files = 41 nodes, each on the file and the twin.
    expect(nodes).toBe(41 * 2);
    // The exported enum twins later tasks import, by their own options.
    const exported: [string, z.ZodEnum, string[]][] = [
      ["CapturePhoneState", CS.CapturePhoneState, SPEC_BEAT.state], ["CaptureCause", CS.CaptureCause, SPEC_BEAT.cause],
      ["CaptureNotReady", CS.CaptureNotReady, SPEC_BEAT.notReady], ["CaptureStartFailed", CS.CaptureStartFailed, SPEC_BEAT.startFailed],
      ["CaptureStartedBy", CS.CaptureStartedBy, SPEC_STARTED_BY], ["CaptureRefusalCode", CS.CaptureRefusalCode, SPEC_REFUSAL_CODES],
    ];
    for (const [name, twin, list] of exported) expect([...twin.options].sort(), name).toEqual([...list].sort());
    expect(exported).toHaveLength(6);
  });

  it("M-3: a takeover (resume), a stop, and both pre-flight failures each have a valid beat request", () => {
    const shapes: [name: string, premise: (b: Json) => boolean][] = [
      // G0-d at Arming: the GET answered the session shape with no cred ("open, not current"), so the phone claims
      // `resume` naming the open sid it resumes. A claim rides only until the pairing's first 2xx, so never with a
      // rejoin (which follows a 2xx `live`), and the phone is not yet publishing.
      ["beat-valid-resume", (b) => b.claim === "resume" && typeof b.sid === "string" && b.state === "arming" && b.cause === null && b.transport === null],
      ["beat-valid-stopped", (b) => b.sid === null && typeof b.stopped === "string"],
      // A pre-flight failure holds no broadcast (no sid), so it carries no `cause` (D12/D13: cause rides only with a sid).
      ["beat-valid-not-ready", (b) => SPEC_BEAT.notReady.includes(b.notReady as string) && b.state === "paired" && b.sid === null && b.cause === null],
      ["beat-valid-start-failed", (b) => SPEC_BEAT.startFailed.includes(b.startFailed as string) && b.state === "paired" && b.sid === null && b.cause === null],
    ];
    const fileAdmits = fileValidator();
    let checked = 0;
    for (const [name, premise] of shapes) {
      const b = fixture("capture-beat.v1", name);
      expect(premise(b), `${name}: premise`).toBe(true);
      expect(parses(S.CaptureBeat, b), name).toBe(true);
      expect(fileAdmits(BEAT, "", b), name).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
    // …and between them and the rest, `transport: "rtmps"` and `claim: "resume"` are shown at least once.
    const all = readdirSync(resolve(FIXTURES, "capture-beat.v1")).filter((f) => /^beat-valid.*\.json$/.test(f)).map((f) => fixture("capture-beat.v1", f.slice(0, -5)));
    expect(all.some((b) => b.transport === "rtmps"), "a valid beat on rtmps").toBe(true);
    expect(all.some((b) => b.claim === "resume"), "a valid resume claim").toBe(true);
  });

  it("R5/A21 beat answer: each state admits only its own fields — 6 states × 10 fields against the twin AND the file", () => {
    const states = Object.keys(ANSWER_MATRIX);
    const valid = Object.fromEntries(states.map((s) => [s, fixture("capture-beat.v1", `answer-valid-${s}`)]));
    const donors = [...Object.values(valid), fixture("capture-beat.v1", "answer-valid-replaced-device")];
    const twinCells = sweepTwin(ANSWER_MATRIX, ANSWER_FIELDS, valid, donors, S.CaptureBeatAnswer);
    expect(twinCells).toBe(60);
    const fileCells = sweepFile(ANSWER_MATRIX, ANSWER_FIELDS, branchesByState(defOf(contract(BEAT), "answer")));
    expect(fileCells).toBe(60);
  });

  it("R5/A21 descriptor: each state admits only its own fields — 6 states × 10 fields (W28's stage included) against the twin AND the file", () => {
    const states = Object.keys(DESCRIPTOR_MATRIX);
    const valid = Object.fromEntries(states.map((s) => [s, fixture("capture-descriptor.v1", `valid-${s}`)]));
    // W28: the stage donors — the plain valid-<state> fixtures carry no stage (it is optional), these do.
    const donors = [...Object.values(valid), fixture("capture-descriptor.v1", "valid-waiting-stage"), fixture("capture-descriptor.v1", "valid-live-stage")];
    const twinCells = sweepTwin(DESCRIPTOR_MATRIX, DESCRIPTOR_FIELDS, valid, donors, S.CaptureDescriptor);
    expect(twinCells).toBe(60);
    const fileCells = sweepFile(DESCRIPTOR_MATRIX, DESCRIPTOR_FIELDS, branchesByState(rootOf(contract(DESCRIPTOR))));
    expect(fileCells).toBe(60);
  });

  it("optional is not nullable: each optional-and-not-`| null` field set to null is refused, and the same fixture without it parses", () => {
    const owed: [dir: string, name: string, field: string, twin: Twin][] = [];
    // §4 / §6.3.1: `scheduledStart?` on the waiting and session shapes.
    for (const state of Object.keys(DESCRIPTOR_MATRIX)) owed.push(["capture-descriptor.v1", `invalid-null-${state}-scheduledStart`, "scheduledStart", S.CaptureDescriptor]);
    for (const [state, row] of Object.entries(DESCRIPTOR_MATRIX)) {
      for (const [field, cell] of Object.entries(row)) if (cell === OPT) owed.push(["capture-descriptor.v1", `invalid-null-${state}-${field}`, field, S.CaptureDescriptor]);
    }
    for (const [state, row] of Object.entries(ANSWER_MATRIX)) {
      for (const [field, cell] of Object.entries(row)) {
        if (cell === OPT && !COMMON_NULLABLE.has(field)) owed.push(["capture-beat.v1", `answer-invalid-null-${state}-${field}`, field, S.CaptureBeatAnswer]);
      }
    }
    let checked = 0;
    for (const [dir, name, field, twin] of owed) {
      const f = fixture(dir, name);
      expect(f[field], `${name}: premise — the field is null`).toBeNull();
      expect(parses(twin, f), `${name}: null must be refused`).toBe(false);
      expect(parses(twin, without(f, field)), `${name}: the same fixture without ${field} parses`).toBe(true);
      checked++;
    }
    // 6 scheduledStart + 3 cred + 6 stage (W28) (descriptor) + 2 × {device, label, autoAllowed, pollSeconds} (answer).
    expect(checked).toBe(23);
    // …and the `| null` common fields on replaced and taken DO admit null (the twin of the refusals above).
    let nullable = 0;
    for (const state of ["replaced", "taken"]) {
      const base = fixture("capture-beat.v1", `answer-valid-${state}`);
      for (const field of COMMON_NULLABLE) {
        expect(parses(S.CaptureBeatAnswer, { ...base, [field]: null }), `${state}.${field}: null`).toBe(true);
        nullable++;
      }
    }
    expect(nullable).toBe(6);
  });

  it("R5 `at`: an offset parses, a value with no zone is refused, and the phone's own beat carries Z", () => {
    const offset = fixture("capture-beat.v1", "beat-valid-at-offset");
    expect(offset.at).toBe("2026-10-01T15:30:00+05:30");
    expect(parses(S.CaptureBeat, offset)).toBe(true);
    const local = fixture("capture-beat.v1", "beat-invalid-at-local");
    expect(local.at).toBe("2026-10-01T10:00:00");
    expect(parses(S.CaptureBeat, local)).toBe(false);
    // The pair differs ONLY in `at`: so `at` is what the refusal is about.
    expect(without(local, "at")).toEqual(without(offset, "at"));
    const beat = fixture("capture-beat.v1", "beat-valid");
    expect(String(beat.at)).toMatch(/Z$/);
    expect(parses(S.CaptureBeat, beat)).toBe(true);
    // RFC 3339 `date-time` (the file's `format`) requires seconds: a minute-only value is refused by the twin AND by
    // the file with formats asserted. Before this pin zod admitted it while the vendored file refused it.
    const fileAdmits = fileValidator();
    const noSeconds = fixture("capture-beat.v1", "beat-invalid-at-no-seconds");
    expect(noSeconds.at).toBe("2026-10-01T13:40Z");
    expect(without(noSeconds, "at"), "premise: differs from beat-valid in `at` alone").toEqual(without(beat, "at"));
    expect(parses(S.CaptureBeat, noSeconds), "the twin refuses a minute-only at").toBe(false);
    expect(fileAdmits(BEAT, "", noSeconds), "the file refuses a minute-only at").toBe(false);
    // D11, capture's own probe value, on zod 4.4.3.
    expect(parses(S.CaptureBeat, { ...beat, at: "2026-10-01T12:34Z" }), "twin: 12:34Z").toBe(false);
    expect(fileAdmits(BEAT, "", { ...beat, at: "2026-10-01T12:34Z" }), "file: 12:34Z").toBe(false);
    // …while fractional seconds stay ADMITTED on both sides (RFC 3339 time-secfrac is optional, any length): the
    // vendored millisecond fixtures, with Z and with an offset, each differ from beat-valid in `at` alone.
    let fractions = 0;
    const millis: [name: string, at: string][] = [
      ["beat-valid-at-millis-z", "2026-10-01T13:40:00.123Z"], ["beat-valid-at-millis-offset", "2026-10-01T14:40:00.123+01:00"],
    ];
    for (const [name, at] of millis) {
      const f = fixture("capture-beat.v1", name);
      expect(f.at, `${name}: premise`).toBe(at);
      expect(without(f, "at"), `${name}: premise — only at differs`).toEqual(without(beat, "at"));
      expect(parses(S.CaptureBeat, f), `twin: ${name}`).toBe(true);
      expect(fileAdmits(BEAT, "", f), `file: ${name}`).toBe(true);
      fractions++;
    }
    expect(fractions).toBe(2);
    let admitted = 0;
    for (const at of ["2026-10-01T13:40:00Z", "2026-10-01T13:40:00.5Z", "2026-10-01T13:40:00.123456789Z", "2026-10-01T15:30:00+05:30"]) {
      expect(parses(S.CaptureBeat, { ...beat, at }), `twin: ${at}`).toBe(true);
      expect(fileAdmits(BEAT, "", { ...beat, at }), `file: ${at}`).toBe(true);
      admitted++;
    }
    expect(admitted).toBe(4);
  });

  it("strictness survives .extend()/.partial(): each answer branch refuses its one extra key, and parses without it", () => {
    let checked = 0;
    for (const state of Object.keys(ANSWER_MATRIX)) {
      const tampered = fixture("capture-beat.v1", `answer-tampered-${state}`);
      const valid = fixture("capture-beat.v1", `answer-valid-${state}`);
      const extra = Object.keys(tampered).filter((k) => !(k in valid));
      expect(extra, `${state}: exactly one extra key`).toHaveLength(1);
      expect(tampered.state).toBe(state);
      expect(parses(S.CaptureBeatAnswer, tampered), `${state}: the extra key must be refused`).toBe(false);
      expect(parses(S.CaptureBeatAnswer, without(tampered, extra[0]!)), `${state}: without it`).toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("A18: cred.srt null with preferred rtmps parses (the RTMPS-only safety net)", () => {
    const f = fixture("capture-descriptor.v1", "valid-live-srt-null");
    expect((f.cred as Json).srt).toBeNull();
    expect(f.preferred).toBe("rtmps");
    expect(parses(S.CaptureDescriptor, f)).toBe(true);
    // …and cred absent altogether is the "claim first" shape (G0-d), a different thing.
    const noCred = fixture("capture-descriptor.v1", "valid-live-no-cred");
    expect("cred" in noCred).toBe(false);
    expect(parses(S.CaptureDescriptor, noCred)).toBe(true);
  });

  it("W26 hosts (supersedes W15 and W21's RTMPS half): both credentials on Cloudflare's own live.cloudflare.com, in every fixture and in the file's prose — no custom ingest host anywhere", () => {
    // W26, verbatim: "Both credentials use Cloudflare's own host, exactly as Cloudflare issues them:
    // `rtmps://live.cloudflare.com:443/live/` and `srt://live.cloudflare.com:778`, in every environment."
    const W26 = { srt: "srt://live.cloudflare.com:778", rtmps: "rtmps://live.cloudflare.com:443/live/" };
    // W15 / W21's custom hosts, which W26 retired: "no longer served to phones".
    const RETIRED = /live\.(stg\.)?seazn\.club/;
    const cred = fixture("capture-descriptor.v1", "valid-live").cred as { srt: Json; rtmps: Json };
    expect(cred.srt.url).toBe(W26.srt);
    expect(cred.rtmps.url).toBe(W26.rtmps);
    // Every cred in every hand-written fixture, whatever the fixture is for: its URLs are W26's, exactly.
    const creds = (node: unknown): Json[] => {
      if (Array.isArray(node)) return node.flatMap(creds);
      if (node === null || typeof node !== "object") return [];
      const o = node as Json;
      const here = o.cred !== null && typeof o.cred === "object" ? [o.cred as Json] : [];
      return [...here, ...Object.values(o).flatMap(creds)];
    };
    let files = 0, srtSeen = 0, rtmpsSeen = 0;
    for (const dir of Object.keys(DIRS)) {
      for (const f of readdirSync(resolve(FIXTURES, dir)).filter((n) => n.endsWith(".json"))) {
        const text = readFileSync(resolve(FIXTURES, dir, f), "utf8");
        expect(text, `${dir}/${f}: a retired custom ingest host`).not.toMatch(RETIRED);
        files++;
        for (const c of creds(JSON.parse(text))) {
          const srt = c.srt as Json | null | undefined, rtmps = c.rtmps as Json | undefined;
          if (srt) { expect(srt.url, `${dir}/${f}: cred.srt.url`).toBe(W26.srt); srtSeen++; }
          if (rtmps) { expect(rtmps.url, `${dir}/${f}: cred.rtmps.url`).toBe(W26.rtmps); rtmpsSeen++; }
        }
      }
    }
    expect(files, "fixture files scanned").toBe(Object.values(DIRS).reduce((n, d) => n + d.count, 0));
    expect(srtSeen, "cred.srt.url values checked").toBe(12);
    expect(rtmpsSeen, "cred.rtmps.url values checked").toBe(15);
    // The published prose names Cloudflare's URL and W26, and never a custom host.
    const descriptor = rootOf(contract(DESCRIPTOR));
    let described = 0;
    for (const [which, url] of Object.entries(W26)) {
      const nodes = nodesAt(descriptor, ["cred", which, "url"]);
      // cred appears in warming, live and ending (§17.5).
      expect(nodes, `cred.${which}.url occurrences`).toHaveLength(3);
      for (const node of nodes) {
        expect(node.description, `cred.${which}.url`).toContain(url);
        expect(node.description, `cred.${which}.url`).toContain("W26");
        expect(node.description, `cred.${which}.url`).not.toMatch(RETIRED);
        expect(node.description, `cred.${which}.url`).not.toContain("live.*");
        described++;
      }
    }
    expect(described).toBe(6);
    let contracts = 0;
    for (const file of Object.keys(SHA256)) {
      expect(contractText(file), `${file}: a retired custom ingest host`).not.toMatch(RETIRED);
      contracts++;
    }
    expect(contracts).toBe(6);
  });

  it("QR v2 `exp` (capture's A1, §1.2): optional, an integer ≥ 0 of epoch SECONDS; admitted when present, never sent by this server", () => {
    const dir = "capture-qr.v2";
    const valid = fixture(dir, "valid");
    expect("exp" in valid, "premise: the plain fixture carries no exp").toBe(false);
    const withExp = fixture(dir, "valid-exp");
    // v1's precedent: 2100-01-01T00:00:00Z in SECONDS (a milliseconds value would be ~1000× this).
    expect(withExp.exp).toBe(4102444800);
    expect(without(withExp, "exp"), "premise: valid-exp is valid plus exp").toEqual(valid);
    expect(parseCaptureQrV2(withExp)).toEqual({ ok: true, payload: withExp });
    // The boundary the ruling names: 0 is admitted.
    const zero = fixture(dir, "valid-exp-zero");
    expect(zero.exp).toBe(0);
    expect(parseCaptureQrV2(zero)).toEqual({ ok: true, payload: zero });
    // Each refusal differs from valid-exp in `exp` alone, and parseCaptureQrV2 calls it invalid (not wrong_version).
    const refused: [name: string, exp: unknown][] = [
      ["invalid-exp-string", "4102444800"], ["invalid-exp-negative", -1], ["invalid-exp-float", 4102444800.5], ["invalid-null-exp", null],
    ];
    let checked = 0;
    for (const [name, exp] of refused) {
      const f = fixture(dir, name);
      expect(f.exp, `${name}: premise`).toStrictEqual(exp);
      expect(without(f, "exp"), `${name}: premise — only exp differs`).toEqual(valid);
      expect(parseCaptureQrV2(f), name).toEqual({ ok: false, reason: "invalid" });
      checked++;
    }
    expect(checked).toBe(4);
    // The file: five properties, four required; `exp` an integer with minimum 0, null not admitted.
    const file = contract(QR);
    expect(Object.keys(file.properties as Json).sort()).toEqual(["code", "exp", "slot", "tok", "v"]);
    expect([...(file.required as string[])].sort()).toEqual(["code", "slot", "tok", "v"]);
    expect(file.additionalProperties).toBe(false);
    const exp = (file.properties as Record<string, Json>).exp!;
    expect(exp.type).toBe("integer");
    expect(exp.minimum).toBe(0);
    expect(exp.anyOf, "exp is not `| null`").toBeUndefined();
    // We never send it (§1.2 A1's web consequence, §6.2): handed a payload that carries exp, the text drops it.
    const text = captureQrV2Text(withExp as CaptureQrV2);
    expect(Object.keys(JSON.parse(text) as Json)).toEqual(["v", "code", "slot", "tok"]);
    expect(text).not.toContain("exp");
    expect(parseCaptureQrV2(JSON.parse(text))).toEqual({ ok: true, payload: valid });
  });

  it("QR v2: valid parses; tampered (a fifth key, cred) and wrong-version (v 1) refuse with their reasons; the text is exactly four keys", () => {
    const dir = "capture-qr.v2";
    const valid = fixture(dir, "valid");
    expect(parseCaptureQrV2(valid)).toEqual({ ok: true, payload: valid });
    const tampered = fixture(dir, "tampered");
    expect(Object.keys(tampered).sort(), "premise: valid plus cred").toEqual([...Object.keys(valid), "cred"].sort());
    expect(parseCaptureQrV2(tampered)).toEqual({ ok: false, reason: "invalid" });
    const wrong = fixture(dir, "wrong-version");
    expect(wrong.v).toBe(1);
    expect(parseCaptureQrV2(wrong)).toEqual({ ok: false, reason: "wrong_version" });
    // W3 / §6.2: the QR and the paste code carry exactly these four keys, in this order, and never credentials.
    const text = captureQrV2Text(valid as CaptureQrV2);
    expect(Object.keys(JSON.parse(text) as Json)).toEqual(["v", "code", "slot", "tok"]);
    expect(parseCaptureQrV2(JSON.parse(text))).toEqual({ ok: true, payload: valid });
    // Handed a wider object, the text still carries the four keys only (a structural type admits extras).
    const wide = { ...valid, cred: tampered.cred } as unknown as CaptureQrV2;
    expect(Object.keys(JSON.parse(captureQrV2Text(wide)) as Json)).toEqual(["v", "code", "slot", "tok"]);
    // The empty case: nothing that is not an object throws or parses.
    for (const input of [undefined, null, {}, [], "", 1, true, { v: 2 }]) {
      expect(parseCaptureQrV2(input), JSON.stringify(input) ?? "undefined").toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("the stream code is lowercase Crockford base32 × 12 (§6.1), one pattern across the QR, the descriptor and the beat", () => {
    let accepted = 0;
    for (const ch of CROCKFORD) {
      const code = ch.repeat(12);
      expect(S.CAPTURE_CODE_RE.test(code), code).toBe(true);
      expect(CaptureQrV2.shape.code.safeParse(code).success, code).toBe(true);
      accepted++;
    }
    expect(accepted).toBe(32);
    for (const code of ["i", "l", "o", "u", "A"].map((c) => c.repeat(12)).concat(["0".repeat(11), "0".repeat(13)])) {
      expect(S.CAPTURE_CODE_RE.test(code), code).toBe(false);
      expect(CaptureQrV2.shape.code.safeParse(code).success, code).toBe(false);
    }
    const patterns = [
      ...nodesAt(contract(QR), ["code"]),
      ...nodesAt(rootOf(contract(DESCRIPTOR)), ["code"]),
      ...nodesAt(rootOf(contract(BEAT)), ["code"]),
    ].map((n) => n.pattern);
    expect(patterns, "QR 1 + descriptor 6 + beat 1").toHaveLength(8);
    for (const p of patterns) expect(p).toBe(S.CAPTURE_CODE_RE.source);
  });

  it("end reasons (§6.8.4): the files carry exactly the seven wire values, and each one parses on `over` and on `completed`", () => {
    const overEnum = (branchesByState(defOf(contract(BEAT), "answer")).over!.properties as Record<string, Json>).endReason!.enum as string[];
    expect([...overEnum].sort()).toEqual([...WIRE_END_REASONS].sort());
    let checked = 0;
    for (const state of ["ending", "completed", "failed"]) {
      const e = (branchesByState(rootOf(contract(DESCRIPTOR)))[state]!.properties as Record<string, Json>).endReason!.enum as string[];
      expect([...e].sort(), state).toEqual([...WIRE_END_REASONS].sort());
    }
    const over = fixture("capture-beat.v1", "answer-valid-over");
    const completed = fixture("capture-descriptor.v1", "valid-completed");
    for (const r of WIRE_END_REASONS) {
      expect(parses(S.CaptureBeatAnswer, { ...over, endReason: r }), `over ${r}`).toBe(true);
      expect(parses(S.CaptureDescriptor, { ...completed, endReason: r }), `completed ${r}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(7);
    // The DB-only words never reach the wire (§6.8.4 maps them).
    for (const r of ["operator_stopped", "no_credits", "provision_timeout"]) {
      expect(parses(S.CaptureBeatAnswer, { ...over, endReason: r }), r).toBe(false);
    }
  });

  it("refusals: 409 already_live still carries {code, message, sid, startedBy}; every refusal code has a fixture; extras ride only on already_live", () => {
    const live = fixture("capture-start.v1", "valid-already_live");
    expect(Object.keys(live).sort()).toEqual(["code", "message", "sid", "startedBy"]);
    expect(parses(S.CaptureRefusal, live)).toBe(true);
    expect(parses(S.CaptureRefusal, without(live, "startedBy")), "already_live without startedBy").toBe(false);
    expect(parses(S.CaptureRefusal, without(live, "sid")), "already_live without sid").toBe(false);
    // The codes come from the spec's table (SPEC_REFUSALS), never the twin or the file; the enums test pins the files.
    const codes = Object.keys(SPEC_REFUSALS);
    expect(codes).toHaveLength(10);
    let checked = 0;
    for (const code of codes) {
      const f = fixture("capture-start.v1", `valid-${code}`);
      expect(f.code).toBe(code);
      expect(parses(S.CaptureRefusal, f), code).toBe(true);
      if (code !== "already_live") {
        expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
        expect(parses(S.CaptureRefusal, { ...f, sid: live.sid }), `${code} carrying sid`).toBe(false);
      }
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("descriptor refusals (§6.3.1, §6.14 one fixture per refusal per file): 401, 404, 422, 429 and 503 each have a vendored fixture; 503 is `unavailable`", () => {
    const fileAdmits = fileValidator();
    let checked = 0;
    for (const code of SPEC_DESCRIPTOR_REFUSALS) {
      const f = fixture("capture-descriptor.v1", `refusal-valid-${code}`);
      expect(f.code).toBe(code);
      expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
      expect(parses(S.CaptureRefusal, f), code).toBe(true);
      expect(fileAdmits(DESCRIPTOR, "#/$defs/refusal", f), code).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
    expect([...SPEC_DESCRIPTOR_REFUSALS].map((c) => SPEC_REFUSALS[c]).sort()).toEqual([401, 404, 422, 429, 503]);
    expect(SPEC_REFUSALS.unavailable).toBe(503);
    // The descriptor directory carries no start-only refusal (409, 402, 403 cannot come from GET).
    const present = readdirSync(resolve(FIXTURES, "capture-descriptor.v1")).filter((f) => f.startsWith("refusal-valid-"));
    expect(present.map((f) => f.slice("refusal-valid-".length, -5)).sort()).toEqual([...SPEC_DESCRIPTOR_REFUSALS].sort());
  });

  it("W28 stage: each stage fixture differs from its sibling in `stage` alone; the twin AND the file admit the valid ones (an unknown role.kind and an 8-character code included) and refuse a pool of \"AA\", a 9-character code and every other breach", () => {
    const fileAdmits = fileValidator();
    const dir = "capture-descriptor.v1";
    // [fixture, its sibling, admitted?] — every sibling is a plain valid-<state> fixture, which carries NO stage.
    const owed: [name: string, sibling: string, admitted: boolean][] = [
      ["valid-waiting-stage", "valid-waiting", true],
      ["valid-live-stage", "valid-live", true],
      ["valid-waiting-stage-unknown-kind", "valid-waiting", true],
      ["valid-waiting-stage-code-8", "valid-waiting", true],
      ["invalid-stage-pool-AA", "valid-waiting", false],
      ["invalid-stage-pool-lowercase", "valid-waiting", false],
      ["invalid-stage-code-9", "valid-waiting", false],
      ["invalid-stage-code-empty", "valid-waiting", false],
      ["invalid-stage-role-n-0", "valid-waiting", false],
      ["invalid-stage-role-entrants-1", "valid-waiting", false],
      ["invalid-stage-role-no-kind", "valid-waiting", false],
      ["invalid-stage-extra-key", "valid-waiting", false],
      // `label` (2026-10-07): 1..40 characters, optional.
      ["valid-waiting-stage-label-40", "valid-waiting", true],
      ["invalid-stage-label-41", "valid-waiting", false],
      ["invalid-stage-label-empty", "valid-waiting", false],
    ];
    let checked = 0;
    for (const [name, sibling, admitted] of owed) {
      const f = fixture(dir, name), base = fixture(dir, sibling);
      expect("stage" in base, `${name}: premise — ${sibling} carries no stage`).toBe(false);
      expect(without(f, "stage"), `${name}: premise — differs from ${sibling} in stage alone`).toEqual(base);
      expect(parses(S.CaptureDescriptor, f), `${name}: the twin ${admitted ? "admits" : "refuses"} it`).toBe(admitted);
      expect(fileAdmits(DESCRIPTOR, "", f), `${name}: the file ${admitted ? "admits" : "refuses"} it`).toBe(admitted);
      if (!admitted) {
        // The refusal is about the stage, not some other guard.
        const paths = S.CaptureDescriptor.safeParse(f).error!.issues.map((i) => i.path[0]);
        expect(paths.every((p) => p === "stage"), `${name}: refused on stage (${JSON.stringify(paths)})`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBe(owed.length);
    expect(checked).toBe(15);
    // The brief's own boundary values, read off the fixtures so the premise is visible.
    const stageOf = (name: string) => fixture(dir, name).stage as { code: string; role: Json; pool?: string };
    expect(stageOf("invalid-stage-pool-AA").pool).toBe("AA");
    expect(stageOf("invalid-stage-code-9").code).toHaveLength(9);
    expect(stageOf("valid-waiting-stage-code-8").code).toHaveLength(8);
    expect(Object.keys(ROLE_KINDS), "premise: the fixture's kind is not one the engine declares").not.toContain(stageOf("valid-waiting-stage-unknown-kind").role.kind);
    expect(stageOf("valid-waiting-stage").pool, "a pooled fixture carries its pool").toMatch(/^[A-Z]$/);
    // label: the boundary pair, the empty case, and a stage WITHOUT one admitted (the phone shows nothing then).
    const labelOf = (name: string) => (fixture(dir, name).stage as { label?: string }).label;
    expect(labelOf("valid-waiting-stage-label-40")).toHaveLength(40);
    expect(labelOf("invalid-stage-label-41")).toHaveLength(41);
    expect(labelOf("invalid-stage-label-empty")).toBe("");
    // The server's own label for division "Open", pool A, plain round 1, en (capture-stage.ts, owner ruling 2026-10-08):
    // division · pool word · round.
    expect(labelOf("valid-waiting-stage"), "a pooled fixture's label: division, pool word, round").toBe("Open · Group A · Round 1");
    expect(Object.hasOwn(fixture(dir, "valid-waiting-stage-code-8").stage as object, "label"), "premise: a stage with no label").toBe(false);
  });

  it("W28 stage.label (2026-10-07): optional and 1..40 on all six states, in the file and the twin; a 41-character label is refused and a missing one admitted on every state", () => {
    const desc = rootOf(contract(DESCRIPTOR));
    let nodes = 0;
    for (const [side, shape] of [["file", desc], ["twin", zodJson(S.CaptureDescriptor, "output")]] as const) {
      const stages = nodesAt(shape, ["stage"]);
      expect(stages, `${side}: stage on all six states`).toHaveLength(6);
      for (const st of stages) {
        const label = (st.properties as Record<string, Json>).label!;
        expect(label, `${side}: stage.label exists`).toBeDefined();
        expect({ type: label.type, minLength: label.minLength, maxLength: label.maxLength }, side).toEqual({ type: "string", minLength: 1, maxLength: 40 });
        expect((st.required as string[] | undefined) ?? [], `${side}: label is optional`).not.toContain("label");
        nodes++;
      }
    }
    expect(nodes).toBe(12);
    // Through the twin, on every state's own valid fixture: a stage with no label parses, one of 41 does not.
    const fileAdmits = fileValidator();
    let states = 0;
    for (const state of ["waiting", "warming", "live", "ending", "completed", "failed"] as const) {
      const base = fixture("capture-descriptor.v1", `valid-${state}`);
      const bare = { ...base, stage: { code: "R1", role: { kind: "plain_round", n: 1 } } };
      const long = { ...base, stage: { code: "R1", role: { kind: "plain_round", n: 1 }, label: "x".repeat(41) } };
      expect(parses(S.CaptureDescriptor, bare), `${state}: no label`).toBe(true);
      expect(fileAdmits(DESCRIPTOR, "", bare), `${state}: no label (file)`).toBe(true);
      expect(parses(S.CaptureDescriptor, long), `${state}: 41`).toBe(false);
      expect(fileAdmits(DESCRIPTOR, "", long), `${state}: 41 (file)`).toBe(false);
      states++;
    }
    expect(states).toBe(6);
  });

  it("W28 role.kind is OPEN: no enum or const in the file or the twin, on every state; its prose lists every kind the engine declares and the rule for an unknown one", () => {
    const desc = rootOf(contract(DESCRIPTOR));
    const kinds = Object.keys(ROLE_KINDS);
    expect(kinds).toHaveLength(15);
    let nodes = 0;
    for (const [side, shape] of [["file", desc], ["twin", zodJson(S.CaptureDescriptor, "output")]] as const) {
      const found = nodesAt(shape, ["stage", "role", "kind"]);
      expect(found, `${side}: role.kind on all six states`).toHaveLength(6);
      for (const node of found) {
        expect(enumOf(node), `${side}: role.kind closes nothing`).toEqual([]);
        expect(node.type, side).toBe("string");
        nodes++;
      }
    }
    expect(nodes).toBe(12);
    let prose = 0;
    for (const node of nodesAt(desc, ["stage", "role", "kind"])) {
      for (const k of kinds) expect(node.description, `role.kind prose names ${k}`).toContain(`\`${k}\``);
      expect(node.description).toContain("show nothing for an unknown kind");
      prose++;
    }
    expect(prose).toBe(6);
  });

  it("W27 scoring-link: the 200 is the bare {url} on the brief's exact pattern; every refusal the route answers has a fixture, admitted by the twin and the file; extras ride on none of them", () => {
    const fileAdmits = fileValidator();
    const dir = "capture-scoring-link.v1";
    // The pattern is the brief's text, on the file and on the twin.
    for (const [side, shape] of [["file", defOf(contract(SCORING), "ok")], ["twin", zodJson(S.CaptureScoringLinkOk, "output")]] as const) {
      const url = (shape.properties as Record<string, Json>).url!;
      // JSON Schema stores a RegExp's `.source`, which escapes "/": compare the two as patterns, not as bytes.
      expect(new RegExp(String(url.pattern)).source, side).toBe(new RegExp(SPEC_SCORING_LINK_URL).source);
      expect(shape.required, side).toEqual(["url"]);
    }
    const ok = fixture(dir, "ok-valid");
    expect(String(ok.url)).toMatch(new RegExp(SPEC_SCORING_LINK_URL));
    // Each refusal of the ok shape differs from ok-valid in `url` alone (or adds one key).
    let okChecked = 0;
    for (const name of ["ok-invalid-http", "ok-invalid-path", "ok-invalid-secret-42", "ok-tampered"]) {
      const f = fixture(dir, name);
      if (name === "ok-tampered") expect(Object.keys(f).sort()).toEqual(["secret", "url"]);
      else expect(String(f.url), `${name}: premise`).not.toMatch(new RegExp(SPEC_SCORING_LINK_URL));
      expect(parses(S.CaptureScoringLinkOk, f), name).toBe(false);
      expect(fileAdmits(SCORING, "#/$defs/ok", f), name).toBe(false);
      okChecked++;
    }
    expect(okChecked).toBe(4);
    const codes = Object.keys(SPEC_SCORING_LINK_REFUSALS);
    expect(codes).toHaveLength(8);
    let checked = 0;
    for (const code of codes) {
      const f = fixture(dir, `valid-${code}`);
      expect(f.code).toBe(code);
      expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
      expect(parses(S.CaptureRefusal, f), code).toBe(true);
      expect(fileAdmits(SCORING, "#/$defs/refusal", f), code).toBe(true);
      checked++;
    }
    expect(checked).toBe(8);
    // The directory carries exactly the route's refusals: no start-only word (already_live, no_destination, no_credit).
    const present = readdirSync(resolve(FIXTURES, dir)).filter((f) => /^valid-/.test(f)).map((f) => f.slice("valid-".length, -5));
    expect(present.sort()).toEqual([...codes].sort());
    // match_finished is the one NEW word; it carries no extras.
    expect(SPEC_REFUSAL_CODES.filter((c) => !(c in SPEC_REFUSALS))).toEqual(["match_finished"]);
    expect(parses(S.CaptureRefusal, { ...fixture(dir, "valid-match_finished"), sid: fixture("capture-start.v1", "valid-already_live").sid }), "match_finished carrying sid").toBe(false);
  });

  it("capture-record.v1: every fixture is judged by the published bytes under ajv, counted per shape — valid* admitted, invalid-*/tampered* refused, and each line-secret-* ADMITTED, its rule being the server's alone and stated in the root's prose", () => {
    const fileAdmits = fileValidator();
    const root = rootOf(contract(RECORD));
    const names = readdirSync(resolve(FIXTURES, RECORD_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    const perRoute = new Map<string, number>();
    let secrets = 0, serverOnly = 0;
    for (const name of names) {
      const route = RECORD_ROUTES.find(([prefix]) => name.startsWith(prefix));
      expect(route, `${RECORD_DIR}/${name}: no shape routes this fixture`).toBeDefined();
      const [prefix, pointer] = route!;
      const kind = name.slice(prefix.length);
      const value = fixture(RECORD_DIR, name);
      let admitted: boolean;
      if (/^valid(-.+)?$/.test(kind)) admitted = true;
      else if (/^(invalid-.+|tampered(-.+)?)$/.test(kind)) admitted = false;
      else if (prefix === "line-" && /^secret-.+$/.test(kind)) {
        // The file's line shape admits it; the server drops it on the one rule its entry names, which the root states.
        const entry = RECORD_SERVER_ONLY[name];
        expect(entry, `${name}: a secret-shaped vector names its rule`).toBeDefined();
        expect(root.description, `${name}: the root states "${entry![1]}"`).toContain(entry![1]);
        admitted = true;
        secrets++;
      } else if (prefix === "line-" && /^server-.+$/.test(kind)) {
        // Review fix 1: a rule on the line's TEXT. The file's shape admits the parsed value; the server drops the line,
        // and the root says so in the words its entry names.
        const entry = RECORD_SERVER_TEXT_RULES[name];
        expect(entry, `${name}: a server-only text rule names itself`).toBeDefined();
        expect(root.description, `${name}: the root states "${entry![1]}"`).toContain(entry![1]);
        expect(entry![0](rawFixture(RECORD_DIR, name)), `${name}: premise — the file's TEXT breaks the rule`).toBe(true);
        admitted = true;
        serverOnly++;
      } else expect.fail(`${RECORD_DIR}/${name}: neither valid* nor invalid-*/tampered* nor line-secret-* nor line-server-*`);
      expect(fileAdmits(RECORD, pointer, value), `${RECORD_DIR}/${name}: ${RECORD}${pointer} ${admitted ? "admits" : "refuses"} it`).toBe(admitted);
      perRoute.set(prefix, (perRoute.get(prefix) ?? 0) + 1);
    }
    let routes = 0;
    for (const [prefix, , count] of RECORD_ROUTES) {
      expect(perRoute.get(prefix) ?? 0, `${RECORD_DIR}: "${prefix}" fixtures checked`).toBe(count);
      routes++;
    }
    expect(routes).toBe(3);
    expect(names).toHaveLength(49 + 6 + 8);
    // Every RECORD_SERVER_ONLY entry names a fixture that exists and was swept (a stale entry would excuse nothing).
    expect(secrets, "secret-shaped vectors swept").toBe(Object.keys(RECORD_SERVER_ONLY).length);
    expect(secrets).toBe(6);
    expect(serverOnly, "server-only text rules swept").toBe(Object.keys(RECORD_SERVER_TEXT_RULES).length);
    expect(serverOnly).toBe(1);
    // S1's vector is the Bearer the route's test will send, as a plain word the file cannot tell from any other.
    expect(fixture(RECORD_DIR, "line-secret-sending-tok").state).toBe(RECORD_SENDING_TOK);
    expect(Object.keys(contract(RECORD).$defs as Json).sort()).toEqual([...RECORD_DEFS].sort());
  });

  it("capture-record.v1 secret-shaped rules S2–S5 are the file's own $defs and skip the scrub's mask: each secret vector trips its rule ALONE, each of capture's scrubbed outputs trips NONE and trips its rule once unmasked, and no string of any valid line is secret-shaped — counted", () => {
    const fileAdmits = fileValidator();
    const RULES = ["S2", "S3", "S4", "S5"] as const;
    const stringsOf = (line: Json): string[] => Object.values(line).filter((v): v is string => typeof v === "string");
    /** The rules any string value of `line` trips, through the published bytes (each `$defs.secretS<n>`). */
    const tripped = (line: Json): string[] => RULES.filter((r) => stringsOf(line).some((s) => fileAdmits(RECORD, `#/$defs/secret${r}`, s)));
    const shaped = (line: Json): boolean => stringsOf(line).some((s) => fileAdmits(RECORD, "#/$defs/secretShaped", s));
    // The secret vectors: S2–S5 each trip their own rule and no other; S1's needs the Bearer, so it trips none.
    let vectors = 0;
    for (const [name, [rule]] of Object.entries(RECORD_SERVER_ONLY)) {
      const line = fixture(RECORD_DIR, name);
      expect(tripped(line), name).toEqual(rule === "S1" ? [] : [rule]);
      expect(shaped(line), `${name}: secretShaped`).toBe(rule !== "S1");
      vectors++;
    }
    expect(vectors).toBe(6);
    // The near misses: capture's scrubbed output trips nothing; unmasked, it trips exactly its rule (the premise that
    // the mask, and only the mask, is what spares it).
    const CREDENTIAL = "FAKE0123456789ABCDEF";
    let nearMisses = 0;
    for (const [name, rule] of Object.entries(RECORD_NEAR_MISS)) {
      const line = fixture(RECORD_DIR, name);
      expect(String(line.message), `${name}: premise — a mask in place`).toContain("***");
      expect(fileAdmits(RECORD, "", line), `${name}: the line shape admits it`).toBe(true);
      expect(tripped(line), `${name}: masked, it trips no rule`).toEqual([]);
      const unmasked = { ...line, message: String(line.message).replaceAll("***", CREDENTIAL) };
      expect(tripped(unmasked), `${name}: unmasked, it trips ${rule} alone`).toEqual([rule]);
      nearMisses++;
    }
    expect(nearMisses).toBe(9);
    expect(fixture(RECORD_DIR, "line-valid-scrubbed-srt-passphrase").message, "capture's vectors.json case 22, verbatim").toBe("srt://h:1?passphrase=***&x=1");
    // Premise of the punctuation near misses: each puts exactly that character straight after the mask.
    let punctuated = 0;
    for (const [name, after] of [["period", "."], ["comma", ","], ["quoted", "\""]] as const) {
      expect(String(fixture(RECORD_DIR, `line-valid-scrubbed-rtmps-key-${name}`).message), name).toContain(`/live/***${after}`);
      punctuated++;
    }
    expect(String(fixture(RECORD_DIR, "line-valid-scrubbed-streamid-paren").message)).toContain("streamid=***)");
    punctuated++;
    expect(punctuated).toBe(4);
    // Capture's vectors.json case 24: its input is the S3 vector (key problems), its output a near miss, both verbatim.
    expect(fixture(RECORD_DIR, "line-secret-streamid-space").problems).toBe("streamid a1b2c3d4e5f60718293a4b5c6d7e8f90 refused");
    expect(fixture(RECORD_DIR, "line-valid-scrubbed-vectors").problems).toBe("streamid *** refused");
    // The skip is for a WHOLE mask only: *** with a letter or digit after it is a partial mask, and still trips.
    let partial = 0;
    for (const [s, rule] of [["rtmps://live.cloudflare.com:443/live/***K3Y", "S2"], ["passphrase=***x1", "S3"], ["(streamid=***0)", "S3"]] as const) {
      expect(fileAdmits(RECORD, `#/$defs/secret${rule}`, s), s).toBe(true);
      partial++;
    }
    expect(partial).toBe(3);
    // Capture's own prose about SRT credentials (SessionConfig.kt problems(), verbatim, as a pair-refused line's
    // problems) names the word with no credential after it: admitted, and it trips no rule, S3's whitespace form
    // included (its 16-character floor is what spares "passphrase is" and "streamId is").
    let prose = 0;
    for (const [name, text] of [["line-valid-prose-srt-passphrase-length", "srt passphrase is not 10–79 characters"], ["line-valid-prose-srt-streamid-blank", "srt streamId is blank"]] as const) {
      const line = fixture(RECORD_DIR, name);
      expect(line.problems, `${name}: capture's string, verbatim`).toBe(text);
      expect(fileAdmits(RECORD, "", line), `${name}: the line shape admits it`).toBe(true);
      expect(tripped(line), `${name}: it trips no rule`).toEqual([]);
      prose++;
    }
    expect(prose).toBe(2);
    // No string value of any valid line — the near misses, capture's other scrubbed outputs and the plain lines — is
    // secret-shaped: the rules do not refuse what capture correctly sends.
    let validLines = 0, strings = 0;
    for (const f of readdirSync(resolve(FIXTURES, RECORD_DIR)).filter((n) => /^line-valid.*\.json$/.test(n))) {
      const line = fixture(RECORD_DIR, f.slice(0, -5));
      expect(shaped(line), `${f}: no string is secret-shaped`).toBe(false);
      strings += stringsOf(line).length;
      validLines++;
    }
    expect(validLines).toBe(25);
    expect(strings).toBeGreaterThan(validLines);
    // The bare ingest URLs W26 serves carry no credential; a masked RTMPS key or SRT passphrase is no secret either.
    let bare = 0;
    for (const s of ["rtmps://live.cloudflare.com:443/live/", "srt://live.cloudflare.com:778", "rtmps://live.cloudflare.com:443/live/***",
      "srt://live.cloudflare.com:778?streamid=***&passphrase=***", "Bearer ***", "the bearer of the card", "https://***@example.com/x"]) {
      expect(fileAdmits(RECORD, "#/$defs/secretShaped", s), s).toBe(false);
      bare++;
    }
    expect(bare).toBe(7);
  });

  it("capture-record.v1 keys are capture's allow-list, class for class: the line's own three, every plain/publicUrl/text/scalars key (the field kind written field_kind), no never key, no unnamed key — each class proven through ajv, counted", () => {
    const root = rootOf(contract(RECORD));
    const written = (k: string): string => (ALLOW_LIST.reserved.includes(k) ? `field_${k}` : k);
    const lists = [ALLOW_LIST.reserved, ALLOW_LIST.plain, ALLOW_LIST.publicUrl, ALLOW_LIST.text, ALLOW_LIST.scalars];
    const expected = [...ALLOW_LIST.reserved, ...ALLOW_LIST.plain.map(written), ...ALLOW_LIST.publicUrl, ...ALLOW_LIST.text, ...ALLOW_LIST.scalars];
    // Premise: the lists are disjoint once `kind` is renamed, so the key count is their sum.
    expect(new Set(expected).size, "premise: disjoint lists").toBe(lists.reduce((n, l) => n + l.length, 0));
    expect(expected).toHaveLength(3 + 48 + 3 + 2 + 48);
    expect(Object.keys(root.properties as Json).sort()).toEqual([...expected].sort());
    expect(root.additionalProperties).toBe(false);
    expect([...(root.required as string[])].sort()).toEqual(["at", "kind"]);
    for (const k of ALLOW_LIST.never) expect(Object.keys(root.properties as Json), `never key ${k}`).not.toContain(k);

    // Behaviour, through the published bytes: each key, on a minimal line, admits and refuses by its class.
    const fileAdmits = fileValidator();
    const base: Json = { at: "2026-10-11T21:19:03.123Z", kind: "probe" };
    let probes = 0;
    const probe = (k: string, v: unknown, want: boolean): void => {
      expect(fileAdmits(RECORD, "", { ...base, [k]: v }), `${k} = ${JSON.stringify(v)}`).toBe(want);
      probes++;
    };
    const SCALARS = [3, 0.4, true, false, null];
    // allow-list.json's plainWord (^[A-Za-z0-9_.:-]{1,64}$) and its mask (***).
    const WORDS = ["live", "SocketException", "code.error", "a:b-c_d.e", "x".repeat(64), "***"];
    const NOT_WORDS = ["two words", "a/b", "x".repeat(65), "", "k=v", "a@b", "a?b"];
    const plain = ALLOW_LIST.plain.filter((p) => p !== "tokenTag" && p !== "sid").map(written);
    for (const k of plain) {
      for (const v of [...WORDS, ...SCALARS]) probe(k, v, true);
      for (const v of [...NOT_WORDS, {}, []]) probe(k, v, false);
    }
    // sid (review fix 3): only what attribution judges — the server's uuid (A1), the mask (dropped) or null (A2). A
    // number, a boolean or another word would be neither an A1 nor an A2 line.
    for (const v of ["5f2c8a1e-3b4d-4e6f-8a9b-0c1d2e3f4a5b", "***", null]) probe("sid", v, true);
    for (const v of [42, 0, true, false, "live", "5f2c8a1e3b4d4e6f8a9b0c1d2e3f4a5b", "", {}]) probe("sid", v, false);
    // tokenTag: the allow-list's own reason narrows it — "which issue of a code, eight hex digits; never the token".
    // The admitted values are capture's token-tag-vectors.json tags.
    for (const v of ["c980ff38", "811c9dc5", "0076912c"]) probe("tokenTag", v, true);
    for (const v of ["C980FF38", "c980ff3", "c980ff38ab", "***", 3, null, true]) probe("tokenTag", v, false);
    for (const k of ALLOW_LIST.publicUrl) {
      for (const v of ["https://customer-k7q2.cloudflarestream.com/0f1e/manifest/video.m3u8", "HTTPS://example.com", "https://example.com:443/x", "***", ...SCALARS]) probe(k, v, true);
      for (const v of ["http://example.com/x", "https://u:p@example.com/x", "https://example.com/x?token=1", "https://example.com/x#f", "rtmps://live.cloudflare.com:443/live/", "word", {}]) probe(k, v, false);
    }
    for (const k of ALLOW_LIST.text) {
      for (const v of ["free text, with spaces / and ? and =", "", "***", ...SCALARS]) probe(k, v, true);
      for (const v of [{}, ["a"]]) probe(k, v, false);
    }
    for (const k of ALLOW_LIST.scalars.filter((s) => !(s in NARROWED_SCALARS))) {
      for (const v of SCALARS) probe(k, v, true);
      for (const v of ["word", "***", {}]) probe(k, v, false);
    }
    // The four narrowed scalars: a count is an integer of at least 0 (the safe-integer ceiling is JSON's own); the
    // yes/no a boolean only. Neither admits null, the mask or a word.
    const narrowed = Object.entries(NARROWED_SCALARS);
    for (const [k, cls] of narrowed) {
      const admits = cls === "count" ? [0, 1, 4000, 48213, Number.MAX_SAFE_INTEGER] : [true, false];
      const refuses = cls === "count" ? [-1, 0.5, 48213.5, Number.MAX_SAFE_INTEGER + 1, true, null, "4000", "***", {}] : [0, 1, null, "true", "***", {}];
      for (const v of admits) probe(k, v, true);
      for (const v of refuses) probe(k, v, false);
    }
    expect(narrowed.map(([k]) => k).every((k) => ALLOW_LIST.scalars.includes(k)), "narrowed keys are capture's scalars").toBe(true);
    // The line's own keys. `at` is the beat's R5 shape (review fix 7): any offset, calendar-exact, seconds required,
    // never epoch milliseconds (spec §0.1) — capture's writers send Z with milliseconds; `kind` a word or the mask;
    // `level` one of four or the mask, and optional.
    expect((root.properties as Record<string, Json>).at, "at is the beat's at, shape for shape").toEqual({
      ...(rootOf(contract(BEAT)).properties as Record<string, Json>).at, description: ((root.properties as Record<string, Json>).at as Json).description,
    });
    for (const v of ["2026-10-11T21:19:03.123Z", "2026-10-11T21:19:03Z", "2026-10-11T21:19:03.123456789Z", "2026-10-11T22:19:03.123+01:00", "2028-02-29T00:00:00.000Z"]) probe("at", v, true);
    for (const v of [1791797943123, "2026-10-11T21:19Z", "2026-10-11 21:19:03.123Z", "2026-10-11T21:19:03.123", "2026-02-30T00:00:00.000Z", "2027-02-29T00:00:00.000Z", ""]) probe("at", v, false);
    for (const v of ["live", "code.error", "***"]) probe("kind", v, true);
    for (const v of ["two words", "", 3, null]) probe("kind", v, false);
    for (const v of ["debug", "info", "warn", "error", "***"]) probe("level", v, true);
    for (const v of ["fatal", "INFO", 3, null]) probe("level", v, false);
    expect(fileAdmits(RECORD, "", base), "level absent (= info)").toBe(true);
    expect(fileAdmits(RECORD, "", without(base, "kind")), "kind absent").toBe(false);
    expect(fileAdmits(RECORD, "", without(base, "at")), "at absent").toBe(false);
    // Unlisted keys — every never key, a scalar under an unnamed key, a renamed reserved key no list names — are
    // refused whatever they hold, the mask included.
    const unlisted = [...ALLOW_LIST.never, "battery", "cred", "field_at"];
    for (const k of unlisted) for (const v of ["***", 3, null]) probe(k, v, false);
    expect(plain).toHaveLength(46);
    expect(unlisted).toHaveLength(11);
    // plain 46 × 20, sid 11, tokenTag 10, publicUrl 3 × 16, text 2 × 10, scalars 44 × 8, the narrowed counts 3 × 14 and
    // yes/no 1 × 8, at 12, kind 7, level 9, unlisted 11 × 3.
    expect(probes).toBe(46 * 20 + 11 + 10 + 3 * 16 + 2 * 10 + 44 * 8 + 3 * 14 + 8 + 12 + 7 + 9 + 11 * 3);
  });

  it("capture-record.v1 R-990P (capture 2b4df80): the seven bitrate scalars are the contract's own generic scalar class, exactly gapMs's and videoFps's — a number, a boolean or null admitted (a negative sendBufferMs included), every other JSON type refused, an unknown key still refused — by the published bytes AND the twin, counted; the three bitrate fixtures carry every one of the seven", () => {
    const root = rootOf(contract(RECORD));
    const props = root.properties as Record<string, Json>;
    const fileAdmits = fileValidator();
    const base: Json = { at: "2026-10-11T21:42:17.350Z", kind: "bitrate" };

    // Premises, typed from capture's allow-list: seven keys, each a scalar there, none narrowed by its own reason.
    expect(R990P_KEYS).toHaveLength(7);
    for (const k of R990P_KEYS) {
      expect(ALLOW_LIST.scalars, `${k}: one of capture's scalars`).toContain(k);
      expect(k in NARROWED_SCALARS, `${k}: not narrowed by its reason`).toBe(false);
    }
    // The class is the contract's OWN: the anyOf gapMs and videoFps already carry, verbatim (description included), and
    // the types admitted are read off that anyOf, never typed here. A key missing from the file fails on its first line.
    expect(props.videoFps, "premise: gapMs and videoFps are one class").toEqual(props.gapMs);
    const classTypes = (props.gapMs.anyOf as Json[]).map((branch) => branch.type as string);
    expect(classTypes, "the class: a number, a boolean or null only").toEqual(["number", "boolean", "null"]);
    for (const k of R990P_KEYS) {
      expect(props[k], `${k}: exactly gapMs's shape`).toEqual(props.gapMs);
      // No bound anywhere on it: a minimum would refuse the −336 capture has seen.
      expect(JSON.stringify(props[k]), `${k}: no bound`).not.toMatch(/minimum|maximum|exclusive|multipleOf|"integer"/i);
    }
    expect(root.additionalProperties, "the line stays closed").toBe(false);

    // Every JSON type, by name; a type is admitted iff the contract's class lists it.
    const BY_TYPE: Record<string, unknown[]> = {
      number: [0, 3, 0.4, 4000000, -1, -336],
      boolean: [true, false],
      null: [null],
      string: ["word", "***", "", "-336", "4000000", "true", "null"],
      object: [{}, { a: 1 }],
      array: [[], [3]],
    };
    let probes = 0, admittedProbes = 0, refusedProbes = 0;
    for (const k of R990P_KEYS) {
      for (const [type, values] of Object.entries(BY_TYPE)) {
        const want = classTypes.includes(type);
        for (const v of values) {
          const line = { ...base, [k]: v };
          expect(fileAdmits(RECORD, "", line), `file: ${k} = ${JSON.stringify(v)}`).toBe(want);
          expect(parses(S.CaptureRecordLine, line), `twin: ${k} = ${JSON.stringify(v)}`).toBe(want);
          probes++;
          if (want) admittedProbes++; else refusedProbes++;
        }
      }
    }
    expect(probes).toBe(7 * (6 + 2 + 1 + 7 + 2 + 2));
    expect(admittedProbes, "anti-vacuity: the sweep admitted").toBe(7 * (6 + 2 + 1));
    expect(refusedProbes, "anti-vacuity: the sweep refused").toBe(7 * (7 + 2 + 2));
    // The one that matters for the SRT send buffer, alone: −336 admitted by both, on the key it was seen on.
    expect(fileAdmits(RECORD, "", { ...base, sendBufferMs: -336 }), "file: sendBufferMs −336").toBe(true);
    expect(parses(S.CaptureRecordLine, { ...base, sendBufferMs: -336 }), "twin: sendBufferMs −336").toBe(true);

    // The closed line survives the seven additions: a key near each of them, and a never key, is still refused whatever
    // it holds, by both sides — so `additionalProperties: false` is the thing refusing, not luck.
    const NEAR = ["bandwidthbps", "bandwidth", "sendBuffer", "targetBps", "egress", "gatebps", "lostPackets", "droppedPackets", "R-990P", ...ALLOW_LIST.never];
    let unknown = 0;
    for (const k of NEAR) {
      expect(R990P_KEYS, `${k}: premise — none of the seven`).not.toContain(k);
      for (const v of [3, true, null, "***"]) {
        expect(fileAdmits(RECORD, "", { ...base, [k]: v }), `file: ${k} = ${JSON.stringify(v)}`).toBe(false);
        expect(parses(S.CaptureRecordLine, { ...base, [k]: v }), `twin: ${k} = ${JSON.stringify(v)}`).toBe(false);
        unknown++;
      }
    }
    expect(NEAR).toHaveLength(9 + 8);
    expect(unknown).toBe((9 + 8) * 4);
    // All seven on one line, and each of the seven absent: every key is optional.
    const all = Object.fromEntries(R990P_KEYS.map((k) => [k, null])) as Json;
    expect(fileAdmits(RECORD, "", { ...base, ...all })).toBe(true);
    expect(parses(S.CaptureRecordLine, { ...base, ...all })).toBe(true);
    expect(fileAdmits(RECORD, "", base)).toBe(true);
    expect(parses(S.CaptureRecordLine, base)).toBe(true);

    // The lines as capture now sends them: a full SRT `bitrate` (with the negative send buffer), the RTMPS one (the
    // SRT-only readings null, lost 0 — the allow-list's own reasons) and a `bitrate-held`, admitted by both sides, and
    // between them they carry every one of the seven keys.
    const BITRATE_FIXTURES = ["line-valid-bitrate", "line-valid-bitrate-rtmps", "line-valid-bitrate-held"];
    const carried = new Set<string>();
    for (const name of BITRATE_FIXTURES) {
      const line = fixture(RECORD_DIR, name);
      expect(fileAdmits(RECORD, "", line), `${name}: the file admits it`).toBe(true);
      expect(parses(S.CaptureRecordLine, line), `${name}: the twin admits it`).toBe(true);
      for (const k of Object.keys(line)) if (R990P_KEYS.includes(k)) carried.add(k);
    }
    expect([...carried].sort(), "the fixtures carry all seven").toEqual([...R990P_KEYS].sort());
    expect(BITRATE_FIXTURES.map((n) => fixture(RECORD_DIR, n).kind)).toEqual(["bitrate", "bitrate", "bitrate-held"]);
    expect(fixture(RECORD_DIR, "line-valid-bitrate").sendBufferMs, "a real SRT reading below zero").toBe(-336);
    const rtmps = fixture(RECORD_DIR, "line-valid-bitrate-rtmps");
    expect([rtmps.bandwidthBps, rtmps.sendBufferMs, rtmps.lost], "RTMPS: no bandwidth, no buffer, none lost").toEqual([null, null, 0]);
  });

  it("capture-record.v1 answers: 201 is the closed {ref, kept, dropped} with an upper-case Crockford ref; every refusal word of the spec's table has a fixture the file admits; replaced is none of them (R4)", () => {
    const file = contract(RECORD);
    const ok = defOf(file, "ok");
    expect([...(ok.required as string[])].sort()).toEqual(["dropped", "kept", "ref"]);
    expect(ok.additionalProperties).toBe(false);
    const fileAdmits = fileValidator();
    // The ref is read aloud to the organiser: upper-case Crockford base32 (§6.1's alphabet), so no I, L, O or U.
    let refs = 0;
    for (const ch of CROCKFORD.toUpperCase()) {
      expect(fileAdmits(RECORD, "#/$defs/ok", { ref: `R-${ch.repeat(4)}`, kept: 0, dropped: 0 }), ch).toBe(true);
      refs++;
    }
    for (const ch of ["I", "L", "O", "U", "a"]) {
      expect(fileAdmits(RECORD, "#/$defs/ok", { ref: `R-${ch.repeat(4)}`, kept: 0, dropped: 0 }), ch).toBe(false);
      refs++;
    }
    expect(refs).toBe(32 + 5);
    // The empty case: a record whose every line was another code's is still a 201 (the app shows the ref only).
    const allDropped = fixture(RECORD_DIR, "ok-valid-all-dropped");
    expect(allDropped.kept).toBe(0);
    expect(fileAdmits(RECORD, "#/$defs/ok", allDropped)).toBe(true);
    // Refusals: the file's closed list is the spec's table, word for word; each word has a two-key fixture it admits.
    const refusal = defOf(file, "refusal");
    const codes = Object.keys(SPEC_RECORD_REFUSALS);
    expect(codes).toHaveLength(6);
    expect(enumOf((refusal.properties as Record<string, Json>).code!)).toEqual([...codes].sort());
    let checked = 0;
    for (const code of codes) {
      const f = fixture(RECORD_DIR, `valid-${code}`);
      expect(f.code).toBe(code);
      expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
      expect(fileAdmits(RECORD, "#/$defs/refusal", f), code).toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
    const present = readdirSync(resolve(FIXTURES, RECORD_DIR)).filter((f) => /^valid-/.test(f)).map((f) => f.slice("valid-".length, -5));
    expect(present.sort()).toEqual([...codes].sort());
    // R4: a replaced phone may send, so `replaced` is no answer of this route, and the file refuses its body.
    expect(codes).not.toContain("replaced");
    expect(fileAdmits(RECORD, "#/$defs/refusal", fixture(RECORD_DIR, "invalid-replaced"))).toBe(false);
  });

  it("capture-record.v1's twins joined the parity test: capture-schemas.ts exports exactly the pinned names, and every record zod export is one RECORD_TWINS compares (a new export under ANY name trips this until it joins)", () => {
    const names = Object.keys(CS);
    expect(names.length, "premise: capture-schemas.ts exports").toBeGreaterThan(0);
    // The full list, not a name pattern (review fix 8): a twin named, say, CaptureLogLine trips it too.
    expect([...names].sort()).toEqual([...CAPTURE_SCHEMAS_EXPORTS].sort());
    expect(CAPTURE_SCHEMAS_EXPORTS).toHaveLength(23 + 11);
    // Every record-named export that is a SHAPE (a zod object or string) is a twin the parity test compares, by
    // identity — an enum is checked by its options instead, a constant by the contract's prose.
    const twins = new Map(RECORD_TWINS.map(([pointer, twin, name]) => [name, { pointer, twin }]));
    let joined = 0;
    for (const name of names.filter((n) => /record/i.test(n))) {
      const value = (CS as Record<string, unknown>)[name];
      if (!(value instanceof z.ZodType) || value instanceof z.ZodEnum) continue;
      expect(twins.get(name)?.twin, `${name}: a record twin outside the parity test`).toBe(value);
      joined++;
    }
    expect(joined, "record twins joined to parity").toBe(RECORD_TWINS.length);
    expect(joined).toBe(7);
    // The refusal words twin: the file's closed list exactly, `too_large` among them and `replaced` never (R4) — and
    // the shared CaptureRefusalCode, which every other capture contract twins, did NOT gain the record's word (Q2).
    expect([...CS.CaptureRecordRefusalCode.options].sort()).toEqual(Object.keys(SPEC_RECORD_REFUSALS).sort());
    expect(CS.CaptureRefusalCode.options as readonly string[]).not.toContain("too_large");
    // The limits are the root's prose, figure for figure.
    const prose = String(contract(RECORD).description);
    expect(prose).toContain(`at most ${CS.CAPTURE_RECORD_MAX_LINES} non-empty lines`);
    expect(prose).toContain(`at most 1 MB (${CS.CAPTURE_RECORD_MAX_BYTES} bytes)`);
    // A2's closing kinds are Q7's as capture answered and then CORRECTED it (2026-10-12): `engine-error` is not one.
    const closing = /runs through the next ((?:`[a-z-]+`(?:, | or )?)+) line/.exec(prose)?.[1] ?? "";
    expect([...closing.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort()).toEqual(["ended", "pair-refused", "reset", "unpaired"]);
    expect(CS.CAPTURE_RECORD_REF_RE.source).toBe((defOf(contract(RECORD), "ok").properties as Record<string, Json>).ref!.pattern);
  });
});

/** Runs a field matrix against the twin. For each cell, from that state's valid fixture: forbidden → add the field
 *  (its value from a fixture of a state that allows it) and expect a refusal; required → delete it and expect a
 *  refusal; optional → the present and the absent forms both parse. Returns the cells checked. */
function sweepTwin<F extends string>(matrix: Record<string, Record<F, Cell>>, fields: readonly F[], valid: Record<string, Json>, donors: Json[], twin: Twin): number {
  let cells = 0;
  for (const [state, row] of Object.entries(matrix)) {
    const base = valid[state]!;
    expect(base.state, `${state}: premise — its fixture is that state`).toBe(state);
    expect(parses(twin, base), `${state}: premise — its valid fixture parses`).toBe(true);
    for (const field of fields) {
      const donor = (): unknown => {
        const d = donors.find((x) => x[field] !== undefined && matrix[x.state as string]![field] !== NO);
        expect(d, `${state}.${field}: no fixture of an allowing state carries it`).toBeDefined();
        return structuredClone(d![field]);
      };
      const cell = row[field];
      if (cell === NO) {
        expect(field in base, `${state}.${field}: premise — absent`).toBe(false);
        expect(parses(twin, { ...base, [field]: donor() }), `${state}.${field} is forbidden`).toBe(false);
      } else if (cell === REQ) {
        expect(field in base, `${state}.${field}: premise — present`).toBe(true);
        expect(parses(twin, without(base, field)), `${state}.${field} is required`).toBe(false);
      } else {
        const present = field in base ? base : { ...base, [field]: donor() };
        expect(parses(twin, present), `${state}.${field} present`).toBe(true);
        expect(parses(twin, without(present, field)), `${state}.${field} absent`).toBe(true);
      }
      cells++;
    }
  }
  return cells;
}

/** Runs a field matrix against the JSON file's branches: required → listed and required; optional → listed, not
 *  required; forbidden → not listed, and the branch is closed. Returns the cells checked. */
function sweepFile<F extends string>(matrix: Record<string, Record<F, Cell>>, fields: readonly F[], branches: Record<string, Json>): number {
  let cells = 0;
  for (const [state, row] of Object.entries(matrix)) {
    const b = branches[state]!;
    expect(b, `the file has no ${state} branch`).toBeDefined();
    expect(b.additionalProperties, `${state}: the branch is closed`).toBe(false);
    const props = Object.keys(b.properties as Json), required = (b.required as string[] | undefined) ?? [];
    for (const field of fields) {
      const cell = row[field];
      if (cell === NO) expect(props, `${state}.${field} is forbidden`).not.toContain(field);
      else {
        expect(props, `${state}.${field} is listed`).toContain(field);
        if (cell === REQ) expect(required, `${state}.${field} is required`).toContain(field);
        else expect(required, `${state}.${field} is optional`).not.toContain(field);
      }
      cells++;
    }
  }
  return cells;
}
