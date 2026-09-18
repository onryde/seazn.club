"use client";

import { orgScopeHeaders } from "@/lib/org-scope";

/** The error `api()` throws, carrying the HTTP status alongside the message.
 *
 *  ADDITIVE on purpose: the `message` is unchanged, so every existing caller
 *  that renders `err.message` behaves exactly as before. The status is what a
 *  caller needs to choose TRANSLATED copy per refusal instead of printing the
 *  server's English — `api()` used to throw a bare Error, so a client had the
 *  sentence and nothing else, and untranslated server copy on screen was the
 *  only thing it could do.
 *
 *  Not an `ApiV1Error`: that one belongs to the v1 envelope (it also carries a
 *  machine `code`), and these legacy routes answer `{ ok, error }`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Minimal JSON fetch helper for client components. */
export async function api<T = unknown>(
  url: string,
  options?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = options ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      // WHICH organisation this call is for, read from the console URL on
      // screen. The billing routes would otherwise resolve it from the
      // `seazn_org` cookie, which lags a navigation by one client effect and so
      // answers with the PREVIOUS billing group (v17 gap #334). Empty off the
      // `/o/[orgSlug]` tree, and placed BEFORE the caller's own headers so an
      // explicit override still wins.
      ...orgScopeHeaders(),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    // A 402 upgrade error carries a human `reason` (feature-copy) alongside the
    // raw `error`, which leaks the internal feature key ("Plan upgrade required:
    // orgs.max_owned"). Prefer the reason so a form shows the sentence, not the
    // key. Everything else keeps its `error` message.
    throw new ApiError(
      payload?.reason || payload?.error || `Request failed (${res.status})`,
      res.status,
    );
  }
  return payload.data as T;
}
