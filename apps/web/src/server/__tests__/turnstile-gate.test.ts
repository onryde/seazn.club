// The Turnstile gate on the public POSTs, driven through the REAL route handlers: login, start, register, resend, join, and
// withdraw (two routes share that action: the by-ref one and the registration-id one).
// server/__tests__/turnstile.test.ts proves the judgement; THIS file proves each route actually asks, asks for ITS
// action, asks before it reads a body, and asks after its first rate limit and not before it.
//
// What "the handler body did not run" means here: every one of the six reads its body with `req.json()` (directly, or through
// `parseBody`), so a request spied on `json` that is refused with that spy untouched never got past the gate. That is a
// stronger claim than "returned 403" (a gate placed after the read would also return 403) and needs no usecase mocked.
//
// The surfaces are typed from the brief; two sweeps cross-check them. One against the actions lib/turnstile.ts DECLARES (a
// declared action with no surface fails). One against the route TREE (every non-GET handler under app/api/v1/public, auth,
// funnel and consent is either a surface here or on a reviewed exempt list with a reason; a new public POST that is neither
// fails, so it cannot ship ungated by omission).
//
// Cloudflare is a stateful fake (global `fetch`): a token is good once, exactly as siteverify says.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
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
// The usecases a VALID body would reach (resend, both withdraws), so the good-token case can prove the real work is called.
const usecase = vi.hoisted(() => ({
  resend: vi.fn(async () => ({ sent: true })),
  withdraw: vi.fn(async () => ({ ok: true })),
  withdrawPublic: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  resendRegistrationConfirmationPublic: usecase.resend,
  withdrawRegistrationByRef: usecase.withdraw,
  withdrawRegistrationPublic: usecase.withdrawPublic,
}));

// The join preview GET reads through this; mocked so the un-gated GET provably reaches its usecase (join POST is left real: it
// is refused before its usecase, and answers 400 from its own schema when let through).
const preview = vi.hoisted(() => ({ fn: vi.fn(async () => ({ team_name: "Reds" })) }));
vi.mock("@/server/usecases/registration-submit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registration-submit")>()),
  previewJoinEntry: preview.fn,
}));

import { TURNSTILE_ACTIONS, TURNSTILE_ERROR_CODE, TURNSTILE_HEADER, type TurnstileAction } from "@/lib/turnstile";
import { SITEVERIFY_URL } from "../turnstile";
import { POST as login } from "@/app/api/auth/magic-link/route";
import { POST as start } from "@/app/api/funnel/start/route";
import { POST as register } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route";
import { POST as join } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route";
import { POST as resend } from "@/app/api/v1/public/registrations/groups/[id]/resend/route";
import { POST as withdraw } from "@/app/api/v1/public/registrations/by-ref/[ref]/withdraw/route";
import { POST as withdrawById } from "@/app/api/v1/public/registrations/[id]/withdraw/route";
import { GET as joinPreview } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route";

const SECRET = "1x0000000000000000000000000000000AA"; // Cloudflare's published always-pass test secret
const HOST = "stg.seazn.test";
const GROUP = "00000000-0000-4000-8000-000000000001";
const ENTRY = "00000000-0000-4000-8000-000000000002";

type Surface = {
  name: string;
  /** The route file under src/app/api: the route-tree sweep ties a handler to its surface by this path. */
  file: string;
  action: TurnstileAction;
  call: (req: Request) => Promise<Response>;
  /** A body the route accepts. `valid` lets resend/withdraw reach their (mocked) usecase; the other four have no mocked work, so
   *  they are driven with `{}` and "reached the body" is `req.json` having been read (they answer 400 from their own schema). */
  validBody?: unknown;
  usecase?: ReturnType<typeof vi.fn>;
};

