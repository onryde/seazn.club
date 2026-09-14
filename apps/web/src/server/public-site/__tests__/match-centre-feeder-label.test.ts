// Fix round N1 — the public match centre names a waiting side by its feeder's
// ROUND, the way the hub's Knockout rail names that round.
//
// A knockout final generated with both semi-finals unplayed stores each side's
// slot label as `{ key: "slot.winner_match", params: { round, seq } }` — the
// FEEDER's `round_no` / `seq_in_round` (`usecases/stages.ts`, `matchSlotLabel`).
// The organiser board renders that as "Winner of R1·2" (`lib/slot-label.ts`,
// `matchRef`), a short code that means nothing on a public page. The match
// centre must read "Winner of Semi-finals, match 2": the round name from the
// SAME namer the rail uses (`roundRoleLabel` over `roundRoleFor`, over the
// stage's own rows) and the match's place in that round.
//
// Driven through `publicFixture`, the API loader, so the real `loadMatchCentre`
// reads the real stored label and the real stage rows. Real Postgres required;
// skipped without DATABASE_URL, like every DB-backed suite here.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { publicFixture } from "@/server/usecases/public";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import type { MatchCentreDocT } from "../match-centre-schema";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type FeederLabel = { key: string; params: { round: number; seq: number } };
type StageRow = {
  id: string;
  round_no: number;
  seq_in_round: number;
  lane: "WB" | "LB" | "GF" | null;
  is_final: boolean | null;
  third_place: boolean | null;
  conditional: boolean | null;
  home_slot_label: FeederLabel | null;
  away_slot_label: FeederLabel | null;
};

const ui = (key: Parameters<typeof msgFor>[1], vars?: Record<string, string | number>) => msgFor("en", key, vars);

/** A public, English, generated 4-draw knockout, unplayed: its final waits on
 *  both semi-finals. Returns the stage's stored rows, the final, and the rail's
 *  round namer over those rows. */
async function knockoutFinal() {
  const { auth } = await seedOrg("pro");
  // English on purpose, so the literal anchors are not conditional.
  await sql`update organizations set default_locale = 'en' where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "N1 Feeder Cup",
    visibility: "public", // public_fixtures_v filters on this
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
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
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Knockout", config: {} });
  await generateStageFixtures(auth, stage!.id);

  const rows = await sql<StageRow[]>`
    select id, round_no, seq_in_round, lane, is_final, third_place, conditional,
           home_slot_label, away_slot_label
    from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const final = rows.find((r) => r.home_slot_label?.key === "slot.winner_match");
  // The premise, from the stored rows: a final whose BOTH sides wait on a semi.
  expect(final, JSON.stringify(rows)).toBeDefined();
  expect(final!.away_slot_label?.key).toBe("slot.winner_match");

  /** The feeder's round, named by the rail's own namer over THIS stage's rows. */
  const railName = (label: FeederLabel) => {
    const feeder = rows.find((r) => r.round_no === label.params.round && r.seq_in_round === label.params.seq)!;
    return roundRoleLabel(
      ui,
      roundRoleFor(
        rows.map((r) => ({ round_no: r.round_no, lane: r.lane })),
        {
          round_no: feeder.round_no,
          lane: feeder.lane,
          is_final: feeder.is_final === true,
          third_place: feeder.third_place === true,
          conditional: feeder.conditional === true,
        },
        "knockout",
      ),
    );
  };
  return { final: final!, railName, dict: await getDictionary("en", "public") };
}

const sideNames = async (fixtureId: string) =>
  ((await publicFixture(fixtureId)) as { match_centre: MatchCentreDocT }).match_centre.header.sides.map(
    (s) => s.name,
  );

describe.skipIf(!HAS_DB)("the public match centre — a feeder slot names its ROUND (fix round N1)", () => {
  it("a knockout final waiting on both semi-finals reads 'Winner of Semi-finals, match N' on each side — the rail's round name, never the board's R·code", async () => {
    const { final, railName, dict } = await knockoutFinal();
    const labels = [final.home_slot_label!, final.away_slot_label!];
    expect(labels.map(railName)).toEqual([msgFor("en", "bracket.round.semi"), msgFor("en", "bracket.round.semi")]);

    const names = await sideNames(final.id);

    expect(names).toEqual(
      labels.map((label) => t(dict, "knockout.feederWinner", { round: railName(label), seq: label.params.seq })),
    );
    expect([...names].sort()).toEqual(["Winner of Semi-finals, match 1", "Winner of Semi-finals, match 2"]);
    // Today's text is the board's short code; the match centre no longer shows it.
    expect(names).not.toEqual(labels.map((label) => resolveSlotLabel(label, ui, "schedule.tbd")));
    expect(names.join(" | ")).not.toMatch(/R\d+·\d+/);
  });

  it("a feeder label that names no match of the stage keeps today's text — never a round name for a match that is not there", async () => {
    const { final, railName, dict } = await knockoutFinal();
    const home = final.home_slot_label!;
    // Semi-final 9 does not exist: round 1 of a 4-draw has two matches. Round 1
    // itself does, so only a lookup that checks the seq can tell.
    expect(home.params.round).toBe(1);
    const stale: FeederLabel = { key: "slot.winner_match", params: { round: 1, seq: 9 } };
    await sql`update fixtures set away_slot_label = ${sql.json(stale)} where id = ${final.id}`;

    const [homeName, awayName] = await sideNames(final.id);

    expect(awayName).toBe(resolveSlotLabel(stale, ui, "schedule.tbd"));
    expect(awayName).toBe("Winner of R1·9");
    // The positive pair, same fixture: the side whose feeder exists is round-named.
    expect(homeName).toBe(t(dict, "knockout.feederWinner", { round: railName(home), seq: home.params.seq }));
  });
});
