// Quick match plan 1, Task 5: create a quick match, or nothing (spec docs/superpowers/specs/2026-11-03-quick-match-design.md
// §7.3, §9). Part A drives the UNGUARDED tree, `createQuickMatchTree` (competition → division → stage → name-only
// entrants → fixtures → started, in the system org). Part B drives the GUARDED `createQuickMatch` the route calls: the
// home-token seal first, the per-visitor cap (early and locked), the probe's offer, and the one analytics event.
//
// Every case keys on its OWN name or visitor (pre-flight A16): the system org is shared by every case, every run and the
// parallel probe, so an org-wide count would read other cases' rows. Expected values come from the preview (the number
// the Start button shows), the rulebook (round robin n·(n-1)/2; byes to the top seeds) or the plan's own catalog row,
// never from the create itself.
//
// The wrapper is driven on badminton only: the sweep across every sport and variant is Task 6's probe
// (`_quick-match-probe.ts`, through quick-match-offer.test.ts), which creates through the same tree.
//
// Part C (plan 5 Task 3) is League + Knockout: one division of two stages, the knockout's lines written at the create so the
// bracket shows from the start, and the league's tiebreak order without the seed step (the P8 ruling). Its expected values come
// from the rulebook (n(n-1)/2 + q - 1; 1v4, 2v3; 1v2), the mockup's Start counts, the spec's offer table (§3), the organiser's
// own template and the engine's declarations (`defaultTiebreakers`, `descriptorLabel`). It sweeps every offered variant once
// (C23), through the guarded create.
//
// Real Postgres required (RLS, triggers, the generator); skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EVENTS } from "@/lib/analytics-events";
import { sql, withTenant } from "@/lib/db";
import { captureServer } from "@/lib/posthog-server";
import { isBye } from "@/lib/run-sheet-groups";
import { QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MIN_SIDES, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { cutTiebreakers } from "../quick-match-cut";
import type { AnySportModule, EntrantKind, TiebreakerKey } from "@seazn/engine/sport";
import { descriptorLabel } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs } from "@seazn/engine/testkit";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { loadTableRules } from "@/server/engine-db/table-rules";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { listDivisionFixtures } from "../fixtures";
import { UNDO_BARRIER_TYPES } from "../history";
import { createQuickMatch, createQuickMatchTree, sealNewHomeToken, systemAuth } from "../quick-match-create";
import { quickMatchPreview } from "../quick-match-preview";
import { listQuickMatchSports, offerFor } from "../quick-match-sports";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { hashHomeToken, hashVisitorKey, mintVisitorKey, openHomeToken } from "../quick-match-tokens";
import { afterScheduleWrite } from "../schedule";
import { afterGenerateCommit, type FixtureRow } from "../stages";
import { seedOrg } from "./_seed";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // A15: CI's unit job has no KEK of its own for this suite to rely on
// The tree's organizer events reach a mock, never PostHog; Part B's D11 case reads its calls.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The real offer, through a spy: the League-only case reads it, so it is the real offer that says a knockout is allowed.
// The two post-commit steps, real but spied: a case asserts the create calls them, and the atomicity case fails one.
vi.mock("../stages", async (orig) => {
  const real = await orig<typeof import("../stages")>();
  return { ...real, afterGenerateCommit: vi.fn(real.afterGenerateCommit) };
});
vi.mock("../schedule", async (orig) => {
  const real = await orig<typeof import("../schedule")>();
  return { ...real, afterScheduleWrite: vi.fn(real.afterScheduleWrite) };
});
vi.mock("../quick-match-sports", async (orig) => {
  const real = await orig<typeof import("../quick-match-sports")>();
  return { ...real, offerFor: vi.fn(real.offerFor) };
});

const HAS_DB = !!process.env.DATABASE_URL;
const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

const uniq = () => `QM ${randomUUID().slice(0, 8)}`;
/** A visitor as the route will name one: a fresh visitor key's sha256 hex (the wrapper refuses any other shape). */
const v = () => hashVisitorKey(mintVisitorKey());
const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
/** Read from the catalog in beforeAll, never typed (B5c). */
let BADMINTON_V: string;

type TreeInput = Omit<CreateQuickMatch, "kind">;
const input = (over: Partial<TreeInput> = {}): TreeInput => ({
  name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, format: "league", sides, plays: 1, email: null, locale: "en",
  ...over,
});
// "pair": badminton's entrantModel takes it (engine dist/sports/setbased/badminton.js), so Doubles exists (D2).
const tree = (over: Partial<TreeInput> = {}, kind: EntrantKind = "pair", hook?: () => void) =>
  createQuickMatchTree(input(over), kind, { visitorHash: v(), home: sealNewHomeToken(), _failBeforeGenerateForTests: hook });
