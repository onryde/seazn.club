// /admin/quick-matches, rendered (owner 2026-11-12): the real page, the real reads, the real session.
//
// The secrecy the page owes: a guest's home link is the key to their match, so the page never shows the home token (`qm_…`),
// a device link (`dl_…`), the address a guest typed, or who saved a match. This renders the page over matches that HAVE all
// of those (an emailed match with a minted device link, a match saved by a named account) and looks for each, by value and by
// shape. Guest-typed side names are shown, escaped.
//
// The session is the REAL one (createSession into a cookie jar standing in for next/headers). The reads are the real ones,
// scoped to this file's own matches: the system org is shared by every suite running against one database, so the module is
// wrapped only to pass the reads' TEST ONLY `onlyIds`. Every match is made by the real create, scored by the real write path,
// saved by the real Save.
//
// Expected values come from the two seeds (what each one is), never from the reads under test.
//
// One sport (badminton), on purpose: the page renders the reads' rows, which the usecase suite already holds across two sports.
//
// Plan 4 Task 2: a match marked Not played counts as done. Before Task 3's writer exists, `markNotPlayed` below stands in
// for it with the same guarded status write.
//
// Real Postgres required; skipped without DATABASE_URL. Rendered through react-dom/server (vitest runs `environment: "node"`).
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
const scope = vi.hoisted(() => ({ ids: [] as string[], order: [] as string[] }));
vi.mock("@/server/usecases/quick-match-admin", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-admin")>();
  return {
    ...real,
    quickMatchAdminCounts: (o: Parameters<typeof real.quickMatchAdminCounts>[0] = {}) => {
      scope.order.push("read");
      return real.quickMatchAdminCounts({ ...o, onlyIds: scope.ids });
    },
    listQuickMatchesForAdmin: (o: Parameters<typeof real.listQuickMatchesForAdmin>[0] = {}) => {
      scope.order.push("read");
      return real.listQuickMatchesForAdmin({ ...o, onlyIds: scope.ids });
    },
  };
});
// The real guard, recorded: the page's own ask must come BEFORE any read (the reads ask too, so a page that dropped its own
// would still be refused, by the reads; the order is what tells the two guards apart).
vi.mock("@/lib/admin", async (orig) => {
  const real = await orig<typeof import("@/lib/admin")>();
  return {
    ...real,
    requireStaff: () => {
      scope.order.push("guard");
      return real.requireStaff();
    },
  };
});

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex")); // every create seals a home token, every Score tap a link
vi.stubEnv("AUTH_SECRET", "quick-matches-admin-page-test");

