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
// Real Postgres required (RLS, triggers, the generator); skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EVENTS } from "@/lib/analytics-events";
import { sql, withTenant } from "@/lib/db";
import { captureServer } from "@/lib/posthog-server";
import { isBye } from "@/lib/run-sheet-groups";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import type { EntrantKind } from "@seazn/engine/sport";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { listDivisionFixtures } from "../fixtures";
import { createQuickMatch, createQuickMatchTree, sealNewHomeToken, systemAuth } from "../quick-match-create";
import { quickMatchPreview } from "../quick-match-preview";
import { offerFor } from "../quick-match-sports";
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
// The real offer, through a spy: Part B's Review Focus 5 case answers one call with an offer that refuses knockout.
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

  it("refuses knockout for a variant whose rules can end level, even when asked directly (Review Focus 5)", async () => {
    // Engine 3.0.2: no OFFERED variant's knockout can end level (each plays its sport's preset deciders to a winner; the
    // only `false` in the catalog is cricket's, which the probe excludes), so no real offer reaches this guard today:
    // quick-match-offer.test.ts pins both directions of the declaration across every variant. Here the offer that
    // says no is the guard's input, and the real offer beside it says yes, so only the guard can refuse.
    const real = await offerFor("badminton", BADMINTON_V);
    expect(real).toMatchObject({ offered: true, knockoutAllowed: true });
    vi.mocked(offerFor).mockResolvedValueOnce({ ...real, knockoutAllowed: false });
    await expect(createQuickMatch({ ...base(), format: "knockout" }, { visitorHash: v(), mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
  });

  it("refuses knockout with two sides (C16)", async () => {
    expect((await offerFor("badminton", BADMINTON_V)).knockoutAllowed).toBe(true);   // so only the side count can refuse here
    await expect(createQuickMatch({ ...base(), format: "knockout", sides: sides.slice(0, 2) }, { visitorHash: v(), mailAllowed: async () => true, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
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
      properties: { quick_match_id: out.id, sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league", sides: 4, plays: 1 },
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
