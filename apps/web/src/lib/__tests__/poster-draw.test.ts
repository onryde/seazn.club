// Group D (public poster draw): buildDrawModel is the pure "round-by-round
// list" model builder feeding the poster.pdf route's page 2+ (see
// apps/web/src/lib/poster-draw.ts and .../poster.pdf/route.ts). A rendered
// PDF's content stream is compressed (pdfkit's default — see this repo's
// existing exports.ts test/e2e split), so VALUE proof belongs here, against
// the plain JS model, not against PDF bytes. The route's own tests cover
// wiring (locale threading, division scoping, pagination) and, for the two
// or three highest-value strings, a real decompress-and-decode round trip.
import { describe, expect, it } from "vitest";
import { msgFor } from "@/lib/messages-i18n";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import type { SlotLabelLookup } from "@/lib/slot-label";
import type { PublicFixture } from "@/server/public-site/data";
import { buildDrawModel, type BuildDrawModelInput } from "@/lib/poster-draw";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";

const lookupFor =
  (locale: Locale): SlotLabelLookup =>
  (k: MessageKey, v?: Record<string, string | number>) =>
    msgFor(locale, k, v);
const en = lookupFor("en");

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

/** A pool's printed label, straight out of a public dictionary FILE — the
 *  route hands the builder the org-locale resolver; the builder must call it
 *  with the pool's KEY (2026-10-06: never the stored English `pools.name`). */
const poolTextFor =
  (dict: Record<string, string>) =>
  (key: string): string =>
    dict["table.poolLabel"].replace("{key}", key);

const baseInput = (over: Partial<BuildDrawModelInput> = {}): BuildDrawModelInput => ({
  stages: [{ id: "s1", seq: 1, name: "League" }],
  pools: [],
  fixtures: [],
  entrantNames: {},
  poolText: poolTextFor(enPublic),
  ...over,
});

describe("buildDrawModel — empty input", () => {
  it("no fixtures at all produces no stage groups (page 1 stays the whole poster)", () => {
    expect(buildDrawModel(baseInput(), en)).toEqual([]);
  });

  it("a stage with zero fixtures never appears, even though it exists in `stages`", () => {
    const out = buildDrawModel(
      baseInput({
        stages: [
          { id: "s1", seq: 1, name: "League" },
          { id: "s2", seq: 2, name: "Playoffs" },
        ],
        fixtures: [F({ id: "f1", stage_id: "s1", home_entrant_id: "e1", away_entrant_id: "e2" })],
        entrantNames: { e1: "Lions", e2: "Tigers" },
      }),
      en,
    );
    expect(out.map((s) => s.stageName)).toEqual(["League"]);
  });
});

describe("buildDrawModel — basic grouping and ordering", () => {
  it("groups a single stage's fixtures by round, in round order, one pool group with poolName null", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "r2f1", round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e3" }),
          F({ id: "r1f1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "r1f2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
        ],
        entrantNames: { e1: "Lions", e2: "Tigers", e3: "Bears", e4: "Wolves" },
      }),
      en,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.pools).toHaveLength(1);
    const [pool] = out[0]!.pools;
    expect(pool!.poolName).toBeNull();
    expect(pool!.rounds.map((r) => r.label)).toEqual(["Round 1", "Round 2"]);
    expect(pool!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["r1f1", "r1f2"]);
    expect(pool!.rounds[0]!.fixtures[0]).toEqual({ id: "r1f1", home: "Lions", away: "Tigers" });
  });

  it("sorts fixtures within a round by seq_in_round even when the input array is out of order", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "second", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
          F({ id: "first", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B", e3: "C", e4: "D" },
      }),
      en,
    );
    expect(out[0]!.pools[0]!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["first", "second"]);
  });

  it("orders stages by seq, not by the order fixtures happen to arrive in", () => {
    const out = buildDrawModel(
      baseInput({
        stages: [
          { id: "knockout", seq: 2, name: "Knockout" },
          { id: "group", seq: 1, name: "Group Stage" },
        ],
        fixtures: [
          F({ id: "k1", stage_id: "knockout", home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "g1", stage_id: "group", home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B" },
      }),
      en,
    );
    expect(out.map((s) => s.stageName)).toEqual(["Group Stage", "Knockout"]);
  });
});

describe("buildDrawModel — slot labels (day-one fixtures), same resolver the board uses", () => {
  it('an unfilled slot resolves via resolveSlotLabel — "Winner of Group A" style, not a raw id or blank', () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({
            id: "final",
            home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
            away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
          }),
        ],
      }),
      en,
    );
    const row = out[0]!.pools[0]!.rounds[0]!.fixtures[0]!;
    expect(row).toEqual({ id: "final", home: "Winner of Group A", away: "Runner-up of Group B" });
  });

  it("resolves the SAME slot label in the org's own locale (es), not hardcoded English", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({
            id: "final",
            home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
            away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
          }),
        ],
      }),
      lookupFor("es"),
    );
    const row = out[0]!.pools[0]!.rounds[0]!.fixtures[0]!;
    expect(row.home).toBe("Ganador del Grupo A");
    expect(row.away).toBe("Subcampeón del Grupo B");
  });

  it("no slot label at all (null) falls back to the localized TBD string, never a raw literal", () => {
    const out = buildDrawModel(
      baseInput({ fixtures: [F({ id: "mystery" })] }),
      lookupFor("fr"),
    );
    const row = out[0]!.pools[0]!.rounds[0]!.fixtures[0]!;
    expect(row.home).toBe("À déterminer");
    expect(row.away).toBe("À déterminer");
  });

  it("a MIX of a real entrant and a TBD slot label resolves both correctly on the same row", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({
            id: "semi",
            home_entrant_id: "e1",
            away_slot_label: { key: "slot.runner_up_group", params: { g: "C" } },
          }),
        ],
        entrantNames: { e1: "Real Team" },
      }),
      en,
    );
    const row = out[0]!.pools[0]!.rounds[0]!.fixtures[0]!;
    expect(row).toEqual({ id: "semi", home: "Real Team", away: "Runner-up of Group C" });
  });

  it("an entrant id present on the fixture but missing from the roster map uses the localized unknown-entrant fallback, never a raw id or English default", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [F({ id: "gap", home_entrant_id: "missing-from-roster", away_entrant_id: "e1" })],
        entrantNames: { e1: "Real Team" },
      }),
      lookupFor("fr"),
    );
    const row = out[0]!.pools[0]!.rounds[0]!.fixtures[0]!;
    expect(row.home).toBe("Participant inconnu");
    expect(row.away).toBe("Real Team");
  });
});

