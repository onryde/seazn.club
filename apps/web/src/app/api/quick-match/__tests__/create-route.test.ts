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

import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests, QUICK_MATCH_CREATE_LIMIT } from "@/lib/rate-limit";
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
    const res = await post(sixth, { cookie: key });
    refusedTo(res, "nl", "QUICK_MATCH_TOO_MANY_ALIVE");
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

  it("a server without DEVICE_LINK_KEK (503): QUICK_MATCH_CREATE_FAILED, touching nothing", async () => {
    vi.stubEnv("DEVICE_LINK_KEK", "");
    const f = form();
    refusedTo(await post(f), "en", "QUICK_MATCH_CREATE_FAILED");
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
    refusedTo(await post(f), "fr", "QUICK_MATCH_CREATE_FAILED");
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
    const res = await post(f, { ip: theirs, cookie: key });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/es/play?e=QUICK_MATCH_RATE_LIMITED");
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
