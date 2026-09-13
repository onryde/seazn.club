// B07a T5 — the expected qualifier ORDER a pooled group stage feeds its
// knockout.
//
// ORDER is the deliverable here, not membership. A pooled group stage's
// qualifiers are ordered RANK BEFORE GROUP — every pool's winner, then every
// pool's runner-up (A1, B1, C1, D1, A2, B2 …) — so a comparator that only
// asks WHICH entrants qualified agrees with a group-before-rank list that
// seeds every bracket slot wrong. Several tests below are therefore written
// as ORDERING-DIFFERENTIAL cases: same membership, different sequence, and
// only a sequence-checking assertion can tell them apart.
//
// Two independent authorities are pinned, and neither is a table typed into
// this file (AGENTS.md failure class 19 — derive the expectation from the
// source of truth so a change there moves the test with it):
//
//   1. The WAVE-major structure comes from the engine's own `expandTake`
//      (`@seazn/engine/competition`, progression.ts:124-134 — "every group's
//      winner (wave 1) before any group's runner-up (wave 2)"), cross-checked
//      against the bench's independent re-implementation below.
//   2. The POOL order within a wave comes from the product's own query:
//      `select key from pools where stage_id = ... order by key`
//      (apps/web/src/server/usecases/stage-seeding.ts:134), with the
//      pool-less fallback `POOL_KEYS.slice(0, count).split("")` over
//      `"ABCDEFGHIJKLMNOPQRSTUVWXYZ"` (usecases/stages.ts:745). Both branches
//      are ascending by key, which is what `expectedQualifierRefs` sorting by
//      `poolKey` mirrors.
//
// `lib/qualifiers.ts` itself imports NOTHING from the product (bench
// `_RULES.md` §3, checker independence): two implementations that disagree is
// a finding either way, whereas one shared implementation is a tautology.
// This TEST may import the engine precisely to run that comparison.
import { describe, expect, it } from "vitest";
import { expandTake, type SlotDescriptor } from "@seazn/engine/competition";
import { newSession } from "../http.ts";
import { compareQualifiers, advanceStageSeeding, type AdvanceTransport } from "../advance.ts";
import { expectedQualifierRefs, type QualifierTable } from "../qualifiers.ts";

const tables = [
  {
    poolKey: "A",
    rows: [
      { entrant: "e-a1", rank: 1 },
      { entrant: "e-a2", rank: 2 },
      { entrant: "e-a3", rank: 3 },
    ],
  },
  {
    poolKey: "B",
    rows: [
      { entrant: "e-b1", rank: 1 },
      { entrant: "e-b2", rank: 2 },
      { entrant: "e-b3", rank: 3 },
    ],
  },
];

/** Four pools, so wave-major and pool-major orders diverge in more than one
 *  place — a two-pool sample can be matched by a single transposition, which
 *  is exactly the "one sample is not a parity sweep" trap (AGENTS.md 7). */
const fourPools: QualifierTable[] = ["A", "B", "C", "D"].map((k) => ({
  poolKey: k,
  rows: [
    { entrant: `e-${k.toLowerCase()}1`, rank: 1 },
    { entrant: `e-${k.toLowerCase()}2`, rank: 2 },
    { entrant: `e-${k.toLowerCase()}3`, rank: 3 },
  ],
}));

/** The expectation DERIVED FROM THE ENGINE, not typed out: expand the same
 *  take rule the product would expand, place it with `rank_order` (which
 *  `placeDescriptors` implements as a plain `pots.flat()`,
 *  progression.ts:298 — the list is consumed verbatim), then read each
 *  resulting `group_rank` descriptor back through the pack's own tables.
 *
 *  Pool order is supplied ascending because that is what the PRODUCT supplies
 *  (this file's header, authority 2); the engine contributes the wave-major
 *  structure, which is the half that would silently invert. */
