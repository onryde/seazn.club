// R4 sponsors on stream, S14 - the public sponsor report (`sponsorReport`, server/sponsors/report.ts; spec 2026-10-27 §5.2, §7).
// This is the page a PAYING sponsor sees, so every expected number below is INDEPENDENT ARITHMETIC over the rows this file seeds
// (the seeded instants, summed here in JS), never a figure read back from `sponsorReport`.
//
// THE RULEBOOK (spec §5.2; controller addenda 2026-11-01, binding):
//   - the token is looked up as `token_hash = sha256(token) and revoked_at is null`; an unknown, a revoked and a malformed token
//     all answer the SAME opaque null (the page's 404), with no timing or content oracle - here: one statement each, no more;
//   - the window is S13's rule over the link's inclusive dates: `[from_date 00:00 UTC, to_date + 1 day 00:00 UTC)`;
//   - a link with a competition counts only airings and clicks whose FIXTURE is in it (S13's competition filter); without one,
//     the whole org;
//   - on screen = Σ (ended_at − started_at) over CLOSED airings; an OPEN airing is a showing (times shown) whose own time on screen
//     is unknown (null) and adds nothing to the total;
//   - "visits from the stream" = the sponsor's `sponsor_clicks` with `source = 'stream'` only - never the all-sources number;
//   - each showing's frame is `sponsor_airings LEFT JOIN sponsor_airing_frames on (session_id, moment_id)`, read through
//     `signedReadUrls(orgId, paths, ttl <= 3600)` - ONE provider call per report; the storage path itself is never in the answer;
//   - a deleted sponsor's links cascade with it (V483), so its report is gone (null);
//   - entrant names are the PUBLIC names (`maskPublicEntrantNames`, the house authority the stream itself airs).
// Storage is stubbed at the `signedReadUrls` boundary only (no Supabase locally); the database is real.
//
// What this file CANNOT witness (final review S14 m3): the report reads under `withTenant(orgId)`, so RLS already hides every
// other org's row, and the explicit `org_id = ${orgId}` filters in `sponsorReport` are SHADOWED by it - deleting one leaves
// every test here green. They are belt-and-braces for a reader moved off `withTenant`; the tenant boundary itself is pinned
// by the RLS suites (rls-coverage), not by a cross-org case here.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   unknown / revoked / malformed token ............. "the opaque null"
//   create -> open -> revoke -> null -> second call ... "the seam"
//   both window bounds, both tables .................. "the window"
//   a link with a competition vs without .............. "the competition filter"
//   stream-only visits ................................ "streamVisits"
//   a showing with a frame vs without; a failed sign ... "frames"
//   an open airing .................................... "an open airing"
//   a deleted sponsor ................................. "a deleted sponsor"
//   empty period; a second call ....................... "empty"
//   the list bound ..................................... "the list"
//   another org's row naming this sponsor .............. "tenancy"
//   public names, an empty seat, a deleted fixture ..... "names"
// SINGLE SPORT (generic), on purpose: the report reads no sport - an airing carries its break kind as text, passed through.
//
// Killers (one at a time, each restored from a cp backup; see task-S14-report.md):
//   R1 revoked check   drop `and l.revoked_at is null`                   -> "the opaque null: a revoked token"
//   R2 lower bound     `>= ${w.from}` -> `> ${w.from}`                   -> "the window: a row exactly at 00:00 of from_date counts"
//   R3 upper bound     `< ${w.to}` -> `<= ${w.to}`                       -> "the window: a row at 00:00 the day after to_date does not"
//   R4 competition     drop the competition predicate                    -> "the competition filter"
//   R5 stream only     drop `and c.source = 'stream'`                    -> "streamVisits counts src=stream clicks only"
//   R6 signed url      frameUrl = the row's path                         -> "frames: ...never the storage path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

