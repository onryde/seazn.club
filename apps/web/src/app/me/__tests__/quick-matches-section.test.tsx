// Quick match plan 3, Task 6 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7, C9, C13, C19; plan 3 Amend T6
// [B25, B26, B29], ledger carry "the saved-list finder goes IN quick-match-home.ts"): the account's "Quick matches" on /me, the
// REAL page rendered whole over a real database.
//
// What is proven here:
//   - the empty case first (B26): an account with no saved quick match has no section and no heading, whatever else exists (a
//     match typed with its address but not saved, a match someone else saved);
//   - a saver's matches: one row each, the most recently active first, its name linking to its own home `/q/<token>` (the link
//     rebuilt from the sealed envelope, C19) with `ph-no-capture` (B25), its format and its "{played} of {count}" from the
//     rulebook's counts (a single round robin of n plays n(n-1)/2, a single knockout of n plays n-1, its bye not a match), the
//     same count the match's own home reads;
//   - a row whose token cannot be opened (no usable KEK) is listed by name, without a link, and one warning names it (B29);
//   - C9: the saved match is not among the account's own competitions and does not count toward its plan;
//   - the viewer's language;
//   - the "Nothing here yet" card is not printed above a list of quick matches (it would be false), and is with none.
//
// The real producers: `createQuickMatch` makes each match, the real Save keeps it, the events route's own door scores it,
// `createOrgForUser` makes the account's organization. Stand-ins: the session (`getCurrentUser` answers the case's account), the
// viewer's language, the router, PostHog, and the player-home reads that are not this section's (no rosters, no stats).
//
// Sport: badminton only: the list reads no sport, and the counts are the format's (league, knockout), which is what varies here.
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK); // every create seals a home token, every Score tap a link

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; display_name: string; timezone: string | null; locale: string | null },
  locale: "en" as "en" | "fr" | "es" | "nl",
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirected to ${to}`);
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/me",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => h.user,
  getActiveOrgId: async () => null,
  getUserOrgs: async () => [],
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => h.locale }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
// The player home's other lanes: nobody here is rostered, officiates, holds stats or links Lichess.
vi.mock("@/server/usecases/me", () => ({
  listMyFixtures: async () => ({ upcoming: [], results: [], teams: [] }),
  getMySuspensions: async () => [],
  listMyPersons: async () => [],
  listMyPlayerStats: async () => [],
  listMyCareerStats: async () => [],
}));
vi.mock("@/server/usecases/me-officiating", () => ({
  getMyOfficiating: async () => ({ is_official: false, assignments: [], completed: [], blackouts: [] }),
  listPendingOfficiatingClaims: async () => [],
}));
vi.mock("@/server/usecases/official-marks", () => ({ myMarksAverage: async () => null }));
vi.mock("@/server/usecases/me-lichess", () => ({
  myLichessLink: async () => ({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null }),
}));

import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { plural as pluralRuntime } from "@/lib/i18n-runtime";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { CreateCompetition } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { createCompetition, listCompetitions } from "@/server/usecases/competitions";
import { ensureGuestDeviceLink } from "@/server/usecases/device-links";
import { countActiveCompetitions } from "@/server/usecases/entitlement-freeze";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { listMyQuickMatches, readQuickMatchHome, resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import { addressFor, createTypedMatch, deleteMadeMatches } from "@/server/usecases/__tests__/_quick-match-save-rig";

const { default: MePage } = await import("../page");

const HAS_DB = !!process.env.DATABASE_URL;
const SECTION = "me-quick-matches";

const users: string[] = [];
async function account(tag: string, email = addressFor(tag)): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'QM lister', true) returning id`;
  users.push(id);
  return id;
}
/** The page's viewer: the session `getCurrentUser` answers. */
function viewAs(id: string): void {
  h.user = { id, email: `${id}@test.local`, display_name: "QM lister", timezone: "UTC", locale: null };
}

