// ONE organiser laying out a three-round Swiss, BEFORE the tournament starts —
// and then doing the thing every club night does between the draw going up and
// the first round being called: two more people turn up, and one drops out.
//
// The organiser's own words for what they expect, which is this file's whole
// acceptance criterion: "hope that generate will keep the schedule as only
// affect new or deleted entrants."
//
// ── WHY THIS IS A WALKTHROUGH AND NOT A UNIT TEST ──────────────────────────
// `swiss-withdrawal-reconcile.test.ts` proves the reconcile's arithmetic, and
// `swiss-shell.spec.ts` proves a pinned slot survives Pair for the round being
// paired. Neither can see the thing the organiser actually complained about,
// because it is not arithmetic and it is not one round: pre-Start, an organiser
// lays courts and times out across EVERY round at once. When the field then
// moves, a round still minted for the old field has no board to hang the new
// player on — so it cannot be scheduled at all, and the organiser only finds
// out when Pair finally reaches it, days later, with the timetable already
// printed. The reconcile used to be LAZY (target round only); `485b812dd` made
// it EAGER before Start, for every wholly unseated round.
//
// THE DIFFERENTIAL. Against the lazy code both tests below still Pair round 1
// perfectly happily — the shortfall shows up only in rounds 2 and 3, as a board
// count that no longer matches the field and a `-bye` row that is present when
// it should be gone (or gone when it should be present). So the assertions that
// tell the two builds apart are the round-2 AND round-3 control sets read
// immediately after Generate, and the fact that the NEW board renders as a
// schedulable row. Everything else in this file passes on both.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the API: the competition, the division, the Swiss stage and its
// round budget, the starting field, and the venue whose courts the organiser
// picks from.
// THE TEST, in the browser: Generate, the time-and-court pin on a LATER round's
// TBD shell, every enrolment and every deletion (typed into the add form,
// pressed on the row, confirmed in the dialog), Pair next, and the read-back of
// what rounds 2 and 3 now look like on the organiser's own screen.
//
// ── ONE SAMPLE IS NOT A PARITY SWEEP ──────────────────────────────────────
// Two tests, two directions, because a bye appearing and a bye disappearing are
// different branches of `reconcileSwissRoundShells` (mint vs delete):
//
//   A. 6 → +4 → −1 → 9.  EVEN to ODD. Boards 3 → 4, and `-bye` APPEARS.
//   B. 9 → +1 → −4 → 6.  ODD to EVEN. Boards 4 → 3, and `-bye` DISAPPEARS —
//      and because the board count falls, B is also the only one of the two
//      that drives the destructive half (a surplus board deleted from the
//      highest `seq_in_round` down) while the organiser's pinned shell, which
//      sits at `b1`, has to survive it.
//
// Both change the field with BOTH an enrolment and a deletion, because the
// owner's scenario had both and the two write through different routes.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, seedVenueWithCourts, setDateTime } from "../helpers";
// The ONE authority for how a field of N becomes boards + a bye. Imported, never
// restated: a test carrying its own copy of the rule asserts yesterday's numbers
// the moment the rule moves (AGENTS.md 19). `swiss-shell.ts` is alias-imported
// but pure — its only value import chains to `fixture-bye.ts`, whose single
// import is `import type`, so nothing server-only reaches Playwright's loader.
import { swissBoardsForField } from "@/lib/swiss-shell";

/** The product's own words, from the dictionary it renders — never retyped, so
 *  a copy change reds this file instead of leaving it asserting a sentence the
 *  product no longer says. */
const UI = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The wait every page load and every state read in this file is given. */
const STEP_MS = 20_000;
/** A form submission, a dialog, an inline save: a fraction of a page load. */
const REACH_MS = STEP_MS / 4;
/** A Generate/Pair round trip regenerates the whole stage server-side. */
const GENERATE_MS = 20_000;
/** 1280 / 768 / 320 at the end of each test. */
const WIDTH_CHECKS = 3;

