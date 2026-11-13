// Quick match plan 2, Task 8 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, C5, C13, C15, §7.1
// point 3; pre-flight D3, D4, B8; ledger CARRY to T8): "Add a match", `POST /q/<token>/add-match`, the decider a league
// takes from its home.
//
// The contract: every answer is a 303 (D3), never JSON. An add that works lands back on the home with nothing added to the
// query (the new match is then on it); every refusal lands on the home with `?e=<code>`, printed as the viewer's own flash;
// an unknown token lands on its own `/q/<token>`, the dead screen. The route's checks run in this order (pre-flight B8, the
// brief): the token, a knockout refused, both sides members of THIS quick match (before `addFixture`, so a non-uuid is a
// flash and not a 400), the same side twice, then the cap of QUICK_MATCH_MAX_ADHOC extra matches. `addFixture` refuses a
// bracket, the same entrant twice and an outsider ITSELF, with code-less 422s that read as faults here, so every case below
// reaches the route's OWN check and tells it apart from `addFixture`'s (each guard is mutated alone, AGENTS.md class 3).
//
// Driven through the REAL route, the real `addFixture` and real Postgres rows. Every quick match is made by the real
// producer (`createQuickMatch`), every result by the real write path (`playToDecided`), and the home an answer lands on is
// the REAL page, rendered from the Location's own path and query. The only stand-ins: PostHog (a mock), Sentry's capture (a
// spy, never sent), the limiter's test counter, and `addFixture` / `readQuickMatchHome` behind spies of themselves so one
// case each can make them fail the way only a race or a bug does.
//
// Expected values come from the spec (C5: the decider lands at `max(round) + 1` as `adhoc-<n>`; C1: an action is activity),
// pre-flight D4 (the cap is 10), the rulebook (a match counts one played for each side), the dictionaries (each flash by its
// key) and the rows the write path wrote; never from the route's own answer.
//
// One sport for the flow, badminton: the route is sport-agnostic (it reads the home and calls `addFixture`, which knows no
// sport), and `playToDecided` needs a sport the probe can play (`firstRallyFor` throws for chess, `_quick-match-probe.ts`).
// One football case shows another sport's league takes a decider too.
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { interpolate, plural } from "@/lib/i18n-runtime";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_MAX_ADHOC } from "@/lib/quick-match-constants";
import { systemAuth } from "@/lib/quick-match-auth";
import { MUTATION_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { addFixture } from "@/server/usecases/stages";
import { type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { createQuickMatchAnyFormat } from "@/server/usecases/__tests__/_quick-match-knockout";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { readQuickMatchHome } from "@/server/usecases/quick-match-home";
import { offerFor } from "@/server/usecases/quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { scoreEvent } from "@/server/usecases/scoring";
import { playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import QuickMatchHomePage from "../page";
import { POST } from "../add-match/route";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // every create seals the home token (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The route's fault report, read by the cases that tell a fault from a refusal. Never sent anywhere.
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
// The real `addFixture` behind a spy: the cases count its calls (a refusal never reaches it), and one makes it fail.
vi.mock("@/server/usecases/stages", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/stages")>();
  return { ...real, addFixture: vi.fn(real.addFixture) };
});
// The real home read behind a spy: one case makes it answer null, as a competition deleted after the token's read does.
vi.mock("@/server/usecases/quick-match-home", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-home")>();
  return { ...real, readQuickMatchHome: vi.fn(real.readQuickMatchHome) };
});
// The home an answer lands on reads the viewer's locale (D10); here, English.
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);
const addSpy = vi.mocked(addFixture);
const readSpy = vi.mocked(readQuickMatchHome);

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 24 * 3600 * 1000;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;
/** Pre-flight D4: at most 10 extra matches per quick match. The ruling's number, typed. */
const SPEC_MAX_ADHOC = 10;
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
let BADMINTON_V: string;

/** The copy each answer must print on the home, by the key the code names: the dictionary's own English. */
const FLASH = {
  sameSide: en["quickMatch.flash.sameSide"],
  leagueOnly: en["quickMatch.flash.leagueOnly"],
  notFound: en["quickMatch.flash.notFound"],
  generic: en["quickMatch.flash.generic"],
  adhocLimit: interpolate(en["quickMatch.flash.adhocLimit"], { max: SPEC_MAX_ADHOC }),
};

const league = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: `QM add ${randomUUID().slice(0, 8)}`,
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",
  format: "league",
  sides: SIDES.slice(0, 2),
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});
const created: string[] = [];
async function create(input: CreateQuickMatch = league()): Promise<CreatedQuickMatch> {
  const out = await createQuickMatchAnyFormat(input, { visitorHash: hashVisitorKey(mintVisitorKey()) });
  created.push(out.competitionId);
  return out;
}

