// Quick match plan 2, Task 6 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.4, C1, C4, C18;
// pre-flight A7, A8, B6, C13, D3; ledger carries "CARRY to T6"): the guest's Score tap, `POST /q/<token>/score/<fixtureId>`.
//
// The contract: every answer is a 303 (D3), never JSON. A tap that works lands in the scoring pad, `/score/<device link>`,
// minted or reopened by plan 1's `ensureGuestDeviceLink`; every refusal lands back on the home, `/q/<token>?e=<code>`, which
// prints the refusal as localized flash copy; an unknown token lands on its own `/q/<token>`, the dead screen.
//
// Driven through the REAL route, the real `ensureGuestDeviceLink` and real Postgres rows. Every quick match is made by the real
// producer (`createQuickMatch`); the link a tap lands on is used by the real consumer (the events route, as the pad posts),
// and the home a refusal lands on is the REAL page, rendered with the Location's own path and query. The only stand-ins:
// PostHog (a mock), Sentry's capture (a spy, never sent), the limiter's test counter (`__setRateLimitCounterForTests`), and
// `ensureGuestDeviceLink` behind a spy of itself so one case can make it fail the way only a race or a bug does.
//
// Expected values come from the spec (7 days, C1), the dictionaries (the flash copy, by the key T1's table names for each
// refusal), the shared limiter declaration, and the rows the write path wrote; never from the route's own answer.
//
// One sport, badminton: the route is sport-agnostic (it resolves a token and calls `ensureGuestDeviceLink`), and the link's
// per-sport behaviour is plan 1's device-link test's sweep. `firstRallyFor` throws for chess (`_quick-match-probe.ts:194`).
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as postEvent } from "@/app/api/v1/fixtures/[id]/events/route";
import en from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { systemAuth } from "@/lib/quick-match-auth";
import { DEVICE_LINK_MINT_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { ensureGuestDeviceLink, resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { touchQuickMatchActivity } from "@/server/usecases/quick-match-activity";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { scoreEvent } from "@/server/usecases/scoring";
import { firstRallyFor, playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import { walk } from "@/components/__tests__/_hook-harness";
import { ClearFlashParam } from "@/components/quick-match/clear-flash-param";
import QuickMatchHomePage from "../page";
import { POST } from "../score/[fixtureId]/route";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // every create and every mint seals a secret (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The route's fault report, read by the cases that tell a fault from a refusal. Never sent anywhere.
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
// The real mint behind a spy: the cases count its calls, and two make one call fail as only a race or a bug can.
vi.mock("@/server/usecases/device-links", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/device-links")>();
  return { ...real, ensureGuestDeviceLink: vi.fn(real.ensureGuestDeviceLink) };
});
// The real activity touch behind a spy: one case makes it fail, as a database blip after the mint can.
vi.mock("@/server/usecases/quick-match-activity", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-activity")>();
  return { ...real, touchQuickMatchActivity: vi.fn(real.touchQuickMatchActivity) };
});
// The home a refusal lands on reads the viewer's locale (D10); here, English.
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);
const mintSpy = vi.mocked(ensureGuestDeviceLink);
const touchSpy = vi.mocked(touchQuickMatchActivity);

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 24 * 3600 * 1000;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
let BADMINTON_V: string;

/** The copy a refusal must print on the home, by the key T1's table (task-1-report.md) names for it: the dictionary's own
 *  English, never the route's or the map's answer. The finalized or cancelled 422 is the generic line (ledger CARRY to T6). */
const FLASH = {
  linkLimit: en["quickMatch.flash.linkLimit"],
  notReady: en["quickMatch.flash.notReady"],
  notFound: en["quickMatch.flash.notFound"],
  generic: en["quickMatch.flash.generic"],
  emailLimited: en["quickMatch.flash.emailLimited"],
};

const league = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: `QM score ${randomUUID().slice(0, 8)}`,
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",
  format: "league",
  sides: SIDES,
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});
const created: string[] = [];
async function create(input: CreateQuickMatch = league()): Promise<CreatedQuickMatch> {
  const out = await createQuickMatch(input, { visitorHash: hashVisitorKey(mintVisitorKey()) });
  created.push(out.competitionId);
  return out;
}

