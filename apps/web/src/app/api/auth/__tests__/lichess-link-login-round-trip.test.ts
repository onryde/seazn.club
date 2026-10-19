// A player who is not signed in cannot link Lichess from their personal match-room link.
//
// Staging, 2026-10-19. The match room's "Link Lichess" goes to /api/auth/lichess?org=<club>&next=<the room path>,
// the room path being /shared/<club>/<comp>/<div>/fixtures/<id>/play?t=<match-room JWT>. Signed out, the start sends
// the person to /login?next=<that whole URL, encoded again>, and the login page's form (it is a magic-link form)
// POSTs that `next` to /api/auth/magic-link, which answered 400 {"error":"Invalid input","issues":[{"code":"too_big",
// "maximum":500,"path":["next"]}]}. The `next` is the room link with its ~370-character token nested one level deep,
// which is longer than the 500 characters the sign-in schemas allowed. The player never saw a login; they saw a
// failed form, and the room's ?t= (the only thing that tells the room who they are) was the reason.
//
// This suite builds that URL the way the app does, with nothing typed in: the REAL token minter
// (`mintMatchRoomToken`, claims shaped as invite.ts shapes them), the REAL room path builder (`routes`), the REAL
// room-shell href builder (`lichessLinkStartHref`), the REAL start route, the REAL login page (the `next` it hands
// the form), the REAL form (`AuthForm`, submitted), the REAL magic-link / consume / signup / login / verify-email
// routes, and the REAL magic-link and verify pages' islands. It then follows the redirect the person is landed on
// back through the REAL start route and reads what the callback will use: the stored return path.
//
// Stand-ins, and only these: the mail senders (captured, never sent), the limiter (pinned in token-rate-limits),
// `next/headers` (a cookie jar Map, read back through the real `getCurrentUser`), `next/navigation`'s router, and
// the club lookup (`orgBySlug`: the start route's club check, not the thing under test; the online-chess flag is
// the config's own ONLINE_CHESS_ALWAYS override).
//
// Sport: chess only. The path is the chess external-play room's, but every hop after the start is sport-agnostic
// auth, so there is no other sport to sweep.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  // The options each `set` was given: the Set-Cookie header the route really wrote needs them (a Max-Age, a Path).
  options: new Map<string, Record<string, unknown> | undefined>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.20" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.values.set(name, value);
      jar.options.set(name, options);
    },
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

// ONE stable router object, so an island's effect fires once.
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, redirect: vi.fn() }));

