// Every page and route that READS a credential-looking query parameter has a verdict: scrubbed, or left visible with the reason.
//
// The URL rules are by name or by route, so a new page that reads `?foo_code=` is invisible to them until someone thinks of it.
// This scan finds the readers from the app's own files (`searchParams.get("x")`, a `searchParams: Promise<{ x?: string }>`
// type, a `const { x } = await searchParams` destructure), keeps the names that look like a credential (`token`, `t`, `st`,
// `key`, `code`, `state`, `secret`, `join`, `*_code`, `*_token`, `*_secret`, `*_key`), and fails until each
// `<file>:<param>` is in QUERY_VERDICTS:
//  - `true`: the scrubber removes its value. The URL is built from the route's own directory and a real (or real-shaped)
//    value, in every context a URL reaches telemetry in;
//  - a string: why the value is left visible. The URL is shown to come out UNCHANGED (the positive pair: the scrubber's rules
//    are specific, and a verdict that says "left visible" must be what happens). The OAuth callbacks' reason is also checked
//    against the callbacks' source, since a comment is a hypothesis.
//
// Sport: not applicable — credentials are sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { APP_DIR } from "./_route-scan";
import { createLoginLink } from "@/lib/login-link";
import { createPasswordResetToken } from "@/lib/password-reset";
import { createVerificationToken } from "@/lib/verification";
import { generateRefCode } from "@/lib/ref-code";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { scrubScoreUrl } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";

// ---- the scan -----------------------------------------------------------------------------------------------------------

/** A parameter name that looks like a credential. */
const CREDENTIAL_NAME = /^(?:token|t|st|key|code|state|secret|sig|signature|otp|nonce|join|[a-z]+_code|[a-z]+_token|[a-z]+_secret|[a-z]+_key)$/;

/** Every query parameter name a source reads, by the three ways a page or route reads one. */
function queryParamsRead(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/searchParams\.get\(\s*["']([\w-]+)["']\s*\)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/searchParams\s*:\s*Promise<\{([^}]*)\}>/g)) for (const n of m[1]!.matchAll(/(\w+)\??\s*:/g)) names.add(n[1]!);
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+(?:props\.)?searchParams/g)) {
    for (const n of m[1]!.split(",")) names.add(n.split(":")[0]!.trim());
  }
  names.delete("");
  return [...names].filter((n) => CREDENTIAL_NAME.test(n)).sort();
}

/** Every `app/**` page.tsx / route.ts(x) that reads a credential-looking parameter: `<file under app/>:<param>`. */
function readers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (["page.tsx", "route.ts", "route.tsx"].includes(entry.name)) {
        for (const param of queryParamsRead(fs.readFileSync(full, "utf8"))) found.push(`${path.relative(APP_DIR, full)}:${param}`);
      }
    }
  };
  walk(APP_DIR);
  return found.sort();
}

/** The reusable cart access token (RS006): the status page is re-opened to view and withdraw, so it is not scrubbed (NOT_ONE_TIME). */
const CART_TOKEN = "the cart's reusable access token (RS006, NOT_ONE_TIME in _route-scan.ts): the status page is re-opened to view and withdraw with it";
const OAUTH_CODE = "the OAuth authorization code: single-use, and redeemed only WITH a secret that never leaves the server";
const OAUTH_STATE = "the OAuth state: compared to an httpOnly cookie, so it is worth nothing to whoever reads the URL";