interface Fx {
  id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  const rows = await sql<Fx[]>`
    select f.id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id
    from fixtures f join divisions d on d.id = f.division_id
    where d.competition_id = ${competitionId}
    order by f.round_no, f.fixture_no`;
  if (rows.length === 0) throw new Error(`precondition: competition ${competitionId} has no fixture`);
  return rows;
}
const seated = (f: Fx) => f.home_entrant_id !== null && f.away_entrant_id !== null;
async function linksOn(fixtureId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${fixtureId}`;
  return r!.n;
}
async function activityOf(id: string): Promise<{ last: Date; expires: Date | null }> {
  const [q] = await sql<{ last_activity_at: Date; expires_at: Date | null }[]>`
    select last_activity_at, expires_at from quick_matches where id = ${id}`;
  if (!q) throw new Error(`precondition: quick match ${id} has no row`);
  return { last: q.last_activity_at, expires: q.expires_at };
}
/** Move a quick match's clock into the past, so a touch is visible. */
const age = (id: string) => sql`
  update quick_matches set last_activity_at = now() - interval '2 days', expires_at = now() + interval '5 days' where id = ${id}`;

/** The tap, as a browser posts the home's Score form: no body, the token and the fixture in the path (Next awaits params). */
const tap = (token: string, fixtureId: string) =>
  POST(new Request(`http://localhost/q/${token}/score/${fixtureId}`, { method: "POST" }), {
    params: Promise.resolve({ token, fixtureId }),
  });

/** Every Location this file saw: each must be a relative path, so a sweep at the end can check the set (anti-vacuity). */
const seen: { status: number; location: string }[] = [];
async function landed(res: Response): Promise<string> {
  const location = res.headers.get("location") ?? "";
  seen.push({ status: res.status, location });
  expect(res.status, `a 303, never JSON (${await res.clone().text()})`).toBe(303);
  return location;
}
/** A tap that worked: the pad, `/score/<device link>`, the secret alone in the path (O3). */
async function padSecret(res: Response): Promise<string> {
  const location = await landed(res);
  expect(location).toMatch(/^\/score\/dl_[A-Za-z0-9_-]{43}$/);
  return location.slice("/score/".length);
}
/** A refusal: back on THIS home, the code in `?e=`, nothing else in the query. */
async function refusedWith(res: Response, token: string): Promise<string> {
  const location = await landed(res);
  const url = new URL(location, "http://localhost");
  expect(url.pathname, location).toBe(`/q/${token}`);
  expect([...url.searchParams.keys()], location).toEqual(["e"]);
  return url.searchParams.get("e")!;
}

