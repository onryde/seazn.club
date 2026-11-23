// Lichess's API tips (lichess.org/page/api-tips, pasted by the owner 2026-11-22): "All requests going to lichess.org
// MUST include a User-Agent header with your website URL, or the name of your application, or a contact email".
// Before this test no Lichess call sent one (Node's fetch says `node`).
//
// Two halves, each anti-vacuous:
//   - the SOURCE SCAN finds every `fetch(` in the three files that talk to Lichess and holds each call's own argument
//     text to LICHESS_USER_AGENT, so a new call site without it reds here. Its per-file site counts are pinned: a new
//     site also owes a driven case below.
//   - the DRIVEN cases run each site through its real producer (the Board API client's every method, the OAuth
//     callback, the token revoke and the token test) over a stubbed fetch and read the header off the request.
// The expected header is the exported constant; the constant itself is held to the rule's own words (a URL or the
// application's name; no personal email), never to its own spelling.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
  headers: async () => new Headers(),
}));
const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), requireUser }));

import { sql } from "@/lib/db";
import {
  LICHESS_OAUTH_STATE_COOKIE,
  LICHESS_OAUTH_VERIFIER_COOKIE,
  LICHESS_USER_AGENT,
} from "@/lib/oauth";
import { createBoardApi } from "../lichess/board-api";
import { lichessGrantDowngraded, PLAY_SCOPES, unlinkLichess, upsertLichessLink } from "@/server/usecases/external-accounts";
import { GET as CALLBACK } from "@/app/api/auth/lichess/callback/route";

const HAS_DB = !!process.env.DATABASE_URL;
const WEB = join(__dirname, "../../../..");

/** Every file that sends a request to Lichess, and how many `fetch(` call sites it holds today. The FILE list is not
 *  trusted (review m3): the scan below derives it from src/ and must equal these keys, so a new module that calls Lichess
 *  reds until it is listed here with its count AND owes a driven case below. */
const SITES: Record<string, number> = {
  "src/server/external-play/lichess/board-api.ts": 2, // the shared `call` helper; readGameStream's first-line read
  "src/server/usecases/external-accounts.ts": 2, // revokeAtLichess (DELETE /api/token); testAtLichess (POST /api/token/test)
  "src/app/api/auth/lichess/callback/route.ts": 3, // token exchange; account read; the revoke of an unstored grant
};

type Sent = { url: string; method: string; ua: string | null };
function recorder(answer: (url: string, method: string) => Response) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    sent.push({ url, method, ua: new Headers(init?.headers).get("user-agent") });
    return answer(url, method);
  });
  return { sent, fetch: fn as unknown as typeof fetch };
}

/** The argument text of every `fetch(` / `fetchFn(` call in `src` (comment lines dropped), by balanced parentheses. */
function fetchCalls(src: string): string[] {
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const out: string[] = [];
  const re = /\b(?:fetch|fetchFn)\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
    }
    out.push(code.slice(m.index, i));
  }
  return out;
}

describe("LICHESS_USER_AGENT — the rule's own words", () => {
  it("names our website URL and our application, and carries no personal email", () => {
    expect(LICHESS_USER_AGENT).toContain("https://seazn.club");
    expect(LICHESS_USER_AGENT).toMatch(/Seazn/);
    expect(LICHESS_USER_AGENT).not.toContain("@");
  });
});

/** Every non-test source file under src/ whose CODE (comment lines dropped) names a Lichess URL - lichess.org itself or
 *  any LICHESS_*_URL constant (lib/oauth.ts) - and calls fetch. */
function lichessFetchingFiles(): { files: string[]; scanned: number } {
  const all: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec|load)\.tsx?$/.test(name)) all.push(p);
    }
  };
  walk(join(WEB, "src"));
  const files = all
    .filter((p) => {
      const code = readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      return /LICHESS_[A-Z_]*URL\b|lichess\.org/.test(code) && fetchCalls(code).length > 0;
    })
    .map((p) => p.slice(WEB.length + 1));
  return { files: files.sort(), scanned: all.length };
}

