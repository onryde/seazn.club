// W2c Task 20 (S4, X-SR-4 UI half) - the division's rules say what a STARTED stage locks, before the organiser
// types, and says what a save kept, instead of reading "saved" over a value that snapped back.
//
// Match Day C2: the match rules and the standings points moved from Settings' Match rules block to the Division rules strip on
// the Fixtures tab (`components/v2/rules/division-rules-strip.tsx`) - the same form and notices, each panel with its own Save.
// The STRUCTURE note (`format-locked`) stays in Settings' Format group. C2 fix round 1, I1 (ruling: spec §12 items 4 and 13
// over W2c S4): a section says its lock ONCE (`division-locked-format`, naming the stage), never a line per field; a section
// whose every control is locked reads - its chips, no field and no Save; a partly locked one keeps its form, the locked
// controls read-only.
//
// What a node-env vitest cannot see (AGENTS.md class 2): that the page really hands the form the lock the server will
// enforce, that a locked control is truly inert in a browser, and that the stale-page route (a stage starts AFTER the page
// loaded - the only way a UI save can reach the server's per-field refusal) ends in the partial-save notice, a stored
// state the notice told the truth about, and lock lines once the page refreshes.
//
// WHERE THE EXPECTED VALUES COME FROM. The fields a sport shows are `SPORT_RULES` (the form's own table), every sentence is
// read from the en dictionary the product renders, and the stored state is read back through the API - none is typed here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { legacyPointsRule, pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, apiJson, divisionPath, openStagePanel, stageCardOf } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { openPanels } from "./helpers/rules-strip";
import { SPORT_RULES } from "../src/lib/match-rules";
import { pointsLine } from "../src/lib/points-line";
import { rulesLineText } from "../src/lib/rules-line";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
/** The public dictionary: the stage points card's preview is the public stage line's own words (`format.points.*`). */
const PUB = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8")) as Record<string, string>;
const GENERIC = builtinModules.find((m) => m.key === "generic")!;
/** A dictionary sentence with its {holes} filled. */
const say = (key: string, vars: Record<string, string | number> = {}): string =>
  L[key]!.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));

const STEP_MS = 20_000;

interface Rig {
  divisionId: string;
  stageId: string;
  fixtureIds: string[];
}

/** A division of `sport`/`variant` with a league stage "Pool A" over three entrants, generated and NOT started. A stage that
 *  is told to carry `stageRules` owns those keys itself (a division change to them does not touch what the stage plays). */
async function seedLeague(
  request: APIRequestContext,
  sport: string,
  variant: string,
  label: string,
  stageRules?: Record<string, unknown>,
): Promise<Rig> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T20 ${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `${sport} ${label}`,
    sport_key: sport,
    variant_key: variant,
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  const entrants = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Ana", "Ben", "Cal"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  expect(entrants.status, `entrants: ${JSON.stringify(entrants.error)}`).toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "Pool A",
  });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  if (stageRules !== undefined) {
    const put = await apiJson(request, `/api/v1/stages/${stage.data!.id}/rules`, "PUT", { rules: stageRules });
    expect(put.status, `stage rules: ${JSON.stringify(put.error)}`).toBeLessThan(300);
  }
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  expect(gen.data!.fixtures.length, "premise: the pool has matches").toBeGreaterThan(1);
  return { divisionId, stageId: stage.data!.id, fixtureIds: gen.data!.fixtures.map((f) => f.id) };
}

