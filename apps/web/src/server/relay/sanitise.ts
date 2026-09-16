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
  "mode", "slot", "attempt", "attempts", "retries", "expiry", "deadlineAt", "at", "seconds", "minutes",
  // runner / Fly (config.env VALUES are never here — only ids and states)
  "runnerState", "observed", "machineId", "machineName", "region", "cpus", "memoryMb", "cpuKind", "instanceId",
  "exit", "exitCode", "oomKilled", "requestedStop", "signal", "timeoutSeconds", "flyState", "eventType", "status",
  // ingest / output / storage (uids are not secrets; keys and passphrases never appear under these names)
  "uid", "inputUid", "videoUid", "outputUid", "ingestState", "outputState", "protocol", "connected", "live",
  // Dd: the `recording_finalised` event's per-video facts (Cloudflare's own size/duration/dimensions/status)
  "sizeBytes", "durationSeconds", "width", "height", "videoState", "errorReasonCode",
  "bitrateKbps", "fps", "droppedFrames", "cpuPct", "memMb", "encoderSpeed",
  "usedMinutes", "limitMinutes", "reservedMinutes", "headroomMinutes", "deleted", "deferred", "count",
  // effects / http
  "ok", "result", "httpStatus", "latencyMs", "retryAfterSeconds", "requestId", "errorCode", "operation", "provider", "method", "pathTemplate",
  // money (amounts and ids, never card data)
  "delta", "balanceAfter", "pack", "credits", "amountMinor", "currency", "checkoutSessionId", "paymentIntentId", "ledgerId",
  // client / admin actions
  "action", "actorUserId", "orgId", "sessionId", "fixtureId", "targetId", "destinationKind", "url", "watchUrl",
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
