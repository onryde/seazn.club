// /admin/quick-matches (owner 2026-11-12: "do we have admin panel to match created, used or not?" / "yes build the admin page"):
// the two staff reads behind it, `quickMatchAdminCounts` and `listQuickMatchesForAdmin`.
//
// Every quick match is made by the real producer (`createQuickMatch`), every point and result by the real write path
// (`scoreEvent`, `playToDecided`), every save by the real Save (`saveQuickMatchForUser`). The direct UPDATEs below are the
// clock (`created_at`, `expires_at`) and one state no guest path writes (a decided match with no score event), each named
// where it is made. The session is the REAL one: `createSession` signs it into a cookie jar standing in for next/headers,
// and `requireStaff` reads it back.
//
// Expected values come from the seed table below (each row says what it is: played, finished, saved, expired, its age),
// the windows from the brief (24 hours, 7 days, 30 days, typed here), the cap from the brief (100), and the rulebook for
// the match counts (a round robin of n sides is n(n-1)/2 matches, a knockout of n sides n-1), never from the code under test.
//
// The system org is shared by every case, run and parallel file: every read here passes `onlyIds` with the case's own ids,
// and every count is that scope's.
//
// Sports: badminton for most rows, football for the finished one (the team sport offered, a different scoring module and
// entrant kind): the reads are sport-blind (a score event exists, a fixture's status), so two sports cover the shape.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
  headers: async () => new Headers(),
}));
// The create's and the save's analytics reach a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// Every log line, recorded: the broken-premise guard is a named log line.
const logs = vi.hoisted(() => {
  const lines: unknown[][] = [];
  const rec = (...args: unknown[]) => void lines.push(args);
  const log: Record<string, unknown> = { error: rec, warn: rec, info: rec, debug: rec, fatal: rec, trace: rec };
  log.child = () => log;
  return { lines, log };
});
vi.mock("@/server/logger", () => ({ log: logs.log }));

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex")); // every create seals a home token
vi.stubEnv("AUTH_SECRET", "quick-match-admin-test");

import { createSession } from "@/lib/auth";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import {
  QUICK_MATCH_ADMIN_LIST_LIMIT,
  isFinished,
  listQuickMatchesForAdmin,
  parseQuickMatchAdminFilter,
  quickMatchAdminCounts,
  type QuickMatchAdminFilter,
} from "../quick-match-admin";
import { saveQuickMatchForUser } from "../quick-match-save";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { firstRallyFor, playToDecided } from "./_quick-match-probe";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR_MS = 3600 * 1000;
/** The brief's three windows, typed here (never read back from the code under test). */
const WINDOWS = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS } as const;
type WindowKey = keyof typeof WINDOWS;
/** The brief's cap on the recent table. */
const BRIEF_LIST_CAP = 100;

const competitions: string[] = [];
const users: string[] = [];
const foreignOrgs: string[] = [];

interface Shape {
  sport_key: "badminton" | "football";
  format: "league" | "knockout";
  sides: string[];
  locale?: "en" | "fr";
  email?: string | null;
}

/** The variant and the kind, from the offer (never typed). */
async function offered(sportKey: string): Promise<{ variant_key: string; kind: CreateQuickMatch["kind"] }> {
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === sportKey);
  if (!sport) throw new Error(`premise: ${sportKey} is offered for quick matches`);
  return { variant_key: sport.variants[0]!.variant_key, kind: sport.kinds.at(-1)! };
}

async function create(shape: Shape): Promise<CreatedQuickMatch> {
  const { variant_key, kind } = await offered(shape.sport_key);
  const out = await createQuickMatch(
    {
      name: `QM admin ${randomUUID().slice(0, 8)}`,
      sport_key: shape.sport_key,
      variant_key,
      kind,
      format: shape.format,
      sides: shape.sides,
      plays: 1,
      email: shape.email ?? null,
      locale: shape.locale ?? "en",
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()), baseUrl: "https://qm-admin.test", mailAllowed: async () => true },
  );
  competitions.push(out.competitionId);
  return out;
}