// Storage has no real Supabase locally: the ONE stub is the signing boundary. Everything else in the module is real.
const signs = vi.hoisted(() => ({
  calls: [] as { orgId: string; path: string; ttl: number }[],
  /** Provider calls (final review S14 m5: one per report, however many frames). */
  batches: 0,
  /** The next `fail` objects come back unsigned (the provider's per-object error). */
  fail: 0,
  /** The whole call fails. */
  down: false,
}));
vi.mock("@/lib/supabase-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase-storage")>();
  return {
    ...actual,
    signedReadUrls: vi.fn(async (orgId: string, paths: readonly string[], ttl: number) => {
      signs.batches++;
      if (signs.down) throw new Error("storage sign failed: the provider is down");
      return paths.map((path) => {
        signs.calls.push({ orgId, path, ttl });
        if (signs.fail > 0) {
          signs.fail--;
          return null;
        }
        // Opaque on purpose: a url that carries no part of the path, so "the path is nowhere in the answer" can be asserted.
        return `https://storage.test/signed/${signs.calls.length}?sig=${randomBytes(6).toString("hex")}`;
      });
    }),
  };
});

import { sql, statementCount } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { deleteSponsor } from "@/server/usecases/sponsors";
import { rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { REPORT_SHOWINGS_MAX, type SponsorReport } from "@/lib/sponsor-report";
import { SIGNED_READ_MAX_TTL_SEC } from "@/lib/supabase-storage";
import { log } from "@/server/logger";
import { airingFramePath } from "../airings";
import { createReportLink, hashReportToken, revokeReportLink, sponsorReport } from "../report";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

beforeEach(() => {
  signs.calls = [];
  signs.batches = 0;
  signs.fail = 0;
  signs.down = false;
});

const at = (iso: string) => new Date(iso);
const NOW = at("2026-07-15T12:00:00.000Z");
const SEC = 1000;
/** Review Focus 5's realistic sponsor name: 43 characters. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";

// ---------------------------------------------------------------------------------------------------------------
// Seeding. The writers' own tables (airings, frames, clicks) are filled on the privileged client, the way their writers fill
// them (app_user may only READ them); links go through S13's REAL createReportLink.
// ---------------------------------------------------------------------------------------------------------------
interface Rig {
  auth: AuthCtx;
  sponsorId: string;
  /** Two competitions, one fixture each, with person entrants. */
  a: { competitionId: string; competitionName: string; fixtureId: string; divisionId: string; names: [string, string] };
  b: { competitionId: string; competitionName: string; fixtureId: string; divisionId: string; names: [string, string] };
}

async function match(auth: AuthCtx, names: [string, string]) {
  const competitionName = `Report Cup ${randomUUID().slice(0, 6)}`;
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: competitionName, visibility: "public", branding: {} });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(auth, division.id, names.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L1", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  expect(fixtures.length, "premise: two entrants seat one fixture").toBe(1);
  return { competitionId: competition.id, competitionName, fixtureId: fixtures[0]!.id, divisionId: division.id, names };
}

async function rig(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const [sponsor] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, logo_path) values (${auth.orgId}, ${LONG_NAME}, 'gold', 'https://cdn.example/harbourside.png')
    returning id`;
  return {
    auth,
    sponsorId: sponsor!.id,
    a: await match(auth, ["Arun Kumar", "Bea Smith"]),
    b: await match(auth, ["Cal Jones", "Dee Park"]),
  };
}

/** A stream session on `fixtureId` (streamRig's insert: the snapshot columns read from the fixture's own rows). */
async function sessionOn(orgId: string, fixtureId: string): Promise<string> {
  const targetId = await rigTarget(orgId);
  const createdBy = await rigUser();
  const [s] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by,
                                         sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${orgId}, 'passthrough', 'completed', ${targetId}, ${createdBy}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}
    returning id`;
  return s!.id;
}