/** The verdict on each reader: `true` = scrubbed (and what kind of value); a string = why it is left visible. */
const QUERY_VERDICTS: Record<string, true | string> = {
  "magic-link/page.tsx:token": true,
  "verify-email/page.tsx:token": true,
  "reset-password/page.tsx:token": true,
  "start/claim/page.tsx:token": true,
  "admin/impersonate/page.tsx:token": true,
  "api/auth/change-email/confirm/route.ts:token": true,
  "(public)/shared/(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx:t": true,
  "(public)/shared/[orgSlug]/[competitionSlug]/register/join/page.tsx:join_code": true,
  "(public)/shared/[orgSlug]/[competitionSlug]/register/page.tsx:join": true,
  "api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join/route.ts:join_code": true,
  "(public)/r/[ref]/page.tsx:token": CART_TOKEN,
  "(public)/shared/[orgSlug]/[competitionSlug]/register/status/page.tsx:token": CART_TOKEN,
  "api/v1/public/registrations/[id]/route.ts:token": CART_TOKEN,
  "api/v1/public/registrations/[id]/ics/route.ts:token": CART_TOKEN,
  "api/auth/google/callback/route.ts:code": `${OAUTH_CODE} (Google: the client secret)`,
  "api/auth/google/callback/route.ts:state": OAUTH_STATE,
  "api/auth/lichess/callback/route.ts:code": `${OAUTH_CODE} (Lichess: the PKCE code_verifier, in an httpOnly cookie)`,
  "api/auth/lichess/callback/route.ts:state": OAUTH_STATE,
  "admin/overlay-gallery/page.tsx:code": "a staff-only stress input: a team's short name for the overlay gallery, not a credential",
};

const found = readers();

describe("the reader scan, on synthetic sources (so a new reader is found)", () => {
  it("finds a get(), a typed searchParams, a destructure, both quote styles, and ignores a non-credential name", () => {
    expect(queryParamsRead(`const t = url.searchParams.get("invite_code");\nconst x = req.searchParams.get('page');`)).toEqual(["invite_code"]);
    expect(queryParamsRead("props: { searchParams: Promise<{ join_code?: string; page?: string; state?: string }> }")).toEqual(["join_code", "state"]);
    expect(queryParamsRead("const { token, tab } = await searchParams;")).toEqual(["token"]);
    expect(queryParamsRead("const { api_key: apiKey } = await props.searchParams;")).toEqual(["api_key"]);
    expect(queryParamsRead('const x = searchParams.get("division_id"); const { postal } = await searchParams;')).toEqual([]);
    expect(queryParamsRead("no query read here")).toEqual([]);
  });
});

describe("every page and route that reads a credential-looking query parameter has a verdict", () => {
  it("the scan found the readers (anti-vacuity), and every one has a verdict; no verdict is stale", () => {
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found, "a page or route reads a credential-looking parameter: add it to QUERY_VERDICTS").toEqual(Object.keys(QUERY_VERDICTS).sort());
    // The names the review listed are in the scan.
    for (const k of ["register/join/page.tsx:join_code", "register/join/route.ts:join_code", "google/callback/route.ts:code", "lichess/callback/route.ts:state"]) {
      expect(found.some((f) => f.endsWith(k)), k).toBe(true);
    }
    expect(Object.values(QUERY_VERDICTS).filter((v) => v === true).length).toBeGreaterThanOrEqual(10);
    expect(Object.values(QUERY_VERDICTS).filter((v) => v !== true).length).toBeGreaterThanOrEqual(8);
  });
});

// ---- the witnesses ------------------------------------------------------------------------------------------------------

async function witnesses(): Promise<Record<string, string[]>> {
  const roomToken = () =>
    mintMatchRoomToken({ fixtureId: randomUUID(), personId: randomUUID(), roundOpenId: randomUUID(), roundOpenedAt: new Date().toISOString() });
  return {
    token: [await createLoginLink(USER_ID), await createVerificationToken(USER_ID), await createPasswordResetToken(USER_ID)],
    t: [await roomToken(), await roomToken()],
    join_code: [generateRefCode(), generateRefCode(), generateRefCode()],
    join: [generateRefCode(), generateRefCode(), generateRefCode()],
    // Left-visible kinds: shaped like the real thing.
    code: ["4/0AX4XfWh" + randomBytes(24).toString("base64url"), randomBytes(24).toString("base64url"), "TEAM"],
    state: [randomBytes(24).toString("base64url"), randomBytes(16).toString("hex")],
  };
}
/** The route key's URL path: route groups dropped, `[ref]` a reference, every other dynamic segment a UUID. */
const urlOf = (key: string): string => {
  const dir = path.dirname(key.split(":")[0]!);
  return (
    "/" +
    dir
      .split("/")
      .filter((seg) => !/^\(.*\)$/.test(seg))
      .map((seg) => (seg === "[ref]" ? "AB12CD34" : /^\[.*\]$/.test(seg) ? "00000000-0000-4000-8000-000000000001" : seg))
      .join("/")
  );
};
const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};

