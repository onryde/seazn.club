// Quick match plan 1, Task 7: resolve a home token and read the home (spec docs/superpowers/specs/2026-11-03-quick-match-
// design.md §7.1 point 3, §7.4, §7.5, §7.10; C1, C17, C19; pre-flight B7, C9-C12). Three surfaces:
//   - `resolveQuickMatchToken` / `findQuickMatchByCompetition`: a home token (or a competition) to its `quick_matches`
//     row; a saved row (expires_at null) is alive (B7a);
//   - `readQuickMatchHome` / `nextPlayable`: the home page's read, scoped to the row's own competition (the per-match
//     check, §7.1 point 3: every quick match lives in ONE system org, so RLS alone cannot keep two strangers apart);
//   - `touchQuickMatchActivity` / `...ForFixture`: the 7-day clock (C1) moved by activity, re-armed only while unsaved.
//
// Every quick match is made by the real producer, `createQuickMatch`, and every match result by the real write path
// (`playToDecided` and `scoreEvent`), never by hand-inserted rows; every match marked Not played by the home's own writer
// (`skipQuickMatchFixture`, plan 4 Task 3). The few direct UPDATEs below are the states a later plan or a corrupt row would
// produce (a saved row, an expired one, a tampered seat), each named where it is made.
//
// Every case keys on its OWN quick match (pre-flight A16): the system org is shared by every case, every run and every
// parallel test file, so nothing here counts the org's rows. Expected values come from the spec or the rulebook (round
// robin n·(n-1)/2; a knockout of 3 is two matches and seed 1 sits out, §7.3; 7 days, C1), from the preview (the number
// the Start button showed), or from the database the write path wrote — never from the read under test.
//
// Real Postgres required (RLS, triggers, the generator, the write path); the DB cases skip without DATABASE_URL. The
// `nextPlayable` cases are pure and always run.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "@/lib/db";
import { FIXTURE_STATUSES, type FixtureStatusValue } from "@/lib/fixture-status";
import { isBye, type MatchLineRow } from "@/lib/run-sheet-groups";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n-constants";
import { messages } from "@/lib/messages";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { forEachSportAsync } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import enPublic from "@/dictionaries/en/public.json";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { quickMatchFullTable } from "@/app/q/[token]/full-table";
import { listDivisionFixtures } from "../fixtures";
import { touchQuickMatchActivity, touchQuickMatchActivityForFixture } from "../quick-match-activity";
import { systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { createQuickMatchAnyFormat } from "./_quick-match-knockout";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import {
  findQuickMatchByCompetition,
  isQuickMatchFinished,
  listMyQuickMatches,
  listRecentQuickMatches,
  nextPlayable,
  phaseOf,
  playedOf,
  readQuickMatchHome,
  resolveQuickMatchToken,
  toRow,
  type QuickMatchDbRow,
  type QuickMatchFixture,
  type QuickMatchHome,
  type QuickMatchPhase,
  type QuickMatchRow,
} from "../quick-match-home";
import { quickMatchPreview } from "../quick-match-preview";
import { advanceQuickMatch, afterQuickMatchScore, decideQuickMatchCut, loadLeagueCut } from "../quick-match-advance";
import { getStandings } from "../stages";
import { log } from "@/server/logger";
import { pairKey, playCircle, playWin } from "./_quick-match-results";
import { skipQuickMatchFixture } from "../quick-match-skip";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashHomeToken, hashVisitorKey, mintHomeToken, mintVisitorKey, openHomeToken } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { firstRallyFor, playToDecided } from "./_quick-match-probe";
import { makeUser } from "./_seed";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // A15: every create seals a home token
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// Plan 5 T5: the League + Knockout advance, the real one behind spies. The home read's own retry (`advanceQuickMatch`) and the
// scoring hook's (`afterQuickMatchScore`, reached by `scoring.ts`'s dynamic import of this same module) can each be made to
// miss or fail ONCE, to reach the states only a failed advance leaves (Setting up, a decision on a reopened league). Every
// other call, and every other export, is the real one; `afterEach` resets both to it.
vi.mock("../quick-match-advance", async (orig) => {
  const real = await orig<typeof import("../quick-match-advance")>();
  return {
    ...real,
    advanceQuickMatch: vi.fn(real.advanceQuickMatch),
    afterQuickMatchScore: vi.fn(real.afterQuickMatchScore),
    loadLeagueCut: vi.fn(real.loadLeagueCut),
  };
});
const readRetry = vi.mocked(advanceQuickMatch);
const cutRead = vi.mocked(loadLeagueCut);
const scoreHook = vi.mocked(afterQuickMatchScore);

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 24 * 3600 * 1000;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed here on
 *  purpose so the test does not read it back from the code under test. */
const SPEC_EXPIRY_DAYS = 7;
/** The sweep's budget, in its own cost driver (AGENTS.md class 20): one create and one read per offered sport. Every
 *  other case keeps the repo default (vitest.config.ts: no inline pins). */
const OFFERED_SPORTS = new Set(offerJson.offered.map((o) => o.sport_key)).size;
const SWEEP_TIMEOUT_MS = Math.max(30_000, OFFERED_SPORTS * 30_000);

const uniq = () => `QM home ${randomUUID().slice(0, 8)}`;
/** A visitor as the route names one: a fresh visitor key's sha256 hex. */
const v = () => hashVisitorKey(mintVisitorKey());
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
/** Read from the catalog in beforeAll, never typed (as Task 5's suite does). */
let BADMINTON_V: string;

/** `league4`: four badminton pairs, a single round robin. Each call is its own quick match (its own name). */
const league4 = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: uniq(),
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",   // badminton's entrantModel takes pairs (D2)
  format: "league",
  sides: SIDES,
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});
const create = (input: CreateQuickMatch = league4()) => createQuickMatchAnyFormat(input, { visitorHash: v() });

async function rowOf(out: CreatedQuickMatch): Promise<QuickMatchRow> {
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  return row;
}
async function homeOf(out: CreatedQuickMatch): Promise<QuickMatchHome> {
  const home = await readQuickMatchHome(await rowOf(out));
  if (!home) throw new Error(`precondition: quick match ${out.id} has no home`);
  return home;
}
async function activityOf(id: string): Promise<{ last: number; expires: number | null }> {
  const [q] = await sql<{ last_activity_at: Date; expires_at: Date | null }[]>`
    select last_activity_at, expires_at from quick_matches where id = ${id}`;
  if (!q) throw new Error(`precondition: quick match ${id} has no row`);
  return { last: q.last_activity_at.getTime(), expires: q.expires_at?.getTime() ?? null };
}
/** Plan 3's saved shape (§7.7): a saver, and no expiry. */
async function save(id: string): Promise<void> {
  const saver = await makeUser("qm-saver");
  await sql`update quick_matches set saved_by_user_id = ${saver.id}, expires_at = null where id = ${id}`;
}
/** A standings row as the stored table holds it (`StandingsRowLike`, lib/public-site.ts). */
type TableRow = { entrantId: string; played: number; won: number };
const tableOf = (h: QuickMatchHome) => (h.standings?.rows ?? []) as TableRow[];
const sideIds = (f: QuickMatchFixture) => [f.home?.entrantId, f.away?.entrantId].filter((id): id is string => !!id);