const mail = vi.hoisted(() => ({ sent: [] as { to: string; link: string }[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendMagicLinkEmail: vi.fn(async (to: string, link: string) => {
    mail.sent.push({ to, link });
    return true;
  }),
  sendVerificationEmail: vi.fn(async (to: string, link: string) => {
    mail.sent.push({ to, link });
    return true;
  }),
}));

// The start route's club check: any slug is a club that is offered online chess (the flag is the config override).
vi.mock("@/server/slug-resolve", () => ({
  orgBySlug: vi.fn(async (slug: string) => ({ id: "org-1", name: "Club", slug })),
}));

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { hashPassword, safeNextPath } from "@/lib/auth";
import { NEXT_PATH_MAX_LENGTH, loginSchema } from "@/lib/types";
import { routes } from "@/lib/routes";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { LICHESS_OAUTH_NEXT_COOKIE } from "@/lib/oauth";
import { posthogBeforeSend, scrubScoreUrl, scrubSentryEvent } from "@/lib/scrub-score-url";
import { Slug } from "@/server/api-v1/schemas";
import { mintMatchRoomToken, verifyMatchRoomToken } from "@/server/usecases/match-room-token";
import { AuthForm } from "@/components/auth-form";
import { MagicLink } from "@/components/magic-link";
import { renderIsland, walk, type Props } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import LoginPage from "@/app/login/page";
import MagicLinkPage from "@/app/magic-link/page";
import { GET as START } from "../lichess/route";
import { POST as LOGIN } from "../login/route";
import { POST as SIGNUP } from "../signup/route";
import { POST as MAGIC_LINK } from "../magic-link/route";
import { POST as MAGIC_LINK_CONSUME } from "../magic-link/consume/route";
import { FIRST_RUN_WIZARD, ORIGIN, openVerifyLink, pageFileFor, warmDefaultLanding } from "./_verify-link";

const HAS_DB = !!process.env.DATABASE_URL;
const PASSWORD = "correct-horse-1";
const made: string[] = [];

/** The sign-in schemas' bound BEFORE this fix. Not an expected value: it is the line the staging link crossed, kept
 *  so a test whose link is shorter than it fails loudly instead of witnessing nothing. */
const FORMER_NEXT_CAP = 500;

/** RFC 6265 §6.1: a user agent must keep at least 4096 bytes per cookie, and real browsers drop one larger. */
const COOKIE_BYTES = 4096;

/** A real-length club, competition and division, and a real fixture id and match-room token. */
const SLUGS = { org: "chess-club-lagos", comp: "autumn-rapid-open-2026", div: "open-division" };

type Slugs = typeof SLUGS;

/** The personal link the invite mail carries (usecases/external-play/invite.ts), built from the same claims it mints
 *  with, then the href the room's "Link Lichess" points at (room-shell.tsx: `lichessLinkStartHref(orgSlug, selfPath)`). */
async function roomLink(slugs: Slugs = SLUGS) {
  const claims = {
    fixtureId: randomUUID(),
    personId: randomUUID(),
    roundOpenId: randomUUID(),
    roundOpenedAt: new Date().toISOString(),
  };
  const token = await mintMatchRoomToken(claims);
  const selfPath = routes.sharedFixturePlay(slugs.org, slugs.comp, slugs.div, claims.fixtureId, token);
  return { claims, token, selfPath, startHref: lichessLinkStartHref(slugs.org, selfPath) };
}
type RoomLink = Awaited<ReturnType<typeof roomLink>>;

/** The widest club, competition and division the slug schema allows. Derived from its own declaration, never a typed 80. */
function widestSlugs(): Slugs {
  const longest = Slug.maxLength;
  expect(typeof longest, "Slug declares a maximum").toBe("number");
  const wide: Slugs = { org: "o".repeat(longest!), comp: "c".repeat(longest!), div: "d".repeat(longest!) };
  expect(Slug.safeParse(wide.org).success, "that slug is a legal slug").toBe(true);
  return wide;
}

/** The start, signed out: the login URL it redirects to, exactly as written on the Location header. */
async function startSignedOutLocation(startHref: string): Promise<string> {
  jar.values.clear();
  jar.options.clear();
  const res = await START(new Request(`${ORIGIN}${startHref}`));
  const location = res.headers.get("location")!;
  expect(new URL(location, ORIGIN).pathname, "signed out, the start goes to the login page").toBe("/login");
  return location;
}

/** The same, read the way the login page reads it: the `next` the login URL carries. */
async function startSignedOut(startHref: string): Promise<string> {
  const next = new URL(await startSignedOutLocation(startHref), ORIGIN).searchParams.get("next");
  expect(next, "the login URL carries a next").not.toBeNull();
  return next!;
}

/** The Set-Cookie header the route REALLY wrote for `name`: the value and options it passed to `cookies().set`,
 *  serialised by the framework's own response cookies (URL-encoded value, every attribute). */
function writtenSetCookie(name: string): string {
  expect(jar.values.has(name), `the route set ${name}`).toBe(true);
  const res = NextResponse.next();
  res.cookies.set(name, jar.values.get(name)!, jar.options.get(name));
  return res.headers.get("set-cookie")!;
}

/** The real login page, handed the query a browser would hand it, and the `next` it gives its form. */
async function loginPageFormNext(loginNext: string): Promise<string | undefined> {
  const tree = await LoginPage({ searchParams: Promise.resolve({ next: loginNext }) });
  const form = walk(tree as ReactNode).find((el) => el.type === AuthForm);
  expect(form, "the login page renders the sign-in form").toBeDefined();
  return (form!.props as { next?: string }).next;
}

/** The two island endpoints a browser reaches, answered by the real routes. */
const ROUTES: Record<string, (req: Request) => Promise<Response>> = {
  "/api/auth/magic-link": MAGIC_LINK,
  "/api/auth/magic-link/consume": MAGIC_LINK_CONSUME,
};
const routeFetch = async (input: string, init: RequestInit) => {
  const url = new URL(input, ORIGIN);
  const route = ROUTES[url.pathname];
  if (!route) throw new Error(`no route stands in for ${url.pathname}`);
  return route(new Request(url, init));
};

/** Type an address into the real form and submit it; the form's own error text is returned for the failure message. */
async function submitSignInForm(next: string | undefined, email: string): Promise<{ shown: string }> {
  const island = renderIsland(AuthForm, { next });
  const field = island.tree().find((el) => (el.props as Props).type === "email");
  expect(field, "the form has an email field").toBeDefined();
  island.batch(() => (field!.props as { onChange: (v: string) => void }).onChange(email));
  const form = island.tree().find((el) => el.type === "form");
  expect(form, "the form has a submit handler").toBeDefined();
  vi.stubGlobal("fetch", routeFetch);
  try {
    await (form!.props as { onSubmit: (e: { preventDefault(): void }) => Promise<void> }).onSubmit({
      preventDefault() {},
    });
  } finally {
    vi.unstubAllGlobals();
  }
  return { shown: island.text() };
}

/** Open an emailed magic link the way a person does: the page, then its island, then the real consume route. */
async function openMagicLink(link: string): Promise<{ landed: string | null; shown: string }> {
  const url = new URL(link);
  expect(pageFileFor(url.pathname), `${url.pathname} must be a page a browser can open`).not.toBeNull();
  const tree = await MagicLinkPage({
    searchParams: Promise.resolve({
      token: url.searchParams.get("token") ?? undefined,
      next: url.searchParams.get("next") ?? undefined,
    }),
  });
  const el = walk(tree as ReactNode).find((e) => e.type === MagicLink);
  expect(el, "the magic-link page renders its island").toBeDefined();
  router.push.mockClear();
  vi.stubGlobal("fetch", routeFetch);
  try {
    const island = renderIsland(MagicLink, el!.props as { token: string | null; next: string | null });
    await vi.waitFor(
      () => {
        const settled = router.push.mock.calls.length > 0 || !island.text().includes(en["magicLink.signingIn"]);
        expect(settled, "the magic-link page settled").toBe(true);
      },
      { timeout: 20_000 },
    );
    return { landed: (router.push.mock.calls[0]?.[0] as string | undefined) ?? null, shown: island.text() };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Where the person lands next: the start again, now signed in. Returns what the callback will read back. */
async function followStartSignedIn(startHref: string): Promise<string | undefined> {
  const res = await START(new Request(`${ORIGIN}${startHref}`));
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname, "signed in, the start goes on to Lichess").toBe("https://lichess.org/oauth");
  return jar.values.get(LICHESS_OAUTH_NEXT_COOKIE);
}

/** The callback lands on this cookie (through `safeNextPath`): it must be the room path, with the token intact. */
async function expectBackOnTheRoom(stored: string | undefined, link: RoomLink) {
  expect(stored, "the start stored the room path").toBe(link.selfPath);
  expect(safeNextPath(stored), "and the callback accepts it").toBe(link.selfPath);
  const t = new URL(stored!, ORIGIN).searchParams.get("t");
  expect(t, "?t= is intact").toBe(link.token);
  expect(await verifyMatchRoomToken(t!), "and it still identifies the same player for the same fixture").toEqual(
    link.claims,
  );
}

beforeAll(async () => {
  if (HAS_DB) await warmDefaultLanding();
});

beforeEach(() => {
  jar.values.clear();
  jar.options.clear();
  mail.sent.length = 0;
  router.push.mockClear();
  router.refresh.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
});

afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from organizations where created_by = any(${made})`;
  await sql`delete from subscriptions where owner_user_id = any(${made})`;
  await sql`delete from users where id = any(${made})`;
});

async function verifiedUser(): Promise<{ id: string; email: string }> {
  const email = `lichess-next-${randomUUID()}@example.test`;
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, password_hash, display_name, email_verified)
    values (${email}, ${await hashPassword(PASSWORD)}, 'Lichess Next', true)
    returning id`;
  made.push(u.id);
  return { id: u.id, email };
}

async function userByEmail(email: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
  made.push(u.id);
  return u.id;
}

interface Envelope {
  ok: boolean;
  error?: string;
  issues?: { path: (string | number)[]; code: string }[];
  data?: { redirect: string };
}

async function post(route: (req: Request) => Promise<Response>, path: string, body: unknown) {
  const res = await route(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

// ---- no database: the URL itself -----------------------------------------------------------------------------------

describe("the real nested URL (no database)", () => {
  it("the room path the page hands the shell is the path the invite mail carries, and the start nests it exactly once", async () => {
    const link = await roomLink();
    // page.tsx builds `${snapshot.links.fixture}/play?t=<token>`, and room.ts sets links.fixture to routes.sharedFixture.
    const claims = link.claims;
    expect(link.selfPath).toBe(
      `${routes.sharedFixture(SLUGS.org, SLUGS.comp, SLUGS.div, claims.fixtureId)}/play?t=${encodeURIComponent(link.token)}`,
    );
    const loginNext = await startSignedOut(link.startHref);
    expect(loginNext, "the login URL carries the whole start, query included").toBe(link.startHref);
  });

  it("the link the staging player followed is longer than the old bound, and the sign-in schema now takes it", async () => {
    const link = await roomLink();
    const loginNext = await startSignedOut(link.startHref);

    // Anti-vacuity: a link shorter than the old bound would pass against the old schema too.
    expect(loginNext.length, "the real nested next exceeds the former bound").toBeGreaterThan(FORMER_NEXT_CAP);
    // The login page forwards it whole (safeNextPath is its only gate), and the form carries it on.
    expect(await loginPageFormNext(loginNext)).toBe(link.startHref);

    const parsed = loginSchema.safeParse({ email: "p@example.test", password: PASSWORD, next: loginNext });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("the longest real link still fits: the bound has headroom for 80-character slugs", async () => {
    const typical = await roomLink();
    const link = await roomLink(widestSlugs());
    const loginNext = await startSignedOut(link.startHref);
    const typicalNext = await startSignedOut(typical.startHref);

    expect(loginNext.length, "the widest club/competition/division makes the longer link").toBeGreaterThan(
      typicalNext.length,
    );
    expect(loginNext.length, "the widest real link is within the bound").toBeLessThanOrEqual(NEXT_PATH_MAX_LENGTH);
  });

  it("a long path to another origin is still refused, however it is spelled", () => {
    let checked = 0;
    for (const prefix of ["https://evil.example/", "//evil.example/", "/\\evil.example/", "javascript:alert(1)//"]) {
      const evil = `${prefix}${"a".repeat(FORMER_NEXT_CAP + 200 - prefix.length)}`;
      expect(evil.length, `${prefix}: longer than the old bound`).toBeGreaterThan(FORMER_NEXT_CAP);
      expect(evil.length, `${prefix}: within the new one, so the length is not what refuses it`).toBeLessThanOrEqual(
        NEXT_PATH_MAX_LENGTH,
      );
      expect(new URL(evil, ORIGIN).origin, `${prefix}: leaves the origin`).not.toBe(ORIGIN);
      expect(safeNextPath(evil), prefix).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    // The positive pair: a long SAME-ORIGIN path of the same length is let through.
    const sameOrigin = `/${"a".repeat(FORMER_NEXT_CAP + 199)}`;
    expect(safeNextPath(sameOrigin)).toBe(sameOrigin);
  });
});

// ---- telemetry: the token rides every one of these URLs -------------------------------------------------------------

describe("the match-room token never reaches telemetry (review I1)", () => {
  /** The scrubber's own placeholder style (`/score/[token]`, `key=[key]`): the value is swapped, the URL is kept. */
  const PLACEHOLDER = "[token]";
  /** The URL as it should come out: the same string with the REAL minted token swapped for the placeholder. */
  const without = (url: string, token: string) => url.split(token).join(PLACEHOLDER);

  it("depth 0, the room URL: ?t= and &t= both lose the token and keep everything else", async () => {
    const link = await roomLink();
    const url = `${ORIGIN}${link.selfPath}`;
    expect(url, "premise: the room URL carries the token").toContain(link.token);
    expect(scrubScoreUrl(url)).toBe(without(url, link.token));
    expect(scrubScoreUrl(url)).toContain(`/play?t=${PLACEHOLDER}`);

    const later = url.replace("?t=", "?lang=en&t=");
    expect(later, "premise: the token is now a later parameter").toContain("&t=");
    expect(scrubScoreUrl(later)).toBe(without(later, link.token));
    // Sentry's request.query_string carries no `?`: the parameter is first, then later.
    expect(scrubScoreUrl(`t=${link.token}`)).toBe(`t=${PLACEHOLDER}`);
    expect(scrubScoreUrl(`lang=en&t=${link.token}`)).toBe(`lang=en&t=${PLACEHOLDER}`);
  });

  it("depth 1, the Lichess start URL (the room path URL-encoded in its next=): %3Ft%3D loses the token, either hex case", async () => {
    const link = await roomLink();
    expect(link.startHref, "premise: one level of encoding around the token").toContain(`%3Ft%3D${link.token}`);
    expect(scrubScoreUrl(link.startHref)).toBe(without(link.startHref, link.token));
    expect(scrubScoreUrl(link.startHref)).toContain(`%3Ft%3D${PLACEHOLDER}`);

    const lower = link.startHref.replace(/%3F/g, "%3f").replace(/%3D/g, "%3d");
    expect(lower, "premise: lower-case hex").toContain(`%3ft%3d${link.token}`);
    expect(scrubScoreUrl(lower)).toBe(without(lower, link.token));
  });

  it("depth 2, the login URL the start redirects to (and the start inside it encoded again): %253Ft%253D loses the token", async () => {
    const link = await roomLink();
    const location = await startSignedOutLocation(link.startHref);
    expect(location, "premise: two levels of encoding around the token").toContain(`%253Ft%253D${link.token}`);
    expect(scrubScoreUrl(location)).toBe(without(location, link.token));
    expect(scrubScoreUrl(location)).toContain(`%253Ft%253D${PLACEHOLDER}`);

    const wide = await roomLink(widestSlugs());
    const wideLocation = await startSignedOutLocation(wide.startHref);
    expect(scrubScoreUrl(wideLocation), "the widest real link too").toBe(without(wideLocation, wide.token));
  });

  it("the real hooks: PostHog's before_send and Sentry's beforeSend scrub the room URL at every depth, wherever an event carries one", async () => {
    const link = await roomLink();
    const room = `${ORIGIN}${link.selfPath}`;
    const start = `${ORIGIN}${link.startHref}`;
    const login = `${ORIGIN}${await startSignedOutLocation(link.startHref)}`;
    for (const url of [room, start, login]) expect(url, "premise: each carries the token").toContain(link.token);

    const posthog = posthogBeforeSend({
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: room, $referrer: login, $pathname: "/x", $elements: [{ attr__href: start }] },
      $set_once: { $initial_current_url: login },
    });
    expect(posthog, "a room page is not a staff page: the event is kept").not.toBeNull();
    expect(JSON.stringify(posthog)).not.toContain(link.token);
    expect(posthog!.properties.$current_url).toBe(without(room, link.token));

    const sentry = scrubSentryEvent({
      event_id: "e1",
      transaction: `GET ${link.selfPath}`,
      request: { url: room, query_string: `t=${link.token}`, headers: { Referer: login } },
      breadcrumbs: [{ category: "navigation", data: { from: start, to: room } }],
    });
    expect(JSON.stringify(sentry)).not.toContain(link.token);
    expect(sentry.request?.url).toBe(without(room, link.token));
    expect(sentry.request?.query_string).toBe(`t=${PLACEHOLDER}`);
  });

  it("a t= that is not a match-room token is left alone, at every depth, and so is a token under any other name", async () => {
    // A time offset, a version, a date, a word: none is three long base64url segments.
    const notTokens = ["90s", "1.2.3", "2026.10.19", "top", "a.b.c", "abc123"];
    const forms: ((v: string) => string)[] = [
      (v) => `https://seazn.club/watch?t=${v}`,
      (v) => `https://seazn.club/watch?lang=en&t=${v}`,
      (v) => `/api/auth/lichess?org=x&next=%2Fwatch%3Ft%3D${v}`,
      (v) => `/login?next=%2Fapi%2Fauth%2Flichess%3Forg%3Dx%26next%3D%252Fwatch%253Ft%253D${v}`,
      (v) => `t=${v}`,
    ];
    let checked = 0;
    for (const value of notTokens) {
      for (const form of forms) {
        const url = form(value);
        expect(scrubScoreUrl(url), url).toBe(url);
        checked++;
      }
    }
    expect(checked).toBe(notTokens.length * forms.length);

    // The scope is the parameter NAME `t` as well as the value's shape: the same real token under another name stays.
    // Each URL ALSO carries a genuine non-token `t=`, so the scrubber's cheap pre-check passes and the pattern itself
    // has to refuse the other name (a bare `at=<jwt>` would be waved through by the pre-check alone).
    const link = await roomLink();
    const names = ["at", "utm_t", "format", "tt"];
    for (const name of names) {
      for (const url of [
        `https://seazn.club/play?t=90s&${name}=${link.token}`,
        `/api/auth/lichess?next=%2Fplay%3Ft%3D90s%26${name}%3D${link.token}`,
        `/login?next=%2Fapi%2Fauth%2Flichess%3Fnext%3D%252Fplay%253Ft%253D90s%2526${name}%253D${link.token}`,
      ]) {
        expect(scrubScoreUrl(url), url).toBe(url);
        checked++;
      }
    }
    expect(checked).toBe(notTokens.length * forms.length + names.length * 3);
  });
});

// ---- the database-backed round trips -------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a signed-out player links Lichess from the match room and comes back to the room", () => {
  it("by magic link: the form posts the nested next, the emailed link carries it, opening it lands on the start, which stores the room path", async () => {
    const link = await roomLink();
    const loginNext = await startSignedOut(link.startHref);
    expect(loginNext.length).toBeGreaterThan(FORMER_NEXT_CAP);
    const formNext = await loginPageFormNext(loginNext);

    const email = `lichess-next-${randomUUID()}@example.test`;
    const { shown } = await submitSignInForm(formNext, email);
    expect(mail.sent.map((m) => m.to), `the magic link was mailed (the form showed: ${shown.slice(0, 120)})`).toEqual([
      email,
    ]);
    const userId = await userByEmail(email);

    const emailed = new URL(mail.sent[0]!.link);
    expect(emailed.searchParams.get("next"), "the emailed link carries the start").toBe(link.startHref);
    // The page a person opens from that mail is a URL telemetry records: the room token is two encodings deep in it, and
    // the link's own one-time sign-in token (the row the route inserted, read back) is its first parameter.
    const [{ token: signInToken }] = await sql<{ token: string }[]>`select token from login_links where user_id = ${userId}`;
    expect(mail.sent[0]!.link, "premise: the room token is in the emailed link").toContain(link.token);
    expect(mail.sent[0]!.link, "premise: the sign-in token is in the emailed link").toContain(`?token=${signInToken}&`);
    expect(scrubScoreUrl(mail.sent[0]!.link), "the /magic-link page URL: both tokens go").toBe(
      mail.sent[0]!.link.split(link.token).join("[token]").split(signInToken).join("[token]"),
    );

    const opened = await openMagicLink(emailed.href);
    expect(opened.landed, `signed in and sent to the start (the page showed: ${opened.shown.slice(0, 120)})`).toBe(
      link.startHref,
    );

    await expectBackOnTheRoom(await followStartSignedIn(opened.landed!), link);
  });

  it("with a password: a verified account's login answers with the start, which stores the room path", async () => {
    const link = await roomLink();
    const loginNext = await startSignedOut(link.startHref);
    const user = await verifiedUser();

    const r = await post(LOGIN, "/api/auth/login", { email: user.email, password: PASSWORD, next: loginNext });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.redirect).toBe(link.startHref);

    await expectBackOnTheRoom(await followStartSignedIn(r.body.data!.redirect), link);
  });

  it("by signing up: the verification link carries the start, and opening it lands on the start, which stores the room path", async () => {
    const link = await roomLink();
    const loginNext = await startSignedOut(link.startHref);
    const email = `lichess-next-${randomUUID()}@example.test`;

    const r = await post(SIGNUP, "/api/auth/signup", { email, password: PASSWORD, next: loginNext });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const userId = await userByEmail(email);
    expect(mail.sent.map((m) => m.to)).toEqual([email]);
    const emailed = new URL(mail.sent[0]!.link);
    expect(emailed.searchParams.get("next"), "the verification link carries the start").toBe(link.startHref);
    const [{ token: verifyToken }] = await sql<{ token: string }[]>`select token from email_verifications where user_id = ${userId}`;
    expect(mail.sent[0]!.link, "premise: the room token is in the emailed link").toContain(link.token);
    expect(mail.sent[0]!.link, "premise: the verification token is in the emailed link").toContain(`?token=${verifyToken}&`);
    expect(scrubScoreUrl(mail.sent[0]!.link), "the /verify-email page URL: both tokens go").toBe(
      mail.sent[0]!.link.split(link.token).join("[token]").split(verifyToken).join("[token]"),
    );

    const opened = await openVerifyLink(emailed.href, router.push);
    expect(opened.landed).toBe(link.startHref);

    await expectBackOnTheRoom(await followStartSignedIn(opened.landed!), link);
  });

  it("the widest real link: the Set-Cookie the real start writes for the return path fits one cookie", async () => {
    const link = await roomLink(widestSlugs());
    const user = await verifiedUser();

    const r = await post(LOGIN, "/api/auth/login", { email: user.email, password: PASSWORD, next: link.startHref });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.redirect, "login carries the widest link whole").toBe(link.startHref);

    expect(await followStartSignedIn(r.body.data!.redirect)).toBe(link.selfPath);
    // The header the route wrote, not text built here: URL-encoded value, Max-Age, Path, HttpOnly, SameSite.
    const header = writtenSetCookie(LICHESS_OAUTH_NEXT_COOKIE);
    expect(header, "it holds the room path, token and all").toContain(encodeURIComponent(link.selfPath));
    expect(header, "and the attributes the route set").toContain("HttpOnly");
    expect(header.length, `the widest real Set-Cookie is ${header.length} bytes`).toBeLessThan(COOKIE_BYTES);
  });

  it("the empty case: a form handed no next mails a link with none, and opening it lands on the first-run wizard", async () => {
    const email = `lichess-next-${randomUUID()}@example.test`;
    const { shown } = await submitSignInForm(undefined, email);
    expect(mail.sent.map((m) => m.to), shown.slice(0, 120)).toEqual([email]);
    await userByEmail(email);
    const emailed = new URL(mail.sent[0]!.link);
    expect(emailed.searchParams.has("next")).toBe(false);

    expect((await openMagicLink(emailed.href)).landed).toBe(FIRST_RUN_WIZARD);
  });

  it("the bound is still a bound: a next of exactly the maximum is taken, one more is refused with the field named", async () => {
    const user = await verifiedUser();
    const atMax = `/${"a".repeat(NEXT_PATH_MAX_LENGTH - 1)}`;
    expect(atMax.length).toBe(NEXT_PATH_MAX_LENGTH);

    const ok = await post(LOGIN, "/api/auth/login", { email: user.email, password: PASSWORD, next: atMax });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data?.redirect).toBe(atMax);

    // Every route that takes a next, one past the maximum: all four refuse it, naming `next`.
    const over = `${atMax}a`;
    const refusals = [
      await post(LOGIN, "/api/auth/login", { email: user.email, password: PASSWORD, next: over }),
      await post(SIGNUP, "/api/auth/signup", { email: `over-${randomUUID()}@example.test`, password: PASSWORD, next: over }),
      await post(MAGIC_LINK, "/api/auth/magic-link", { email: user.email, next: over }),
      await post(MAGIC_LINK_CONSUME, "/api/auth/magic-link/consume", { token: "t".repeat(20), next: over }),
    ];
    let checked = 0;
    for (const r of refusals) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.issues?.map((i) => i.path.join(".")), JSON.stringify(r.body)).toEqual(["next"]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("an over-long path to another origin is still ignored by the routes: the person gets the default landing, never that origin", async () => {
    const user = await verifiedUser();
    let checked = 0;
    for (const prefix of ["https://evil.example/", "//evil.example/"]) {
      const evil = `${prefix}${"a".repeat(FORMER_NEXT_CAP + 200 - prefix.length)}`;
      expect(evil.length).toBeGreaterThan(FORMER_NEXT_CAP);
      expect(evil.length).toBeLessThanOrEqual(NEXT_PATH_MAX_LENGTH);
      const r = await post(LOGIN, "/api/auth/login", { email: user.email, password: PASSWORD, next: evil });
      expect(r.status, `${prefix}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.data?.redirect, prefix).not.toBe(evil);
      expect(new URL(r.body.data!.redirect, ORIGIN).origin, `${prefix}: stays on this origin`).toBe(ORIGIN);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