/** The match's fixtures in (round, number) order, byes included. */
async function fixturesOf(competitionId: string): Promise<{ id: string; status: string }[]> {
  return sql<{ id: string; status: string }[]>`
    select f.id, f.status from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${competitionId} order by f.round_no, f.fixture_no`;
}

/** The first fixture both of whose sides are known (a knockout's first match may wait on nobody). */
async function firstPlayable(competitionId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select f.id from fixtures f join divisions d on d.id = f.division_id
     where d.competition_id = ${competitionId} and f.status = 'scheduled'
       and f.home_entrant_id is not null and f.away_entrant_id is not null
     order by f.round_no, f.fixture_no limit 1`;
  if (!row) throw new Error(`precondition: competition ${competitionId} has no playable fixture`);
  return row.id;
}

/** One rally: a point stands, nothing is decided. */
async function rally(out: CreatedQuickMatch): Promise<void> {
  const fixtureId = await firstPlayable(out.competitionId);
  for (const req of await firstRallyFor(fixtureId)) await scoreEvent(systemAuth(), fixtureId, req);
}

/** The first playable match played to its result. */
async function decideFirst(out: CreatedQuickMatch): Promise<void> {
  const fixtureId = await firstPlayable(out.competitionId);
  expect(await playToDecided(systemAuth(), fixtureId), "premise: the match was played to a result").toMatchObject({ kind: "decided" });
}

/** The clock: the row's creation moved to `at`. */
async function createdAt(id: string, at: Date): Promise<void> {
  await sql`update quick_matches set created_at = ${at} where id = ${id}`;
}

/** A fresh user, signed in (the jar holds only their session). `staff` sets users.is_staff. */
async function signInAs(staff: boolean): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`qm-admin-${randomUUID()}@example.test`}, 'Quick match admin reader', true, ${staff}, ${staff ? "support" : null})
    returning id`;
  users.push(id);
  jar.clear();
  await createSession(id);
  return id;
}

// ── The seed table: what each row IS, the authority every expected number below is counted from ──────────────────────────

interface Seed {
  tag: string;
  /** How long before `now` the row was created. */
  ageMs: number;
  shape: Shape;
  /** What is done to it after the create. */
  act: "none" | "rally" | "decideFirst" | "decideAll" | "save" | "expire";
  played: boolean;
  finished: boolean;
  saved: boolean;
  expired: boolean;
  /** "{decided} of {total}": the rulebook's match count (round robin n(n-1)/2, knockout n-1) and the matches played to a result. */
  decided: number;
  total: number;
}

const TWO = ["Ravi & Sam", "Priya & Tom"];
const THREE = ["Ravi & Sam", "Priya & Tom", "Asha & Ben"];
const SEEDS: Seed[] = [
  { tag: "never", ageMs: 1 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: TWO }, act: "none",
    played: false, finished: false, saved: false, expired: false, decided: 0, total: 1 },
  { tag: "rally", ageMs: 2 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: TWO, locale: "fr" }, act: "rally",
    played: true, finished: false, saved: false, expired: false, decided: 0, total: 1 },
  { tag: "saved", ageMs: 5 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: TWO }, act: "save",
    played: false, finished: false, saved: true, expired: false, decided: 0, total: 1 },
  { tag: "partial", ageMs: 2 * 24 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: THREE }, act: "decideFirst",
    played: true, finished: false, saved: false, expired: false, decided: 1, total: 3 },
  { tag: "finished", ageMs: 3 * 24 * HOUR_MS, shape: { sport_key: "football", format: "league", sides: ["Lions", "Tigers"] }, act: "decideAll",
    played: true, finished: true, saved: false, expired: false, decided: 1, total: 1 },
  { tag: "expired", ageMs: 10 * 24 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: TWO }, act: "expire",
    played: false, finished: false, saved: false, expired: true, decided: 0, total: 1 },
  // A knockout of three: one seat sits out round one, and that bye is settled at the start without anyone playing. It is
  // neither played nor decided (the guest's own "{played} of {count}" excludes it).
  { tag: "ko-bye", ageMs: 20 * 24 * HOUR_MS, shape: { sport_key: "badminton", format: "knockout", sides: THREE }, act: "none",
    played: false, finished: false, saved: false, expired: false, decided: 0, total: 2 },
  { tag: "old", ageMs: 31 * 24 * HOUR_MS, shape: { sport_key: "badminton", format: "league", sides: TWO }, act: "rally",
    played: true, finished: false, saved: false, expired: false, decided: 0, total: 1 },
];
const SEED_HOOK_TIMEOUT_MS = Math.max(30_000, SEEDS.length * 20_000);