/** Marks a match Not played through the home's own writer (`skipQuickMatchFixture`, plan 4 T3), as its home link would. */
async function markNotPlayed(out: { token: string }, fixtureId: string): Promise<void> {
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error("precondition: the quick match's token resolves");
  expect(await skipQuickMatchFixture(row, fixtureId), `premise: fixture ${fixtureId} was open and is now Not played`)
    .toEqual({ changed: true });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ── nextPlayable: pure ──────────────────────────────────────────────────────────────────────────────────────────────

const fx = (o: Partial<QuickMatchFixture> & Pick<QuickMatchFixture, "id" | "roundNo" | "fixtureNo">): QuickMatchFixture => ({
  home: { entrantId: "e-home", name: "Home" },
  away: { entrantId: "e-away", name: "Away" },
  homeSlotLabel: null,
  awaySlotLabel: null,
  status: "scheduled",
  seqInRound: 1,
  phase: "ready",
  resultMovedOn: false,
  stage: "league",
  knockoutSeats: null,
  summary: null,
  isBye: false,
  isFinal: false,
  winnerEntrantId: null,
  ...o,
});

describe("nextPlayable (C11: the hero's next match)", () => {
  it("empty case first: no fixtures, no next match", () => {
    expect(nextPlayable([])).toBeNull();
  });

  it("orders by round, then by fixture number, whatever order the list arrives in", () => {
    // Each wrong sort key picks a different row: list order → r2n1; fixture number alone → r2n1; round alone (stable) → r1n3.
    const list = [
      fx({ id: "r2n1", roundNo: 2, fixtureNo: 1 }),
      fx({ id: "r1n3", roundNo: 1, fixtureNo: 3 }),
      fx({ id: "r1n2", roundNo: 1, fixtureNo: 2 }),
    ];
    expect(nextPlayable(list)!.id).toBe("r1n2");
    expect(nextPlayable([...list].reverse())!.id).toBe("r1n2");
  });

  it("a match in play comes first, before any lower-numbered scheduled one", () => {
    const list = [
      fx({ id: "r1n1", roundNo: 1, fixtureNo: 1 }),
      fx({ id: "r2n5", roundNo: 2, fixtureNo: 5, status: "in_play" }),
      fx({ id: "r2n4", roundNo: 2, fixtureNo: 4, status: "in_play" }),
    ];
    expect(nextPlayable(list)!.id).toBe("r2n4");   // the first in play, by the same order
  });

  it("a scheduled match with an unknown side waits; no other status is ever next", () => {
    const waiting = [
      fx({ id: "home-unknown", roundNo: 1, fixtureNo: 1, home: null }),
      fx({ id: "away-unknown", roundNo: 1, fixtureNo: 2, away: null }),
    ];
    // The rulebook's non-playable statuses (V214 + V432; C11/C18: only a match in play, or scheduled with both sides, is
    // next), typed here; the domain minus the two playable ones must be exactly this list, so a new status reds here
    // until someone decides whether it can be next.
    const NOT_PLAYABLE = ["decided", "finalized", "abandoned", "forfeited", "cancelled", "needs_decision"];
    const others = FIXTURE_STATUSES.filter((s) => s !== "scheduled" && s !== "in_play");
    expect([...others].sort()).toEqual([...NOT_PLAYABLE].sort());
    let checked = 0;
    for (const status of NOT_PLAYABLE) {
      const list = [...waiting, fx({ id: `s-${status}`, roundNo: 0, fixtureNo: 0, status }), fx({ id: "ready", roundNo: 3, fixtureNo: 9 })];
      expect(nextPlayable(list)!.id, status).toBe("ready");
      expect(nextPlayable(list.filter((f) => f.id !== "ready")), status).toBeNull();
      checked++;
    }
    expect(checked).toBe(NOT_PLAYABLE.length);
    expect(checked).toBeGreaterThan(0);
  });
});

// ── one count, one "finished": pure (plan 4 Task 2, D4; spec 2026-11-12-quick-match-cancel-and-skip-design.md §3, §6) ──

/** A real match's row as the count reads it (`MatchLineRow`): both seats known, no outcome yet, the given status. */
const line = (status: FixtureStatusValue, o: Partial<MatchLineRow> = {}): MatchLineRow => ({
  status,
  outcome: null,
  home_entrant_id: "e-1",
  away_entrant_id: "e-2",
  home_slot_label: null,
  away_slot_label: null,
  ext_key: null,
  ...o,
});
/** A bye as a knockout's draw writes one (stages/bracket-seats.ts): one seat empty, `forfeited` by an award to the other. */
const byeLine = (): MatchLineRow => line("forfeited", { away_entrant_id: null, outcome: { kind: "award", winner: "e-1" } });

describe("playedOf / isQuickMatchFinished: a Not played match counts as done, and M stays the full total (§6)", () => {
  it("premise: the bye row is a bye and the plain rows are matches (the shared predicate), else the bye cases are vacuous", () => {
    expect(isBye(byeLine())).toBe(true);
    let matches = 0;
    for (const status of FIXTURE_STATUSES) {
      expect(isBye(line(status)), status).toBe(false);
      matches++;
    }
    expect(matches).toBe(FIXTURE_STATUSES.length);
  });

  it("a table of cases, the empty case first: the counts and whether the quick match is finished", () => {
    // Every expected number is counted by hand from the case's own rows: a match is a non-bye row; played is a settled one
    // (decided, forfeited, abandoned); not played is a `cancelled` one; the total is every match, played or not (§6).
    type Want = { played: number; notPlayed: number; total: number };
    const cases: [why: string, rows: MatchLineRow[], want: Want, finished: boolean][] = [
      ["the empty case first: no match at all is not finished", [], { played: 0, notPlayed: 0, total: 0 }, false],
      ["one played, one not played, one to play: not finished",
        [line("decided"), line("cancelled"), line("scheduled")], { played: 1, notPlayed: 1, total: 3 }, false],
      ["one played, one not played: finished (a skip is done, and the total keeps it)",
        [line("decided"), line("cancelled")], { played: 1, notPlayed: 1, total: 2 }, true],
      ["every match not played: finished with nothing played (the no-play case)",
        [line("cancelled"), line("cancelled")], { played: 0, notPlayed: 2, total: 2 }, true],
      ["every match played: finished, as before any skip existed",
        [line("decided"), line("decided")], { played: 2, notPlayed: 0, total: 2 }, true],
      ["a walkover and an abandonment are played; a held level result is neither played nor not played",
        [line("forfeited"), line("abandoned"), line("needs_decision")], { played: 2, notPlayed: 0, total: 3 }, false],
      ["a match back in play (Edit result reopened it) beside a not played one: not finished",
        [line("in_play"), line("cancelled")], { played: 0, notPlayed: 1, total: 2 }, false],
      ["a bye is no match: in none of the three counts", [byeLine(), line("decided")], { played: 1, notPlayed: 0, total: 1 }, true],
      ["a bye beside the one match, not played: finished with nothing played",
        [byeLine(), line("cancelled")], { played: 0, notPlayed: 1, total: 1 }, true],
    ];
    let checked = 0;
    for (const [why, rows, want, finished] of cases) {
      expect(playedOf(rows), why).toEqual(want);
      expect(isQuickMatchFinished(playedOf(rows)), why).toBe(finished);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBe(9);
    // The table can witness the regression it exists for: a case where finished differs from "every match played".
    expect(cases.filter(([, , w, f]) => f && w.played < w.total).length).toBeGreaterThan(0);
  });

  it("finished is derived, never kept: Add a match un-finishes a league finished by skips, and so does Edit result (Review Focus 3, 5)", () => {
    const done = [line("decided"), line("cancelled")];
    expect(isQuickMatchFinished(playedOf(done)), "premise: finished by a skip").toBe(true);
    // Add a match: one new scheduled fixture.
    const added = [...done, line("scheduled")];
    expect(playedOf(added)).toEqual({ played: 1, notPlayed: 1, total: 3 });
    expect(isQuickMatchFinished(playedOf(added))).toBe(false);
    // ... and played to its result: finished again.
    expect(isQuickMatchFinished(playedOf([...done, line("decided")]))).toBe(true);
    // Edit result: the played match's deciding event voided, back in play.
    expect(isQuickMatchFinished(playedOf([line("in_play"), line("cancelled")]))).toBe(false);
  });

  it("the predicate alone, on counts handed to it: at least one match, and every one played or not played", () => {
    const cases: [{ played: number; notPlayed: number; total: number }, boolean][] = [
      [{ played: 0, notPlayed: 0, total: 0 }, false],
      [{ played: 1, notPlayed: 0, total: 1 }, true],
      [{ played: 0, notPlayed: 1, total: 1 }, true],
      [{ played: 1, notPlayed: 2, total: 3 }, true],
      [{ played: 1, notPlayed: 1, total: 3 }, false],
      [{ played: 2, notPlayed: 0, total: 3 }, false],
    ];
    let checked = 0;
    for (const [c, want] of cases) {
      expect(isQuickMatchFinished(c), JSON.stringify(c)).toBe(want);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("phaseOf: every fixture status's phase for a guest", () => {
  it("cancelled is Not played whatever its seats; every other status keeps its phase (C11, C18, C23)", () => {
    // [both sides known, a side still unknown], typed here from the rules the phase doc states: settled (decided,
    // forfeited, abandoned), live (in play), ready (scheduled with both sides known), waiting (anything else: a side still
    // unknown, a held result no guest can settle, a finalized match no guest path writes), and Not played (the skip).
    const RULEBOOK = {
      scheduled: ["ready", "waiting"],
      in_play: ["live", "live"],
      decided: ["settled", "settled"],
      finalized: ["waiting", "waiting"],
      abandoned: ["settled", "settled"],
      forfeited: ["settled", "settled"],
      cancelled: ["notPlayed", "notPlayed"],
      needs_decision: ["waiting", "waiting"],
    } satisfies Record<FixtureStatusValue, [QuickMatchPhase, QuickMatchPhase]>;
    const side = { entrantId: "e-1", name: "One" };
    let checked = 0;
    for (const status of FIXTURE_STATUSES) {
      const [known, unknown] = RULEBOOK[status];
      expect(phaseOf({ status, home: side, away: { ...side, entrantId: "e-2" } }), status).toBe(known);
      expect(phaseOf({ status, home: null, away: side }), `${status}, a side unknown`).toBe(unknown);
      checked++;
    }
    expect(checked).toBe(8);
    expect(Object.keys(RULEBOOK).sort()).toEqual([...FIXTURE_STATUSES].sort());
  });
});

// ── the row ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("toRow: a stored locale", () => {
  // V515's check constraint keeps an unknown locale out of the column (T1's quick-match-email.test.ts proves it), so no DB
  // row can carry one: the read's fallback is proven here, on the mapper itself, as defence in depth.
  const dbRow = (locale: string): QuickMatchDbRow => ({
    id: "qm-1", competition_id: "c-1", name: "n", format: "league", email: null, locale,
    last_activity_at: new Date(0), expires_at: null, saved_by_user_id: null, token_enc: new Uint8Array(),
  });
  it("one the app does not speak reads as the default; each one it speaks reads as itself", () => {
    expect(toRow(dbRow("xx")).locale).toBe(DEFAULT_LOCALE);
    expect(toRow(dbRow("")).locale).toBe(DEFAULT_LOCALE);
    let kept = 0;
    for (const locale of LOCALES) {
      expect(toRow(dbRow(locale)).locale).toBe(locale);
      kept++;
    }
    expect(kept).toBe(4);   // en, fr, es, nl: the four dictionaries
    expect(LOCALES.filter((l) => l !== DEFAULT_LOCALE).length, "a positive case that differs from the default").toBeGreaterThan(0);
  });
});

// ── resolve and find ────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("resolveQuickMatchToken / findQuickMatchByCompetition", () => {
  it("resolves a live token, twice, and refuses its hash, a foreign prefix, a malformed or unknown token, and an expired one", async () => {
    const input = league4({ locale: "fr" });
    const a = await create(input);
    const first = await resolveQuickMatchToken(a.token);
    expect(first).toMatchObject({
      id: a.id, competitionId: a.competitionId, name: input.name, format: "league", email: null, locale: "fr", savedByUserId: null,
    });
    expect(first!.expiresAt!.getTime()).toBe(a.expiresAt.getTime());
    expect(first!.lastActivityAt).toBeInstanceOf(Date);
    expect(openHomeToken(first!.tokenEnc)).toBe(a.token);   // C19: the row carries the envelope the page link is rebuilt from
    expect((await resolveQuickMatchToken(a.token))!.id).toBe(a.id);   // a second resolve: reading never spends the token

    expect(await resolveQuickMatchToken(hashHomeToken(a.token))).toBeNull();   // the stored hash is not the credential
    expect(await resolveQuickMatchToken("dl_" + a.token.slice(3))).toBeNull();   // a device-link-shaped token
    expect(await resolveQuickMatchToken("")).toBeNull();
    expect(await resolveQuickMatchToken(a.token.slice(0, -1))).toBeNull();   // one character short
    expect(await resolveQuickMatchToken(`${a.token} `)).toBeNull();
    expect(await resolveQuickMatchToken(mintHomeToken())).toBeNull();   // well shaped, never issued

    await sql`update quick_matches set expires_at = now() - interval '1 second' where id = ${a.id}`;   // the sweep has not run yet
    expect(await resolveQuickMatchToken(a.token)).toBeNull();
  });

  it("checks the shape before the lookup: a stored hash of a malformed token never resolves", async () => {
    const a = await create();
    const malformed = `qm_${randomUUID()}`;   // the prefix, but a 36-character body: not a home token
    await sql`update quick_matches set token_hash = ${hashHomeToken(malformed)} where id = ${a.id}`;
    expect(await resolveQuickMatchToken(malformed)).toBeNull();
  });

  it("a saved row with no expiry resolves (B7a)", async () => {
    const a = await create();
    await save(a.id);
    const row = await resolveQuickMatchToken(a.token);
    expect(row!.id).toBe(a.id);
    expect(row!.expiresAt).toBeNull();
    expect(row!.savedByUserId).not.toBeNull();
  });

  it("finds a quick match by its competition, expired or not, and nothing for another competition (T9's back link)", async () => {
    const a = await create();
    const found = await findQuickMatchByCompetition(a.competitionId);
    expect(found!.id).toBe(a.id);
    expect(openHomeToken(found!.tokenEnc)).toBe(a.token);
    expect(await findQuickMatchByCompetition(randomUUID())).toBeNull();
    // The row stands until the sweep deletes it, and a score re-arms it (D5): the pad still finds its way back.
    await sql`update quick_matches set expires_at = now() - interval '1 second' where id = ${a.id}`;
    expect((await findQuickMatchByCompetition(a.competitionId))!.id).toBe(a.id);
  });

  it("answers null for a token whose competition was hard-deleted, and a stale row reads no home (Review Focus 3)", async () => {
    const a = await create();
    const stale = await rowOf(a);
    await hardDeleteQuickMatchCompetition(a.competitionId);
    expect(await resolveQuickMatchToken(a.token)).toBeNull();
    expect(await findQuickMatchByCompetition(a.competitionId)).toBeNull();
    expect(await readQuickMatchHome(stale)).toBeNull();
  });
});

// ── the activity clock ──────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("touchQuickMatchActivity / touchQuickMatchActivityForFixture (C1, B7b, D5)", () => {
  it("a touch on an unsaved row moves its activity and re-arms its expiry 7 days out, and no other row moves", async () => {
    const a = await create();
    const bystander = await create();
    const before = await activityOf(bystander.id);
    const at = new Date(Date.now() + 3 * DAY_MS);
    await touchQuickMatchActivity(a.id, at);
    expect(await activityOf(a.id)).toEqual({ last: at.getTime(), expires: at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS });
    expect(await activityOf(bystander.id)).toEqual(before);
  });

  it("a touch on a saved row moves its activity and leaves its expiry null", async () => {
    const a = await create();
    await save(a.id);
    const at = new Date(Date.now() + 2 * DAY_MS);
    await touchQuickMatchActivity(a.id, at);
    expect(await activityOf(a.id)).toEqual({ last: at.getTime(), expires: null });
  });

  it("through a fixture: touches the quick match holding it (re-armed, or still saved), and nothing for any other fixture", async () => {
    const a = await create();
    const saved = await create();
    await save(saved.id);
    const bystander = await create();
    const before = await activityOf(bystander.id);
    const [fa] = await listDivisionFixtures(systemAuth(), a.divisionId);
    const [fs] = await listDivisionFixtures(systemAuth(), saved.divisionId);
    const at = new Date(Date.now() + 4 * DAY_MS);

    await touchQuickMatchActivityForFixture(fa!.id, at);
    await touchQuickMatchActivityForFixture(fs!.id, at);
    await touchQuickMatchActivityForFixture(randomUUID(), at);   // a fixture in no quick match: nothing moves, nothing throws

    expect(await activityOf(a.id)).toEqual({ last: at.getTime(), expires: at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS });
    expect(await activityOf(saved.id)).toEqual({ last: at.getTime(), expires: null });
    expect(await activityOf(bystander.id)).toEqual(before);
  });
});

// ── the home ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("readQuickMatchHome", () => {
  it("reads a fresh league: 0 of 6 played, match 1 next, nothing live, a table of 4", async () => {
    const input = league4();
    const a = await create(input);
    const h = await homeOf(a);
    expect(h.row.id).toBe(a.id);
    expect(h.divisionId).toBe(a.divisionId);
    expect(h.stageId).toBe(a.stageId);
    expect(h.total).toBe(6);   // round robin of 4: 4·3/2
    expect(h.total).toBe(a.matchCount);   // C17: the number the Start button showed
    expect(h.played).toBe(0);
    expect(h.finished).toBe(false);
    expect(h.fixtures.filter((f) => f.phase === "live")).toEqual([]);
    expect(h.next!.roundNo).toBe(1);
    expect(h.next!.fixtureNo).toBe(1);
    expect(h.fixtures).toHaveLength(6);
    expect(h.fixtures.filter((f) => f.isBye || f.isFinal || f.summary !== null || f.winnerEntrantId !== null)).toEqual([]);
    const order = h.fixtures.map((f) => [f.roundNo, f.fixtureNo]);
    expect(order).toEqual([...order].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!));
    // C20: the sides in the order entered, and every pair meets exactly once.
    expect(h.sides.map((s) => s.name)).toEqual(input.sides);
    const pairs = new Set(h.fixtures.map((f) => [f.home!.name, f.away!.name].sort().join(" v ")));
    expect(pairs.size).toBe(6);
    expect(h.standings!.stage_id).toBe(a.stageId);
    expect(tableOf(h).map((r) => r.entrantId).sort()).toEqual(h.sides.map((s) => s.entrantId).sort());
    expect(h.kind).toBe("pair");
    expect(h.sport).toEqual({ key: "badminton", labelKey: "sport.badminton" });
    expect(Object.hasOwn(messages, h.sport.labelKey)).toBe(true);
    // Plan 5 T5, a plain League unchanged: one stage, no knockout, and the league's counts are the match's own.
    expect(h.knockoutStageId).toBeNull();
    expect(h.knockout).toBeNull();
    expect(h.champion).toBeNull();
    expect(h.league).toEqual({ played: 0, notPlayed: 0, total: 6, done: false });
    expect(h.fixtures.map((f) => [f.stage, f.knockoutSeats])).toEqual(h.fixtures.map(() => ["league", null]));
  });

  it("never returns another quick match's division, fixtures or sides (isolation, §7.1 point 3)", async () => {
    const a = await create();
    const b = await create();
    const ha = await homeOf(a);
    expect(ha.divisionId).toBe(a.divisionId);   // B7c: a dropped division predicate answers some other division
    expect(ha.stageId).toBe(a.stageId);
    const aFixtures = await listDivisionFixtures(systemAuth(), a.divisionId);
    const bFixtures = await listDivisionFixtures(systemAuth(), b.divisionId);
    expect(bFixtures.length).toBeGreaterThan(0);
    expect(ha.fixtures.map((f) => f.id).sort()).toEqual(aFixtures.map((f) => f.id).sort());
    expect(ha.fixtures.some((f) => bFixtures.some((x) => x.id === f.id))).toBe(false);
    const hb = await homeOf(b);
    const bSides = new Set(hb.sides.map((s) => s.entrantId));
    expect(ha.sides.some((s) => bSides.has(s.entrantId))).toBe(false);
  });

  it("refuses to name a seat outside the quick match's own sides (a tampered fixture)", async () => {
    const a = await create();
    const b = await create();
    try {
      const [fa] = await listDivisionFixtures(systemAuth(), a.divisionId);
      const hb = await homeOf(b);
      await sql`update fixtures set home_entrant_id = ${hb.sides[0]!.entrantId} where id = ${fa!.id}`;
      await expect(readQuickMatchHome(await rowOf(a))).rejects.toThrow(/outside its own sides/);
    } finally {
      await hardDeleteQuickMatchCompetition(a.competitionId);   // the corrupt match never outlives its case
    }
  });

  it("a quick match with no fixture left reads nothing played, nothing next, and NOT all played (the empty case)", async () => {
    const a = await create();
    try {
      await sql`delete from fixtures where division_id = ${a.divisionId}`;   // a state no producer makes: the guard's own case
      const h = await homeOf(a);
      expect(h.fixtures).toEqual([]);
      expect(h.total).toBe(0);
      expect(h.played).toBe(0);
      expect(h.finished).toBe(false);   // zero of zero is not a finished match: no winner card
      expect(h.next).toBeNull();
      expect(h.fixtures.filter((f) => f.phase === "live")).toEqual([]);
      expect(h.sides).toHaveLength(SIDES.length);
    } finally {
      await hardDeleteQuickMatchCompetition(a.competitionId);
    }
  });

  it("refuses a competition holding two divisions, a division holding two stages, or sides of two kinds (one each, §7.1, D2)", async () => {
    const corrupt: CreatedQuickMatch[] = [];
    try {
      const twoDivisions = await create();
      corrupt.push(twoDivisions);
      await sql`
        insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
        select competition_id, org_id, name, slug || '-twin', sport_key, variant_key, config, module_version
        from divisions where id = ${twoDivisions.divisionId}`;
      await expect(readQuickMatchHome(await rowOf(twoDivisions))).rejects.toThrow(/2 divisions/);

      const twoStages = await create();
      corrupt.push(twoStages);
      await sql`
        insert into stages (division_id, org_id, seq, kind, name)
        select division_id, org_id, seq + 1, kind, name from stages where id = ${twoStages.stageId}`;
      await expect(readQuickMatchHome(await rowOf(twoStages))).rejects.toThrow(/2 stages/);

      const twoKinds = await create();
      corrupt.push(twoKinds);
      const [first] = (await homeOf(twoKinds)).sides;
      await sql`update entrants set kind = 'team' where id = ${first!.entrantId}`;
      await expect(readQuickMatchHome(await rowOf(twoKinds))).rejects.toThrow(/2 entrant kinds/);
    } finally {
      for (const m of corrupt) await hardDeleteQuickMatchCompetition(m.competitionId);   // no corrupt match outlives its case
    }
  });

  it("refuses a stage that is neither a league nor a knockout: the moved-on read assumes no Swiss round to pair (review m3)", async () => {
    const a = await create();
    try {
      expect((await homeOf(a)).fixtures.length, "the positive pair: the same match reads as a league").toBeGreaterThan(0);
      await sql`update stages set kind = 'swiss' where id = ${a.stageId}`;   // a state no producer makes: the guard's own case
      await expect(readQuickMatchHome(await rowOf(a))).rejects.toThrow(/is a swiss stage, not a league or a knockout/);
    } finally {
      await hardDeleteQuickMatchCompetition(a.competitionId);
    }
  });

  it("refuses a settled fixture whose feed names a match outside its own division (review m4)", async () => {
    // A knockout of 3: its bye is settled at the draw, so the moved-on read follows the bye's feed into the final.
    const a = await create(league4({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const b = await create(league4({ format: "knockout", sides: SIDES.slice(0, 3) }));
    try {
      const bye = (await homeOf(a)).fixtures.find((f) => f.isBye);
      expect(bye, "premise: a knockout of 3 draws one bye").toBeDefined();
      const [fed] = await sql<{ winner_to_fixture: string | null }[]>`select winner_to_fixture from fixtures where id = ${bye!.id}`;
      expect(fed!.winner_to_fixture, "premise: the bye feeds this match's own final").not.toBeNull();
      const foreign = (await homeOf(b)).fixtures.find((f) => f.isFinal)!;
      await sql`update fixtures set winner_to_fixture = ${foreign.id} where id = ${bye!.id}`;
      await expect(readQuickMatchHome(await rowOf(a))).rejects.toThrow(/feeds .* outside its own division/);
    } finally {
      await hardDeleteQuickMatchCompetition(a.competitionId);
      await hardDeleteQuickMatchCompetition(b.competitionId);
    }
  });

  it("a match in play is live and next, even past a lower-numbered one; only its own summary is read", async () => {
    const a = await create();
    let h = await homeOf(a);
    const last = h.fixtures.at(-1)!;
    expect(last.fixtureNo).toBeGreaterThan(h.next!.fixtureNo);   // precondition: it is not already next
    for (const req of await firstRallyFor(last.id)) await scoreEvent(systemAuth(), last.id, req);
    h = await homeOf(a);
    expect(h.fixtures.filter((f) => f.phase === "live").map((f) => f.id)).toEqual([last.id]);
    expect(h.next!.id).toBe(last.id);
    const [stored] = await sql<{ summary: unknown }[]>`select summary from match_states where fixture_id = ${last.id}`;
    expect(stored).toBeDefined();
    expect(h.fixtures.find((f) => f.id === last.id)!.summary).toEqual(stored!.summary);
    expect(h.fixtures.filter((f) => f.id !== last.id && f.summary !== null)).toEqual([]);
    expect(h.played).toBe(0);
  });

  it("a void of the deciding event takes the match back: played, the winner and the table follow it (the sequence)", async () => {
    const a = await create();
    let h = await homeOf(a);
    const first = h.next!;
    const r = await playToDecided(systemAuth(), first.id);
    if (r.kind !== "decided") throw new Error(`precondition: ${JSON.stringify(r)}`);

    h = await homeOf(a);
    expect(h.played).toBe(1);
    expect(h.finished).toBe(false);
    const decided = h.fixtures.find((f) => f.id === first.id)!;
    expect(sideIds(first)).toContain(decided.winnerEntrantId);
    expect(h.next!.id).not.toBe(first.id);
    expect(tableOf(h).reduce((n, row) => n + row.played, 0)).toBe(2);   // one match, two sides played it
    expect(tableOf(h).find((row) => row.entrantId === decided.winnerEntrantId)!.won).toBe(1);

    // core.void of the last event, expected_seq = the tip (carried-forward-scoring.test.ts); a settled fixture still takes it.
    await scoreEvent(systemAuth(), first.id, { expected_seq: r.lastSeq, type: "core.void", payload: { event_id: r.lastEventId } });
    h = await homeOf(a);
    expect(h.played).toBe(0);
    const undone = h.fixtures.find((f) => f.id === first.id)!;
    expect(undone.winnerEntrantId).toBeNull();
    // started and undecided again: in play
    expect(h.fixtures.filter((f) => f.phase === "live").map((f) => f.id)).toEqual([first.id]);
    expect(h.next!.id).toBe(first.id);
    expect(tableOf(h).reduce((n, row) => n + row.played, 0)).toBe(0);
  });

  it("a Not played match counts as done: 1 played and 1 not played of 3 is open, the last not played finishes it; the strip and the account list read the same count (plan 4 T2)", async () => {
    // One sport (badminton): the count reads fixture statuses, never a sport's scoring; the skip's sport sweep is Task 3's.
    const visitorHash = v();
    const out = await createQuickMatchAnyFormat(league4({ sides: SIDES.slice(0, 3) }), { visitorHash });
    try {
      let h = await homeOf(out);
      const matches = h.fixtures.filter((f) => !f.isBye);
      expect(matches).toHaveLength(3);   // round robin of 3: 3·2/2
      const [m1, m2, m3] = matches as [QuickMatchFixture, QuickMatchFixture, QuickMatchFixture];
      expect(await playToDecided(systemAuth(), m1.id)).toMatchObject({ kind: "decided" });
      await markNotPlayed(out, m2.id);

      h = await homeOf(out);
      expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished })
        .toEqual({ played: 1, notPlayed: 1, total: 3, finished: false });
      expect(h.fixtures.find((f) => f.id === m2.id)!.phase).toBe("notPlayed");
      expect(h.next!.id).toBe(m3.id);   // a Not played match is never next

      // Every count consumer reads the one `playedOf`: the setup page's Continue card (the recent strip's read) and the
      // account list. An open match first, then the finished one below.
      const recent = async () => (await listRecentQuickMatches(visitorHash, { counts: true })).find((r) => r.token === out.token);
      expect(await recent()).toMatchObject({ played: 1, notPlayed: 1, total: 3 });

      await markNotPlayed(out, m3.id);
      h = await homeOf(out);
      expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished })
        .toEqual({ played: 1, notPlayed: 2, total: 3, finished: true });
      expect(h.next).toBeNull();
      expect(h.fixtures.filter((f) => !f.isBye).map((f) => [f.id, f.phase])).toEqual([
        [m1.id, "settled"],
        [m2.id, "notPlayed"],
        [m3.id, "notPlayed"],
      ]);
      expect(await recent()).toMatchObject({ played: 1, notPlayed: 2, total: 3 });

      await save(out.id);
      const [saver] = await sql<{ saved_by_user_id: string }[]>`select saved_by_user_id from quick_matches where id = ${out.id}`;
      const mine = await listMyQuickMatches(saver!.saved_by_user_id, { links: false });
      expect(mine.find((m) => m.id === out.id)).toMatchObject({ played: 1, notPlayed: 2, total: 3 });
    } finally {
      await hardDeleteQuickMatchCompetition(out.competitionId);
    }
  });

  it("knockout of 3: the bye is marked and not counted, the final waits, follows its semi-final, then all is played (C10)", async () => {
    const input = league4({ format: "knockout", sides: SIDES.slice(0, 3) });
    const k = await create(input);
    let h = await homeOf(k);
    const byes = h.fixtures.filter((f) => f.isBye);
    expect(byes).toHaveLength(1);
    expect([byes[0]!.home?.name, byes[0]!.away?.name]).toContain(input.sides[0]);   // §7.3: with 3 sides seed 1 sits out
    expect(h.total).toBe(2);   // the semi-final and the final; the bye is not a match
    expect(h.total).toBe(k.matchCount);
    expect(h.played).toBe(0);   // the bye is settled (forfeited) but is not a match played
    expect(h.standings).toBeNull();   // a bracket has no table (§7.10): plan 2 draws it instead
    // Plan 5 T5, a plain Knockout unchanged: no league, no League + Knockout block, its seats read from its own labels.
    expect(h.league).toBeNull();
    expect(h.knockout).toBeNull();
    expect(h.knockoutStageId).toBeNull();
    expect(h.champion).toBeNull();
    expect(h.fixtures.map((f) => [f.stage, f.knockoutSeats])).toEqual(h.fixtures.map(() => ["knockout", null]));
    const finals = h.fixtures.filter((f) => f.isFinal);
    expect(finals).toHaveLength(1);
    const final = finals[0]!;
    expect(final.roundNo).toBe(2);
    expect(h.next!.isFinal).toBe(false);   // the final has an unknown side: not next
    const semi = h.next!;
    expect(semi.isBye).toBe(false);

    expect(await playToDecided(systemAuth(), semi.id)).toMatchObject({ kind: "decided" });
    h = await homeOf(k);
    expect(h.played).toBe(1);
    expect(h.finished).toBe(false);
    const semiWinner = h.fixtures.find((f) => f.id === semi.id)!.winnerEntrantId;
    expect(sideIds(semi)).toContain(semiWinner);
    expect(h.next!.id).toBe(final.id);   // both sides of the final are now known
    expect(sideIds(h.next!)).toContain(semiWinner);

    expect(await playToDecided(systemAuth(), final.id)).toMatchObject({ kind: "decided" });
    h = await homeOf(k);
    expect(h.played).toBe(2);
    expect(h.finished).toBe(true);
    expect(h.next).toBeNull();
    expect(h.fixtures.filter((f) => f.phase === "live")).toEqual([]);
    const done = h.fixtures.find((f) => f.id === final.id)!;
    expect(sideIds(done)).toContain(done.winnerEntrantId);
    // The champion is the final's winner (plan 5 D8), read off the stored outcome.
    const [stored] = await sql<{ winner: string }[]>`select outcome->>'winner' as winner from fixtures where id = ${final.id}`;
    expect(h.champion).toEqual({ entrantId: stored!.winner, finalFixtureId: final.id });
  });

  it("knockout of 5: each fixture carries its seq in round, so every waiting seat's label names exactly one feeder (D12)", async () => {
    // Five sides: an 8-draw, three first-round byes, one real quarter-final, two semi-finals and the final (n - 1 = 4
    // matches, §7.3). The expected seqs are the generator's own rows, read straight from `fixtures`, never from the read.
    const k = await create(league4({ format: "knockout", sides: ["S1", "S2", "S3", "S4", "S5"] }));
    try {
      const h = await homeOf(k);
      const stored = await sql<{ id: string; seq_in_round: number }[]>`
        select id, seq_in_round from fixtures where division_id = ${k.divisionId}`;
      expect(stored).toHaveLength(h.fixtures.length);
      expect(h.fixtures.filter((f) => !f.isBye)).toHaveLength(4);   // the rulebook: a knockout of n is n - 1 matches
      for (const f of h.fixtures) {
        expect(f.seqInRound, `fixture ${f.id}`).toBe(stored.find((s) => s.id === f.id)!.seq_in_round);
      }
      // Within a round the seqs are 1..k, each once: a (round, seq) pair names one fixture.
      for (const round of new Set(h.fixtures.map((f) => f.roundNo))) {
        const seqs = h.fixtures.filter((f) => f.roundNo === round).map((f) => f.seqInRound).sort((a, b) => a - b);
        expect(seqs, `round ${round}`).toEqual(seqs.map((_, i) => i + 1));
      }
      // Every unknown seat's label is a winner feed whose {round, seq} resolves to exactly one fixture of an earlier round.
      let resolved = 0;
      for (const f of h.fixtures) {
        if (f.isBye) continue;   // a bye's empty seat carries no feeder
        for (const [side, label] of [[f.home, f.homeSlotLabel], [f.away, f.awaySlotLabel]] as const) {
          if (side !== null) continue;
          const { key, params } = label as { key: string; params: { round: number; seq: number } };
          expect(key).toBe("slot.winner_match");
          const feeders = h.fixtures.filter((x) => x.roundNo === Number(params.round) && x.seqInRound === Number(params.seq));
          expect(feeders, `${f.id}: ${JSON.stringify(label)}`).toHaveLength(1);
          expect(feeders[0]!.roundNo).toBeLessThan(f.roundNo);
          resolved++;
        }
      }
      // The quarter-final's winner (one semi-final seat) and both seats of the final: three seats wait on a feeder.
      expect(resolved).toBe(3);
      // Each fixture's phase, by C11/C18 on a draw nothing has been played in: a bye is settled (its walkover), a match
      // with both sides known is ready, one with a side still unknown waits. The list's Score and the hero's next agree.
      let phased = 0;
      for (const f of h.fixtures) {
        const expected = f.isBye ? "settled" : f.home !== null && f.away !== null ? "ready" : "waiting";
        expect(f.phase, `fixture ${f.roundNo}.${f.seqInRound}`).toBe(expected);
        phased++;
      }
      expect(phased).toBe(stored.length);
      expect(h.fixtures.filter((f) => f.phase === "waiting")).toHaveLength(2);   // the semi-final with a feeder, the final
      expect(h.fixtures.find((f) => f.phase === "ready" && f.id === h.next!.id)).toBeDefined();
    } finally {
      await hardDeleteQuickMatchCompetition(k.competitionId);
    }
  });

  it("reads every offered sport's home with that sport's own keys and kind (sweep)", async () => {
    const offered = new Map((await listQuickMatchSports()).map((s) => [s.sport_key, s]));
    let checked = 0;
    const visited = await forEachSportAsync(async ({ key }) => {
      const sport = offered.get(key);
      if (!sport) return;   // not offered (generic, the lineup sport): no quick match of it can exist to read
      const variant = sport.variants[0]!;
      const kind = sport.kinds.at(-1)!;   // the last kind: pairs for badminton, a team for football, one player for chess
      const input = league4({ sport_key: key, variant_key: variant.variant_key, kind, sides: ["Side A", "Side B"] });
      const out = await create(input);
      const h = await homeOf(out);
      // The setup screen's own names for this sport and variant (C1: keys, never English names), and the kind chosen.
      expect(h.sport).toEqual({ key, labelKey: sport.labelKey });
      expect(h.kind).toBe(kind);
      // The kind is named only where the guest chose it: the setup screen shows its kind switch for >1 kind (h1).
      expect(h.kindChosen, key).toBe(sport.kinds.length > 1);
      // The table's points unit: FIDE's half-points for chess (win 1, draw ½), whole points for every other sport.
      expect(h.pointsUnit, key).toBe(key === "boardgame" ? "half" : "whole");
      expect(h.total).toBe(quickMatchPreview({ format: "league", sides: 2, plays: 1 }).matchCount);
      expect(h.total).toBe(1);
      expect(h.next!.id).toBe(h.fixtures[0]!.id);
      expect([h.next!.home!.name, h.next!.away!.name].sort()).toEqual(["Side A", "Side B"]);
      expect(tableOf(h)).toHaveLength(2);
      // The Full table's ingredients (owner 2026-11-12): the sport's own standings metrics, as the engine declares them, and
      // the stage's table rules from the one loader (its tie-break order); the table built from them has more to show
      // than the short table's P, W and Pts, in every offered sport, and a cell for every row.
      expect(h.metricSpecs, key).toEqual(builtinModules.find((m) => m.key === key)!.metrics);
      expect(h.tableRules, key).not.toBeNull();
      expect(h.tableRules!.tiebreakers.length, key).toBeGreaterThan(0);
      const full = quickMatchFullTable(h, (k) => tRuntime(enPublic, k));
      const fullKeys = full!.columns.map((c) => c.key);
      expect(fullKeys, key).toEqual(expect.arrayContaining(["played", "won", "points"]));
      expect(fullKeys.filter((k) => !["played", "won", "drawn", "points"].includes(k)).length, `${key}: more than the short table`).toBeGreaterThan(0);
      expect(Object.keys(full!.cells).sort(), key).toEqual(tableOf(h).map((r) => r.entrantId).sort());
      for (const cells of Object.values(full!.cells)) expect(cells, key).toHaveLength(fullKeys.length);
      checked++;
      await hardDeleteQuickMatchCompetition(out.competitionId);
    });
    console.info(`quick match home sweep: ${checked} offered sports read of ${visited} sport modules`);
    expect(visited).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(0);   // zero checked is a failure
    expect(checked).toBe(offered.size);   // every offered sport, once
  }, SWEEP_TIMEOUT_MS);
});

