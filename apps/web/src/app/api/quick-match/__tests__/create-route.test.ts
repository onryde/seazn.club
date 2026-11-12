// Quick match plan 2, Task 3: POST /api/quick-match, the guest's setup form. Driven through the REAL route, the real
// `createQuickMatch` and real Postgres rows; the only stand-ins are PostHog (a mock, never the live project) and, in the
// limiter cases, the limiter's own test counter (`__setRateLimitCounterForTests`, lib/rate-limit.ts).
//
// The contract (controller dispatch 2026-11-08, D2, D3, A6, B3): the form posts `application/x-www-form-urlencoded`; every
// answer is a 303. A create lands on `/q/<token>` (`routes.quickMatch`), with the visitor cookie set when it was minted. A
// refusal lands back on the setup page, `/<locale>/play?e=<code>`, never on JSON.
//
// Every case keys on its OWN cookie, visitor hash, name and client IP (plan-1 A16, pre-flight A13): the system org is shared by
// every suite and every parallel lane, so nothing here reads an org-wide count. Expected values come from the spec and the
// rulebook (400-day cookie, 20 per 600 s, plays × n(n−1)/2), never from the route's own answer.
//
// One sport, badminton: the route is sport-agnostic, and the sweep across every sport and variant is plan 1's offer probe
// (`quick-match-offer.test.ts`), which creates through the same `createQuickMatch`. Football, a team sport, is driven once for
// the kind refusal's other direction.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { __setRateLimitCounterForTests, QUICK_MATCH_CREATE_LIMIT } from "@/lib/rate-limit";
import { createCompetition } from "@/server/usecases/competitions";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { systemAuth } from "@/server/usecases/quick-match-create";
import { offerFor } from "@/server/usecases/quick-match-sports";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { hashVisitorKey, mintHomeToken, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { POST } from "../route";

const KEK = randomBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // a local scoped run has no KEK of its own (pre-flight B3e)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The route's fault report, read by the cases that tell a fault from a refusal. Never sent anywhere.
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
// The real competition create, through a spy: the plan-cap case answers one call with the 402 a capped org gets.
vi.mock("@/server/usecases/competitions", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/competitions")>();
  return { ...real, createCompetition: vi.fn(real.createCompetition) };
});
/** The route's Sentry reports since the last clear. */
const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);

const HAS_DB = !!process.env.DATABASE_URL;
const COOKIE = "seazn_qm_visitor";   // plan 1's QUICK_MATCH_VISITOR_COOKIE, typed: the name a browser holds is the contract
/** RFC 6265bis §5.5: a user agent caps Max-Age at 400 days, so plan 1 asks for exactly that. */
const FOUR_HUNDRED_DAYS_S = 400 * 24 * 3600;

let BADMINTON_V: string;
let FOOTBALL_V: string;
const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
const uniq = () => `QM route ${randomUUID().slice(0, 8)}`;
/** A client IP of this case's own (TEST-NET-3 plus random octets), so a limiter bucket is never another case's. */
const ip = () => `203.0.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

type Fields = Record<string, string | string[]>;
/** The setup form's exact nine fields (pre-flight B4e), as a browser posts them. */
const form = (over: Fields = {}): Fields => ({
  name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league",
  sides, plays: "1", email: "", locale: "en", ...over,
});

async function post(fields: Fields, opts: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? ip(), ...opts.headers };
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE}=${opts.cookie}`;
  return POST(new NextRequest("http://localhost/api/quick-match", { method: "POST", body, headers }));
}

/** The Set-Cookie lines for the visitor cookie, as the response really carries them. */
const visitorCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE}=`));
const cookieValue = (line: string) => decodeURIComponent(line.slice(COOKIE.length + 1).split(";")[0]!);

/** The home a create lands on: `/q/<token>`, the token alone in the path, never a query string. */
function landedToken(res: Response): string {
  expect(res.status).toBe(303);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/q\/qm_[A-Za-z0-9_-]{43}$/);
  return loc.slice("/q/".length);
}
const rowsFor = async (visitorHash: string) =>
  sql<{ id: string; name: string; email: string | null; locale: string }[]>`
    select id, name, email, locale from quick_matches where visitor_hash = ${visitorHash} order by created_at`;
const rowsNamed = async (name: string) => sql`select 1 from quick_matches where name = ${name}`;

beforeAll(async () => {
  if (!HAS_DB) return;
  const variant = async (sport: string) => {
    const [row] = await sql<{ key: string }[]>`
      select key from sport_variants where sport_key = ${sport} and is_system and org_id is null order by key limit 1`;
    if (!row) throw new Error(`no system ${sport} variant: run \`npm run sync:sports\` against this database`);
    return row.key;
  };
  BADMINTON_V = await variant("badminton");
  FOOTBALL_V = await variant("football");
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
  vi.unstubAllEnvs();
  vi.stubEnv("DEVICE_LINK_KEK", KEK);
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("QUICK_MATCH_CREATE_LIMIT (D2)", () => {
  it("is 20 per 600 s per IP and fails open, so shared club wifi never locks a group out on a Redis blip", () => {
    expect(QUICK_MATCH_CREATE_LIMIT).toEqual({ max: 20, windowSeconds: 600, failClosed: false });
  });
});