/**
 * Each test's budget is DERIVED from its own journey, never a flat literal
 * beside it — AGENTS.md 20: a blown flat budget reports as whichever assertion
 * was in flight, i.e. as a data defect, and the misleading line comes first.
 * Adding a page load or a Generate without adding it to the call below shrinks
 * the allowance for everything else, so each test passes the counts it actually
 * performs and settles them against `visits` at the end.
 *
 * MEASURED 2026-09-22, `--workers=1` against a warm standalone prod server:
 * 9.8s for journey A, 8.7s for journey B, 30.3s for the whole file including
 * the two `auth.setup` projects. Both budgets derive to 185s, so the headroom
 * is large — deliberately, because the number that matters is the CONTENDED
 * one and this file has never been measured under `--workers=3` beside the
 * scorepad specs. Do not "tighten" it against the solo figure above.
 */
const budgetFor = (navs: number, acts: number, generates: number): number =>
  Math.max(120_000, navs * STEP_MS + (acts + WIDTH_CHECKS) * REACH_MS + generates * GENERATE_MS);

/** Every navigation goes through here, so the number each test checks its own
 *  list against is MEASURED rather than declared. Reset per test. */
let visits = 0;
const visit = async (page: Page, url: string): Promise<void> => {
  visits += 1;
  await page.goto(url, { waitUntil: "load" });
};
const revisit = async (page: Page): Promise<void> => {
  visits += 1;
  await page.reload({ waitUntil: "load" });
};

const JOURNEY_A_NAVIGATIONS = [
  "?tab=fixtures — the stage, before anything is generated",
  "?tab=fixtures — reloaded, to pin a court and a time on a ROUND 2 shell",
  "?tab=entrants — four arrive, one drops out",
  "?tab=fixtures — Pair next, with the field changed under it",
  "?tab=fixtures — reloaded, to read rounds 2 and 3 off the screen",
] as const;
const JOURNEY_B_NAVIGATIONS = [
  "?tab=fixtures — the stage, before anything is generated",
  "?tab=fixtures — reloaded, to pin a court and a time on a ROUND 3 shell",
  "?tab=entrants — one arrives, four drop out",
  "?tab=fixtures — Pair next, with the field changed under it",
  "?tab=fixtures — reloaded, to read rounds 2 and 3 off the screen",
] as const;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface FixtureRow {
  id: string;
  stage_id: string;
  fixture_no: number;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  court_id: string | null;
  court_name: string | null;
  outcome: { kind?: string; winner?: string } | null;
}

/** The shells a field of `n` needs in ONE round, as ext_keys, sorted the way
 *  `roundKeys` below sorts what it reads. Derived from the engine's own
 *  `swissBoardsForField`, so a change to the rule moves the expectation with
 *  it instead of leaving this file pinning old numbers. */
function expectedRoundKeys(round: number, field: number): string[] {
  const { boards, bye } = swissBoardsForField(field);
  const keys = Array.from({ length: boards }, (_, i) => `sw-r${round}-b${i + 1}`);
  if (bye) keys.push(`sw-r${round}-bye`);
  return keys.sort();
}