describe("buildDrawModel — pooled group stage: independent round-robins, never merged", () => {
  // engine_pooled_group_stage_independent_round_sequences.md: Pool A's
  // "Round 1" and Pool B's "Round 1" are different matches, not the same
  // round split two ways — scoping by (stage, pool) keeps them apart.
  it("two pools sharing the same round_no stay in two separate pool groups, each with its own Round 1", () => {
    const out = buildDrawModel(
      baseInput({
        pools: [
          { id: "pa", stage_id: "s1", key: "A" },
          { id: "pb", stage_id: "s1", key: "B" },
        ],
        fixtures: [
          F({ id: "b1", pool_id: "pb", round_no: 1, home_entrant_id: "e3", away_entrant_id: "e4" }),
          F({ id: "a1", pool_id: "pa", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B", e3: "C", e4: "D" },
      }),
      en,
    );
    expect(out[0]!.pools.map((p) => p.poolName)).toEqual(["A", "B"].map((k) => enPublic["table.poolLabel"].replace("{key}", k)));
    expect(out[0]!.pools[0]!.rounds.map((r) => r.label)).toEqual(["Round 1"]);
    expect(out[0]!.pools[0]!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["a1"]);
    expect(out[0]!.pools[1]!.rounds.map((r) => r.label)).toEqual(["Round 1"]);
    expect(out[0]!.pools[1]!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["b1"]);
  });
});

// Pool label i18n (2026-10-06): the poster is printed in the ORG's locale,
// and `pools.name` is only ever the stored English "Pool " + key. Each pool
// heading is the supplied resolver over the pool's KEY. The read below hands
// over the stored name too (as `public_pools_v` does), so a builder that still
// printed it would read "Pool A" where the Spanish file says otherwise.
describe("buildDrawModel — a pool heading is the org-locale label over the pool's key", () => {
  it("a Spanish poster heads each pool from its key, never from the stored English name", () => {
    const want = (key: string) => esPublic["table.poolLabel"].replace("{key}", key);
    expect(want("A"), "premise: Spanish differs from the stored name").not.toBe("Pool A");
    // The view's row, stored English name and all.
    const read = [
      { id: "pa", stage_id: "s1", key: "A", name: "Pool A" },
      { id: "pb", stage_id: "s1", key: "B", name: "Pool B" },
    ];
    const out = buildDrawModel(
      baseInput({
        pools: read,
        poolText: poolTextFor(esPublic),
        fixtures: [
          F({ id: "a1", pool_id: "pa", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "b1", pool_id: "pb", round_no: 1, home_entrant_id: "e3", away_entrant_id: "e4" }),
        ],
        entrantNames: { e1: "A", e2: "B", e3: "C", e4: "D" },
      }),
      lookupFor("es"),
    );
    const headings = out.flatMap((s) => s.pools.map((p) => p.poolName));
    expect(headings).toEqual([want("A"), want("B")]);
    // Anti-vacuity: both pools were headed.
    expect(headings).toHaveLength(2);
  });

  it("a fixture whose pool the read does not list keeps a stage-only heading (no label, no resolver call)", () => {
    let calls = 0;
    const out = buildDrawModel(
      baseInput({
        pools: [],
        poolText: (key) => {
          calls += 1;
          return `label ${key}`;
        },
        fixtures: [F({ id: "x1", pool_id: "p-unlisted", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" })],
        entrantNames: { e1: "A", e2: "B" },
      }),
      en,
    );
    expect(out[0]!.pools.map((p) => p.poolName)).toEqual([null]);
    expect(calls).toBe(0);
  });
});

describe("buildDrawModel — double-elim: lane keeps WB/LB/GF from interleaving on shared round_no", () => {
  it("WB rounds print as one contiguous block, then LB's, even when round_no overlaps and input order is scrambled", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "lb1", lane: "LB", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "wb2", lane: "WB", round_no: 2, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "wb1", lane: "WB", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B" },
      }),
      en,
    );
    const rounds = out[0]!.pools[0]!.rounds;
    expect(rounds.map((r) => r.label)).toEqual([
      "Winners bracket · Round 1",
      "Winners bracket · Round 2",
      "Losers bracket · Round 1",
    ]);
  });

  it("the first Grand Final round prints plain; a second GF round (the reset) gets the reset label — order-based, not math-derived", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "gf2", lane: "GF", round_no: 6, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "gf1", lane: "GF", round_no: 5, home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B" },
      }),
      en,
    );
    const rounds = out[0]!.pools[0]!.rounds;
    expect(rounds.map((r) => r.label)).toEqual(["Grand final", "Grand final (reset)"]);
    expect(rounds.map((r) => r.fixtures[0]!.id)).toEqual(["gf1", "gf2"]);
  });

  it("lane labels resolve in the org's own locale too", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [F({ id: "wb1", lane: "WB", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" })],
        entrantNames: { e1: "A", e2: "B" },
      }),
      lookupFor("nl"),
    );
    expect(out[0]!.pools[0]!.rounds[0]!.label).toBe("Winnaarsronde · Ronde 1");
  });
});

