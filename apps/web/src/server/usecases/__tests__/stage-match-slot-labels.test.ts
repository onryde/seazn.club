// P7/F1: generateStageFixtures now persists home_slot_label/away_slot_label
// for a slot fed by an earlier-round match WITHIN the same generation
// (g.homeFrom/g.awayFrom — the intra-bracket case bracketToGen produces).
// Before this, ONLY the .seeding path's cross-stage descriptors
// (descriptorLabel, stage-seeding.ts, untouched by this task) wrote this
// column; a plain knockout's own round-2+ TBD slots left it null, so the org
// bracket panel and the public bracket showed bare "TBD" for them (brief's
// defect (b) — both bracket surfaces show nothing).
import { describe, expect, it, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

type LabelRow = {
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key: string; params: { round: number; seq: number } } | null;
  away_slot_label: { key: string; params: { round: number; seq: number } } | null;
};

async function makeKnockoutDivision(config: Record<string, unknown> = {}) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Match Slot Labels " + JSON.stringify(config),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "knockout",
    name: "Knockout",
    config,
  });
  return { auth, stage: stage! };
}

describe.skipIf(!HAS_DB)("generateStageFixtures — match-sourced slot labels (P7/F1)", () => {
  it("a round-2 fixture fed by round-1 winners gets {key:'slot.winner_match', params:{round,seq}} (numbers); round-1's baked-entrant fixtures get NULL", async () => {
    const { auth, stage } = await makeKnockoutDivision();
    const { created } = await generateStageFixtures(auth, stage.id);
    expect(created).toBe(3); // 4 entrants: 2 semis (round 1) + 1 final (round 2)

    const rows = await sql<LabelRow[]>`
      select round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
      from fixtures where stage_id = ${stage.id} order by round_no, seq_in_round`;

    const round1 = rows.filter((r) => r.round_no === 1);
    const round2 = rows.filter((r) => r.round_no === 2);
    expect(round1).toHaveLength(2);
    expect(round2).toHaveLength(1);

    // Round 1: both sides are REAL, seeded entrants at generation time — no
    // slot label, NULL on both columns.
    for (const r of round1) {
      expect(r.home_entrant_id).not.toBeNull();
      expect(r.away_entrant_id).not.toBeNull();
      expect(r.home_slot_label).toBeNull();
      expect(r.away_slot_label).toBeNull();
    }

    // Round 2 (the final): both sides are TBD, fed by the two round-1
    // matches' WINNERS. Don't assume which round-1 seq feeds home vs away
    // (that's the bracket generator's own convention, not this task's
    // concern) — assert the SET of {round,seq} the final's two labels name
    // is exactly the SET of round-1 fixtures that exist.
    const final = round2[0]!;
    expect(final.home_entrant_id).toBeNull();
    expect(final.away_entrant_id).toBeNull();
    expect(final.home_slot_label).not.toBeNull();
    expect(final.away_slot_label).not.toBeNull();
    expect(final.home_slot_label!.key).toBe("slot.winner_match");
    expect(final.away_slot_label!.key).toBe("slot.winner_match");
    expect(typeof final.home_slot_label!.params.round).toBe("number");
    expect(typeof final.home_slot_label!.params.seq).toBe("number");

    const fedRefs = [final.home_slot_label!.params, final.away_slot_label!.params].sort((a, b) => a.seq - b.seq);
    const round1Refs = round1.map((r) => ({ round: r.round_no, seq: r.seq_in_round })).sort((a, b) => a.seq - b.seq);
    expect(fedRefs).toEqual(round1Refs);
  });

  it("thirdPlace: true feeds the bronze match from the semis' LOSERS — slot.loser_match, never baked into params as rendered text", async () => {
    const { auth, stage } = await makeKnockoutDivision({ thirdPlace: true });
    await generateStageFixtures(auth, stage.id);

    const rows = await sql<LabelRow[]>`
      select round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
      from fixtures where stage_id = ${stage.id} order by round_no, seq_in_round`;

    const labels = rows
      .flatMap((r) => [r.home_slot_label, r.away_slot_label])
      .filter((l): l is NonNullable<LabelRow["home_slot_label"]> => l !== null);
    const loserLabels = labels.filter((l) => l.key === "slot.loser_match");
    expect(loserLabels.length).toBeGreaterThan(0);
    for (const l of loserLabels) {
      expect(typeof l.params.round).toBe("number");
      expect(typeof l.params.seq).toBe("number");
      // Never a pre-rendered fragment sneaking into params under another key.
      expect(Object.keys(l.params).sort()).toEqual(["round", "seq"]);
    }
  });
});
