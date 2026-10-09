// P3 review findings 2 & 3.
//
// Finding 2: assembleResultEnrichment (org-posts.ts) had no DB-integration
// test at all — nothing with 2+ real scorers ever ran through it, which is
// exactly why finding 1's computeLeaderboardMoves bug shipped unnoticed.
//
// Finding 3: fail-open was proven for 1 of ~6 wrapped sources (recap's
// standingsMoves, via a genuinely malformed previous_rows value). The rest
// (topPerformers/leaderboardMoves/streak on the result path; leaders/
// upcoming/claimed on the digest path) were shape-only — their catch blocks
// had never actually caught anything. Every test below drives a REAL throw
// (a genuine postgres type error, or the same malformed-JSON class already
// proven for standingsMoves) through the exported assembly functions —
// never a mock that resolves to undefined.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// W2a Task 6 — a passthrough spy on the real resolver, for the bracket-overlay case at the end of this file.
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { appendEvent } from "@/server/engine-db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  assembleResultEnrichment,
  assembleRecapEnrichment,
  assembleDigestLeaders,
  assembleDigestClaimed,
  assembleDigestUpcoming,
  generateWeeklyDigest,
  draftPostsForDecidedFixture,
  listPosts,
  type FixtureCtx,
  type ActiveDivision,
  type DivisionHeadline,
} from "../org-posts";
import { scoreEvent } from "../scoring";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const badminton = builtinModules.find((m) => m.key === "badminton")!;
const BADMINTON_CFG = badminton.configSchema.parse({});
// A well-formed UUID that matches no row in this fresh test DB — real
// enough to bind as a `uuid` parameter (so it reaches the query, unlike a
// non-UUID string, which is used separately below where a TYPE error is
// specifically what's wanted), but guaranteed to 404 a "select ... where
// id = " lookup.
const NONEXISTENT_UUID = "00000000-0000-4000-8000-000000000000";

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
}

async function seedOrg(): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`src-${suffix}@test.local`}, 'Src', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Src " + suffix}, ${"src-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('badminton', 'Badminton', ${badminton.version}, ${sql.json(badminton.positions as never)})
    on conflict (key) do nothing`;
  return { auth: { orgId, via: "session", userId, role: "owner", keyId: null }, orgId, userId };
}

interface DivCtx {
  compId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
  personA: string;
  personB: string;
}

async function seedDivision(ctx: Ctx): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${ctx.userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version, auto_posts)
    values (${compId}, ${ctx.orgId}, 'Singles', ${"singles-" + suffix}, 'badminton', 'default',
      ${sql.json(BADMINTON_CFG as never)}, ${badminton.version}, true)
    returning id`;
  await sql`update divisions set status = 'active' where id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', 'Alice', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', 'Bob', 2) returning id`;
  const [{ id: personA }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, 'Alice Player') returning id`;
  const [{ id: personB }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, 'Bob Player') returning id`;
  await sql`
    insert into entrant_members (entrant_id, person_id, org_id)
    values (${entrantA}, ${personA}, ${ctx.orgId}), (${entrantB}, ${personB}, ${ctx.orgId})`;
  return { compId, divisionId, stageId, entrantA, entrantB, personA, personB };
}

async function draft(ctx: Ctx, fixtureId: string): Promise<void> {
  const newsAuto = await hasFeature(ctx.orgId, "news.auto");
  await withTenant(ctx.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtureId, newsAuto));
}

/** A structurally-valid FixtureCtx a test can override fields on — every
 *  field the two assembly functions actually read is exercised by at least
 *  one existing DB-backed test elsewhere in this file set; the ones NOT
 *  under test here (venue, scheduled_at, names) are cosmetic. */
function fixtureCtx(overrides: Partial<FixtureCtx>): FixtureCtx {
  return {
    fixture_id: randomUUID(),
    org_id: randomUUID(),
    division_id: randomUUID(),
    competition_id: randomUUID(),
    stage_id: randomUUID(),
    stage_kind: "league",
    round_no: 1,
    status: "decided",
    home_entrant_id: randomUUID(),
    away_entrant_id: randomUUID(),
    home_name: "Home",
    away_name: "Away",
    scheduled_at: null,
    venue: null,
    venue_tz: null,
    division_name: "Division",
    competition_name: "Competition",
    sport_key: "badminton",
    module_version: badminton.version,
    auto_posts: true,
    default_locale: "en",
    ...overrides,
  };
}