const SURFACES: Surface[] = [
  { name: "login (POST /api/auth/magic-link)", file: "auth/magic-link/route.ts", action: "login", call: (r) => login(r) },
  { name: "start (POST /api/funnel/start)", file: "funnel/start/route.ts", action: "start", call: (r) => start(r) },
  {
    name: "register (POST .../register)",
    file: "v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts",
    action: "register",
    call: (r) => register(r, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) }),
  },
  {
    name: "join (POST .../register/join)",
    file: "v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route.ts",
    action: "join",
    call: (r) => join(r, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) }),
  },
  {
    name: "resend (POST .../groups/{id}/resend)",
    file: "v1/public/registrations/groups/[id]/resend/route.ts",
    action: "resend",
    call: (r) => resend(r, { params: Promise.resolve({ id: GROUP }) }),
    validBody: { token: "registrant-token-0123456789" },
    usecase: usecase.resend,
  },
  {
    name: "withdraw (POST .../by-ref/{ref}/withdraw)",
    file: "v1/public/registrations/by-ref/[ref]/withdraw/route.ts",
    action: "withdraw",
    call: (r) => withdraw(r, { params: Promise.resolve({ ref: "AB12CD" }) }),
    validBody: { token: "registrant-token-0123456789", registration_id: ENTRY },
    usecase: usecase.withdraw,
  },
  {
    name: "withdraw by id (POST .../registrations/{id}/withdraw)",
    file: "v1/public/registrations/[id]/withdraw/route.ts",
    action: "withdraw",
    call: (r) => withdrawById(r, { params: Promise.resolve({ id: ENTRY }) }),
    validBody: { token: "registrant-token-0123456789" },
    usecase: usecase.withdrawPublic,
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

describe("the surfaces cover exactly the declared actions", () => {
  it("every action declared in lib/turnstile.ts has a surface; only withdraw has two (by-ref and by-id)", () => {
    expect([...new Set(SURFACES.map((s) => s.action))].sort()).toEqual([...TURNSTILE_ACTIONS].sort());
    const perAction = new Map<string, number>();
    for (const s of SURFACES) perAction.set(s.action, (perAction.get(s.action) ?? 0) + 1);
    expect(Object.fromEntries(perAction)).toEqual({
      ...Object.fromEntries(TURNSTILE_ACTIONS.map((a) => [a, 1])),
      withdraw: 2,
    });
    expect(SURFACES).toHaveLength(7);
    expect(new Set(SURFACES.map((s) => s.file)).size, "one route file per surface").toBe(SURFACES.length);
  });

  // The per-surface "the work did / did not run" checks are guarded by `if (s.usecase)`; if that were silently false everywhere they
  // would assert nothing. Three surfaces (resend, both withdraws) have a mocked usecase to watch, so exactly three must.
  it("anti-vacuity: the usecase-watching assertions reach exactly resend and the two withdraws", () => {
    expect(SURFACES.filter((s) => s.usecase).map((s) => s.action).sort()).toEqual(["resend", "withdraw", "withdraw"]);
  });
});

describe("TURNSTILE=off opens EVERY gated route, and only that value does", () => {
  it("sweep: with the switch on and the check otherwise enforced, every surface lets a token-less request through", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      enforce();
      vi.stubEnv("TURNSTILE", "off");
      const { req, json } = post(s.validBody);
      const res = await s.call(req);
      expect([s.name, res.status === 403]).toEqual([s.name, false]);
      expect([s.name, json.mock.calls.length]).toEqual([s.name, 1]);
      checked++;
    }
    expect(checked, "gated routes opened by the switch").toBe(SURFACES.length);
    expect(checked).toBe(7);
    expect(cf.impl, "never asked Cloudflare").not.toHaveBeenCalled();
  });

  it("and the same sweep with the switch unset refuses every one of them (the positive pair: the sweep is not vacuous)", async () => {
    let checked = 0;
    for (const s of SURFACES) {
      enforce();
      const { req, json } = post(s.validBody);
      expect([s.name, (await s.call(req)).status]).toEqual([s.name, 403]);
      expect(json).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(SURFACES.length);
  });

  it("the surfaces swept ARE the gated routes found in the tree, so a gated route with no surface cannot dodge the switch test", () => {
    const gatedFiles = sweptWriteRoutes.filter((r) => r.actions.length > 0).map((r) => r.file).sort();
    expect(gatedFiles.length).toBeGreaterThan(0);
    expect(gatedFiles).toEqual(SURFACES.map((s) => s.file).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The route-tree sweep. The surfaces above prove each GATED route; nothing there can see a public POST that was never gated.
// This reads the source of every route file under the public/auth/funnel/consent trees, finds each exported non-GET handler, and
// requires it to be either a surface above or on EXEMPT with a reason. Reading source is the point: a route nobody remembered to
// add to SURFACES is exactly the one that needs to fail.
// ---------------------------------------------------------------------------------------------------------------------------
const API_DIR = resolve(import.meta.dirname, "../../app/api");
const SWEPT_ROOTS = ["v1/public", "auth", "funnel", "consent"];
const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** The non-GET verbs a route module EXPORTS as handlers: `export function POST`, `export const POST =`, `export { x as POST }`.
 *  An outbound `fetch(url, { method: "POST" })` is not an export and must not count (auth/google/callback has one). */
function exportedWriteVerbs(src: string): string[] {
  const verbs = new Set<string>();
  const verb = WRITE_VERBS.join("|");
  for (const m of src.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${verb})\\b`, "g"))) verbs.add(m[1]!);
  for (const m of src.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${verb})\\b`, "g"))) verbs.add(m[1]!);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const spec of m[1]!.split(",")) {
      const exported = spec.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if ((WRITE_VERBS as readonly string[]).includes(exported)) verbs.add(exported);
    }
  }
  return [...verbs].sort();
}

