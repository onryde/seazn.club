// A one-time sign-in token must not reach telemetry.
//
// The emailed link is `/magic-link?token=<one-time>&next=…` (and `/verify-email?token=…&next=…`). The page lands, PostHog's
// `$pageview` fires on landing, and only AFTER that does the island POST the token to be consumed. So for the whole
// window between landing and consumption a still-live credential sits in `$current_url` (consent-gated, but a third
// party), in Sentry's request URL, breadcrumbs and `request.query_string`, and in a replay's URL list. Each such URL's
// `token=` query value becomes `token=[token]`, plain or URL-encoded at any depth, and the rest of the URL is kept.
// The same holds for every other single-use token a link carries to a page that consumes it (reset-password, the funnel
// claim, an impersonation hand-off, an email-change confirmation).
//
// Every token here is minted by the REAL minter (`createLoginLink`, `createVerificationToken`,
// `createPasswordResetToken`, `createImpersonationToken`; only the Postgres round trip is a stand-in, see
// _fake-sql.ts), and every link is built by the REAL route that emails it (magic-link, signup, forgot-password). The
// expected value of each case is the same string with the minted token swapped for the placeholder, never a typed
// literal, and never taken from the scrubber's own route list: the routes swept are the ones the app's own link
// builders name (a source scan), so a new builder cannot ship unscrubbed without this file saying so.
//
// Sport: not applicable — sign-in is sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import type { Event } from "@sentry/nextjs";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.31" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// Only the Postgres round trip is a stand-in: the real minters and the real routes run on top of it.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));
vi.mock("@/lib/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/users")>()),
  resolveOrCreateUser: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/legal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/legal")>()),
  stampTermsAcceptance: vi.fn(async () => {}),
}));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; link: string }[] }));
vi.mock("@/lib/email", async (importOriginal) => {
  const record = vi.fn(async (to: string, link: string) => {
    mail.sent.push({ to, link });
    return true;
  });
  return {
    ...(await importOriginal<typeof import("@/lib/email")>()),
    sendMagicLinkEmail: record,
    sendVerificationEmail: record,
    sendPasswordResetEmail: record,
  };
});

import { inserts, USER_ID } from "./_fake-sql";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import { createPasswordResetToken } from "@/lib/password-reset";
import { createImpersonationToken } from "@/lib/admin";
import { routes } from "@/lib/routes";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { posthogBeforeSend, scrubRecordingEvent, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";
import { POST as MAGIC_LINK } from "@/app/api/auth/magic-link/route";
import { POST as SIGNUP } from "@/app/api/auth/signup/route";
import { POST as FORGOT_PASSWORD } from "@/app/api/auth/forgot-password/route";

const ORIGIN = "https://seazn.club";
const PLACEHOLDER = "[token]";
const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const APP_DIR = path.join(SRC_DIR, "app");

/** The string with every occurrence of each minted secret swapped for the placeholder: the expected value of a case. */
const without = (url: string, ...secrets: string[]) => secrets.reduce((s, secret) => s.split(secret).join(PLACEHOLDER), url);
/** `encodeURIComponent`, applied `depth` times (a URL carried inside another URL's `next=`, and again inside that). */
const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};
/** Every percent-escape in lower-case hex, at any depth (`%252F` -> `%252f`). */
const lowerHex = (value: string) => value.replace(/(%(?:25)*)([0-9A-F]{2})/g, (_, pct: string, hex: string) => pct + hex.toLowerCase());

beforeEach(() => {
  mail.sent.length = 0;
  inserts.length = 0;
  vi.stubEnv("OAUTH_BASE_URL", ORIGIN);
});
afterEach(() => vi.unstubAllEnvs());

// ---- real tokens -------------------------------------------------------------------------------------------------

const pool = { login: [] as string[], verification: [] as string[], reset: [] as string[], impersonation: [] as string[] };
const MINTS = 300;
beforeAll(async () => {
  for (let i = 0; i < MINTS; i++) {
    pool.login.push(await createLoginLink(USER_ID));
    pool.verification.push(await createVerificationToken(USER_ID));
    pool.reset.push(await createPasswordResetToken(USER_ID));
    pool.impersonation.push(await createImpersonationToken(USER_ID, USER_ID));
  }
}, 60_000);

