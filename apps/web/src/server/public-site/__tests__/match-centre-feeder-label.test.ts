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
import { afterAll, describe, expect, it, vi } from "vitest";

// The hub loader (`loadCompetitionHub`, fix round 1 M3 below) reads through
// `unstable_cache`, a Next server-runtime API with no incremental cache outside
// a real request: a passthrough, never a memoising double.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
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
import type { MessageKey } from "@/lib/messages";
import { loadCompetitionHub } from "../competition-hub";

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
    expect([...names].sort()).toEqual(["Winner of Semi-finals, match\u00a01", "Winner of Semi-finals, match\u00a02"]);
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

// Fix round 1, M3 — a page playoff's rounds are Qualifier 1, the Eliminator,
// Qualifier 2 and the Final. The engine can only tell Qualifier 1 from the
// Eliminator by the generator's stable id (`fixtures.ext_key`, "pp-q1" /
// "pp-elim"): they share round one and a match count. Without that id the rail
// named both "Quarter-finals" and Qualifier 2 "Semi-finals", and N1 copied those
// names into every waiting slot — Qualifier 2 read "Loser of Quarter-finals,
// match 1". Driven through the engine's REAL generator and both real loaders.
describe.skipIf(!HAS_DB)("a generated page playoff names its rounds by the playoff's own names (fix round 1, M3)", () => {
  it("the rail reads Qualifier 1 / Eliminator / Qualifier 2 / Final, and Qualifier 2's waiting sides read 'Loser of Qualifier 1' / 'Winner of Eliminator' on the hub and in the match centre", async () => {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set default_locale = 'en' where id = ${auth.orgId}`;
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "M3 Page Playoff",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Playoffs",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      ["P1", "P2", "P3", "P4"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "page_playoff", name: "Playoffs", config: {} });
    await generateStageFixtures(auth, stage!.id);

    const rows = await sql<(StageRow & { ext_key: string | null })[]>`
      select id, round_no, seq_in_round, lane, is_final, third_place, conditional,
             home_slot_label, away_slot_label, ext_key
      from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
    const byExt = new Map(rows.map((r) => [r.ext_key, r]));
    // The premise, from the stored rows: the engine's four playoff matches, with
    // Qualifier 1 and the Eliminator sharing round one and Qualifier 2 waiting
    // on the loser of one and the winner of the other.
    expect([...byExt.keys()].sort(), JSON.stringify(rows)).toEqual(["pp-elim", "pp-final", "pp-q1", "pp-q2"]);
    const [q1, elim, q2, final] = ["pp-q1", "pp-elim", "pp-q2", "pp-final"].map((k) => byExt.get(k)!);
    expect(elim!.round_no).toBe(q1!.round_no);
    expect(q2!.home_slot_label).toEqual({ key: "slot.loser_match", params: { round: q1!.round_no, seq: q1!.seq_in_round } });
    expect(q2!.away_slot_label).toEqual({ key: "slot.winner_match", params: { round: elim!.round_no, seq: elim!.seq_in_round } });

    /** A match's round name by the engine's own role for its generator id —
     *  what the rail must say for it. */
    const roleName = (r: StageRow & { ext_key: string | null }) =>
      roundRoleLabel(
        ui,
        roundRoleFor(
          rows.map((x) => ({ round_no: x.round_no, lane: x.lane })),
          {
            round_no: r.round_no,
            lane: r.lane,
            is_final: r.is_final === true,
            third_place: r.third_place === true,
            conditional: r.conditional === true,
          },
          "page_playoff",
          r.ext_key,
        ),
      );
    const playoff = [q1!, elim!, q2!, final!];
    expect(playoff.map(roleName)).toEqual(
      (["bracket.round.qualifier1", "bracket.round.eliminator", "bracket.round.qualifier2", "bracket.round.final"] as MessageKey[]).map((k) =>
        msgFor("en", k),
      ),
    );

    // The hub: one rail round per playoff round, in playoff order, each named.
    const [slugs] = await sql<{ org: string; competition: string }[]>`
      select o.slug as org, c.slug as competition
      from competitions c join organizations o on o.id = c.org_id where c.id = ${competition.id}`;
    const doc = (await loadCompetitionHub(slugs!.org, slugs!.competition))!;
    const view = doc.knockouts.find((v) => v.stageId === stage!.id);
    expect(view, JSON.stringify(doc.knockouts)).toBeDefined();
    expect(view!.rounds.map((r) => r.fixtureIds)).toEqual(playoff.map((r) => [r.id]));
    expect(view!.rounds.map((r) => r.label)).toEqual(playoff.map(roleName));

    // The waiting slots name those rounds. Each holds ONE match, so the round
    // name stands alone (M2).
    const { dict } = { dict: await getDictionary("en", "public") };
    const hubNames = (id: string) => doc.matches.find((m) => m.fixtureId === id)!.header.sides.map((s) => s.name);
    const q2Names = [
      t(dict, "knockout.feederLoserOnly", { round: roleName(q1!) }),
      t(dict, "knockout.feederWinnerOnly", { round: roleName(elim!) }),
    ];
    expect(q2Names).toEqual(["Loser of Qualifier 1", "Winner of Eliminator"]);
    expect(hubNames(q2!.id)).toEqual(q2Names);
    expect(hubNames(final!.id)).toEqual([
      t(dict, "knockout.feederWinnerOnly", { round: roleName(q1!) }),
      t(dict, "knockout.feederWinnerOnly", { round: roleName(q2!) }),
    ]);

    // The match centre says exactly what the hub card says.
    expect(await sideNames(q2!.id)).toEqual(q2Names);
    expect(await sideNames(final!.id)).toEqual(hubNames(final!.id));
  });
});