describe.skipIf(!HAS_DB)("assembleResultEnrichment — DB-integration (P3 review finding 2)", () => {
  it("a real multi-scorer fixture: topPerformers for both, a GENUINE leaderboardMoves entry, and a real win-streak line (also the finding-1 regression proof)", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx);

    // Rounds 1-2: Alice's entrant wins by forfeit (no rally credit) — a real
    // 2-win streak by round 2, checked below on round 2's OWN draft.
    const roundFixtures: string[] = [];
    for (const round of [1, 2]) {
      const [{ id: fx }] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
          home_entrant_id, away_entrant_id, status)
        values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, ${round}, 1,
          ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;
      await scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(ctx.auth, fx, {
        expected_seq: 1,
        type: "core.forfeit",
        payload: { by: div.entrantB, reason: "walkover" },
      });
      roundFixtures.push(fx);
    }

    // Round 3: BOTH players score real rally credit (Alice 2, Bob 5), then
    // Alice's entrant forfeits — Bob's entrant wins this ONE fixture, but
    // the STAT credit from both sides is what feeds topPerformers/
    // leaderboardMoves.
    const [{ id: fx3 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 3, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;
    await scoreEvent(ctx.auth, fx3, { expected_seq: 0, type: "core.start", payload: {} });
    let seq = 1;
    for (let i = 0; i < 2; i++) {
      await scoreEvent(ctx.auth, fx3, { expected_seq: seq, type: "badminton.rally", payload: { wonBy: div.entrantA } });
      seq += 1;
    }
    for (let i = 0; i < 5; i++) {
      await scoreEvent(ctx.auth, fx3, { expected_seq: seq, type: "badminton.rally", payload: { wonBy: div.entrantB } });
      seq += 1;
    }
    await scoreEvent(ctx.auth, fx3, {
      expected_seq: seq,
      type: "core.forfeit",
      payload: { by: div.entrantA, reason: "walkover" },
    });

    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    const round2 = results.find((r) => r.autoSource?.fixture_id === roundFixtures[1])!;
    const round3 = results.find((r) => r.autoSource?.fixture_id === fx3)!;
    expect(round2, "round 2 result draft missing").toBeTruthy();
    expect(round3, "round 3 result draft missing").toBeTruthy();

    // Streak: entrant "Alice" (not the person "Alice Player") has 2 real
    // wins in a row by round 2.
    expect(round2.bodyMd).toContain("Alice have now won 2 in a row.");

    // topPerformers: both scorers, by PERSON name.
    expect(round3.bodyMd).toContain("Top performers");
    expect(round3.bodyMd).toContain("Alice Player");
    expect(round3.bodyMd).toContain("Bob Player");

    // leaderboardMoves — the finding-1 regression proof. Cumulative going
    // into round 3: Alice=0, Bob=0 (rounds 1-2 were forfeits). After round
    // 3: Alice=2, Bob=5. Rolling back round 3's OWN credit from both at
    // once (the fix), "before" is {Alice:0,Bob:0} — tied — so Alice's rank
    // genuinely moves #1 -> #2 (Bob's 5 now beats her 2). The bug this
    // replaces would have held Bob at his POST-fixture 5 while rolling back
        // only Alice, reading "before" as {Alice:0, Bob:5} where Alice was
    // ALREADY #2 — so the buggy code would have reported NO move here,
    // silently hiding a move that genuinely happened (the mirror image of
    // the reviewer's phantom-move repro, covered directly in
    // enrichment.test.ts).
    expect(round3.bodyMd).toContain("Alice Player moved to #2");
    expect(round3.bodyMd).toContain("was #1");
  });
});

