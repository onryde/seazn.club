// Realtime push nudges (spec 2026-11-24 §3; plan Task 9 / T2.2): `GET /api/v1/match-day-code/realtime-token`, a Match Day code's
// subscriber token for its private topic `match-day:{codeId}` (V555), through the REAL route, the real door and a real HS256 mint
// whose output is verified with jose. Real Postgres required; skipped without DATABASE_URL.
//
// What is pinned, each against the plan's table, never the code under test:
//   - the 200: the v1 envelope, the contract's five keys, `private, no-store`, the claims the token carries (V555's `md_code_id`,
//     `sub md:{id}`, role/aud), and `expiresAt` in epoch SECONDS equal to the token's own `exp`;
//   - the TTL clamp: min(60 min, the code's expiry), with a code expiring in the hour, at exactly 60 min, one second past, and a day;
//   - the refusals (401 no bearer / a query-string credential / a foreign bearer, 410 withdrawn, 410 ended, 403 not open, 429) and
//     that none of them mints; a withdrawal after a mint refuses the next call (no re-mint);
//   - the sequence: a second call mints a FRESH token; each code's own topic and claim; an unconfigured, refused (http, padded,
//     query-bearing, userinfo, foreign host, oversize key) or failed-mint server answers 503 and never a token;
//   - the budgets: the realtime bucket is the code's own (the day read's untouched, another code's untouched), 120 a minute with
//     Retry-After; the day read now admits 1800 a minute and refuses the 1801st; failed lookups spend the IP's budget;
//   - the secret: the token and the md_ credential never reach a log line, a console line, a Sentry capture, a stored row or a
//     response header, across the whole sequence.
// Applies to another sport: N/A (no sport rules): the door reads no sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { jwtVerify } from "jose";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
// What reaches Sentry is counted at its own seam: v1()'s >=500 capture and the usecase's old `captureError` both end in
// `Sentry.captureException`, so ONE spy sees a double capture whichever side makes it.
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
  withScope: (cb: (scope: object) => void) => cb({ setUser() {}, setTag() {}, setExtras() {} }),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { __setRateLimitCounterForTests, MD_DAY_LIMIT, MD_REALTIME_LIMIT } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";