/** Start the division (scoring is closed before it: 422 WRONG_PHASE), which locks NO rule by itself. */
async function startDivision(request: APIRequestContext, divisionId: string): Promise<void> {
  const res = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(res.status, `start division: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}

/** Start one match: the stage that plays it now holds the rules it inherits. */
async function startMatch(request: APIRequestContext, fixtureId: string): Promise<void> {
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(res.status, `start match: ${JSON.stringify(res.error)}`).toBe(201);
}

/** The Division rules strip on the Fixtures tab, its Match format and Points panels open. */
async function openFormat(page: Page, request: APIRequestContext, divisionId: string): Promise<void> {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: STEP_MS });
  await openPanels(strip, "format", "points");
}

/** Settings' Format group still says the STRUCTURE is locked once fixtures exist (that note did not move). */
async function expectStructureLocked(page: Page, request: APIRequestContext, divisionId: string): Promise<void> {
  await page.goto(await divisionPath(request, divisionId, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
  await page.getByRole("button", { name: /^Format/ }).click();
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(page.getByTestId("division-rules-moved"), "Settings points at the strip for the rules").toBeVisible();
}

/** The Match format panel's Save. */
const saveRules = (page: Page) => page.getByTestId("division-rules-format-save");

/** The variant picker. By role and a leading name: `getByLabel("Variant")` also matches a rule field whose help text says "variant". */
const variantPicker = (page: Page) => page.getByRole("combobox", { name: new RegExp(`^${L["divset.variant"]!}`) });

/** The Match format panel: what a rules save says renders inside it, directly under its Save button (T20 review I-1). */
const formatCard = (page: Page) => page.getByTestId("division-rules-panel-format");

/** The control of one rule field of a sport, by the label the form prints. */
const fieldControl = (page: Page, sport: string, key: string) => {
  const f = SPORT_RULES[sport]!.find((x) => x.key === key)!;
  return page.getByLabel(f.label);
};
const labelOf = (sport: string, key: string): string => SPORT_RULES[sport]!.find((x) => x.key === key)!.label;

const storedConfig = async (request: APIRequestContext, divisionId: string): Promise<Record<string, unknown>> => {
  const res = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  expect(res.status).toBe(200);
  return res.data!.config;
};

test("the registry the page reads is not empty", () => {
  expect(Object.keys(SPORT_RULES).length, "the form's sports").toBeGreaterThanOrEqual(11);
  expect(SPORT_RULES.badminton!.length, "badminton's fields").toBeGreaterThan(3);
  expect(SPORT_RULES.generic!.length, "generic's fields").toBeGreaterThan(2);
});

// ---------------------------------------------------------------------------------------------------------------------
// The locks are said BEFORE anyone types (a set sport: badminton) - and not said when nothing has started.
// ---------------------------------------------------------------------------------------------------------------------
test("badminton: a started stage locks every field and the variant before typing - the section reads, with ONE line and no Save; the same division unstarted shows none", async ({ page, request }) => {
  test.setTimeout(150_000);
  const rig = await seedLeague(request, "badminton", "short", "badminton-lines");
  const lockLines = page.locator('[data-testid^="division-locked-"]');

  // Fixtures exist, nothing has started: the structure note is up, every rule is open.
  await expectStructureLocked(page, request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  await expect(lockLines, "generated but not started: nothing is locked").toHaveCount(0);
  for (const f of SPORT_RULES.badminton!) await expect(fieldControl(page, "badminton", f.key), `${f.key} is editable`).toBeEnabled();
  await expect(variantPicker(page), "the variant is editable").toBeEnabled();

  // The division starts and a match starts.
  await startDivision(request, rig.divisionId);
  await expectStructureLocked(page, request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  await expect(lockLines, "starting the DIVISION locks no rule: only a started stage does").toHaveCount(0);
  await startMatch(request, rig.fixtureIds[0]!);
  await openFormat(page, request, rig.divisionId);

  // A started league stage plays every field the section draws and the variant: the section says so ONCE, naming the stage,
  // and reads - the format in chips, no field, no variant picker, and no Save over a form the server would refuse whole.
  const sentence = say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" });
  const line = formatCard(page).getByTestId("division-locked-format");
  await expect(line, "the section's lock line").toBeVisible({ timeout: STEP_MS });
  await expect(line).toContainText(sentence);
  await expect(formatCard(page).locator('[data-testid^="division-locked-"]'), "exactly one line for the section").toHaveCount(1);
  await expect(formatCard(page).getByTestId("match-format-chips"), "what it plays, read-only").toBeVisible();
  await expect(formatCard(page).locator("input, select, textarea"), "no field to type into").toHaveCount(0);
  for (const f of SPORT_RULES.badminton!) await expect(fieldControl(page, "badminton", f.key), `${f.key}: no control`).toHaveCount(0);
  await expect(variantPicker(page), "no variant picker").toHaveCount(0);
  await expect(saveRules(page), "no Save").toHaveCount(0);

  // The server agrees, field by field: the page's lock list is the writer's refusal list.
  const stored = await storedConfig(request, rig.divisionId);
  const patch = await page.request.patch(`/api/v1/divisions/${rig.divisionId}`, { data: { config: { ...stored, setTo: Number(stored.setTo) + 2 } } });
  expect(patch.status(), "a changed locked key is refused outright").toBe(409);
  const body = (await patch.json()) as { error?: { code?: string; refused?: { field: string; stageName: string }[] } };
  expect(body.error?.code).toBe("DIVISION_FORMAT_LOCKED");
  expect(body.error?.refused?.map((r) => [r.field, r.stageName])).toEqual([["setTo", "Pool A"]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Another sport family: generic keeps points in the TABLE. W2d loosened W2c's lock on them into the pin (design
// 2026-10-20-format-matrix-w2d-design.md §5.4 "What changes after the pin": the points keys a stage rule replaces "stop
// raising DIVISION_TABLE_RULES_LOCKED"; §10's table: that code is "now only for scoring/awardScore"; §11 item 4: W2c's lock
// tests are rewritten, not worked around). So the boxes stay open once a match has started, a save of them lands and never
// reaches the stage pinned at generate, and the stage's points card says the PIN's points (W2d final review I1).
// ---------------------------------------------------------------------------------------------------------------------
test("generic: once a match has started the rule fields lock with their own sentence, the points boxes stay open, and a points save never reaches the pinned stage's card", async ({ page, request }) => {
  test.setTimeout(180_000);
  const rig = await seedLeague(request, "generic", "score", "generic-lines"); // generated: Pool A is pinned now (W2d §5.4)
  // What the pin took at generate: the division's points as stored then (nothing has changed them yet).
  const atPin = await storedConfig(request, rig.divisionId);
  const pinned = atPin.points as { w: number; d: number; l: number };
  expect([pinned.w, pinned.d, pinned.l].every((n) => typeof n === "number"), "premise: generic stores w/d/l points").toBe(true);
  const sentence = (p: { w: number; d: number; l: number }) =>
    rulesLineText(PUB, pointsLine(legacyPointsRule({ base: { win: p.w, draw: p.d, loss: p.l } }), { awardReaches: pointsRuleAwardReachesTable(GENERIC) }));
  await startDivision(request, rig.divisionId);

  // I1, before any score: a division points save lands and never reaches the pinned stage, so its editor reads the PIN -
  // the started line, the pin's sentence, and (unchecked) boxes prefilled with the pin's numbers, never the division's new win.
  const early = pinned.w + 1;
  const patched = await apiJson(request, `/api/v1/divisions/${rig.divisionId}`, "PATCH", { config: { ...atPin, points: { ...pinned, w: early } } });
  expect(patched.status, `division points save before the first score: ${JSON.stringify(patched.error)}`).toBe(200);
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await openStagePanel(stageCardOf(page, rig.stageId), "points"); // Match Day C3: the card's Points button opens the section
  const editor = page.getByTestId(`stage-points-${rig.stageId}`);
  await expect(editor, "not scored yet: the editor").toHaveAttribute("data-stage-points-state", "editor", { timeout: STEP_MS });
  await expect(editor).toHaveAttribute("data-stage-points-basis", "pin");
  // Match Day C2: the pinned stage's checkbox says it keeps what it started with (no separate started line).
  await expect(editor.getByText(L["stagePoints.keepStarted"]!, { exact: true })).toBeVisible();
  await expect(editor.getByTestId("stage-points-preview")).toHaveText(sentence(pinned));
  await editor.getByTestId("stage-points-use-division").uncheck();
  await expect(editor.getByTestId("stage-points-win"), "the boxes start at the pin's win, not the division's new one").toHaveValue(String(pinned.w));
  await expect(editor.getByTestId("stage-points-loss")).toHaveValue(String(pinned.l));
  await editor.getByTestId("stage-points-use-division").check(); // nothing saved: the stage keeps its pin

  await startMatch(request, rig.fixtureIds[0]!);
  await openFormat(page, request, rig.divisionId);

  // The rule fields and the variant keep W2c's lock, with their own sentence (unchanged by W2d: §5.4 touches the points keys
  // only) - said ONCE for the section, which reads with no field and no Save (fix round 1, I1).
  const formatLine = formatCard(page).getByTestId("division-locked-format");
  await expect(formatLine, "the section's lock line").toBeVisible({ timeout: STEP_MS });
  await expect(formatLine).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  await expect(formatCard(page).locator('[data-testid^="division-locked-"]'), "one line for the section").toHaveCount(1);
  await expect(formatCard(page).locator("input, select, textarea"), "no rule field and no variant picker").toHaveCount(0);
  await expect(saveRules(page), "no Save for the format").toHaveCount(0);

  // W2d §5.4 / §10 (replaces W2c's DIVISION_TABLE_RULES_LOCKED line and read-only boxes here): no points lock line, and the
  // boxes are editable. Their only lock keys left are `scoring`/`awardScore`, which have no box on this form (generic has
  // neither); their refusal is division-locks.test.ts's (awardScore, DIVISION_TABLE_RULES_LOCKED).
  await expect(page.getByTestId("division-locked-points"), "no points lock line once a match has started").toHaveCount(0);
  await expect(page.getByText(say("ruleLock.DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" })), "the table sentence is said nowhere").toHaveCount(0);
  for (const box of [L["divset.win"]!, L["divset.draw"]!, L["divset.loss"]!]) {
    await expect(page.getByTestId("division-rules-panel-points").getByRole("spinbutton", { name: box }), `${box} is editable`).toBeEnabled();
  }

  // ...and a save of them lands (the Points panel's own Save): "saved" is said, and the division stores the new win.
  const moved = pinned.w + 2;
  await page.getByTestId("division-rules-panel-points").getByRole("spinbutton", { name: L["divset.win"]! }).fill(String(moved));
  await page.getByTestId("division-points-save").click();
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toBeVisible({ timeout: STEP_MS });
  await expect.poll(async () => ((await storedConfig(request, rig.divisionId)).points as { w: number }).w, { timeout: STEP_MS }).toBe(moved);

  // I1: the pinned stage's points card says what its TABLE pays - the pin's points, under the stage card's one lock line
  // (Match Day C2) - never the division's new win. The sentence is the public line's own words for the editor's rule.
  expect(sentence(pinned), "premise: the pin and the moved points read differently").not.toBe(sentence({ ...pinned, w: moved }));
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await openStagePanel(stageCardOf(page, rig.stageId), "points");
  const card = page.getByTestId(`stage-points-${rig.stageId}`);
  await expect(card, "a match has started: the card reads").toHaveAttribute("data-stage-points-state", "readonly", { timeout: STEP_MS });
  await expect(card).toHaveAttribute("data-stage-points-basis", "pin");
  await expect(card.getByTestId("stage-points-locked")).toContainText(L["stageCard.locked"]!);
  await expect(card.getByTestId("stage-points-source"), "a pin says no source line").toHaveCount(0);
  await expect(card.getByTestId("stage-points-preview")).toHaveText(sentence(pinned));
  await expect(card.getByText(L["stagePoints.divisionPoints"]!), "never 'the division's points'").toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The stale page: the only way a UI save reaches the server's per-field refusal. A mixed save names what was kept.
// ---------------------------------------------------------------------------------------------------------------------
test("a stage starts after the page loaded: a mixed save says what landed and names what was kept, then the page locks it", async ({ page, request }) => {
  test.setTimeout(180_000);
  // Pool A plays its own cap (cap is its own, so a division change to it lands), and inherits setTo (locked once it starts).
  const rig = await seedLeague(request, "badminton", "short", "stale-mixed", { cap: 15 });
  await startDivision(request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  const lockLines = page.locator('[data-testid^="division-locked-"]');
  await expect(lockLines, "premise: the page loaded with nothing locked").toHaveCount(0);
  const before = await storedConfig(request, rig.divisionId);
  const newSetTo = Number(before.setTo) + 2;
  const newCap = Number(before.cap) + 4;

  // A match starts in another tab; this one does not know.
  await startMatch(request, rig.fixtureIds[0]!);

  await fieldControl(page, "badminton", "setTo").fill(String(newSetTo));
  await fieldControl(page, "badminton", "cap").fill(String(newCap));
  await saveRules(page).click();

  // The notice: some landed, which were kept and why - and it does NOT say the rules were saved.
  const partial = page.getByTestId("division-partial-save");
  await expect(partial).toBeVisible({ timeout: STEP_MS });
  // ...where the organiser is looking: in the viewport right after Save (not 700px down the page), inside the Format card.
  await expect(partial).toBeInViewport();
  await expect(formatCard(page).getByTestId("division-partial-save")).toBeVisible();
  await expect(partial).toHaveAttribute("role", "status");
  await expect(partial).toContainText(say("ruleLock.partialSave", { n: 1 }));
  const kept = page.getByTestId("division-refused-setTo");
  await expect(kept).toContainText(labelOf("badminton", "setTo"));
  await expect(kept).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  await expect(page.getByTestId("division-refused-cap"), "cap landed: it is not listed").toHaveCount(0);
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toHaveCount(0);

  // The notice told the truth: the stored config has the cap the stage does not inherit, and the old setTo.
  await expect(async () => {
    const after = await storedConfig(request, rig.divisionId);
    expect(after.cap, "the open key landed").toBe(newCap);
    expect(after.setTo, "the locked key kept its stored value").toBe(before.setTo);
  }).toPass({ timeout: STEP_MS });

  // The page then locks what it was told: setTo read-only (no reload needed), cap still open, and the section says why ONCE.
  const line = formatCard(page).getByTestId("division-locked-format");
  await expect(line).toBeVisible({ timeout: STEP_MS });
  await expect(line).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  await expect(lockLines, "one line, the section's").toHaveCount(1);
  await expect(fieldControl(page, "badminton", "setTo")).toBeDisabled();
  await expect(fieldControl(page, "badminton", "cap")).toBeEnabled();
  // The locked box shows what is STORED, not the value that was typed and kept out (T20 review I-2) - before any reload.
  await expect(fieldControl(page, "badminton", "setTo")).toHaveValue(String(before.setTo));
  await expect(fieldControl(page, "badminton", "cap")).toHaveValue(String(newCap));

  // A reload reads the lock from the server (every key Pool A inherits; its own cap stays open): still one line, a form
  // around the open cap, with the stored values the notice promised.
  await openFormat(page, request, rig.divisionId);
  await expect(formatCard(page).getByTestId("division-locked-format")).toBeVisible({ timeout: STEP_MS });
  await expect(lockLines, "one line, the section's").toHaveCount(1);
  await expect(fieldControl(page, "badminton", "setTo")).toBeDisabled();
  await expect(fieldControl(page, "badminton", "cap")).toBeEnabled();
  await expect(fieldControl(page, "badminton", "setTo")).toHaveValue(String(before.setTo));
  await expect(fieldControl(page, "badminton", "cap")).toHaveValue(String(newCap));

  // The sequence: a save AFTER the partial one is clean - the notice is gone, "saved" is said, the cap lands again.
  await fieldControl(page, "badminton", "cap").fill(String(newCap + 1));
  await saveRules(page).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId("division-partial-save")).toHaveCount(0);
  expect((await storedConfig(request, rig.divisionId)).cap).toBe(newCap + 1);
});

test("a stage starts after the page loaded: a save of ONLY locked fields is refused whole, every refused field named", async ({ page, request }) => {
  test.setTimeout(180_000);
  const rig = await seedLeague(request, "badminton", "short", "stale-refused");
  await startDivision(request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  await expect(page.locator('[data-testid^="division-locked-"]'), "premise: nothing locked on load").toHaveCount(0);
  const before = await storedConfig(request, rig.divisionId);
  await startMatch(request, rig.fixtureIds[0]!);

  await fieldControl(page, "badminton", "setTo").fill(String(Number(before.setTo) + 2));
  await fieldControl(page, "badminton", "finalSetTo").fill(String(Number(before.finalSetTo) + 2));
  await saveRules(page).click();

  // The refusal is said in the reader's words, naming the stage; BOTH refused fields are listed - in the viewport, inside the card.
  const refusal = page.getByText(say("rules.err.divisionFormatLocked", { stage: "Pool A" }));
  await expect(refusal).toBeVisible({ timeout: STEP_MS });
  await expect(refusal).toBeInViewport();
  await expect(formatCard(page).getByText(say("rules.err.divisionFormatLocked", { stage: "Pool A" }))).toBeVisible();
  await expect(page.getByTestId("division-refused-list")).toBeInViewport();
  for (const key of ["setTo", "finalSetTo"]) {
    const item = page.getByTestId(`division-refused-${key}`);
    await expect(item, `${key} is listed`).toBeVisible();
    await expect(item).toContainText(labelOf("badminton", key));
  }
  await expect(page.getByTestId("division-partial-save"), "nothing was saved").toHaveCount(0);
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toHaveCount(0);
  const after = await storedConfig(request, rig.divisionId);
  expect([after.setTo, after.finalSetTo], "nothing landed").toEqual([before.setTo, before.finalSetTo]);

  // And the form locks them from then on - one line for the section, both read-only - and the locked boxes show the stored
  // values, not what was typed (review I-2).
  await expect(formatCard(page).getByTestId("division-locked-format")).toBeVisible();
  await expect(formatCard(page).locator('[data-testid^="division-locked-"]'), "one line, not one per field").toHaveCount(1);
  await expect(fieldControl(page, "badminton", "setTo")).toBeDisabled();
  await expect(fieldControl(page, "badminton", "finalSetTo")).toBeDisabled();
  await expect(fieldControl(page, "badminton", "setTo")).toHaveValue(String(before.setTo));
  await expect(fieldControl(page, "badminton", "finalSetTo")).toHaveValue(String(before.finalSetTo));
});

test("a stage starts after the page loaded: a changed variant is refused, the picker goes back to the stored variant, and the list names controls (not config keys)", async ({ page, request }) => {
  test.setTimeout(180_000);
  const rig = await seedLeague(request, "badminton", "short", "stale-variant");
  await startDivision(request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  await expect(page.locator('[data-testid^="division-locked-"]'), "premise: nothing locked on load").toHaveCount(0);
  const picker = variantPicker(page);
  const values = await picker.locator("option").evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
  const other = values.find((v) => v !== "short");
  expect(other, "premise: badminton offers a second variant").toBeDefined();
  await startMatch(request, rig.fixtureIds[0]!);

  await picker.selectOption(other!);
  await expect(picker, "premise: the chosen variant is on screen").toHaveValue(other!);
  await saveRules(page).click();

  const list = page.getByTestId("division-refused-list");
  await expect(list).toBeVisible({ timeout: STEP_MS });
  await expect(list).toBeInViewport();
  await expect(page.getByTestId("division-refused-variant_key")).toContainText(L["divset.variant"]!);
  // Every line is a control the organiser can see: the variant, a rule field's label, the points boxes, or the grouped line.
  const allowed = new Set([L["divset.variant"]!, L["divset.standingsPoints"]!, L["ruleLock.otherSettings"]!, ...SPORT_RULES.badminton!.map((f) => f.label)]);
  const labels = await list.locator("li > span").allTextContents();
  expect(labels.length, "the list names something").toBeGreaterThan(0);
  for (const label of labels) expect(allowed.has(label.trim()), `"${label}" is a control's name, not a raw config key`).toBe(true);

  // Nothing landed, and the picker shows the variant that is STORED - before any reload (review I-2).
  expect((await apiJson<{ variant_key: string }>(request, `/api/v1/divisions/${rig.divisionId}`)).data!.variant_key).toBe("short");
  await expect(picker).toHaveValue("short");
  await expect(picker).toBeDisabled();
  await expect(formatCard(page).getByTestId("division-locked-format")).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  await expect(formatCard(page).locator('[data-testid^="division-locked-"]'), "one line for the section").toHaveCount(1);
});
