// server/relay/sanitise.ts — PURE (no sql, no fetch, no Date). The one gate a
// payload passes before a capture table. ALLOWLIST: add a key here when a new
// fact is worth keeping; nothing else survives. sanitise.test.ts pins that no
// allowed key names a credential.
import { EVENT_PAYLOAD_MAX_STRING } from "./config";

const MAX_DEPTH = 4;
const MAX_ARRAY = 50;

export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // domain
  "state", "from", "to", "trigger", "effect", "event", "reason", "endReason", "failReason", "desiredState",
  "mode", "slot", "attempt", "attempts", "staleAttempt", "retries", "expiry", "deadlineAt", "at", "seconds", "minutes",
  // runner / Fly (config.env VALUES are never here — only ids and states)
  "runnerState", "observed", "machineId", "machineName", "region", "cpus", "memoryMb", "cpuKind", "instanceId",
  "exit", "exitCode", "oomKilled", "requestedStop", "signal", "timeoutSeconds", "flyState", "eventType", "status",
  // ingest / output / storage (uids are not secrets; keys and passphrases never appear under these names)
  "uid", "inputUid", "videoUid", "outputUid", "ingestState", "outputState", "protocol", "connected", "live",
  // Dd: the `recording_finalised` event's per-video facts (Cloudflare's own size/duration/dimensions/status)
  "sizeBytes", "durationSeconds", "width", "height", "videoState", "errorReasonCode",
  "bitrateKbps", "fps", "droppedFrames", "cpuPct", "memMb", "encoderSpeed",
  // R2002: the rest of the Machine's beat, so a sample's raw keeps the WHOLE body (ruling 13) — the two R1 facts the
  // list had missed, and the R2 compositor's ten (compositor spec §5.3; C14, C15 and C17 read them over time). Enum
  // words, counts and booleans; `input`/`output` are link states on the beat, and as containers they keep only the
  // keys this list names (a composed session's input keeps its protocol and bare url, never its stream id or passphrase).
  "egressBytes", "measuredLatencyMs",
  "programmePhase", "input", "output", "graphics", "inputKicks", "inputKickAlert", "pipelineRebuilds", "sinkSwaps",
  "rung", "scoreStale",
  // …and its final beat's why (owner 2026-10-15): an enum word and compositor-redacted text (cut at `?` like any string).
  "exitReason", "exitDetail",
  "usedMinutes", "limitMinutes", "reservedMinutes", "headroomMinutes", "deleted", "deferred", "count",
  // effects / http
  "ok", "result", "httpStatus", "latencyMs", "retryAfterSeconds", "requestId", "errorCode", "operation", "provider", "method", "pathTemplate",
  // money (amounts and ids, never card data)
  "delta", "balanceAfter", "pack", "credits", "amountMinor", "currency", "checkoutSessionId", "paymentIntentId", "ledgerId",
  // client / admin actions
  "action", "actorUserId", "orgId", "sessionId", "fixtureId", "targetId", "destinationKind", "url", "watchUrl",
  // capture QR v2 (T6): who started it and the pairing it rode on (ids, never the phone's own id or the tok)
  "startCause", "pairingId",
  // capture QR v2 (T8b): the beat's slot events — a takeover's (dead phone? whom it replaced), a refused claim's row, an
  // ignored late stop (§6.8.2 T24a). Ids and booleans only.
  "dead", "replacedPairingId", "claimRow", "held",
  // nesting containers
  "outputs", "inputs", "samples", "summary",
]);

function cutString(s: string): string {
  const q = s.indexOf("?");
  const noQuery = q === -1 ? s : s.slice(0, q);
  return noQuery.length > EVENT_PAYLOAD_MAX_STRING ? noQuery.slice(0, EVENT_PAYLOAD_MAX_STRING) : noQuery;
}

function walk(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return cutString(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      const w = walk(val, depth + 1);
      if (w !== undefined) out[k] = w;
    }
    return out;
  }
  return undefined; // functions, symbols, bigints: not data
}