function engineExpectedRefs(source: readonly QualifierTable[], n: number): string[] {
  const poolKeys = source
    .map((t) => t.poolKey)
    .filter((k): k is string => k !== undefined)
    .sort((a, b) => a.localeCompare(b));
  const pots: SlotDescriptor[][] = expandTake([{ kind: "topNPerGroup", n }], { poolKeys });
  return pots.flat().map((d) => {
    if (d.kind !== "group_rank") {
      throw new Error(`topNPerGroup produced a non-group_rank descriptor: ${d.kind}`);
    }
    const table = source.find((t) => t.poolKey === d.pool);
    const row = table?.rows.find((r) => r.rank === d.rank);
    if (row === undefined) throw new Error(`no row for ${d.pool}${d.rank}`);
    return row.entrant;
  });
}

/** The WRONG answer this whole task exists to exclude: group-before-rank
 *  (A1, A2, B1, B2 …). Same membership as the right answer, different seats. */
function groupBeforeRank(source: readonly QualifierTable[], n: number): string[] {
  return [...source]
    .filter((t) => t.poolKey !== undefined)
    .sort((a, b) => (a.poolKey ?? "").localeCompare(b.poolKey ?? ""))
    .flatMap((t) =>
      [...t.rows]
        .sort((x, y) => x.rank - y.rank)
        .filter((r) => r.rank <= n)
        .map((r) => r.entrant),
    );
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("expectedQualifierRefs", () => {
  // The EMPTY case first (AGENTS.md, competition-desk _RULES: an empty set
  // answers no to every question and lands on whatever the default is).
  it("returns nothing when no table declares a pool — the empty case, stated first", () => {
    expect(
      expectedQualifierRefs([{ poolKey: undefined, rows: tables[0]!.rows }], {
        kind: "topNPerGroup",
        n: 2,
      }),
    ).toEqual([]);
  });

  it("orders rank before group: every pool's winner, then every pool's runner-up", () => {
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 2 })).toEqual([
      "e-a1",
      "e-b1",
      "e-a2",
      "e-b2",
    ]);
  });

  it("is not merely grouping by pool — the ORDERING-differential case", () => {
    // Group-before-rank would give a1,a2,b1,b2. Any test whose expectation is
    // a SET cannot tell the two apart, so assert the sequence.
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 2 })).not.toEqual([
      "e-a1",
      "e-a2",
      "e-b1",
      "e-b2",
    ]);
  });

  it("takes only the declared N per pool", () => {
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 1 })).toEqual([
      "e-a1",
      "e-b1",
    ]);
  });

  it("orders pools by key so a pack's declaration order cannot change the seats", () => {
    expect(
      expectedQualifierRefs([tables[1]!, tables[0]!], { kind: "topNPerGroup", n: 2 }),
    ).toEqual(["e-a1", "e-b1", "e-a2", "e-b2"]);
  });

  it("ignores the unpooled table when a pooled one is present", () => {
    // A stage-wide table sitting beside per-pool tables must not contribute
    // seats: the pooled rows are the ones the progression reads.
    const mixed: QualifierTable[] = [
      ...tables,
      { poolKey: undefined, rows: [{ entrant: "e-zz", rank: 1 }] },
    ];
    const refs = expectedQualifierRefs(mixed, { kind: "topNPerGroup", n: 2 });
    expect(refs).toEqual(["e-a1", "e-b1", "e-a2", "e-b2"]);
    expect(refs).not.toContain("e-zz");
  });

  it("takes nothing when N is zero — no seats, rather than every seat", () => {
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 0 })).toEqual([]);
  });
});