describe("premise: the minted tokens are real and varied", () => {
  it("each minter returned its full pool, every token unique and URL-safe, and the base64url alphabet's `-` and `_` both occur", () => {
    for (const [kind, tokens] of Object.entries(pool)) {
      expect(tokens, kind).toHaveLength(MINTS);
      expect(new Set(tokens).size, `${kind}: unique`).toBe(MINTS);
      for (const t of tokens) expect(encodeURIComponent(t), `${kind}: needs no escaping in a URL`).toBe(t);
    }
    for (const kind of ["login", "verification", "reset"] as const) {
      expect(pool[kind].some((t) => t.includes("-")), `${kind} has a '-'`).toBe(true);
      expect(pool[kind].some((t) => t.includes("_")), `${kind} has a '_'`).toBe(true);
    }
  });
});

// ---- the real emailed links -------------------------------------------------------------------------------------

type Route = (req: Request) => Promise<Response>;
/** POST to a real route and return the link it emailed, plus the token it minted (read off the row it inserted). */
async function drive(route: Route, pathname: string, table: string, body: unknown) {
  mail.sent.length = 0;
  inserts.length = 0;
  const res = await route(
    new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  expect(res.status, `${pathname} answered ${res.status}: ${await res.clone().text()}`).toBe(200);
  expect(mail.sent, `${pathname} emailed exactly one link`).toHaveLength(1);
  const minted = inserts.filter((i) => i.table === table).map((i) => i.values[1] as string);
  expect(minted, `${pathname} minted exactly one token into ${table}`).toHaveLength(1);
  const link = mail.sent[0]!.link;
  expect(link, "premise: the emailed link carries the minted token").toContain(minted[0]!);
  return { link, token: minted[0]! };
}

const hasRoute = (route: string) =>
  ["page.tsx", "route.ts"].some((file) => fs.existsSync(path.join(APP_DIR, route, file)));

const REAL_LINKS = [
  { name: "magic-link", route: MAGIC_LINK, pathname: "/api/auth/magic-link", table: "login_links", page: "/magic-link", body: (next?: string) => ({ email: "a@example.test", ...(next ? { next } : {}) }) },
  { name: "signup (verification)", route: SIGNUP, pathname: "/api/auth/signup", table: "email_verifications", page: "/verify-email", body: (next?: string) => ({ email: "b@example.test", password: "correct-horse-1", ...(next ? { next } : {}) }) },
] as const;

describe.each(REAL_LINKS)("the link the real $name route emails", ({ route, pathname, table, page, body }) => {
  it("is a page a browser opens, and its token is scrubbed with the rest of the URL kept", async () => {
    const { link, token } = await drive(route, pathname, table, body());
    expect(new URL(link).pathname).toBe(page);
    expect(hasRoute(page), `${page} is a real route`).toBe(true);
    expect(link, "premise: the token is a real query value").toBe(`${ORIGIN}${page}?token=${token}`);
    expect(scrubScoreUrl(link)).toBe(`${ORIGIN}${page}?token=${PLACEHOLDER}`);
  });

  it("with a next: the token is scrubbed and the encoded next is kept exactly", async () => {
    const { link, token } = await drive(route, pathname, table, body("/join/inv0123456789"));
    expect(link).toBe(`${ORIGIN}${page}?token=${token}&next=${encodeURIComponent("/join/inv0123456789")}`);
    expect(scrubScoreUrl(link)).toBe(`${ORIGIN}${page}?token=${PLACEHOLDER}&next=%2Fjoin%2Finv0123456789`);
  });

  it("with the Lichess start as its next (the match-room token two encodings deep): BOTH tokens are scrubbed, nothing else changes", async () => {
    const claims = { fixtureId: randomUUID(), personId: randomUUID(), roundOpenId: randomUUID(), roundOpenedAt: new Date().toISOString() };
    const room = await mintMatchRoomToken(claims);
    const startHref = lichessLinkStartHref("chess-club", routes.sharedFixturePlay("chess-club", "autumn-open", "open", claims.fixtureId, room));
    const { link, token } = await drive(route, pathname, table, body(startHref));
    expect(link, "premise: the room token is carried, encoded twice").toContain(`%253Ft%253D${room}`);
    const out = scrubScoreUrl(link);
    expect(out).toBe(without(link, token, room));
    expect(out).toContain(`token=${PLACEHOLDER}&next=`);
    expect(out).toContain(`%253Ft%253D${PLACEHOLDER}`);
    expect(scrubScoreUrl(out), "idempotent").toBe(out);
  });

  it("with a profile-claim link as its next (AuthForm sends next=/claim/<secret>): BOTH secrets are scrubbed", async () => {
    const secret = mintClaimSecret();
    const { link, token } = await drive(route, pathname, table, body(routes.claim(secret)));
    expect(link, "premise: the claim secret is carried, encoded once").toContain(`%2Fclaim%2F${secret}`);
    const out = scrubScoreUrl(link);
    expect(out).toBe(without(link, token, secret));
    expect(out).toBe(`${ORIGIN}${page}?token=${PLACEHOLDER}&next=%2Fclaim%2F${PLACEHOLDER}`);
  });
});

describe("the link the real forgot-password route emails", () => {
  it("is /reset-password?token=…, and its token is scrubbed", async () => {
    const { link, token } = await drive(FORGOT_PASSWORD, "/api/auth/forgot-password", "password_resets", { email: "c@example.test" });
    expect(hasRoute("/reset-password")).toBe(true);
    expect(scrubScoreUrl(link)).toBe(`${ORIGIN}/reset-password?token=${PLACEHOLDER}`);
    expect(without(link, token)).toBe(scrubScoreUrl(link));
  });
});

// ---- which links carry a one-time token: the app's own builders ---------------------------------------------------

/** Every `<path>?…token=${…}` template the app builds: the route a link is built FOR, mapped to where it is built. */
let scanned: Map<string, string> | undefined;
function linkBuilders(): Map<string, string> {
  if (scanned) return scanned;
  const found = new Map<string, string>();
  const builder = /(\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\?(?:[^`\s]*&)?token=\$\{/g;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && entry.name !== "scrub-score-url.ts") {
        const text = fs.readFileSync(full, "utf8");
        if (!text.includes("token=${")) continue;
        for (const m of text.matchAll(builder)) if (!found.has(m[1]!)) found.set(m[1]!, path.relative(SRC_DIR, full));
      }
    }
  };
  walk(SRC_DIR);
  return (scanned = found);
}

/** Builders whose token is NOT a one-time credential, each with the reason; the scrubber must leave them alone. */
const NOT_ONE_TIME: Record<string, string> = {
  "/register/status": "the cart's access token (RS006): reusable, the status page is re-opened to view and withdraw",
};

describe("every emailed ?token= link is scrubbed, or is knowingly not a one-time token", () => {
  const builders = linkBuilders();
  const live = () => pool.login[0]!;

  it("the scan found the builders (anti-vacuity), and each names a real route", () => {
    expect([...builders.keys()].sort()).toEqual(
      expect.arrayContaining(["/magic-link", "/verify-email", "/reset-password", "/start/claim", "/admin/impersonate", "/api/auth/change-email/confirm"]),
    );
    expect(builders.size).toBeGreaterThanOrEqual(7);
    for (const route of builders.keys()) {
      // "/register/status" is the tail of /shared/<org>/<comp>/register/status: a real page, under a dynamic prefix.
      if (route in NOT_ONE_TIME) continue;
      expect(hasRoute(route), `${route} (built in ${builders.get(route)}) is a real route`).toBe(true);
    }
  });

  it("each one-time builder's URL loses its token; each not-one-time builder's URL keeps it; no allow-list entry is stale", () => {
    let scrubbed = 0;
    let kept = 0;
    for (const [route, file] of builders) {
      const url = `${ORIGIN}${route}?token=${live()}`;
      if (route in NOT_ONE_TIME) {
        expect(scrubScoreUrl(url), `${route} (${file}): ${NOT_ONE_TIME[route]}`).toBe(url);
        kept++;
      } else {
        expect(scrubScoreUrl(url), `${route} (built in ${file}) must be scrubbed, or added to NOT_ONE_TIME with a reason`).toBe(without(url, live()));
        scrubbed++;
      }
    }
    for (const route of Object.keys(NOT_ONE_TIME)) expect(builders.has(route), `${route} is no longer built anywhere: delete it`).toBe(true);
    expect(scrubbed).toBeGreaterThanOrEqual(6);
    expect(kept).toBe(Object.keys(NOT_ONE_TIME).length);
  });
});

// ---- the sweep: every one-time route x every real token kind x every URL form --------------------------------------

const oneTimeRoutes = () => [...linkBuilders().keys()].filter((r) => !(r in NOT_ONE_TIME));

/** Each way a token-bearing URL reaches a telemetry hook. `url` is built for one route and one real token. */
const FORMS: { name: string; build: (route: string, t: string) => string }[] = [
  { name: "absolute URL", build: (r, t) => `${ORIGIN}${r}?token=${t}` },
  { name: "bare path", build: (r, t) => `${r}?token=${t}` },
  { name: "token first, next after", build: (r, t) => `${ORIGIN}${r}?token=${t}&next=%2Fjoin%2Fabc` },
  { name: "token after another parameter", build: (r, t) => `${ORIGIN}${r}?next=%2Fjoin%2Fabc&token=${t}` },
  { name: "token between two parameters", build: (r, t) => `${ORIGIN}${r}?a=1&token=${t}&b=2` },
  { name: "a hash after it", build: (r, t) => `${ORIGIN}${r}?token=${t}#top` },
  { name: "a trailing slash on the route", build: (r, t) => `${ORIGIN}${r}/?token=${t}` },
  { name: "quoted in a message", build: (r, t) => `GET "${ORIGIN}${r}?token=${t}" failed` },
  { name: "twice in one string", build: (r, t) => `from ${ORIGIN}${r}?token=${t} to ${ORIGIN}${r}?token=${t}` },
  { name: "the same parameter repeated", build: (r, t) => `${ORIGIN}${r}?token=${t}&token=${t}` },
  ...[1, 2, 3].flatMap((depth) =>
    (["upper", "lower"] as const).flatMap((hex) => [
      {
        name: `URL-encoded ${depth}x in a next=, ${hex}-case hex, token first`,
        build: (r: string, t: string) => {
          const url = `${ORIGIN}/login?next=${encode(`${ORIGIN}${r}?token=${t}&next=%2Fjoin%2Fabc`, depth)}`;
          return hex === "lower" ? lowerHex(url) : url;
        },
      },
      {
        name: `URL-encoded ${depth}x in a next=, ${hex}-case hex, token last`,
        build: (r: string, t: string) => {
          const url = `${ORIGIN}/login?lang=en&next=${encode(`${ORIGIN}${r}?next=%2Fjoin%2Fabc&token=${t}`, depth)}&x=1`;
          return hex === "lower" ? lowerHex(url) : url;
        },
      },
    ]),
  ),
];

describe("the sweep", () => {
  it("scrubs the minted token out of every form, for every one-time route, with every kind of real token; the rest of the URL is kept; a second pass changes nothing", () => {
    const routesSwept = oneTimeRoutes();
    expect(routesSwept.length).toBeGreaterThanOrEqual(6);
    // A few tokens per kind, spread across the pool so the charset's `-` and `_` are among them.
    const samples = Object.entries(pool).flatMap(([kind, tokens]) => [0, 1, 150, 299].map((i) => ({ kind, token: tokens[i]! })));
    let checked = 0;
    const failures: string[] = [];
    for (const route of routesSwept) {
      for (const { kind, token } of samples) {
        for (const form of FORMS) {
          const input = form.build(route, token);
          const out = scrubScoreUrl(input);
          const label = `${route} / ${kind} / ${form.name}`;
          // One verdict per case (a sweep this size stays fast): the premise, the expected value, the absence, idempotence.
          if (!input.includes(token)) failures.push(`${label}: the input does not carry the token`);
          else if (out !== without(input, token)) failures.push(`${label}: ${input} -> ${out}`);
          else if (out.includes(token)) failures.push(`${label}: the token survived`);
          else if (scrubScoreUrl(out) !== out) failures.push(`${label}: not idempotent`);
          checked++;
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBe(routesSwept.length * samples.length * FORMS.length);
    expect(checked).toBeGreaterThan(2000);
  });
});

// ---- what must be left alone ---------------------------------------------------------------------------------------

describe("a token= that is not on a one-time route is left alone", () => {
  const T = () => pool.login[0]!;
  // Every URL here ALSO names a one-time route (plain or encoded) somewhere harmless, so the scrubber's cheap pre-check
  // passes and the PATTERN has to refuse the `token=`: a URL with no route in it would be waved through by the pre-check alone.
  const cases: [string, (t: string) => string][] = [
    ["the registration status page's access token", (t) => `${ORIGIN}/shared/org/cup/register/status?rid=r1&token=${t}&back=%2Fmagic-link`],
    ["a public registration API read", (t) => `${ORIGIN}/api/v1/public/registrations/abc?token=${t}&from=/verify-email`],
    ["a route that only starts with a one-time route's name", (t) => `${ORIGIN}/magic-linkage?token=${t}`],
    ["a hyphenated route that begins with a one-time route's name", (t) => `${ORIGIN}/x/magic-link-old?token=${t}`],
    ["a one-time route's name as a path segment, no query", (t) => `visited /magic-link then ${ORIGIN}/other?token=${t}`],
    ["a hash before the query", (t) => `${ORIGIN}/magic-link#x?token=${t}`],
    ["the same names, encoded", (t) => `${ORIGIN}/login?next=%2Fother%3Ftoken%3D${t}&from=%2Fmagic-link`],
    ["a one-time route's query, then an OUTER token after a plain &", (t) => `${ORIGIN}/login?next=%2Fverify-email%3Fa%3D1&token=${t}`],
  ];

  it.each(cases)("%s", (_name, build) => {
    const url = build(T());
    expect(url).toContain(T());
    expect(scrubScoreUrl(url)).toBe(url);
  });

  it("other parameter names on a one-time route are left alone (token must be the whole name)", () => {
    for (const name of ["mytoken", "tokens", "token_id", "xtoken", "Token"]) {
      const url = `${ORIGIN}/magic-link?${name}=${T()}`;
      expect(scrubScoreUrl(url), name).toBe(url);
      const encoded = `${ORIGIN}/login?next=${encodeURIComponent(`${ORIGIN}/magic-link?${name}=${T()}`)}`;
      expect(scrubScoreUrl(encoded), `${name} encoded`).toBe(encoded);
    }
  });

  it("the positive pair: the same shapes on a one-time route DO lose the token", () => {
    const plain = `${ORIGIN}/magic-link?token=${T()}`;
    expect(scrubScoreUrl(plain)).toBe(`${ORIGIN}/magic-link?token=${PLACEHOLDER}`);
    const encoded = `${ORIGIN}/login?next=${encodeURIComponent(`/verify-email?a=1&token=${T()}`)}`;
    expect(scrubScoreUrl(encoded)).toBe(without(encoded, T()));
    expect(scrubScoreUrl(encoded)).not.toContain(T());
  });
});

describe("an empty token=", () => {
  it("is left exactly as it is, plain and encoded, and does not stop a live token beside it being scrubbed", () => {
    const live = pool.verification[0]!;
    for (const empty of [
      `${ORIGIN}/magic-link?token=`,
      `${ORIGIN}/magic-link?token=&next=%2Fjoin%2Fabc`,
      `${ORIGIN}/verify-email?next=%2Fjoin%2Fabc&token=`,
      `${ORIGIN}/login?next=${encodeURIComponent(`${ORIGIN}/magic-link?token=&next=%2Fjoin%2Fabc`)}`,
      `${ORIGIN}/login?next=${encode(`${ORIGIN}/magic-link?token=`, 2)}`,
    ]) {
      expect(scrubScoreUrl(empty), empty).toBe(empty);
    }
    const both = `${ORIGIN}/magic-link?token=&token=${live}`;
    expect(scrubScoreUrl(both)).toBe(`${ORIGIN}/magic-link?token=&token=${PLACEHOLDER}`);
    const bothEncoded = `${ORIGIN}/login?next=${encode(`${ORIGIN}/magic-link?token=&token=${live}`, 1)}`;
    expect(scrubScoreUrl(bothEncoded)).toBe(without(bothEncoded, live));
  });
});

// ---- the hooks -------------------------------------------------------------------------------------------------

describe("the hooks, on the real emailed links", () => {
  it("PostHog: the $pageview on landing (and its referrer, autocaptured hrefs and person properties) loses the token", async () => {
    const magic = await drive(MAGIC_LINK, "/api/auth/magic-link", "login_links", { email: "d@example.test", next: "/join/inv0123456789" });
    const verify = await drive(SIGNUP, "/api/auth/signup", "email_verifications", { email: "e@example.test", password: "correct-horse-1" });
    const event: CaptureResult = {
      uuid: "u1",
      event: "$pageview",
      properties: {
        $current_url: magic.link,
        $pathname: "/magic-link",
        $referrer: verify.link,
        $elements: [{ attr__href: verify.link }],
      },
      $set_once: { $initial_current_url: magic.link, $initial_referrer: verify.link },
    } as unknown as CaptureResult;
    const out = posthogBeforeSend(event);
    expect(out, "a sign-in page is not a staff page: the event is kept").not.toBeNull();
    const text = JSON.stringify(out);
    expect(text).not.toContain(magic.token);
    expect(text).not.toContain(verify.token);
    expect(out!.properties.$current_url).toBe(without(magic.link, magic.token));
    expect(out!.properties.$pathname).toBe("/magic-link");
    expect(JSON.stringify(event), "the input is never mutated").toContain(magic.token);
  });

  it("PostHog drops a staff page's event whole, so /admin/impersonate's own pageview never carries its token", () => {
    const token = pool.impersonation[0]!;
    const event = { uuid: "u2", event: "$pageview", properties: { $current_url: `${ORIGIN}/admin/impersonate?token=${token}`, $pathname: "/admin/impersonate" } } as unknown as CaptureResult;
    expect(posthogBeforeSend(event)).toBeNull();
  });

  it("Sentry: the request URL, headers, breadcrumbs, spans and transaction of an error on the page", async () => {
    const { link, token } = await drive(MAGIC_LINK, "/api/auth/magic-link", "login_links", { email: "f@example.test" });
    const event: Event = {
      event_id: "e1",
      transaction: `GET ${new URL(link).pathname}`,
      request: { url: link, headers: { Referer: link }, query_string: `token=${token}` },
      breadcrumbs: [
        { category: "navigation", data: { from: link, to: `${ORIGIN}/dashboard` } },
        { category: "fetch", data: { url: link } },
      ],
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": link } }],
    };
    const out = scrubSentryEvent(event);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.request?.url).toBe(`${ORIGIN}/magic-link?token=${PLACEHOLDER}`);
    expect(out.request?.query_string).toBe(`token=${PLACEHOLDER}`);
    expect(JSON.stringify(event), "the input is never mutated").toContain(token);
  });

  it("Sentry Replay: a replay_event's URL list and a recording frame's URL", async () => {
    const { link, token } = await drive(SIGNUP, "/api/auth/signup", "email_verifications", { email: "g@example.test", password: "correct-horse-1" });
    expect(JSON.stringify(scrubSentryEvent({ type: "replay_event", urls: [link] } as unknown as Event))).not.toContain(token);
    const frame = { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: link } } };
    expect(JSON.stringify(scrubRecordingEvent(frame))).not.toContain(token);
  });
});

// ---- Sentry's bare request.query_string ----------------------------------------------------------------------------

describe("Sentry's request.query_string (no `?`) is scrubbed when the event is on a one-time route, and only then", () => {
  const T = () => pool.login[5]!;
  const onRoute = (route: string): Event => ({ event_id: "e", request: { url: `${ORIGIN}${route}?token=${T()}&next=%2Fjoin%2Fabc`, query_string: `token=${T()}&next=%2Fjoin%2Fabc` } });

  it("every one-time route: the string form", () => {
    const routesSwept = oneTimeRoutes();
    let checked = 0;
    for (const route of routesSwept) {
      const out = scrubSentryEvent(onRoute(route));
      expect(out.request?.query_string, route).toBe(`token=${PLACEHOLDER}&next=%2Fjoin%2Fabc`);
      expect(JSON.stringify(out), route).not.toContain(T());
      checked++;
    }
    expect(checked).toBe(routesSwept.length);
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it("the token anywhere in the query, repeated, and an empty one beside a live one", () => {
    const ev = (qs: string): Event => ({ event_id: "e", request: { url: `${ORIGIN}/magic-link`, query_string: qs } });
    expect(scrubSentryEvent(ev(`next=%2Fjoin%2Fabc&token=${T()}`)).request?.query_string).toBe(`next=%2Fjoin%2Fabc&token=${PLACEHOLDER}`);
    expect(scrubSentryEvent(ev(`a=1&token=${T()}&b=2`)).request?.query_string).toBe(`a=1&token=${PLACEHOLDER}&b=2`);
    expect(scrubSentryEvent(ev(`token=${T()}&token=${T()}`)).request?.query_string).toBe(`token=${PLACEHOLDER}&token=${PLACEHOLDER}`);
    expect(scrubSentryEvent(ev(`token=&token=${T()}`)).request?.query_string).toBe(`token=&token=${PLACEHOLDER}`);
    expect(scrubSentryEvent(ev("token=")).request?.query_string).toBe("token=");
    expect(scrubSentryEvent(ev("mytoken=abc&tokens=abc")).request?.query_string).toBe("mytoken=abc&tokens=abc");
  });

  it("an event that names the route in its TRANSACTION alone (no request URL) is a one-time-route event too", () => {
    const out = scrubSentryEvent({ event_id: "e", transaction: "GET /verify-email", request: { query_string: `token=${T()}` } });
    expect(out.request?.query_string).toBe(`token=${PLACEHOLDER}`);
  });

  it("the object and pair-list forms Sentry's type allows are scrubbed too", () => {
    const asObject = scrubSentryEvent({ event_id: "e", request: { url: `${ORIGIN}/magic-link`, query_string: { token: T(), next: "/join/abc" } } });
    expect(asObject.request?.query_string).toEqual({ token: PLACEHOLDER, next: "/join/abc" });
    const asPairs = scrubSentryEvent({ event_id: "e", request: { url: `${ORIGIN}/magic-link`, query_string: [["token", T()], ["next", "/join/abc"]] as [string, string][] } });
    expect(asPairs.request?.query_string).toEqual([["token", PLACEHOLDER], ["next", "/join/abc"]]);
  });

  it("the positive pair: the SAME query string on any other route is kept, and so is an event with no request", () => {
    for (const url of [`${ORIGIN}/api/v1/public/registrations/abc`, `${ORIGIN}/shared/o/c/register/status`, `${ORIGIN}/magic-linkage`, `${ORIGIN}/dashboard`]) {
      const event: Event = { event_id: "e", request: { url, query_string: `token=${T()}` } };
      expect(scrubSentryEvent(event).request?.query_string, url).toBe(`token=${T()}`);
    }
    const bare: Event = { event_id: "e", transaction: "GET /magic-link" };
    expect(scrubSentryEvent(bare).request, "a one-time route's event with no request has nothing to scrub").toBeUndefined();
    const noQuery: Event = { event_id: "e", request: { url: `${ORIGIN}/magic-link` } };
    expect(scrubSentryEvent(noQuery).request).toEqual({ url: `${ORIGIN}/magic-link` });
  });

  it("is idempotent, and never mutates its input", () => {
    const event = onRoute("/magic-link");
    const snapshot = structuredClone(event);
    const once = scrubSentryEvent(event);
    expect(event).toEqual(snapshot);
    expect(scrubSentryEvent(once)).toEqual(once);
  });

  it("scoping is by the event's route, not by the value: a capture route's event is still a capture route's event", () => {
    const capture: Event = { event_id: "e", request: { url: `${ORIGIN}/api/v1/capture/codes/abc/beats`, query_string: `token=${T()}`, data: "{}" } };
    const out = scrubSentryEvent(capture);
    expect(out.request?.query_string, "not a one-time route: kept").toBe(`token=${T()}`);
    expect(Object.hasOwn(out.request ?? {}, "data"), "and still a capture event: its body is dropped").toBe(false);
  });
});
