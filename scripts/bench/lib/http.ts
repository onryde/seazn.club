// A thin cookie-jar HTTP client + magic-link auth session for the bench,
// hand-copied from scripts/smoke.ts's own shapes (Session/newSession/
// cookieHeader at smoke.ts:43-50, raw() at :52-81, call() at :83-87,
// signIn() at :110-120) — never imported, per _RULES.md §1 and the B01
// brief ("no smoke.ts refactor", the 13k-line monolith stays untouched).
//
// Every function here takes `base` explicitly rather than reading a
// module-level env constant the way smoke.ts's own `const BASE =
// process.env.SMOKE_BASE ?? ...` (smoke.ts:24) does: bench.ts is the single
// place that resolves --base/env (and it DOES read SMOKE_BASE as one
// fallback, matching smoke.ts's convention — see bench.ts's own comment),
// so nothing in this file could ever disagree with it. That is what "don't
// reuse the exact var name" (B01 brief §3) buys in practice — there is no
// second, competing default living in this file at all.
export interface Session {
  cookies: Record<string, string>;
}

export function newSession(): Session {
  return { cookies: {} };
}

export function cookieHeader(s: Session): string {
  return Object.entries(s.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export interface RawJson {
  ok: boolean;
  data?: unknown;
  error?: string;
  issues?: { path?: unknown[] }[];
}

export interface RawResult {
  status: number;
  json: RawJson;
}

/** fetch + Set-Cookie jar bookkeeping. Mirrors smoke.ts's `raw()` exactly. */
export async function raw(base: string, s: Session, path: string, method = "GET", body?: unknown): Promise<RawResult> {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    if (m[2] === "") delete s.cookies[m[1]];
    else s.cookies[m[1]] = m[2];
  }
  const json = (await res.json().catch(() => ({ ok: false, error: "no json" }))) as RawJson;
  return { status: res.status, json };
}

/** Unwraps `{ ok, data }`, throwing on `ok === false`. Mirrors smoke.ts's
 *  `call()`. Prefer `request()` below for new bench suite code — it
 *  captures the response body on failure instead of just `error`. */
export async function call(base: string, s: Session, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const { json } = await raw(base, s, path, method, body);
  if (json.ok === false) throw new Error(`${path}: ${json.error}`);
  return json.data;
}

/**
 * Passwordless sign-in: request a magic link, then consume the dev-exposed
 * token (mirrors smoke.ts:110-120 exactly). An unknown email creates the
 * account, plus a default org auto-provisioned on first sign-in.
 */
export async function signIn(
  base: string,
  s: Session,
  email: string,
): Promise<{ has_org: boolean; org_id: string; redirect: string }> {
  const req = (await call(base, s, "/api/auth/magic-link", "POST", { email })) as { login_url?: string };
  const token = new URL(req.login_url ?? "").searchParams.get("token");
  return (await call(base, s, "/api/auth/magic-link/consume", "POST", { token })) as {
    has_org: boolean;
    org_id: string;
    redirect: string;
  };
}

/** Thrown by `request()` on any unexpected 4xx/5xx — carries the response
 *  body so the report can show exactly what the API rejected. */
export class BenchHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`${path}: unexpected HTTP ${status} — ${safeStringify(body)}`);
    this.name = "BenchHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Statuses this call treats as a legitimate outcome rather than a
   *  gate-red failure — e.g. a probe that deliberately expects a 404.
   *  Empty by default: any 4xx/5xx not listed here fails the run. */
  allowStatus?: number[];
}

/**
 * Typed request helper: returns `data` on success. Any 4xx/5xx NOT in
 * `allowStatus` throws `BenchHttpError` with the response body attached —
 * this is what makes an unexpected API rejection a gate-red for the run
 * (B01 brief: "FAILS the run ... with the body captured") rather than a
 * silent `undefined` a caller has to remember to check for.
 */
export async function request<T>(base: string, s: Session, path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, allowStatus = [] } = opts;
  const { status, json } = await raw(base, s, path, method, body);
  if (allowStatus.includes(status)) return json.data as T;
  if (status >= 400 || json.ok === false) {
    throw new BenchHttpError(path, status, json);
  }
  return json.data as T;
}