interface Fx {
  id: string;
  round_no: number;
  status: string;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  return sql<Fx[]>`
    select f.id, f.round_no, f.status, f.ext_key, f.home_entrant_id, f.away_entrant_id
    from fixtures f join divisions d on d.id = f.division_id
    where d.competition_id = ${competitionId}
    order by f.round_no, f.fixture_no, f.created_at`;
}
/** The quick match's sides, in the order the guest typed them (seed order, C20). */
async function sidesOf(competitionId: string): Promise<{ id: string; name: string }[]> {
  const rows = await sql<{ id: string; display_name: string }[]>`
    select e.id, e.display_name from entrants e join divisions d on d.id = e.division_id
    where d.competition_id = ${competitionId} order by e.seed nulls last, e.created_at, e.id`;
  if (rows.length < 2) throw new Error(`precondition: competition ${competitionId} has ${rows.length} sides`);
  return rows.map((r) => ({ id: r.id, name: r.display_name }));
}
/** The extra matches: spec C5 names them `adhoc-<n>`. */
const adhocOf = async (competitionId: string) => (await fixturesOf(competitionId)).filter((f) => /^adhoc-\d+$/.test(f.ext_key ?? ""));
async function activityOf(id: string): Promise<{ last: Date; expires: Date | null }> {
  const [q] = await sql<{ last_activity_at: Date; expires_at: Date | null }[]>`
    select last_activity_at, expires_at from quick_matches where id = ${id}`;
  if (!q) throw new Error(`precondition: quick match ${id} has no row`);
  return { last: q.last_activity_at, expires: q.expires_at };
}
const age = (id: string) => sql`
  update quick_matches set last_activity_at = now() - interval '2 days', expires_at = now() + interval '5 days' where id = ${id}`;

/** The post, as a browser sends the home's form: urlencoded fields, the token in the path (Next awaits params). */
function add(token: string, body: Record<string, string> | string = {}, contentType = "application/x-www-form-urlencoded") {
  return POST(
    new Request(`http://localhost/q/${token}/add-match`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : new URLSearchParams(body).toString(),
    }),
    { params: Promise.resolve({ token }) },
  );
}
const pick = (home: string, away: string) => ({ home, away });

/** Every Location this file saw: each must be a relative path, so a sweep at the end can check the set (anti-vacuity). */
const seen: { status: number; location: string }[] = [];
async function landed(res: Response): Promise<string> {
  const location = res.headers.get("location") ?? "";
  seen.push({ status: res.status, location });
  expect(res.status, `a 303, never JSON (${await res.clone().text()})`).toBe(303);
  return location;
}
/** An add that worked: the bare home, nothing in the query. */
async function addedOn(res: Response, token: string): Promise<void> {
  expect(await landed(res)).toBe(`/q/${token}`);
}
/** A refusal: back on THIS home, the code in `?e=` first; beside it only the guest's picks handed back (review m4). */
async function refusedWith(res: Response, token: string): Promise<string> {
  const location = await landed(res);
  const url = new URL(location, "http://localhost");
  expect(url.pathname, location).toBe(`/q/${token}`);
  const keys = [...url.searchParams.keys()];
  expect(keys[0], location).toBe("e");
  expect(keys.filter((k) => k !== "e" && k !== "home" && k !== "away"), location).toEqual([]);
  expect(new Set(keys).size, `${location}: no parameter twice`).toBe(keys.length);
  return url.searchParams.get("e")!;
}
/** The picks a refusal handed back, as the Location carries them (null for one left out). */
const pickedBack = (location: string) => {
  const url = new URL(location, "http://localhost");
  return { home: url.searchParams.get("home"), away: url.searchParams.get("away") };
};

