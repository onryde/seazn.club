// Quick match plan 2, Task 3: POST /api/quick-match, the guest's setup form. Driven through the REAL route, the real
// `createQuickMatch` and real Postgres rows; the only stand-ins are PostHog (a mock, never the live project), in the
// limiter cases the limiter's own test counter (`__setRateLimitCounterForTests`, lib/rate-limit.ts), and in the bot-check
// cases a fake Cloudflare siteverify on global `fetch`.
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { explicitLocale } from "@/lib/explicit-locale";
import { LOCALES } from "@/lib/i18n-constants";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MIN_SIDES } from "@/lib/quick-match-constants";
import { __setRateLimitCounterForTests, QUICK_MATCH_CREATE_LIMIT } from "@/lib/rate-limit";
import { createCompetition } from "@/server/usecases/competitions";
import { isBye } from "@/lib/run-sheet-groups";
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
    // A production build on a harness server (e2e's), so the post needs no bot-check token: the cookie's Secure follows
    // NODE_ENV alone. A named deployment with a token is the bot-check block's (below).
    vi.stubEnv("ENV_NAME", "ci");
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
});

describe.skipIf(!HAS_DB)("POST /api/quick-match: the visitor's language (A-M8: /fr/play lands on a French home)", () => {
  /** The Set-Cookie lines for the language switcher's cookie, as the response really carries them. */
  const localeCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith("seazn_locale="));
  /** A cookie line's attributes, lower-cased names, for an order-free comparison. */
  const attrs = (line: string) =>
    new Set(line.split(";").slice(1).map((a) => a.trim().toLowerCase()).filter((a) => a !== ""));

  it("no pick of their own: the create sets the switcher's cookie to the form's locale, as the switcher writes it, for every shipped locale (counted)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const res = await post(form({ locale }));
      landedToken(res);
      const lines = localeCookies(res);
      expect(lines, locale).toHaveLength(1);
      expect(lines[0]!.split(";")[0], locale).toBe(`seazn_locale=${locale}`);
      // components/i18n/locale-switcher.tsx: `path=/; max-age=31536000; samesite=lax`, and readable by its script (no
      // HttpOnly, no Secure). Next adds the Expires a max-age implies; it is pinned too, a year out, never left unread.
      const set = attrs(lines[0]!);
      const expires = [...set].filter((a) => a.startsWith("expires="));
      expect(expires, locale).toHaveLength(1);
      const yearOut = Date.parse(expires[0]!.slice("expires=".length)) - Date.now();
      expect(Math.abs(yearOut - 31_536_000_000), `${locale}: Expires is the max-age's year`).toBeLessThan(60_000);
      expect(new Set([...set].filter((a) => !a.startsWith("expires="))), locale).toEqual(
        new Set(["path=/", "max-age=31536000", "samesite=lax"]),
      );
      // What the home's locale reader then sees on the next request: the form's language.
      const next = new Request("http://localhost/q/x", { headers: { cookie: lines[0]!.split(";")[0]! } });
      expect(explicitLocale(next), locale).toBe(locale);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length);
  });

  it("a pick of their own is never overwritten; a forged one that does not decode is replaced; a refusal sets none", async () => {
    const kept = await post(form({ locale: "fr" }), { headers: { cookie: "seazn_locale=nl" } });
    landedToken(kept);
    expect(localeCookies(kept), "the visitor chose Dutch: kept").toEqual([]);
    const forged = await post(form({ locale: "fr" }), { headers: { cookie: "seazn_locale=%E0" } });
    landedToken(forged);
    expect(localeCookies(forged).map((l) => l.split(";")[0])).toEqual(["seazn_locale=fr"]);
    const unknown = await post(form({ locale: "es" }), { headers: { cookie: "seazn_locale=xx" } });
    landedToken(unknown);
    expect(localeCookies(unknown).map((l) => l.split(";")[0]), "a pick naming no shipped locale is none").toEqual(["seazn_locale=es"]);
    // A refusal stays on the setup page, already in the form's language: nothing to set.
    const refused = await post(form({ locale: "fr", sides: ["Solo"] }));
    expect(refused.headers.get("location")).toBe("/fr/play?e=QUICK_MATCH_CREATE_FAILED");
    expect(localeCookies(refused)).toEqual([]);
  });
});