let badmintonVariant: string | null = null;
const made: string[] = [];
/** A badminton quick match of `sides` sides in `format`, through the real create. */
async function create(format: "league" | "knockout", sides: number): Promise<CreatedQuickMatch> {
  badmintonVariant ??= (
    await sql<{ key: string }[]>`
      select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`
  )[0]!.key;
  const out = await createQuickMatch(
    {
      name: `QM list ${format} ${randomUUID().slice(0, 8)}`,
      sport_key: "badminton",
      variant_key: badmintonVariant,
      kind: "individual",
      format,
      sides: ["Ravi", "Priya", "Sam", "Tom", "Ana", "Lee"].slice(0, sides),
      plays: 1,
      email: null,
      locale: "en",
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true },
  );
  made.push(out.competitionId);
  return out;
}
async function save(userId: string, qm: CreatedQuickMatch): Promise<void> {
  expect(await saveQuickMatchForUser(userId, qm.id), "premise: saved").toBe("saved");
}
/** The first match of `qm` played to its result, through the events route's own door. */
async function playFirst(qm: CreatedQuickMatch): Promise<void> {
  const row = await resolveQuickMatchToken(qm.token);
  const [f0] = await sql<{ id: string }[]>`
    select f.id from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${qm.competitionId} and f.home_entrant_id is not null and f.away_entrant_id is not null
     order by f.round_no, f.fixture_no limit 1`;
  const { secret } = await ensureGuestDeviceLink(row!, f0!.id);
  const auth = await requireFixtureActor(
    new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }),
    f0!.id,
    "score",
  );
  expect(await playToDecided(auth, f0!.id)).toMatchObject({ kind: "decided" });
}