/** The REAL home the Location names, rendered as Next renders it (its params and its query from that Location). */
async function homeAt(location: string): Promise<string> {
  const url = new URL(location, "http://localhost");
  const token = decodeURIComponent(url.pathname.slice("/q/".length));
  const tree = await QuickMatchHomePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(Object.fromEntries(url.searchParams)),
  });
  return renderToStaticMarkup(tree as ReactElement);
}
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
function flashOf(html: string): string | null {
  const m = /<p[^>]*data-testid="qm-flash"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return m ? unescape(m[1]!) : null;
}
const textOfTestId = (html: string, id: string): string | null => {
  const m = new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(p|span|div|section|h1)>`).exec(html);
  return m ? unescape(m[1]!.replace(/<[^>]+>/g, "")).trim() : null;
};

/** The Add-a-match form the home draws: whether its disclosure is open on first paint, its action, and each select's name
 *  with its options and the one it opens at. */
function addForm(
  html: string,
): { open: boolean; action: string; selects: Record<string, { options: string[]; selected: string | null }> } | null {
  const m = /<form[^>]*data-testid="qm-add-match-form"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!m) return null;
  const details = /<details[^>]*data-testid="qm-add-match"[^>]*>/.exec(html)?.[0] ?? "";
  expect(details, "the form sits in its disclosure").not.toBe("");
  const action = /\baction="([^"]+)"/.exec(m[0])?.[1] ?? "";
  const selects: Record<string, { options: string[]; selected: string | null }> = {};
  for (const s of m[1]!.matchAll(/<select[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...s[2]!.matchAll(/<option[^>]*\bvalue="([^"]+)"/g)].map((o) => o[1]!);
    const selected = /<option[^>]*\bvalue="([^"]+)"[^>]*\bselected=""/.exec(s[2]!)?.[1] ?? null;
    selects[s[1]!] = { options, selected };
  }
  return { open: /\sopen=""/.test(details), action, selects };
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
  addSpy.mockClear();
  readSpy.mockClear();
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

// ── an add that works ─────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("POST /q/<token>/add-match: an add that works lands back on the home, with the decider on it (C5)", () => {
  it("a finished league of 2: the decider lands at max(round)+1 as adhoc-<n>, the winner card gives way to 'Up next', and the table counts it once played (Review Focus 5)", async () => {
    const out = await create();
    const [only] = await fixturesOf(out.competitionId);
    const [a, b] = await sidesOf(out.competitionId);
    expect(await playToDecided(systemAuth(), only!.id)).toMatchObject({ kind: "decided" });
    let html = await homeAt(`/q/${out.token}`);
    expect(html, "premise: every match played, the winner card is up").toContain('data-testid="qm-winner"');
    expect(html).not.toContain('data-testid="qm-hero"');

    await addedOn(await add(out.token, pick(b!.id, a!.id)), out.token);
    const fixtures = await fixturesOf(out.competitionId);
    expect(fixtures).toHaveLength(2);
    const decider = fixtures.find((f) => f.id !== only!.id)!;
    // C5: one more round, named adhoc-<n>, seated as the guest picked (home first), not yet played.
    expect(decider.round_no).toBe(only!.round_no + 1);
    expect(decider.ext_key).toMatch(/^adhoc-\d+$/);
    expect([decider.home_entrant_id, decider.away_entrant_id]).toEqual([b!.id, a!.id]);
    expect(decider.status).toBe("scheduled");
    expect(reported()).toEqual([]);

    // The home: no winner card any more; the decider is up next, as match 2 of 2; one of two played.
    html = await homeAt(`/q/${out.token}`);
    expect(html).not.toContain('data-testid="qm-winner"');
    expect(textOfTestId(html, "qm-hero-kicker")).toBe(interpolate(en["quickMatch.home.upNext"], { n: 2, total: 2 }));
    expect(textOfTestId(html, "qm-hero-home")).toBe(b!.name);
    expect(textOfTestId(html, "qm-hero-away")).toBe(a!.name);
    expect(textOfTestId(html, "qm-played")).toBe(
      plural(en, "quickMatch.home.played", 2, "en", { played: 1, days: SPEC_EXPIRY_DAYS }),
    );

    // Played: the stored table counts it (a match is one played for each side, rulebook), and the winner card is back.
    expect(await playToDecided(systemAuth(), decider.id)).toMatchObject({ kind: "decided" });
    const [stored] = await sql<{ rows: { entrantId: string; played: number; won: number }[] }[]>`
      select s.rows from standings_snapshots s join stages st on st.id = s.stage_id
      join divisions d on d.id = st.division_id
      where d.competition_id = ${out.competitionId} and s.pool_id is null`;
    expect(stored, "one stored table").toBeDefined();
    let checked = 0;
    for (const side of [a!, b!]) {
      const row = stored!.rows.find((r) => r.entrantId === side.id);
      expect(row?.played, `${side.name} played the first match and the decider`).toBe(2);
      checked++;
    }
    expect(checked).toBe(2);
    expect(stored!.rows.reduce((n, r) => n + r.won, 0), "two decided matches, two wins").toBe(2);
    html = await homeAt(`/q/${out.token}`);
    expect(html).toContain('data-testid="qm-winner"');
    // Finished again: the played line carries no countdown (plan 4, T4 review m1), the open league's line above did.
    expect(textOfTestId(html, "qm-played")).toBe("2 of 2 matches played");
  });

  it("a fresh league (nothing played yet) takes a decider, and a second add after the first: each its own new round", async () => {
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const before = await fixturesOf(out.competitionId);
    expect(before, "premise: a round robin of 3 plays 3").toHaveLength(3);
    const lastRound = Math.max(...before.map((f) => f.round_no));
    const [a, b, c] = await sidesOf(out.competitionId);
    await addedOn(await add(out.token, pick(a!.id, b!.id)), out.token);
    await addedOn(await add(out.token, pick(c!.id, a!.id)), out.token);
    const extra = await adhocOf(out.competitionId);
    expect(extra.map((f) => [f.round_no, f.home_entrant_id, f.away_entrant_id])).toEqual([
      [lastRound + 1, a!.id, b!.id],
      [lastRound + 2, c!.id, a!.id],
    ]);
    expect(new Set(extra.map((f) => f.ext_key)).size, "two distinct adhoc names").toBe(2);
    // The home lists five matches now, the generated three first.
    const html = await homeAt(`/q/${out.token}`);
    expect([...html.matchAll(/data-testid="qm-match"/g)]).toHaveLength(5);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it("an add is activity: last_activity_at moves to now and the expiry re-arms 7 days out; a refused add moves nothing (C1)", async () => {
    const out = await create();
    const [a] = await sidesOf(out.competitionId);
    await age(out.id);
    const before = await activityOf(out.id);
    // The negative pair first: a refusal (the same side twice) touches nothing.
    expect(await refusedWith(await add(out.token, pick(a!.id, a!.id)), out.token)).toBe(QUICK_MATCH_ERRORS.SAME_SIDE);
    expect(await activityOf(out.id)).toEqual(before);
    const [, b] = await sidesOf(out.competitionId);
    const t0 = Date.now();
    await addedOn(await add(out.token, pick(a!.id, b!.id)), out.token);
    const after = await activityOf(out.id);
    expect(after.last.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(after.expires!.getTime() - after.last.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
  });

  it("another sport: a football league of 2 takes a decider the same way (the route knows no sport)", async () => {
    const variant = offerJson.offered.find((o) => o.sport_key === "football")?.variant_key;
    expect(variant, "premise: the catalog offers football").toBeDefined();
    const offer = await offerFor("football", variant!);
    const out = await create(league({ sport_key: "football", variant_key: variant!, kind: offer.kinds[0]!, sides: ["Reds", "Blues"] }));
    const [a, b] = await sidesOf(out.competitionId);
    await addedOn(await add(out.token, pick(a!.id, b!.id)), out.token);
    expect((await adhocOf(out.competitionId)).map((f) => [f.home_entrant_id, f.away_entrant_id])).toEqual([[a!.id, b!.id]]);
  });
});

// ── every refusal is a 303 back to the home, with its flash, and writes nothing ──────────────────────────────────────

describe.skipIf(!HAS_DB)("a refused add lands back on the home with ?e=, which prints its own copy; nothing is written (D3)", () => {
  it("the same side twice: SAME_SIDE, 'Pick two different sides.', addFixture never asked", async () => {
    const out = await create();
    const [a] = await sidesOf(out.competitionId);
    const res = await add(out.token, pick(a!.id, a!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.SAME_SIDE);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.sameSide);
    expect(await adhocOf(out.competitionId)).toEqual([]);
    expect(addSpy, "the route's own check, before addFixture's").not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
  });

  it("a knockout: LEAGUE_ONLY before anything else is read of the post (C5), even a valid pair; the league's pair adds", async () => {
    const cup = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const [a, b] = await sidesOf(cup.competitionId);
    const before = await fixturesOf(cup.competitionId);
    // A valid pair, the same side twice, and a stranger: the format is read first, so each is the knockout's refusal.
    let checked = 0;
    for (const body of [pick(a!.id, b!.id), pick(a!.id, a!.id), pick(randomUUID(), "nope")]) {
      const res = await add(cup.token, body);
      expect(await refusedWith(res, cup.token), JSON.stringify(body)).toBe(QUICK_MATCH_ERRORS.LEAGUE_ONLY);
      checked++;
    }
    expect(checked).toBe(3);
    expect(flashOf(await homeAt(`/q/${cup.token}?e=${QUICK_MATCH_ERRORS.LEAGUE_ONLY}`))).toBe(FLASH.leagueOnly);
    expect(await fixturesOf(cup.competitionId)).toEqual(before);
    expect(addSpy).not.toHaveBeenCalled();
    expect(reported(), "a refusal, not a fault").toEqual([]);
  });

  it("a side of another quick match, or a value that is no side at all: NOT_FOUND, never a 400 or a cast error; through its own home the pair adds", async () => {
    const out = await create();
    const other = await create();
    const [a, b] = await sidesOf(out.competitionId);
    const [x] = await sidesOf(other.competitionId);
    const bodies: (Record<string, string> | string)[] = [
      pick(a!.id, x!.id),
      pick(x!.id, a!.id),
      pick(x!.id, x!.id),   // two strangers that are the same: membership is read before "the same side"
      pick(a!.id, "not-a-side"),
      pick(`${a!.id}'`, b!.id),
      pick(a!.id.toUpperCase(), b!.id),   // the same uuid spelled another way is not one of the sides as the home reads them
      { home: a!.id },
      {},
      "home=&away=",
    ];
    let checked = 0;
    for (const body of bodies) {
      const res = await add(out.token, body);
      expect(await refusedWith(res, out.token), JSON.stringify(body)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
      checked++;
    }
    // A body that is no form at all (JSON): the same refusal, not the handler's 400.
    expect(await refusedWith(await add(out.token, JSON.stringify(pick(a!.id, b!.id)), "application/json"), out.token)).toBe(
      QUICK_MATCH_ERRORS.NOT_FOUND,
    );
    checked++;
    expect(checked).toBe(bodies.length + 1);
    expect(flashOf(await homeAt(`/q/${out.token}?e=${QUICK_MATCH_ERRORS.NOT_FOUND}`))).toBe(FLASH.notFound);
    expect(await adhocOf(out.competitionId)).toEqual([]);
    expect(await adhocOf(other.competitionId)).toEqual([]);
    expect(addSpy).not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
    // The positive pair: the stranger's own home adds its own pair.
    const [, y] = await sidesOf(other.competitionId);
    await addedOn(await add(other.token, pick(x!.id, y!.id)), other.token);
  });

  it(`the cap: ${SPEC_MAX_ADHOC} extra matches add, the next is ADHOC_LIMIT with the cap in its words; membership and same side still answer first`, async () => {
    expect(QUICK_MATCH_MAX_ADHOC, "the constant is D4's number").toBe(SPEC_MAX_ADHOC);
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    let added = 0;
    for (let k = 0; k < SPEC_MAX_ADHOC; k++) {
      await addedOn(await add(out.token, k % 2 === 0 ? pick(a!.id, b!.id) : pick(b!.id, a!.id)), out.token);
      added++;
    }
    expect(added).toBe(SPEC_MAX_ADHOC);
    expect(await adhocOf(out.competitionId)).toHaveLength(SPEC_MAX_ADHOC);
    addSpy.mockClear();
    const res = await add(out.token, pick(a!.id, b!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ADHOC_LIMIT);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.adhocLimit);
    expect(FLASH.adhocLimit, "the flash names the cap").toContain(String(SPEC_MAX_ADHOC));
    expect(await adhocOf(out.competitionId)).toHaveLength(SPEC_MAX_ADHOC);
    // The order: at the cap, the checks before it still answer first.
    expect(await refusedWith(await add(out.token, pick(a!.id, a!.id)), out.token)).toBe(QUICK_MATCH_ERRORS.SAME_SIDE);
    expect(await refusedWith(await add(out.token, pick(a!.id, randomUUID())), out.token)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
    expect(addSpy).not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
  });

  it("the post limit (MUTATION_LIMIT, this quick match's own bucket): the generic line, nothing written; the bucket drains and it adds", async () => {
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return key === `rl:qm-add:${out.id}` ? { count: MUTATION_LIMIT.max + 1, ttlMs: 30_000 } : null;
    });
    const res = await add(out.token, pick(a!.id, b!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    // The limiter answers FIRST: the home is never read for a post over the limit (review m1). Before `homeAt`, which reads it.
    expect(readSpy, "the post limit answers before the home is read").not.toHaveBeenCalled();
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.generic);
    expect(keys).toContain(`rl:qm-add:${out.id}`);
    expect(await adhocOf(out.competitionId)).toEqual([]);
    expect(addSpy).not.toHaveBeenCalled();
    expect(reported(), "a limit is a refusal, not a fault").toEqual([]);
    __setRateLimitCounterForTests(null);
    await addedOn(await add(out.token, pick(a!.id, b!.id)), out.token);
    expect(await adhocOf(out.competitionId)).toHaveLength(1);
  });
});