// ── League + Knockout (quick match plan 5, Task 5) ──────────────────────────────────────────────────────────────────────
//
// One division, two stages (T3): the home reads them as one match. Every quick match is made by the guarded create, every
// result by the real write path (`playWin`: chess, so each winner is steered and counted), every skip by the home's own
// writer, every answer to a tie by the real usecase (`decideQuickMatchCut`). The expected values come from the results each
// case made, the rulebook (a round robin of n is n·(n−1)/2; a knockout of q is q − 1; semi-finals 1st v 4th and 2nd v 3rd,
// the final 1st v 2nd), and the engine's own stored rows (the stored table's ranks, `stage_lots_draws`, the generator's feed
// edges): never from the read under test. Single-sport cases are chess for the steering; the last case reads every offered
// sport.

interface Lk {
  out: CreatedQuickMatch;
  row: QuickMatchRow;
  /** Each side's entrant id by the name it was typed as. */
  id: Map<string, string>;
}
interface StageLine {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  is_final: boolean;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
}
let CHESS: { variant_key: string; kind: CreateQuickMatch["kind"] };
const lkMade: string[] = [];

async function lkMatch(sides: string[], qualifiers: 2 | 4, plays: 1 | 2 = 1): Promise<Lk> {
  const out = await create(
    league4({ sport_key: "boardgame", variant_key: CHESS.variant_key, kind: CHESS.kind, format: "league_knockout", qualifiers, sides, plays }),
  );
  lkMade.push(out.competitionId);
  expect(out.knockoutStageId, "premise: a League + Knockout is made with its knockout stage (T3)").not.toBeNull();
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${out.divisionId}`;
  return { out, row: await rowOf(out), id: new Map(entrants.map((e) => [e.display_name, e.id])) };
}
const stageLines = (stageId: string) => sql<StageLine[]>`
  select id, home_entrant_id, away_entrant_id, is_final, winner_to_fixture, winner_to_slot
  from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
/** `winner` beats `loser` on their `nth` league line (0-based). */
async function beat(m: Lk, winner: string, loser: string, nth = 0): Promise<string> {
  const key = pairKey(m.id.get(winner)!, m.id.get(loser)!);
  const line = (await stageLines(m.out.stageId)).filter((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!) === key)[nth];
  if (!line) throw new Error(`precondition: no league line ${nth} between ${winner} and ${loser}`);
  await playWin(line.id, m.id.get(winner)!);
  return line.id;
}
/** The stored league table's entrant ids, best first: the engine's ranks as `standings_snapshots` holds them. */
async function rankedIds(m: Lk): Promise<string[]> {
  const rows = (await getStandings(systemAuth(), m.out.stageId)).rows as { entrantId: string; rank?: number }[];
  return [...rows].sort((a, b) => a.rank! - b.rank!).map((r) => r.entrantId);
}
async function storedDecision(m: Lk): Promise<unknown> {
  const [r] = await sql<{ cut_decision: unknown }[]>`select cut_decision from quick_matches where id = ${m.row.id}`;
  return r!.cut_decision;
}
const koLines = (h: QuickMatchHome) => h.fixtures.filter((f) => f.stage === "knockout");
const finalOf = (h: QuickMatchHome) => koLines(h).find((f) => f.isFinal)!;
/** Every seat of the knockout as the read names it, `[fixtureId, side, seat]`; counted by the cases (anti-vacuity). */
const seatsOf = (h: QuickMatchHome) =>
  koLines(h).flatMap((f) => (["home", "away"] as const).map((side) => [f.id, side, f.knockoutSeats?.[side] ?? null] as const));
const rankSeats = (h: QuickMatchHome) =>
  seatsOf(h).flatMap(([id, side, seat]) => (seat?.from === "league" ? [{ id, side, rank: seat.rank, toDecide: seat.toDecide }] : []));
const sorted = (ids: readonly string[]) => [...ids].sort();
const advanceFailures = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([o]) => (o as { event?: string } | undefined)?.event === "quick_match_advance_failed");