describe.skipIf(!HAS_DB)("P3 review finding 3 — genuine-throw fail-open, per source", () => {
  it("leaderboardMoves: recomputePlayerStats 404s on a nonexistent division; topPerformers still succeeds", async () => {
    const fx = fixtureCtx({ division_id: NONEXISTENT_UUID, stage_kind: "league" });
    const scorers = [
      { name: "Real Scorer", count: 3, personId: randomUUID() },
    ];
    const out = await withTenant((await seedOrg()).orgId, (tx) => assembleResultEnrichment(tx, fx, scorers));
    // topPerformers doesn't touch division_id at all — succeeds regardless.
    expect(out.topPerformers).toEqual([{ personName: "Real Scorer", statLine: expect.stringContaining("3") }]);
    // leaderboardMoves DOES need recomputePlayerStats(tx, fx.division_id),
    // which throws HttpError(404, "division not found") for real on this
    // nonexistent id — caught, dropped, never propagated.
    expect(out.leaderboardMoves).toBeUndefined();
  });

  it("recapLeaders: recomputePlayerStats 404s on a nonexistent division; biggestResult (pure, no DB) still succeeds", async () => {
    const fx = fixtureCtx({ division_id: NONEXISTENT_UUID, stage_id: randomUUID() });
    const results = [{ homeName: "A", homeScore: "5", awayName: "B", awayScore: "0" }];
    const out = await withTenant((await seedOrg()).orgId, (tx) => assembleRecapEnrichment(tx, fx, results));
    expect(out.leaders).toBeUndefined();
    expect(out.biggestResult).toEqual({ label: "A 5–0 B" });
    // No standings_snapshots row for this random stage_id either — a
    // legitimate ABSENCE (the `if (snap)` guard), not a throw; asserted
    // separately so this test's own pass doesn't hide a real exception here.
    expect(out.standingsMoves).toBeUndefined();
  });

  it("streak: a malformed outcome.winner (not a UUID) throws a real postgres type error; the result draft still lands", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx);
    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status, outcome)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        ${div.entrantA}, ${div.entrantB}, 'decided',
        ${sql.json({ kind: "win", winner: "not-a-uuid", loser: div.entrantB })})
      returning id`;
    await sql`
      insert into match_states (fixture_id, org_id, last_seq, state, summary)
      values (${fx}, ${ctx.orgId}, 0, ${sql.json({})}, ${sql.json({ perSide: [] })})`;

    await draft(ctx, fx);

    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results, "the draft was NOT dropped by the malformed outcome").toHaveLength(1);
    expect(results[0]!.bodyMd).not.toContain("in a row");
    expect(results[0]!.bodyMd).not.toContain("unbeaten");
    expect(results[0]!.bodyMd).not.toContain("undefined");
  });

  it("digestLeaders: a non-UUID personId in the headline rows throws a real postgres type error", async () => {
    const ctx = await seedOrg();
    const divisions: ActiveDivision[] = [
      { division_id: randomUUID(), division_name: "Div", sport_key: "badminton", module_version: badminton.version },
    ];
    const headlines = new Map<string, DivisionHeadline>([
      [
        divisions[0]!.division_id,
        {
          metric: { key: "points_won", label: "Points won" },
          rows: [{ personId: "not-a-uuid", stats: { points_won: 5 } }] as never,
        },
      ],
    ]);
    const out = await withTenant(ctx.orgId, (tx) => assembleDigestLeaders(tx, divisions, headlines));
    expect(out).toEqual([]);
  });

  it("digestClaimed: a non-UUID division_id throws a real postgres type error", async () => {
    const ctx = await seedOrg();
    const divisions: ActiveDivision[] = [
      { division_id: "not-a-uuid", division_name: "Div", sport_key: "badminton", module_version: badminton.version },
    ];
    const headlines = new Map<string, DivisionHeadline>([
      ["not-a-uuid", { metric: { key: "points_won", label: "Points won" }, rows: [] }],
    ]);
    const window = { start: new Date(Date.now() - 7 * 86400_000).toISOString(), end: new Date().toISOString(), weekOfYmd: "2026-01-01" };
    const out = await withTenant(ctx.orgId, (tx) => assembleDigestClaimed(tx, divisions, headlines, window));
    expect(out).toBeUndefined();
  });

  it("digestUpcoming: a non-UUID orgId throws a real postgres type error internally, caught, empty result returned", async () => {
    const ctx = await seedOrg();
    const out = await withTenant(ctx.orgId, (tx) => assembleDigestUpcoming(tx, "not-a-uuid", Date.now(), "UTC"));
    expect(out).toEqual({ upcoming: [], overflow: 0 });
  });

  // F5/Task 9: assembleDigestUpcoming's `homeName`/`awayName` used to
  // coalesce a fixture's unfilled entrant name straight to the bare literal
  // "TBD" — never selecting home_slot_label/away_slot_label. This query
  // filters only on status='scheduled', not on entrants resolved, so a
  // day-one fixture with a real time but no entrants reaches this digest.
  it("digestUpcoming: a day-one fixture with unresolved entrants renders its slot label, not TBD", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx);
    const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, scheduled_at)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        null, null, ${sql.json({ key: "bracket.round.roundOf", params: { n: 4 } })}, null,
        'scheduled', ${scheduledAt})`;

    const out = await withTenant(ctx.orgId, (tx) =>
      assembleDigestUpcoming(tx, ctx.orgId, Date.now(), "UTC", "en"),
    );
    const line = out.upcoming.flatMap((d) => d.lines).find((l) => l.homeName === "Round of 4");
    expect(line, "expected an upcoming line with the resolved slot label").toBeTruthy();
    // away_slot_label was left null deliberately — its fallback to
    // schedule.tbd stays visible here so this test doesn't false-positive
    // on a whole-row check the way a bare "not TBD" probe on the string
    // concatenation would.
    expect(line!.awayName).toBe("TBD");
    expect(line!.homeName).not.toBe("TBD");
  });

  // Final-review finding (2026-08-19): the test above (and its officials.ts/
  // schedule.ts siblings) only ever asserted "en" output, so a hardcoded
  // "en" swapped in for the real `toLocale(org.default_locale)` call at the
  // production call sites would leave all three green — the locale THREADING
  // itself was never pinned. This one drives the real production path
  // end-to-end instead of calling assembleDigestUpcoming directly: a
  // French-default_locale org, through generateWeeklyDigest -> digestForOrg
  // (org lookup -> toLocale -> assembleDigestUpcoming's 5th param), so a
  // regression to a hardcoded "en" — or to dropping the `, locale` argument
  // at org-posts.ts's digestForOrg call site — genuinely fails this test.
  it("digestUpcoming via the real generateWeeklyDigest path: a FR-locale org renders the slot label and TBD fallback in French, not English", async () => {
    const ctx = await seedOrg();
    await sql`update organizations set default_locale = 'fr' where id = ${ctx.orgId}`;
    const div = await seedDivision(ctx);
    const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, scheduled_at)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        null, null, ${sql.json({ key: "bracket.round.roundOf", params: { n: 4 } })}, null,
        'scheduled', ${scheduledAt})`;

    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    // fr's "bracket.round.roundOf" is "Ronde des {n}" and "schedule.tbd" is
    // "À déterminer" — both distinct from the English strings the earlier
    // "en" test above asserts, so this can only pass if digestForOrg's real
    // org-locale resolution actually reached assembleDigestUpcoming.
    expect(post.bodyMd).toContain("Ronde des 4");
    expect(post.bodyMd).toContain("À déterminer");
    expect(post.bodyMd).not.toContain("Round of 4");
    expect(post.bodyMd).not.toMatch(/\bTBD\b/);
  });
});

describe.skipIf(!HAS_DB)("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1, W2a Task 6)", () => {
  it("org-posts.ts draftPostsForDecidedFixture", async () => {
    // A decided boardgame knockout fixture in an auto-posting division, its snapshot nulled (the legacy shape) so
    // the result draft's scorer fold (`extractScorers`) resolves LIVE cfg — where this site's overlay is observable.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    await sql`update divisions set auto_posts = true where id = ${s.divisionId}`;
    const id = s.fixtureIds[0]!;
    const [f] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${id}`;
    await appendEvent(s.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(s.auth.orgId, id, 1, { type: "boardgame.result", payload: { winner: f!.home_entrant_id, method: "checkmate" } });
    await sql`update fixtures set config_snapshot = null where id = ${id}`;
    const spy = vi.mocked(resolveFixtureCfg);
    spy.mockClear();
    await withTenant(s.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, id, true));
    const calls = spy.mock.calls.map((c, i) => ({
      kind: (c[2] as { kind?: string } | null | undefined)?.kind ?? null,
      out: spy.mock.results[i]!.value as Record<string, unknown> | null,
    }));
    expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
    expect(calls.some((c) => c.kind === "knockout" && c.out?.tiebreak === true), JSON.stringify(calls)).toBe(true);
  });
});
