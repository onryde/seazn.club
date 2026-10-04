// server/api-v1/capture-http.ts — the phone-facing wire (capture QR v2 §6.3, the `capture-*` contracts). T5 created it
// for `resolveStreamCode`'s refusal; T8a adds the wire mapping the three phone routes share:
//  - every 2xx is the BARE contract shape (no `{ok, data}` envelope), and every refusal is `{code, message}` — only
//    `already_live` carries extras (`{sid, startedBy}`, contract R5);
//  - EVERY answer, error paths included, is `Cache-Control: private, no-store` + `Pragma: no-cache` (§6.3, §9): a
//    descriptor carries live ingest credentials, and a cached refusal would outlive the state it describes.
// The `code` is the contract's closed `CaptureRefusalCode` list, so a refusal the phone cannot key its copy on does not
// compile.
import { HttpError, handler } from "@/lib/http";
import { CAPTURE_CODE_LIMIT, CAPTURE_FAIL_LIMIT, CAPTURE_START_LIMIT, rateLimit, rateLimitPeek } from "@/lib/rate-limit";
import { normaliseCode } from "@/server/relay/domain/stream-code";
import type { CaptureRefusalCode } from "./capture-schemas";

export class CaptureRefusalError extends Error {
  constructor(
    readonly status: number,
    readonly code: CaptureRefusalCode,
    message: string,
    /** Only `already_live` carries extras on the wire (`{sid, startedBy}`, contract R5). */
    readonly extras?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CaptureRefusalError";
  }
}

/** C1: ONE sentence for every refusal of a code — unknown, wrong tok, ended, and (A17) a missing or malformed Bearer —
 *  so the wire never tells them apart. `resolveStreamCode` and `captureBearer` both throw this. */
export const codeEnded = (): CaptureRefusalError => new CaptureRefusalError(401, "code_ended", "this stream code is no longer valid");

const NO_STORE = { "cache-control": "private, no-store", pragma: "no-cache" } as const;

/** A bare JSON answer with the capture cache headers. `headers` (e.g. `Retry-After`) are added; the two cache headers
 *  are applied LAST, so no caller can serve a cacheable capture answer. */
export function captureJson(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json", ...NO_STORE },
  });
}

/** The contract's refusal body. Extras ride ONLY on `already_live` (R5): anything else carrying them is a programming
 *  error, refused by name rather than leaked onto a strict wire. */
export function captureRefusal(e: CaptureRefusalError): Response {
  if (e.extras !== undefined && e.code !== "already_live") {
    throw new RangeError(`captureRefusal: only already_live carries extras on the wire, not ${e.code}`);
  }
  return captureJson(e.status, { code: e.code, message: e.message, ...(e.code === "already_live" ? e.extras : {}) });
}

/**
 * Run a phone route inside `handler()` (request context, Sentry and the logger for anything unmapped) and map the
 * capture refusals to bare bodies: a `CaptureRefusalError`, and the rate limiter's `HttpError(429)` → `rate_limited`
 * (its headers, e.g. `Retry-After`, ride along when the error carries them). Whatever comes out — a 2xx, a refusal or
 * an unmapped 500 — leaves with the capture cache headers.
 */
export async function captureRoute(fn: () => Promise<Response>): Promise<Response> {
  const res = await handler(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CaptureRefusalError) return captureRefusal(e);
      if (e instanceof HttpError && e.status === 429) {
        return captureJson(429, { code: "rate_limited", message: e.message }, e.headers);
      }
      throw e;
    }
  });
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

/** A17: the capture Bearer. A missing header and a malformed one ("Bearer" with no token, another scheme, extra parts)
 *  all throw `codeEnded()` — the same body as a wrong tok or an ended code, so the wire never tells them apart. NOT
 *  relay/bearer.ts's `bearerOf`, which answers `HttpError(401, …, "RELAY_TOKEN_INVALID")`. */
export function captureBearer(req: Request): string {
  const m = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw codeEnded();
  return m[1]!;
}

/** The client IP the failed-401 budget is keyed on: the first X-Forwarded-For hop (Fly / Cloudflare set it), else
 *  X-Real-IP — the idiom every per-IP limiter in this app uses. */
function clientIpOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/**
 * A phone route with its rate limits (§10.4, amended §17.4), inside `captureRoute`, in this order:
 *  1. an IP already past its failed-401 budget is refused BEFORE anything is read (`rateLimitPeek`): every request,
 *     the right tok included, so a guess cannot be told from a hit;
 *  2. the code's own budget is spent — ONE budget across the three routes — and a start spends its own on top. Only a
 *     well-formed code has a budget (a malformed one is the use-case's 404, read from nothing);
 *  3. the route runs; a 401 it answers spends the IP's failure budget, and the one that crosses it answers 429.
 * Every 429 is the bare `{code: rate_limited, message}` with `Retry-After` = the window's true remaining seconds.
 */
export async function capturePhoneRoute(
  req: Request, rawCode: string, route: "get" | "beats" | "start", fn: () => Promise<Response>,
): Promise<Response> {
  return captureRoute(async () => {
    const failKey = `capture-fail:${clientIpOf(req)}`;
    await rateLimitPeek(failKey, CAPTURE_FAIL_LIMIT);
    const code = normaliseCode(rawCode);
    if (code !== null) {
      await rateLimit(`capture-code:${code}`, CAPTURE_CODE_LIMIT);
      if (route === "start") await rateLimit(`capture-start:${code}`, CAPTURE_START_LIMIT);
    }
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CaptureRefusalError && e.status === 401) await rateLimit(failKey, CAPTURE_FAIL_LIMIT);
      throw e;
    }
  });
}