let NOW: Date;
const made = new Map<string, CreatedQuickMatch>();
let saverId: string;
let foreignId: string;

/** The seeds' ids, the scope of every read. */
const seedIds = (): string[] => SEEDS.map((s) => made.get(s.tag)!.id);

beforeAll(async () => {
  if (!HAS_DB) return;
  saverId = (await makeUser("qm-admin-saver")).id;
  users.push(saverId);
  for (const s of SEEDS) {
    const out = await create(s.shape);
    made.set(s.tag, out);
    if (s.act === "rally") await rally(out);
    if (s.act === "decideFirst") await decideFirst(out);
    if (s.act === "decideAll") {
      for (const f of await fixturesOf(out.competitionId)) {
        expect(await playToDecided(systemAuth(), f.id), "premise: every match played to a result").toMatchObject({ kind: "decided" });
      }
    }
    if (s.act === "save") expect(await saveQuickMatchForUser(saverId, out.id), "premise: the real Save kept it").toBe("saved");
  }
  NOW = new Date();
  for (const s of SEEDS) {
    await createdAt(made.get(s.tag)!.id, new Date(NOW.getTime() - s.ageMs));
    // The clock again: an unsaved match past its expiry, still on record because no sweep has run yet.
    if (s.act === "expire") await sql`update quick_matches set expires_at = ${new Date(NOW.getTime() - HOUR_MS)} where id = ${made.get(s.tag)!.id}`;
  }

  // Another org's row: a `quick_matches` row that is NOT the system org's (no guest path writes one), saved and past its
  // expiry, created a minute ago. In scope by id, it would add to every count if the org were not the predicate.
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values ('QM admin foreign', ${`qm-admin-foreign-${randomUUID().slice(0, 8)}`}, ${saverId})
    returning id`;
  foreignOrgs.push(org!.id);
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${org!.id}, 'QM admin foreign', ${`qm-admin-foreign-${randomUUID().slice(0, 8)}`}) returning id`;
  const [qm] = await sql<{ id: string }[]>`
    insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, expires_at, created_at)
    values (${org!.id}, ${comp!.id}, 'QM admin foreign', 'league', ${randomBytes(32).toString("hex")}, ${randomBytes(48)},
            ${randomBytes(32).toString("hex")}, ${new Date(NOW.getTime() - HOUR_MS)}, ${new Date(NOW.getTime() - 60_000)})
    returning id`;
  foreignId = qm!.id;
}, SEED_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  logs.lines.length = 0;
  if (HAS_DB) await signInAs(true);
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const id of competitions) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (foreignOrgs.length > 0) {
    await sql`delete from quick_matches where org_id = any(${foreignOrgs}::uuid[])`;
    await sql`delete from competitions where org_id = any(${foreignOrgs}::uuid[])`;
    await sql`delete from organizations where id = any(${foreignOrgs}::uuid[])`;
  }
  if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The counts the seed table says, for one window: every row created at or after `now - window`. */
function expectedCounts(window: WindowKey, seeds: readonly Seed[] = SEEDS) {
  const inside = seeds.filter((s) => s.ageMs <= WINDOWS[window]);
  return {
    created: inside.length,
    played: inside.filter((s) => s.played).length,
    finished: inside.filter((s) => s.finished).length,
    saved: inside.filter((s) => s.saved).length,
    expiredPending: inside.filter((s) => s.expired).length,
  };
}

describe("premises", () => {
  it("the recent table caps at the brief's 100", () => {
    expect(QUICK_MATCH_ADMIN_LIST_LIMIT).toBe(BRIEF_LIST_CAP);
  });
});