import { CaptureMatchdayRealtime, CaptureMatchdayRefusal } from "@/server/api-v1/capture-schemas";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { log } from "@/server/logger";
import { MATCH_DAY_TOKEN_TTL_SECONDS } from "@/lib/realtime";
import { matchDayRealtimeFor } from "@/server/usecases/match-day-realtime";
import { mintMatchDayCode, revokeMatchDayCode, type MatchDayCodeRow } from "@/server/usecases/match-day-codes";
import { at, seedDay, T0, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { GET as DAY } from "@/app/api/v1/match-day-code/route";
import { GET } from "../realtime-token/route";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE_URL = "https://mdrealtime.supabase.co";
const ANON_KEY = "sb_publishable_mdrealtime_anon";
const JWT_SECRET = `md-realtime-test-${randomBytes(24).toString("hex")}`;
const ENV_KEYS = [
  "DEVICE_LINK_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET",
  "SUPABASE_JWT_ALG", "SUPABASE_JWT_PRIVATE_KEY", "SUPABASE_JWT_SIGNING_KEY_B64", "SUPABASE_JWT_KID",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex");
  process.env.OAUTH_BASE_URL = "https://md.test.seazn.club";
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.SUPABASE_JWT_ALG = "HS256";
}
beforeEach(() => { baseEnv(); vi.mocked(Sentry.captureException).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); __setRateLimitCounterForTests(null); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const IP = "203.0.113.7";
const NOW = at(30);                       // 10:30Z on the code's day
const MIN = 60_000;
const SECRET_KEY = new TextEncoder().encode(JWT_SECRET);
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);
const PATH = "https://test.local/api/v1/match-day-code/realtime-token";

async function codeFor(day: Day, opts: { dayKey?: string } = {}): Promise<{ code: MatchDayCodeRow; token: string }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
  try {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: opts.dayKey ?? "2026-11-07", canApprove: false });
    return { code: row, token: tokenOf(url) };
  } finally {
    vi.useRealTimers();
  }
}
const headers = (bearer: string | null, ip = IP): Record<string, string> => ({ ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "x-forwarded-for": ip });
const door = (bearer: string | null, ip = IP, url = PATH): Promise<Response> => GET(new Request(url, { headers: headers(bearer, ip) }));
const dayRead = (bearer: string): Promise<Response> => DAY(new Request("https://test.local/api/v1/match-day-code", { headers: headers(bearer) }));
const guess = (): string => "md_" + randomBytes(32).toString("base64url");
type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; opens_at?: string }; requestId: string };
const bodyOf = async (res: Response): Promise<Body> => (await res.json()) as Body;
const dataOf = async (res: Response): Promise<CaptureMatchdayRealtime> => {
  expect(res.status).toBe(200);
  const b = await bodyOf(res);
  expect(b.ok).toBe(true);
  return CaptureMatchdayRealtime.parse(b.data);
};
/** The code's own `expires_at` as the database holds it, in epoch seconds: the oracle for a short code. */
async function expiresAtS(codeId: string): Promise<number> {
  const [r] = await sql<{ s: string }[]>`select extract(epoch from expires_at)::text as s from match_day_codes where id = ${codeId}`;
  return Math.floor(Number(r!.s));
}
/** A fixed-window counter with the Lua's semantics (as match-day-code-open.test.ts's), recording every key spent. */
function windowedRedis() {
  let now = 0;
  const keys = new Map<string, { count: number; expiresAt: number }>();
  const spent: string[] = [];
  __setRateLimitCounterForTests(async (key, windowSeconds) => {
    spent.push(key);
    let k = keys.get(key);
    if (k && k.expiresAt <= now) { keys.delete(key); k = undefined; }
    if (!k) { k = { count: 0, expiresAt: now + windowSeconds * 1000 }; keys.set(key, k); }
    k.count++;
    return { count: k.count, ttlMs: k.expiresAt - now };
  });
  return { advance: (ms: number) => (now += ms), spent };
}
const clockAt = (d: Date) => vi.useFakeTimers({ toFake: ["Date"], now: d });

