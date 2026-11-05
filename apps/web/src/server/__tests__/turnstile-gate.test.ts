// The Turnstile gate on the six public POSTs, driven through the REAL route handlers: login, start, register, resend, join,
// withdraw. server/__tests__/turnstile.test.ts proves the judgement; THIS file proves each route actually asks, asks for ITS
// action, asks before it reads a body, and asks after its first rate limit and not before it.
//
// What "the handler body did not run" means here: every one of the six reads its body with `req.json()` (directly, or through
// `parseBody`), so a request spied on `json` that is refused with that spy untouched never got past the gate. That is a
// stronger claim than "returned 403" (a gate placed after the read would also return 403) and needs no usecase mocked.
//
// The six surfaces are typed from the brief; the sweep cross-checks them against the actions lib/turnstile.ts DECLARES, so a
// seventh declared action with no surface here fails the count rather than going unguarded.
//
// Cloudflare is a stateful fake (global `fetch`): a token is good once, exactly as siteverify says.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({ calls: 0, refuse: false }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {
    limiter.calls++;
    if (limiter.refuse) {
      const { HttpError } = await import("@/lib/errors");
      throw new HttpError(429, "Too many requests", "RATE_LIMITED");
    }
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.77" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
// The two usecases a VALID body would reach (resend, withdraw), so the good-token case can prove the real work is called.
const usecase = vi.hoisted(() => ({
  resend: vi.fn(async () => ({ sent: true })),
  withdraw: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  resendRegistrationConfirmationPublic: usecase.resend,
  withdrawRegistrationByRef: usecase.withdraw,
}));

import { TURNSTILE_ACTIONS, TURNSTILE_ERROR_CODE, TURNSTILE_HEADER, type TurnstileAction } from "@/lib/turnstile";
import { SITEVERIFY_URL } from "../turnstile";
import { POST as login } from "@/app/api/auth/magic-link/route";
import { POST as start } from "@/app/api/funnel/start/route";
import { POST as register } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route";
import { POST as join } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route";
import { POST as resend } from "@/app/api/v1/public/registrations/groups/[id]/resend/route";
import { POST as withdraw } from "@/app/api/v1/public/registrations/by-ref/[ref]/withdraw/route";

const SECRET = "1x0000000000000000000000000000000AA"; // Cloudflare's published always-pass test secret
const HOST = "stg.seazn.test";
const GROUP = "00000000-0000-4000-8000-000000000001";
const ENTRY = "00000000-0000-4000-8000-000000000002";

type Surface = {
  name: string;
  action: TurnstileAction;
  call: (req: Request) => Promise<Response>;
  /** A body the route accepts. `valid` lets resend/withdraw reach their (mocked) usecase; the other four have no mocked work, so
   *  they are driven with `{}` and "reached the body" is `req.json` having been read (they answer 400 from their own schema). */
  validBody?: unknown;
  usecase?: ReturnType<typeof vi.fn>;
};

const SURFACES: Surface[] = [
  { name: "login (POST /api/auth/magic-link)", action: "login", call: (r) => login(r) },
  { name: "start (POST /api/funnel/start)", action: "start", call: (r) => start(r) },
  {
    name: "register (POST .../register)",
    action: "register",
    call: (r) => register(r, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) }),
  },
  {
    name: "join (POST .../register/join)",
    action: "join",
    call: (r) => join(r, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) }),
  },
  {
    name: "resend (POST .../groups/{id}/resend)",
    action: "resend",
    call: (r) => resend(r, { params: Promise.resolve({ id: GROUP }) }),
    validBody: { token: "registrant-token-0123456789" },
    usecase: usecase.resend,
  },
  {
    name: "withdraw (POST .../by-ref/{ref}/withdraw)",
    action: "withdraw",
    call: (r) => withdraw(r, { params: Promise.resolve({ ref: "AB12CD" }) }),
    validBody: { token: "registrant-token-0123456789", registration_id: ENTRY },
    usecase: usecase.withdraw,
  },
];

// A stateful Cloudflare: a minted token is accepted once and only for the action and host it was minted for.
const cf = (() => {
  const minted = new Map<string, { action: string; hostname: string; spent: boolean }>();
  let n = 0;
  const seen: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(url));
    const form = new URLSearchParams(String(init?.body));
    const t = minted.get(form.get("response") ?? "");
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (form.get("secret") !== SECRET || !t) return reply({ success: false, "error-codes": ["invalid-input-response"] });
    if (t.spent) return reply({ success: false, "error-codes": ["timeout-or-duplicate"] });
    t.spent = true;
    return reply({ success: true, hostname: t.hostname, action: t.action, "error-codes": [] });
  });
  return {
    impl,
    seen,
    mint: (action: string, hostname = HOST) => {
      const token = `0.gate-${++n}-${action}`;
      minted.set(token, { action, hostname, spent: false });
      return token;
    },
    reset: () => {
      minted.clear();
      seen.length = 0;
      impl.mockClear();
    },
  };
})();

/** A POST whose `json` reader is spied: the proof the body was (not) read. */
function post(body: unknown, headers: Record<string, string> = {}) {
  const req = new Request("https://x.test/api/any", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const json = vi.spyOn(req, "json");
  return { req, json };
}

/** Production, on a named deployment, with the secret and the allowed host set: the only mode that checks. */
function enforce() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENV_NAME", "stg");
  vi.stubEnv("TURNSTILE_SECRET", SECRET);
  vi.stubEnv("TURNSTILE_HOSTNAMES", HOST);
}

