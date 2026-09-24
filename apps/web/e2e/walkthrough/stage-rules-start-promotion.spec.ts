// ONE organiser's path through the three things this branch shipped, driven
// through the screens an organiser actually uses:
//
//   1. per-stage match rules — set on the league stage of a League + Finals
//      division, and NOT on the Finals beside it (design 2026-09-17 §T3/§T5);
//   2. the Start-tournament confirmation and the four consequences it states
//      (design 2026-09-20);
//   3. `startDivision`'s promotion of the parent competition published → live
//      (`server/usecases/schedule.ts`, inside the status transaction);
//   4. what a SPECTATOR then reads of those rules (brief 2026-09-24): the
//      public match page labels a league fixture with the league stage's own
//      format, not the division's preset name, and the hub and division page
//      name the league stage's format — while the Finals, back on the
//      division's format, stay as they were.
//
// They are one file because they are one journey: the confirmation's own
// fourth line PROMISES the lock behaviour this file then drives ("Match rules
// stay editable for stages that have not begun. Once a stage's first match is
// scored, its format locks too."). A spec that read that sentence and never
// tested it would be asserting a promise, not a product.
//
// WHY NOT journey-pro. `journey-pro.spec.ts` already drives the Start dialog
// and the promotion, and stays as it is. It reaches that screen through a
// generic 6-entrant league with every fixture timed, so it can say nothing
// about per-stage rules: `generic` is not in `STAGE_RULES_SPORTS`, and it has
// exactly one stage, so neither direction of a PER-STAGE lock is expressible
// in it. This file is badminton, two stages, and reads the format row.
//
// BOTH DIRECTIONS, always. A stage whose first match has been scored must
// REFUSE, and the stage beside it that has not begun must still SAVE — in the
// same division, at the same moment, on the same endpoint. A refusal-only test
// cannot tell a working lock from one that refuses everything, and this lock's
// predicate is deliberately monotonic (`usecases/stage-rules.ts`: a voided
// `core.start` moves `fixtures.status` BACKWARDS, so status can never be the
// guard), which is exactly the kind of guard that reads fine while over-
// refusing.
//
// The ledger writes below are a REACH, not a read: the badminton pad itself is
// walked tap by tap in `scorepad-v3-badminton-match.spec.ts`, and re-playing it
// here would buy this leg nothing but minutes. Everything this file makes a
// CLAIM about — the format row, the editor, the confirmation, the locked
// state — is driven in the browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createCompetitionViaUi,
  divisionPath,
} from "../helpers";
// Directive-free and JSX-free on purpose (design §T0), which is why a spec can
// import it. The picker's own option label, so a rename of "Best of 3" moves
// this file with it instead of leaving it asserting yesterday's copy.
import { ruleOptionLabel } from "../../src/lib/match-rules";

/** Every user-facing string this file asserts comes from the dictionary the
 *  product renders — never retyped here (house pattern: run-sheet.spec.ts,
 *  settings-competition-drive.spec.ts). A copy change reds this file, which is
 *  the point. */
const L = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string>;
/** The PUBLIC dictionary — the spectator pages' copy (the format lines and
 *  the headings around them live there, not in `ui.json`). */
const P = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../src/dictionaries/en/public.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string>;

/** `{name}` placeholders filled — the dictionary's own template, so the words
 *  are never retyped here. */
function fill(template: string | undefined, params: Record<string, number>): string {
  expect(template, "the dictionary must carry the template").toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]));
}

test.describe.configure({ mode: "serial" });

/** The wait every `goto` and every state read in this file is given. */
const STEP_MS = 20_000;
/** The wait every API status poll is given. */
const POLL_MS = 20_000;

/**
 * The stage format this walkthrough OVERRIDES to.
 *
 * It is asserted below to differ from the division's own `bestOf`, because a
 * summary line reading the division's number cannot witness an override that
 * silently did not apply (AGENTS.md 19: pin what the control OPENS AT and what
 * it LANDS ON, and prefer a case whose right answer differs from the wrong
 * one's constant). `5` is one of badminton's three offered options
 * (`SPORT_RULES.badminton`, widened by owner ruling 2026-09-20), and it is odd,
 * which the set-based kernel's schema requires.
 */
const LEAGUE_BEST_OF = 5;
/** The Finals' own, different again — so the last save in this file cannot be
 *  confused with either the division's format or the league stage's. */