/** A relay token is a JWT: base64url `{"` is `eyJ`. Eight more characters make it a token's header (or more of one),
 *  never an ordinary word; the dotted segments after it ride along, so a FRAGMENT of a token is still caught. */
const JWT_SHAPED = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)*/g;
const REDACTED = "[redacted]";
/** Below this a "secret" would redact ordinary words — and the replacement could lengthen the text. */
const MIN_SECRET_LENGTH = REDACTED.length;

/** R2002 review Q3 — defence in depth for a Machine's free text (the final beat's `exitDetail`). The compositor redacts
 *  it before sending; the server scrubs it again before EITHER beat store keeps it: each named secret (the job token the
 *  handler holds) AND each of its dot-separated parts (confirm pass: a JWT's signature alone is not JWT-shaped), anything
 *  JWT-shaped, and everything from the first `?` (the cut `sanitise` makes for samples.raw, so both stores keep the same
 *  text). Never lengthens the text, and idempotent. */
export function scrubBeatText(text: string, secrets: readonly string[]): string {
  const redact = (from: string, patterns: readonly string[]): string =>
    patterns.filter((p) => p.length >= MIN_SECRET_LENGTH).reduce((acc, p) => acc.split(p).join(REDACTED), from);
  // Widest first, so each secret is ONE redaction: whole secrets, then any JWT-shaped run (a header with whatever of
  // the token follows it), then the secrets' own parts (what is left: a signature, or a payload, alone).
  let out = redact(text, secrets);
  out = out.replace(JWT_SHAPED, REDACTED);
  out = redact(out, secrets.flatMap((s) => s.split(".")));
  const q = out.indexOf("?");
  return q === -1 ? out : out.slice(0, q);
}

/** Allowlisted keys only; strings cut at `?` and at EVENT_PAYLOAD_MAX_STRING;
 *  depth ≤ 4; arrays ≤ 50. A non-object input is the empty payload. */
export function sanitise(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  return walk(input, 0) as Record<string, unknown>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_SEGMENT = /\/[0-9a-f]{12,}(?=\/|$)/gi;   // Fly machine ids (14 hex), Cloudflare uids (32 hex)

/** `https://host/v1/apps/relay/machines/abc?x=1` + ["abc"] → `/v1/apps/relay/machines/{id}`.
 *  Origin dropped, query dropped, each non-empty id → `{id}`, any residual uuid
 *  → `{uuid}`, any residual ≥12-hex path segment → `{id}`. The DDL CHECK on
 *  stream_provider_calls.path_template is the floor under this function. */
export function pathTemplate(url: string, ids: readonly string[]): string {
  let path = url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  for (const id of ids) {
    if (!id) continue;
    path = path.split(`/${id}/`).join("/{id}/");
    if (path.endsWith(`/${id}`)) path = path.slice(0, -id.length) + "{id}";
  }
  return path.replace(UUID, "{uuid}").replace(LONG_HEX_SEGMENT, "/{id}");
}

/** Replace every occurrence of every secret with `[redacted]`. Substring, not token —
 *  a provider that quotes our value inside a sentence of its own is exactly the case
 *  this exists for. An empty secret is skipped: `"".split("")` would shred the string.
 *
 *  It lives HERE, and no longer only in `fly-client.ts`, because the whole-branch review's I4 gave the SECOND
 *  adapter the same obligation: `ingest-cf.ts` interpolated Cloudflare's error message verbatim into a thrown
 *  Error while `addOutput` POSTs the organiser's real destination stream key. Two adapters needing the same
 *  three lines is not a reason for two copies, and the Cloudflare adapter importing the Fly one would couple
 *  two drivers that the ports/adapters split exists to keep independent. `fly-client.ts` re-exports it, so its
 *  consumers and tests keep one importable name. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join("[redacted]");
  return out;
}