describe("isFinished (pure): every match decided, and at least one", () => {
  it("the empty case first: a match with no matches is not finished; all decided is; one short is not", () => {
    const cases: [{ decided: number; total: number }, boolean][] = [
      [{ decided: 0, total: 0 }, false],
      [{ decided: 1, total: 1 }, true],
      [{ decided: 3, total: 3 }, true],
      [{ decided: 2, total: 3 }, false],
      [{ decided: 0, total: 3 }, false],
    ];
    let checked = 0;
    for (const [m, want] of cases) {
      expect(isFinished(m), JSON.stringify(m)).toBe(want);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("parseQuickMatchAdminFilter (pure): a query value as a filter", () => {
  it("the empty case first: absent is all; each filter is itself; an unknown, a repeated or a cased value is all", () => {
    const cases: [unknown, QuickMatchAdminFilter][] = [
      [undefined, "all"], ["", "all"], ["all", "all"], ["played", "played"], ["never", "never"], ["saved", "saved"],
      ["Saved", "all"], ["bogus", "all"], [["played", "saved"], "all"], [["saved"], "all"],
    ];
    let checked = 0;
    for (const [raw, want] of cases) {
      expect(parseQuickMatchAdminFilter(raw), JSON.stringify(raw)).toBe(want);
      checked++;
    }
    expect(checked).toBe(10);
  });
});

describe.skipIf(!HAS_DB)("the staff guard: each read asks for staff itself (a Next layout does not gate its segments)", () => {
  it("no session and a signed-in NON-staff user are each refused by both reads; the same reads as staff answer (the positive pair)", async () => {
    const refusals: [who: string, signIn: () => Promise<unknown>, message: string][] = [
      ["no session", async () => { jar.clear(); }, "Not authenticated"],
      ["a non-staff user", () => signInAs(false), "Staff access required"],
    ];
    let refused = 0;
    for (const [who, signIn, message] of refusals) {
      await signIn();
      for (const read of [() => quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() }), () => listQuickMatchesForAdmin({ onlyIds: seedIds() })]) {
        const e = await read().then(() => null, (err: unknown) => err);
        expect(e, who).toBeInstanceOf(AuthError);
        expect((e as Error).message, who).toBe(message);
        refused++;
      }
    }
    expect(refused).toBe(4);
    await signInAs(true);
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() }))["30d"].created).toBe(expectedCounts("30d").created);
    expect((await listQuickMatchesForAdmin({ onlyIds: seedIds() })).rows.length).toBe(SEEDS.length);
  });
});

describe.skipIf(!HAS_DB)("the counts", () => {
  it("the empty case first: a scope of nothing counts zero everywhere", async () => {
    const counts = await quickMatchAdminCounts({ now: NOW, onlyIds: [] });
    const zero = { created: 0, played: 0, finished: 0, saved: 0, expiredPending: 0 };
    expect(counts).toEqual({ "24h": zero, "7d": zero, "30d": zero });
  });

  it("each window counts the seed table's rows: created, played (a point or a result), finished (every match decided), saved, expired awaiting the sweep", async () => {
    const counts = await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() });
    let checked = 0;
    for (const w of Object.keys(WINDOWS) as WindowKey[]) {
      expect(counts[w], w).toEqual(expectedCounts(w));
      checked++;
    }
    expect(checked).toBe(3);
    // Anti-vacuity on the table itself: every state the page names is seeded inside the widest window, and the windows differ.
    const wide = expectedCounts("30d");
    for (const k of ["created", "played", "finished", "saved", "expiredPending"] as const) expect(wide[k], k).toBeGreaterThan(0);
    expect(expectedCounts("24h")).not.toEqual(expectedCounts("7d"));
    expect(expectedCounts("7d")).not.toEqual(expectedCounts("30d"));
    // And a row older than every window is in none.
    expect(SEEDS.some((s) => s.ageMs > WINDOWS["30d"] && s.played)).toBe(true);
  });

  it("a second read answers the same (a read changes nothing)", async () => {
    const first = await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() });
    expect(await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() })).toEqual(first);
  });

  it("another org's quick_matches row is never counted, though it is in scope by id", async () => {
    const withForeign = await quickMatchAdminCounts({ now: NOW, onlyIds: [...seedIds(), foreignId] });
    expect(withForeign).toEqual(await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() }));
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [foreignId] }))["24h"].created).toBe(0);
  });

  it("after the expired row is swept (hard-deleted) it is in no count: the database keeps no record of it", async () => {
    const doomed = await create({ sport_key: "badminton", format: "league", sides: TWO });
    await sql`update quick_matches set expires_at = ${new Date(NOW.getTime() - HOUR_MS)}, created_at = ${new Date(NOW.getTime() - HOUR_MS)} where id = ${doomed.id}`;
    const before = await quickMatchAdminCounts({ now: NOW, onlyIds: [doomed.id] });
    expect(before["24h"]).toEqual({ created: 1, played: 0, finished: 0, saved: 0, expiredPending: 1 });
    expect(await hardDeleteQuickMatchCompetition(doomed.competitionId, { expiredBefore: NOW })).toEqual({ deleted: true, kept: false });
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [doomed.id] }))["24h"]).toEqual({ created: 0, played: 0, finished: 0, saved: 0, expiredPending: 0 });
  });
});