describe("every fetch( that reaches Lichess passes LICHESS_USER_AGENT (source scan)", () => {
  it("the files that call Lichess are DERIVED from src/, and are exactly the pinned ones", () => {
    const { files, scanned } = lichessFetchingFiles();
    expect(scanned, "anti-vacuity: src/ was walked").toBeGreaterThan(1_000);
    expect(files, "a file that names a Lichess URL and calls fetch, missing from SITES (or listed and gone)").toEqual(Object.keys(SITES).sort());
  });

  it("each call site's own arguments name the constant, and the site count per file is the pinned one", () => {
    let checked = 0;
    for (const [rel, expected] of Object.entries(SITES)) {
      const calls = fetchCalls(readFileSync(join(WEB, rel), "utf8"));
      expect(calls.length, `${rel}: fetch( call sites`).toBe(expected);
      for (const c of calls) {
        expect(c, `${rel}: ${c.slice(0, 80)}`).toContain("LICHESS_USER_AGENT");
        checked += 1;
      }
    }
    const total = Object.values(SITES).reduce((a, b) => a + b, 0);
    expect(checked, "anti-vacuity: every pinned site was scanned").toBe(total);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the Board API client (board-api.ts): every method sends the User-Agent", () => {
  it("drives all 12 methods through both fetch sites", async () => {
    const r = recorder((url) =>
      url.includes("/api/board/game/stream/") ? new Response("", { status: 404 }) : new Response("{}", { status: 200 }),
    );
    const api = createBoardApi({ fetch: r.fetch, baseUrl: "https://li.test" });
    const drive: Record<keyof typeof api, () => Promise<unknown>> = {
      createChallengeToUser: () => api.createChallengeToUser({ whiteToken: "t", blackUsername: "b", limitSeconds: 600, incrementSeconds: 5 }),
      acceptChallenge: () => api.acceptChallenge({ blackToken: "t", challengeId: "c" }),
      submitMove: () => api.submitMove({ token: "t", gameId: "g", uci: "e2e4" }),
      resignGame: () => api.resignGame({ token: "t", gameId: "g" }),
      offerOrAcceptDraw: () => api.offerOrAcceptDraw({ token: "t", gameId: "g", accept: true }),
      abortGame: () => api.abortGame({ token: "t", gameId: "g" }),
      exportGame: () => api.exportGame("g"),
      cancelChallenge: () => api.cancelChallenge({ token: "t", challengeId: "c" }),
      listOutgoingChallenges: () => api.listOutgoingChallenges("t"),
      exportGameMeta: () => api.exportGameMeta("g"),
      listOngoingGames: () => api.listOngoingGames("t"),
      readGameStream: () => api.readGameStream({ token: "t", gameId: "g" }),
    };
    // A method added to the client without a row here reds: the table is the client's own key set.
    expect(Object.keys(drive).sort()).toEqual(Object.keys(api).sort());
    let checked = 0;
    for (const [name, run] of Object.entries(drive)) {
      const before = r.sent.length;
      await run();
      const mine = r.sent.slice(before);
      expect(mine.length, `${name}: one request`).toBe(1);
      expect(mine[0]!.ua, name).toBe(LICHESS_USER_AGENT);
      checked += 1;
    }
    expect(checked).toBe(12);
    // Both sites of the file were reached: the shared helper and the stream read.
    const stream = r.sent.filter((s) => s.url.includes("/api/board/game/stream/"));
    expect(stream.length, "readGameStream's own fetch").toBe(1);
    expect(r.sent.length - stream.length, "the shared call helper").toBe(11);
  });
});

describe("the OAuth callback (callback/route.ts): token exchange, account read and the revoke", () => {
  beforeEach(() => {
    cookieJar.clear();
    vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
    requireUser.mockReset().mockResolvedValue({ id: "u1" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("an account read Lichess refuses: all three requests the route makes carry the User-Agent", async () => {
    cookieJar.set(LICHESS_OAUTH_STATE_COOKIE, "st");
    cookieJar.set(LICHESS_OAUTH_VERIFIER_COOKIE, "ver");
    const r = recorder((url, method) => {
      if (url.endsWith("/api/token") && method === "POST") return new Response(JSON.stringify({ access_token: "lio_cb" }), { status: 200 });
      if (url.endsWith("/api/account")) return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 }); // the revoke
    });
    vi.stubGlobal("fetch", r.fetch);
    await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));
    expect(r.sent.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ["POST", "/api/token"],
      ["GET", "/api/account"],
      ["DELETE", "/api/token"],
    ]);
    let checked = 0;
    for (const s of r.sent) {
      expect(s.ua, `${s.method} ${s.url}`).toBe(LICHESS_USER_AGENT);
      checked += 1;
    }
    expect(checked).toBe(SITES["src/app/api/auth/lichess/callback/route.ts"]);
  });
});

describe.skipIf(!HAS_DB)("external-accounts.ts: the token test and the revoke", () => {
  beforeEach(() => {
    vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("lichessGrantDowngraded asks POST /api/token/test and unlinkLichess sends DELETE /api/token, both with the User-Agent", async () => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`ua-${randomUUID()}@test.local`}, 'UA User', true) returning id`;
    const userId = u!.id;
    const token = `lio_ua_${randomUUID().slice(0, 8)}`;
    const r = recorder((url) =>
      url.endsWith("/api/token/test")
        ? new Response(JSON.stringify({ [token]: { userId: "x", scopes: PLAY_SCOPES.join(","), expires: null } }), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", r.fetch);
    await upsertLichessLink(userId, { externalUserId: `ua-${randomUUID().slice(0, 8)}`, username: "ua", scopes: [...PLAY_SCOPES], token });
    expect(r.sent, "a first link revokes nothing").toEqual([]);
    expect(await lichessGrantDowngraded(userId)).toBe(false);
    await unlinkLichess(userId);
    expect(r.sent.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ["POST", "/api/token/test"],
      ["DELETE", "/api/token"],
    ]);
    let checked = 0;
    for (const s of r.sent) {
      expect(s.ua, `${s.method} ${s.url}`).toBe(LICHESS_USER_AGENT);
      checked += 1;
    }
    expect(checked).toBe(SITES["src/server/usecases/external-accounts.ts"]);
  });
});