describe.skipIf(!HAS_DB)("readQuickMatchHome: a League + Knockout (plan 5 T5)", () => {
  beforeAll(async () => {
    const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
    if (!chess) throw new Error("premise: chess is offered for quick matches (run `npm run sync:sports`)");
    CHESS = { variant_key: chess.variants[0]!.variant_key, kind: chess.kinds.at(-1)! };
  });
  afterEach(() => {
    readRetry.mockReset();
    scoreHook.mockReset();
    cutRead.mockReset();
  });
  afterAll(async () => {
    for (const id of lkMade) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  });

  it("(a) mid-league, Semi-finals: one home over two stages, the league's lines first; N of M counts both (D8), the league's own counts only its lines; every knockout seat names a league rank (1v4, 2v3) or its feeder", async () => {
    const m = await lkMatch(["W", "X", "Y", "Z"], 4);
    const league = await stageLines(m.out.stageId);
    const ko = await stageLines(m.out.knockoutStageId!);
    expect(league, "premise: a round robin of 4 is 4·3/2").toHaveLength(6);
    expect(ko, "premise: a knockout of 4 is two semi-finals and a final").toHaveLength(3);
    const played = await beat(m, "W", "X");

    const h = await homeOf(m.out);
    expect(h.stageId, "the league stage: the add form and the full table read it").toBe(m.out.stageId);
    expect(h.knockoutStageId).toBe(m.out.knockoutStageId);
    // Stage first, then round and number: the knockout's lines never interleave the league's.
    expect(h.fixtures.map((f) => f.stage)).toEqual([...league.map(() => "league"), ...ko.map(() => "knockout")]);
    expect(sorted(h.fixtures.filter((f) => f.stage === "league").map((f) => f.id))).toEqual(sorted(league.map((l) => l.id)));
    expect(sorted(koLines(h).map((f) => f.id))).toEqual(sorted(ko.map((l) => l.id)));
    expect({ played: h.played, notPlayed: h.notPlayed, total: h.total }).toEqual({ played: 1, notPlayed: 0, total: 6 + 3 });
    expect(h.total, "C17: the number the Start button showed").toBe(m.out.matchCount);
    expect(h.league).toEqual({ played: 1, notPlayed: 0, total: 6, done: false });
    expect(h.knockout).toMatchObject({ qualifiers: 4, state: "league", filled: false, started: false, tie: null, decision: null, byLot: [], picked: [] });
    expect(h.finished).toBe(false);
    expect(h.champion).toBeNull();
    expect(h.next?.stage).toBe("league");
    expect(h.next?.phase).toBe("ready");
    expect(koLines(h).map((f) => f.phase)).toEqual(ko.map(() => "waiting"));
    expect(h.fixtures.find((f) => f.id === played)!.resultMovedOn, "the league is open: its results can change").toBe(false);
    expect(h.fixtures.filter((f) => f.stage === "league" && f.knockoutSeats !== null)).toEqual([]);
    expect(h.standings!.stage_id, "the table is the league's").toBe(m.out.stageId);
    expect(h.standings!.rows).toHaveLength(4);

    // The seats: the semi-finals 1st v 4th and 2nd v 3rd (the rulebook), nobody to decide; each final seat fed by the semi
    // whose winner edge (the generator's own row) names that seat.
    const seats = seatsOf(h);
    expect(seats, "two seats per knockout line, every one named").toHaveLength(6);
    expect(seats.filter(([, , seat]) => seat === null)).toEqual([]);
    const semis = koLines(h).filter((f) => !f.isFinal);
    expect(semis.map((f) => [f.knockoutSeats!.home, f.knockoutSeats!.away].map((s) => (s.from === "league" ? s.rank : 0)).sort()).sort())
      .toEqual([[1, 4], [2, 3]]);
    expect(rankSeats(h).filter((s) => s.toDecide)).toEqual([]);
    const final = finalOf(h);
    const feeds = ko.filter((l) => l.winner_to_fixture === final.id);
    expect(feeds, "premise: both semi-finals feed the final").toHaveLength(2);
    expect(final.knockoutSeats).toEqual({
      home: { from: "winner", fixtureId: feeds.find((l) => l.winner_to_slot === 1)!.id },
      away: { from: "winner", fixtureId: feeds.find((l) => l.winner_to_slot === 2)!.id },
    });
  });

  it("(b) a two-way tie for 2nd (Twice, 3 sides, final): the question (no next, the seat to decide); a Pick whose advance fails is Setting up WITH the answer; the next load fills the final from it", async () => {
    const m = await lkMatch(["P", "Q", "R"], 2, 2);
    const [p, q, r] = ["P", "Q", "R"].map((n) => m.id.get(n)!) as [string, string, string];
    for (const nth of [0, 1]) {
      await beat(m, "P", "Q", nth);
      await beat(m, "P", "R", nth);
    }
    await beat(m, "Q", "R", 0);
    await beat(m, "R", "Q", 1);
    const table = await rankedIds(m);
    expect(table[0], "premise: four wins of four lead").toBe(p);
    const third = table[2]!;

    const asked = await homeOf(m.out);
    expect(asked.league).toEqual({ played: 6, notPlayed: 0, total: 6, done: true });
    expect({ played: asked.played, total: asked.total, finished: asked.finished }).toEqual({ played: 6, total: 7, finished: false });
    expect(asked.knockout).toMatchObject({ qualifiers: 2, state: "tie", filled: false, decision: null, byLot: [], picked: [] });
    expect(asked.knockout!.tie).toMatchObject({ entrantIds: sorted([q, r]), seats: 1, place: 2, straddles: true, byLot: true });
    expect(asked.next, "the league is done and the final is not filled: nothing to play").toBeNull();
    expect(rankSeats(asked).map((s) => [s.rank, s.toDecide]).sort()).toEqual([[1, false], [2, true]]);
    const again = await homeOf(m.out);
    expect({ knockout: again.knockout, next: again.next }, "a second load asks the same").toEqual({ knockout: asked.knockout, next: null });

    expect(await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [third] })).toEqual({ through: [third] });
    const failure = new Error("the advance failed on this load");
    readRetry.mockRejectedValueOnce(failure);
    const errors = vi.spyOn(log, "error");
    let settling: QuickMatchHome;
    try {
      settling = await homeOf(m.out);
      expect(advanceFailures(errors), "logged once, as the advance's own event").toHaveLength(1);
      // Exactly these fields: the error itself, the event name, the quick match by id (never its token), and a message.
      expect(advanceFailures(errors)[0]).toStrictEqual([
        { err: failure, event: "quick_match_advance_failed", quickMatch: m.row.id },
        expect.stringMatching(/advance failed on load/),
      ]);
    } finally {
      errors.mockRestore();
    }
    expect(settling.knockout).toMatchObject({ state: "settingUp", filled: false, tie: null, byLot: [], picked: [third] });
    expect(settling.knockout!.decision).toMatchObject({ how: "pick", through: [third], tie: sorted([q, r]) });
    expect(settling.next).toBeNull();

    const filled = await homeOf(m.out);
    expect(filled.knockout).toMatchObject({ state: "filled", filled: true, started: false, tie: null, byLot: [], picked: [third] });
    expect(filled.next?.id, "the final is next").toBe(finalOf(filled).id);
    const seated = Object.fromEntries(rankSeats(filled).map((s) => [s.rank, finalOf(filled)[s.side]?.entrantId]));
    expect(seated, "1st and the side the guests picked, in the 2nd seat").toEqual({ 1: p, 2: third });
    expect(rankSeats(filled).filter((s) => s.toDecide)).toEqual([]);
    expect(filled.fixtures.filter((f) => f.stage === "league").every((f) => f.resultMovedOn), "P16: the league's results are locked").toBe(true);
    const reload = await homeOf(m.out);
    expect(reload.knockout).toEqual(filled.knockout);
  });

  it("(c) a three-way tie under Once (final): pick 2 of 3, both seats to decide; Toss reveals the stored lot, every member 'by lot', the same on every load (plan case 5)", async () => {
    const m = await lkMatch(["Asha", "Ben", "Cleo"], 2);
    const ids = await playCircle((await stageLines(m.out.stageId)) as never);
    const asked = await homeOf(m.out);
    expect(asked.knockout!.state).toBe("tie");
    expect(asked.knockout!.tie).toMatchObject({ entrantIds: ids, seats: 2, place: 1, byLot: true });
    expect(rankSeats(asked).map((s) => [s.rank, s.toDecide]).sort()).toEqual([[1, true], [2, true]]);

    const { through } = await decideQuickMatchCut(m.row, { how: "toss" });
    const first = await homeOf(m.out);
    const draws = await sql<{ drawn_order: string[] }[]>`
      select drawn_order from stage_lots_draws where stage_id = ${m.out.stageId} and superseded_at is null`;
    expect(draws, "completion stored the one lot").toHaveLength(1);
    const lot = draws[0]!.drawn_order;
    expect(first.knockout).toMatchObject({ state: "filled", picked: [] });
    expect(first.knockout!.decision).toMatchObject({ how: "toss", through: lot.slice(0, 2), tie: ids });
    expect(through).toEqual(lot.slice(0, 2));
    expect(sorted(first.knockout!.byLot), "D6: every member of a class settled by toss").toEqual(ids);
    const seated = Object.fromEntries(rankSeats(first).map((s) => [s.rank, finalOf(first)[s.side]?.entrantId]));
    expect(seated, "the lot's first two, in its order").toEqual({ 1: lot[0], 2: lot[1] });
    const koRows = await stageLines(m.out.knockoutStageId!);
    expect(koRows, "premise: a League → Final's knockout is the one final").toHaveLength(1);
    expect(first.next?.id, "the toss filled the final: it is next").toBe(koRows[0]!.id);
    const second = await homeOf(m.out);
    expect(second.knockout!.decision).toEqual(first.knockout!.decision);
    expect(second.knockout!.byLot).toEqual(first.knockout!.byLot);
  });

  it("(d) Setting up: the league done with no tie, the score's advance missed and the load's own failed: no question, no next, one log line; the next load fills the final with 1st and 2nd", async () => {
    const m = await lkMatch(["A", "B", "C"], 2);
    await beat(m, "A", "B");
    await beat(m, "A", "C");
    scoreHook.mockClear();
    scoreHook.mockImplementationOnce(async () => ({ state: "league" })); // the last result's advance never ran
    await beat(m, "B", "C");
    expect(scoreHook, "premise: the last result reached the hook").toHaveBeenCalledTimes(1);
    expect((await stageLines(m.out.knockoutStageId!)).filter((l) => l.home_entrant_id ?? l.away_entrant_id), "premise: empty").toEqual([]);

    readRetry.mockRejectedValueOnce(new Error("the advance failed on this load"));
    const errors = vi.spyOn(log, "error");
    let h: QuickMatchHome;
    try {
      h = await homeOf(m.out);
      expect(advanceFailures(errors)).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
    expect(h.league!.done).toBe(true);
    expect(h.knockout).toMatchObject({ state: "settingUp", filled: false, started: false, tie: null, decision: null });
    expect(h.next).toBeNull();
    expect(finalOf(h).phase).toBe("waiting");

    const filled = await homeOf(m.out);
    expect(filled.knockout!.state, "the load is the retry (D2 caller d)").toBe("filled");
    const [a, b] = ["A", "B"].map((n) => m.id.get(n)!);
    expect(sorted([finalOf(filled).home!.entrantId, finalOf(filled).away!.entrantId]), "wins 2-1-0: A and B").toEqual(sorted([a!, b!]));
  });

  it("(e) a decision on a league that is no longer done (m9): until an advance drops it, the read shows no answer, no question and no markers", async () => {
    const m = await lkMatch(["P", "Q", "R"], 2, 2);
    const [q, r] = ["Q", "R"].map((n) => m.id.get(n)!) as [string, string];
    const pq = await beat(m, "P", "Q", 0);
    await beat(m, "P", "Q", 1);
    await beat(m, "P", "R", 0);
    await beat(m, "P", "R", 1);
    await beat(m, "Q", "R", 0);
    await beat(m, "R", "Q", 1);
    expect((await homeOf(m.out)).knockout!.state, "premise: Q and R level for 2nd").toBe("tie");
    await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [r] });

    // A P–Q result voided (the same class stays level: P–Q only), its own advance missed.
    const [tail] = await sql<{ id: string; seq: number }[]>`select id, seq from score_events where fixture_id = ${pq} order by seq desc limit 1`;
    scoreHook.mockImplementationOnce(async () => ({ state: "league" }));
    await scoreEvent(systemAuth(), pq, { expected_seq: tail!.seq, type: "core.void", payload: { event_id: tail!.id } });
    expect(await storedDecision(m), "premise: nothing dropped the answer").toMatchObject({ how: "pick", through: [r], tie: sorted([q, r]) });

    readRetry.mockRejectedValueOnce(new Error("the advance failed on this load"));
    const h = await homeOf(m.out);
    expect(h.league).toEqual({ played: 5, notPlayed: 0, total: 6, done: false });
    expect(h.knockout).toMatchObject({ state: "league", filled: false, tie: null, decision: null, byLot: [], picked: [] });
    expect(rankSeats(h).filter((s) => s.toDecide)).toEqual([]);
    expect(h.next?.id).toBe(pq);

    expect((await homeOf(m.out)).knockout!.state).toBe("league");
    expect(await storedDecision(m), "the load's own advance drops it (§11)").toBeNull();
  });

  it("(f) Semi-finals in play, then the champion: started only once a knockout line is played; the champion is the final's winner, the 2nd seed here, never the table's leader", async () => {
    const m = await lkMatch(["W", "X", "Y", "Z"], 4);
    // W beats everyone, X beats Y and Z, Y beats Z: wins 3-2-1-0. The last result's hook fills the semi-finals.
    for (const [w, l] of [["W", "X"], ["W", "Y"], ["W", "Z"], ["X", "Y"], ["X", "Z"], ["Y", "Z"]] as const) await beat(m, w, l);
    const [w, x, y, z] = ["W", "X", "Y", "Z"].map((n) => m.id.get(n)!) as [string, string, string, string];
    expect(await rankedIds(m), "premise: the stored table ranks by wins").toEqual([w, x, y, z]);

    const filled = await homeOf(m.out);
    expect(filled.knockout).toMatchObject({ state: "filled", filled: true, started: false, byLot: [], picked: [], decision: null });
    expect(filled.league).toEqual({ played: 6, notPlayed: 0, total: 6, done: true });
    expect(filled.fixtures.filter((f) => f.stage === "league").every((f) => f.resultMovedOn)).toBe(true);
    const rankOf = new Map([[w, 1], [x, 2], [y, 3], [z, 4]]);
    const named = rankSeats(filled).map((s) => [s.rank, rankOf.get(koLines(filled).find((f) => f.id === s.id)![s.side]!.entrantId)]);
    expect(named, "each filled seat carries the rank its side holds in the table").toEqual(named.map(([rank]) => [rank, rank]));
    expect(named).toHaveLength(4);
    const semiOf = (a: string) => koLines(filled).find((f) => !f.isFinal && [f.home?.entrantId, f.away?.entrantId].includes(a))!;
    expect(sorted([semiOf(w).home!.entrantId, semiOf(w).away!.entrantId])).toEqual(sorted([w, z]));
    expect(filled.next?.stage).toBe("knockout");
    expect(filled.champion).toBeNull();

    // Started means a knockout line is under way, a result or not: a semi-final only begun (its Start, no result) counts.
    await scoreEvent(systemAuth(), semiOf(w).id, { expected_seq: 0, type: "core.start", payload: {} });
    const begun = await homeOf(m.out);
    expect(koLines(begun).map((f) => [f.id, f.phase]).filter(([, phase]) => phase !== "waiting" && phase !== "ready"),
      "premise: one knockout line in play, none settled").toEqual([[semiOf(w).id, "live"]]);
    expect(begun.knockout).toMatchObject({ state: "filled", started: true });
    expect(begun.next?.id, "the match in play is next").toBe(semiOf(w).id);

    await playWin(semiOf(w).id, w);
    const onePlayed = await homeOf(m.out);
    expect(onePlayed.knockout).toMatchObject({ state: "filled", started: true });
    expect(onePlayed.next?.id).toBe(semiOf(x).id);
    await playWin(semiOf(x).id, x);
    const final = finalOf(await homeOf(m.out));
    expect(sorted([final.home!.entrantId, final.away!.entrantId])).toEqual(sorted([w, x]));
    await playWin(final.id, x);

    const done = await homeOf(m.out);
    expect(done.finished).toBe(true);
    expect(done.next).toBeNull();
    expect(done.champion).toEqual({ entrantId: x, finalFixtureId: final.id });
    expect(await rankedIds(m).then((t) => t[0]), "the table's leader is W, not the champion").toBe(w);
    expect({ played: done.played, total: done.total }).toEqual({ played: 9, total: 9 });
    // Each line reads its OWN stage (carried-forward.ts): the league's stage is complete, so its results are locked; a
    // semi-final's winner sits in the final, so it has moved on; the final feeds nothing and its knockout stage is not
    // complete, so its result can still be edited (Edit result).
    const [koStage] = await sql<{ status: string }[]>`select status from stages where id = ${m.out.knockoutStageId}`;
    const [leagueStage] = await sql<{ status: string }[]>`select status from stages where id = ${m.out.stageId}`;
    expect({ league: leagueStage!.status, ko: koStage!.status === "complete" }, "premise: the stages differ").toEqual({ league: "complete", ko: false });
    expect(done.fixtures.filter((f) => f.stage === "league").every((f) => f.resultMovedOn)).toBe(true);
    expect(koLines(done).map((f) => [f.isFinal, f.resultMovedOn]).sort()).toEqual([[false, true], [false, true], [true, false]]);

    // A void of the final's result takes the champion back (the sequence): nobody has won, the final is in play and next.
    const [tip] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${final.id} order by seq desc limit 1`;
    await scoreEvent(systemAuth(), final.id, { expected_seq: tip!.seq, type: "core.void", payload: { event_id: tip!.id } });
    const reopened = await homeOf(m.out);
    expect(reopened.champion).toBeNull();
    expect(reopened.finished).toBe(false);
    expect(finalOf(reopened)).toMatchObject({ winnerEntrantId: null, phase: "live" });
    expect(reopened.next?.id).toBe(final.id);
    expect(reopened.knockout).toMatchObject({ state: "filled", started: true });
  });

  it("(g) every league match skipped: nothing played, a seed-ordered class is never 'by lot' — final (3 level for 2 seats): Pick only, the picked marked; semis (4 level, all through): filled at once, no marker", async () => {
    const three = await lkMatch(["A", "B", "C"], 2);
    for (const l of await stageLines(three.out.stageId)) await markNotPlayed(three.out, l.id);
    const asked = await homeOf(three.out);
    expect(asked.league).toEqual({ played: 0, notPlayed: 3, total: 3, done: true });
    expect({ played: asked.played, notPlayed: asked.notPlayed, total: asked.total, finished: asked.finished })
      .toEqual({ played: 0, notPlayed: 3, total: 4, finished: false });
    expect(asked.knockout!.state).toBe("tie");
    expect(asked.knockout!.tie).toMatchObject({ seats: 2, byLot: false, entrantIds: sorted([...three.id.values()]) });
    const picks = [three.id.get("C")!, three.id.get("A")!];
    await decideQuickMatchCut(three.row, { how: "pick", entrantIds: picks });
    const picked = await homeOf(three.out);
    expect(picked.knockout).toMatchObject({ state: "filled", byLot: [] });
    expect(sorted(picked.knockout!.picked)).toEqual(sorted(picks));
    expect(picked.champion).toBeNull();

    const four = await lkMatch(["A", "B", "C", "D"], 4);
    for (const l of await stageLines(four.out.stageId)) await markNotPlayed(four.out, l.id);
    const h = await homeOf(four.out);
    expect(h.league).toEqual({ played: 0, notPlayed: 6, total: 6, done: true });
    expect(h.knockout).toMatchObject({ state: "filled", tie: null, decision: null, byLot: [], picked: [] });
    expect(h.next?.stage).toBe("knockout");
  });

  it("(h) a plain League, every match skipped: no knockout block and no champion; its league counts are the match's (unchanged)", async () => {
    const out = await create(league4({ sides: SIDES.slice(0, 3) }));
    try {
      for (const f of (await homeOf(out)).fixtures) await markNotPlayed(out, f.id);
      const h = await homeOf(out);
      expect(h.league).toEqual({ played: 0, notPlayed: 3, total: 3, done: true });
      expect({ played: h.played, notPlayed: h.notPlayed, total: h.total, finished: h.finished }).toEqual({ played: 0, notPlayed: 3, total: 3, finished: true });
      expect(h.knockout).toBeNull();
      expect(h.champion).toBeNull();
      expect(readRetry, "a plain League is never advanced").not.toHaveBeenCalled();
    } finally {
      await hardDeleteQuickMatchCompetition(out.competitionId);
    }
  });

  it("(i) refuses a League + Knockout that is not a league then a knockout (three stages, one stage, the kinds swapped), and a knockout seat with no rank and no feeder", async () => {
    const cases: [string, (m: Lk) => Promise<unknown>, RegExp][] = [
      ["three stages", (m) => sql`
        insert into stages (division_id, org_id, seq, kind, name)
        select division_id, org_id, 3, kind, name from stages where id = ${m.out.knockoutStageId}`, /holds 3 stages, not 2/],
      ["one stage", (m) => sql`delete from stages where id = ${m.out.knockoutStageId}`, /holds 1 stages, not 2/],
      // The home's own wording (the cut's read refuses the same shape in its own): the head's guard, not the cut's, refused.
      ["the kinds swapped", (m) => sql`update stages set kind = 'knockout' where id = ${m.out.stageId}`,
        /the home reads a League \+ Knockout over a league stage then a knockout stage/],
      ["a seat with no feeder", (m) => sql`update fixtures set winner_to_fixture = null where stage_id = ${m.out.knockoutStageId} and not is_final`,
        /names no league rank and no feeder/],
    ];
    let checked = 0;
    for (const [what, tamper, refusal] of cases) {
      const m = await lkMatch(["W", "X", "Y", "Z"], 4);
      expect((await homeOf(m.out)).knockout, `${what}: the positive pair, the same match reads`).not.toBeNull();
      await tamper(m);   // a state no producer makes: the guard's own case
      await expect(readQuickMatchHome(m.row), what).rejects.toThrow(refusal);
      await hardDeleteQuickMatchCompetition(m.out.competitionId);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("(i2) a competition gone between the head read and the cut's (deleted meanwhile): the dead link, never a home without its knockout", async () => {
    const m = await lkMatch(["A", "B", "C"], 2);
    expect((await homeOf(m.out)).knockout, "the positive pair: the same match reads").not.toBeNull();
    cutRead.mockResolvedValueOnce(null);   // the cut's own read answers null for a competition that is gone
    expect(await readQuickMatchHome(m.row)).toBeNull();
  });

  it("(j) reads every offered sport's League → Final with its two stages: 3 + 1 matches, the final's seats 1st and 2nd in the league (sweep)", async () => {
    const offered = new Map((await listQuickMatchSports()).map((s) => [s.sport_key, s]));
    let checked = 0;
    let refused = 0;
    const visited = await forEachSportAsync(async ({ key }) => {
      const sport = offered.get(key);
      if (!sport) return;   // not offered: no quick match of it can exist to read
      const variant = sport.variants.find((v) => v.knockoutAllowed);
      if (!variant) {
        // League only (cricket, C11 as amended 2026-11-14): the create refuses a League + Knockout of it, so no home to read.
        await expect(create(league4({
          sport_key: key, variant_key: sport.variants[0]!.variant_key, kind: sport.kinds.at(-1)!, format: "league_knockout", qualifiers: 2,
          sides: ["Side A", "Side B", "Side C"],
        })), key).rejects.toThrow(/is not offered a knockout/);
        refused++;
        return;
      }
      const out = await create(league4({
        sport_key: key, variant_key: variant.variant_key, kind: sport.kinds.at(-1)!, format: "league_knockout", qualifiers: 2,
        sides: ["Side A", "Side B", "Side C"],
      }));
      try {
        const h = await homeOf(out);
        expect({ total: h.total, league: h.league?.total, ko: koLines(h).length }, key).toEqual({ total: 3 + 1, league: 3, ko: 1 });
        expect(h.knockout, key).toMatchObject({ qualifiers: 2, state: "league", filled: false, tie: null });
        expect(rankSeats(h).map((s) => [s.rank, s.toDecide]).sort(), key).toEqual([[1, false], [2, false]]);
        expect(h.standings!.stage_id, key).toBe(out.stageId);
        expect(h.next?.stage, key).toBe("league");
        checked++;
      } finally {
        await hardDeleteQuickMatchCompetition(out.competitionId);
      }
    });
    console.info(`quick match League + Knockout home sweep: ${checked} offered sports read, ${refused} refused, of ${visited} sport modules`);
    expect(checked).toBeGreaterThan(0);
    expect(refused, "anti-vacuity: a League-only sport was refused").toBeGreaterThan(0);
    expect(checked + refused).toBe(offered.size);
  }, SWEEP_TIMEOUT_MS);
});