/** The REAL home the Location names, rendered as Next renders it (its params and its query from that Location). */
async function homeAt(location: string): Promise<string> {
  const url = new URL(location, "http://localhost");
  const token = decodeURIComponent(url.pathname.slice("/q/".length));
  const e = url.searchParams.get("e");
  const tree = await QuickMatchHomePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(e === null ? {} : { e }),
  });
  return renderToStaticMarkup(tree as ReactElement);
}
/** The flash the home prints, or null. */
function flashOf(html: string): string | null {
  const m = /<p[^>]*data-testid="qm-flash"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return m ? m[1]!.replace(/&#x27;/g, "'").replace(/&amp;/g, "&") : null;
}

/** The link the tap landed on, through the real consumer: the events route the pad posts to, with its first rally. */
async function scoresARally(secret: string, fixtureId: string): Promise<void> {
  const rally = await firstRallyFor(fixtureId);
  for (const e of rally) {
    const res = await postEvent(
      new Request(`http://test.local/api/v1/fixtures/${fixtureId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(e),
      }),
      { params: Promise.resolve({ id: fixtureId }) },
    );
    expect(res.status, await res.clone().text()).toBe(201);
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
  vi.mocked(Sentry.captureException).mockClear();
  mintSpy.mockClear();
  touchSpy.mockClear();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ── a tap that works ──────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("POST /q/<token>/score/<fixtureId>: a tap that works lands in the pad (§7.4, C4)", () => {
  it("lands on /score/<device link>: the link is this fixture's, issued by the system user, and it scores a rally", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const secret = await padSecret(await tap(out.token, f0!.id));
    expect(await resolveDeviceLinkToken(secret)).toMatchObject({ fixture_id: f0!.id, issued_by: QUICK_MATCH_SYSTEM_USER_ID });
    await scoresARally(secret, f0!.id);   // the real consumer takes it
    expect(await padSecret(await tap(` ${out.token}\n`, f0!.id)), "a padded token is the same token (trimmed)").toBe(secret);
    expect(reported()).toEqual([]);
  });

  it("a second tap reopens the same link (no second row); so does a tap on the match once it is live (Review Focus 1)", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const first = await padSecret(await tap(out.token, f0!.id));
    const second = await padSecret(await tap(out.token, f0!.id));
    expect(second).toBe(first);
    expect(await linksOn(f0!.id)).toBe(1);
    await scoresARally(first, f0!.id);
    expect((await fixturesOf(out.competitionId)).find((f) => f.id === f0!.id)!.status).toBe("in_play");
    expect(await padSecret(await tap(out.token, f0!.id)), "live: the same link").toBe(first);
    expect(await linksOn(f0!.id)).toBe(1);
  });

  it("a decided match posted from a page that still offered it reopens its link (only finalized or cancelled refuse)", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const first = await padSecret(await tap(out.token, f0!.id));
    const auth = await requireFixtureActor(
      new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${first}` } }),
      f0!.id,
      "score",
    );
    expect(await playToDecided(auth, f0!.id)).toMatchObject({ kind: "decided" });
    expect(await padSecret(await tap(out.token, f0!.id))).toBe(first);
    expect(await linksOn(f0!.id)).toBe(1);
  });

  it("a tap is activity: last_activity_at moves to now and the expiry re-arms 7 days out; a refused tap moves nothing (C1)", async () => {
    const out = await create();
    const other = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const [foreign] = await fixturesOf(other.competitionId);
    await age(out.id);
    const before = await activityOf(out.id);
    // The negative pair first: a refusal (a match of another quick match) touches nothing.
    expect(await refusedWith(await tap(out.token, foreign!.id), out.token)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
    expect(await activityOf(out.id)).toEqual(before);
    const t0 = Date.now();
    await padSecret(await tap(out.token, f0!.id));
    const after = await activityOf(out.id);
    expect(after.last.getTime()).toBeGreaterThan(before.last.getTime());
    expect(after.last.getTime()).toBeGreaterThanOrEqual(t0 - 1000);   // now, not merely later
    expect(after.expires!.getTime() - after.last.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
  });

  it("a touch that fails after the mint: the link stands, so the tap still lands in the pad; logged once, never reported", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const blip = new Error("connection reset during the touch");
    touchSpy.mockRejectedValueOnce(blip);
    let secret: string;
    let logged: unknown[][];
    try {
      secret = await padSecret(await tap(out.token, f0!.id));
    } finally {
      logged = [...errors.mock.calls];   // read before the restore, which clears them
      errors.mockRestore();
    }
    expect(touchSpy, "premise: the touch was asked, for this quick match").toHaveBeenCalledWith(out.id);
    expect(await resolveDeviceLinkToken(secret)).toMatchObject({ fixture_id: f0!.id });
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ err: blip, quickMatch: out.id });
    expect(reported(), "a failed touch is no fault the guest sees").toEqual([]);
  });
});