describe("buildDrawModel — a final and its 3rd-place playoff sharing a round split apart", () => {
  // Review gap (2026-08-24): bracket.ts:220-227 gives the 3rd-place playoff
  // the SAME round_no as the final itself, and single-elim never sets a
  // `bracket` tag, so both also share lane=null — without a split, the two
  // fixtures used to land in one bucket and print as two indistinguishable
  // rows under a single generic "Round N" heading.
  it("splits a mixed bucket into a 'Final' group and a 'Third place' group, not one merged 'Round N' heading", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "final", round_no: 3, seq_in_round: 1, is_final: true, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "third", round_no: 3, seq_in_round: 2, third_place: true, home_entrant_id: "e3", away_entrant_id: "e4" }),
        ],
        entrantNames: { e1: "Lions", e2: "Tigers", e3: "Bears", e4: "Wolves" },
      }),
      en,
    );
    const rounds = out[0]!.pools[0]!.rounds;
    expect(rounds.map((r) => r.label)).toEqual(["Final", "Third place"]);
    expect(rounds[0]!.fixtures).toEqual([{ id: "final", home: "Lions", away: "Tigers" }]);
    expect(rounds[1]!.fixtures).toEqual([{ id: "third", home: "Bears", away: "Wolves" }]);
  });

  it("a lone final with no 3rd-place sibling in its round keeps the plain 'Round N' heading (no over-eager relabel)", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [F({ id: "final", round_no: 2, is_final: true, home_entrant_id: "e1", away_entrant_id: "e2" })],
        entrantNames: { e1: "Lions", e2: "Tigers" },
      }),
      en,
    );
    const rounds = out[0]!.pools[0]!.rounds;
    expect(rounds.map((r) => r.label)).toEqual(["Round 2"]);
    expect(rounds[0]!.fixtures).toEqual([{ id: "final", home: "Lions", away: "Tigers" }]);
  });

  it("the split labels resolve in the org's own locale too (fr)", () => {
    const out = buildDrawModel(
      baseInput({
        fixtures: [
          F({ id: "final", round_no: 3, is_final: true, home_entrant_id: "e1", away_entrant_id: "e2" }),
          F({ id: "third", round_no: 3, third_place: true, home_entrant_id: "e3", away_entrant_id: "e4" }),
        ],
        entrantNames: { e1: "A", e2: "B", e3: "C", e4: "D" },
      }),
      lookupFor("fr"),
    );
    expect(out[0]!.pools[0]!.rounds.map((r) => r.label)).toEqual(["Finale", "Troisième place"]);
  });
});
