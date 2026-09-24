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
import { restByeExtKey } from "@/lib/fixture-bye";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import type { SlotLabelLookup } from "@/lib/slot-label";
import type { PublicFixture } from "@/server/public-site/data";
import { buildDrawModel, type BuildDrawModelInput } from "@/lib/poster-draw";

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

const baseInput = (over: Partial<BuildDrawModelInput> = {}): BuildDrawModelInput => ({
  stages: [{ id: "s1", seq: 1, name: "League" }],
  pools: [],
  fixtures: [],
  entrantNames: {},
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
          { id: "pa", stage_id: "s1", name: "Pool A" },
          { id: "pb", stage_id: "s1", name: "Pool B" },
        ],
        fixtures: [
          F({ id: "b1", pool_id: "pb", round_no: 1, home_entrant_id: "e3", away_entrant_id: "e4" }),
          F({ id: "a1", pool_id: "pa", round_no: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
        ],
        entrantNames: { e1: "A", e2: "B", e3: "C", e4: "D" },
      }),
      en,
    );
    expect(out[0]!.pools.map((p) => p.poolName)).toEqual(["Pool A", "Pool B"]);
    expect(out[0]!.pools[0]!.rounds.map((r) => r.label)).toEqual(["Round 1"]);
    expect(out[0]!.pools[0]!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["a1"]);
    expect(out[0]!.pools[1]!.rounds.map((r) => r.label)).toEqual(["Round 1"]);
    expect(out[0]!.pools[1]!.rounds[0]!.fixtures.map((f) => f.id)).toEqual(["b1"]);
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

// #850 (owner ruling 2026-09-24): on the printed draw a round-robin REST bye
// is a NOTE in its round — "X has a bye" — never "X vs Bye". The same row in a
// knockout or Swiss stage prints as it always did (the twin that keeps the
// note from passing by dropping every bye).
describe("buildDrawModel — a round-robin rest bye prints as a note in its round (#850)", () => {
  const rest = (id: string, stage: string, round: number, holder: string) =>
    F({
      id,
      stage_id: stage,
      round_no: round,
      seq_in_round: 2,
      home_entrant_id: holder,
      away_slot_label: { key: "bracket.slot.bye", params: {} },
      status: "forfeited",
      outcome: { kind: "award", winner: holder },
      // The rest-bye MARKER, spelled by the generator's own function.
      ext_key: restByeExtKey("", round),
    });
  const match = (id: string, stage: string, round: number) =>
    F({ id, stage_id: stage, round_no: round, home_entrant_id: "a", away_entrant_id: "b" });
  const names = { a: "Alder", b: "Birch", e: "Elm" };

  it.each(["en", "es", "fr", "nl"] as const)("%s: under its round's heading, after the match, in the org's words", (locale) => {
    const out = buildDrawModel(
      baseInput({
        stages: [{ id: "lg", seq: 1, name: "League", kind: "league" }],
        fixtures: [rest("bye1", "lg", 1, "e"), match("m1", "lg", 1), match("m2", "lg", 2)],
        entrantNames: names,
      }),
      lookupFor(locale),
    );
    const rounds = out[0]!.pools[0]!.rounds;
    expect(rounds.map((r) => r.label)).toEqual([1, 2].map((n) => msgFor(locale, "schedule.round", { n })));
    expect(rounds[0]!.fixtures.map((f) => f.id)).toEqual(["m1", "bye1"]);
    expect(rounds[0]!.fixtures[1]!.note).toBe(msgFor(locale, "schedule.bye", { name: "Elm" }));
    expect(rounds[0]!.fixtures[0]!.note).toBeUndefined();
  });

  // Owner ruling 2026-09-24 (fourth round): a fed league's WALKOVER — a
  // qualifier left before the draw, `awardSeededByes` settled the line — has
  // the rest bye's shape in the same league but its MATCH key. It prints as it
  // did before #850: a line, never the "has a bye" note.
  it("the walkover twin: the same row shape in the same league, unmarked, prints as a line — no note", () => {
    const walkover = { ...rest("wo", "lg", 1, "e"), ext_key: "rr-r1-c2" };
    const out = buildDrawModel(
      baseInput({
        stages: [{ id: "lg", seq: 1, name: "League", kind: "league" }],
        fixtures: [walkover, match("m1", "lg", 1)],
        entrantNames: names,
      }),
      en,
    );
    const rows = out[0]!.pools[0]!.rounds[0]!.fixtures;
    expect(rows.map((f) => f.id).sort()).toEqual(["m1", "wo"]);
    expect(rows.every((f) => f.note === undefined)).toBe(true);
    expect(rows.find((f) => f.id === "wo")!.home).toBe("Elm");
  });

  it("the knockout twin: the same row shape in a bracket stage has no note", () => {
    const out = buildDrawModel(
      baseInput({
        stages: [{ id: "ko", seq: 1, name: "Cup", kind: "knockout" }],
        fixtures: [rest("kb", "ko", 1, "e"), match("km", "ko", 1)],
        entrantNames: names,
      }),
      en,
    );
    expect(out[0]!.pools[0]!.rounds[0]!.fixtures.every((f) => f.note === undefined)).toBe(true);
  });
});