async function newSwissDivision(
  request: APIRequestContext,
  name: string,
  rounds: number,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${comp.status} ${JSON.stringify(comp.error)}`).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, `division POST → ${div.status} ${JSON.stringify(div.error)}`).toBe(201);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds },
  });
  expect(stage.status, `stage POST → ${stage.status} ${JSON.stringify(stage.error)}`).toBe(201);
  return { divisionId: div.data!.id, stageId: stage.data!.id };
}

/** The organiser's own hands on the add form. Copied deliberately from
 *  `journey-pro.spec.ts`: the shared e2e org accumulates teams from other
 *  specs, `AddEntrantForm` flips itself into "Existing team" mode once any
 *  exist, and a bare `click().catch()` races that very flip — so only the
 *  MODE PINNING is retried, never the add itself, and a retry can therefore
 *  never enter the same person twice. */
async function addEntrantThroughTheScreen(page: Page, name: string): Promise<void> {
  const modeToggle = page.getByRole("button", { name: "New entrant", exact: true });
  const nameBox = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(async () => {
    if (await modeToggle.isVisible().catch(() => false)) {
      await modeToggle.click({ timeout: 3_000 }).catch(() => undefined);
    }
    await expect(nameBox).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000, 2_000] });
  await nameBox.fill(name);
  await page.getByRole("button", { name: "Add entrant", exact: true }).click();
  // Strict on purpose — no `.first()`. Every name here carries the run's TAG,
  // so two matching cells would mean the form entered somebody twice, and that
  // is worth a red rather than a quiet pass on the first of them.
  await expect(page.getByRole("cell", { name }), `${name} never landed on the roster`).toBeVisible({
    timeout: STEP_MS,
  });
}

/** Delete — not Withdraw. The two are different controls with different
 *  consequences, and `deletable={divisionStatus === "setup"}` means Delete is
 *  offered ONLY before the division starts, which is exactly the state this
 *  whole file is about. Driven through the row button and the confirmation
 *  dialog that states the policy, because a product whose Delete is wired to
 *  nothing passes every API-driven version of this test. */
async function deleteEntrantThroughTheScreen(page: Page, name: string): Promise<void> {
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row, `no entrants row for ${name}`).toHaveCount(1);
  // "Delete" is HARDCODED ENGLISH in `entrants-panel.tsx` — like its "Withdraw"
  // sibling it is in no dictionary, so unlike the confirm label below it cannot
  // be read from one. Recorded rather than silently retyped.
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  // `alertdialog`, not `dialog` — `confirm-provider.tsx` uses the alert role.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: STEP_MS });
  await expect(dialog, "the confirmation does not name who is being removed").toContainText(name);
  const go = dialog.getByRole("button", { name: UI["confirm.deleteEntrant.label"]!, exact: true });
  // The danger button arms on its own tick (`disabled={!armed}`), so waiting on
  // the state is the difference between a click and a dropped click.
  await expect(go).toBeEnabled({ timeout: STEP_MS });
  await go.click();
  await expect(dialog).toBeHidden({ timeout: STEP_MS });
  // A DELETE, not a withdrawal: the row goes. (Its withdrawn sibling stays and
  // is marked — `withdrawn-entrant-organiser.spec.ts` pins that other half.)
  await expect(row, `${name} was withdrawn, not deleted — the row is still there`).toHaveCount(0, {
    timeout: STEP_MS,
  });
}

/** Lay a court and a time on an UNSEATED shell, through the run sheet's own
 *  inline editor. An unscheduled row's single action is `set_time`, which
 *  toggles the editor that carries both the datetime field and the R35 court
 *  picker; Save sends them in one PATCH. */
async function pinSlotThroughTheScreen(
  page: Page,
  fixtureNo: number,
  typed: string,
  court: { id: string; name: string },
): Promise<void> {
  const row = page.locator(`[data-fixture-no="${fixtureNo}"]`);
  await expect(row, `no run-sheet row for fixture ${fixtureNo}`).toHaveCount(1);
  await row.locator('[data-row-action="set_time"]').click();
  await expect(row.getByTestId("run-sheet-set-time-editor")).toBeVisible({ timeout: REACH_MS });
  await setDateTime(row, typed);
  await row.getByTestId("fixture-court-select").selectOption(court.id);
  await row.getByRole("button", { name: UI["schedule.save"]!, exact: true }).click();
}

/**
 * Every line of the run sheet a NAME can appear on.
 *
 * Not `[data-fixture-no]` alone, which is how this file first failed: a Swiss
 * bye takes `run-sheet-row.tsx`'s settled-bye branch, which renders a plain
 * `run-sheet-bye` list item with NO `data-fixture-no` at all. On an odd field
 * exactly one entrant per round is on that line — so a "was everybody seated?"
 * probe written against `data-fixture-no` reports the bye holder as seated
 * NOWHERE, and the same probe used negatively would call a name absent when it
 * is printed on screen. (`withdrawn-entrant-organiser.spec.ts` records the same
 * trap from the walkover direction.)
 */
const runSheetLines = (page: Page) => page.locator('[data-fixture-no], [data-testid="run-sheet-bye"]');

test.describe.configure({ mode: "serial" });

test("an even field grows odd before Start, and every later round is re-laid out — keeping the slot the organiser already pinned", async ({
  page,
  request,
}) => {
  test.setTimeout(budgetFor(JOURNEY_A_NAVIGATIONS.length, /* acts */ 6, /* generates */ 2));
  visits = 0;

  const ROUNDS = 3;
  const START_FIELD = 6; // even — no bye anywhere
  const ARRIVE = 4;
  const END_FIELD = START_FIELD + ARRIVE - 1; // 9 — odd, so every round now owes a bye

  const { divisionId, stageId } = await newSwissDivision(request, `Swiss pre-start grow ${TAG}`, ROUNDS);

  // REACH: the courts the organiser picks from. A venue of its own per test, so
  // the pin below cannot collide with another spec's fixture on a shared court
  // — `moveFixture` refuses a double-booking, and that refusal would read here
  // as the reconcile losing the slot.
  const { courts } = await seedVenueWithCourts(request, ["Table 1", "Table 2"], {
    venueName: `Swiss grow venue ${TAG}`,
  });
  const court = courts[0]!;

  const starters = Array.from({ length: START_FIELD }, (_, i) => `Early ${i + 1} ${TAG}`);
  const seeded = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    starters.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
  );
  expect(seeded.status, `entrants POST → ${seeded.status} ${JSON.stringify(seeded.error)}`).toBe(201);

  const fixturesOf = async (): Promise<FixtureRow[]> => {
    const res = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
    expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
    return (res.data ?? []).filter((f) => f.stage_id === stageId);
  };
  const roundKeys = async (round: number): Promise<string[]> =>
    (await fixturesOf())
      .filter((f) => f.round_no === round)
      .map((f) => f.ext_key ?? "")
      .sort();
  const shellCount = async (): Promise<number> => (await fixturesOf()).length;
  const seatedBoard = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const roundSeated = async (round: number): Promise<boolean> => {
    const rows = (await fixturesOf()).filter((f) => f.round_no === round);
    return rows.length > 0 && rows.every((f) => seatedBoard(f) || f.outcome?.kind === "award");
  };

  // ─────────────────────────────────── the organiser lays the tournament out
  const fixturesUrl = await divisionPath(request, divisionId, "?tab=fixtures");
  await visit(page, fixturesUrl);

  const generate = page.getByTestId("stage-generate");
  await expect(generate, "the stage rail offers no Generate at all").toBeVisible({ timeout: STEP_MS });
  await expect(generate, "a Swiss stage with no fixtures must offer Generate, not Pair").toHaveText(
    UI["schedule.generate"]!,
  );
  await generate.click();
  const mintedPerRound = expectedRoundKeys(1, START_FIELD).length;
  await expect
    .poll(shellCount, { timeout: GENERATE_MS })
    .toBe(ROUNDS * mintedPerRound);

  // All three rounds are minted for the six-player field, and NOTHING is seated
  // — this is the pre-Start layout state the whole scenario starts from.
  for (const round of [1, 2, 3]) {
    expect(await roundKeys(round), `round ${round} was not minted for the six-player field`).toEqual(
      expectedRoundKeys(round, START_FIELD),
    );
  }
  expect((await fixturesOf()).some(seatedBoard), "Generate seated somebody before Pair").toBe(false);

  // ──────────────── a court and a time, pinned on ROUND 2 — not the round that
  // is about to be paired. This is the organiser's advance layout, and it is
  // the single assertion that tells a reconcile from a delete-and-recreate.
  await revisit(page);
  const pinnedBefore = (await fixturesOf()).find((f) => f.ext_key === "sw-r2-b1")!;
  const pinnedAt = "2030-06-15T14:00:00.000Z";
  await pinSlotThroughTheScreen(page, pinnedBefore.fixture_no, "2030-06-15T14:00", court);
  await expect
    .poll(async () => {
      const f = (await fixturesOf()).find((x) => x.id === pinnedBefore.id);
      return `${f?.scheduled_at ?? "-"}|${f?.court_id ?? "-"}`;
    }, { timeout: STEP_MS })
    .toBe(`${pinnedAt}|${court.id}`);

  // ───────────────────────────────────────── the field moves under the layout
  await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
  const latecomers = Array.from({ length: ARRIVE }, (_, i) => `Late ${i + 1} ${TAG}`);
  for (const name of latecomers) await addEntrantThroughTheScreen(page, name);
  const dropped = starters[starters.length - 1]!;
  await deleteEntrantThroughTheScreen(page, dropped);

  const field = await apiJson<{ id: string; display_name: string; status: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  const active = (field.data ?? []).filter((e) => e.status === "registered" || e.status === "confirmed");
  expect(active.length, "the field is not the size the organiser's own taps left it").toBe(END_FIELD);
  expect(
    active.some((e) => e.display_name === dropped),
    "the deleted entrant is still in the field",
  ).toBe(false);

  // ─────────────────────────────────────────────────────────── Pair next round
  await visit(page, fixturesUrl);
  await expect(generate, "with shells minted and nothing seated, the rail must offer Pair next").toHaveText(
    UI["schedule.pairNext"]!,
  );
  await generate.click();
  await expect.poll(() => roundSeated(1), { timeout: GENERATE_MS }).toBe(true);

  // ── THE CLAIM ─────────────────────────────────────────────────────────────
  // Round 1 is seated against the new field, which the lazy build also managed.
  expect(await roundKeys(1), "round 1 was not re-laid out for the nine-player field").toEqual(
    expectedRoundKeys(1, END_FIELD),
  );
  // Rounds 2 AND 3 are the half only the eager reconcile does. Against the lazy
  // build these still read as the six-player field's three boards and no bye.
  for (const round of [2, 3]) {
    expect(
      await roundKeys(round),
      `round ${round} still carries the OLD field's shells — a later round the organiser cannot schedule for the field they now have`,
    ).toEqual(expectedRoundKeys(round, END_FIELD));
  }
  // …and the bye specifically APPEARED, in a later round, because the parity
  // flipped. Stated separately from the set above so the even→odd direction is
  // named rather than buried inside a deep-equal.
  expect(await roundKeys(3), "the odd field's bye never reached round 3").toContain("sw-r3-bye");

  // The organiser's advance layout survived it: SAME ROW, same slot, same court.
  const pinnedAfter = (await fixturesOf()).find((f) => f.ext_key === "sw-r2-b1")!;
  expect(pinnedAfter.id, "the round-2 board was RECREATED, not reconciled — its id changed").toBe(
    pinnedBefore.id,
  );
  expect(pinnedAfter.scheduled_at, "the reconcile discarded the pinned kick-off time").toBe(pinnedAt);
  expect(pinnedAfter.court_id, "the reconcile discarded the pinned court").toBe(court.id);

  // ── AND WHAT THE ORGANISER SEES ───────────────────────────────────────────
  await revisit(page);
  const after = await fixturesOf();
  for (const round of [2, 3]) {
    for (const f of after.filter((x) => x.round_no === round)) {
      await expect(
        page.locator(`[data-fixture-no="${f.fixture_no}"]`),
        `round ${round}'s ${f.ext_key} is in the record but not on the run sheet`,
      ).toHaveCount(1);
    }
  }
  // The NEW board is the point of the whole change: it is not merely present,
  // it is SCHEDULABLE — a row the organiser can put a time and a court on,
  // which is precisely what a round still minted for the old field cannot
  // offer the player who just arrived.
  const newBoard = after.find((f) => f.ext_key === `sw-r2-b${swissBoardsForField(END_FIELD).boards}`)!;
  const newRow = page.locator(`[data-fixture-no="${newBoard.fixture_no}"]`);
  await expect(newRow, "the board the new field needs is not on the run sheet").toHaveCount(1);
  await expect(
    newRow.locator('[data-row-action="set_time"]'),
    "the new board offers the organiser no way to schedule it",
  ).toHaveCount(1);
  // The pinned row still shows the organiser what they laid down.
  const pinnedRow = page.locator(`[data-fixture-no="${pinnedAfter.fixture_no}"]`);
  await expect(pinnedRow, "the pinned round-2 row lost its court on screen").toContainText(court.name);
  // Everyone who is still in the field has a seat in round 1 — including the
  // people who arrived after the shells were minted. Read off the screen, by
  // name, because "the counts add up" is equally satisfied by nine strangers.
  for (const name of latecomers) {
    await expect(
      runSheetLines(page).filter({ hasText: name }).first(),
      `${name} arrived before Pair and was seated nowhere`,
    ).toBeVisible({ timeout: STEP_MS });
  }

  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  expect(visits, "the journey-A navigation list no longer describes this journey").toBe(
    JOURNEY_A_NAVIGATIONS.length,
  );
});