// ── every refusal is a 303 back to the home, with its flash ───────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a refused tap lands back on the home with ?e=, which prints the refusal's own copy (D3, A7, B6)", () => {
  it("the mint limit (429): ?e= names it, the home says so, and no device_links row is written; its own bucket", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const keys: string[] = [];
    // This quick match's bucket is already full; every other limiter stays inert, as with no Redis.
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return key === `rl:qm-mint:${out.id}` ? { count: DEVICE_LINK_MINT_LIMIT.max + 1, ttlMs: 30_000 } : null;
    });
    await age(out.id);
    const before = await activityOf(out.id);
    const res = await tap(out.token, f0!.id);
    const code = await refusedWith(res, out.token);
    expect(code).toBe(QUICK_MATCH_ERRORS.LINK_LIMITED);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.linkLimit);
    expect(await linksOn(f0!.id)).toBe(0);
    expect(await activityOf(out.id), "a refused tap is no activity").toEqual(before);
    expect(keys).toContain(`rl:qm-mint:${out.id}`);   // premise: the limiter was asked, by this match's key
    expect(reported(), "a limit is a refusal, not a fault").toEqual([]);
    // The positive pair: the bucket drains, the same tap mints.
    __setRateLimitCounterForTests(null);
    await padSecret(await tap(out.token, f0!.id));
    expect(await linksOn(f0!.id)).toBe(1);
  });

  it("a waiting final (knockout of 3) and the bye: ?e= SIDES_UNKNOWN, the home's 'not yet' line, no link; the semi-final mints", async () => {
    const out = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const fixtures = await fixturesOf(out.competitionId);
    const final = fixtures.find((f) => f.round_no === 2)!;
    const bye = fixtures.find((f) => f.round_no === 1 && !seated(f))!;
    const semi = fixtures.find((f) => f.round_no === 1 && seated(f))!;
    expect([final, bye, semi].every(Boolean)).toBe(true);   // §7.3: 3 sides = a bye, a semi-final and a final
    let checked = 0;
    for (const waiting of [final, bye]) {
      const res = await tap(out.token, waiting.id);
      expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.SIDES_UNKNOWN);
      expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.notReady);
      expect(await linksOn(waiting.id)).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
    expect(reported()).toEqual([]);
    await padSecret(await tap(out.token, semi.id));
  });

  it("a finalized match: the generic line (the link's code-less 422, ledger CARRY), no new link, no fault report", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const secret = await padSecret(await tap(out.token, f0!.id));
    const auth = await requireFixtureActor(
      new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }),
      f0!.id,
      "score",
    );
    const played = await playToDecided(auth, f0!.id);
    if (played.kind !== "decided") throw new Error(`precondition: the match decides (${played.kind})`);
    // Finalized: only an organizer may, never the link (plan 1 T8's own case does it the same way).
    await scoreEvent(systemAuth(), f0!.id, { expected_seq: played.lastSeq, type: "core.finalize", payload: {} });
    const res = await tap(out.token, f0!.id);
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.generic);
    expect(await linksOn(f0!.id)).toBe(1);
    expect(reported(), "a finalized match is a refusal, not a fault").toEqual([]);
  });

  it("a match of another quick match: ?e= NOT_FOUND, the home's 'not part of this' line, no link on it; through its own home it mints", async () => {
    const a = await create();
    const b = await create();
    const [fb] = await fixturesOf(b.competitionId);
    const res = await tap(a.token, fb!.id);
    expect(await refusedWith(res, a.token)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.notFound);
    expect(await linksOn(fb!.id)).toBe(0);
    expect(reported()).toEqual([]);
    await padSecret(await tap(b.token, fb!.id));   // the pair: its own home
  });

  it("a fixture id that is no uuid: NOT_FOUND before the limiter or the mint is asked (the path's shape first, plan-1 T8 review)", async () => {
    const out = await create();
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return null;
    });
    const malformed = ["not-a-fixture", "00000000-0000-4000-8000-00000000a00", `${randomUUID()}'`, "%00"];
    let checked = 0;
    for (const id of malformed) {
      expect(await refusedWith(await tap(out.token, id), out.token), JSON.stringify(id)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
      checked++;
    }
    expect(checked).toBe(malformed.length);
    expect(keys.filter((k) => k.startsWith("rl:qm-mint:")), "no mint bucket spent on a malformed id").toEqual([]);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
  });

  it("the home's ?e=: blank is no flash; anything it does not know is the generic line, never the raw value; the flash leads the page as an alert", async () => {
    const out = await create();
    const crafted = "<img src=x onerror=alert(1)>";
    const cases: [Record<string, string | string[]>, string | null][] = [
      [{}, null],
      [{ e: "" }, null],
      [{ e: "   " }, null],
      [{ e: crafted }, FLASH.generic],
      [{ e: "__proto__" }, FLASH.generic],
      [{ e: "quickMatch.flash.notFound" }, FLASH.generic],
      [{ e: QUICK_MATCH_ERRORS.TOO_MANY_ALIVE }, FLASH.generic],   // a setup page code: not the home's
      [{ e: QUICK_MATCH_ERRORS.EXPIRED }, FLASH.generic],   // no flash of its own: an expiry lands on the dead screen (m1)
      [{ e: ` ${QUICK_MATCH_ERRORS.SIDES_UNKNOWN} ` }, FLASH.notReady],
      [{ e: [QUICK_MATCH_ERRORS.NOT_FOUND, QUICK_MATCH_ERRORS.LINK_LIMITED] }, FLASH.notFound],   // a repeated ?e= reads its first
      [{ e: QUICK_MATCH_ERRORS.EMAIL_LIMITED }, FLASH.emailLimited],   // the create's own landing (B-m3)
    ];
    let checked = 0;
    for (const [search, flash] of cases) {
      const tree = await QuickMatchHomePage({ params: Promise.resolve({ token: out.token }), searchParams: Promise.resolve(search) });
      const html = renderToStaticMarkup(tree as ReactElement);
      expect(flashOf(html), JSON.stringify(search)).toBe(flash);
      expect(html, "the raw value never reaches the page").not.toContain("onerror=alert");
      checked++;
    }
    expect(checked).toBe(cases.length);
    const html = await homeAt(`/q/${out.token}?e=${QUICK_MATCH_ERRORS.NOT_FOUND}`);
    expect(html).toMatch(/<p[^>]*role="alert"[^>]*data-testid="qm-flash"/);
    // Inside the page's one main, ahead of the hero: the first thing read and seen after the redirect.
    const main = html.indexOf("<main");
    expect(main).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="qm-flash"')).toBeGreaterThan(main);
    expect(html.indexOf('data-testid="qm-flash"')).toBeLessThan(html.indexOf('data-testid="qm-hero"'));
    // Printed once: the page mounts the island that takes the spent ?e= out of the URL (T6 review m2).
    const tree = await QuickMatchHomePage({
      params: Promise.resolve({ token: out.token }),
      searchParams: Promise.resolve({ e: QUICK_MATCH_ERRORS.NOT_FOUND }),
    });
    expect(walk(tree as ReactElement).filter((el) => el.type === ClearFlashParam)).toHaveLength(1);
    // The one code that is no refusal (B-m3): the match was made, so its line is a status, not an alert, in the same place.
    const info = await homeAt(`/q/${out.token}?e=${QUICK_MATCH_ERRORS.EMAIL_LIMITED}`);
    expect(info).toMatch(/<p role="status" data-testid="qm-flash" data-tone="info"/);
    expect(info).not.toMatch(/role="alert"[^>]*data-testid="qm-flash"/);
    expect(html, "the positive pair: a refusal is still an alert").toMatch(/<p role="alert" data-testid="qm-flash" data-tone="refusal"/);
  });

  it("an expiry that lands between the home's read and the mint: the bare home, no ?e= (the dead link), never reported", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    mintSpy.mockRejectedValueOnce(new HttpError(404, "quick match not found or expired", QUICK_MATCH_ERRORS.EXPIRED));
    const res = await tap(out.token, f0!.id);
    expect(await landed(res)).toBe(`/q/${out.token}`);
    expect(reported()).toEqual([]);
    expect(await linksOn(f0!.id)).toBe(0);
    // What the guest then sees: the row the mint saw expired is expired for the home too, so it is the dead screen (D16).
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day'
              where id = ${out.id}`;
    const html = await homeAt(res.headers.get("location")!);
    expect(html).toContain('data-testid="qm-dead-link"');
    expect(flashOf(html)).toBeNull();
  });
});

// ── a fault is reported, and still a 303 ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a fault is reported to Sentry and still lands on the home's generic line", () => {
  it("a server without DEVICE_LINK_KEK (the mint's 503): reported once, the generic line, nothing written", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    vi.stubEnv("DEVICE_LINK_KEK", "");
    let res: Response;
    try {
      res = await tap(out.token, f0!.id);
    } finally {
      vi.stubEnv("DEVICE_LINK_KEK", KEK);
    }
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(reported()).toHaveLength(1);
    expect(reported()[0]).toMatchObject({ status: 503, code: "DEVICE_LINK_KEK_MISSING" });
    expect(await linksOn(f0!.id)).toBe(0);
  });

  it("an unexpected error: reported once, the generic line", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const boom = new Error("connection reset");
    mintSpy.mockRejectedValueOnce(boom);
    const res = await tap(out.token, f0!.id);
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.generic);
    expect(reported()).toEqual([boom]);
  });
});

// ── the dead link ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("an unknown, changed or expired token lands on its own /q/<token>: the dead screen, with no flash", () => {
  it("never mints, never names a reason, and never leaves /q/", async () => {
    const out = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const changed = out.token.slice(0, -1) + (out.token.endsWith("A") ? "B" : "A");
    const cases: [string, string][] = [
      [changed, `/q/${changed}`],
      [`qm_${"x".repeat(43)}`, `/q/qm_${"x".repeat(43)}`],
      ["not-a-token", "/q/not-a-token"],
      // A token-shaped hole: whatever the path held stays one segment under /q/, never a way out of it.
      ["../../admin", "/q/..%2F..%2Fadmin"],
      ["qm_ä", "/q/qm_%C3%A4"],
    ];
    let checked = 0;
    for (const [token, location] of cases) {
      const res = await tap(token, f0!.id);
      expect(await landed(res), token).toBe(location);
      const html = await homeAt(location);
      expect(html, token).toContain('data-testid="qm-dead-link"');
      expect(flashOf(html), token).toBeNull();
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(await linksOn(f0!.id)).toBe(0);
    // Expired: the same dead screen, whatever the query says (a crafted ?e= on a dead link names no reason, D16).
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day'
              where id = ${out.id}`;
    const res = await tap(out.token, f0!.id);
    expect(await landed(res)).toBe(`/q/${out.token}`);
    const dead = await homeAt(`/q/${out.token}?e=${QUICK_MATCH_ERRORS.EXPIRED}`);
    expect(dead).toContain('data-testid="qm-dead-link"');
    expect(flashOf(dead)).toBeNull();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
  });
});

