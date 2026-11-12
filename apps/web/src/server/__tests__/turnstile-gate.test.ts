// The Turnstile gate on the public POSTs, driven through the REAL route handlers: login, start, register, resend, join, and
// withdraw (two routes share that action: the by-ref one and the registration-id one).
// server/__tests__/turnstile.test.ts proves the judgement; THIS file proves each route actually asks, asks for ITS
// action, asks before it reads a body, and asks after its first rate limit and not before it.
//
// What "the handler body did not run" means here: every one of the seven reads its body with `req.json()` (directly, or through
// `parseBody`), so a request spied on `json` that is refused with that spy untouched never got past the gate. That is a
// stronger claim than "returned 403" (a gate placed after the read would also return 403) and needs no usecase mocked.
//
// The surfaces are typed from the brief; two sweeps cross-check them. One against the actions lib/turnstile.ts DECLARES (a
// declared action with no surface fails). One against the route TREE (every write handler under app/api is a surface here, sits
// behind a door the reader can detect in the source, or is on a reviewed exempt list with a reason; a new anonymous write that
// is none of those fails, so it cannot ship ungated by omission).
//
// Cloudflare is a stateful fake (global `fetch`): a token is good once, exactly as siteverify says.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { resolve } from "node:path";
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
import { classifyHandler, classifyTree, gatedActions, writeHandlers, type Handler, type RouteClass } from "./_route-classify";
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
    const gatedFiles = tree.filter((t) => t.cls === "gated").map((t) => t.handler.file).sort();
    expect(gatedFiles.length).toBeGreaterThan(0);
    expect(gatedFiles).toEqual(SURFACES.map((s) => s.file).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The route-tree sweep. The surfaces above prove each GATED route; nothing there can see a public write that was never gated.
// This reads the source of EVERY route file under app/api (_route-classify.ts), finds each exported write handler (POST, PUT,
// PATCH, DELETE) and says what stands in front of it. A handler that sits behind something the reader can DETECT (a session or
// API-key door, a staff door, a cron secret, a verified webhook signature, a fake-driver switch, a minted bearer) needs nothing
// typed here. A handler with nothing detectable in front of it is anonymous, and an anonymous write must be a surface above or on
// EXEMPT with a reason. Reading source is the point: a route nobody remembered to add anywhere is exactly the one that must fail.
// ---------------------------------------------------------------------------------------------------------------------------
const SRC_DIR = resolve(import.meta.dirname, "../..");
const API_DIR = resolve(SRC_DIR, "app/api");

/** Anonymous write handlers that are deliberately NOT bot-checked, keyed `<file> <VERB>`. Reviewed 2026-11-07; each reason is
 *  what the handler does today, so a future reader can disagree with it. A handler a detectable door holds back is NOT listed:
 *  the sweep fails an entry that a rule now explains. */
const EXEMPT: Record<string, string> = {
  "auth/logout/route.ts POST": "ends the caller's own session; takes no input, writes nothing and sends nothing a bot could use",
  "auth/magic-link/consume/route.ts POST": "redeems an emailed one-time token: the token is the credential and is spent on use; per-IP AUTH_LIMIT",
  "auth/verify-email/route.ts POST": "redeems an emailed one-time token: the token is the credential and is spent on use; per-IP AUTH_LIMIT",
  "funnel/claim/route.ts POST": "redeems an emailed one-time funnel token (mailed only after the bot-checked start); per-IP AUTH_LIMIT",
  "invites/[token]/claim/route.ts POST":
    "redeems an emailed invite token: the token proves the inbox and is the credential, it mints a session only for a new or unverified invitee; POST-only, per-IP AUTH_LIMIT",
  "claims/[token]/accept/route.ts POST":
    "redeems an emailed person-claim token: signed in it links the caller's own account, signed out it needs the emailed secret plus a same-origin request; per-IP AUTH_LIMIT",
  "public/format-preview/route.ts POST":
    "pure computation over placeholder entrants for the home configurator: no database, no session, no mail; the answer is cached per (format, entrants); per-IP limit of 30 a minute",
  "consent/route.ts POST": "cookie-consent receipt: writes one row, sends no mail; per-IP CONSENT_LIMIT; a challenge would block the consent banner itself",
  "v1/public/registrations/[id]/checkout/route.ts POST":
    "pay: needs the registrant's own token for an existing registration, per-IP CHECKOUT_LIMIT; revisit if Checkout Session spend becomes a target",
  "v1/match-day-code/approvals/[kind]/[stageId]/route.ts POST":
    "the Seazn Club app's call, bearing a Match Day code (md_, 256 bits, one day, withdrawable): the code is the credential and a phone cannot solve a browser challenge; per-code MD_REVIEW_LIMIT / MD_APPROVE_LIMIT and per-IP MD_FAIL_LIMIT on failed lookups",
  "v1/match-day-code/fixtures/[id]/scoring-link/route.ts POST":
    "the Seazn Club app's call, bearing a Match Day code (md_): the code is the credential and a phone cannot solve a browser challenge; per-code MD_OPEN_LIMIT, per-IP MD_FAIL_LIMIT on failed lookups, and a minting open spends the console's DEVICE_LINK_MINT_LIMIT",
};

const tree = classifyTree(API_DIR, SRC_DIR);
const key = (h: Handler) => `${h.file} ${h.verb}`;
const byClass = (cls: RouteClass) => tree.filter((t) => t.cls === cls);

describe("route-tree sweep: every write handler under app/api is gated, behind a detectable door, or reviewed-exempt", () => {
  const door = (src: string, over: { readModule?: (s: string) => string | undefined } = {}): RouteClass =>
    classifyHandler(writeHandlers("x/route.ts", src)[0]!, { readModule: over.readModule ?? (() => undefined) });

  it("the detectors see each export form, and a guard NAMED in a comment, or on a GET, or on another verb, is not a guard on this handler", () => {
    const verbs = (src: string) => writeHandlers("x/route.ts", src).map((h) => h.verb).sort();
    expect(verbs("export async function POST(req: Request) {}")).toEqual(["POST"]);
    expect(verbs("export function DELETE() {}\nexport const PATCH = handler(x);")).toEqual(["DELETE", "PATCH"]);
    expect(verbs("const h = x;\nexport { h as PUT, other, GET, POST };")).toEqual(["POST", "PUT"]);
    expect(verbs('export async function GET() {}\nawait fetch(u, { method: "POST" });')).toEqual([]);
    expect(gatedActions('await requireTurnstile(req, "login");\nawait requireTurnstile( req ,"join" )')).toEqual(["login", "join"]);
    expect(gatedActions("// requireTurnstile is mentioned here\nawait other(req, 'login')")).toEqual([]);
    // A door in a comment is not a door.
    expect(door("export async function POST() {\n  // requireUser() would go here\n  /* requireStaff() */\n  return 1;\n}")).toBe("anonymous");
    // A door on the GET does not hold the POST back (handlers are read one by one, up to the next export).
    expect(door("export async function GET() { await requireUser(); }\nexport async function POST() { return 1; }")).toBe("anonymous");
    expect(writeHandlers("x/route.ts", "export async function GET() { await requireUser(); }\nexport async function POST() { return 1; }")).toHaveLength(1);
    // A bare re-export names no body, so it cannot be explained and has to be argued for.
    expect(door("export { POST } from '../other/route';")).toBe("anonymous");
  });

  it("each class is recognised from the source it names (a rule that matches nothing proves nothing), and not from a lookalike", () => {
    const cases: [RouteClass, string][] = [
      ["gated", 'export async function POST(req: Request) { await requireTurnstile(req, "login"); }'],
      ["identity", "export async function POST(req: Request) { const ctx = await requireResourceAuth(req, 'fixture', id, 'write'); }"],
      ["identity", "export async function POST(req: Request) { await matchRoomIdentity(req); }"],
      ["staff", "export async function POST() { await requireSuperadmin(); }"],
      ["billing", "export async function POST() { await requireBillingOwner(); }"],
      ["cron", "const s = process.env.CRON_SECRET;\nexport async function POST(req: Request) { req.headers.get('x-cron-secret'); }"],
      ["webhook", "export async function POST(req: Request) { stripe.webhooks.constructEvent(raw, sig, secret); }"],
      ["harness", "export async function POST() { if (!fakeControlEnabled(process.env)) throw new Error(); }"],
      ["bearer", "export async function POST(req: Request) { const t = bearerOf(req); }"],
      ["session401", "export async function POST() { const u = await getCurrentUser(); if (!u) return json({}, { status: 401 }); }"],
    ];
    for (const [want, src] of cases) expect([want, door(src)]).toEqual([want, want]);
    // Lookalikes: the secret header with no CRON_SECRET in the file, getCurrentUser without a 401 (consent reads it optionally).
    expect(door("export async function POST(req: Request) { req.headers.get('x-cron-secret'); }")).toBe("anonymous");
    expect(door("export async function POST() { const u = await getCurrentUser(); return u?.id; }")).toBe("anonymous");
    expect(door("export async function POST() { await requireUserAgent(); }")).toBe("anonymous");
  });

  it("one hop: a door inside the usecase the handler calls counts; a usecase with no door, or an uncalled import, does not", () => {
    const route = "import { setThing, other } from '@/server/usecases/thing';\nexport async function POST() { return setThing(1); }";
    const guarded = () => "export async function setThing(n: number) {\n  await requireBillingOwner();\n}\nexport async function other() {}";
    const unguarded = () => "export async function setThing(n: number) { return n; }\nexport async function other() { await requireUser(); }";
    expect(door(route, { readModule: guarded })).toBe("via-usecase");
    expect(door(route, { readModule: unguarded }), "the door is in `other`, which this handler does not call").toBe("anonymous");
    expect(door(route, { readModule: () => undefined })).toBe("anonymous");
    const commented = () => "export async function setThing() {\n  // await requireUser();\n}";
    expect(door(route, { readModule: commented })).toBe("anonymous");
  });

  it("anti-vacuity: the walker found the tree, every surface file is a swept gated handler, and every class the rules exist for occurs", () => {
    const files = new Set(tree.map((t) => t.handler.file));
    expect(tree.length, "write handlers found under app/api").toBeGreaterThan(250);
    expect(files.size, "route files with a write handler").toBeGreaterThan(250);
    // Counts are floors for the big classes (the tree grows) and exact for the small ones the rules were written around.
    const floors: Partial<Record<RouteClass, number>> = { identity: 150, staff: 15, cron: 10, billing: 5, bearer: 4, session401: 3, webhook: 2, harness: 2, "via-usecase": 3 };
    for (const [cls, floor] of Object.entries(floors) as [RouteClass, number][]) {
      expect(byClass(cls).length, `handlers classified ${cls}`).toBeGreaterThanOrEqual(floor);
    }
    expect(byClass("gated").map((t) => t.handler.file).sort()).toEqual(SURFACES.map((s) => s.file).sort());
    expect(byClass("anonymous").length, "anonymous write handlers").toBe(Object.keys(EXEMPT).length);
  });

  it("every gated handler is a surface for exactly its declared action, and every surface is a gated handler", () => {
    const surfaceByFile = new Map(SURFACES.map((s) => [s.file, s.action]));
    let checked = 0;
    for (const { handler, cls } of tree) {
      const surface = surfaceByFile.get(handler.file);
      if (cls === "gated") {
        expect([key(handler), "is a surface", surface !== undefined]).toEqual([key(handler), "is a surface", true]);
        expect([key(handler), gatedActions(handler.body)]).toEqual([key(handler), [surface]]);
      } else {
        expect([key(handler), "is not a surface", surface === undefined]).toEqual([key(handler), "is not a surface", true]);
        expect([key(handler), "calls the gate", gatedActions(handler.body).length]).toEqual([key(handler), "calls the gate", 0]);
      }
      checked++;
    }
    expect(checked, "handlers checked").toBe(tree.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every anonymous write handler is on EXEMPT, every EXEMPT entry is an anonymous handler (no stale or shadowed entry), none is both", () => {
    const anonymous = new Set(byClass("anonymous").map((t) => key(t.handler)));
    expect([...anonymous].filter((k) => !(k in EXEMPT)), "anonymous and not argued for: gate it, or review it onto EXEMPT with a reason").toEqual([]);
    const present = new Map(tree.map((t) => [key(t.handler), t.cls]));
    let checked = 0;
    for (const k of Object.keys(EXEMPT)) {
      expect([k, present.get(k)], "an EXEMPT entry must be a real handler that nothing detectable explains").toEqual([k, "anonymous"]);
      checked++;
    }
    expect(checked, "exempt entries checked").toBe(Object.keys(EXEMPT).length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every exempt entry carries a real reason", () => {
    expect(Object.keys(EXEMPT).length).toBeGreaterThan(0);
    for (const [k, why] of Object.entries(EXEMPT)) expect([k, why.length > 30]).toEqual([k, true]);
  });

  it("the three anonymous token and compute routes the review named are exempt, not hidden behind a rule", () => {
    for (const k of ["invites/[token]/claim/route.ts POST", "claims/[token]/accept/route.ts POST", "public/format-preview/route.ts POST"]) {
      expect([k, tree.find((t) => key(t.handler) === k)?.cls, k in EXEMPT]).toEqual([k, "anonymous", true]);
    }
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