// ── a played decider, voided (review m3) ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("an added match played and then voided reopens like any other match; the cap does not move (review m3)", () => {
  it("added, played to decided, its deciding event voided: the hero is on it again, no winner card, still one extra match", async () => {
    const out = await create();
    const [only] = await fixturesOf(out.competitionId);
    const [a, b] = await sidesOf(out.competitionId);
    expect(await playToDecided(systemAuth(), only!.id)).toMatchObject({ kind: "decided" });
    await addedOn(await add(out.token, pick(a!.id, b!.id)), out.token);
    const [decider] = await adhocOf(out.competitionId);
    expect(decider, "premise: the add made one extra match").toBeDefined();
    const played = await playToDecided(systemAuth(), decider!.id);
    if (played.kind !== "decided") throw new Error(`precondition: the decider decided, got ${JSON.stringify(played)}`);
    let html = await homeAt(`/q/${out.token}`);
    expect(html, "premise: both played, the winner card is up").toContain('data-testid="qm-winner"');

    // The void use case, as Edit result's pad posts it: core.void of the deciding event, expected_seq = the tip.
    await scoreEvent(systemAuth(), decider!.id, {
      expected_seq: played.lastSeq,
      type: "core.void",
      payload: { event_id: played.lastEventId },
    });
    const [after] = (await fixturesOf(out.competitionId)).filter((f) => f.id === decider!.id);
    expect(after!.status, "no longer decided").not.toBe("decided");
    html = await homeAt(`/q/${out.token}`);
    expect(html, "no winner once the result is undone").not.toContain('data-testid="qm-winner"');
    // The hero is on the decider again: the next row is its row, and the kicker numbers it 2 of 2. Its other rallies stand,
    // so the engine reads it in play: the live kicker.
    const next = /<li[^>]*data-testid="qm-match"[^>]*data-fixture-id="([^"]+)"[^>]*data-next="true"/.exec(html)?.[1];
    expect(next, "the row marked next is the voided decider").toBe(decider!.id);
    // The kicker is a <p> holding the live dot's span and the words' span: read the whole <p>, tags stripped.
    const kicker = /data-testid="qm-hero-kicker"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(unescape(kicker.replace(/<[^>]+>/g, "")).trim()).toBe(interpolate(en["quickMatch.home.liveMatch"], { n: 2, total: 2 }));
    expect(textOfTestId(html, "qm-hero-home")).toBe(a!.name);
    expect(textOfTestId(html, "qm-hero-away")).toBe(b!.name);
    expect(textOfTestId(html, "qm-played")).toBe(
      plural(en, "quickMatch.home.played", 2, "en", { played: 1, days: SPEC_EXPIRY_DAYS }),
    );
    // The cap's count: a void neither removes the extra match nor adds one.
    expect((await adhocOf(out.competitionId)).map((f) => f.id), "still exactly the one extra match").toEqual([decider!.id]);
  });
});