interface SeededAiring {
  sponsorId: string | null;
  fixtureId: string | null;
  start: Date;
  end: Date | null;
  source?: "rotation" | "scene" | "operator";
  breakKind?: string | null;
  sessionId?: string | null;
  momentId?: string;
  orgId?: string;
}
async function airing(orgId: string, a: SeededAiring): Promise<{ id: string; momentId: string }> {
  const source = a.source ?? "rotation";
  const momentId = a.momentId ?? (source === "scene" ? `scene:starting:${randomUUID().replace(/\D/g, "").slice(0, 6) || "1"}` : `${Math.floor(Math.random() * 1e6)}:sponsor.over_end`);
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style,
                                 started_at, ended_at)
    values (${a.orgId ?? orgId}, ${a.sponsorId}, ${LONG_NAME}, ${a.fixtureId}, ${a.sessionId ?? null}, ${momentId}, ${source},
            ${a.breakKind === undefined ? (source === "scene" ? null : "over_end") : a.breakKind},
            ${source === "scene" ? "banner" : "lower_third"}, ${a.start}, ${a.end})
    returning id`;
  return { id: row!.id, momentId };
}
async function frame(orgId: string, sessionId: string, momentId: string): Promise<string> {
  const path = airingFramePath(orgId, sessionId, momentId);
  await sql`insert into sponsor_airing_frames (session_id, moment_id, org_id, path) values (${sessionId}, ${momentId}, ${orgId}, ${path})`;
  return path;
}
interface SeededClick { sponsorId: string; fixtureId: string | null; source: "stream" | "match" | "site" | "unknown"; at: Date }
async function click(orgId: string, c: SeededClick): Promise<void> {
  await sql`
    insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at) values (${orgId}, ${c.sponsorId}, ${c.fixtureId}, ${c.source}, ${c.at})`;
}

/** A link through S13's REAL createReportLink; the token is the url's last segment (shown once, as the console shows it). */
async function link(r: Rig, o: { from: string; to: string; competitionId?: string | null }): Promise<{ id: string; token: string }> {
  const made = await createReportLink(r.auth, r.auth.orgId, { sponsorId: r.sponsorId, competitionId: o.competitionId ?? null, from: o.from, to: o.to });
  const m = /^\/r\/sponsor\/([A-Za-z0-9_-]{43})$/.exec(made.url);
  if (!m) throw new Error(`premise: S13's url shape, got ${made.url}`);
  return { id: made.id, token: m[1]! };
}

/** The rulebook's sums over what was seeded, by plain arithmetic. */
function expectedFor<A extends SeededAiring>(airings: A[], inPeriod: (a: A) => boolean) {
  const aired = airings.filter(inPeriod);
  return {
    timesShown: aired.length,
    onScreenMs: aired.reduce((sum, a) => sum + (a.end === null ? 0 : Math.max(0, a.end.getTime() - a.start.getTime())), 0),
  };
}
const inWindow = (from: string, toExclusive: string) => (a: { start?: Date; at?: Date }) => {
  const t = (a.start ?? a.at)!.getTime();
  return t >= at(from).getTime() && t < at(toExclusive).getTime();
};

const must = (r: SponsorReport | null): SponsorReport => {
  expect(r, "premise: a live link answers a report").not.toBeNull();
  return r!;
};
const numbersOf = (r: SponsorReport) => ({ timesShown: r.timesShown, onScreenMs: r.onScreenMs });