describe.skipIf(!HAS_DB)("the window edges (inclusive: a row created exactly `window` ago is inside it)", () => {
  it("exactly at each edge is in; one second past it is out", async () => {
    const edge: { tag: string; ageMs: number }[] = [];
    for (const w of Object.keys(WINDOWS) as WindowKey[]) {
      edge.push({ tag: `${w}-at`, ageMs: WINDOWS[w] }, { tag: `${w}-past`, ageMs: WINDOWS[w] + 1000 });
    }
    const ids = new Map<string, string>();
    for (const e of edge) {
      const out = await create({ sport_key: "badminton", format: "league", sides: TWO });
      await createdAt(out.id, new Date(NOW.getTime() - e.ageMs));
      ids.set(e.tag, out.id);
    }
    const counts = await quickMatchAdminCounts({ now: NOW, onlyIds: [...ids.values()] });
    let checked = 0;
    for (const w of Object.keys(WINDOWS) as WindowKey[]) {
      const want = edge.filter((e) => e.ageMs <= WINDOWS[w]).length;
      expect(counts[w].created, w).toBe(want);
      checked++;
    }
    expect(checked).toBe(3);
    // The 24h edge row is in 24h; its one-second-older twin is not, and lands in 7d.
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [ids.get("24h-at")!] }))["24h"].created).toBe(1);
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [ids.get("24h-past")!] }))["24h"].created).toBe(0);
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [ids.get("24h-past")!] }))["7d"].created).toBe(1);
    expect((await quickMatchAdminCounts({ now: NOW, onlyIds: [ids.get("30d-past")!] }))["30d"].created).toBe(0);
  }, Math.max(30_000, 6 * 10_000));
});