const nonBye = (fx: FixtureRow[]) => fx.filter((f) => !isBye(f));
const seedOf = async (divisionId: string) =>
  new Map((await withTenant(SYSTEM_ORG, (tx) =>
    tx<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${divisionId}`)).map((e) => [e.id, e.seed]));

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

describe.skipIf(!HAS_DB)("createQuickMatchTree (Part A: the unguarded tree)", () => {
  it("creates a started league with the promised fixture count", async () => {
    const out = await tree();
    expect(out.matchCount).toBe(quickMatchPreview({ format: "league", sides: 4, plays: 1 }).matchCount);   // A8: the preview's number…
    expect(out.matchCount).toBe(6);                                                                        // …which is 4·3/2 (round robin)
    expect(nonBye(await listDivisionFixtures(systemAuth(), out.divisionId))).toHaveLength(out.matchCount);   // C17: never drifts
    const [d] = await withTenant(SYSTEM_ORG, (tx) => tx`select status from divisions where id = ${out.divisionId}`);
    expect(d!.status).toBe("active");
    const [c] = await withTenant(SYSTEM_ORG, (tx) => tx`
      select status, visibility, discoverable, ends_on - starts_on as days from competitions where id = ${out.competitionId}`);
    expect(c).toEqual({ status: "live", visibility: "private", discoverable: false, days: 365 });   // D9: C21 "a year out" (date columns)
    const ents = await withTenant(SYSTEM_ORG, (tx) => tx`select kind, seed from entrants where division_id = ${out.divisionId} order by seed`);
    expect(ents.map((e) => [e.kind, e.seed])).toEqual([["pair", 1], ["pair", 2], ["pair", 3], ["pair", 4]]);   // C20 + D2: the kind passed in, in entry order
    const [q] = await sql`select token_hash, saved_by_user_id, visitor_hash, expires_at, last_activity_at from quick_matches where id = ${out.id}`;
    expect(q!.token_hash).toBe(hashHomeToken(out.token));
    expect(q!.saved_by_user_id).toBeNull();
    // §7.2: alive for QUICK_MATCH_EXPIRY_DAYS (7) days of inactivity from the create.
    expect((q!.expires_at as Date).getTime() - (q!.last_activity_at as Date).getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(out.expiresAt.getTime()).toBe((q!.expires_at as Date).getTime());
    // C19: the sealed envelope opens to the token the creator was handed (the page link can be shown again).
    const [enc] = await sql<{ token_enc: Uint8Array }[]>`select token_enc from quick_matches where id = ${out.id}`;
    expect(openHomeToken(enc!.token_enc)).toBe(out.token);
  });

  it("runs both post-commit steps: the generate's (SCHEDULE_GENERATED) and the start's (afterScheduleWrite)", async () => {
    const out = await tree();
    const generated = vi.mocked(captureServer).mock.calls.map(([a]) => a)
      .filter((a) => a.event === EVENTS.SCHEDULE_GENERATED && a.properties?.stage_id === out.stageId);
    expect(generated).toHaveLength(1);
    expect(generated[0]!.properties).toMatchObject({ fixtures_created: 6 });   // 4·3/2, the round robin's own count
    const starts = vi.mocked(afterScheduleWrite).mock.calls.filter(([divisionId]) => divisionId === out.divisionId);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.slice(0, 3)).toEqual([out.divisionId, out.competitionId, "start"]);
    expect(new Set(starts[0]![3])).toEqual(new Set(nonBye(await listDivisionFixtures(systemAuth(), out.divisionId)).map((f) => f.id)));
  });

  it("creates a knockout of 4 with two semi-finals and a final wired", async () => {
    const out = await tree({ format: "knockout" });
    const fx = await listDivisionFixtures(systemAuth(), out.divisionId);   // selects winner_to_fixture
    expect(fx.filter((f) => f.round_no === 1)).toHaveLength(2);
    const final = fx.find((f) => f.round_no === 2)!;
    expect(final.home_entrant_id).toBeNull();
    expect(final.away_entrant_id).toBeNull();
    expect(fx.filter((f) => f.round_no === 1).every((f) => f.winner_to_fixture === final.id)).toBe(true);
    expect(out.matchCount).toBe(3);   // 2 semis + 1 final, no third place (W4 G4: Shared is the default)
  });

  it.each([[3, [1]], [5, [1, 2, 3]], [6, [1, 2]]])(
    "a knockout of %i draws what the preview drew: round-1 pairs, and byes to seeds %j (C22, D4)",
    async (n, holders) => {
      const out = await tree({ format: "knockout", sides: [...sides, "Kim & Lou", "Ola & Pat"].slice(0, n) });
      const seed = await seedOf(out.divisionId);
      const fx = await listDivisionFixtures(systemAuth(), out.divisionId);
      const r1 = fx.filter((f) => f.round_no === 1);
      const madePairs = new Set(nonBye(r1).map((f) => [seed.get(f.home_entrant_id!), seed.get(f.away_entrant_id!)].sort().join("v")));
      const madeByes = r1.filter((f) => isBye(f)).map((f) => seed.get((f.home_entrant_id ?? f.away_entrant_id)!)).sort();
      const p = quickMatchPreview({ format: "knockout", sides: n, plays: 1 }).rounds[0]!;
      expect(madePairs).toEqual(new Set(p.lines.filter((l) => !l.bye).map((l) => [l.home.seed, l.away.seed].sort().join("v"))));
      expect(madeByes).toEqual(p.lines.filter((l) => l.bye).map((l) => l.home.seed).sort());
      // …and the spec's own rule (§7.3 step 3), not only the preview's: the create stores a config built at create
      // (stageConfigsAtCreate), the preview runs {}.
      expect(madeByes).toEqual(holders);
      expect(nonBye(fx)).toHaveLength(out.matchCount);   // C17 on a bracket with byes: a bye is not a match
    },
  );

  it("leaves nothing behind when generation fails (atomicity)", async () => {
    const name = uniq();   // B5b: this case's own name, never the org's count (A16)
    await expect(tree({ name }, "pair", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${name}`).toHaveLength(0);
  });

  it("leaves nothing behind when a step AFTER the commit fails: the committed quick_matches row goes too", async () => {
    // Here the last transaction has committed, so the row exists until the compensation deletes it: this check can fail.
    const name = uniq();
    vi.mocked(afterGenerateCommit).mockRejectedValueOnce(new Error("after-commit boom"));
    await expect(tree({ name })).rejects.toThrow("after-commit boom");
    expect(await sql`select 1 from quick_matches where name = ${name}`).toHaveLength(0);
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${name}`).toHaveLength(0);
  });

  it("the locked recount refuses the 6th alive match with 429, and the refused create leaves no competition (B5f)", async () => {
    // The tree has no early count, so this 429 comes from the recount INSIDE the last transaction, after the competition,
    // division, stage and entrants were committed by their own use cases.
    const visitorHash = v();
    const make = (name: string) => createQuickMatchTree(input({ name }), "pair", { visitorHash, home: sealNewHomeToken() });
    for (let i = 0; i < 5; i++) await make(uniq());
    const name = uniq();
    await expect(make(name)).rejects.toMatchObject({ status: 429, code: "QUICK_MATCH_TOO_MANY_ALIVE" });
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${name}`).toHaveLength(0);
  });

  it("the hard delete touches only the system org: another org's competition id deletes nothing (§7.8)", async () => {
    const { auth } = await seedOrg("community");
    const theirs = await createCompetition(auth, {
      name: uniq(), visibility: "private", branding: {}, starts_on: "2026-11-07", ends_on: "2026-11-08",
    });
    await hardDeleteQuickMatchCompetition(theirs.id);
    expect(await sql`select 1 from competitions where id = ${theirs.id}`).toHaveLength(1);
  });

  it("is never in a public view (§9 visibility, D7)", async () => {
    const out = await tree();
    expect(await sql`select 1 from public_competitions_v where id = ${out.competitionId}`).toHaveLength(0);
    expect(await sql`select 1 from public_discovery_v where id = ${out.competitionId}`).toHaveLength(0);
  });

  it("two quick matches with the same name both create, with distinct slugs (§9 slugs, D7)", async () => {
    const name = uniq();
    const a = await tree({ name });
    const b = await tree({ name });
    const rows = await sql`select slug from competitions where id in (${a.competitionId}, ${b.competitionId})`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(2);
  });

  it("two sides may share a name (Review Focus 2)", async () => {
    const out = await tree({ sides: ["A", "A", "B"] });
    expect(await withTenant(SYSTEM_ORG, (tx) => tx`select 1 from entrants where division_id = ${out.divisionId}`)).toHaveLength(3);
  });

  it("exactly one division and one stage", async () => {
    const out = await tree();
    const divisions = await sql<{ id: string }[]>`select id from divisions where competition_id = ${out.competitionId}`;
    expect(divisions.map((d) => d.id)).toEqual([out.divisionId]);
    const stages = await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${out.divisionId}`;
    expect(stages).toEqual([{ id: out.stageId, kind: "league" }]);
  });

  it("the system org holds more alive quick matches than community's competitions.max_active (§9 quota; D6's behavior test)", async () => {
    const [entitlement] = await sql<{ int_value: number }[]>`
      select int_value from plan_entitlements where plan_key = 'community' and feature_key = 'competitions.max_active'`;   // the plan's own row
    const cap = entitlement!.int_value;
    expect(cap).toBeGreaterThan(0);
    // cap + 1 creates, each its own visitor: without Task 1's null override the last one refuses (402).
    const made: string[] = [];
    for (let i = 0; i <= cap; i++) made.push((await tree()).competitionId);
    expect(new Set(made).size).toBe(cap + 1);
  });

  it("an org other than the system org reads none of its quick_matches rows, and the system org reads its own (RLS, T1 review)", async () => {
    const out = await tree();
    const other = (await seedOrg("community")).auth.orgId;
    expect(await withTenant(other, (tx) => tx`select 1 from quick_matches where id = ${out.id}`)).toHaveLength(0);
    expect(await withTenant(SYSTEM_ORG, (tx) => tx`select 1 from quick_matches where id = ${out.id}`)).toHaveLength(1);
  });

  it("a whitespace side name is refused by the schema (Review Focus 1)", () => {
    expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["A", "   "] }).success).toBe(false);
  });

  it("a side name over 60 characters is refused, never clipped (Review Focus 1, E1)", () => {
    const ok = (s: string) => CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["A", s] }).success;
    const shuttle = String.fromCodePoint(0x1f3f8);   // one emoji, two UTF-16 units
    expect(ok("x".repeat(60))).toBe(true);
    expect(ok("x".repeat(61))).toBe(false);
    expect(ok(shuttle.repeat(30))).toBe(true);
    expect(ok(shuttle.repeat(31))).toBe(false);
  });

  it("the 7th side is refused by the schema", () => {
    expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["1", "2", "3", "4", "5", "6"] }).success).toBe(true);
    expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["1", "2", "3", "4", "5", "6", "7"] }).success).toBe(false);
  });

  it("kind is required and must be an entrant kind (D2)", () => {
    expect(CreateQuickMatch.safeParse(input()).success).toBe(false);
    expect(CreateQuickMatch.safeParse({ ...input(), kind: "doubles" }).success).toBe(false);
    expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair" }).success).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("createQuickMatch (Part B: the guarded wrapper)", () => {
  const base = () => ({ ...input(), kind: "pair" as const });
  const reachedTree = () => { throw new Error("reached the tree"); };

  it("refuses with 503 before it reads or writes anything when DEVICE_LINK_KEK is unset (Review Focus 4, E2)", async () => {
    const visitorHash = v();
    for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });   // at the cap: a seal placed after the count answers 429, not 503
    const b = base();
    vi.stubEnv("DEVICE_LINK_KEK", "");
    try {
      await expect(createQuickMatch(b, { visitorHash, mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
        .rejects.toMatchObject({ status: 503, code: "DEVICE_LINK_KEK_MISSING" });
    } finally {
      vi.stubEnv("DEVICE_LINK_KEK", KEK);
    }
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${b.name}`).toHaveLength(0);
  });

  it("refuses the 6th alive match for one visitor with 429 QUICK_MATCH_TOO_MANY_ALIVE, before the tree", async () => {
    const visitorHash = v();
    for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });
    // The early count answers before the tree; without it, the hook fires first and the rejection is "reached the tree".
    await expect(createQuickMatch(base(), { visitorHash, mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 429, code: "QUICK_MATCH_TOO_MANY_ALIVE" });
  });

  it("a visitor's SAVED matches do not count: five saved, the next create succeeds (§7.2 alive = unsaved)", async () => {
    const visitorHash = v();
    for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });
    const { auth } = await seedOrg("community");   // a real user to have saved them
    await sql`update quick_matches set saved_by_user_id = ${auth.userId} where visitor_hash = ${visitorHash}`;
    const out = await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });
    expect(await sql`select 1 from quick_matches where id = ${out.id}`).toHaveLength(1);
  });

  it("a visitor's EXPIRED matches do not count: five made, the next create 8 days later succeeds (§7.2 alive = unexpired)", async () => {
    const visitorHash = v();
    for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000);   // past QUICK_MATCH_EXPIRY_DAYS (7) of the five
    const out = await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true, now: later });
    expect(await sql`select 1 from quick_matches where id = ${out.id}`).toHaveLength(1);
  });

  it.each([[""], ["test-visitor-1"], ["A".repeat(64)], ["a".repeat(63)], ["g".repeat(64)]])(
    "refuses a visitorHash that is not sha256 hex (%j) with 400 QUICK_MATCH_VISITOR_INVALID, before anything",
    async (visitorHash) => {
      await expect(createQuickMatch(base(), { visitorHash, mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
        .rejects.toMatchObject({ status: 400, code: "QUICK_MATCH_VISITOR_INVALID" });
    },
  );

  it("two concurrent creates at 4 alive: exactly one succeeds (the locked recount, B5f)", async () => {
    const visitorHash = v();
    for (let i = 0; i < 4; i++) await createQuickMatch(base(), { visitorHash, mailAllowed: async () => true });
    const pair = [base(), base()];
    const both = await Promise.allSettled(pair.map((b) => createQuickMatch(b, { visitorHash, mailAllowed: async () => true })));
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 429, code: "QUICK_MATCH_TOO_MANY_ALIVE" } });
    // The loser leaves no competition, found by its own name; the winner's stands.
    const loser = pair[both.findIndex((r) => r.status === "rejected")]!.name;
    const winner = pair[both.findIndex((r) => r.status === "fulfilled")]!.name;
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${loser}`).toHaveLength(0);
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${winner}`).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from quick_matches where visitor_hash = ${visitorHash}`;
    expect(n).toBe(5);
  });

  it("refuses a knockout at every side count with QUICK_MATCH_FORMAT_NOT_OFFERED, before anything (owner 2026-11-12: League only)", async () => {
    // The real offer says a knockout of this variant is allowed (`knockoutAllowed`, kept for League + Knockout), and 3..6
    // sides were the old knockout's own range, so only the League-only guard can refuse here. Nothing is built: the tree's
    // hook throws if it is reached, and no competition carries the asked name.
    expect(await offerFor("badminton", BADMINTON_V)).toMatchObject({ offered: true, knockoutAllowed: true });
    const many = [...sides, "Kim & Lou", "Ola & Pat"];
    let checked = 0;
    for (let n = QUICK_MATCH_MIN_SIDES; n <= QUICK_MATCH_MAX_SIDES; n++) {
      const asked = { ...base(), format: "knockout" as const, sides: many.slice(0, n) };
      expect(asked.sides, `${n} sides`).toHaveLength(n);
      await expect(
        createQuickMatch(asked, { visitorHash: v(), mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }),
        `a knockout of ${n}`,
      ).rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
      expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${asked.name}`, `${n}: nothing built`).toHaveLength(0);
      checked++;
    }
    expect(checked, "anti-vacuity: 2..6 sides").toBe(5);
    // The positive pair: the same input as a league is made.
    const league = await createQuickMatch({ ...base(), sides: many.slice(0, 3) }, { visitorHash: v(), mailAllowed: async () => true });
    expect(await sql`select format from quick_matches where id = ${league.id}`).toEqual([{ format: "league" }]);
  });

  it("refuses a sport the probe excluded with QUICK_MATCH_SPORT_NOT_OFFERED", async () => {
    const [g] = await sql<{ key: string }[]>`
      select key from sport_variants where sport_key = 'generic' and is_system and org_id is null order by key limit 1`;   // excluded by the probe (Task 6, B6e)
    await expect(createQuickMatch({ ...base(), sport_key: "generic", variant_key: g!.key, kind: "team" }, { visitorHash: v(), mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_SPORT_NOT_OFFERED" });
  });

  it("refuses a kind the sport does not take with QUICK_MATCH_KIND_NOT_OFFERED (D2)", async () => {
    const { offered, kinds } = await offerFor("badminton", BADMINTON_V);
    expect(offered).toBe(true);   // so the sport check cannot be what refuses
    const missing = (["individual", "pair", "team"] as const).find((k) => !kinds.includes(k));
    expect(missing, "badminton takes every kind: this test has nothing to witness").toBeDefined();
    await expect(createQuickMatch({ ...base(), kind: missing! }, { visitorHash: v(), mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_KIND_NOT_OFFERED" });
  });

  it("a create emits quick_match_created once, carrying no name, email or token (D11)", async () => {
    const cap = vi.mocked(captureServer);
    cap.mockClear();
    const b = { ...base(), email: "guest@example.com" };
    const out = await createQuickMatch(b, { visitorHash: v(), mailAllowed: async () => true, baseUrl: "https://qm-create.test" });
    const ours = cap.mock.calls.map(([a]) => a).filter((a) => a.event === EVENTS.QUICK_MATCH_CREATED);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      orgId: SYSTEM_ORG,
      properties: { quick_match_id: out.id, sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league", qualifiers: null, sides: 4, plays: 1 },
    });
    const wire = JSON.stringify(ours[0]);
    for (const secret of [b.name, b.email, out.token]) expect(wire).not.toContain(secret);
  });
});

// Branch-fix A review m6: the mail gate has no default. Optional, a caller that forgot it mailed with no limit at all (fail
// open); required, the compiler refuses that caller. Checked by tsc (this file is in the scoped type check), not by vitest.
describe("createQuickMatch's mail gate is required (review m6)", () => {
  it("a create with no `mailAllowed` does not type-check", () => {
    const omitted = (input: Parameters<typeof createQuickMatch>[0]) =>
      // @ts-expect-error -- mailAllowed is required: there is no "every mail allowed" default to forget it into.
      createQuickMatch(input, { visitorHash: "0".repeat(64) });
    expect(omitted).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part C: League + Knockout (plan 5 Task 3, D1, D10; spec §3, §12, §13)
// ---------------------------------------------------------------------------------------------------------------------

/** The engine's own module and a variant's declared cfg (the authority for a sport's default tiebreak order, P8). */
function moduleOf(sportKey: string): AnySportModule {
  const mod = builtinModules.find((m) => m.key === sportKey);
  if (mod === undefined) throw new Error(`premise: the engine registers no sport "${sportKey}"`);
  return mod;
}
function declaredLeagueOrder(sportKey: string, variantKey: string): TiebreakerKey[] {
  const mod = moduleOf(sportKey);
  const declared = declaredCfgs(mod).find((c) => c.name === variantKey);
  if (declared === undefined) throw new Error(`premise: ${sportKey} declares no variant "${variantKey}"`);
  return mod.defaultTiebreakers("league", declared.cfg as never);
}

interface StageReadRow {
  id: string;
  seq: number;
  kind: string;
  config: Record<string, unknown>;
  progression: unknown;
}
const stagesOf = async (divisionId: string): Promise<StageReadRow[]> => [
  ...(await sql<StageReadRow[]>`select id, seq, kind, config, progression from stages where division_id = ${divisionId} order by seq`),
];
interface LabelledFixture {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key: string; params?: Record<string, unknown>; seed?: number } | null;
  away_slot_label: { key: string; params?: Record<string, unknown>; seed?: number } | null;
  winner_to_fixture: string | null;
}
const knockoutLinesOf = (stageId: string) =>
  sql<LabelledFixture[]>`
    select id, round_no, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, winner_to_fixture
      from fixtures where stage_id = ${stageId} order by round_no, fixture_no`;
/** A placeholder seat's rank, read off its label, after checking the label is the engine's own for that rank. */
function rankOfSeat(label: LabelledFixture["home_slot_label"], where: string): number {
  expect(label, `${where}: a waiting seat carries its label`).not.toBeNull();
  const rank = label!.seed!;
  // rank_order placement: the i-th seat is the i-th of the table, and the label says so in the engine's words.
  expect(label, where).toEqual({ ...descriptorLabel({ kind: "rank_range", rank }), seed: rank });
  return rank;
}

const SIX = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max", "Kim & Lou", "Ola & Pat"];
const lkMade: string[] = [];

describe.skipIf(!HAS_DB)("createQuickMatch (Part C: League + Knockout, two stages and the bracket from the start)", () => {
  const reachedTree = () => { throw new Error("reached the tree"); };
  const ctx = (hook?: () => void) => ({ visitorHash: v(), mailAllowed: async () => true as const, _failBeforeGenerateForTests: hook });
  const lk = (qualifiers: 2 | 4, n: number, over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
    ...input(), kind: "pair", format: "league_knockout", qualifiers, sides: SIX.slice(0, n), ...over,
  });
  const make = async (asked: CreateQuickMatch) => {
    const out = await createQuickMatch(asked, ctx());
    lkMade.push(out.competitionId);
    return out;
  };
  const nothingBuilt = async (name: string) =>
    expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${name}`, `${name}: nothing built`).toHaveLength(0);

  afterAll(async () => {
    for (const id of lkMade.splice(0)) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  });

  it("top 4 of 4: the league (seq 1, its own lot seed), then the knockout (seq 2, the top 4), 6 + 3 lines; every knockout seat waits on its rank, 1v4 and 2v3, no bye; auto_progress stays off", async () => {
    const out = await make(lk(4, 4));
    const stages = await stagesOf(out.divisionId);
    expect(stages.map((st) => [st.seq, st.kind])).toEqual([[1, "league"], [2, "knockout"]]);
    const [league, knockout] = stages as [StageReadRow, StageReadRow];
    expect([out.stageId, out.knockoutStageId], "the first stage, then the knockout").toEqual([league.id, knockout.id]);
    expect(league.config.legs, "each pair plays Once").toBe(1);
    expect(league.config.rngSeed, "the league draws its own lot (P7: minted on every stage create)").toBeDefined();
    expect(knockout.progression).toMatchObject({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });

    const leagueLines = await sql`select 1 from fixtures where stage_id = ${league.id}`;
    expect(leagueLines, "4·3/2 league matches").toHaveLength(6);
    const lines = await knockoutLinesOf(knockout.id);
    expect(lines, "a knockout of 4 is 4 − 1 matches").toHaveLength(3);
    expect(lines.every((f) => f.home_entrant_id === null && f.away_entrant_id === null), "nobody is seated before the league ends").toBe(true);
    const all = await listDivisionFixtures(systemAuth(), out.divisionId);
    expect(all.filter((f) => f.stage_id === knockout.id).filter((f) => isBye(f)), "q is 4: a full bracket, no bye line").toEqual([]);

    const semis = lines.filter((f) => f.round_no === 1);
    expect(semis).toHaveLength(2);
    const pairs = new Set(semis.map((f, i) => [rankOfSeat(f.home_slot_label, `SF${i + 1} home`), rankOfSeat(f.away_slot_label, `SF${i + 1} away`)].sort().join("v")));
    expect(pairs, "the rulebook's seeding (§3): 1st v 4th, 2nd v 3rd").toEqual(new Set(["1v4", "2v3"]));
    const final = lines.find((f) => f.round_no === 2)!;
    expect(semis.every((f) => f.winner_to_fixture === final.id), "both semi-finals feed the final").toBe(true);

    const [division] = await sql<{ auto_progress: boolean }[]>`select auto_progress from divisions where id = ${out.divisionId}`;
    expect(division!.auto_progress, "D2: the quick match advances itself; the organiser switch stays off").toBe(false);
    // Both stages are ACTIVE and pinned from the moment of create: the knockout's setup-timing bracket starts its stage
    // (`stages/setup-fixtures.ts`, pending → active + pin). So "the knockout has started" is never `stages.status`: it is a
    // confirmed proposal (`seed_confirmed`) or a seated line, and neither exists yet.
    const states = await sql<{ status: string; pinned: boolean }[]>`
      select status, table_rules_pinned is not null as pinned from stages where division_id = ${out.divisionId} order by seq`;
    expect(states, "league, then knockout: both active and pinned at create").toEqual([
      { status: "active", pinned: true },
      { status: "active", pinned: true },
    ]);
    expect(Object.keys(UNDO_BARRIER_TYPES), "premise: `seed_confirmed` is the confirm's ledger row").toContain("seed_confirmed");
    const confirmed = await sql`select 1 from division_events where division_id = ${out.divisionId} and type = 'seed_confirmed'`;
    expect(confirmed, "no seed confirmed at create").toHaveLength(0);
    expect(await sql`select format from quick_matches where id = ${out.id}`).toEqual([{ format: "league_knockout" }]);
    expect(out.matchCount, "the Start button's number").toBe(quickMatchPreview({ format: "league_knockout", sides: 4, plays: 1, qualifiers: 4 }).matchCount);
    expect(out.matchCount, "6 + 3 (rulebook)").toBe(9);
    expect(nonBye(all), "C17: never drifts").toHaveLength(out.matchCount);
  });

  it("top 2 of 3: three league lines and a final between 1st and 2nd; Twice doubles the league only", async () => {
    const once = await make(lk(2, 3));
    const [, knockout] = (await stagesOf(once.divisionId)) as [StageReadRow, StageReadRow];
    const lines = await knockoutLinesOf(knockout.id);
    expect(lines, "one final").toHaveLength(1);
    const ranks = [rankOfSeat(lines[0]!.home_slot_label, "final home"), rankOfSeat(lines[0]!.away_slot_label, "final away")].sort();
    expect(ranks, "§3: 1st v 2nd").toEqual([1, 2]);
    expect(once.matchCount).toBe(3 + 1);
    const twice = await make(lk(2, 3, { plays: 2 }));
    expect(twice.matchCount, "2 × 3 league + 1 final").toBe(6 + 1);
    expect(nonBye(await listDivisionFixtures(systemAuth(), twice.divisionId))).toHaveLength(7);
  });

  it("a plain League keeps one stage and no knockout stage id", async () => {
    const out = await make({ ...input(), kind: "pair" });
    expect((await stagesOf(out.divisionId)).map((st) => st.kind)).toEqual(["league"]);
    expect(out.knockoutStageId).toBeNull();
  });

  // single-sport: tennis and ice hockey are the two sports whose default lists `seed` (P8), the only ones where the stored
  // order differs from the default; every offered sport's stored order is swept in the C23 case below.
  it.each(["tennis", "icehockey"])(
    "Step 0 (P8 ruling): a League + Knockout %s league ranks by its default with no seed step; a plain League keeps the seed",
    async (sportKey) => {
      const sport = (await listQuickMatchSports()).find((x) => x.sport_key === sportKey);
      expect(sport, `premise: ${sportKey} is offered`).toBeDefined();
      const variant_key = sport!.variants[0]!.variant_key;
      const declared = declaredLeagueOrder(sportKey, variant_key);
      expect(declared, `premise: ${sportKey}'s default lists the seed before the lot`).toContain("seed");
      const withoutSeed = declared.filter((k) => k !== "seed");
      const asked = { ...input(), sport_key: sportKey, variant_key, kind: sport!.kinds.at(-1)!, sides: SIX.slice(0, 3) };

      const knockoutNight = await make({ ...asked, format: "league_knockout", qualifiers: 2 });
      const [league, knockout] = (await stagesOf(knockoutNight.divisionId)) as [StageReadRow, StageReadRow];
      expect(league.config.tiebreakers, "the league stage's own order").toEqual(withoutSeed);
      expect(knockout.config.tiebreakers, "the knockout ranks no table").toBeUndefined();
      const rules = await withTenant(SYSTEM_ORG, (tx) => loadTableRules(tx, league.id));
      expect(rules.tiebreakers, "what the table ranks by").toEqual(withoutSeed);

      const plain = await make({ ...asked, format: "league" });
      const [plainLeague] = (await stagesOf(plain.divisionId)) as [StageReadRow];
      expect(plainLeague.config.tiebreakers, "a plain League stores no order of its own").toBeUndefined();
      const plainRules = await withTenant(SYSTEM_ORG, (tx) => loadTableRules(tx, plainLeague.id));
      expect(plainRules.tiebreakers, "and ranks by the sport's default, seed included (§13)").toEqual(declared);
    },
  );

  it("refuses semi-finals of three with SEMIS_TOO_FEW_SIDES and any knockout of two with FORMAT_NOT_OFFERED, before anything (§3)", async () => {
    const cases: [CreateQuickMatch, string][] = [
      [lk(4, 3), "QUICK_MATCH_SEMIS_TOO_FEW_SIDES"],
      [lk(2, 2), "QUICK_MATCH_FORMAT_NOT_OFFERED"],
      [lk(4, 2), "QUICK_MATCH_FORMAT_NOT_OFFERED"],
    ];
    let refused = 0;
    for (const [asked, code] of cases) {
      await expect(createQuickMatch(asked, ctx(reachedTree)), `${asked.sides.length} sides, top ${asked.qualifiers}`)
        .rejects.toMatchObject({ status: 422, code });
      await nothingBuilt(asked.name);
      refused++;
    }
    expect(refused).toBe(3);
    // The positive pairs at each boundary: the final of three and the semi-finals of four are made.
    expect((await make(lk(2, 3))).matchCount).toBe(3 + 1);
    expect((await make(lk(4, 4))).matchCount).toBe(6 + 3);
  });

  it("refuses a variant whose knockout match may end level (C23: !knockoutAllowed) with FORMAT_NOT_OFFERED; the real offer makes it", async () => {
    const real = await offerFor("badminton", BADMINTON_V);
    expect(real.knockoutAllowed, "premise: badminton's real offer allows a knockout").toBe(true);
    vi.mocked(offerFor).mockResolvedValueOnce({ ...real, knockoutAllowed: false });
    const asked = lk(2, 4);
    await expect(createQuickMatch(asked, ctx(reachedTree))).rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
    await nothingBuilt(asked.name);
    // The same input, the real offer: made. And a plain League is never asked the knockout's question.
    expect((await make({ ...asked, name: uniq() })).matchCount).toBe(6 + 1);
    vi.mocked(offerFor).mockResolvedValueOnce({ ...real, knockoutAllowed: false });
    expect((await make({ ...input(), kind: "pair" })).matchCount).toBe(6);
  });

  it("refuses a format and a count that disagree (a caller that built its input in code, past the schema) with 400 VALIDATION, before the mail limit is asked; the tree alone refuses them too", async () => {
    const email = "guest@qm-create.test";
    const baseUrl = "https://qm-create.test";
    const cases: CreateQuickMatch[] = [
      { ...lk(2, 3), qualifiers: null },
      { ...lk(2, 3), qualifiers: undefined },
      { ...input(), kind: "pair", qualifiers: 2 },
    ];
    let refused = 0;
    for (const asked of cases) {
      const where = `${asked.format} with ${asked.qualifiers}`;
      // The guarded create: refused before `ctx.mailAllowed`, so a refused create spends no mail bucket (its docstring, step 3).
      const mailAllowed = vi.fn(async () => true as const);
      await expect(createQuickMatch({ ...asked, email }, { visitorHash: v(), mailAllowed, baseUrl, _failBeforeGenerateForTests: reachedTree }), where)
        .rejects.toMatchObject({ status: 400, code: "VALIDATION" });
      expect(mailAllowed, `${where}: no mail bucket spent`).not.toHaveBeenCalled();
      await nothingBuilt(asked.name);
      // The tree on its own (the offer probe's door, no guard in front of it): the same refusal, nothing built.
      const { kind, ...treeInput } = asked;
      const treeName = uniq();
      await expect(createQuickMatchTree({ ...treeInput, name: treeName }, kind, { visitorHash: v(), home: sealNewHomeToken() }), `tree: ${where}`)
        .rejects.toMatchObject({ status: 400, code: "VALIDATION" });
      await nothingBuilt(treeName);
      refused++;
    }
    expect(refused).toBe(3);
    // The positive pair: a format and a count that agree, with an email, ask the mail limit once and are made.
    const mailAllowed = vi.fn(async () => true as const);
    const made = await createQuickMatch({ ...lk(2, 3), email }, { visitorHash: v(), mailAllowed, baseUrl });
    lkMade.push(made.competitionId);
    expect(mailAllowed, "an agreeing pair asks the mail limit").toHaveBeenCalledTimes(1);
  });

  it("quick_match_created carries the count: 2 for League → Final, 4 for semi-finals (and null for a League, Part B)", async () => {
    const cap = vi.mocked(captureServer);
    for (const q of [2, 4] as const) {
      cap.mockClear();
      const out = await make(lk(q, 4));
      const ours = cap.mock.calls.map(([a]) => a).filter((a) => a.event === EVENTS.QUICK_MATCH_CREATED);
      expect(ours, `top ${q}`).toHaveLength(1);
      expect(ours[0]!.properties, `top ${q}`).toMatchObject({ quick_match_id: out.id, format: "league_knockout", qualifiers: q, sides: 4 });
    }
  });

  it("every offered variant whose knockout cannot end level (C23) makes a League → Final of three: 3 + 1 lines, two stages, and a league order with no seed that ends in the lot", async () => {
    const offered = (offerJson as { offered: { sport_key: string; variant_key: string; knockoutAllowed: boolean }[] }).offered;
    const allowed = offered.filter((o) => o.knockoutAllowed);
    expect(allowed.length, "anti-vacuity: the offer allows a knockout somewhere").toBeGreaterThan(0);
    let checked = 0;
    for (const { sport_key, variant_key } of allowed) {
      const where = `${sport_key}/${variant_key}`;
      const { kinds } = await offerFor(sport_key, variant_key);
      const out = await createQuickMatch(
        { ...input(), sport_key, variant_key, kind: kinds.at(-1)!, format: "league_knockout", qualifiers: 2, sides: ["Side 1", "Side 2", "Side 3"] },
        ctx(),
      );
      try {
        expect(nonBye(await listDivisionFixtures(systemAuth(), out.divisionId)), where).toHaveLength(3 + 1);
        const [league, knockout] = (await stagesOf(out.divisionId)) as [StageReadRow, StageReadRow];
        expect([league.kind, knockout?.kind], where).toEqual(["league", "knockout"]);
        const stored = league.config.tiebreakers as string[];
        expect(stored, where).toEqual(declaredLeagueOrder(sport_key, variant_key).filter((k) => k !== "seed"));
        expect(stored.at(-1), `${where}: the toss reveals the lot, so the lot is last`).toBe("lots");
        expect(stored, where).toEqual(cutTiebreakers(declaredLeagueOrder(sport_key, variant_key)));
      } finally {
        await hardDeleteQuickMatchCompetition(out.competitionId);
      }
      checked++;
    }
    expect(checked).toBe(allowed.length);
    console.info(`League + Knockout C23 sweep: ${checked} offered variants made and deleted`);
  }, 600_000);
});