describe("each verdict is what the scrubber does", () => {
  it("true: the value is gone from the URL, bare, with an origin, and inside a login next= at depth 1 to 3; the other parameters stay", async () => {
    const pool = await witnesses();
    const failures: string[] = [];
    let checked = 0;
    for (const [key, verdict] of Object.entries(QUERY_VERDICTS)) {
      if (verdict !== true) continue;
      const param = key.split(":")[1]!;
      for (const value of pool[param] ?? []) {
        const url = `${urlOf(key)}?other=1&${param}=${encodeURIComponent(value)}&tail=2`;
        const contexts = [
          url,
          `${ORIGIN}${url}`,
          `${ORIGIN}${url}#top`,
          ...[1, 2, 3].map((d) => `${ORIGIN}/login?next=${encode(url, d)}`),
        ];
        for (const input of contexts) {
          const out = scrubScoreUrl(input);
          if (out.includes(value) || out.includes(encodeURIComponent(value))) failures.push(`${key}: the value survived in ${out}`);
          if (!input.includes("%") ? !out.includes("other=1") || !out.includes("tail=2") : false) failures.push(`${key}: another parameter was lost in ${out}`);
          checked++;
        }
      }
    }
    expect(pool.token.length + pool.t.length + pool.join_code.length, "premise: witnesses exist").toBeGreaterThanOrEqual(8);
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(150);
  });

  it("a string: the URL comes out unchanged, so 'left visible' is what happens", async () => {
    const pool = await witnesses();
    const cart = ["rg_" + randomBytes(24).toString("base64url")];
    let checked = 0;
    for (const [key, verdict] of Object.entries(QUERY_VERDICTS)) {
      if (verdict === true) continue;
      const param = key.split(":")[1]!;
      const values = param === "token" ? cart : (pool[param] ?? []);
      expect(values.length, `${key}: premise, a witness`).toBeGreaterThan(0);
      for (const value of values) {
        for (const url of [`${urlOf(key)}?${param}=${encodeURIComponent(value)}`, `${ORIGIN}${urlOf(key)}?x=1&${param}=${encodeURIComponent(value)}`]) {
          expect(scrubScoreUrl(url), `${key}: ${verdict}`).toBe(url);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });
});

describe("the OAuth reason is true of the callbacks' source (a comment is a hypothesis)", () => {
  const google = fs.readFileSync(path.join(APP_DIR, "api/auth/google/callback/route.ts"), "utf8");
  const lichess = fs.readFileSync(path.join(APP_DIR, "api/auth/lichess/callback/route.ts"), "utf8");
  it("Google: the code is redeemed with the client secret, and the state must equal the httpOnly cookie", () => {
    expect(google).toMatch(/client_secret:\s*process\.env\.GOOGLE_CLIENT_SECRET/);
    expect(google).toMatch(/grant_type:\s*"authorization_code"/);
    expect(google).toMatch(/jar\.get\(OAUTH_STATE_COOKIE\)/);
    expect(google).toMatch(/state !== expected/);
  });
  it("Lichess: PKCE, the code is redeemed with the verifier from a cookie and there is no client secret; the state must equal the cookie", () => {
    expect(lichess).toMatch(/code_verifier:\s*verifier/);
    expect(lichess).toMatch(/jar\.get\(LICHESS_OAUTH_VERIFIER_COOKIE\)/);
    expect(lichess).not.toMatch(/client_secret/);
    expect(lichess).toMatch(/jar\.get\(LICHESS_OAUTH_STATE_COOKIE\)/);
    expect(lichess).toMatch(/state !== expectedState/);
  });
  it("both cookies are httpOnly where the start routes set them (the value never reaches page JS)", () => {
    const starts = ["api/auth/google/route.ts", "api/auth/lichess/route.ts"];
    for (const start of starts) {
      const text = fs.readFileSync(path.join(APP_DIR, start), "utf8");
      expect(text, start).toMatch(/httpOnly:\s*true/);
      expect(text, start).toMatch(/jar\.set\(/);
    }
    expect(starts).toHaveLength(2);
  });
});