describe.skipIf(!HAS_DB)("the recent table", () => {
  /** The seed table's tags a filter keeps, newest first. */
  const want = (keep: (s: Seed) => boolean): string[] => SEEDS.filter(keep).sort((a, b) => a.ageMs - b.ageMs).map((s) => s.tag);
  const tagOf = (id: string): string => [...made.entries()].find(([, m]) => m.id === id)?.[0] ?? `?${id}`;

  it("each filter keeps the seed table's rows, newest first: all, played, never played, saved", async () => {
    const cases: [QuickMatchAdminFilter, (s: Seed) => boolean][] = [
      ["all", () => true],
      ["played", (s) => s.played],
      ["never", (s) => !s.played],
      ["saved", (s) => s.saved],
    ];
    let checked = 0;
    for (const [filter, keep] of cases) {
      const list = await listQuickMatchesForAdmin({ filter, onlyIds: seedIds() });
      const expected = want(keep);
      expect(expected.length, `${filter}: the seed table has rows for it`).toBeGreaterThan(0);
      expect(list.rows.map((r) => tagOf(r.id)), filter).toEqual(expected);
      expect(list.capped, filter).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
    // played and never played partition all.
    expect(want((s) => s.played).length + want((s) => !s.played).length).toBe(SEEDS.length);
  });

  it("no filter is all", async () => {
    const list = await listQuickMatchesForAdmin({ onlyIds: seedIds() });
    expect(list.rows.map((r) => tagOf(r.id))).toEqual(want(() => true));
  });

  it("each row's columns: sport, format, kind, sides in the order typed, decided x of y, saved, expiry, locale", async () => {
    const list = await listQuickMatchesForAdmin({ onlyIds: seedIds() });
    let checked = 0;
    for (const s of SEEDS) {
      const out = made.get(s.tag)!;
      const row = list.rows.find((r) => r.id === out.id);
      expect(row, s.tag).toBeDefined();
      const [db] = await sql<{ created_at: Date; last_activity_at: Date; expires_at: Date | null }[]>`
        select created_at, last_activity_at, expires_at from quick_matches where id = ${out.id}`;
      expect(row, s.tag).toMatchObject({
        sportKey: s.shape.sport_key,
        format: s.shape.format,
        kinds: [(await offered(s.shape.sport_key)).kind],
        sides: s.shape.sides,
        decided: s.decided,
        total: s.total,
        saved: s.saved,
        locale: s.shape.locale ?? "en",
        createdAt: db!.created_at,
        lastActivityAt: db!.last_activity_at,
        expiresAt: db!.expires_at,
      });
      if (s.saved) expect(row!.expiresAt, `${s.tag}: a saved match never expires`).toBeNull();
      else expect(row!.expiresAt, s.tag).toBeInstanceOf(Date);
      checked++;
    }
    expect(checked).toBe(SEEDS.length);
  });

  it("a row carries no token, no typed address and no saver: only the fields the page shows", async () => {
    const list = await listQuickMatchesForAdmin({ onlyIds: seedIds() });
    expect(list.rows.length).toBe(SEEDS.length);
    for (const row of list.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["createdAt", "decided", "expiresAt", "format", "id", "kinds", "lastActivityAt", "locale", "saved", "sides", "sportKey", "total"],
      );
    }
  });

  it("caps at the limit, newest first, and says so; a limit the scope fits is not capped", async () => {
    const two = await listQuickMatchesForAdmin({ onlyIds: seedIds(), limit: 2 });
    expect(two.rows.map((r) => tagOf(r.id))).toEqual(want(() => true).slice(0, 2));
    expect(two.capped).toBe(true);
    const all = await listQuickMatchesForAdmin({ onlyIds: seedIds(), limit: SEEDS.length });
    expect(all.rows.length).toBe(SEEDS.length);
    expect(all.capped).toBe(false);
  });

  it("the empty case: a scope of nothing lists nothing, under every filter", async () => {
    for (const filter of ["all", "played", "never", "saved"] as const) {
      expect(await listQuickMatchesForAdmin({ filter, onlyIds: [] }), filter).toEqual({ rows: [], capped: false });
    }
  });

  it("another org's quick_matches row is never listed, though it is in scope by id", async () => {
    for (const filter of ["all", "never", "saved"] as const) {
      const list = await listQuickMatchesForAdmin({ filter, onlyIds: [foreignId] });
      expect(list.rows, filter).toEqual([]);
    }
  });
});

describe.skipIf(!HAS_DB)("the played premise is a guard, not a comment", () => {
  it("a decided match with no score event (no guest path writes one) is logged by id as a broken premise; the read still answers", async () => {
    const odd = await create({ sport_key: "badminton", format: "league", sides: TWO });
    // A state no guest path writes: the match's one fixture decided without an event. Only an organizer's settle or a
    // withdrawal's walkover could, and a quick match has neither.
    const [f] = await fixturesOf(odd.competitionId);
    await sql`update fixtures set status = 'decided' where id = ${f!.id}`;
    const list = await listQuickMatchesForAdmin({ onlyIds: [odd.id] });
    expect(list.rows[0]).toMatchObject({ decided: 1, total: 1 });
    const text = JSON.stringify(logs.lines);
    expect(text).toContain(odd.id);
    expect(text).toContain("quick match admin");
    // The positive pair: the seeded rows, every one consistent, log nothing.
    logs.lines.length = 0;
    await listQuickMatchesForAdmin({ onlyIds: seedIds() });
    await quickMatchAdminCounts({ now: NOW, onlyIds: seedIds() });
    expect(logs.lines).toEqual([]);
  });
});