// ── where the home offers Score ───────────────────────────────────────────────────────────────────────────────────────

/** Every Score form on the page: its action, the fixture its row names (the hero's has none), and its button's words. */
function scoreForms(html: string): { action: string; place: string; row: string | null; label: string }[] {
  const out: { action: string; place: string; row: string | null; label: string }[] = [];
  // A list row carries its fixture id; the form inside it is that row's.
  const rowAt = (i: number) => {
    const before = html.slice(0, i);
    const li = before.lastIndexOf('<li data-testid="qm-match"');
    if (li === -1 || before.indexOf("</li>", li) !== -1) return null;
    return /data-fixture-id="([^"]+)"/.exec(before.slice(li))?.[1] ?? null;
  };
  for (const m of html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)) {
    const attrs = m[1]!;
    out.push({
      action: /\baction="([^"]+)"/.exec(attrs)?.[1] ?? "",
      place: /\bdata-place="([^"]+)"/.exec(attrs)?.[1] ?? "",
      row: rowAt(m.index!),
      label: m[2]!.replace(/<[^>]+>/g, "").trim(),
    });
  }
  return out;
}

describe.skipIf(!HAS_DB)("the home offers Score on a playable match only, each form posting to that match (C11, C18)", () => {
  it("a fresh league of 4: 'Score this match' on match 1's hero, 'Score' on each of the 6 rows, every form a credential painter", async () => {
    const out = await create();
    const fixtures = await fixturesOf(out.competitionId);
    const html = await homeAt(`/q/${out.token}`);
    const forms = scoreForms(html);
    const hero = forms.filter((f) => f.place === "hero");
    const rows = forms.filter((f) => f.place === "row");
    expect(hero.map((f) => [f.action, f.label])).toEqual([[`/q/${out.token}/score/${fixtures[0]!.id}`, en["quickMatch.home.score"]]]);
    expect(rows).toHaveLength(6);
    let checked = 0;
    for (const f of rows) {
      expect(f.row, "a row form sits in its row").not.toBeNull();
      expect(f.action, "a row posts its own match").toBe(`/q/${out.token}/score/${f.row}`);
      expect(f.label).toBe(en["quickMatch.home.scoreShort"]);
      checked++;
    }
    expect(checked).toBe(fixtures.length);
    // A real form post (works with no script), and blocked from session replay: its action carries the home token (O3).
    const tags = [...html.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(7);
    for (const tag of tags) {
      expect(tag).toContain('method="post"');
      expect(tag).toMatch(/class="[^"]*\bph-no-capture\b/);
    }
  });

  it("a decided match has no Score anywhere and the hero moves on; a live one reads 'Continue scoring' and keeps its row's", async () => {
    const out = await create();
    const [f0, f1] = await fixturesOf(out.competitionId);
    // Match 1 decided (played from its first event, `playToDecided`'s own premise).
    const first = await padSecret(await tap(out.token, f0!.id));
    const auth = await requireFixtureActor(
      new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${first}` } }),
      f0!.id,
      "score",
    );
    expect(await playToDecided(auth, f0!.id)).toMatchObject({ kind: "decided" });
    let forms = scoreForms(await homeAt(`/q/${out.token}`));
    expect(forms.filter((f) => f.action.endsWith(`/${f0!.id}`)), "settled: no Score").toEqual([]);
    expect(forms.filter((f) => f.place === "hero").map((f) => [f.action, f.label])).toEqual([
      [`/q/${out.token}/score/${f1!.id}`, en["quickMatch.home.score"]],
    ]);
    expect(forms.filter((f) => f.place === "row")).toHaveLength(5);
    // Match 2 live: the hero's words change, the row keeps its Score.
    await scoresARally(await padSecret(await tap(out.token, f1!.id)), f1!.id);
    forms = scoreForms(await homeAt(`/q/${out.token}`));
    expect(forms.filter((f) => f.place === "hero").map((f) => [f.action, f.label])).toEqual([
      [`/q/${out.token}/score/${f1!.id}`, en["quickMatch.home.continue"]],
    ]);
    expect(forms.filter((f) => f.row === f1!.id).map((f) => f.label), "the live row keeps its Score").toEqual([en["quickMatch.home.scoreShort"]]);
    expect(forms.filter((f) => f.place === "row")).toHaveLength(5);
  });

  it("a knockout of 3: the semi-final in the hero and its row; the waiting final and the bye offer none", async () => {
    const out = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const fixtures = await fixturesOf(out.competitionId);
    const semi = fixtures.find((f) => f.round_no === 1 && seated(f))!;
    const forms = scoreForms(await homeAt(`/q/${out.token}`));
    expect(forms.map((f) => [f.place, f.action]).sort()).toEqual(
      [
        ["hero", `/q/${out.token}/score/${semi.id}`],
        ["row", `/q/${out.token}/score/${semi.id}`],
      ].sort(),
    );
    const waiting = fixtures.filter((f) => !seated(f));
    expect(waiting).toHaveLength(2);   // the final and the bye
    for (const f of waiting) expect(forms.some((x) => x.action.endsWith(`/${f.id}`)), f.id).toBe(false);
  });
});

// ── the form on the home posts to this route ─────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("the seam: the home's Score form names this route, and its post lands in the pad", () => {
  it("the hero's form action is a path whose route file is this one; posting it as Next routes it mints the hero's match", async () => {
    const out = await create();
    const html = await homeAt(`/q/${out.token}`);
    const actions = [...html.matchAll(/<form[^>]*\baction="([^"]+)"/g)].map((m) => m[1]!);
    expect(actions.length, "a fresh league offers Score on the hero and on every match").toBe(1 + 6);
    const hero = /data-testid="qm-hero"[\s\S]*?<form[^>]*\baction="([^"]+)"/.exec(html)?.[1];
    expect(hero).toBeDefined();
    const m = /^\/q\/([^/]+)\/score\/([^/]+)$/.exec(hero!);
    expect(m, hero).not.toBeNull();
    const [, token, fixtureId] = m!;
    expect(token).toBe(out.token);
    // The path's route file is the handler under test (Next maps app/q/[token]/score/[fixtureId]/route.ts to it).
    const routeFile = path.resolve(import.meta.dirname, "../score/[fixtureId]/route.ts");
    expect(fs.existsSync(routeFile)).toBe(true);
    const [first] = await fixturesOf(out.competitionId);
    expect(fixtureId, "the hero's match is match 1 (C11)").toBe(first!.id);
    const secret = await padSecret(await tap(token!, fixtureId!));
    expect((await resolveDeviceLinkToken(secret)).fixture_id).toBe(fixtureId);
  });
});

// ── the sweep over every answer this file saw ────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("every answer", () => {
  it("was a 303 to a relative path on this site: the pad, the home, or the home with one ?e= the home maps", async () => {
    expect(seen.length, "the cases above ran (anti-vacuity)").toBeGreaterThanOrEqual(25);
    const codes = new Set<string>();
    for (const { status, location } of seen) {
      expect(status, location).toBe(303);
      expect(location, "relative, never another origin").toMatch(/^\/(?!\/)/);
      const url = new URL(location, "http://localhost");
      expect(url.pathname, location).toMatch(/^\/(score|q)\//);
      const e = url.searchParams.get("e");
      if (e !== null) codes.add(e);
    }
    // Every refusal the route sends is one T1's table gave copy (these four; an expiry sends none), each seen at least once.
    expect([...codes].sort()).toEqual(
      [
        QUICK_MATCH_ERRORS.LINK_LIMITED,
        QUICK_MATCH_ERRORS.SIDES_UNKNOWN,
        QUICK_MATCH_ERRORS.ACTION_FAILED,
        QUICK_MATCH_ERRORS.NOT_FOUND,
      ].sort(),
    );
  });
});