describe.skipIf(!HAS_DB)("POST /api/quick-match: the create", () => {
  it("a first create lands on /q/<token>, whose token resolves to the new match, and mints the visitor cookie", async () => {
    const f = form();
    const res = await post(f);
    const token = landedToken(res);
    const row = await resolveQuickMatchToken(token);
    expect(row).toMatchObject({ name: f.name, format: "league", email: null, locale: "en" });   // blank email stored as none (B4e)

    const [line, ...more] = visitorCookies(res);
    expect(more).toHaveLength(0);
    const key = cookieValue(line!);
    expect(key).toMatch(/^qv_[A-Za-z0-9_-]{43}$/);
    // The cookie the browser keeps is the key whose hash the row carries: the strip and the cap read the same visitor.
    expect((await rowsFor(hashVisitorKey(key))).map((r) => r.id)).toEqual([row!.id]);
    const attrs = line!.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["httponly", "samesite=lax", "path=/", `max-age=${FOUR_HUNDRED_DAYS_S}`]));
    expect(attrs).not.toContain("secure");   // not production: a plain-http dev server must still keep it (refer/[code] precedent)
  });

  it("in production the visitor cookie is also Secure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post(form());
    landedToken(res);
    const attrs = visitorCookies(res)[0]!.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["secure", "httponly", "samesite=lax"]));
  });

  it("a second create carrying the cookie sets no new cookie, and both matches share its visitor_hash", async () => {
    const first = await post(form());
    landedToken(first);
    const key = cookieValue(visitorCookies(first)[0]!);
    const second = await post(form(), { cookie: key });
    const token = landedToken(second);
    expect(visitorCookies(second)).toEqual([]);
    const rows = await rowsFor(hashVisitorKey(key));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.id).toBe((await resolveQuickMatchToken(token))!.id);
  });

  it.each([
    ["not a key at all", "garbage"],
    ["one character short", `qv_${"a".repeat(42)}`],
    ["a home token, not a visitor key", mintHomeToken()],
    ["empty", ""],
  ])("a malformed cookie (%s) is never trusted: the create still works and a fresh key is minted (Review Focus 4)", async (_why, bad) => {
    const f = form();
    const res = await post(f, { cookie: bad });
    const token = landedToken(res);
    const fresh = cookieValue(visitorCookies(res)[0]!);
    expect(fresh).toMatch(/^qv_[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(bad);
    const row = (await resolveQuickMatchToken(token))!;
    expect((await rowsFor(hashVisitorKey(fresh))).map((r) => r.id)).toEqual([row.id]);
    // THIS row is keyed on the fresh key, never on the bad value. Row-scoped on purpose: the bad values are constants, so an
    // "no row anywhere has hash(bad)" check reads every earlier run's rows in a shared database.
    const [{ visitor_hash }] = await sql<{ visitor_hash: string }[]>`select visitor_hash from quick_matches where id = ${row.id}`;
    expect(visitor_hash).not.toBe(hashVisitorKey(bad));
  });

  it("maps the form's strings to the create: plays, the email, the locale (a league of 4 played twice is 12 matches)", async () => {
    const f = form({ plays: "2", email: "guest@example.com", locale: "fr" });
    const token = landedToken(await post(f));
    const row = (await resolveQuickMatchToken(token))!;
    expect(row).toMatchObject({ name: f.name, email: "guest@example.com", locale: "fr" });
    const [{ division_id }] = await sql<{ division_id: string }[]>`
      select d.id as division_id from divisions d join quick_matches q on q.competition_id = d.competition_id where q.id = ${row.id}`;
    // Rulebook: a round robin of n sides played p times is p · n(n−1)/2 matches.
    expect(await listDivisionFixtures(systemAuth(), division_id)).toHaveLength(2 * (4 * 3) / 2);
  });

  it("a knockout of 4 lands on its home too (the format field reaches the create)", async () => {
    const token = landedToken(await post(form({ format: "knockout" })));
    expect(await resolveQuickMatchToken(token)).toMatchObject({ format: "knockout" });
  });
});