import { createSession } from "@/lib/auth";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import { createQuickMatch, systemAuth, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { hashHomeToken, hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { ensureGuestDeviceLink } from "@/server/usecases/device-links";
import { scoreEvent } from "@/server/usecases/scoring";
import { firstRallyFor, playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import AdminQuickMatchesPage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;

const competitions: string[] = [];
const users: string[] = [];

/** Guest-typed side names with markup and quotes in them: the page must print them as text. */
const MARKUP_SIDE = `<b>Ravi</b> & "Sam"`;
const PLAIN_SIDE = "Priya & Tom";

interface Secrets {
  played: CreatedQuickMatch;
  saved: CreatedQuickMatch;
  typedEmail: string;
  visitorHashes: string[];
  deviceLink: string;
  saver: { id: string; email: string; name: string };
}
let S: Secrets;

async function create(email: string | null, visitorHash: string, sides: string[] = [MARKUP_SIDE, PLAIN_SIDE]): Promise<CreatedQuickMatch> {
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === "badminton");
  if (!sport) throw new Error("premise: badminton is offered for quick matches");
  const out = await createQuickMatch(
    {
      name: `QM admin page ${randomUUID().slice(0, 8)}`,
      sport_key: "badminton",
      variant_key: sport.variants[0]!.variant_key,
      kind: sport.kinds.at(-1)!,
      format: "league",
      sides,
      plays: 1,
      email,
      locale: "en",
    },
    { visitorHash, baseUrl: "https://qm-admin-page.test", mailAllowed: async () => true },
  );
  competitions.push(out.competitionId);
  return out;
}

async function signInAs(staff: boolean): Promise<void> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`qm-admin-page-${randomUUID()}@example.test`}, 'Quick match admin page reader', true, ${staff}, ${staff ? "support" : null})
    returning id`;
  users.push(id);
  jar.clear();
  await createSession(id);
}

const render = async (filter?: string | string[]): Promise<string> =>
  renderToStaticMarkup(await AdminQuickMatchesPage({ searchParams: Promise.resolve(filter === undefined ? {} : { filter }) }));

const rowsIn = (html: string): number => html.split('data-testid="qm-row"').length - 1;
/** Each listed row's Decided cell, in order. */
const decidedCells = (html: string): string[] => [...html.matchAll(/data-testid="qm-decided"[^>]*>([^<]*)</g)].map((m) => m[1]!);

/**
 * Marks a match Not played. This STANDS IN for plan 4 Task 3's writer (`quick-match-skip.ts`, not built when this was
 * written) and makes the same guarded status write: under the fixture lock the write path takes (append-event.ts), only
 * `scheduled` or `in_play` becomes `cancelled`, and exactly one row moves.
 */
async function markNotPlayed(fixtureId: string): Promise<void> {
  const moved = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    return tx<{ id: string }[]>`
      update fixtures set status = 'cancelled' where id = ${fixtureId} and status in ('scheduled', 'in_play') returning id`;
  });
  expect(moved, `premise: fixture ${fixtureId} was open and is now Not played`).toHaveLength(1);
}
const cell = (html: string, row: string, window: string): string | undefined =>
  html.match(new RegExp(`data-testid="qm-count-${row}-${window}"[^>]*>([^<]*)<`))?.[1];

beforeAll(async () => {
  if (!HAS_DB) return;
  const typedEmail = `qm-admin-page-guest-${randomUUID().slice(0, 8)}@example.test`;
  const visitorHashes = [hashVisitorKey(mintVisitorKey()), hashVisitorKey(mintVisitorKey())];
  // 1. An emailed match, a Score tap's device link minted, one rally scored: played, never saved.
  const played = await create(typedEmail, visitorHashes[0]!);
  const row = await resolveQuickMatchToken(played.token);
  if (!row) throw new Error("precondition: the new match resolves");
  const [f] = await sql<{ id: string }[]>`
    select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${played.competitionId}
     order by f.round_no, f.fixture_no limit 1`;
  const { secret: deviceLink } = await ensureGuestDeviceLink(row, f!.id);
  for (const req of await firstRallyFor(f!.id)) await scoreEvent(systemAuth(), f!.id, req);
  // 2. A match saved by a named account, never played.
  const name = `Saver ${randomUUID().slice(0, 6)}`;
  const saverEmail = `qm-admin-page-saver-${randomUUID().slice(0, 8)}@example.test`;
  const [saver] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${saverEmail}, ${name}, true) returning id`;
  users.push(saver!.id);
  const saved = await create(null, visitorHashes[1]!);
  expect(await saveQuickMatchForUser(saver!.id, saved.id), "premise: the real Save kept it").toBe("saved");
  scope.ids = [played.id, saved.id];
  S = { played, saved, typedEmail, visitorHashes, deviceLink, saver: { id: saver!.id, email: saverEmail, name } };
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  for (const id of competitions) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("/admin/quick-matches: the staff guard is the page's own", () => {
  it("a signed-out visitor and a signed-in NON-staff user are each refused; staff see the page (the positive pair)", async () => {
    const refusals: [who: string, signIn: () => Promise<unknown>, message: string][] = [
      ["no session", async () => { jar.clear(); }, "Not authenticated"],
      ["a non-staff user", () => signInAs(false), "Staff access required"],
    ];
    let refused = 0;
    for (const [who, signIn, message] of refusals) {
      await signIn();
      const e = await render().then(() => null, (err: unknown) => err);
      expect(e, who).toBeInstanceOf(AuthError);
      expect((e as Error).message, who).toBe(message);
      refused++;
    }
    expect(refused).toBe(2);
    await signInAs(true);
    scope.order.length = 0;
    expect(rowsIn(await render())).toBe(2);
    // The page asked first, then each read asked for itself.
    expect(scope.order[0]).toBe("guard");
    expect(scope.order.filter((x) => x === "read").length).toBe(2);
    expect(scope.order.filter((x) => x === "guard").length).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("/admin/quick-matches renders what is there, and nothing secret", () => {
  it("never shows a home token, a device link, the typed address or the saver (by value and by shape); shows the sides escaped", async () => {
    await signInAs(true);
    const html = await render();
    // Anti-vacuity: both matches are on the page, with the guest's sides.
    expect(rowsIn(html)).toBe(2);
    expect(html).toContain(PLAIN_SIDE.replace("&", "&amp;"));

    // By value: everything secret these two matches hold.
    const secrets: [what: string, value: string][] = [
      ["the played match's home token", S.played.token],
      ["the saved match's home token", S.saved.token],
      ["a home token's hash", hashHomeToken(S.played.token)],
      ["the device link", S.deviceLink],
      ["the typed address", S.typedEmail],
      ["the saver's address", S.saver.email],
      ["the saver's id", S.saver.id],
      ["the saver's name", S.saver.name],
      ...S.visitorHashes.map((h, i): [string, string] => [`visitor hash ${i}`, h]),
    ];
    for (const [what, value] of secrets) {
      expect(value.length, `premise: ${what} is a real value`).toBeGreaterThan(8);
      expect(html, what).not.toContain(value);
    }
    expect(secrets.length).toBe(10);
    // By shape: no token-shaped string and no address at all, whatever its value.
    expect(S.played.token.startsWith("qm_"), "premise: home tokens are qm_-shaped").toBe(true);
    expect(S.deviceLink.startsWith("dl_"), "premise: device links are dl_-shaped").toBe(true);
    expect(html).not.toContain("qm_");
    expect(html).not.toContain("dl_");
    expect(html).not.toContain("@");

    // Guest-typed text is printed as text: the markup and the quotes escaped, never live.
    expect(html).not.toContain("<b>Ravi</b>");
    expect(html).toContain("&lt;b&gt;Ravi&lt;/b&gt; &amp; &quot;Sam&quot;");
  });

  it("the counts are the two seeds': created 2, played 1, finished 0, saved 1, expired 0, in every window", async () => {
    await signInAs(true);
    const html = await render();
    const want = { created: "2", played: "1", finished: "0", saved: "1", expiredPending: "0" };
    let checked = 0;
    for (const w of ["24h", "7d", "30d"]) {
      for (const [row, n] of Object.entries(want)) {
        expect(cell(html, row, w), `${row} ${w}`).toBe(n);
        checked++;
      }
    }
    expect(checked).toBe(15);
    // The page says what it cannot count: a deleted match leaves no row, so its row points at PostHog's event (controller
    // ruling 2026-11-12, the name typed here) instead of a number, in every window.
    expect(html).toContain('data-testid="qm-counts-note"');
    // Review m6: no window is claimed complete; the 24-hour one names the one delete that reaches it. Unescaped first: the
    // static markup writes the apostrophe as an entity, and a raw probe would fail on spelling, not on the words.
    const note = html.replace(/&#x27;|&apos;/g, "'");
    expect(note).toContain("every window counts the survivors; within 24 hours only a saver's Delete removes one");
    // The sentence as a reader sees it: the event names keep their spaces (a JSX line break before `{...}` ate one, and
    // the sign-off screen read "deletion asquick_match_deleted"). The note's own text, tags out, names typed here.
    const noteText = /data-testid="qm-counts-note"[^>]*>([\s\S]*?)<\/p>/.exec(note)?.[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    expect(noteText, "the note renders").toBeDefined();
    expect(noteText).toContain("PostHog has every deletion as quick_match_deleted, by how it went, and every create as quick_match_created.");
    expect(note).not.toContain("Created over 7 and 30 days");
    let pointed = 0;
    for (const w of ["24h", "7d", "30d"]) {
      expect(cell(html, "deleted", w), `deleted ${w}`).toBe("see PostHog: quick_match_deleted");
      pointed++;
    }
    expect(pointed).toBe(3);
  });

  it("the filter: played shows the played one, saved the saved one, never played the saved one; an unknown or repeated value is all", async () => {
    await signInAs(true);
    const cases: [filter: string | string[] | undefined, rows: number, saved: string[]][] = [
      [undefined, 2, ["no", "yes"]],
      ["played", 1, ["no"]],
      ["saved", 1, ["yes"]],
      ["never", 1, ["yes"]],
      ["bogus", 2, ["no", "yes"]],
      [["played", "saved"], 2, ["no", "yes"]],
    ];
    let checked = 0;
    for (const [filter, rows, saved] of cases) {
      const html = await render(filter);
      expect(rowsIn(html), JSON.stringify(filter)).toBe(rows);
      const shown = [...html.matchAll(/>(yes|no)<\/span>/g)].map((m) => m[1]).sort();
      expect(shown, JSON.stringify(filter)).toEqual(saved);
      checked++;
    }
    expect(checked).toBe(6);
    // The active filter is marked.
    expect(await render("saved")).toMatch(/aria-current="page"[^>]*>Saved</);
  });

  it("Not played (plan 4): the Decided cell adds how many were not played, and Finished counts a league finished by skips", async () => {
    await signInAs(true);
    const ids = scope.ids;
    // A league of three sides: three matches (a round robin of n is n(n-1)/2), scoped alone so the counts are its own.
    const league = await create(null, hashVisitorKey(mintVisitorKey()), [PLAIN_SIDE, "Asha & Ben", "Lee & Ana"]);
    scope.ids = [league.id];
    try {
      const fixtures = await sql<{ id: string }[]>`
        select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${league.competitionId}
         order by f.round_no, f.fixture_no`;
      expect(fixtures.length, "premise: a round robin of 3 is 3 matches").toBe(3);
      expect(await playToDecided(systemAuth(), fixtures[0]!.id), "premise: played to a result").toMatchObject({ kind: "decided" });

      // Nothing not played: the cell is the guest's own "x of y", and the match is not finished.
      let html = await render();
      expect(decidedCells(html)).toEqual(["1 of 3"]);
      let finished = 0;
      for (const w of ["24h", "7d", "30d"]) {
        expect(cell(html, "finished", w), w).toBe("0");
        finished++;
      }

      // One not played: x of y keeps the full total and says the rest; still one to play, still not finished.
      await markNotPlayed(fixtures[1]!.id);
      html = await render();
      expect(decidedCells(html)).toEqual(["1 of 3 · 1 not played"]);
      expect(cell(html, "finished", "30d")).toBe("0");

      // The last not played: every match played or not played, so it is finished in every window.
      await markNotPlayed(fixtures[2]!.id);
      html = await render();
      expect(decidedCells(html)).toEqual(["1 of 3 · 2 not played"]);
      for (const w of ["24h", "7d", "30d"]) {
        expect(cell(html, "finished", w), w).toBe("1");
        finished++;
      }
      expect(finished).toBe(6);
      // The Finished row's hint says what finished now means.
      expect(html).toContain("every match played or not played");
      expect(html).not.toContain("every match decided");
    } finally {
      scope.ids = ids;
    }
  });

  it("the empty case: nothing in scope is the empty row, not an empty table", async () => {
    await signInAs(true);
    const ids = scope.ids;
    scope.ids = [];
    try {
      const html = await render();
      expect(rowsIn(html)).toBe(0);
      expect(html).toContain("No quick matches");
      expect(cell(html, "created", "30d")).toBe("0");
    } finally {
      scope.ids = ids;
    }
  });
});
