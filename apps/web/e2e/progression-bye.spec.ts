import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  apiJson,
  TAG,
  divisionPath,
  expectNoHorizontalScroll,
  screenshotAtWidths,
} from "./helpers";

// A structural bye in a PROGRESSION-SEEDED bracket, read off the SCREEN.
//
// The defect: every progression-bearing template declares
// `timing: "setup"`, so the bracket is drawn before anyone has qualified and
// the walkover cannot be baked at generation time. Nothing wrote it at
// confirm time either, so the bye line reached the organiser as
// `home = <top qualifier>, away = null, scheduled, outcome null` — which
// `isBye` reads as false, so the run sheet and the bracket panel both showed
// an ordinary open match awaiting a draw, on a fixture nobody can ever play.
//
// The DB-level proof lives in
// `server/usecases/__tests__/progression-bye-is-decided.test.ts`. This spec
// exists because that one cannot see the screen (AGENTS.md failure class 2:
// `apps/web` vitest is `environment: "node"`, and the panel/sheet render
// through `resolveSlotLabel` and the run sheet's own bye branch). It drives
// league_ko's shape — a league feeding a Top 3 knockout — over the real HTTP
// boundary and then reads the two surfaces the walkthrough found it on.

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** The SHIPPED English copy, so a copy assertion moves with the dictionary
 *  instead of freezing yesterday's sentence (the idiom `run-sheet.spec.ts`
 *  and four others already use). */
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

interface FixtureWire {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
}