describe.skipIf(!HAS_DB)("POST /api/quick-match: every refusal is a 303 back to the setup page with its code (D3)", () => {
  const refusedTo = (res: Response, locale: string, code: string) => {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${locale}/play?e=${code}`);
    expect(res.headers.get("content-type") ?? "").not.toContain("json");
  };

  it("the 6th alive match for one visitor: the first five land on their homes, the sixth is refused and writes nothing", async () => {
    const key = mintVisitorKey();
    for (let i = 0; i < 5; i++) landedToken(await post(form(), { cookie: key }));
    const sixth = form({ locale: "nl" });
    vi.mocked(Sentry.captureException).mockClear();
    const res = await post(sixth, { cookie: key });
    refusedTo(res, "nl", "QUICK_MATCH_TOO_MANY_ALIVE");
    expect(reported(), "a guest's refusal is not a fault: never reported").toEqual([]);
    expect(visitorCookies(res)).toEqual([]);
    expect(await rowsFor(hashVisitorKey(key))).toHaveLength(5);
    expect(await rowsNamed(sixth.name as string)).toHaveLength(0);
  });

  it("a sport the offer excludes: QUICK_MATCH_SPORT_NOT_OFFERED", async () => {
    const [g] = await sql<{ key: string }[]>`
      select key from sport_variants where sport_key = 'generic' and is_system and org_id is null order by key limit 1`;
    const f = form({ sport_key: "generic", variant_key: g!.key, kind: "team" });
    refusedTo(await post(f), "en", "QUICK_MATCH_SPORT_NOT_OFFERED");
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
  });

  it("a kind the sport does not take: QUICK_MATCH_KIND_NOT_OFFERED (a racket sport and a team sport, each its own missing kind)", async () => {
    let checked = 0;
    for (const [sport_key, variant_key] of [["badminton", BADMINTON_V], ["football", FOOTBALL_V]] as const) {
      // The missing kind comes from the sport's own declaration (the offer), never from the route.
      const { offered, kinds } = await offerFor(sport_key, variant_key);
      expect(offered, `${sport_key}/${variant_key} must be offered, so only the kind can refuse`).toBe(true);
      const missing = (["individual", "pair", "team"] as const).find((k) => !kinds.includes(k));
      expect(missing, `${sport_key} takes every kind: nothing to witness`).toBeDefined();
      const f = form({ sport_key, variant_key, kind: missing! });
      refusedTo(await post(f), "en", "QUICK_MATCH_KIND_NOT_OFFERED");
      expect(await rowsNamed(f.name as string)).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a knockout of two sides: QUICK_MATCH_FORMAT_NOT_OFFERED (C16)", async () => {
    const f = form({ format: "knockout", sides: sides.slice(0, 2), locale: "es" });
    refusedTo(await post(f), "es", "QUICK_MATCH_FORMAT_NOT_OFFERED");
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
  });

  it("a server without DEVICE_LINK_KEK (503): QUICK_MATCH_CREATE_FAILED, touching nothing, and reported once as a fault", async () => {
    vi.stubEnv("DEVICE_LINK_KEK", "");
    const f = form();
    vi.mocked(Sentry.captureException).mockClear();
    refusedTo(await post(f), "en", "QUICK_MATCH_CREATE_FAILED");
    expect(reported()).toHaveLength(1);
    expect(reported()[0]).toMatchObject({ status: 503, code: "DEVICE_LINK_KEK_MISSING" });
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
  });

  it("a plan cap's 402 (no quick match code) is a fault, not a refusal: reported once, still a 303 to CREATE_FAILED", async () => {
    // The system org's caps are unlimited (plan 1 Task 1), so no real create reaches a 402 today; the competition create
    // answers one call with the 402 a capped org gets, and every step before and after it is real.
    const cap = new PaymentRequiredError("competitions.max_active");
    vi.mocked(createCompetition).mockRejectedValueOnce(cap);
    const f = form();
    vi.mocked(Sentry.captureException).mockClear();
    refusedTo(await post(f), "en", "QUICK_MATCH_CREATE_FAILED");
    expect(vi.mocked(createCompetition)).toHaveBeenCalled();   // the stub was reached through the real createQuickMatch
    expect(reported()).toEqual([cap]);
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
  });

  it("a quick match code on a 5xx is a fault, not a refusal: BASE_URL_MISSING is reported once, shown as CREATE_FAILED", async () => {
    // The route always passes a base URL (plan 3 Task 1), so no real create throws it; the competition create answers one
    // call with it, and every step before and after it is real. A refusal names its own code; a programmer error must not.
    const fault = new HttpError(500, "a quick match create with an email needs a baseUrl", QUICK_MATCH_ERRORS.BASE_URL_MISSING);
    vi.mocked(createCompetition).mockRejectedValueOnce(fault);
    const f = form();
    vi.mocked(Sentry.captureException).mockClear();
    refusedTo(await post(f), "en", "QUICK_MATCH_CREATE_FAILED");
    expect(vi.mocked(createCompetition)).toHaveBeenCalled();
    expect(reported()).toEqual([fault]);
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
  });

  it.each([
    ["one side", { sides: ["Solo"] }],
    ["seven sides", { sides: ["A", "B", "C", "D", "E", "F", "G"] }],
    ["a blank side", { sides: ["Ravi", "   "] }],
    ["a stray field", { seeds: "1" }],
    ["a repeated name", { name: ["One", "Two"] }],
    ["plays out of range", { plays: "5" }],
    ["plays not a number", { plays: "twice" }],
    ["a bad email", { email: "not-an-email" }],
  ])("a form the schema refuses (%s): QUICK_MATCH_CREATE_FAILED, in the form's own language", async (_why, over) => {
    const f = form({ ...over, locale: "fr" });
    vi.mocked(Sentry.captureException).mockClear();
    refusedTo(await post(f), "fr", "QUICK_MATCH_CREATE_FAILED");
    expect(reported(), "the form's own refusal is not a fault").toEqual([]);
    if (typeof f.name === "string") expect(await rowsNamed(f.name)).toHaveLength(0);
  });

  it("a body that is not a form (JSON): refused to the visitor's own locale cookie, else English", async () => {
    const json = (headers: Record<string, string>) =>
      POST(new NextRequest("http://localhost/api/quick-match", {
        method: "POST", body: JSON.stringify(form()), headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...headers },
      }));
    refusedTo(await json({ cookie: "seazn_locale=es" }), "es", "QUICK_MATCH_CREATE_FAILED");
    refusedTo(await json({}), "en", "QUICK_MATCH_CREATE_FAILED");
  });

  it("a locale field that names no shipped locale falls back to the visitor's cookie, and is refused", async () => {
    refusedTo(await post(form({ locale: "xx" }), { headers: { cookie: "seazn_locale=nl" } }), "nl", "QUICK_MATCH_CREATE_FAILED");
  });

  it("a forged locale cookie that does not decode (seazn_locale=%E0) falls back to English: a 303, never a JSON 500", async () => {
    const forged = { headers: { cookie: "seazn_locale=%E0" } };
    refusedTo(await post(form({ locale: "xx" }), forged), "en", "QUICK_MATCH_CREATE_FAILED");
    // The same cookie beside a good form: the form's locale wins and the create still lands on its home.
    landedToken(await post(form(), forged));
  });
});

describe.skipIf(!HAS_DB)("POST /api/quick-match: the per-IP limit (D2)", () => {
  /** The limiter's own test seam: THIS case's bucket reads `count`; every other key is inert, as with no Redis. */
  const countFor = (theirIp: string, count: number) => {
    const seen: { key: string; windowSeconds: number }[] = [];
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      seen.push({ key, windowSeconds });
      return key === `rl:quick-match-create:${theirIp}` ? { count, ttlMs: 120_000 } : null;
    });
    return seen;
  };

  it("past 20 in the window: QUICK_MATCH_RATE_LIMITED back to the setup page, before any row is written", async () => {
    const theirs = ip();
    const key = mintVisitorKey();
    const seen = countFor(theirs, 21);
    const f = form({ locale: "es" });
    vi.mocked(Sentry.captureException).mockClear();
    const res = await post(f, { ip: theirs, cookie: key });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/es/play?e=QUICK_MATCH_RATE_LIMITED");
    expect(reported(), "the limiter's refusal is not a fault").toEqual([]);
    expect(await rowsFor(hashVisitorKey(key))).toHaveLength(0);
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
    // Keyed on the first X-Forwarded-For hop (the funnel's idiom), over the declared window.
    expect(seen).toEqual([{ key: `rl:quick-match-create:${theirs}`, windowSeconds: 600 }]);
  });

  it("the 20th in the window still creates (the bound is inclusive)", async () => {
    const theirs = ip();
    countFor(theirs, 20);
    landedToken(await post(form(), { ip: theirs }));
  });

  it("only the first X-Forwarded-For hop names the bucket", async () => {
    const theirs = ip();
    const seen = countFor(theirs, 21);
    const res = await post(form(), { ip: `${theirs}, 10.0.0.1, 10.0.0.2` });
    expect(res.headers.get("location")).toBe("/en/play?e=QUICK_MATCH_RATE_LIMITED");
    expect(seen.map((s) => s.key)).toEqual([`rl:quick-match-create:${theirs}`]);
  });
});
