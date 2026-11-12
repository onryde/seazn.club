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
// Real Postgres required (RLS, triggers, the generator); skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sql, withTenant } from "@/lib/db";
import { isBye } from "@/lib/run-sheet-groups";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import type { EntrantKind } from "@seazn/engine/sport";
import { CreateQuickMatch } from "@/server/api-v1/schemas";
import { listDivisionFixtures } from "../fixtures";
import { createQuickMatchTree, sealNewHomeToken, systemAuth } from "../quick-match-create";
import { quickMatchPreview } from "../quick-match-preview";
import { hashHomeToken } from "../quick-match-tokens";
import type { FixtureRow } from "../stages";
import { seedOrg } from "./_seed";

const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // A15: CI's unit job has no KEK of its own for this suite to rely on
// The tree's organizer events reach a mock, never PostHog; Part B's D11 case reads its calls.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

const uniq = () => `QM ${randomUUID().slice(0, 8)}`;
const v = () => `test-visitor-${randomUUID()}`;
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
    expect(await sql`select 1 from quick_matches where name = ${name}`).toHaveLength(0);
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

  it("the system org holds more alive quick matches than community's competitions.max_active (§9 quota; D6's behaviour test)", async () => {
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