// ── a refused add comes back open, at the guest's picks (review m4) ───────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a refused add hands the guest's picks back: the home opens 'Add a match' at them (review m4)", () => {
  it("the same side twice: the Location carries both picks; the home prints the flash with the disclosure open at them", async () => {
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const [, , c] = await sidesOf(out.competitionId);
    const res = await add(out.token, pick(c!.id, c!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.SAME_SIDE);
    const location = res.headers.get("location")!;
    expect(pickedBack(location)).toEqual({ home: c!.id, away: c!.id });
    const html = await homeAt(location);
    expect(flashOf(html)).toBe(FLASH.sameSide);
    const form = addForm(html)!;
    expect(form.open, "open on first paint").toBe(true);
    expect([form.selects.home!.selected, form.selects.away!.selected], "at the guest's picks, not the table's").toEqual([c!.id, c!.id]);
    // The negative pair: the same home with no refusal opens closed, at its own pick (the table's top two, neither c).
    const plain = addForm(await homeAt(`/q/${out.token}`))!;
    expect(plain.open).toBe(false);
    expect([plain.selects.home!.selected, plain.selects.away!.selected]).not.toContain(c!.id);
  });

  it("each refusal hands back the picks shaped like an id, and the home keeps only this match's own sides", async () => {
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const other = await create();
    const [a, b] = await sidesOf(out.competitionId);
    const [x] = await sidesOf(other.competitionId);
    const defaults = addForm(await homeAt(`/q/${out.token}`))!;
    const [dHome, dAway] = [defaults.selects.home!.selected!, defaults.selects.away!.selected!];
    // [what is posted, the code, the picks handed back, the selects the home opens at]
    const cases: [Record<string, string>, string, { home: string | null; away: string | null }, [string, string]][] = [
      // A side and a non-id: only the id comes back; the other select keeps the home's own pick.
      [pick(b!.id, "not-a-side"), QUICK_MATCH_ERRORS.NOT_FOUND, { home: b!.id, away: null }, [b!.id, dAway]],
      // Another quick match's side: handed back (it is id-shaped), never kept (not one of this match's sides).
      [pick(x!.id, a!.id), QUICK_MATCH_ERRORS.NOT_FOUND, { home: x!.id, away: a!.id }, [dHome, a!.id]],
    ];
    let checked = 0;
    for (const [body, code, back, opensAt] of cases) {
      const res = await add(out.token, body);
      expect(await refusedWith(res, out.token), JSON.stringify(body)).toBe(code);
      const location = res.headers.get("location")!;
      expect(pickedBack(location), JSON.stringify(body)).toEqual(back);
      const form = addForm(await homeAt(location))!;
      expect(form.open, JSON.stringify(body)).toBe(true);
      expect([form.selects.home!.selected, form.selects.away!.selected], JSON.stringify(body)).toEqual(opensAt);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Nothing posted that is an id: no picks, and so the disclosure stays closed (no refused add to come back to).
    const res = await add(out.token, {});
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.NOT_FOUND);
    expect(pickedBack(res.headers.get("location")!)).toEqual({ home: null, away: null });
    expect(addForm(await homeAt(res.headers.get("location")!))!.open).toBe(false);
  });

  it("the post limit and a fault hand the picks back too (the guest's retry is one tap); the dead link never does", async () => {
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const [a, b, c] = await sidesOf(out.competitionId);
    __setRateLimitCounterForTests(async (key) => (key === `rl:qm-add:${out.id}` ? { count: MUTATION_LIMIT.max + 1, ttlMs: 30_000 } : null));
    let res = await add(out.token, pick(c!.id, b!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(pickedBack(res.headers.get("location")!)).toEqual({ home: c!.id, away: b!.id });
    __setRateLimitCounterForTests(null);
    addSpy.mockRejectedValueOnce(new Error("connection reset"));
    res = await add(out.token, pick(b!.id, a!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(pickedBack(res.headers.get("location")!)).toEqual({ home: b!.id, away: a!.id });
    const form = addForm(await homeAt(res.headers.get("location")!))!;
    expect([form.open, form.selects.home!.selected, form.selects.away!.selected]).toEqual([true, b!.id, a!.id]);
    // The dead link: the bare home, nothing handed back (D16: it says nothing).
    const changed = out.token.slice(0, -1) + (out.token.endsWith("A") ? "B" : "A");
    expect(await landed(await add(changed, pick(a!.id, b!.id)))).toBe(`/q/${changed}`);
  });

  it("picks with no flash (a reload, a crafted link) or a Score refusal with none: the disclosure stays closed at the home's own pick", async () => {
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const [, , c] = await sidesOf(out.competitionId);
    const own = addForm(await homeAt(`/q/${out.token}`))!;
    const cases = [
      `/q/${out.token}?home=${c!.id}&away=${c!.id}`,
      `/q/${out.token}?e=${QUICK_MATCH_ERRORS.SIDES_UNKNOWN}`,
    ];
    let checked = 0;
    for (const location of cases) {
      const form = addForm(await homeAt(location))!;
      expect(form.open, location).toBe(false);
      expect([form.selects.home!.selected, form.selects.away!.selected], location).toEqual([
        own.selects.home!.selected,
        own.selects.away!.selected,
      ]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ── the dead link, and a quick match gone mid-post ──────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("an unknown, changed or expired token lands on its own /q/<token>: the dead screen, nothing added", () => {
  it("never adds, never spends the post limit, never names a reason, and never leaves /q/", async () => {
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      keys.push(key);
      return null;
    });
    const changed = out.token.slice(0, -1) + (out.token.endsWith("A") ? "B" : "A");
    const cases: [string, string][] = [
      [changed, `/q/${changed}`],
      ["not-a-token", "/q/not-a-token"],
      ["../../admin", "/q/..%2F..%2Fadmin"],
    ];
    let checked = 0;
    for (const [token, location] of cases) {
      const res = await add(token, pick(a!.id, b!.id));
      expect(await landed(res), token).toBe(location);
      expect(await homeAt(location), token).toContain('data-testid="qm-dead-link"');
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Expired: the same.
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day'
              where id = ${out.id}`;
    expect(await landed(await add(out.token, pick(a!.id, b!.id)))).toBe(`/q/${out.token}`);
    expect(keys.filter((k) => k.startsWith("rl:qm-add:")), "no bucket spent on a dead link").toEqual([]);
    expect(addSpy).not.toHaveBeenCalled();
    expect(await adhocOf(out.competitionId)).toEqual([]);
    expect(reported()).toEqual([]);
  });

  it("a quick match whose competition is gone between the token's read and the home's: the bare home (the dead link), never reported", async () => {
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    readSpy.mockResolvedValueOnce(null);
    expect(await landed(await add(out.token, pick(a!.id, b!.id)))).toBe(`/q/${out.token}`);
    expect(addSpy).not.toHaveBeenCalled();
    expect(reported()).toEqual([]);
  });
});

// ── a fault is reported, and still a 303 ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a fault is reported to Sentry and still lands on the home's generic line", () => {
  it("addFixture's own refusal after every check of the route passed (a stage someone completed): reported, the generic line", async () => {
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    await sql`update stages set status = 'complete'
              where division_id in (select id from divisions where competition_id = ${out.competitionId})`;
    const res = await add(out.token, pick(a!.id, b!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.generic);
    expect(addSpy, "premise: the route's checks passed and addFixture refused").toHaveBeenCalledTimes(1);
    expect(reported()).toHaveLength(1);
    expect(reported()[0]).toMatchObject({ status: 422 });
    expect(await adhocOf(out.competitionId)).toEqual([]);
  });

  it("an unexpected error: reported once, the generic line", async () => {
    const out = await create();
    const [a, b] = await sidesOf(out.competitionId);
    const boom = new Error("connection reset");
    addSpy.mockRejectedValueOnce(boom);
    const res = await add(out.token, pick(a!.id, b!.id));
    expect(await refusedWith(res, out.token)).toBe(QUICK_MATCH_ERRORS.ACTION_FAILED);
    expect(flashOf(await homeAt(res.headers.get("location")!))).toBe(FLASH.generic);
    expect(reported()).toEqual([boom]);
  });
});

// ── the seam: the home's form posts here ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("the seam: the home's Add-a-match form names this route, opens at the table's top two, and its post adds that match", () => {
  it("a league of 4 with one result: the form's action is this route, every side is offered in both selects, the defaults are the table's top two; posting them adds exactly that match", async () => {
    const out = await create(league({ sides: SIDES }));
    const sides = await sidesOf(out.competitionId);
    const [first] = await fixturesOf(out.competitionId);
    const played = await playToDecided(systemAuth(), first!.id);
    expect(played).toMatchObject({ kind: "decided" });
    // The table's top two, read from the STORED table (the producer's order), never from the page.
    const [stored] = await sql<{ rows: { entrantId: string }[] }[]>`
      select s.rows from standings_snapshots s join stages st on st.id = s.stage_id
      join divisions d on d.id = st.division_id
      where d.competition_id = ${out.competitionId} and s.pool_id is null`;
    const topTwo = stored!.rows.slice(0, 2).map((r) => r.entrantId);
    expect(topTwo).toHaveLength(2);

    const html = await homeAt(`/q/${out.token}`);
    const form = addForm(html);
    expect(form, "a league draws the form").not.toBeNull();
    expect(form!.action).toBe(`/q/${out.token}/add-match`);
    const routeFile = path.resolve(import.meta.dirname, "../add-match/route.ts");
    expect(fs.existsSync(routeFile), "the action's route file is the handler under test").toBe(true);
    expect(Object.keys(form!.selects).sort()).toEqual(["away", "home"]);
    let checked = 0;
    for (const name of ["home", "away"] as const) {
      expect(form!.selects[name]!.options, `${name}: every side, in the order typed`).toEqual(sides.map((s) => s.id));
      checked++;
    }
    expect(checked).toBe(2);
    expect([form!.selects.home!.selected, form!.selects.away!.selected], "opens at the table's top two").toEqual(topTwo);

    await addedOn(await add(out.token, pick(form!.selects.home!.selected!, form!.selects.away!.selected!)), out.token);
    expect((await adhocOf(out.competitionId)).map((f) => [f.home_entrant_id, f.away_entrant_id])).toEqual([topTwo]);
  });

  it("a knockout draws no form, so nothing on its home posts here", async () => {
    const cup = await create(league({ format: "knockout", sides: SIDES.slice(0, 4) }));
    const html = await homeAt(`/q/${cup.token}`);
    expect(addForm(html)).toBeNull();
    expect(html).not.toContain("/add-match");
  });
});

// ── the sweep over every answer this file saw ────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("every answer", () => {
  it("was a 303 to a relative path on this site: the home, or the home with one ?e= the home maps to its own copy", async () => {
    expect(seen.length, "the cases above ran (anti-vacuity)").toBeGreaterThanOrEqual(30);
    const codes = new Set<string>();
    for (const { status, location } of seen) {
      expect(status, location).toBe(303);
      expect(location, "relative, never another origin").toMatch(/^\/(?!\/)/);
      const url = new URL(location, "http://localhost");
      expect(url.pathname, location).toMatch(/^\/q\/[^/]+$/);
      const e = url.searchParams.get("e");
      if (e !== null) codes.add(e);
    }
    // Every refusal the route sends, each seen at least once, and each one the home prints as its own line.
    expect([...codes].sort()).toEqual(
      [
        QUICK_MATCH_ERRORS.SAME_SIDE,
        QUICK_MATCH_ERRORS.LEAGUE_ONLY,
        QUICK_MATCH_ERRORS.NOT_FOUND,
        QUICK_MATCH_ERRORS.ADHOC_LIMIT,
        QUICK_MATCH_ERRORS.ACTION_FAILED,
      ].sort(),
    );
  });
});