test("a progression-seeded bye reads as a bye on the run sheet and in the bracket", async ({
  page,
  request,
}, testInfo) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Bye E2E ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual",
      display_name: `E${i + 1}`,
      seed: i + 1,
    })),
  );
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);
  const nameOf = new Map(entrants.data!.map((e) => [e.id, e.display_name]));

  // league_ko's own shape: a league feeding a Top 3 knockout. THREE
  // qualifiers pad to a bracket of four, so the table's winner takes the
  // spare line — the exact draw the defect was found on, and one that
  // predates Swiss Knockout by months.
  const stages = await apiJson<{ id: string; kind: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "Finals",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status, JSON.stringify(stages.error)).toBe(201);
  const leagueStageId = stages.data!.find((s) => s.kind === "league")!.id;
  const koStageId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const koGen = await apiJson<{ fixtures: FixtureWire[] }>(
    request,
    `/api/v1/stages/${koStageId}/generate`,
    "POST",
  );
  expect(koGen.status, JSON.stringify(koGen.error)).toBe(200);

  const leagueGen = await apiJson<{ fixtures: FixtureWire[] }>(
    request,
    `/api/v1/stages/${leagueStageId}/generate`,
    "POST",
  );
  expect(leagueGen.status, JSON.stringify(leagueGen.error)).toBe(200);
  expect(leagueGen.data!.fixtures).toHaveLength(6); // 4 entrants, single round robin

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

  // The LOWER-numbered entrant always wins, whichever side of the board it is
  // on: 3/2/1/0 wins, a table strict on points with no tiebreaker in play, so
  // the bye belongs to E1 and the screenshots below say something an owner can
  // check by eye.
  for (const f of leagueGen.data!.fixtures) {
    const homeWins =
      Number(nameOf.get(f.home_entrant_id!)!.slice(1)) <
      Number(nameOf.get(f.away_entrant_id!)!.slice(1));
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
    const scored = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 },
    });
    expect(scored.status, JSON.stringify(scored.error)).toBe(201);
  }

  const completed = await apiJson<{ completed: boolean; seed_proposal?: { id: string } }>(
    request,
    `/api/v1/stages/${leagueStageId}/complete`,
    "POST",
  );
  expect(completed.status, JSON.stringify(completed.error)).toBe(200);
  expect(completed.data!.completed).toBe(true);

  const confirmed = await apiJson<{ fixtures: FixtureWire[] }>(
    request,
    `/api/v1/stages/${koStageId}/seed-proposal/confirm`,
    "POST",
    { proposalId: completed.data!.seed_proposal!.id },
  );
  expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);

  // The wire shape first — if this is wrong the screen assertions below would
  // be chasing the right pixels for the wrong reason.
  const firstRound = Math.min(...confirmed.data!.fixtures.map((f) => f.round_no));
  const byes = confirmed.data!.fixtures.filter(
    (f) => f.round_no === firstRound && (f.home_entrant_id === null) !== (f.away_entrant_id === null),
  );
  expect(byes, "a Top 3 bracket holds exactly one bye line").toHaveLength(1);
  const bye = byes[0]!;
  expect(bye.status).toBe("forfeited");
  expect(bye.outcome?.kind).toBe("award");
  const byeName = nameOf.get(bye.home_entrant_id ?? bye.away_entrant_id!)!;
  expect(byeName, "the bye belongs to the league winner").toBe("E1");

  // The SERVING payload, not just the confirm's own echo: this is the list
  // the desk reads, and a fix that lands in the table but not here is still a
  // defect on screen. It is also the shape `scripts/smoke.ts` asserts, so
  // this is where the premise under that check is proven.
  const listed = await apiJson<(FixtureWire & { away_slot_label: { key?: string } | null })[]>(
    request,
    `/api/v1/divisions/${divisionId}/fixtures`,
  );
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  const served = listed.data!.find((f) => f.id === bye.id)!;
  expect(served.status).toBe("forfeited");
  expect(served.outcome).toMatchObject({ kind: "award", winner: bye.home_entrant_id });
  expect(served.away_slot_label?.key).toBe("bracket.slot.bye");

  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));

  // ── The run sheet ────────────────────────────────────────────────────────
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  // Copy from the dictionary, not typed here — `{name} has a bye`.
  const byeSentence = UI_EN["schedule.bye"]!.replace("{name}", byeName);
  // PRINT WHAT WAS SEEN beside the gate (_RULES.md): a green gate on the
  // wrong state is worse than a red one, and "no open match" below is a
  // negative assertion that an empty page would satisfy vacuously.
  const sheetText = (await sheet.innerText()).replace(/\s+/g, " ");
  console.log("run sheet text:", sheetText.slice(0, 600));
  expect(sheetText, `expected the bye sentence "${byeSentence}"`).toContain(byeSentence);

  // …and the phrase the DEFECT put there instead. "Awaiting draw" is the
  // sentence an un-decided bracket slot carries, and before the fix the bye
  // line carried it too — beside a real entrant's name, on a match that could
  // never be played. Its POSITIVE pair is the assertion above: both are
  // required, or "contains no TBD" passes on a blank page.
  const byeRow = sheet.locator("li", { hasText: byeSentence });
  await expect(byeRow).toHaveCount(1);
  await expect(byeRow).not.toContainText(UI_EN["bracket.tbd"] ?? "TBD");

  // ── The bracket panel ────────────────────────────────────────────────────
  const bracket = page.getByTestId("bracket-panel");
  await expect(bracket).toBeVisible();
  const bracketText = (await bracket.innerText()).replace(/\s+/g, " ");
  console.log("bracket panel text:", bracketText.slice(0, 600));
  // The phantom side names itself: `bracket.slot.bye`, the label the seeded
  // generation now stamps, resolved through the panel's own resolveSlotLabel.
  expect(bracketText, "the bye's empty seat must say Bye, not TBD").toContain(
    UI_EN["bracket.slot.bye"]!,
  );
  // Its differential. This used to be "the panel holds exactly ONE TBD — the
  // Final's open side, genuinely waiting on the semi winner", against TWO
  // before the original fix, the second being the bye's phantom seat falling
  // through to the same generic placeholder.
  //
  // That Final seat is no longer nameless: the tree now reads the bracket FEED
  // edges, so it says "Winner of R1·2" (owner ruling 2026-09-21 — the tree and
  // the draw list below it must agree). The differential therefore tightens
  // rather than relaxes: this draw now has NO generic placeholder at all, and
  // the bye's seat is still the only one saying Bye. A bye that regressed back
  // to the placeholder would take the count from 0 to 1 and red this line, so
  // the case still witnesses the regression it exists for — and a Final seat
  // that lost its feeder would do the same.
  const tbd = UI_EN["bracket.tbd"]!;
  const tbdCount = bracketText.split(tbd).length - 1;
  expect(tbdCount, `bracket panel read: ${bracketText}`).toBe(0);
  const byeLabel = UI_EN["bracket.slot.bye"]!;
  expect(bracketText.split(byeLabel).length - 1, `bracket panel read: ${bracketText}`).toBe(1);
  // The POSITIVE half: the seat that used to carry that one TBD now names the
  // match it is waiting on, rather than having gone blank. Built from the
  // SHIPPED dictionary like every other copy assertion in this file — a
  // hand-typed "Winner of R1·2" freezes today's sentence, and an
  // `|Ganador de` alternative would let the EN leg pass on Spanish copy.
  const feederSentence = UI_EN["slot.winner_match"]!.replace(
    "{ext}",
    UI_EN["slot.match_ref"]!.replace("{round}", "1").replace("{seq}", "2"),
  );
  expect(bracketText, `bracket panel read: ${bracketText}`).toContain(feederSentence);

  // ── Desktop, tablet and phone ────────────────────────────────────────────
  // AGENTS.md's bar is 1280 / 768 / 320; 375 is added because that is the
  // width the walkthrough that found this defect was driven at.
  const WIDTHS = [1280, 768, 375, 320];
  await screenshotAtWidths(page, testInfo, "progression-bye", WIDTHS);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("run-sheet")).toBeVisible();
    await expect(page.getByTestId("run-sheet")).toContainText(byeSentence);
    await expectNoHorizontalScroll(page);
  }
});
