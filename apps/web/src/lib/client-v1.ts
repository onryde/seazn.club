"use client";

// Fetch helper for the /api/v1 envelope ({ ok, data | error, requestId } —
// doc 08 §1). Errors carry the typed code so callers can branch on
// SEQ_CONFLICT (resync) and PAYMENT_REQUIRED (upgrade gate).
export class ApiV1Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiV1Error";
  }
}

export async function apiV1<T = unknown>(
  url: string,
  options?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = options ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  // A body that is not JSON (a proxy's HTML 502) defaults to `{}` so the
  // status check below still throws a typed `ApiV1Error`. An ABORT is not
  // that: a signal that fires after the headers errors the body stream, and
  // defaulting it made a 200 resolve with `undefined` — which a bounded
  // refresh then wrote into its live state and crashed the next render on
  // (G1 review round 1). So an aborted read rethrows its own abort, and a
  // caller that tells "superseded" from "failed" by `AbortError` still can.
  const payload = (await res.json().catch((err: unknown) => {
    if (rest.signal?.aborted) throw err;
    return {};
  })) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; [k: string]: unknown };
  };
  if (!res.ok || payload.ok === false) {
    const { code = "UNKNOWN", message, ...extra } = payload.error ?? {};
    throw new ApiV1Error(message ?? `Request failed (${res.status})`, res.status, code, extra);
  }
  return payload.data as T;
}