const FINALS_BEST_OF = 1;
/** The value the API writes to the Finals AFTER the UI already wrote
 *  `FINALS_BEST_OF`, so a 200 that changed nothing is not mistaken for a 200
 *  that saved. */
const FINALS_BEST_OF_VIA_API = 3;

const SPORT = "badminton";
/** `1. League` / `2. Finals` — `STAGE_TEMPLATES.league_ko`'s own stage names,
 *  rendered by the stage card header as `{seq}. {name}`. */
const LEAGUE_HEADING = "1. League";
const FINALS_HEADING = "2. Finals";
/** `SPORT_RULES.badminton`'s `bestOf` field label — sport-rules vocabulary,
 *  canonical English and deliberately NOT localized (`lib/match-rules.ts`). */
const BEST_OF_LABEL = "Best of (sets)";

let compId = "";
let divId = "";
let leagueStageId = "";
let finalsStageId = "";
let leagueFixtureId = "";
/** A Finals placeholder — the public page's control: its stage ends this file
 *  back on the division's own format. */
let finalsFixtureId = "";
/** The division's own `bestOf`, READ from the created division rather than
 *  typed here — the inherited summary line is derived from it. */
let divisionBestOf = 0;

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: { rules?: Record<string, unknown> };
}

/** One stage's card body. Anchored on the heading an organiser reads, not on
 *  an index: `stage-sheet` is emitted once per stage, and an index would keep
 *  passing if the two cards swapped. */