beforeEach(() => {
  vi.clearAllMocks();
  cf.reset();
  limiter.calls = 0;
  limiter.refuse = false;
  vi.stubGlobal("fetch", cf.impl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const envelopeCode = async (res: Response): Promise<string | undefined> => {
  const b = (await res.json()) as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code; // /api/v1 nests it under `error`, the legacy envelope puts it beside `error`
};

describe("the six surfaces are exactly the declared actions", () => {
  it("one surface per action declared in lib/turnstile.ts, none twice", () => {
    expect(SURFACES.map((s) => s.action).sort()).toEqual([...TURNSTILE_ACTIONS].sort());
    expect(SURFACES).toHaveLength(6);
  });

  // The per-surface "the work did / did not run" checks are guarded by `if (s.usecase)`; if that were silently false everywhere they
  // would assert nothing. Two surfaces (resend, withdraw) have a mocked usecase to watch, so exactly two must.
  it("anti-vacuity: the usecase-watching assertions reach exactly resend and withdraw", () => {
    expect(SURFACES.filter((s) => s.usecase).map((s) => s.action).sort()).toEqual(["resend", "withdraw"]);
  });
});

describe.each(SURFACES)("$name", (s) => {
  it("enforce mode, no token: 403 TURNSTILE_FAILED before the body is read", async () => {
    enforce();
    const { req, json } = post(s.validBody);
    const res = await s.call(req);
    expect(res.status).toBe(403);
    expect(await envelopeCode(res)).toBe(TURNSTILE_ERROR_CODE);
    expect(json, "the body must not be read").not.toHaveBeenCalled();
    if (s.usecase) expect(s.usecase).not.toHaveBeenCalled();
    expect(cf.impl, "a request with no token never costs a call to Cloudflare").not.toHaveBeenCalled();
  });

  it("enforce mode, a token Cloudflare refuses: 403 before the body is read", async () => {
    enforce();
    const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: "never-minted" });
    const res = await s.call(req);
    expect(res.status).toBe(403);
    expect(await envelopeCode(res)).toBe(TURNSTILE_ERROR_CODE);
    expect(json).not.toHaveBeenCalled();
    expect(cf.seen).toEqual([SITEVERIFY_URL]);
  });

  it("enforce mode, a good token minted for THIS action: the gate opens and the body is read (the positive pair)", async () => {
    enforce();
    const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: cf.mint(s.action) });
    const res = await s.call(req);
    expect(res.status, "not the gate's refusal").not.toBe(403);
    expect(json, "the handler body ran").toHaveBeenCalledTimes(1);
    if (s.usecase) expect(s.usecase).toHaveBeenCalledTimes(1);
    expect(cf.seen).toEqual([SITEVERIFY_URL]);
  });

  it("enforce mode, a token minted for EVERY OTHER action is refused (the route asks for its own action)", async () => {
    enforce();
    let checked = 0;
    for (const other of TURNSTILE_ACTIONS.filter((a) => a !== s.action)) {
      const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: cf.mint(other) });
      const res = await s.call(req);
      expect([other, res.status]).toEqual([other, 403]);
      expect(json).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(TURNSTILE_ACTIONS.length - 1);
  });

  it("enforce mode, a token minted on another host is refused", async () => {
    enforce();
    const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: cf.mint(s.action, "evil.example") });
    expect((await s.call(req)).status).toBe(403);
    expect(json).not.toHaveBeenCalled();
  });

  it("replay: the same token spent twice opens the gate once", async () => {
    enforce();
    const token = cf.mint(s.action);
    const first = post(s.validBody, { [TURNSTILE_HEADER]: token });
    expect((await s.call(first.req)).status, "first use").not.toBe(403);
    expect(first.json).toHaveBeenCalledTimes(1);
    const second = post(s.validBody, { [TURNSTILE_HEADER]: token });
    const res = await s.call(second.req);
    expect(res.status, "second use of the same token").toBe(403);
    expect(await envelopeCode(res)).toBe(TURNSTILE_ERROR_CODE);
    expect(second.json).not.toHaveBeenCalled();
  });

  it("a deployment whose secret is gone: 403 for everyone, a plausible token included, with no call to Cloudflare", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("TURNSTILE_SECRET", "");
    const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: cf.mint(s.action) });
    expect((await s.call(req)).status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(cf.impl).not.toHaveBeenCalled();
  });

  it("skip mode (vitest, dev, a harness server): no token needed, the body is read, Cloudflare is not called", async () => {
    const { req, json } = post(s.validBody); // NODE_ENV is "test"
    expect((await s.call(req)).status).not.toBe(403);
    expect(json).toHaveBeenCalledTimes(1);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "ci");
    const harness = post(s.validBody);
    expect((await s.call(harness.req)).status).not.toBe(403);
    expect(harness.json).toHaveBeenCalledTimes(1);
    expect(cf.impl).not.toHaveBeenCalled();
  });

  it("sits AFTER the first rate limit and not before it: a throttled request is refused by the limiter, never reaches Cloudflare", async () => {
    enforce();
    limiter.refuse = true;
    const { req, json } = post(s.validBody, { [TURNSTILE_HEADER]: cf.mint(s.action) });
    const res = await s.call(req);
    expect(res.status).toBe(429);
    expect(json).not.toHaveBeenCalled();
    expect(cf.impl).not.toHaveBeenCalled();
  });

  it("a refused token spends exactly ONE limiter hit (the first), so a failed check does not burn the narrower buckets", async () => {
    enforce();
    const { req } = post(s.validBody, { [TURNSTILE_HEADER]: "never-minted" });
    await s.call(req);
    expect(limiter.calls).toBe(1);
  });
});