describe("the ordering-differential, four pools deep", () => {
  it("agrees with the ENGINE's own expansion of the same take rule", () => {
    const expected = engineExpectedRefs(fourPools, 2);
    // Vacuity guard: a broken derivation that returned [] would otherwise
    // "agree" with an equally broken bench implementation.
    expect(expected.length).toBe(8);
    expect(expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 2 })).toEqual(expected);
  });

  it("differs from group-before-rank in SEQUENCE while matching it in MEMBERSHIP", () => {
    // This is the case the task exists for. A membership-only comparator
    // passes on BOTH lists; only an order-checking one separates them.
    const ours = expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 2 });
    const wrong = groupBeforeRank(fourPools, 2);
    expect(sorted(ours)).toEqual(sorted(wrong)); // same entrants …
    expect(ours).not.toEqual(wrong); // … different seats
    expect(ours).toEqual(["e-a1", "e-b1", "e-c1", "e-d1", "e-a2", "e-b2", "e-c2", "e-d2"]);
  });

  it("keeps rank-before-group at N=3, not just at N=2", () => {
    const expected = engineExpectedRefs(fourPools, 3);
    expect(expected.length).toBe(12);
    expect(expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 3 })).toEqual(expected);
    // The wrong shape is genuinely different here too, so this row can
    // witness the regression rather than agreeing with both answers.
    expect(expected).not.toEqual(groupBeforeRank(fourPools, 3));
  });
});

// ---------------------------------------------------------------------------
// THE SEAM — a derivation nothing asserts against the product is inert
// (AGENTS.md failure class 1, six recurrences). These drive the REAL consumer:
// `advance.ts`'s `compareQualifiers`, and the full `advanceStageSeeding` flow
// that calls it, with only the HTTP transport doubled. Nothing hand-builds an
// expected row in between — the bench's own derivation goes in one end and
// the product's D7 verdict comes out the other.
// ---------------------------------------------------------------------------
describe("the derivation drives the real qualifier comparison (D7)", () => {
  const idOf = (ref: string) => `id-${ref}`;

  function proposalFor(refs: readonly string[]) {
    return refs.map((ref, i) => ({ rank: i + 1, entrantId: idOf(ref) }));
  }

  it("matches when the product proposes the pack's rank-before-group order", () => {
    const refs = expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 2 });
    const check = compareQualifiers(refs.map(idOf), proposalFor(refs));
    expect(check.matched).toBe(true);
  });

  it("REDS when the product proposes the same entrants group-before-rank", () => {
    // The regression this seam exists to catch: right people, wrong seats.
    const refs = expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 2 });
    const wrong = groupBeforeRank(fourPools, 2);
    expect(sorted(wrong)).toEqual(sorted([...refs])); // membership is identical …
    const check = compareQualifiers(refs.map(idOf), proposalFor(wrong));
    expect(check.matched).toBe(false); // … and the comparison still fails
  });

  it("stops the live advance flow cold — confirm/generate are never called", async () => {
    const refs = expectedQualifierRefs(fourPools, { kind: "topNPerGroup", n: 2 });
    const wrong = groupBeforeRank(fourPools, 2);
    const calls: string[] = [];
    const transport: AdvanceTransport = {
      raw(_base, _s, path, method) {
        calls.push(`${method ?? "GET"} ${path}`);
        if (path.endsWith("/seed-proposal")) {
          return Promise.resolve({
            status: 201,
            json: {
              ok: true,
              data: {
                id: "proposal-1",
                stageId: "stage-target",
                status: "draft",
                computed: { qualifiers: proposalFor(wrong), standingsHash: "h" },
              },
            },
          } as Awaited<ReturnType<AdvanceTransport["raw"]>>);
        }
        throw new Error(`unexpected call: ${method ?? "GET"} ${path}`);
      },
    };

    const outcome = await advanceStageSeeding({
      base: "http://bench.example",
      session: newSession(),
      stageId: "stage-target",
      expectedQualifierEntrantIds: refs.map(idOf),
      transport,
    });

    expect(outcome.qualifierCheck.matched).toBe(false);
    expect(outcome.confirmed).toBeUndefined();
    expect(outcome.generated).toBeUndefined();
    expect(calls).toEqual(["POST /api/v1/stages/stage-target/seed-proposal"]);
  });
});