describe.skipIf(!HAS_DB)("GET /api/v1/match-day-code/realtime-token", () => {
  let day: Day;
  beforeEach(async () => { day = await seedDay(); });

  describe("the 200", () => {
    it("the v1 envelope, the contract's five keys, `private, no-store`, and the claims V555 keys on", async () => {
      const { code, token } = await codeFor(day);
      clockAt(NOW);
      const res = await door(token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toMatch(/json/);
      const b = await bodyOf(res);
      expect(Object.keys(b).sort()).toEqual(["data", "ok", "requestId"]);
      expect(b.ok).toBe(true);
      const data = CaptureMatchdayRealtime.parse(b.data);
      expect(Object.keys(data).sort(), "exactly the contract's five keys").toEqual(["apikey", "expiresAt", "token", "topic", "url"]);
      expect(data.url).toBe(SUPABASE_URL);
      expect(data.apikey).toBe(ANON_KEY);
      expect(data.topic).toBe(`match-day:${code.id}`);
      // The token is a real HS256 JWT: V555's claim, the code's own subject, authenticated, verified against the signing secret.
      const { payload, protectedHeader } = await jwtVerify(data.token, SECRET_KEY, { audience: "authenticated", currentDate: NOW });
      expect(protectedHeader.alg).toBe("HS256");
      expect(payload).toMatchObject({ role: "authenticated", sub: `md:${code.id}`, md_code_id: code.id, aud: "authenticated" });
      expect(Object.keys(payload).filter((k) => /_id$/.test(k)), "one family claim, never another family's").toEqual(["md_code_id"]);
      expect(payload.exp, "expiresAt is the token's own exp, in epoch SECONDS").toBe(data.expiresAt);
      expect(data.expiresAt).toBeLessThan(10 ** 11);
    });

    it("never carries the token or the md_ credential in a response header, nor the credential in the body", async () => {
      const { token } = await codeFor(day);
      clockAt(NOW);
      const res = await door(token);
      const data = await dataOf(res.clone());
      let headerCount = 0;
      for (const [name, value] of res.headers) {
        expect(value.includes(data.token), `header ${name} carries the token`).toBe(false);
        expect(value.includes(token), `header ${name} carries the credential`).toBe(false);
        headerCount++;
      }
      expect(headerCount, "headers scanned").toBeGreaterThan(0);
      expect(JSON.stringify(await bodyOf(res)).includes(token), "the credential never comes back").toBe(false);
    });

    it("a ?token=md_… in the URL is never read: with no bearer it is 401, and beside a bearer the bearer's code is served", async () => {
      const a = await codeFor(day);
      const b = await codeFor(day);
      clockAt(NOW);
      const bare = await door(null, IP, `${PATH}?token=${a.token}`);
      expect(bare.status).toBe(401);
      const refusal = (await bodyOf(bare)).error!;
      expect(refusal.code).toBe("MD_UNKNOWN");
      expect(CaptureMatchdayRefusal.safeParse(refusal).success).toBe(true);
      // The query names code A, the bearer code B: B's channel, never A's.
      const both = await dataOf(await door(b.token, IP, `${PATH}?token=${a.token}`));
      expect(both.topic).toBe(`match-day:${b.code.id}`);
      expect(both.topic).not.toBe(`match-day:${a.code.id}`);
    });
  });

  describe("the TTL: min(60 min, the code's own expiry)", () => {
    it("a code whose day ends within the hour: expiresAt is the code's own expires_at, and the token's exp with it", async () => {
      const { code, token } = await codeFor(day);
      const endS = await expiresAtS(code.id);
      for (const remainingS of [1800, 59 * 60 + 59, 1]) {
        clockAt(new Date((endS - remainingS) * 1000));
        const data = await dataOf(await door(token));
        expect(data.expiresAt, `${remainingS} s left`).toBe(endS);
        const { payload } = await jwtVerify(data.token, SECRET_KEY, { audience: "authenticated", currentDate: new Date((endS - remainingS) * 1000) });
        expect(payload.exp).toBe(endS);
        vi.useRealTimers();
      }
    });

    it("exactly 60 minutes left: the hour and the code's end are the same instant; one second more: the hour", async () => {
      const { code, token } = await codeFor(day);
      const endS = await expiresAtS(code.id);
      clockAt(new Date((endS - 3600) * 1000));
      expect((await dataOf(await door(token))).expiresAt, "60:00 left").toBe(endS);
      vi.useRealTimers();
      const early = new Date((endS - 3601) * 1000);
      clockAt(early);
      const data = await dataOf(await door(token));
      expect(data.expiresAt, "60:01 left").toBe(Math.floor(early.getTime() / 1000) + 3600);
      expect(data.expiresAt).toBeLessThan(endS);
    });

    it("a code with a day to run: the token lives the full hour from this call, not the code's day", async () => {
      const { token } = await codeFor(day);
      clockAt(NOW);
      const data = await dataOf(await door(token));
      expect(MATCH_DAY_TOKEN_TTL_SECONDS, "the contract's 'up to 60 minutes'").toBe(60 * 60);
      expect(data.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 60 * 60);
    });
  });

  describe("refusals: the day read's own words, and none of them mints", () => {
    const expectNoToken = async (res: Response, status: number, word: string) => {
      expect(res.status).toBe(status);
      const b = await bodyOf(res);
      expect(b.ok).toBe(false);
      expect(b.data, "a refusal carries no data").toBeUndefined();
      expect(b.error!.code).toBe(word);
      expect(CaptureMatchdayRefusal.safeParse(b.error).success).toBe(true);
      expect(JSON.stringify(b), "no token-shaped value in a refusal").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(res.headers.get("cache-control") ?? "").not.toMatch(/public/);
    };

    it("401 MD_UNKNOWN: no bearer, a bearer that is not an md_ code, and an md_ code that does not exist", async () => {
      clockAt(NOW);
      for (const bearer of [null, "", "dl_" + "A".repeat(43), "sk_live_" + "b".repeat(24), "cap_" + "c".repeat(20), guess()]) {
        await expectNoToken(await door(bearer), 401, "MD_UNKNOWN");
      }
    });

    it("410 MD_WITHDRAWN, and a withdrawal AFTER a mint refuses the next call: no re-mint", async () => {
      const { code, token } = await codeFor(day);
      clockAt(NOW);
      const first = await dataOf(await door(token));
      expect(first.topic).toBe(`match-day:${code.id}`);
      await revokeMatchDayCode(day.auth, code.id);
      await expectNoToken(await door(token), 410, "MD_WITHDRAWN");
      // A second withdrawn lookup, and a withdrawal wins over an ended day (the organiser's act is the truer answer).
      clockAt(new Date((await expiresAtS(code.id)) * 1000 + 1000));
      await expectNoToken(await door(token), 410, "MD_WITHDRAWN");
    });

    it("410 MD_ENDED: at the code's expiry and after it", async () => {
      const { code, token } = await codeFor(day);
      const endS = await expiresAtS(code.id);
      for (const s of [endS, endS + 3600]) {
        clockAt(new Date(s * 1000));
        await expectNoToken(await door(token), 410, "MD_ENDED");
        vi.useRealTimers();
      }
    });

    it("410 MD_ENDED with under a second of code life left: floor(expiry) <= floor(now) would be a dead token in a 200", async () => {
      const { code, token } = await codeFor(day);
      const baseS = Math.floor(NOW.getTime() / 1000);               // a whole second inside the day
      await sql`update match_day_codes set expires_at = ${new Date(baseS * 1000 + 500)} where id = ${code.id}`;
      // The door's own answer for an ended day is the oracle for the word and the message.
      clockAt(new Date((await expiresAtS(code.id) + 7200) * 1000));
      const doorEnded = await bodyOf(await door(token));
      expect(doorEnded.error!.code).toBe("MD_ENDED");
      vi.useRealTimers();
      // 200 ms in, 300 ms left: the same whole second as the expiry -> exp == iat, a token dead on arrival.
      for (const ms of [200, 0, 499]) {
        clockAt(new Date(baseS * 1000 + ms));
        await expectNoToken(await door(token), 410, "MD_ENDED");
        expect((await bodyOf(await door(token))).error!.message, `${ms} ms in: the door's own message`).toBe(doorEnded.error!.message);
        vi.useRealTimers();
      }
      // Positive pair: one tick earlier (a prior whole second) the token has a second to live, and exp == the code's floor.
      clockAt(new Date(baseS * 1000 - 300));
      const data = await dataOf(await door(token));
      expect(data.expiresAt, "999 ms before the second: exp is the next second").toBe(baseS);
      const { payload } = await jwtVerify(data.token, SECRET_KEY, { audience: "authenticated", currentDate: new Date(baseS * 1000 - 300) });
      expect(payload.exp! - payload.iat!, "a token with a second to live").toBe(1);
    });

    it("403 MD_NOT_OPEN with opens_at, before the day starts", async () => {
      const { code, token } = await codeFor(day);
      const [r] = await sql<{ s: string }[]>`select extract(epoch from opens_at)::text as s from match_day_codes where id = ${code.id}`;
      const opensS = Math.floor(Number(r!.s));
      clockAt(new Date((opensS - 60) * 1000));
      const res = await door(token);
      const opensAt = (await bodyOf(res.clone())).error!.opens_at!;
      await expectNoToken(res, 403, "MD_NOT_OPEN");
      expect(new Date(opensAt).getTime()).toBe(opensS * 1000);
      vi.useRealTimers();
      clockAt(new Date(opensS * 1000));
      expect((await door(token)).status, "the instant it opens").toBe(200);
    });

    it("a refusal mints nothing: no row is written and the code's stored row is unchanged", async () => {
      const { code, token } = await codeFor(day);
      const rowText = async () => (await sql<{ t: string }[]>`select row_to_json(c)::text as t from match_day_codes c where id = ${code.id}`)[0]!.t;
      const uses = async () => (await sql<{ n: number }[]>`select count(*)::int as n from match_day_code_uses where code_id = ${code.id}`)[0]!.n;
      const before = { uses: await uses() };
      clockAt(NOW);
      const minted: string[] = [];
      for (let i = 0; i < 3; i++) minted.push((await dataOf(await door(token))).token);
      await revokeMatchDayCode(day.auth, code.id);
      const after = { row: await rowText(), uses: await uses() };
      expect(await door(token).then((r) => r.status)).toBe(410);
      expect(after.uses, "no use row written by a mint").toBe(before.uses);
      // The minted tokens are in no column of the code's row.
      for (const t of minted) expect(after.row.includes(t), "a minted token is stored in the code's row").toBe(false);
    });
  });

  describe("the sequence", () => {
    it("a second call mints a FRESH token: a later clock gives a later expiry and a different token, both valid", async () => {
      const { token } = await codeFor(day);
      clockAt(NOW);
      const first = await dataOf(await door(token));
      vi.useRealTimers();
      const later = new Date(NOW.getTime() + 10 * MIN);
      clockAt(later);
      const second = await dataOf(await door(token));
      expect(second.token).not.toBe(first.token);
      expect(second.expiresAt - first.expiresAt, "ten minutes later, ten minutes further").toBe(600);
      // The first is still a live token until its own exp: the door never revokes (a JWT cannot be).
      await jwtVerify(first.token, SECRET_KEY, { audience: "authenticated", currentDate: later });
      await jwtVerify(second.token, SECRET_KEY, { audience: "authenticated", currentDate: later });
    });

    it("another surface: two codes get their own topic and claim, and one's token names the other's topic nowhere", async () => {
      const a = await codeFor(day);
      const b = await codeFor(day);
      expect(a.code.id).not.toBe(b.code.id);
      clockAt(NOW);
      const [da, db] = [await dataOf(await door(a.token)), await dataOf(await door(b.token))];
      expect([da.topic, db.topic]).toEqual([`match-day:${a.code.id}`, `match-day:${b.code.id}`]);
      const [pa, pb] = [(await jwtVerify(da.token, SECRET_KEY, { audience: "authenticated", currentDate: NOW })).payload, (await jwtVerify(db.token, SECRET_KEY, { audience: "authenticated", currentDate: NOW })).payload];
      expect([pa.md_code_id, pb.md_code_id]).toEqual([a.code.id, b.code.id]);
      expect(JSON.stringify(pa).includes(b.code.id)).toBe(false);
    });

    it("the day read still answers the code beside it: a mint changes nothing the day read returns", async () => {
      const { token } = await codeFor(day);
      clockAt(NOW);
      const before = await (await dayRead(token)).json();
      await dataOf(await door(token));
      const after = await (await dayRead(token)).json();
      expect(after.ok).toBe(true);
      expect(after.data).toEqual(before.data);
    });
  });

  describe("a server that cannot serve one answers 503 REALTIME_UNAVAILABLE, never a token", () => {
    /** The refusal word the usecase logged last (`{codeId, refusal}`), so each guard is judged by ITS OWN word: the contract parse
     *  behind them refuses the same inputs with a 503 too, and a status alone would let either guard stand in for the other. */
    const lastRefusal = (warn: ReturnType<typeof vi.spyOn>): unknown => (warn.mock.calls.at(-1)?.[0] as { refusal?: string } | undefined)?.refusal;
    const refused = async (token: string, why: string) => {
      clockAt(NOW);
      const res = await door(token);
      expect(res.status, why).toBe(503);
      const b = await bodyOf(res);
      expect(b.ok).toBe(false);
      expect(b.error!.code).toBe("REALTIME_UNAVAILABLE");
      expect(b.data).toBeUndefined();
      expect(JSON.stringify(b)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(JSON.stringify(b).includes(SUPABASE_URL), "the refusal does not echo the url").toBe(false);
      vi.useRealTimers();
    };

    it("no Supabase configured at all (the empty case): no url, and no key", async () => {
      const { token } = await codeFor(day);
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      await refused(token, "no url");
      baseEnv();
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      await refused(token, "no key");
      baseEnv();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "";
      await refused(token, "an empty url");
    });

    it("the url guard: http, padded, query, fragment, userinfo and a url that is not a url are each refused; the plain https one is served", async () => {
      const { token } = await codeFor(day);
      const bad = [
        "http://mdrealtime.supabase.co",
        ` ${SUPABASE_URL}`,
        `${SUPABASE_URL} `,
        `${SUPABASE_URL}?apikey=x`,
        `${SUPABASE_URL}/#frag`,
        "https://user:pass@mdrealtime.supabase.co",
        "mdrealtime.supabase.co",
        "https://",
      ];
      let refusedCount = 0;
      const warn = vi.spyOn(log, "warn");
      for (const url of bad) {
        process.env.NEXT_PUBLIC_SUPABASE_URL = url;
        await refused(token, `url ${JSON.stringify(url)}`);
        expect(lastRefusal(warn), `url ${JSON.stringify(url)}: the url guard's own word`).toBe("url_not_contract");
        refusedCount++;
      }
      expect(refusedCount, "urls refused").toBe(bad.length);
      // The positive pair: the same server with the plain url, and with a path, is served, and the parsed value is what is sent.
      for (const url of [SUPABASE_URL, `${SUPABASE_URL}/`]) {
        process.env.NEXT_PUBLIC_SUPABASE_URL = url;
        clockAt(NOW);
        expect((await dataOf(await door(token))).url).toBe(url);
        vi.useRealTimers();
      }
    });

    it("the host guard: a configured project whose host is not NEXT_PUBLIC_SUPABASE_URL's is refused (a token is never handed out for another host)", async () => {
      const { code } = await codeFor(day);
      const mints: string[] = [];
      const port = (url: string) => ({ config: () => ({ url, apikey: ANON_KEY }), mint: async (id: string) => { mints.push(id); return "tok.tok.tok"; } });
      const warn = vi.spyOn(log, "warn");
      await expect(matchDayRealtimeFor(code, NOW, port("https://other-project.supabase.co"))).rejects.toMatchObject({ status: 503, code: "REALTIME_UNAVAILABLE" });
      expect(lastRefusal(warn), "the host guard's own word").toBe("host_not_project");
      expect(mints, "nothing was minted for another host").toEqual([]);
      const ok = await matchDayRealtimeFor(code, NOW, port(SUPABASE_URL));
      expect(ok.url).toBe(SUPABASE_URL);
      expect(mints).toEqual([code.id]);
    });

    it("the key guard: an oversize anon key is refused, a 512-character one is served", async () => {
      const { token } = await codeFor(day);
      const warn = vi.spyOn(log, "warn");
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k".repeat(513);
      await refused(token, "a 513-character key");
      expect(lastRefusal(warn), "the key guard's own word").toBe("apikey_not_contract");
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k".repeat(512);
      clockAt(NOW);
      expect((await dataOf(await door(token))).apikey).toHaveLength(512);
    });

    it("a mint that throws: 503, logged {err, codeId} and captured EXACTLY ONCE (v1's own capture, the original error as `cause`), the signing key's material in neither", async () => {
      const { code, token } = await codeFor(day);
      const error = vi.spyOn(log, "error");
      delete process.env.SUPABASE_JWT_SECRET;                       // the mint has no key
      await refused(token, "no signing key");
      const captured = vi.mocked(Sentry.captureException).mock.calls;
      expect(captured, "one failed mint, one Sentry capture (v1's; the usecase adds none)").toHaveLength(1);
      const err = captured[0]![0] as HttpError & { cause?: unknown };
      expect(err, "v1 captures the 503 itself").toBeInstanceOf(HttpError);
      expect(err.status).toBe(503);
      expect(err.cause, "the original mint error rides along as `cause`").toBeInstanceOf(Error);
      expect((err.cause as Error).message, "the cause is the mint's own failure, not a wrapper").not.toBe(err.message);
      expect(error.mock.calls.some(([o]) => (o as { codeId?: string })?.codeId === code.id && typeof (o as { err?: unknown }).err === "string"), "the usecase's own log line names {err, codeId}").toBe(true);
      baseEnv();
      process.env.SUPABASE_JWT_PRIVATE_KEY = "{not json";
      await refused(token, "a malformed signing key");
      expect(captured, "a second failed mint adds exactly one more").toHaveLength(2);
    });

    it("an answer that is not the contract's (a token past 4096 characters) is refused, naming the paths and never the token", async () => {
      const { code } = await codeFor(day);
      const warn = vi.spyOn(log, "warn");
      const giant = "x".repeat(5000);
      await expect(matchDayRealtimeFor(code, NOW, { config: () => ({ url: SUPABASE_URL, apikey: ANON_KEY }), mint: async () => giant })).rejects.toMatchObject({ status: 503 });
      const lines = warn.mock.calls.map((c) => JSON.stringify(c));
      expect(lines.length, "PREMISE: the refusal was logged").toBeGreaterThan(0);
      expect(lines.some((l) => l.includes("token")), "the failing path is named").toBe(true);
      for (const l of lines) expect(l.includes(giant), "the token is in a log line").toBe(false);
    });

    it("a blank code id never reaches a mint: the mint helper refuses it (Task 3)", async () => {
      const { code } = await codeFor(day);
      await expect(matchDayRealtimeFor({ ...code, id: "  " }, NOW)).rejects.toMatchObject({ status: 503 });
    });
  });

  describe("budgets, per code and never per client IP", () => {
    it("the pinned numbers: the realtime bucket 120 a minute, the day read 1800 a minute", () => {
      expect(MD_REALTIME_LIMIT).toEqual({ max: 120, windowSeconds: 60 });
      expect(MD_DAY_LIMIT, "150 phones x 12 reads a minute").toEqual({ max: 1800, windowSeconds: 60 });
    });

    it("120 calls in a minute are served, the 121st is 429 with Retry-After; the day read's bucket is untouched and another code's too", async () => {
      const a = await codeFor(day);
      const b = await codeFor(day);
      clockAt(NOW);
      const redis = windowedRedis();
      const statuses: number[] = [];
      for (let i = 0; i < 120; i++) statuses.push((await door(a.token)).status);
      expect(statuses).toEqual(Array(120).fill(200));
      const over = await door(a.token);
      expect(over.status).toBe(429);
      const retry = Number(over.headers.get("retry-after"));
      expect(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${over.headers.get("retry-after")}`).toBe(true);
      expect((await bodyOf(over)).data, "a 429 mints nothing").toBeUndefined();
      // Isolation: only this door's bucket of this code was spent.
      expect(new Set(redis.spent), "buckets spent").toEqual(new Set([`rl:mdrealtime:${a.code.id}`]));
      expect(redis.spent.filter((k) => k.startsWith("rl:mdday:")), "the day read's bucket").toEqual([]);
      expect((await dayRead(a.token)).status, "the day read is still admitted").toBe(200);
      expect((await door(b.token)).status, "another code's door").toBe(200);
      redis.advance(60_000);
      expect((await door(a.token)).status, "the next minute").toBe(200);
    });

    it("the day read admits 1800 a minute and refuses the 1801st; the realtime bucket is untouched by it", async () => {
      const { code, token } = await codeFor(day);
      clockAt(NOW);
      const redis = windowedRedis();
      const read = (budget: "day" | "realtime") =>
        matchDayCodeOf(new Request("https://test.local/x", { headers: headers(token) }), NOW, budget).then((c) => c.id, (e: HttpError) => e.status);
      let admitted = 0;
      for (let i = 0; i < 1800; i++) if ((await read("day")) === code.id) admitted++;
      expect(admitted, "the day read's first 1800").toBe(1800);
      expect(await read("day"), "the 1801st").toBe(429);
      expect(await read("realtime"), "the token door's bucket is its own").toBe(code.id);
      redis.advance(60_000);
      expect(await read("day"), "the next minute").toBe(code.id);
    });

    it("a guessing client is 429 past its failed-lookup budget at this door too, and a valid code from the same IP is still served", async () => {
      const { token } = await codeFor(day);
      clockAt(NOW);
      windowedRedis();
      const guesses: number[] = [];
      for (let i = 0; i < 31; i++) guesses.push((await door(guess())).status);
      expect(guesses.slice(0, 30)).toEqual(Array(30).fill(401));
      expect(guesses[30], "the 31st failed lookup in the minute").toBe(429);
      expect((await door(token)).status, "a valid code is never refused for the IP's failures").toBe(200);
    });
  });

  describe("the token is a secret", () => {
    it("never in a log line, a console line, a Sentry capture, a stored row or a response header, across a served sequence and every refusal", async () => {
      const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
      const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
      const spies = [...LEVELS.map((l) => vi.spyOn(log, l)), ...CONSOLE.map((m) => vi.spyOn(console, m)), vi.mocked(Sentry.captureException)];
      const { code, token } = await codeFor(day);
      const secrets: string[] = [token];
      const headerSets: Headers[] = [];
      const run = async (res: Response) => {
        headerSets.push(res.headers);
        if (res.status === 200) secrets.push((await dataOf(res.clone())).token);
        return res.status;
      };
      clockAt(NOW);
      windowedRedis();
      const seen: number[] = [];
      seen.push(await run(await door(token)));                                  // 200
      vi.useRealTimers();
      clockAt(new Date(NOW.getTime() + 2000));                                  // a later second: a different iat, a different token
      seen.push(await run(await door(token)));                                  // 200
      seen.push(await run(await door(null, IP, `${PATH}?token=${token}`)));     // 401 (a query credential)
      seen.push(await run(await door(guess())));                                // 401
      process.env.SUPABASE_JWT_SECRET = "";
      seen.push(await run(await door(token)));                                  // 503 (mint fails: logged + captured)
      baseEnv();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://mdrealtime.supabase.co";
      seen.push(await run(await door(token)));                                  // 503 (url refused: logged)
      baseEnv();
      for (let i = 0; i < 119; i++) await door(token);                           // spend the minute's bucket
      seen.push(await run(await door(token)));                                  // 429
      await revokeMatchDayCode(day.auth, code.id);
      seen.push(await run(await door(token)));                                  // 410
      expect(seen).toEqual([200, 200, 401, 401, 503, 503, 429, 410]);
      expect(secrets.length, "a credential and two minted tokens").toBe(3);
      expect(new Set(secrets).size).toBe(3);
      vi.useRealTimers();

      const text = (v: unknown): string => {
        if (typeof v === "string") return v;
        if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ""}\n${JSON.stringify(v, Object.getOwnPropertyNames(v))}`;
        try {
          return JSON.stringify(v, (_k, x: unknown) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ""}` : typeof x === "bigint" ? String(x) : x)) ?? String(v);
        } catch {
          return String(v);
        }
      };
      let scanned = 0;
      for (const spy of spies) {
        for (const args of spy.mock.calls as unknown[][]) {
          const line = args.map(text).join(" ");
          for (const s of secrets) expect(line.includes(s), `a ${spy.getMockName()} call carries a secret`).toBe(false);
          scanned++;
        }
      }
      expect(scanned, "log/console/Sentry calls scanned").toBeGreaterThan(0);
      expect(vi.mocked(log.warn).mock.calls.length, "PREMISE: the refused url was logged (and scanned)").toBeGreaterThan(0);
      expect(vi.mocked(log.error).mock.calls.length, "PREMISE: the failed mint was logged (and scanned)").toBeGreaterThan(0);
      expect(vi.mocked(Sentry.captureException).mock.calls.length, "PREMISE: the failed mint and the refused url were each captured once, by v1 (and scanned)").toBe(2);
      let headers = 0;
      for (const h of headerSets) for (const [name, value] of h) {
        for (const s of secrets) expect(value.includes(s), `header ${name} carries a secret`).toBe(false);
        headers++;
      }
      expect(headers, "response headers scanned").toBeGreaterThan(headerSets.length);
      // Stored: every row of this code and its uses, whole.
      const rows = await sql<{ t: string }[]>`
        select row_to_json(c)::text as t from match_day_codes c where c.id = ${code.id}
        union all select row_to_json(u)::text from match_day_code_uses u where u.code_id = ${code.id}`;
      expect(rows.length, "rows scanned").toBeGreaterThan(0);
      for (const { t } of rows) for (const s of secrets.slice(1)) expect(t.includes(s), "a stored row carries a minted token").toBe(false);
    });
  });
});