function stageSheet(page: Page, heading: string) {
  return page
    .getByTestId("stage-sheet")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/** The summary line the row renders for a given effective `bestOf` and state
 *  clause — assembled the way `StageFormatRow` assembles it
 *  (`${stageFormatHeadline(...)} · ${clause}`), from the SAME option-label
 *  lookup, so neither half is a string typed into this file. */
function summaryLine(bestOf: number, clauseKey: string): string {
  const headline = ruleOptionLabel(SPORT, "bestOf", String(bestOf)) ?? String(bestOf);
  return `${headline} · ${L[clauseKey]}`;
}

async function readStages(request: APIRequestContext): Promise<StageRow[]> {
  const res = await apiJson<StageRow[]>(request, `/api/v1/divisions/${divId}/stages`);
  expect(res.status, `GET /divisions/${divId}/stages`).toBe(200);
  // `apiJson` swallows a body-parse failure into `data: undefined`, which would
  // degrade every assertion below into a vacuous pass.
  expect(res.data, "the stage read must carry rows").toBeDefined();
  return res.data!;
}

function stageById(rows: StageRow[], id: string): StageRow {
  const row = rows.find((s) => s.id === id);
  if (!row) throw new Error(`stage ${id} missing from ${JSON.stringify(rows.map((s) => s.id))}`);
  return row;
}

/** Set one stage's `bestOf` through the product — open the row's editor, move
 *  the picker, press Save — and wait for the row to restate itself. */
async function setBestOfInUi(
  page: Page,
  heading: string,
  bestOf: number,
  expectedClauseKey: string,
): Promise<void> {
  const sheet = stageSheet(page, heading);
  await sheet.getByTestId("stage-format-edit").click();
  const picker = sheet.getByLabel(BEST_OF_LABEL);
  await expect(picker).toBeVisible({ timeout: STEP_MS });
  await picker.selectOption(String(bestOf));
  await sheet.getByTestId("stage-format-save").click();
  // `onSaved` fires `router.refresh()`, so the row restates itself without a
  // reload — which is the behaviour an organiser actually gets, and worth
  // asserting rather than navigating past.
  await expect(sheet.getByTestId("stage-format-summary")).toHaveText(
    summaryLine(bestOf, expectedClauseKey),
    { timeout: STEP_MS },
  );
}

test("an organiser gives the league stage its own match format, and the Finals beside it keeps the division's", async ({
  page,
  request,
}) => {
  // Derived from the waits this test actually spends, never a flat literal
  // beside them (AGENTS.md 20): ~10 page/state waits at STEP_MS.
  test.setTimeout(Math.max(120_000, 10 * STEP_MS));

  compId = await createCompetitionViaUi(page, `Stage Rules ${TAG}`, "public");

  // The division, through the wizard, with the format an organiser picks when
  // they want two stages: League + Finals. `createDivisionViaUi` cannot express
  // this — it never visits the Format tab, so it always ships the default
  // single `league` stage, and a one-stage division has no second stage for the
  // per-stage lock to be ABOUT.
  await page.goto(await competitionPath(request, compId, "/d/new"));
  await page.getByRole("textbox").first().fill(`Singles ${TAG}`);
  await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption(SPORT);
  await page.getByRole("button", { name: L["wizard.tab.format"], exact: true }).click();
  // The radio itself is `sr-only` inside its card `<label>`, and the label's
  // text is title + help, so an exact accessible-name match cannot address it.
  // Scope to the cards that actually carry a `template` radio, then pick by the
  // title copy — and verify the radio TOOK, rather than trusting the click.
  const leagueKo = page
    .locator("label")
    .filter({ has: page.locator('input[name="template"]') })
    .filter({ hasText: L["format.template.league_ko.label"] });
  await leagueKo.click();
  await expect(leagueKo.locator("input")).toBeChecked();
  await page.getByRole("button", { name: L["wizard.tab.scheduling"], exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: STEP_MS });
  const divSlug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divisions = await apiJson<{ id: string; slug: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  divId = divisions.data!.find((d) => d.slug === divSlug)!.id;

  // The wizard really built TWO stages, and the right two. Without this the
  // whole file could run against a single-stage division and every "the other
  // stage is untouched" assertion below would be about a card that never
  // rendered.
  const stages = await readStages(request);
  expect(
    stages.map((s) => `${s.seq}:${s.kind}:${s.name}`),
    "League + Finals must ship a league stage then a knockout stage",
  ).toEqual(["1:league:League", "2:knockout:Finals"]);
  leagueStageId = stages[0]!.id;
  finalsStageId = stages[1]!.id;

  const entrants = await addEntrantsViaApi(request, divId, [
    `Ada ${TAG}`,
    `Bo ${TAG}`,
    `Cy ${TAG}`,
    `Di ${TAG}`,
  ]);
  expect(entrants.status, `entrants POST → ${entrants.status}`).toBeLessThan(300);
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${leagueStageId}/generate`,
    "POST",
  );
  expect(gen.status, `generate → ${gen.status} ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  // A 4-entrant single round robin is 6 matches. Asserted so a generate that
  // quietly produced none cannot leave the lock step below with nothing to
  // score.
  expect(gen.data!.fixtures.length, "4 entrants, single round robin").toBe(6);
  leagueFixtureId = gen.data!.fixtures[0]!.id;

  // The Finals too, as TBD placeholders. NOT cosmetic: the lock predicate reads
  // `fixtures` (`config_snapshot is not null OR exists(score_events)`), so a
  // stage with NO fixtures at all satisfies "not locked" for a reason that has
  // nothing to do with whether it has been PLAYED. Minting them here makes the
  // "still editable" half of the test the sharp case — a stage that has
  // fixtures and has not begun — instead of the empty one.
  const genFinals = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${finalsStageId}/generate`,
    "POST",
  );
  expect(
    genFinals.status,
    `generating the Finals → ${genFinals.status} ${JSON.stringify(genFinals.error)}`,
  ).toBeLessThan(300);
  expect(
    genFinals.data!.fixtures.length,
    "the Finals must carry real fixture rows, or the unlocked half of this file is the empty case",
  ).toBeGreaterThan(0);
  finalsFixtureId = genFinals.data!.fixtures[0]!.id;

  const division = await apiJson<{ config: Record<string, unknown> }>(
    request,
    `/api/v1/divisions/${divId}`,
  );
  expect(division.status, `GET /divisions/${divId}`).toBe(200);
  divisionBestOf = Number(division.data!.config.bestOf);
  // The load-bearing property is not WHICH number the bwf preset ships — it is
  // that the override differs from it. If they were equal, every summary-line
  // assertion below would read the same string whether the override applied or
  // was silently dropped.
  expect(
    divisionBestOf,
    "the override must differ from the division's own format, or the row cannot witness it",
  ).not.toBe(LEAGUE_BEST_OF);
  expect(Number.isInteger(divisionBestOf), "the bwf preset must carry a bestOf").toBe(true);

  await page.goto(await divisionPath(request, divId, "?tab=fixtures"));
  const league = stageSheet(page, LEAGUE_HEADING);
  const finals = stageSheet(page, FINALS_HEADING);
  const inherited = summaryLine(divisionBestOf, "schedule.stageFormat.inherited");

  // Opening state, both cards: inherited, and stating the division's number.
  await expect(league.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "inherited",
    { timeout: STEP_MS },
  );
  await expect(league.getByTestId("stage-format-summary")).toHaveText(inherited);
  await expect(finals.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "inherited",
  );
  await expect(finals.getByTestId("stage-format-summary")).toHaveText(inherited);

  await setBestOfInUi(page, LEAGUE_HEADING, LEAGUE_BEST_OF, "schedule.stageFormat.overridden");
  await expect(league.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "overridden",
  );
  // PER STAGE, not per division: the Finals card must not have moved. This is
  // the assertion a division-wide write would fail.
  await expect(finals.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "inherited",
  );
  await expect(finals.getByTestId("stage-format-summary")).toHaveText(inherited);

  // And the system's own record agrees with the screen. The stored value is a
  // FRAGMENT — `{bestOf}` alone, never the division's format materialised —
  // because an absent key is what "inherit" means here, and a fully-filled
  // fragment would pin the stage to today's division format forever.
  const saved = await readStages(request);
  expect(stageById(saved, leagueStageId).config.rules).toEqual({ bestOf: LEAGUE_BEST_OF });
  expect(
    stageById(saved, finalsStageId).config.rules,
    "the Finals must carry no rules key at all — inherit is key ABSENCE",
  ).toBeUndefined();
});

test("publishing, then Start: the confirmation states its four consequences, and the division AND the competition both move", async ({
  page,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 4 * STEP_MS + 2 * POLL_MS));

  // PATCH is the only way to publish: `createCompetition` never inserts
  // `status`, the column defaults to `draft`, and zod STRIPS `status` from a
  // create body — so a competition made by the wizard is `draft`, and `draft`
  // is the one status under which the promotion below cannot fire.
  const published = await apiJson<{ status: string }>(
    request,
    `/api/v1/competitions/${compId}`,
    "PATCH",
    { status: "published" },
  );
  expect(
    published.status,
    `publishing failed: ${JSON.stringify(published.error)}`,
  ).toBe(200);
  // The PATCH's own row, not a re-read: a 200 that silently kept `draft` would
  // leave the competition line below testing an absent line, and the `live`
  // poll unable to pass for a reason no assertion would name.
  expect(published.data?.status, "the competition must really be published").toBe("published");

  await page.goto(await divisionPath(request, divId, "?tab=fixtures"));
  await page.getByTestId("launch-start-division").click();

  // Start confirms first — the button opens a dialog and POSTs nothing.
  const confirm = page.getByTestId("start-confirm");
  await expect(confirm).toBeVisible({ timeout: STEP_MS });
  await expect(confirm).toContainText(L["launch.confirm.lead"]);
  // The CONTROL SET of the consequences, in order, with no extras: membership,
  // order and count in one assertion. A dialog that rendered an empty body, or
  // three of the four, or the same line twice, fails here — which presence
  // checks on two testids would not.
  await expect(
    confirm.getByTestId("start-confirm-consequences").getByRole("listitem"),
  ).toHaveText([
    L["launch.confirm.entrants"],
    L["launch.confirm.competition"],
    L["launch.confirm.format"],
    L["launch.confirm.rules"],
  ]);
  // And each conditional line is the one its own testid claims: the two above
  // are rendered only when they are TRUE of this division, so binding the text
  // to the testid is what stops a future reorder from swapping their meanings.
  await expect(confirm.getByTestId("start-confirm-entrants")).toHaveText(
    L["launch.confirm.entrants"],
  );
  await expect(confirm.getByTestId("start-confirm-competition")).toHaveText(
    L["launch.confirm.competition"],
  );

  await page.getByTestId("start-confirm-confirm").click();
  // The button label flips to "Starting…" while the POST is in flight and the
  // fixtures already exist (so quick-start generates none and does not
  // redirect) — poll the record for the real transitions instead of the button.
  await expect
    .poll(
      async () => {
        try {
          return (await apiJson<{ status: string }>(request, `/api/v1/divisions/${divId}`)).data
            ?.status;
        } catch {
          return undefined; // transient server hiccup — keep polling
        }
      },
      { timeout: POLL_MS },
    )
    .toBe("active");
  // The consequence the dialog promised, in the data. The promotion rides in
  // `startDivision`'s own status transaction, so it is settled by the time the
  // division reads `active` — polled on the same terms anyway.
  await expect
    .poll(
      async () => {
        try {
          return (await apiJson<{ status: string }>(request, `/api/v1/competitions/${compId}`)).data
            ?.status;
        } catch {
          return undefined;
        }
      },
      { timeout: POLL_MS },
    )
    .toBe("live");
});

test("the format lock is per stage: the played stage refuses, the stage that has not begun still saves", async ({
  page,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 8 * STEP_MS));

  // Score the league stage's first match. Two writes, because "started" and
  // "scored" are different claims and the dialog promised the second one: a
  // `core.start` alone would lock the stage through `config_snapshot`, and this
  // file would then never have driven the `score_events` half of the predicate.
  const fixture = await apiJson<{ home_entrant_id: string }>(
    request,
    `/api/v1/fixtures/${leagueFixtureId}`,
  );
  expect(fixture.status, `GET fixture ${leagueFixtureId}`).toBe(200);
  const started = await apiJson(request, `/api/v1/fixtures/${leagueFixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, `core.start → ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const rally = await apiJson(request, `/api/v1/fixtures/${leagueFixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "badminton.rally",
    payload: { wonBy: fixture.data!.home_entrant_id },
  });
  expect(rally.status, `badminton.rally → ${JSON.stringify(rally.error)}`).toBeLessThan(300);
  // The ledger really carries both — otherwise the "locked" reads below would
  // be proving nothing but that the page renders.
  const state = await apiJson<{ last_seq: number }>(
    request,
    `/api/v1/fixtures/${leagueFixtureId}/state`,
  );
  expect(state.data?.last_seq, "the start and the rally must both be on the ledger").toBe(2);

  await page.goto(await divisionPath(request, divId, "?tab=fixtures"));
  const league = stageSheet(page, LEAGUE_HEADING);
  const finals = stageSheet(page, FINALS_HEADING);

  // DIRECTION 1 — the played stage. It reads locked, it still states the format
  // it is being played at, and the organiser is offered no way in: the panel
  // declines to render the editor rather than letting them discover the 409
  // after pressing Save.
  await expect(league.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "locked",
    { timeout: STEP_MS },
  );
  await expect(league.getByTestId("stage-format-summary")).toHaveText(
    summaryLine(LEAGUE_BEST_OF, "schedule.stageFormat.locked"),
  );
  await expect(league.getByTestId("stage-format-edit")).toHaveCount(0);
  await expect(league.getByTestId("stage-format-clear")).toHaveCount(0);

  // DIRECTION 2 — the stage beside it, in the SAME division, at the SAME
  // moment, after the division has already started. It is still offered, and
  // the save still lands. Without this pair the locked read above is equally
  // satisfied by a lock that refuses everything.
  await expect(finals.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "inherited",
  );
  await expect(finals.getByTestId("stage-format-edit")).toBeVisible();
  await setBestOfInUi(page, FINALS_HEADING, FINALS_BEST_OF, "schedule.stageFormat.overridden");
  await expect(finals.getByTestId("stage-format")).toHaveAttribute(
    "data-stage-format-state",
    "overridden",
  );
  // The locked card did not move while its neighbour was being edited.
  await expect(league.getByTestId("stage-format-summary")).toHaveText(
    summaryLine(LEAGUE_BEST_OF, "schedule.stageFormat.locked"),
  );

  // The same two directions on the endpoint itself, one call apart, so the
  // 409 is read against a 200 rather than on its own.
  const refused = await apiJson(request, `/api/v1/stages/${leagueStageId}/rules`, "PUT", {
    rules: { bestOf: FINALS_BEST_OF },
  });
  expect(refused.status, "a played stage's rules are refused").toBe(409);
  expect(refused.error?.code).toBe("STAGE_FORMAT_LOCKED");
  const accepted = await apiJson(request, `/api/v1/stages/${finalsStageId}/rules`, "PUT", {
    rules: { bestOf: FINALS_BEST_OF_VIA_API },
  });
  expect(
    accepted.status,
    `an unplayed stage's rules still save: ${JSON.stringify(accepted.error)}`,
  ).toBe(200);

  // And the record: the refusal landed NOWHERE (the league keeps the format it
  // was played under), the acceptance landed WHOLE.
  const after = await readStages(request);
  expect(
    stageById(after, leagueStageId).config.rules,
    "a refused write must not half-land",
  ).toEqual({ bestOf: LEAGUE_BEST_OF });
  expect(stageById(after, finalsStageId).config.rules).toEqual({ bestOf: FINALS_BEST_OF_VIA_API });
});

test("a spectator reads the league stage's own format: on its match page, on the hub and on the division page — and the Finals keep the division's", async ({
  page,
  request,
}) => {
  // Five page loads plus the Info-tab hydration wait, each at STEP_MS.
  test.setTimeout(Math.max(120_000, 7 * STEP_MS));

  // Where this file left the two stages: the league at its own Best of 5
  // (locked, scored), the Finals written back by the API to a value that is
  // the division's own — so the Finals play the division's format again.
  const division = await apiJson<{ config: Record<string, unknown>; variant_key: string }>(
    request,
    `/api/v1/divisions/${divId}`,
  );
  expect(division.status, `GET /divisions/${divId}`).toBe(200);
  const cfg = division.data!.config;
  const setTo = Number(cfg.setTo);
  const cap = Number(cfg.cap);
  expect(Number.isInteger(setTo) && Number.isInteger(cap), "the preset must carry setTo and cap").toBe(true);
  expect(cap, "the cap clause is only said when the cap exceeds the target").toBeGreaterThan(setTo);
  expect(
    FINALS_BEST_OF_VIA_API,
    "the Finals must end this file back on the division's own format, or they are no control",
  ).toBe(divisionBestOf);
  // The league stage's EFFECTIVE rules, described the way the product does:
  // its own bestOf over the division's points and cap.
  const leagueLine = fill(P["format.rules.bestOfPointsCap"], { n: LEAGUE_BEST_OF, points: setTo, cap });
  // The division's own label — what every page said before, and what the
  // Finals must still say.
  const preset = L[`variant.badminton.${division.data!.variant_key}`];
  expect(preset, `a dictionary label for variant ${division.data!.variant_key}`).toBeDefined();

  const [, orgSlug, compSlug] = (await competitionPath(request, compId)).match(/^\/o\/([^/]+)\/c\/([^/]+)$/)!;
  const divSlug = (await divisionPath(request, divId)).split("/d/")[1]!;
  const shared = `/shared/${orgSlug}/${compSlug}`;

  // 1. The public match page of a league fixture — the one scored above, so
  // it is labelled from its frozen snapshot, which carries the stage's rules.
  // The header meta line (which the poster falls back to) and the Info tab.
  await page.goto(`${shared}/${divSlug}/fixtures/${leagueFixtureId}?tab=info`);
  await expect(page.getByTestId("mc-meta-line")).toContainText(leagueLine, { timeout: STEP_MS });
  await expect(page.getByTestId("mc-meta-line")).not.toContainText(preset!);
  const formatRow = page.getByTestId(/^mc-info-\d+$/).filter({ hasText: P["matchCentre.info.format"]! });
  await expect(formatRow.locator("dd")).toHaveText(leagueLine, { timeout: STEP_MS });

  // The control: a Finals fixture keeps the division's label, and says no
  // rules line at all.
  await page.goto(`${shared}/${divSlug}/fixtures/${finalsFixtureId}`);
  await expect(page.getByTestId("mc-meta-line")).toContainText(preset!, { timeout: STEP_MS });
  await expect(page.getByTestId("mc-meta-line")).not.toContainText(leagueLine);

  // 2. The hub's Info tab: the division's box names the League stage's format,
  // and ONLY it — the Finals' line would be noise, identical to the division.
  await page.goto(`${shared}?tab=info`);
  const formats = page.getByTestId(`mh-info-formats-${divSlug}`);
  await expect(formats).toBeVisible({ timeout: STEP_MS });
  await expect(formats.getByRole("heading", { name: P["info.stageFormats"]! })).toBeVisible();
  const rows = formats.getByTestId(new RegExp(`^mh-info-format-${divSlug}-\\d+$`));
  await expect(rows).toHaveCount(1);
  await expect(rows.locator("dt")).toHaveText("League");
  await expect(rows.locator("dd")).toHaveText(leagueLine);

  // 3. The division page, where a spectator reads the format under the title:
  // the League chip carries its line, the Finals chip is its bare name, and
  // the preset chip is the division's, unchanged.
  await page.goto(`${shared}/${divSlug}`);
  const leagueChip = page.locator(`[data-stage-id="${leagueStageId}"]`);
  await expect(leagueChip).toContainText(`League · ${leagueLine}`, { timeout: STEP_MS });
  const finalsChip = page.locator(`[data-stage-id="${finalsStageId}"]`);
  await expect(finalsChip).toContainText("Finals");
  await expect(finalsChip.getByTestId("division-stage-format")).toHaveCount(0);
  await expect(page.getByText(preset!, { exact: true })).toBeVisible();
});