// Plan 5 Task 6 (D1): the setup form posts ONE radio, `shape` = league | final | semis, and the route maps it to the create's
// `format` + `qualifiers`, so the page without its script needs no paired fields. Expected counts are the rulebook's (a round
// robin of n sides played p times is p · n(n−1)/2; a single-elimination draw of q sides is q − 1) and the mockup's (qmd13a01
// §6: 6 sides twice + semis = 33).
describe.skipIf(!HAS_DB)("POST /api/quick-match: the Format list's `shape` (plan 5 D1)", () => {
  /** The setup form as it now posts: `shape` in place of `format`. */
  const shapeForm = (over: Fields = {}): Fields => {
    const fields: Fields = { ...form(), shape: "league", ...over };
    if (!("format" in over)) delete fields.format;
    return fields;
  };
  /** The match a landed post made: its stored format, its non-bye lines, and its knockout stage's cut (the one authority, D1). */
  async function made(res: Response) {
    const row = (await resolveQuickMatchToken(landedToken(res)))!;
    const [{ division_id, format }] = await sql<{ division_id: string; format: string }[]>`
      select d.id as division_id, q.format from divisions d join quick_matches q on q.competition_id = d.competition_id
       where q.id = ${row.id}`;
    const lines = (await listDivisionFixtures(systemAuth(), division_id)).filter((f) => !isBye(f)).length;
    const cut = await sql<{ to: string | null }[]>`
      select progression->'sources'->0->'take'->0->>'to' as to from stages where division_id = ${division_id} and kind = 'knockout'`;
    return { format, lines, cut: cut.map((c) => (c.to === null ? null : Number(c.to))) };
  }
  const refused = (res: Response, code: string) => {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/en/play?e=${code}`);
  };

  it("League: a league, no knockout stage (4 sides once = 6)", async () => {
    expect(await made(await post(shapeForm({ shape: "league" })))).toEqual({ format: "league", lines: 6, cut: [] });
  });

  it("League → Final: the top 2 (3 sides once = 3 + 1 = 4, the mockup's number)", async () => {
    const f = shapeForm({ shape: "final", sides: sides.slice(0, 3) });
    expect(await made(await post(f))).toEqual({ format: "league_knockout", lines: 4, cut: [2] });
  });

  it("League → Semi-finals → Final: the top 4 (6 sides twice = 30 + 3 = 33, the mockup's number)", async () => {
    const six = [...sides, "Kim & Lou", "Ola & Pat"];
    const f = shapeForm({ shape: "semis", sides: six, plays: "2" });
    expect(await made(await post(f))).toEqual({ format: "league_knockout", lines: 33, cut: [4] });
  });

  it("the create's own guards still answer through the shape: Semi-finals of 3 is SEMIS_TOO_FEW_SIDES, a Final of 2 FORMAT_NOT_OFFERED; nothing made", async () => {
    const semis3 = shapeForm({ shape: "semis", sides: sides.slice(0, 3) });
    refused(await post(semis3), "QUICK_MATCH_SEMIS_TOO_FEW_SIDES");
    expect(await rowsNamed(semis3.name as string)).toHaveLength(0);
    const final2 = shapeForm({ shape: "final", sides: sides.slice(0, 2) });
    refused(await post(final2), "QUICK_MATCH_FORMAT_NOT_OFFERED");
    expect(await rowsNamed(final2.name as string)).toHaveLength(0);
  });

  it("a shape that is not one of the three fails the form (CREATE_FAILED), never a guess; nothing made (counted)", async () => {
    let checked = 0;
    for (const shape of ["knockout", "league_knockout", "Final", "", "__proto__", "constructor"]) {
      const f = shapeForm({ shape });
      refused(await post(f), "QUICK_MATCH_CREATE_FAILED");
      expect(await rowsNamed(f.name as string), JSON.stringify(shape)).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a shape beside a format or a count, or posted twice, is refused, never merged: one radio is one fact (counted)", async () => {
    const cases: Fields[] = [
      shapeForm({ shape: "semis", format: "league" }),
      shapeForm({ shape: "league", format: "league" }),
      shapeForm({ shape: "final", qualifiers: "4" }),
      shapeForm({ shape: ["final", "semis"] }),
    ];
    for (const f of cases) {
      refused(await post(f), "QUICK_MATCH_CREATE_FAILED");
      expect(await rowsNamed(f.name as string), JSON.stringify(f.shape)).toHaveLength(0);
    }
    expect(cases).toHaveLength(4);
  });

  it("a post with neither a shape nor a format is refused (the schema's format is required)", async () => {
    const bare = shapeForm();
    delete bare.shape;
    refused(await post(bare), "QUICK_MATCH_CREATE_FAILED");
    expect(await rowsNamed(bare.name as string)).toHaveLength(0);
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

  it("a knockout at any side count: QUICK_MATCH_FORMAT_NOT_OFFERED, nothing made (owner 2026-11-12: League only)", async () => {
    // The format field reaches the create: the same form as a league lands on a home (the create tests above), and as a
    // knockout it is refused at every side count the form takes, 2..6.
    const many = [...sides, "Kim & Lou", "Ola & Pat"];
    let checked = 0;
    for (let n = QUICK_MATCH_MIN_SIDES; n <= QUICK_MATCH_MAX_SIDES; n++) {
      const f = form({ format: "knockout", sides: many.slice(0, n), locale: "es" });
      refusedTo(await post(f), "es", "QUICK_MATCH_FORMAT_NOT_OFFERED");
      expect(await rowsNamed(f.name as string), `${n} sides`).toHaveLength(0);
      checked++;
    }
    expect(checked, "anti-vacuity: 2..6 sides").toBe(5);
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
    // Owner 2026-11-12: "Each pair plays" is Once | Twice only; three is refused at the server too, not just unoffered.
    ["plays 3, past the owner's Twice", { plays: "3" }],
    ["plays out of range", { plays: "5" }],
    ["plays not a number", { plays: "twice" }],
    // An email fault BESIDE another one is still the form's: only an email-only failure names the address (A-I2).
    ["a bad email and one side", { email: "ravi@gmail", sides: ["Solo"] }],
  ])("a form the schema refuses (%s): QUICK_MATCH_CREATE_FAILED, in the form's own language", async (_why, over) => {
    const f = form({ ...over, locale: "fr" });
    vi.mocked(Sentry.captureException).mockClear();
    refusedTo(await post(f), "fr", "QUICK_MATCH_CREATE_FAILED");
    expect(reported(), "the form's own refusal is not a fault").toEqual([]);
    if (typeof f.name === "string") expect(await rowsNamed(f.name)).toHaveLength(0);
  });

  it("an address the schema refuses, and nothing else: QUICK_MATCH_EMAIL_INVALID, in the form's language, no row (A-I2; counted)", async () => {
    // The review's realistic typos: a missing top-level domain, a dot before the @, a one-letter top-level domain; and one
    // with no @ at all, and one past the 254 bound.
    const bad = ["ravi@gmail", "ravi.@gmail.com", "ravi@gmail.c", "not-an-email", `${"a".repeat(250)}@x.io`];
    let checked = 0;
    for (const email of bad) {
      const f = form({ email, locale: "es" });
      vi.mocked(Sentry.captureException).mockClear();
      refusedTo(await post(f), "es", QUICK_MATCH_ERRORS.EMAIL_INVALID);
      expect(reported(), `${email}: a typo is not a fault`).toEqual([]);
      expect(await rowsNamed(f.name as string), email).toHaveLength(0);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(bad.length);
    // The positive pair: the corrected address lands.
    landedToken(await post(form({ email: "guest@example.com" })));
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
    // Keyed on the client's IP from the repo's one reader (lib/client-ip.ts `clientIp`; no Fly header here, so its local
    // fallback, the first X-Forwarded-For hop), over the declared window.
    expect(seen).toEqual([{ key: `rl:quick-match-create:${theirs}`, windowSeconds: 600 }]);
  });

  it("the 20th in the window still creates (the bound is inclusive)", async () => {
    const theirs = ip();
    countFor(theirs, 20);
    landedToken(await post(form(), { ip: theirs }));
  });

  it("with no Fly header, only the first X-Forwarded-For hop names the bucket (clientIp's local fallback)", async () => {
    const theirs = ip();
    const seen = countFor(theirs, 21);
    const res = await post(form(), { ip: `${theirs}, 10.0.0.1, 10.0.0.2` });
    expect(res.headers.get("location")).toBe("/en/play?e=QUICK_MATCH_RATE_LIMITED");
    expect(seen.map((s) => s.key)).toEqual([`rl:quick-match-create:${theirs}`]);
  });

  it("behind Fly, the bucket is Fly's own client IP, never the X-Forwarded-For hop a guest can forge (review I-1)", async () => {
    // lib/client-ip.ts's declared order: Fly's `fly-client-ip` (the TCP peer Fly saw) wins over any X-Forwarded-For, whose
    // first hop the client writes itself. A forged hop must neither dodge this guest's bucket nor spend a stranger's.
    const theirs = ip(); // 203.0.x.y
    const forged = "198.51.100.7"; // another range, so the two readers can never name the same bucket
    const seen = countFor(theirs, 21);
    const res = await post(form(), { ip: `${forged}, 10.0.0.1`, headers: { "fly-client-ip": theirs } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/en/play?e=QUICK_MATCH_RATE_LIMITED");
    expect(seen.map((s) => s.key)).toEqual([`rl:quick-match-create:${theirs}`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The bot check (owner 2026-11-12: "yes we need turnstile"). The create asks Cloudflare Turnstile straight after its per-IP
// limit (server/turnstile.ts `requireTurnstile`, action `quickmatch`), and a refusal is a 303 back to the setup page with
// QUICK_MATCH_TURNSTILE_FAILED, as every refusal here is. turnstile-gate.test.ts proves the gate's placement and every token
// case against a mocked create; THIS block proves it on real rows: a refused create writes nothing and spends no mail bucket,
// and a passed one makes the match and does reach the mail bucket (the pair).
//
// Enforce mode is production on a named deployment with the secret and the allowed host set, the only mode that checks
// (`turnstileMode`). Cloudflare is a fake on global fetch that accepts a token once, for the action it was minted for; every
// other fetch passes through untouched. The wire strings are typed, not imported: the setup page and the widget agree on them.
describe.skipIf(!HAS_DB)("POST /api/quick-match: the bot check (Cloudflare Turnstile)", () => {
  const SECRET = "1x0000000000000000000000000000000AA"; // Cloudflare's published always-pass test secret
  const HOST = "stg.seazn.test";
  const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const HEADER = "cf-turnstile-response";
  const BOT_CHECK = "QUICK_MATCH_TURNSTILE_FAILED";
  const realFetch = globalThis.fetch;
  const minted = new Map<string, { action: string; spent: boolean }>();
  /** The tokens Cloudflare was asked about, in order. */
  const asked: string[] = [];
  let unreachable = false;

  const mint = (action: string) => {
    const token = `0.qm-${randomUUID()}`;
    minted.set(token, { action, spent: false });
    return token;
  };
  /** Production on a named deployment, with the secret and the allowed host: the only mode that checks. */
  const enforce = () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "stg");
    vi.stubEnv("TURNSTILE_SECRET", SECRET);
    vi.stubEnv("TURNSTILE_HOSTNAMES", HOST);
  };
  /** Every limiter bucket asked, through the limiter's own seam. The create's bucket allows; the per-IP MAIL bucket refuses, so
   *  a create that gets past the gate makes its match with no mail queued, and the record shows that bucket WAS asked. */
  const buckets = () => {
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return { count: key.startsWith("rl:quick-match-email:") ? 1_000 : 1, ttlMs: 60_000 };
    });
    return keys;
  };
  const refusedTo = (res: Response, locale: string) => {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${locale}/play?e=${BOT_CHECK}`);
  };

  beforeEach(() => {
    minted.clear();
    asked.length = 0;
    unreachable = false;
    vi.mocked(Sentry.captureException).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== SITEVERIFY) return realFetch(url, init);
        if (unreachable) throw new TypeError("fetch failed");
        const body = new URLSearchParams(String(init?.body));
        const token = body.get("response") ?? "";
        asked.push(token);
        const t = minted.get(token);
        const reply = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (body.get("secret") !== SECRET || !t || t.spent) return reply({ success: false, "error-codes": ["invalid-input-response"] });
        t.spent = true;
        return reply({ success: true, action: t.action, hostname: HOST, "error-codes": [] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("no token, as a post without the script carries none: refused in the form's language, no row, no mail bucket, no fault", async () => {
    enforce();
    const keys = buckets();
    const theirs = ip();
    const key = mintVisitorKey();
    const f = form({ locale: "fr", email: "guest@example.com" });
    const res = await post(f, { ip: theirs, cookie: key });
    refusedTo(res, "fr");
    expect(asked, "no token: Cloudflare is never asked").toEqual([]);
    expect(await rowsNamed(f.name as string)).toHaveLength(0);
    expect(await rowsFor(hashVisitorKey(key))).toHaveLength(0);
    expect(keys, "only the create's own limit: a refused create spends no mail bucket").toEqual([`rl:quick-match-create:${theirs}`]);
    expect(reported(), "a bot-check refusal is the guest's, not a fault: never reported").toEqual([]);
    expect(visitorCookies(res), "a refused create sets no visitor cookie").toEqual([]);
  });

  it("a token Cloudflare refuses (never minted; minted for the sign-in form): refused, nothing written, no mail bucket (counted)", async () => {
    enforce();
    let checked = 0;
    for (const token of ["never-minted", mint("login")]) {
      const keys = buckets();
      const theirs = ip();
      const f = form({ email: "guest@example.com" });
      refusedTo(await post(f, { ip: theirs, headers: { [HEADER]: token } }), "en");
      expect(asked.at(-1), "Cloudflare judged this request's own token").toBe(token);
      expect(await rowsNamed(f.name as string), token).toHaveLength(0);
      expect(keys, token).toEqual([`rl:quick-match-create:${theirs}`]);
      checked++;
    }
    expect(checked).toBe(2);
    expect(reported()).toEqual([]);
  });

  it("a good token minted for `quickmatch` makes the match, after a refused try that changed nothing (sequence; the pair)", async () => {
    enforce();
    const key = mintVisitorKey();
    const theirs = ip();
    const keys = buckets();
    const first = form({ email: "guest@example.com" });
    refusedTo(await post(first, { ip: theirs, cookie: key }), "en");
    // The guest taps Start again: the same visitor, the widget's token this time.
    const second = form({ email: "guest@example.com" });
    const token = mint("quickmatch");
    const res = await post(second, { ip: theirs, cookie: key, headers: { [HEADER]: token } });
    expect(res.status).toBe(303);
    // The home, with the mail line: the mail bucket refused this create's mail (above), so the match was made without it.
    expect(res.headers.get("location")).toMatch(/^\/q\/qm_[A-Za-z0-9_-]{43}\?e=QUICK_MATCH_EMAIL_LIMITED$/);
    expect(await rowsFor(hashVisitorKey(key))).toEqual([expect.objectContaining({ name: second.name, email: null })]);
    expect(await rowsNamed(first.name as string)).toHaveLength(0);
    expect(asked).toEqual([token]);
    // The positive pair of "no mail bucket": past the gate, the per-IP mail bucket IS asked.
    expect(keys).toEqual([
      `rl:quick-match-create:${theirs}`,
      `rl:quick-match-create:${theirs}`,
      `rl:quick-match-email:${theirs}`,
    ]);
  });

  it("the gate runs BEFORE the schema: a form it refuses, posted with no token, is the bot check's refusal (m1; counted)", async () => {
    // Two shapes from the schema table above. With no token each is the bot check's refusal, never CREATE_FAILED, so a post
    // without the script learns nothing about the form. The pair proves each form IS one the schema refuses: with a good
    // `quickmatch` token it gets past the gate and the schema answers CREATE_FAILED, so the no-token answer can only come from a
    // gate that ran first.
    const cases: [string, Fields][] = [["one side", { sides: ["Solo"] }], ["a stray field", { seeds: "1" }]];
    let checked = 0;
    for (const [what, over] of cases) {
      enforce();
      buckets();
      asked.length = 0;
      const f = form({ locale: "es", ...over });
      refusedTo(await post(f), "es");
      expect(asked, `${what}: no token, so Cloudflare is never asked`).toEqual([]);
      const token = mint("quickmatch");
      const past = await post(f, { headers: { [HEADER]: token } });
      expect(past.status, what).toBe(303);
      const schemaRefused = "/es/play?e=QUICK_MATCH_CREATE_FAILED";
      expect(past.headers.get("location"), `${what}: past the gate, the schema refuses it`).toBe(schemaRefused);
      expect(asked, `${what}: the gate asked about the good token`).toEqual([token]);
      expect(await rowsNamed(f.name as string), what).toHaveLength(0);
      expect(reported(), `${what}: both are the guest's refusals, never reported`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("Turnstile unavailable fails CLOSED: Cloudflare unreachable, or a deployment that lost its secret, refuses a real token (counted)", async () => {
    let checked = 0;
    for (const outage of ["unreachable", "secret unset"] as const) {
      enforce();
      if (outage === "unreachable") unreachable = true;
      else vi.stubEnv("TURNSTILE_SECRET", "");
      const keys = buckets();
      const theirs = ip();
      const f = form({ email: "guest@example.com", locale: "nl" });
      refusedTo(await post(f, { ip: theirs, headers: { [HEADER]: mint("quickmatch") } }), "nl");
      expect(await rowsNamed(f.name as string), outage).toHaveLength(0);
      expect(keys, outage).toEqual([`rl:quick-match-create:${theirs}`]);
      expect(reported(), `${outage}: refused, not reported as a create fault`).toEqual([]);
      unreachable = false;
      checked++;
    }
    expect(checked).toBe(2);
    // The pair: Cloudflare back and the secret set, a fresh token makes the match.
    enforce();
    buckets();
    const f = form();
    landedToken(await post(f, { headers: { [HEADER]: mint("quickmatch") } }));
    expect(await rowsNamed(f.name as string)).toHaveLength(1);
  });

  it("a harness server (ENV_NAME ci, as e2e runs) skips the check: no token needed, Cloudflare never asked", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "ci");
    vi.stubEnv("TURNSTILE_SECRET", SECRET);
    vi.stubEnv("TURNSTILE_HOSTNAMES", HOST);
    buckets();
    const f = form();
    landedToken(await post(f));
    expect(asked).toEqual([]);
    expect(await rowsNamed(f.name as string)).toHaveLength(1);
  });
});