async function page(): Promise<string> {
  return renderToStaticMarkup((await MePage({ searchParams: Promise.resolve({}) })) as ReactElement);
}
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
/** The section's markup, or null when the page has none. */
function sectionOf(html: string): string | null {
  const m = new RegExp(`<section[^>]*data-testid="${SECTION}"[\\s\\S]*?</section>`).exec(html);
  return m ? m[0] : null;
}
interface Row {
  id: string;
  /** The name element's tag: `a` with a link, `span` without. */
  tag: string;
  name: string;
  href: string | null;
  classes: string;
  meta: string;
  hasNoLinkLine: boolean;
}
/** Each row of the section, in order. */
function rowsOf(section: string): Row[] {
  return [...section.matchAll(/<li[^>]*data-qm-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map(([, id, body]) => {
    const name = /<(a|span)([^>]*)data-testid="me-qm-name"([^>]*)>([\s\S]*?)<\/\1>/.exec(body!);
    const attrs = `${name?.[2] ?? ""} ${name?.[3] ?? ""}`;
    const meta = /data-testid="me-qm-meta"[^>]*>([\s\S]*?)<\/p>/.exec(body!);
    return {
      id: id!,
      tag: name?.[1] ?? "",
      name: unescape((name?.[4] ?? "").replace(/<[^>]+>/g, "")),
      href: /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? null,
      classes: /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "",
      meta: unescape((meta?.[1] ?? "").replace(/<[^>]+>/g, "")).trim(),
      hasNoLinkLine: body!.includes('data-testid="me-qm-nolink"'),
    };
  });
}

beforeEach(() => {
  h.user = null;
  h.locale = "en";
  vi.stubEnv("DEVICE_LINK_KEK", KEK);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  await deleteMadeMatches();
  for (const id of made) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (users.length > 0) {
    await sql`delete from competitions where org_id in (select id from organizations where created_by = any(${users}::uuid[]))`;
    await sql`delete from organizations where created_by = any(${users}::uuid[])`;
    await sql`delete from subscriptions where owner_user_id = any(${users}::uuid[])`;
    await sql`delete from users where id = any(${users}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("/me: the account's Quick matches", () => {
  it("the empty case first: no saved quick match, no section and no heading, though a match carries this address and another is someone else's", async () => {
    const email = addressFor("empty");
    const me = await account("empty", email);
    const someoneElse = await account("someone-else");
    await createTypedMatch(email); // typed with my address, never saved: not mine until a sign-in saves it
    await save(someoneElse, await create("league", 2));
    viewAs(me);

    expect(await listMyQuickMatches(me), "the finder answers none").toEqual([]);
    const html = await page();

    expect(sectionOf(html), "no section").toBeNull();
    expect(unescape(html)).not.toContain(`>${en["quickMatch.me.title"]}<`);
    // The positive pair: the page rendered (its own title), and the "Nothing here yet" card is there for an empty account.
    expect(unescape(html)).toContain(`>${en["me.title"]}<`);
    expect(unescape(html)).toContain(en["me.empty"]);
  });

  it("a saver's matches: one row each, most recently active first, each name linking to its own home with ph-no-capture; format and the rulebook's counts, as the home reads them", async () => {
    const me = await account("saver");
    const league = await create("league", 3); // a single round robin of 3: 3 matches
    const knockout = await create("knockout", 3); // a single knockout of 3: 2 matches (one side has a bye, which is no match)
    const pair = await create("league", 2); // 1 match
    for (const qm of [league, knockout, pair]) await save(me, qm);
    await playFirst(league);
    // The order is last activity, newest first: the knockout, then the pair, then the league (whose score touched it last of
    // all, so it is moved back explicitly to make the order the case's, not the clock's).
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await sql`update quick_matches set last_activity_at = ${at(1)} where id = ${knockout.id}`;
    await sql`update quick_matches set last_activity_at = ${at(5)} where id = ${pair.id}`;
    await sql`update quick_matches set last_activity_at = ${at(9)} where id = ${league.id}`;
    // Someone else's saved match never shows here.
    const other = await account("other-saver");
    await save(other, await create("league", 2));
    viewAs(me);

    const section = sectionOf(await page());

    expect(section, "the section is there").not.toBeNull();
    expect(section).toContain(`>${en["quickMatch.me.title"]}<`);
    // The anchor the home's "In your account" link lands on (controller ruling on T6: /me#quick-matches).
    expect(section).toMatch(/^<section[^>]*\sid="quick-matches"/);
    const rows = rowsOf(section!);
    expect(rows.map((r) => r.id)).toEqual([knockout.id, pair.id, league.id]);
    const expected: Record<string, { qm: CreatedQuickMatch; played: number; total: number; format: string }> = {
      [league.id]: { qm: league, played: 1, total: (3 * 2) / 2, format: en["quickMatch.format.league"] },
      [knockout.id]: { qm: knockout, played: 0, total: 3 - 1, format: en["quickMatch.format.knockout"] },
      [pair.id]: { qm: pair, played: 0, total: 1, format: en["quickMatch.format.league"] },
    };
    let checked = 0;
    for (const row of rows) {
      const want = expected[row.id]!;
      const [stored] = await sql<{ name: string }[]>`select name from quick_matches where id = ${row.id}`;
      expect([row.tag, row.name]).toEqual(["a", stored!.name]);
      // C19: the link is the home's own address, rebuilt from the sealed envelope; B25: never recorded by session replay.
      expect(row.href).toBe(`/q/${want.qm.token}`);
      expect(row.classes.split(/\s+/)).toContain("ph-no-capture");
      expect((await resolveQuickMatchToken(row.href!.slice("/q/".length)))?.id, "the link opens this match").toBe(row.id);
      expect(row.meta).toBe(
        `${want.format} · ${pluralRuntime(en, "quickMatch.home.playedSaved", want.total, "en", { played: want.played })}`,
      );
      // The list's count is the home's own count (one reader for both), not a second opinion.
      const home = await readQuickMatchHome((await resolveQuickMatchToken(want.qm.token))!);
      expect([home!.played, home!.total]).toEqual([want.played, want.total]);
      expect(row.hasNoLinkLine).toBe(false);
      checked++;
    }
    expect(checked, "rows checked").toBe(3);
    // Each row offers its saver the two actions (C13), as plain buttons until tapped.
    expect(section!.match(/data-testid="me-qm-rename"/g)).toHaveLength(3);
    expect(section!.match(/data-testid="me-qm-delete"/g)).toHaveLength(3);
    // The "Nothing here yet" card would be false above a list: it is not printed.
    expect(unescape(await page())).not.toContain(en["me.empty"]);
  });

  it("B29: with no usable KEK every row is still listed by name, without a link, with its line saying so; one warning names the rows, never a token", async () => {
    const me = await account("no-kek");
    const a = await create("league", 2);
    const b = await create("league", 2);
    await save(me, a);
    await save(me, b);
    viewAs(me);
    const warn = vi.spyOn(log, "warn");
    vi.stubEnv("DEVICE_LINK_KEK", "");

    const listed = await listMyQuickMatches(me);
    const html = await page();

    expect(listed.map((r) => [r.id, r.token]).sort()).toEqual([[a.id, null], [b.id, null]].sort());
    const rows = rowsOf(sectionOf(html)!);
    expect(rows.map((r) => [r.tag, r.href, r.hasNoLinkLine])).toEqual([
      ["span", null, true],
      ["span", null, true],
    ]);
    expect(unescape(html)).toContain(en["quickMatch.me.noLink"]);
    expect(html, "no home link anywhere on the page").not.toMatch(/href="\/q\//);
    const warnings = warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.startsWith("quick match account list"));
    expect(warnings.length, "one warning per read").toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(warnings);
    expect(text).toContain(a.id);
    expect(text).toContain(b.id);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(b.token);
    warn.mockRestore();

    // The positive pair: the key back, the links back.
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    expect(rowsOf(sectionOf(await page())!).map((r) => r.tag)).toEqual(["a", "a"]);
  });

  it("C9: a saved match is not among the account's own competitions and never counts toward its plan; a real competition of the account does both", async () => {
    const me = await account("c9");
    const org = await createOrgForUser(me, "My organization");
    const auth: AuthCtx = { orgId: org.id, via: "session", userId: me, role: "owner", keyId: null };
    const ids = async () => (await listCompetitions(auth, { cursor: null, limit: 100 })).items.map((c) => c.id);
    const countBefore = await countActiveCompetitions(org.id);
    const qm = await create("league", 2);

    await save(me, qm);

    expect(await countActiveCompetitions(org.id), "the plan's active count is unchanged").toBe(countBefore);
    expect(await ids()).not.toContain(qm.competitionId);
    expect((await listMyQuickMatches(me)).map((r) => r.id), "it is in the account's Quick matches instead").toEqual([qm.id]);
    // The positive pair: a competition the account really runs is listed and counted by the same two readers.
    const real = await createCompetition(
      auth,
      CreateCompetition.parse({ name: `Club cup ${randomUUID().slice(0, 6)}`, visibility: "private", ends_on: "2027-12-31" }),
    );
    expect(await ids()).toContain(real.id);
    expect(await countActiveCompetitions(org.id)).toBe(countBefore + 1);
  });

  it("in the viewer's language: the heading, the actions and the row's line in French", async () => {
    const me = await account("fr");
    const qm = await create("knockout", 3);
    await save(me, qm);
    viewAs(me);
    h.locale = "fr";

    const section = sectionOf(await page())!;

    expect(section).toContain(`>${fr["quickMatch.me.title"]}<`);
    expect(section).toContain(`>${fr["quickMatch.me.rename"]}<`);
    expect(section).toContain(`>${fr["quickMatch.me.delete"]}<`);
    expect(rowsOf(section)[0]!.meta).toBe(
      `${fr["quickMatch.format.knockout"]} · ${pluralRuntime(fr, "quickMatch.home.playedSaved", 2, "fr", { played: 0 })}`,
    );
    expect(fr["quickMatch.me.title"]).not.toBe(en["quickMatch.me.title"]);
  });
});
