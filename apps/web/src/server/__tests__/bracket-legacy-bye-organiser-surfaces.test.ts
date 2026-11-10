// N-1 on the organiser's two other bracket surfaces (W4 app A, B6b fix round 1, review finding 1).
//
// Task 22 made a settled bye's empty seat read the bye's word on the console tile, the public card and the public
// /present bracket. Two siblings still fell back to "TBD" for the legacy shape — a one-seat award with no reason and no
// stored seat label (the pre-flight census's double-elimination byes): the ORGANISER /present bracket slide
// (`buildDivisionSlides`) and the printed bracket poster (`buildDivisionDocModel(…, "bracket")`). Both now ask the one
// predicate (`lib/bracket-bye-seat.ts`). Driven through the real generator and the real readers; the legacy row is
// made by stripping today's stamped label and reason from a bye the generator wrote.
//
// Kinds: knockout and double elimination — the two draws that seat byes (a stepladder or page playoff has none).
// Sport: generic — a seat's word does not depend on the sport.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import { createEntrants } from "@/server/usecases/entrants";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { buildDivisionSlides } from "@/server/slideshow-data";

const HAS_DB = !!process.env.DATABASE_URL;
const BYE = msgFor("en", "bracket.slot.bye");
const TBD = msgFor("en", "bracket.tbd");

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Seat { id: string; home: string | null; away: string | null }

/** A three-entrant draw whose first-round bye is rewritten into the legacy shape, its seated side on `seated`. */
async function legacyByeDraw(kind: "knockout" | "double_elim", seated: "home" | "away") {
  const { auth } = await seedOrg("pro"); // double elimination is Pro-gated
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Legacy bye ${kind}`, visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(auth, div.id, ["Ash", "Birch", "Cedar"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, div.id, { seq: 1, kind, name: kind, config: {} });
  await generateStageFixtures(auth, stage!.id);
  const byes = await sql<{ id: string; winner: string }[]>`
    select id, outcome->>'winner' as winner from fixtures
    where stage_id = ${stage!.id} and outcome->>'kind' = 'award' and (home_entrant_id is null) <> (away_entrant_id is null)`;
  expect(byes, `${kind}: premise — the generator seats exactly one first-round bye`).toHaveLength(1);
  const bye = byes[0]!;
  // The legacy shape: the seated side wins an award with no reason; neither seat carries a stored label.
  await sql`
    update fixtures set
      home_entrant_id = ${seated === "home" ? bye.winner : null},
      away_entrant_id = ${seated === "away" ? bye.winner : null},
      home_slot_label = null, away_slot_label = null,
      outcome = outcome - 'reason'
    where id = ${bye.id}`;
  // The positive pair: a seat still waiting on a result, with no label either — that one IS "to be decided".
  const [waiting] = await sql<{ id: string }[]>`
    update fixtures set away_slot_label = null, away_entrant_id = null
    where id = (select id from fixtures where stage_id = ${stage!.id} and round_no = 2 and seq_in_round = 1)
    returning id`;
  expect(waiting, `${kind}: premise — the round-2 match exists`).toBeDefined();
  return { auth, divId: div.id, byeId: bye.id, waitingId: waiting!.id };
}

describe.skipIf(!HAS_DB)("N-1 a legacy settled bye reads the bye's word on the organiser /present and the bracket poster", () => {
  it("both kinds, the empty seat on either side: the bye word on both surfaces; an unlabelled waiting seat stays TBD", async () => {
    let checked = 0;
    for (const kind of ["knockout", "double_elim"] as const) {
      for (const seated of ["home", "away"] as const) {
        const empty = seated === "home" ? "away" : "home";
        const d = await legacyByeDraw(kind, seated);

        const slides = await buildDivisionSlides(d.auth, d.divId, "Open");
        const slide = slides.find((s) => s.kind === "bracket") as { fixtures: Seat[] } | undefined;
        expect(slide, `${kind}: the organiser board lays the draw out as a bracket`).toBeDefined();
        const onBoard = slide!.fixtures.find((f) => f.id === d.byeId)!;
        expect(onBoard[seated], `${kind}/${seated}: premise — the bye's winner is named`).toBe("Ash");
        expect(onBoard[empty], `${kind}/${seated}: organiser /present, the bye's empty seat`).toBe(BYE);
        expect(slide!.fixtures.find((f) => f.id === d.waitingId)!.away, `${kind}: organiser /present, a waiting seat`).toBe(TBD);

        const model = await buildDivisionDocModel(d.auth, d.divId, "bracket", { printedAt: "2026-07-20T09:00:00.000Z" });
        const nodes: { fixtureId: string; home: string | null; away: string | null }[] = model.bracket?.nodes ?? model.bracketDe?.nodes ?? [];
        const onPoster = nodes.find((n) => n.fixtureId === d.byeId);
        expect(onPoster, `${kind}: the poster draws the bye`).toBeDefined();
        expect(onPoster![seated], `${kind}/${seated}: premise — the poster names the bye's winner`).toBe("Ash");
        expect(onPoster![empty], `${kind}/${seated}: bracket poster, the bye's empty seat`).toBe(BYE);
        expect(nodes.find((n) => n.fixtureId === d.waitingId)!.away, `${kind}: bracket poster, a waiting seat`).toBe(TBD);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 kinds x 2 seats").toBe(4);
  });
});