/** The actions a route file asks Cloudflare for: every `requireTurnstile(req, "<action>")` in it. */
function gatedActions(src: string): string[] {
  return [...src.matchAll(/\brequireTurnstile\(\s*req\s*,\s*"([a-z]+)"\s*\)/g)].map((m) => m[1]!);
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

/** Non-GET handlers that are deliberately NOT bot-checked. Reviewed 2026-11-05; each needs a reason a future reader can disagree with. */
const EXEMPT: Record<string, string> = {
  "auth/change-email/route.ts": "needs a signed-in session (requireUser); not an anonymous surface",
  "auth/logout/route.ts": "ends the caller's own session; sends no mail and writes nothing a bot can use",
  "auth/magic-link/consume/route.ts": "redeems an emailed one-time token: the token is the credential, spent on use, per-IP AUTH_LIMIT",
  "auth/verify-email/route.ts": "redeems an emailed one-time token: the token is the credential, per-IP AUTH_LIMIT",
  "funnel/claim/route.ts": "redeems an emailed one-time funnel token: the token is the credential, per-IP AUTH_LIMIT",
  "funnel/remind/route.ts": "cron endpoint behind the x-cron-secret header; never reached from a browser",
  "consent/route.ts": "cookie-consent receipt: writes one row, sends no mail, per-IP CONSENT_LIMIT; a challenge would block the banner itself",
  "v1/public/registrations/[id]/checkout/route.ts": "pay: needs the registrant's own token for an existing registration, per-IP CHECKOUT_LIMIT; revisit if Checkout Session spend becomes a target",
};

const sweptWriteRoutes = SWEPT_ROOTS.flatMap((root) => routeFiles(resolve(API_DIR, root)))
  .map((abs) => ({ file: relative(API_DIR, abs), src: readFileSync(abs, "utf8") }))
  .map((r) => ({ ...r, verbs: exportedWriteVerbs(r.src), actions: gatedActions(r.src) }))
  .filter((r) => r.verbs.length > 0);

describe("route-tree sweep: every public non-GET handler is gated or reviewed-exempt", () => {
  it("the detectors see each export form and ignore an outbound fetch method (a detector that finds nothing proves nothing)", () => {
    expect(exportedWriteVerbs("export async function POST(req: Request) {}")).toEqual(["POST"]);
    expect(exportedWriteVerbs("export function DELETE() {}\nexport const PATCH = handler(x);")).toEqual(["DELETE", "PATCH"]);
    expect(exportedWriteVerbs("const h = x;\nexport { h as PUT, other, GET, POST };")).toEqual(["POST", "PUT"]);
    expect(exportedWriteVerbs('export async function GET() {}\nawait fetch(u, { method: "POST" });')).toEqual([]);
    expect(gatedActions('await requireTurnstile(req, "login");\nawait requireTurnstile( req ,"join" )')).toEqual(["login", "join"]);
    expect(gatedActions("// requireTurnstile is mentioned here\nawait other(req, 'login')")).toEqual([]);
  });

  it("anti-vacuity: the sweep found the route tree (every surface file, every exempt file) and checked a real number of routes", () => {
    const found = new Set(sweptWriteRoutes.map((r) => r.file));
    // 7 gated + 8 exempt. Typed here, not derived from the lists under test: a lost directory or a broken walker shrinks this.
    expect(sweptWriteRoutes.length, "non-GET route files found").toBe(15);
    for (const s of SURFACES) expect(found.has(s.file), `${s.file} is a swept write route`).toBe(true);
    for (const f of Object.keys(EXEMPT)) expect(found.has(f), `${f} is a swept write route`).toBe(true);
  });

  it("every swept non-GET route is a surface (gated for its declared action) or exempt, never both, never neither", () => {
    const surfaceByFile = new Map(SURFACES.map((s) => [s.file, s.action]));
    let checked = 0;
    for (const r of sweptWriteRoutes) {
      const exempt = r.file in EXEMPT;
      const surface = surfaceByFile.get(r.file);
      expect([r.file, "gated or exempt, not both", exempt !== (surface !== undefined)]).toEqual([r.file, "gated or exempt, not both", true]);
      if (surface) expect([r.file, r.actions]).toEqual([r.file, [surface]]);
      else expect([r.file, "exempt route must not call the gate", r.actions]).toEqual([r.file, "exempt route must not call the gate", []]);
      checked++;
    }
    expect(checked, "routes checked").toBe(sweptWriteRoutes.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every exempt entry carries a reason", () => {
    expect(Object.keys(EXEMPT).length).toBeGreaterThan(0);
    for (const [file, why] of Object.entries(EXEMPT)) expect([file, why.length > 20]).toEqual([file, true]);
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

  it("TURNSTILE=off (enforce mode otherwise): no token needed, the body is read, the work runs, Cloudflare is not called", async () => {
    enforce();
    vi.stubEnv("TURNSTILE", "off");
    const { req, json } = post(s.validBody);
    const res = await s.call(req);
    expect(res.status, "not the gate's refusal").not.toBe(403);
    expect(json, "the handler body ran").toHaveBeenCalledTimes(1);
    if (s.usecase) expect(s.usecase).toHaveBeenCalledTimes(1);
    expect(cf.impl).not.toHaveBeenCalled();
    expect(limiter.calls, "the limiter still ran (resend and others add narrower buckets after the first): the switch turns off the bot check, not the throttle").toBeGreaterThanOrEqual(1);
  });

  it("TURNSTILE=off with the limiter refusing: still 429 (the switch does not open the throttle)", async () => {
    enforce();
    vi.stubEnv("TURNSTILE", "off");
    limiter.refuse = true;
    const { req, json } = post(s.validBody);
    expect((await s.call(req)).status).toBe(429);
    expect(json).not.toHaveBeenCalled();
  });

  it("' off ' and 'OFF' open the gate; 'false', '0', 'no', '' and unset keep it shut (403, body unread)", async () => {
    let checked = 0;
    for (const [value, opens] of [[" off ", true], ["OFF", true], ["false", false], ["0", false], ["no", false], ["", false], [undefined, false]] as const) {
      vi.unstubAllEnvs();
      enforce();
      if (value !== undefined) vi.stubEnv("TURNSTILE", value);
      const { req, json } = post(s.validBody);
      const res = await s.call(req);
      if (opens) {
        expect([JSON.stringify(value), res.status === 403]).toEqual([JSON.stringify(value), false]);
        expect(json).toHaveBeenCalledTimes(1);
      } else {
        expect([JSON.stringify(value), res.status]).toEqual([JSON.stringify(value), 403]);
        expect(json).not.toHaveBeenCalled();
      }
      checked++;
    }
    expect(checked).toBe(7);
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

// The GET on the join route is a read (a code preview): it stays open in enforce mode, so a challenge is never put in front of
// someone who has only opened a link. Its sibling POST, in the same file, is the gated one.
describe("the join preview GET is not gated", () => {
  it("enforce mode, no token: not refused by the gate, and Cloudflare is not called", async () => {
    enforce();
    const req = new Request("https://x.test/api/any?join_code=AB12CD", { method: "GET" });
    const res = await joinPreview(req, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) });
    expect(res.status, "not the gate's refusal").toBe(200);
    expect(preview.fn, "the preview's own usecase ran").toHaveBeenCalledWith("AB12CD");
    expect(cf.impl).not.toHaveBeenCalled();
  });

  it("the positive pair: the SAME route's POST with no token IS refused under the same enforce mode", async () => {
    enforce();
    const { req } = post({ join_code: "AB12CD" });
    const res = await join(req, { params: Promise.resolve({ orgSlug: "riverside", slug: "summer" }) });
    expect(res.status).toBe(403);
    expect(await envelopeCode(res)).toBe(TURNSTILE_ERROR_CODE);
  });
});