test("an odd field shrinks even before Start, and the surplus board and its bye leave every later round", async ({
  page,
  request,
}) => {
  test.setTimeout(budgetFor(JOURNEY_B_NAVIGATIONS.length, /* acts */ 6, /* generates */ 2));
  visits = 0;

  const ROUNDS = 3;
  const START_FIELD = 9; // odd — every round is minted with a `-bye`
  const LEAVE = 4;
  const END_FIELD = START_FIELD + 1 - LEAVE; // 6 — even, one board fewer, no bye

  const { divisionId, stageId } = await newSwissDivision(request, `Swiss pre-start shrink ${TAG}`, ROUNDS);
  const { courts } = await seedVenueWithCourts(request, ["Rink A", "Rink B"], {
    venueName: `Swiss shrink venue ${TAG}`,
  });
  const court = courts[1]!;

  const starters = Array.from({ length: START_FIELD }, (_, i) => `Full ${i + 1} ${TAG}`);
  const seeded = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    starters.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
  );
  expect(seeded.status, `entrants POST → ${seeded.status} ${JSON.stringify(seeded.error)}`).toBe(201);

  const fixturesOf = async (): Promise<FixtureRow[]> => {
    const res = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
    expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
    return (res.data ?? []).filter((f) => f.stage_id === stageId);
  };
  const roundKeys = async (round: number): Promise<string[]> =>
    (await fixturesOf())
      .filter((f) => f.round_no === round)
      .map((f) => f.ext_key ?? "")
      .sort();
  const shellCount = async (): Promise<number> => (await fixturesOf()).length;
  const seatedBoard = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const roundSeated = async (round: number): Promise<boolean> => {
    const rows = (await fixturesOf()).filter((f) => f.round_no === round);
    return rows.length > 0 && rows.every((f) => seatedBoard(f) || f.outcome?.kind === "award");
  };

  const fixturesUrl = await divisionPath(request, divisionId, "?tab=fixtures");
  await visit(page, fixturesUrl);

  const generate = page.getByTestId("stage-generate");
  await expect(generate).toBeVisible({ timeout: STEP_MS });
  await generate.click();
  const mintedPerRound = expectedRoundKeys(1, START_FIELD).length;
  await expect.poll(shellCount, { timeout: GENERATE_MS }).toBe(ROUNDS * mintedPerRound);
  for (const round of [1, 2, 3]) {
    expect(await roundKeys(round), `round ${round} was not minted for the nine-player field`).toEqual(
      expectedRoundKeys(round, START_FIELD),
    );
  }
  // The positive half of the bye assertion at the end: it really was there to
  // begin with, so its later absence is a removal and not an empty locator.
  expect(await roundKeys(3), "the odd field minted no bye in round 3").toContain("sw-r3-bye");

  // The pin goes on ROUND 3 this time — the furthest round from the one about
  // to be paired, and the one a lazy reconcile reaches last.
  await revisit(page);
  const pinnedBefore = (await fixturesOf()).find((f) => f.ext_key === "sw-r3-b1")!;
  const pinnedAt = "2030-07-20T09:30:00.000Z";
  await pinSlotThroughTheScreen(page, pinnedBefore.fixture_no, "2030-07-20T09:30", court);
  await expect
    .poll(async () => {
      const f = (await fixturesOf()).find((x) => x.id === pinnedBefore.id);
      return `${f?.scheduled_at ?? "-"}|${f?.court_id ?? "-"}`;
    }, { timeout: STEP_MS })
    .toBe(`${pinnedAt}|${court.id}`);

  await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
  const latecomer = `Late arrival ${TAG}`;
  await addEntrantThroughTheScreen(page, latecomer);
  const dropouts = starters.slice(0, LEAVE);
  for (const name of dropouts) await deleteEntrantThroughTheScreen(page, name);

  const field = await apiJson<{ id: string; display_name: string; status: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  const active = (field.data ?? []).filter((e) => e.status === "registered" || e.status === "confirmed");
  expect(active.length, "the field is not the size the organiser's own taps left it").toBe(END_FIELD);

  await visit(page, fixturesUrl);
  await expect(generate).toHaveText(UI["schedule.pairNext"]!);
  await generate.click();
  await expect.poll(() => roundSeated(1), { timeout: GENERATE_MS }).toBe(true);

  // ── THE CLAIM, the other way round ────────────────────────────────────────
  expect(await roundKeys(1), "round 1 was not re-laid out for the six-player field").toEqual(
    expectedRoundKeys(1, END_FIELD),
  );
  for (const round of [2, 3]) {
    expect(
      await roundKeys(round),
      `round ${round} still carries the OLD field's shells — a surplus board and a bye nobody is owed`,
    ).toEqual(expectedRoundKeys(round, END_FIELD));
  }
  // Named separately, both halves: the bye LEFT, and so did the board the
  // shrunken field no longer needs.
  expect(await roundKeys(3), "the bye outlived the parity that justified it").not.toContain("sw-r3-bye");
  expect(
    await roundKeys(3),
    "the surplus board survived — a round still laid out for a field that has gone",
  ).not.toContain(`sw-r3-b${swissBoardsForField(START_FIELD).boards}`);

  // The destructive half deleted from the highest `seq_in_round` DOWN, so the
  // organiser's pinned `b1` is exactly the row that must survive it.
  const pinnedAfter = (await fixturesOf()).find((f) => f.ext_key === "sw-r3-b1")!;
  expect(pinnedAfter.id, "the round-3 board was RECREATED, not reconciled — its id changed").toBe(
    pinnedBefore.id,
  );
  expect(pinnedAfter.scheduled_at, "the shrink discarded the pinned kick-off time").toBe(pinnedAt);
  expect(pinnedAfter.court_id, "the shrink discarded the pinned court").toBe(court.id);

  await revisit(page);
  const after = await fixturesOf();
  for (const round of [2, 3]) {
    for (const f of after.filter((x) => x.round_no === round)) {
      await expect(
        page.locator(`[data-fixture-no="${f.fixture_no}"]`),
        `round ${round}'s ${f.ext_key} is in the record but not on the run sheet`,
      ).toHaveCount(1);
    }
  }
  const pinnedRow = page.locator(`[data-fixture-no="${pinnedAfter.fixture_no}"]`);
  await expect(pinnedRow, "the pinned round-3 row lost its court on screen").toContainText(court.name);
  await expect(
    runSheetLines(page).filter({ hasText: latecomer }).first(),
    "the one person who arrived was seated nowhere",
  ).toBeVisible({ timeout: STEP_MS });
  // And nobody the organiser deleted is still printed anywhere on the sheet —
  // bye lines included, which is the half a `data-fixture-no` sweep cannot see.
  for (const name of dropouts) {
    await expect(
      runSheetLines(page).filter({ hasText: name }),
      `${name} was deleted and is still named in the draw`,
    ).toHaveCount(0);
  }

  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  expect(visits, "the journey-B navigation list no longer describes this journey").toBe(
    JOURNEY_B_NAVIGATIONS.length,
  );
});