describe.skipIf(!HAS_DB)("S14: the opaque null - an unknown, a revoked and a malformed token answer the same, at the same cost", () => {
  it("each answers null with exactly ONE statement (the lookup), while a live token answers its report", async () => {
    const r = await rig();
    const live = await link(r, { from: "2026-07-01", to: "2026-07-31" });
    const revoked = await link(r, { from: "2026-07-01", to: "2026-07-31" });
    await revokeReportLink(r.auth, r.auth.orgId, revoked.id);

    const unknown = randomBytes(32).toString("base64url");
    const cases: [string, string][] = [
      ["unknown (a well-formed token nobody holds)", unknown],
      ["a revoked token", revoked.token],
      ["malformed: empty", ""],
      ["malformed: not base64url, with a path", "%2e%2e/../x?y=1"],
      ["malformed: a near-miss (the live token, one character short)", live.token.slice(0, -1)],
      ["malformed: 10 000 characters", "A".repeat(10_000)],
    ];
    let checked = 0;
    for (const [name, token] of cases) {
      const before = statementCount();
      const answer = await sponsorReport(token, NOW);
      const spent = statementCount() - before;
      expect(answer, name).toBeNull();
      expect(spent, `${name}: one lookup, no more (no oracle in the work done)`).toBe(1);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(signs.calls, "nothing was signed for a token that opens nothing").toEqual([]);

    // The positive pair: the live link from the same rig opens.
    const before = statementCount();
    expect((await sponsorReport(live.token, NOW))?.sponsor.name).toBe(LONG_NAME);
    expect(statementCount() - before, "a live link reads its numbers").toBeGreaterThan(1);
  });

  it("an invalid `now` is refused by name, never read as a NaN window", async () => {
    await expect(sponsorReport("x", new Date(Number.NaN))).rejects.toThrow(RangeError);
  });
});

describe.skipIf(!HAS_DB)("S14: the seam - S13's real createReportLink, the real report, the real revoke", () => {
  it("create -> open -> revoke -> null; a second open after the revoke is null again", async () => {
    const r = await rig();
    await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-07-02T10:00:00.000Z"), end: at("2026-07-02T10:00:08.000Z") });
    const l = await link(r, { from: "2026-07-01", to: "2026-07-31" });

    const opened = must(await sponsorReport(l.token, NOW));
    expect(opened.sponsor).toEqual({ name: LONG_NAME, logoUrl: "https://cdn.example/harbourside.png" });
    expect(opened.period).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(opened.competition).toBeNull();
    expect(opened.asOf).toBe(NOW.toISOString());
    expect(numbersOf(opened)).toEqual({ timesShown: 1, onScreenMs: 8 * SEC });
    // A second call is the same answer (TEST-STRATEGY: the second call).
    expect(await sponsorReport(l.token, NOW)).toEqual(opened);

    await revokeReportLink(r.auth, r.auth.orgId, l.id);
    expect(await sponsorReport(l.token, NOW), "revoked: the opaque null").toBeNull();
    expect(await sponsorReport(l.token, NOW), "and again").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("S14: the window - [from_date, to_date + 1 day) in UTC, on airings and clicks alike", () => {
  it("a row exactly at 00:00 of from_date counts, one a millisecond before does not; the last millisecond of to_date counts, 00:00 the day after does not", async () => {
    const r = await rig();
    const seeded: SeededAiring[] = [
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-05-31T23:59:59.999Z"), end: at("2026-06-01T00:00:09.999Z") }, // out
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-01T00:00:00.000Z"), end: at("2026-06-01T00:00:08.000Z") }, // in
      { sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, start: at("2026-06-14T18:30:00.000Z"), end: at("2026-06-14T18:30:15.000Z") }, // in
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-30T23:59:59.999Z"), end: at("2026-07-01T00:00:07.999Z") }, // in
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-07-01T00:00:00.000Z"), end: at("2026-07-01T00:00:06.000Z") }, // out
    ];
    for (const a of seeded) await airing(r.auth.orgId, a);
    const clicks: SeededClick[] = [
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-05-31T23:59:59.999Z") }, // out
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-06-01T00:00:00.000Z") }, // in
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-06-30T23:59:59.999Z") }, // in
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-07-01T00:00:00.000Z") }, // out
    ];
    for (const c of clicks) await click(r.auth.orgId, c);

    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    const inJune = inWindow("2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    const want = expectedFor(seeded, (a) => inJune(a));
    expect(want, "premise: three airings in, two out").toEqual({ timesShown: 3, onScreenMs: 8 * SEC + 15 * SEC + 8 * SEC });
    expect(numbersOf(got)).toEqual(want);
    expect(got.streamVisits).toBe(clicks.filter((c) => inJune(c)).length);
    expect(got.streamVisits, "premise: two clicks in").toBe(2);
    // The showings are exactly the in-window airings, newest first.
    expect(got.showings.map((s) => s.startedAt)).toEqual(
      seeded.filter((a) => inJune(a)).map((a) => a.start.toISOString()).sort().reverse(),
    );

    // A one-day link: only that day.
    const day = await link(r, { from: "2026-06-14", to: "2026-06-14" });
    expect(numbersOf(must(await sponsorReport(day.token, NOW)))).toEqual({ timesShown: 1, onScreenMs: 15 * SEC });
  });
});

describe.skipIf(!HAS_DB)("S14: the competition filter - a link with a competition sees only its matches; one without sees the org", () => {
  it("a link on competition A counts A's airings and clicks only; the same dates with no competition count A, B and no-fixture rows", async () => {
    const r = await rig();
    const seeded: (SeededAiring & { where: "a" | "b" | "none" })[] = [
      { where: "a", sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") },
      { where: "a", sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-03T10:00:00.000Z"), end: at("2026-06-03T10:00:15.000Z") },
      { where: "b", sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, start: at("2026-06-04T10:00:00.000Z"), end: at("2026-06-04T10:00:30.000Z") },
      { where: "none", sponsorId: r.sponsorId, fixtureId: null, start: at("2026-06-05T10:00:00.000Z"), end: at("2026-06-05T10:00:10.000Z") },
    ];
    for (const a of seeded) await airing(r.auth.orgId, a);
    await click(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-06-02T10:01:00.000Z") });
    await click(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, source: "stream", at: at("2026-06-04T10:01:00.000Z") });
    await click(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: null, source: "stream", at: at("2026-06-05T10:01:00.000Z") });

    const scoped = await link(r, { from: "2026-06-01", to: "2026-06-30", competitionId: r.a.competitionId });
    const inA = must(await sponsorReport(scoped.token, NOW));
    expect(inA.competition).toBe(r.a.competitionName);
    expect(numbersOf(inA)).toEqual(expectedFor(seeded, (a) => a.where === "a"));
    expect(inA.timesShown, "premise: A holds two").toBe(2);
    expect(inA.streamVisits, "A's one stream click").toBe(1);
    expect(inA.showings.every((s) => s.match?.home === resolvePersonDisplayName("Arun Kumar", null, null, false))).toBe(true);

    const whole = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const org = must(await sponsorReport(whole.token, NOW));
    expect(org.competition).toBeNull();
    expect(numbersOf(org)).toEqual(expectedFor(seeded, () => true));
    expect(org.timesShown, "premise: all four").toBe(4);
    expect(org.streamVisits, "all three stream clicks").toBe(3);

    // The other competition, the other way round.
    const onB = await link(r, { from: "2026-06-01", to: "2026-06-30", competitionId: r.b.competitionId });
    expect(numbersOf(must(await sponsorReport(onB.token, NOW)))).toEqual({ timesShown: 1, onScreenMs: 30 * SEC });
  });
});

describe.skipIf(!HAS_DB)("S14: streamVisits", () => {
  it("streamVisits counts src=stream clicks only - never match, site or unknown, another sponsor's, or another period's", async () => {
    const r = await rig();
    const [other] = await sql<{ id: string }[]>`insert into sponsors (org_id, name, tier) values (${r.auth.orgId}, 'Other Co', 'partner') returning id`;
    const inJune = at("2026-06-10T12:00:00.000Z");
    const seeded: SeededClick[] = [
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: inJune },
      { sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, source: "stream", at: inJune },
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "match", at: inJune },
      { sponsorId: r.sponsorId, fixtureId: null, source: "site", at: inJune },
      { sponsorId: r.sponsorId, fixtureId: null, source: "unknown", at: inJune },
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "stream", at: at("2026-08-01T00:00:00.000Z") },
      { sponsorId: other!.id, fixtureId: r.a.fixtureId, source: "stream", at: inJune },
    ];
    for (const c of seeded) await click(r.auth.orgId, c);
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    const want = seeded.filter((c) => c.sponsorId === r.sponsorId && c.source === "stream" && inWindow("2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")(c)).length;
    expect(want, "premise: two of the seven").toBe(2);
    expect(got.streamVisits).toBe(want);
    // The all-sources number for the same sponsor and period is NOT it (the bug the label would hide).
    const allSources = seeded.filter((c) => c.sponsorId === r.sponsorId && inWindow("2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")(c)).length;
    expect(allSources).toBe(5);
    expect(got.streamVisits).not.toBe(allSources);
    expect(got.timesShown, "no airings were seeded").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("S14: frames", () => {
  it("a showing with no frame renders the placeholder; frameUrl is a signed URL, never the storage path", async () => {
    const r = await rig();
    const session = await sessionOn(r.auth.orgId, r.a.fixtureId);
    const framed = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, sessionId: session, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") });
    const bare = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, sessionId: session, start: at("2026-06-02T10:05:00.000Z"), end: at("2026-06-02T10:05:08.000Z") });
    // A session-less airing (its session deleted: set null) cannot join a frame either.
    const orphan = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, sessionId: null, start: at("2026-06-02T10:10:00.000Z"), end: at("2026-06-02T10:10:08.000Z") });
    const path = await frame(r.auth.orgId, session, framed.momentId);
    // A frame for a moment no airing of this report holds (S9's orphan case) is never shown.
    const stray = await frame(r.auth.orgId, session, `${Math.floor(Math.random() * 1e6)}:sponsor.set_end`);

    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    const byId = new Map(got.showings.map((s) => [s.airingId, s]));
    expect(byId.size, "the three showings").toBe(3);

    expect(signs.calls, "one sign, for the one framed showing, with the org, its path and a TTL of at most an hour").toHaveLength(1);
    const [call] = signs.calls;
    expect(call!.orgId).toBe(r.auth.orgId);
    expect(call!.path).toBe(path);
    expect(Number.isInteger(call!.ttl) && call!.ttl >= 1 && call!.ttl <= 3600, `ttl ${call!.ttl}`).toBe(true);
    expect(call!.ttl).toBeLessThanOrEqual(SIGNED_READ_MAX_TTL_SEC);
    expect(byId.get(framed.id)!.frameUrl).toMatch(/^https:\/\/storage\.test\/signed\/1\?sig=/);
    expect(byId.get(bare.id)!.frameUrl, "no frame: the placeholder").toBeNull();
    expect(byId.get(orphan.id)!.frameUrl, "no session: the placeholder").toBeNull();

    const answer = JSON.stringify(got);
    expect(answer, "the storage path is nowhere in the answer").not.toContain(path);
    expect(answer, "nor any part of its key").not.toContain(path.split("/").at(-1)!);
    expect(answer).not.toContain(stray);
  });

  it("a frame the store cannot sign falls back to the placeholder; the report still opens, and the failure is logged once without the path", async () => {
    const r = await rig();
    const session = await sessionOn(r.auth.orgId, r.a.fixtureId);
    const one = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, sessionId: session, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") });
    const two = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, sessionId: session, start: at("2026-06-02T11:00:00.000Z"), end: at("2026-06-02T11:00:08.000Z") });
    const p1 = await frame(r.auth.orgId, session, one.momentId);
    const p2 = await frame(r.auth.orgId, session, two.momentId);
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });

    const warn = vi.spyOn(log, "warn").mockImplementation((() => undefined) as never);
    try {
      signs.fail = 1;
      const got = must(await sponsorReport(l.token, NOW));
      expect(signs.calls).toHaveLength(2);
      expect(signs.batches, "both frames in ONE provider call").toBe(1);
      const urls = got.showings.map((s) => s.frameUrl);
      expect(urls.filter((u) => u === null), "the one that failed").toHaveLength(1);
      expect(urls.filter((u) => u !== null), "the one that signed").toHaveLength(1);
      expect(warn, "logged once").toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of [p1, p2, l.token]) expect(logged).not.toContain(secret);

      // The whole call failing: every frame is the placeholder, the report still opens, one warning counts both.
      warn.mockClear();
      signs.down = true;
      const down = must(await sponsorReport(l.token, NOW));
      expect(down.showings.map((s) => s.frameUrl)).toEqual([null, null]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ unsigned: 2 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!HAS_DB)("S14: an open airing", () => {
  it("is a showing (times shown) whose own time on screen is unknown (null), and adds nothing to the total", async () => {
    const r = await rig();
    const seeded: SeededAiring[] = [
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") },
      { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-02T10:05:00.000Z"), end: null },
    ];
    const ids: string[] = [];
    for (const a of seeded) ids.push((await airing(r.auth.orgId, a)).id);
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    expect(numbersOf(got)).toEqual(expectedFor(seeded, () => true));
    expect(numbersOf(got), "premise: two shown, eight seconds").toEqual({ timesShown: 2, onScreenMs: 8 * SEC });
    expect(got.showings.find((s) => s.airingId === ids[1])!.onScreenMs, "open: unknown, never measured to now").toBeNull();
    expect(got.showings.find((s) => s.airingId === ids[0])!.onScreenMs).toBe(8 * SEC);
  });
});

describe.skipIf(!HAS_DB)("S14: a deleted sponsor", () => {
  it("its links cascade with it, so its report is the opaque null - and its airings survive, unread by any link", async () => {
    const r = await rig();
    await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") });
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    expect(must(await sponsorReport(l.token, NOW)).timesShown).toBe(1);

    await deleteSponsor(r.auth, r.sponsorId);
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_report_links where id = ${l.id}`;
    expect(left!.n, "premise: V483's cascade took the link").toBe(0);
    const [kept] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_airings where org_id = ${r.auth.orgId} and sponsor_id is null`;
    expect(kept!.n, "the airing kept its row, sponsor set null (R16)").toBe(1);
    expect(await sponsorReport(l.token, NOW)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("S14: empty", () => {
  it("a link over a period with nothing in it: zeros, an empty list, viewers a dash (null) - a second call the same", async () => {
    const r = await rig();
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    expect({ ...numbersOf(got), streamVisits: got.streamVisits, viewerImpressions: got.viewerImpressions, showings: got.showings }).toEqual({
      timesShown: 0, onScreenMs: 0, streamVisits: 0, viewerImpressions: null, showings: [],
    });
    expect(await sponsorReport(l.token, NOW)).toEqual(got);
  });
});

describe.skipIf(!HAS_DB)("S14: the list", () => {
  it(`lists the newest ${REPORT_SHOWINGS_MAX} showings, newest first, while the numbers count every one`, async () => {
    const r = await rig();
    const total = REPORT_SHOWINGS_MAX + 2;
    const seeded: SeededAiring[] = Array.from({ length: total }, (_, i) => ({
      sponsorId: r.sponsorId,
      fixtureId: r.a.fixtureId,
      start: new Date(at("2026-06-01T09:00:00.000Z").getTime() + i * 60 * SEC),
      end: new Date(at("2026-06-01T09:00:00.000Z").getTime() + i * 60 * SEC + (5 + (i % 4)) * SEC),
    }));
    for (const a of seeded) await airing(r.auth.orgId, a);
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    expect(numbersOf(got)).toEqual(expectedFor(seeded, () => true));
    expect(got.timesShown).toBe(total);
    expect(got.showings).toHaveLength(REPORT_SHOWINGS_MAX);
    const want = seeded.map((a) => a.start.toISOString()).sort().reverse().slice(0, REPORT_SHOWINGS_MAX);
    expect(got.showings.map((s) => s.startedAt)).toEqual(want);
  });
});

describe.skipIf(!HAS_DB)("S14: tenancy", () => {
  it("a row of ANOTHER org naming this sponsor's id is never counted (the database checks no cross-org reference)", async () => {
    const r = await rig();
    const { auth: other } = await seedOrg("pro");
    await airing(r.auth.orgId, { orgId: other.orgId, sponsorId: r.sponsorId, fixtureId: null, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:30.000Z") });
    await click(other.orgId, { sponsorId: r.sponsorId, fixtureId: null, source: "stream", at: at("2026-06-02T10:01:00.000Z") });
    await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: null, start: at("2026-06-03T10:00:00.000Z"), end: at("2026-06-03T10:00:08.000Z") });
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    expect({ ...numbersOf(got), streamVisits: got.streamVisits }).toEqual({ timesShown: 1, onScreenMs: 8 * SEC, streamVisits: 0 });
  });

  it("a link row naming ANOTHER org's sponsor or competition opens nothing (the lookup's own org checks), its own-org twin does", async () => {
    const mine = await rig();
    const theirs = await rig();
    // Rows S13 never writes (it checks both ids are the caller's), written raw: the database alone would take them.
    const raw = async (sponsorId: string, competitionId: string | null) => {
      const token = randomBytes(32).toString("base64url");
      await sql`
        insert into sponsor_report_links (org_id, sponsor_id, competition_id, from_date, to_date, token_hash)
        values (${mine.auth.orgId}, ${sponsorId}, ${competitionId}, '2026-06-01', '2026-06-30', ${hashReportToken(token)})`;
      return token;
    };
    const cases: [string, string, boolean][] = [
      ["another org's sponsor", await raw(theirs.sponsorId, null), false],
      ["another org's competition", await raw(mine.sponsorId, theirs.a.competitionId), false],
      ["own sponsor, own competition (the positive pair)", await raw(mine.sponsorId, mine.a.competitionId), true],
      ["own sponsor, no competition (the positive pair)", await raw(mine.sponsorId, null), true],
    ];
    let checked = 0;
    for (const [name, token, opens] of cases) {
      expect((await sponsorReport(token, NOW)) !== null, name).toBe(opens);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("S14: names - the public names the stream airs, an empty seat, a deleted fixture, the break", () => {
  it("masks the sides by the division's policy (the house authority), and keeps the break kind and source as they aired", async () => {
    const r = await rig();
    // The division asks for first-initial names: the report must show what the public site and the stream show, never the full name.
    await sql`update divisions set player_name_display = 'first_initial' where id = ${r.a.divisionId}`;
    const scene = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, source: "scene", start: at("2026-06-02T09:00:00.000Z"), end: at("2026-06-02T09:00:10.000Z") });
    const over = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.a.fixtureId, breakKind: "over_end", start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") });
    const gone = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: null, start: at("2026-06-02T11:00:00.000Z"), end: at("2026-06-02T11:00:08.000Z") });
    const unmasked = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, start: at("2026-06-02T12:00:00.000Z"), end: at("2026-06-02T12:00:08.000Z") });
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    const byId = new Map(got.showings.map((s) => [s.airingId, s]));

    const masked = {
      home: resolvePersonDisplayName("Arun Kumar", null, "first_initial", false),
      away: resolvePersonDisplayName("Bea Smith", null, "first_initial", false),
    };
    expect(masked.home, "premise: the policy changes the name").not.toBe("Arun Kumar");
    expect(byId.get(over.id)!.match).toEqual(masked);
    expect(byId.get(scene.id)!.match).toEqual(masked);
    expect(byId.get(unmasked.id)!.match, "B's division shows full names").toEqual({ home: "Cal Jones", away: "Dee Park" });
    expect(byId.get(gone.id)!.match, "the fixture is gone").toBeNull();
    expect(JSON.stringify(got), "the full names of A's sides are nowhere").not.toMatch(/Arun Kumar|Bea Smith/);

    expect([byId.get(over.id)!.breakKind, byId.get(over.id)!.source]).toEqual(["over_end", "rotation"]);
    expect([byId.get(scene.id)!.breakKind, byId.get(scene.id)!.source]).toEqual([null, "scene"]);
    for (const s of got.showings) expect([s.viewers, s.watchUrl], "PR A: no viewers, no watch link").toEqual([null, null]);
    expect(got.viewerImpressions).toBeNull();
  });

  it("an empty seat (a fixture whose side is not decided) reads null for that side, the other side its name", async () => {
    const r = await rig();
    await sql`update fixtures set away_entrant_id = null where id = ${r.b.fixtureId}`;
    const a = await airing(r.auth.orgId, { sponsorId: r.sponsorId, fixtureId: r.b.fixtureId, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:08.000Z") });
    const l = await link(r, { from: "2026-06-01", to: "2026-06-30" });
    const got = must(await sponsorReport(l.token, NOW));
    expect(got.showings.find((s) => s.airingId === a.id)!.match).toEqual({ home: "Cal Jones", away: null });
  });
});
