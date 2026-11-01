// W2c Task 17 (S1 + S4) - the stage format row for EVERY sport, driven the way an organiser drives it: the division page's
// Fixtures tab, a stage card, "Edit rules", a change, Save, and what the API then stores.
//
// What a node-env vitest cannot see (AGENTS.md class 2) is what this file is for: that the row is on the screen for each
// sport through the real page, that a click lands the value the field says, that the deciders notice follows the edit
// before anything is saved, that a locked stage says so, and that a list saved EMPTY stays empty.
//
// WHERE THE EXPECTED VALUES COME FROM. The sport population is the engine's registry (`builtinModules`), the fields a
// sport must show are `stageFieldsFor` (the engine's `ruleKeys`), the value a field must store is what the FIELD builds
// (`field.build`), and every sentence is read from the dictionary the product renders - none is typed here. The
// sequence control's rungs are the engine's own `TIEBREAK_RUNGS`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { PointsRule, pointsRuleAwardReachesTable, reachableOutcomes } from "@seazn/engine/competition";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, seedScoredDivision } from "./helpers";
import { withDb } from "./rs007-money-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPORT_RULES, type RuleField } from "../src/lib/match-rules";
import { stageFieldsFor } from "../src/lib/rule-scope";
import { pointsLine } from "../src/lib/points-line";
import { rulesChipText, rulesLineText } from "../src/lib/rules-line";
import { RULEBOOK_SPLITS } from "../src/components/v2/stage-rules/__tests__/_points-split-rulebook";
import { openPanels } from "./helpers/rules-strip";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

/** The PUBLIC dictionary: the stage row's chips are worded from its `format.rules.*` clauses, the public rules line's own. */
const PUB = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8")) as Record<string, string>;
const chipText = (key: string, params?: Record<string, string | number>): string => rulesChipText(PUB, { key, params });

const STEP_MS = 20_000;
/** Per sport: a competition, a division, a stage, a page load, an edit, a save, a read, a clear, a read. */
const PER_SPORT_MS = 90_000;

interface StageRow {
  id: string;
  kind: string;
  config: { rules?: Record<string, unknown> | null; points?: Record<string, unknown> | null };
}

/** A competition + one division of `sport` (its first variant, or `variant`) + one stage of `kind`, through the API. */
async function seedStage(
  request: APIRequestContext,
  sport: string,
  opts: { kind?: string; variant?: string; label: string; config?: Record<string, unknown> },
): Promise<{ divisionId: string; stageId: string; variant: string }> {
  const m = builtinModules.find((x) => x.key === sport)!;
  const variant = opts.variant ?? Object.keys(m.variants)[0]!;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T17 ${opts.label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `${sport} ${opts.label}`,
    sport_key: sport,
    variant_key: variant,
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });
  expect(div.status, `division ${sport}/${variant}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
    seq: 1,
    kind: opts.kind ?? "knockout",
    name: opts.kind === "league" ? "League" : "Knockout",
  });
  expect(stage.status, `stage ${sport}: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: stage.data!.id, variant };
}

async function storedRules(request: APIRequestContext, divisionId: string, stageId: string): Promise<Record<string, unknown> | null> {
  const res = await apiJson<StageRow[]>(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(res.status, `GET stages`).toBe(200);
  expect(res.data, "the stage read must carry rows").toBeDefined();
  const row = res.data!.find((s) => s.id === stageId);
  expect(row, `stage ${stageId} in the read`).toBeDefined();
  return row!.config.rules ?? null;
}

async function openRow(page: Page, request: APIRequestContext, divisionId: string, stageId: string): Promise<Locator> {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const row = page.getByTestId(`stage-format-row-${stageId}`);
  await expect(row, "the stage rules row is on the Fixtures tab").toBeVisible({ timeout: STEP_MS });
  return row;
}

async function openEditor(row: Locator): Promise<void> {
  await row.getByTestId("stage-format-edit").click();
  await expect(row.getByTestId("stage-format-editor")).toBeVisible({ timeout: STEP_MS });
}

/** The testid segment a field is rendered under: the top segment of the first engine key it edits. */
const topOf = (f: RuleField): string => f.edits[0]!.split(".")[0]!;

/** The control of a field block: its number input, its select (a sequence field has its own testid). */
const controlOf = (row: Locator, f: RuleField): Locator => row.getByTestId(`stage-rule-field-${topOf(f)}`).locator(f.kind === "number" ? "input" : "select").first();

/** The value this field is edited to in the sweep, its UI raw value: a bool goes Off, a select takes its LAST option (a best
 *  of 1 would fold "set to" into another field), a number its minimum, a sequence the empty list. */
function editTo(f: RuleField): string {
  if (f.kind === "bool") return "off";
  if (f.kind === "select") return f.options![f.options!.length - 1]!.value;
  if (f.kind === "sequence") return f.emptyValue!;
  return String(f.min ?? 1);
}

const REGISTRY = builtinModules.map((m) => m.key);

test("the registry the sweep walks is not empty", () => {
  expect(REGISTRY.length, "the engine ships its sports").toBeGreaterThanOrEqual(11);
  for (const m of builtinModules) expect(stageFieldsFor({ module: m, stageKind: "knockout", variant: null }).length, m.key).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// EVERY SPORT through the real door (carry 5): one test per registry sport, so a red names its sport.
// ---------------------------------------------------------------------------------------------------------------------
for (const m of builtinModules) {
  test(`${m.key}: the stage rules row opens on a knockout stage, shows the engine's fields, saves a change that is stored, and resets`, async ({ page, request }) => {
    test.setTimeout(Math.max(120_000, PER_SPORT_MS));
    const { divisionId, stageId, variant } = await seedStage(request, m.key, { label: "sweep" });
    const row = await openRow(page, request, divisionId, stageId);
    await openEditor(row);

    // 1. The fields the engine allows a stage of this sport are on the screen, each once: the testids ARE the engine's list.
    const fields = stageFieldsFor({ module: m, stageKind: "knockout", variant });
    expect(fields.length, `${m.key}: the engine declares stage fields`).toBeGreaterThan(0);
    const blocks = await row.locator('[data-testid^="stage-rule-field-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("stage-rule-field-".length)));
    expect([...blocks].sort(), `${m.key}: the field blocks shown`).toEqual(fields.map(topOf).sort());
    for (const f of fields) await expect(row.getByTestId(`stage-rule-field-${topOf(f)}`).first(), `${m.key}.${f.key}`).toBeVisible();

    // 2. One edit through the UI: the first field whose value is a single control we can drive and whose build writes a key.
    const target = fields.find((f) => f.kind !== "sequence" && f.kind !== "number" && Object.keys(f.build(editTo(f), {})).length > 0)
      ?? fields.find((f) => Object.keys(f.build(editTo(f), {})).length > 0)!;
    expect(target, `${m.key}: a field to edit`).toBeDefined();
    const raw = editTo(target);
    const built = target.build(raw, { [target.key]: raw });
    expect(Object.keys(built).length, `${m.key}.${target.key} builds a key`).toBeGreaterThan(0);
    if (target.kind === "number") await controlOf(row, target).fill(raw);
    else if (target.kind === "sequence") await row.getByTestId(`stage-rule-sequence-${target.key}-item-0`).locator("button").last().click();
    else await controlOf(row, target).selectOption(raw);
    await row.getByTestId("stage-format-save").click();
    await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });

    // 3. What the API stores is what the field builds (top-level keys, each deep-equal), beside whatever the preset put there.
    const rules = await storedRules(request, divisionId, stageId);
    expect(rules, `${m.key}: the save stored rules`).not.toBeNull();
    for (const [k, v] of Object.entries(built)) {
      // A decider the engine's off is null is stored as `false` (null would mean inherit).
      const stored = rules![k];
      expect(stored === false && v === null ? null : stored, `${m.key}.${k} stored`).toEqual(v === undefined ? undefined : v);
    }

    // 4. Use division rules: the stage stores nothing and the row says it is the division's.
    await expect(row.getByTestId("stage-format-clear")).toBeVisible({ timeout: STEP_MS });
    await row.getByTestId("stage-format-clear").click();
    await expect(row).toHaveText(new RegExp(L["schedule.stageFormat.inherited"]!), { timeout: STEP_MS });
    expect(await storedRules(request, divisionId, stageId), `${m.key}: cleared`).toBeNull();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// S1 deciders notice (carry 1, M-3): live while editing, and on the collapsed row after a reload.
// ---------------------------------------------------------------------------------------------------------------------
test("football knockout: the deciders notice follows the edit before anything is saved, in both modes, and survives a reload", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { divisionId, stageId } = await seedStage(request, "football", { label: "notice" });
  const row = await openRow(page, request, divisionId, stageId);
  // The stage starts with its preset (extra time + penalties): neither notice.
  await expect(row.getByTestId("stage-deciders-off")).toHaveCount(0);
  await expect(row.getByTestId("stage-deciders-level")).toHaveCount(0);
  await expect(row.getByTestId("stage-format-preset"), "the stage is the sport's knockout preset").toBeVisible();
  await openEditor(row);
  const extra = row.getByTestId("stage-rule-field-extraTime").locator("select");
  const penalties = row.getByTestId("stage-rule-field-shootout").locator("select");
  // Extra time ON, penalties OFF: a match can still end level behind a decider (the engine says so): the second mode.
  await extra.selectOption("on");
  await penalties.selectOption("off");
  await expect(row.getByTestId("stage-deciders-level")).toBeVisible();
  await expect(row.getByTestId("stage-deciders-level")).toHaveText(L["stageRules.decidersMayEndLevel"]!);
  await expect(row.getByTestId("stage-deciders-off")).toHaveCount(0);
  // Both OFF: every decider off, a level match is held.
  await extra.selectOption("off");
  await expect(row.getByTestId("stage-deciders-off")).toBeVisible();
  await expect(row.getByTestId("stage-deciders-off")).toHaveText(L["stageRules.decidersOff"]!);
  await expect(row.getByTestId("stage-deciders-level")).toHaveCount(0);
  // Penalties back ON: sudden death settles it - neither.
  await penalties.selectOption("on");
  await expect(row.getByTestId("stage-deciders-off")).toHaveCount(0);
  await expect(row.getByTestId("stage-deciders-level")).toHaveCount(0);
  // Off again, saved, reloaded: the COLLAPSED row says it too.
  await penalties.selectOption("off");
  await expect(row.getByTestId("stage-deciders-off")).toBeVisible();
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  await expect(row.getByTestId("stage-deciders-off")).toBeVisible({ timeout: STEP_MS });
  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId(`stage-format-row-${stageId}`).getByTestId("stage-deciders-off")).toBeVisible({ timeout: STEP_MS });
  const rules = await storedRules(request, divisionId, stageId);
  expect(rules?.shootout, "penalties are stored OFF").toBe(false);
});

test("a league stage never carries the held-match notice, however its deciders read", async ({ page, request }) => {
  test.setTimeout(90_000);
  const { divisionId, stageId } = await seedStage(request, "football", { label: "league-notice", kind: "league" });
  const row = await openRow(page, request, divisionId, stageId);
  await openEditor(row);
  await row.getByTestId("stage-rule-field-extraTime").locator("select").selectOption("off");
  await row.getByTestId("stage-rule-field-shootout").locator("select").selectOption("off");
  await expect(row.getByTestId("stage-rule-field-shootout").locator("select")).toHaveValue("off");
  await expect(row.getByTestId("stage-deciders-off")).toHaveCount(0);
  await expect(row.getByTestId("stage-deciders-level")).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Chess: the ordered-list control, the empty list, and "save [], reload, save again" (carries 2, 3, 6).
// ---------------------------------------------------------------------------------------------------------------------
test("chess knockout: the tie-break list reorders, empties (held), and the empty list stays empty across a reload and a second save", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { divisionId, stageId } = await seedStage(request, "boardgame", { label: "tiebreak" });
  const seq = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
  const rungLabel = (v: string): string => seq.options!.find((o) => o.value === v)!.label;
  const row = await openRow(page, request, divisionId, stageId);
  await openEditor(row);
  const list = row.getByTestId(`stage-rule-sequence-${seq.key}`);
  await expect(list).toBeVisible();
  // The default order: every rung, in the engine's order.
  for (let i = 0; i < TIEBREAK_RUNGS.length; i++) await expect(row.getByTestId(`stage-rule-sequence-${seq.key}-item-${i}`)).toContainText(rungLabel(TIEBREAK_RUNGS[i]!));
  await expect(row.getByTestId("stage-deciders-off"), "the default list is a decider").toHaveCount(0);

  // Reorder: the second rung moves to the top, and the stored order is the stage's own.
  await row.getByTestId(`stage-rule-sequence-${seq.key}-item-1`).getByRole("button", { name: new RegExp(`^${L["stageRules.sequence.moveUp"]!.replace("{item}", "")}`) }).click();
  await expect(row.getByTestId(`stage-rule-sequence-${seq.key}-item-0`)).toContainText(rungLabel(TIEBREAK_RUNGS[1]!));
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  const reordered = [TIEBREAK_RUNGS[1]!, TIEBREAK_RUNGS[0]!, ...TIEBREAK_RUNGS.slice(2)];
  expect((await storedRules(request, divisionId, stageId))?.tiebreakRungs, "the stage's own order is stored").toEqual(reordered);

  // Empty it: remove from the top until none is left. The notice (held for the organiser) appears before any save.
  await openEditor(row);
  for (let i = 0; i < TIEBREAK_RUNGS.length; i++) await row.getByTestId(`stage-rule-sequence-${seq.key}-item-0`).getByRole("button", { name: new RegExp(`^${L["stageRules.sequence.remove"]!.replace("{item}", "")}`) }).click();
  await expect(row.getByTestId(`stage-rule-sequence-${seq.key}-empty`)).toBeVisible();
  await expect(row.getByTestId("stage-deciders-off")).toBeVisible();
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  expect((await storedRules(request, divisionId, stageId))?.tiebreakRungs, "an EMPTY list is stored as a list, not dropped").toEqual([]);

  // Reload: the collapsed row still says it, the editor opens on the empty list, and a save of ANOTHER field keeps it empty.
  await page.reload({ waitUntil: "load" });
  const row2 = page.getByTestId(`stage-format-row-${stageId}`);
  await expect(row2.getByTestId("stage-deciders-off")).toBeVisible({ timeout: STEP_MS });
  await openEditor(row2);
  await expect(row2.getByTestId(`stage-rule-sequence-${seq.key}-empty`)).toBeVisible();
  const other = SPORT_RULES.boardgame!.find((f) => f.kind === "select" && f.key !== seq.key && stageFieldsFor({ module: builtinModules.find((x) => x.key === "boardgame")!, stageKind: "knockout", variant: null }).some((s) => s.key === f.key))!;
  expect(other, "chess has another stage field to edit").toBeDefined();
  await controlOf(row2, other).selectOption(other.options![other.options!.length - 1]!.value);
  await row2.getByTestId("stage-format-save").click();
  await expect(row2.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  const after = await storedRules(request, divisionId, stageId);
  expect(after?.tiebreakRungs, "no rung comes back after a second save").toEqual([]);

  // A deliberate edit puts one back: one rung chosen from the menu is a list of one.
  await openEditor(row2);
  await row2.getByTestId(`stage-rule-sequence-${seq.key}-add`).selectOption(TIEBREAK_RUNGS[2]!);
  await expect(row2.getByTestId(`stage-rule-sequence-${seq.key}-item-0`)).toContainText(rungLabel(TIEBREAK_RUNGS[2]!));
  await expect(row2.getByTestId("stage-deciders-off"), "a list of one is a decider").toHaveCount(0);
  await row2.getByTestId("stage-format-save").click();
  await expect(row2.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  expect((await storedRules(request, divisionId, stageId))?.tiebreakRungs).toEqual([TIEBREAK_RUNGS[2]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// A blanked field is sent as null, so the cleared field is not silently kept (the Save-fragment carry).
// ---------------------------------------------------------------------------------------------------------------------
test("a field the organiser blanks is removed from the stage's stored rules; the field beside it stays", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { divisionId, stageId } = await seedStage(request, "badminton", { label: "blank", kind: "league" });
  const fields = stageFieldsFor({ module: builtinModules.find((x) => x.key === "badminton")!, stageKind: "league", variant: null });
  const bestOf = fields.find((f) => f.key === "bestOf")!;
  const cap = fields.find((f) => f.key === "cap")!;
  const row = await openRow(page, request, divisionId, stageId);
  await openEditor(row);
  await controlOf(row, bestOf).selectOption("3");
  await controlOf(row, cap).fill("30");
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  const saved = await storedRules(request, divisionId, stageId);
  expect(saved?.bestOf).toBe(3);
  expect(saved?.cap).toBe(30);
  await openEditor(row);
  await controlOf(row, cap).fill("");
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  const after = await storedRules(request, divisionId, stageId);
  expect(after, "the stage still has rules").not.toBeNull();
  expect(Object.hasOwn(after!, "cap"), "the blanked field is gone from the stored rules").toBe(false);
  expect(after!.bestOf, "its sibling is untouched").toBe(3);
});

// ---------------------------------------------------------------------------------------------------------------------
// If abandoned (owner P-5): `share` needs draws; and it is offered only on a stage the engine says can share.
// ---------------------------------------------------------------------------------------------------------------------
test("generic: 'share the points' is offered only where draws are allowed, and a knockout stage has no abandon field at all", async ({ page, request }) => {
  test.setTimeout(150_000);
  // win_loss allows no draws: share is disabled, with the engine's own sentence.
  const noDraws = await seedStage(request, "generic", { label: "abandon-off", kind: "league", variant: "win_loss" });
  const row = await openRow(page, request, noDraws.divisionId, noDraws.stageId);
  await openEditor(row);
  const abandon = row.getByTestId("stage-rule-field-abandonPolicy");
  await expect(abandon).toBeVisible();
  // The DOM property, not Playwright's toBeDisabled: that matcher does not report an <option> as disabled.
  await expect(abandon.locator('option[value="share"]')).toHaveJSProperty("disabled", true);
  await expect(row.getByTestId("stage-abandon-unavailable-share")).toContainText(L["stageRules.abandon.shareNeedsDraws"]!);
  // the score variant allows draws: share is a real choice, and no reason is shown.
  const draws = await seedStage(request, "generic", { label: "abandon-on", kind: "league", variant: "score" });
  const row2 = await openRow(page, request, draws.divisionId, draws.stageId);
  await openEditor(row2);
  await expect(row2.getByTestId("stage-rule-field-abandonPolicy").locator('option[value="share"]')).toHaveJSProperty("disabled", false);
  await expect(row2.getByTestId("stage-abandon-unavailable-share")).toHaveCount(0);
  await row2.getByTestId("stage-rule-field-abandonPolicy").locator("select").selectOption("share");
  await row2.getByTestId("stage-format-save").click();
  await expect(row2.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  expect((await storedRules(request, draws.divisionId, draws.stageId))?.abandonPolicy).toBe("share");
  // a knockout stage must produce a winner: the engine declares no abandon-share for it, so the row has no such field.
  const ko = await seedStage(request, "generic", { label: "abandon-ko", kind: "knockout", variant: "score" });
  const row3 = await openRow(page, request, ko.divisionId, ko.stageId);
  await openEditor(row3);
  await expect(row3.getByTestId("stage-rule-field-abandonPolicy")).toHaveCount(0);
  // the positive pair: the same editor still shows the stage's other fields.
  expect(await row3.locator('[data-testid^="stage-rule-field-"]').count()).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// S4: a started stage says so before anyone tries, reads its rules without being able to change them, and the server still
// refuses a write (the 16b rule stands).
// ---------------------------------------------------------------------------------------------------------------------
// Match Day C2: the locked stage's Match format is the shared editor's locked mode - one lock line ("Locked: the stage has
// started") and the format as chips, read-only. No "View" form of disabled inputs and no link (the row is on the Fixtures tab).
test("a stage whose first match is scored: the lock line, the format read-only as chips, no control; the API still refuses with STAGE_FORMAT_LOCKED", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { divisionId, stageId } = await seedScoredDivision(request);
  const row = await openRow(page, request, divisionId, stageId);
  const line = row.getByTestId("stage-format-locked");
  await expect(line).toBeVisible();
  await expect(line).toContainText(L["stageCard.locked"]!);
  await expect(row.getByTestId("stage-format-edit"), "no way to start an edit").toHaveCount(0);
  await expect(row.getByTestId("stage-format-clear")).toHaveCount(0);
  // Read-only: the format is said as chips, and the row holds no control and no editor - nothing to change, no Save.
  const chips = row.getByTestId("stage-format-chips");
  await expect(chips).toBeVisible();
  expect((await chips.innerText()).trim().length, "the chips say the format").toBeGreaterThan(0);
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0);
  await expect(row.locator("input, select, textarea")).toHaveCount(0);
  await expect(row.getByTestId("stage-format-save")).toHaveCount(0);
  await expect(line.getByRole("button"), "the lock line is words, not a link").toHaveCount(0);
  // The server says no regardless of what the page showed (a stale tab, the API).
  const put = await apiJson(request, `/api/v1/stages/${stageId}/rules`, "PUT", { rules: { allowDraws: false } });
  expect(put.status, "a started stage's rules are refused").toBe(409);
  expect(put.error?.code).toBe("STAGE_FORMAT_LOCKED");
  // The positive pair: a stage that has NOT started in the same product is editable.
  const fresh = await seedStage(request, "generic", { label: "unlocked", kind: "league", variant: "score" });
  const row2 = await openRow(page, request, fresh.divisionId, fresh.stageId);
  await expect(row2.getByTestId("stage-format-locked")).toHaveCount(0);
  await expect(row2.getByTestId("stage-format-edit")).toBeVisible();
});

// The stage kinds a bracket sport reaches: the row is the same row on every bracket kind (no kind falls out of the page).
test("the row is on the page for every bracket kind of a bracket sport", async ({ page, request }) => {
  test.setTimeout(Math.max(180_000, BRACKET_KINDS.size * 45_000));
  let seen = 0;
  for (const kind of BRACKET_KINDS) {
    const { divisionId, stageId } = await seedStage(request, "football", { label: `kind-${kind}`, kind });
    const row = await openRow(page, request, divisionId, stageId);
    await expect(row.getByTestId("stage-format-edit"), kind).toBeVisible();
    seen++;
  }
  expect(seen).toBe(BRACKET_KINDS.size);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review I-1, M-4): the collapsed row says the stage's EFFECTIVE format as chips, and the kicks of a shoot-out
// are held, with the reason, while the shoot-out is off.
// ---------------------------------------------------------------------------------------------------------------------
test("football knockout: the chips say what the stage plays after each save, and the kicks are held while the shoot-out is off", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { divisionId, stageId } = await seedStage(request, "football", { label: "chips" });
  // The kicks the new stage starts with are the engine's knockout preset, read back from what the API stored.
  const preset = await storedRules(request, divisionId, stageId);
  const presetKicks = preset?.shootoutAttempts;
  expect(typeof presetKicks, "the knockout preset carries the kicks").toBe("number");
  const newKicks = presetKicks === 3 ? 4 : 3;
  const shootoutLabel = SPORT_RULES.football!.find((f) => f.key === "shootout")!.label;

  const row = await openRow(page, request, divisionId, stageId);
  const chips = row.getByTestId("stage-format-chips");
  await expect(chips, "the collapsed row carries the chips").toBeVisible({ timeout: STEP_MS });
  await expect(chips).toContainText(chipText("format.rules.decider.penalties", { n: presetKicks as number }));
  await expect(chips, "the abandon policy is always said").toContainText(chipText("format.rules.abandon.replay"));

  await openEditor(row);
  const kicks = row.getByTestId("stage-rule-field-shootoutAttempts").locator("input");
  const shootout = row.getByTestId("stage-rule-field-shootout").locator("select");
  const held = row.getByTestId("stage-rule-detail-off-shootoutAttempts");
  // Positive pair first: with the shoot-out on, the kicks are a live control and nothing explains a hold.
  await expect(kicks).toBeEnabled();
  await expect(held).toHaveCount(0);
  await shootout.selectOption("off");
  // Round 2: the chips are the SAME preview as the notice and the held kicks - they follow the edit before anything is saved.
  await expect(chips, "while editing, the chips preview what Save stores: no penalties").not.toContainText(chipText("format.rules.decider.penalties", { n: presetKicks as number }), { timeout: STEP_MS });
  await expect(kicks, "the kicks mean nothing with no shoot-out").toBeDisabled();
  await expect(held).toHaveText(L["stageRules.detail.off"]!.replace("{decider}", shootoutLabel));
  await expect(row.getByTestId("stage-rule-field-halfMinutes").locator("input"), "a field that is not a detail stays editable").toBeEnabled();
  await shootout.selectOption("on");
  await expect(kicks).toBeEnabled();
  await expect(held).toHaveCount(0);
  await expect(chips, "and back on: the penalties chip returns with it").toContainText(chipText("format.rules.decider.penalties", { n: presetKicks as number }), { timeout: STEP_MS });

  // A save moves the chips to the stage's own value, and the division's / old value is gone from them.
  await kicks.fill(String(newKicks));
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  await expect(chips).toContainText(chipText("format.rules.decider.penalties", { n: newKicks }), { timeout: STEP_MS });
  await expect(chips).not.toContainText(chipText("format.rules.decider.penalties", { n: presetKicks as number }));
  expect((await storedRules(request, divisionId, stageId))?.shootoutAttempts).toBe(newKicks);

  // Switch the shoot-out off and save: the penalties chip is gone with it.
  await openEditor(row);
  await row.getByTestId("stage-rule-field-shootout").locator("select").selectOption("off");
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  await expect(chips).not.toContainText(chipText("format.rules.decider.penalties", { n: newKicks }), { timeout: STEP_MS });
  expect((await storedRules(request, divisionId, stageId))?.shootout).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review M-2, M-3, M-5): the lock is stated once; one Cancel, beside Save; focus follows the editor.
// ---------------------------------------------------------------------------------------------------------------------
test("a locked stage says it is locked once; an open editor has one Cancel and focus follows it", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { divisionId, stageId } = await seedScoredDivision(request);
  const row = await openRow(page, request, divisionId, stageId);
  const sentence = L["stageCard.locked"]!;
  const said = (await row.innerText()).split(sentence).length - 1;
  expect(said, "the lock sentence appears once in the row").toBe(1);
  for (const text of await row.getByTestId("stage-format-summary").allInnerTexts()) expect(text, "the header carries the format alone").not.toMatch(/locked/i);
  await expect(row.getByTestId("stage-format-chips"), "a locked stage still reads its format as chips").toBeVisible();

  // An editable stage: closed, the row offers Edit and no Cancel; open, Edit is gone and Cancel is the one way out.
  const fresh = await seedStage(request, "generic", { label: "cancel", kind: "league", variant: "score" });
  const row2 = await openRow(page, request, fresh.divisionId, fresh.stageId);
  const cancels = row2.getByRole("button", { name: L["schedule.cancel"]!, exact: true });
  await expect(cancels).toHaveCount(0);
  await expect(row2.getByTestId("stage-format-edit")).toBeVisible();
  await openEditor(row2);
  await expect.soft(row2.getByTestId("stage-format-edit"), "Edit is gone while editing").toHaveCount(0);
  await expect(cancels, "one Cancel, not two").toHaveCount(1);
  await expect(row2.getByTestId("stage-format-cancel")).toBeVisible();
  await expect.soft(row2.getByTestId("stage-format-editor"), "focus lands on the editor it opened").toBeFocused();
  await row2.getByTestId("stage-format-cancel").click();
  await expect(row2.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  await expect.soft(row2.getByTestId("stage-format-edit"), "focus returns to the Edit button").toBeFocused();
  expect(await storedRules(request, fresh.divisionId, fresh.stageId), "Cancel saved nothing").toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review I-2): the DIVISION door's "Use the default order" removes a stored tie-break list.
// ---------------------------------------------------------------------------------------------------------------------
test("chess division Settings: 'Use the default order' removes the stored tie-break list from the division's config", async ({ page, request }) => {
  test.setTimeout(150_000);
  const m = builtinModules.find((x) => x.key === "boardgame")!;
  const seq = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T17 division-reset ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const stored = [TIEBREAK_RUNGS[1]!];
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Chess reset",
    sport_key: "boardgame",
    variant_key: Object.keys(m.variants)[0]!,
    config: { tiebreakRungs: stored },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const configOf = async (): Promise<Record<string, unknown>> => {
    const res = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${div.data!.id}`);
    expect(res.status).toBe(200);
    return res.data!.config;
  };
  expect((await configOf()).tiebreakRungs, "premise: the division stores its own list").toEqual(stored);

  // Match Day C2: the division's door is the Division rules strip's Match format panel (it left Settings).
  await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const strip = page.getByTestId("division-rules-strip");
  await expect(strip).toBeVisible({ timeout: STEP_MS });
  await openPanels(strip, "format");
  const list = strip.getByTestId(`stage-rule-sequence-${seq.key}`);
  await expect(list, "the division door shows the ordered list").toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId(`stage-rule-sequence-${seq.key}-item-0`)).toContainText(seq.options!.find((o) => o.value === stored[0])!.label);
  await page.getByTestId(`stage-rule-sequence-${seq.key}-reset`).click();
  await strip.getByTestId("division-rules-format-save").click();
  await expect.poll(async () => Object.hasOwn(await configOf(), "tiebreakRungs"), { timeout: STEP_MS, message: "the saved list is gone from the division" }).toBe(false);
  // The positive pair: nothing else was lost by the save.
  const after = await configOf();
  expect(Object.keys(after).length, "the rest of the config survives the save").toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 2 (re-review residual 4, G1): a blank stage list shows the list it INHERITS from its division.
// ---------------------------------------------------------------------------------------------------------------------
test("chess stage under a division that holds a tie-break list: the blank stage lists the division's, [] at the stage lists none across a reload, and the reset brings the division's back", async ({ page, request }) => {
  test.setTimeout(180_000);
  const seq = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
  const rungLabel = (v: string): string => seq.options!.find((o) => o.value === v)!.label;
  const stored = [TIEBREAK_RUNGS[1]!];
  const { divisionId, stageId } = await seedStage(request, "boardgame", { label: "inherit", config: { tiebreakRungs: stored } });
  expect((await storedRules(request, divisionId, stageId))?.tiebreakRungs, "premise: the stage holds no list of its own").toBeUndefined();
  const row = await openRow(page, request, divisionId, stageId);
  await openEditor(row);
  const item = (r: Locator, i: number): Locator => r.getByTestId(`stage-rule-sequence-${seq.key}-item-${i}`);
  // Blank stage: the division's list - ONE rung - not the engine's default three, and the control says whose it is.
  await expect(item(row, 0)).toContainText(rungLabel(stored[0]!));
  await expect(item(row, 1), "the engine's default rungs are not listed").toHaveCount(0);
  await expect(row.getByTestId(`stage-rule-sequence-${seq.key}`)).toContainText(L["stageRules.sequence.inherited"]!);
  await expect(row.getByTestId(`stage-rule-sequence-${seq.key}-reset`), "a blank list has nothing of its own to reset").toHaveCount(0);

  // The stage empties it: [] is the stage's own value, over the division's list.
  await item(row, 0).getByRole("button", { name: new RegExp(`^${L["stageRules.sequence.remove"]!.replace("{item}", "")}`) }).click();
  await expect(row.getByTestId(`stage-rule-sequence-${seq.key}-empty`)).toBeVisible();
  await row.getByTestId("stage-format-save").click();
  await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  expect((await storedRules(request, divisionId, stageId))?.tiebreakRungs, "the stage's empty list is stored").toEqual([]);

  // Reload: it still lists none (not the division's one, not the default three).
  await page.reload({ waitUntil: "load" });
  const row2 = page.getByTestId(`stage-format-row-${stageId}`);
  await openEditor(row2);
  await expect(row2.getByTestId(`stage-rule-sequence-${seq.key}-empty`)).toBeVisible({ timeout: STEP_MS });
  await expect(item(row2, 0)).toHaveCount(0);

  // Reset: the division's list is back, and the stage stores nothing of its own again.
  await row2.getByTestId(`stage-rule-sequence-${seq.key}-reset`).click();
  await expect(item(row2, 0)).toContainText(rungLabel(stored[0]!));
  await expect(item(row2, 1)).toHaveCount(0);
  await row2.getByTestId("stage-format-save").click();
  await expect(row2.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });
  expect(Object.hasOwn((await storedRules(request, divisionId, stageId)) ?? {}, "tiebreakRungs"), "the reset drops the stage's own list").toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// W2c Task 18 (S3) - the stage points section, driven the way an organiser drives it: the stage card on the Fixtures tab,
// the win / draw / loss sentence, "More" for the walkover row and bonuses, Save, and what the API and the TABLE then say.
//
// WHERE THE EXPECTED VALUES COME FROM. Whether a sport shows the walkover SCORE is the engine's `pointsRuleAwardReachesTable`;
// the editor where its flat rule says the sport's points, else the can't-set-per-stage state (W2d T10 fix round 1 I2: the
// rulebooks' splits, `_points-split-rulebook.ts`); the division's own base points are
// the numbers the test STORES on the division (distinct from the defaults, so a prefill from the wrong place is visible); the
// preview sentence is the public line's own words (`pointsLine` + the public dictionary); and the proof that a walkover pays
// what the section says is the stage's STANDINGS, read after a real walkover - not the stored JSON alone.
// ---------------------------------------------------------------------------------------------------------------------
const sectionOf = (page: Page, stageId: string): Locator => page.getByTestId(`stage-points-${stageId}`);
/** Phones fold the walkover row and the bonuses behind "More" (`md:hidden` toggle); open it only where the toggle is shown and
 *  closed (AGENTS.md class 22: gate on the toggle, never on a width literal). */
async function openMore(section: Locator): Promise<void> {
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function storedPoints(request: APIRequestContext, divisionId: string, stageId: string): Promise<Record<string, unknown> | null> {
  const res = await apiJson<StageRow[]>(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(res.status, "GET stages").toBe(200);
  const row = res.data!.find((s) => s.id === stageId);
  expect(row, `stage ${stageId} in the read`).toBeDefined();
  return row!.config.points ?? null;
}
const parsedCfg = (sport: string, variant: string): Record<string, unknown> => {
  const m = builtinModules.find((x) => x.key === sport)!;
  const r = m.configSchema.safeParse(m.variants[variant]);
  return (r.success ? r.data : m.variants[variant]) as Record<string, unknown>;
};
/** A started league of two entrants: the division started, one fixture with both sides seated. */
async function seedPointsLeague(
  request: APIRequestContext,
  sport: string,
  opts: { label: string; variant?: string; config?: Record<string, unknown>; entrantKind?: "individual" | "team" },
): Promise<{ divisionId: string; stageId: string; fixtureId: string; home: string; away: string; variant: string; start: () => Promise<void> }> {
  const { entrantKind = "individual", ...stageOpts } = opts;
  const seeded = await seedStage(request, sport, { kind: "league", ...stageOpts });
  const added = await addEntrantsViaApi(request, seeded.divisionId, [`Asha ${TAG}`, `Bala ${TAG}`], entrantKind);
  expect(added.ids, `two entrants seated (HTTP ${added.status})`).toHaveLength(2);
  const gen = await apiJson<{ fixtures: { id: string; home_entrant_id: string; away_entrant_id: string }[] }>(request, `/api/v1/stages/${seeded.stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  const fx = gen.data!.fixtures[0]!;
  return {
    ...seeded,
    fixtureId: fx.id,
    home: fx.home_entrant_id,
    away: fx.away_entrant_id,
    start: async () => {
      const started = await apiJson(request, `/api/v1/divisions/${seeded.divisionId}/start`, "POST");
      expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    },
  };
}
async function walkover(request: APIRequestContext, fixtureId: string, by: string): Promise<void> {
  const tip = (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`)).data!.last_seq;
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: tip, type: "core.forfeit", payload: { by, reason: "walkover" } });
  expect(res.status, `walkover: ${JSON.stringify(res.error)}`).toBeLessThan(300);
}
async function tableOf(request: APIRequestContext, stageId: string): Promise<Map<string, { points: number; metrics: Record<string, number> }>> {
  const st = await apiJson<{ rows: { entrantId: string; points: number; metrics: Record<string, number> }[] }>(request, `/api/v1/stages/${stageId}/standings`);
  expect(st.status, "GET standings").toBe(200);
  return new Map((st.data?.rows ?? []).map((r) => [r.entrantId, r]));
}
/** The PUT the section sends, caught as it leaves the page. */
function nextPointsPut(page: Page, stageId: string) {
  return page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === `/api/v1/stages/${stageId}/rules`, { timeout: STEP_MS });
}

/** Holds the page's re-read until released. `onSaved` is `router.refresh()` - an RSC fetch carrying `_rsc` - which is not
 *  awaited: for a moment after the PUT lands the props are still the pre-save ones. Holding it lets a test look at the
 *  section in exactly that window (the section must already read "saved"). `seen()` counts the fetches held, so a hold that
 *  caught nothing is a failure, not a pass. */
async function holdRefresh(page: Page): Promise<{ seen: () => number; release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const inFlight: Promise<void>[] = [];
  const isRefresh = (url: URL): boolean => url.searchParams.has("_rsc");
  await page.route(isRefresh, (route) => {
    const forwarded = gate.then(() => route.continue()).catch(() => undefined);
    inFlight.push(forwarded);
    return forwarded;
  });
  return {
    seen: () => inFlight.length,
    release: async () => {
      open();
      await Promise.all(inFlight); // every held fetch goes out before the hold is removed
      await page.unroute(isRefresh);
    },
  };
}

const DIVISION_BASE = { win: 4, draw: 2, loss: 1 };
/** W2d T16 (spec §5.3, §9 "Points section, widened"): the editor opens at the rule the stage PLAYS. With no rule of its own
 *  and no pin that is the sport's own rule for a league stage under the division's cfg (`tablePointsRule`, as the engine
 *  parses the cfg), and a Save of the boxes sends that shape: football's shoot-out booked `draw_plus_bonus` (B2), a set
 *  sport's set table. Derived from the engine, never a body typed here (the W2c three-box reading is retired). */
const sportLeagueRule = (sport: string, cfg: Record<string, unknown>): PointsRule => {
  const m = builtinModules.find((x) => x.key === sport)!;
  return PointsRule.parse((m.tablePointsRule as unknown as (c: unknown, k: string) => unknown)(m.configSchema.parse(cfg), "league"));
};

/** Only for the owner's per-screen verdict capture: the section cropped at 1280 / 768 / 320 into a SCRATCH dir, no page scroll
 *  at any of them. Unset in CI - never the repo. A tall viewport so the section is not clipped by the fold. */
const SHOTS = process.env.T18_SHOTS_DIR;
async function shootSection(page: Page, section: Locator, state: string, prepare?: () => Promise<void>): Promise<void> {
  if (!SHOTS) return;
  const original = page.viewportSize();
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 2600 });
    if (prepare) await prepare();
    await expectNoHorizontalScroll(page);
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(dims.scroll, `${state} at ${width}: scrollWidth ${dims.scroll} within clientWidth ${dims.client}`).toBeLessThanOrEqual(dims.client);
    await page.evaluate(() => window.scrollTo(0, 0));
    await section.screenshot({ path: `${SHOTS}/${state}-${width}.png` });
  }
  if (original) await page.setViewportSize(original);
}

test("football league: the section prefills the DIVISION's points, saves a walkover row with a score - the PUT carries only {points} - and the table pays it after a real walkover", async ({ page, request }) => {
  test.setTimeout(240_000);
  const rig = await seedPointsLeague(request, "football", { label: "points-football", config: { points: DIVISION_BASE }, entrantKind: "team" });
  const m = builtinModules.find((x) => x.key === "football")!;
  expect(pointsRuleAwardReachesTable(m), "premise: a goal sport's table reads a walkover score").toBe(true);
  const divisionCfg = { ...(m.variants[rig.variant] as Record<string, unknown>), points: DIVISION_BASE };
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = sectionOf(page, rig.stageId);
  await expect(section, "the points section is on a table stage").toBeVisible({ timeout: STEP_MS });
  await expect(section).toHaveAttribute("data-stage-points-state", "editor");
  // Nothing stored: it inherits, says so, shows the division's sentence, offers no inputs and nothing to save.
  await expect(section.getByTestId("stage-points-use-division")).toBeChecked();
  await expect(section.getByTestId("stage-points-win")).toHaveCount(0);
  await expect(section.getByTestId("stage-points-save")).toHaveCount(0);
  const divisionSentence = rulesLineText(PUB, pointsLine(sportLeagueRule("football", divisionCfg)));
  await expect(section.getByTestId("stage-points-preview")).toHaveText(divisionSentence);

  // Own points: the boxes start at the division's numbers (the prefill is the division, not a default of the editor's).
  await section.getByTestId("stage-points-use-division").uncheck();
  await expect(section.getByTestId("stage-points-win")).toHaveValue(String(DIVISION_BASE.win));
  await expect(section.getByTestId("stage-points-draw")).toHaveValue(String(DIVISION_BASE.draw));
  await expect(section.getByTestId("stage-points-loss")).toHaveValue(String(DIVISION_BASE.loss));
  await openMore(section);
  // I3, in the browser: a goal sport shows the walkover score beside the walkover points.
  await expect(section.getByTestId("stage-points-award-w")).toBeVisible();
  // Unchecked with nothing stored, the division's own numbers are a rule the stage can pin: Save is offered (the stage would
  // then keep these numbers even if the division's change).
  await expect(section.getByTestId("stage-points-save")).toBeEnabled();
  await section.getByTestId("stage-points-walkover-w").fill("7");
  await section.getByTestId("stage-points-walkover-l").fill("2");
  await section.getByTestId("stage-points-award-w").fill("3");
  await section.getByTestId("stage-points-award-l").fill("0");
  const want = { ...sportLeagueRule("football", divisionCfg), forfeit: { winnerPoints: 7, loserPoints: 2, awardScore: [3, 0] as [number, number] } };
  await shootSection(page, section, "editor", () => openMore(section));
  await expect(section.getByTestId("stage-points-preview"), "the live preview is the public line's own words").toHaveText(rulesLineText(PUB, pointsLine(want, { awardReaches: true })));
  const put = nextPointsPut(page, rig.stageId);
  await section.getByTestId("stage-points-save").click();
  const sent = (await put).postDataJSON() as Record<string, unknown>;
  expect(Object.keys(sent), "the PUT body is strict: only the arm that changed").toEqual(["points"]);
  expect(sent.points).toEqual(want);
  await expect.poll(() => storedPoints(request, rig.divisionId, rig.stageId), { timeout: STEP_MS }).toEqual(want);
  await expect(section.getByTestId("stage-points-save"), "saved: nothing left to save").toBeDisabled({ timeout: STEP_MS });

  // Reload: the stored rule comes back, and the form is the same as before the reload (the sequence test).
  await page.reload({ waitUntil: "load" });
  const again = sectionOf(page, rig.stageId);
  await expect(again.getByTestId("stage-points-use-division")).not.toBeChecked({ timeout: STEP_MS });
  await openMore(again);
  await expect(again.getByTestId("stage-points-walkover-w")).toHaveValue("7");
  await expect(again.getByTestId("stage-points-award-w")).toHaveValue("3");
  await expect(again.getByTestId("stage-points-save")).toBeDisabled();
  // Saving again after a change and a change back stores the same rule (idempotent, no stray keys).
  await again.getByTestId("stage-points-win").fill("9");
  await expect(again.getByTestId("stage-points-save")).toBeEnabled();
  await again.getByTestId("stage-points-win").fill(String(DIVISION_BASE.win));
  await expect(again.getByTestId("stage-points-save"), "changed back: not dirty").toBeDisabled();

  // Owner: "make sure that works" - a SECOND save of a DIFFERENT value, then a reload: the new rule is what is stored, what
  // the form holds and what the summary says (the first one is not).
  const want2 = { ...sportLeagueRule("football", { ...divisionCfg, points: { ...DIVISION_BASE, win: 5 } }), forfeit: { winnerPoints: 6, loserPoints: 1, awardScore: [3, 0] as [number, number] } };
  const words2 = rulesLineText(PUB, pointsLine(want2, { awardReaches: true }));
  expect(words2, "premise: the second rule reads differently from the first").not.toBe(rulesLineText(PUB, pointsLine(want, { awardReaches: true })));
  await again.getByTestId("stage-points-win").fill("5");
  await again.getByTestId("stage-points-walkover-w").fill("6");
  await again.getByTestId("stage-points-walkover-l").fill("1");
  await expect(again.getByTestId("stage-points-preview")).toHaveText(words2);
  const hold = await holdRefresh(page);
  const put2 = nextPointsPut(page, rig.stageId);
  try {
    await again.getByTestId("stage-points-save").click();
    const sent2 = (await put2).postDataJSON() as Record<string, unknown>;
    expect(Object.keys(sent2), "the second PUT is strict too").toEqual(["points"]);
    expect(sent2.points).toEqual(want2);
    await expect.poll(() => storedPoints(request, rig.divisionId, rig.stageId), { timeout: STEP_MS }).toEqual(want2);
    // The page's re-read is still in flight and the props are the pre-save ones: the section already reads "saved" (review M4).
    await expect.poll(() => hold.seen(), { message: "the page's re-read was held", timeout: STEP_MS }).toBeGreaterThan(0);
    await expect(again.getByTestId("stage-points-save"), "saved: nothing left to save while the page has not re-read").toBeDisabled();
  } finally {
    await hold.release();
  }
  await page.reload({ waitUntil: "load" });
  const third = sectionOf(page, rig.stageId);
  await expect(third.getByTestId("stage-points-use-division")).not.toBeChecked({ timeout: STEP_MS });
  await openMore(third);
  await expect(third.getByTestId("stage-points-win")).toHaveValue("5");
  await expect(third.getByTestId("stage-points-walkover-w")).toHaveValue("6");
  await expect(third.getByTestId("stage-points-walkover-l")).toHaveValue("1");
  await expect(third.getByTestId("stage-points-award-w")).toHaveValue("3");
  await expect(third.getByTestId("stage-points-preview"), "the summary says the NEW rule").toHaveText(words2);
  await expect(third.getByTestId("stage-points-save")).toBeDisabled();
  expect(await storedPoints(request, rig.divisionId, rig.stageId), "and the API still holds the new rule after the reload").toEqual(want2);

  // The table: a REAL walkover pays what the section said LAST (6 / 1 points, 3-0 in goals), not the first save's 7 / 2 nor the division's 4 / 1.
  // W2d Task 10 (PS-5d, X-PT-1): the stage was pinned at generate, BEFORE both saves; each own save before the first score
  // re-pins the field it saved, so the table pays the saved rule and not the pin's (the division's 4 / 1).
  await rig.start();
  await walkover(request, rig.fixtureId, rig.away);
  await expect
    .poll(async () => {
      const t = await tableOf(request, rig.stageId);
      return [t.get(rig.home)?.points, t.get(rig.away)?.points, t.get(rig.home)?.metrics.gf, t.get(rig.home)?.metrics.ga];
    }, { timeout: 30_000 })
    .toEqual([6, 1, 3, 0]);

  // A started stage is read-only: the same lock as the format row, said in words, with no control (and the API agrees).
  await page.reload({ waitUntil: "load" });
  const locked = sectionOf(page, rig.stageId);
  await expect(locked).toHaveAttribute("data-stage-points-state", "readonly", { timeout: STEP_MS });
  await expect(locked.locator("input, select, button:not([data-role='phone-disclosure-toggle'])")).toHaveCount(0);
  await expect(locked.getByTestId("stage-points-locked")).toContainText(L["stageCard.locked"]!);
  await expect(locked.getByTestId("stage-points-source")).toHaveText(L["stagePoints.ownPoints"]!);
  await expect(locked.getByTestId("stage-points-preview")).toHaveText(words2);
  const refused = await apiJson(request, `/api/v1/stages/${rig.stageId}/rules`, "PUT", { points: null });
  expect(refused.status, "the server holds the same lock").toBe(409);
  expect(await storedPoints(request, rig.divisionId, rig.stageId), "and the stored rule is untouched").toEqual(want2);
});

test("badminton league: a set sport shows the walkover points and NO score box, saves the walkover row without a score, and the table credits 2-0 in games whatever it pays in points", async ({ page, request }) => {
  test.setTimeout(240_000);
  const rig = await seedPointsLeague(request, "badminton", { label: "points-badminton" });
  const m = builtinModules.find((x) => x.key === "badminton")!;
  expect(pointsRuleAwardReachesTable(m), "premise: a set sport's table never reads a walkover score").toBe(false);
  const cfg = parsedCfg("badminton", rig.variant);
  const pair = (cfg.pointsMap as Record<string, [number, number]>)["*"]!;
  // W2d T16 (D10(a)): under a set table the win and the loss pay through one row per final set score the stage reaches,
  // as the engine answers; there is no plain win box.
  const scores = [...reachableOutcomes(m, cfg as never, "league")].filter((k) => k.startsWith("set:")).map((k) => k.slice("set:".length));
  expect(scores.length, "premise: a badminton league reaches final set scores").toBeGreaterThan(0);
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = sectionOf(page, rig.stageId);
  await expect(section).toBeVisible({ timeout: STEP_MS });
  await section.getByTestId("stage-points-use-division").uncheck();
  await expect(section.getByTestId("stage-points-draw"), "a sport that cannot draw has no draw box").toHaveCount(0);
  await expect(section.getByTestId("stage-points-win"), "under a set table: no plain win box").toHaveCount(0);
  let setRows = 0;
  for (const s of scores) {
    await expect(section.getByTestId(`stage-points-set-${s}-w`), `${s}: the division's pair, the winner`).toHaveValue(String(pair[0]));
    await expect(section.getByTestId(`stage-points-set-${s}-l`), `${s}: the division's pair, the loser`).toHaveValue(String(pair[1]));
    setRows++;
  }
  expect(setRows, "set rows checked").toBe(scores.length);
  await openMore(section);
  await expect(section.getByTestId("stage-points-walkover-w")).toBeVisible();
  await expect(section.getByTestId("stage-points-award-w"), "I3: the server refuses a walkover score here, so none is offered").toHaveCount(0);
  await expect(section.getByTestId("stage-points-award-l")).toHaveCount(0);
  await section.getByTestId("stage-points-walkover-w").fill("5");
  await section.getByTestId("stage-points-walkover-l").fill("1");
  const put = nextPointsPut(page, rig.stageId);
  await section.getByTestId("stage-points-save").click();
  const sent = (await put).postDataJSON() as { points: { forfeit?: Record<string, unknown> } };
  expect(Object.keys(sent)).toEqual(["points"]);
  expect(sent.points.forfeit, "no awardScore key on a set sport").toEqual({ winnerPoints: 5, loserPoints: 1 });
  const want = { ...sportLeagueRule("badminton", m.variants[rig.variant] as Record<string, unknown>), forfeit: { winnerPoints: 5, loserPoints: 1 } };
  await expect.poll(() => storedPoints(request, rig.divisionId, rig.stageId), { timeout: STEP_MS }).toEqual(want);
  // W2d Task 10 (PS-5d): pinned at generate, re-pinned by the save above, so the walkover pays the saved 5 / 1.
  await rig.start();
  await walkover(request, rig.fixtureId, rig.away);
  await expect
    .poll(async () => {
      const t = await tableOf(request, rig.stageId);
      const h = t.get(rig.home);
      return h === undefined ? null : [h.points, t.get(rig.away)?.points, h.metrics.sets_won, h.metrics.points_won];
    }, { timeout: 30_000 })
    .toEqual([5, 1, 2, 42]);
});

test("use the division's points: unchecking and saving removes the stage's rule, a reload inherits it again, and a stage that never had one cannot be saved as one", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { divisionId, stageId } = await seedStage(request, "generic", { kind: "league", label: "points-inherit", variant: "score" });
  const first = await apiJson<{ points: unknown }>(request, `/api/v1/stages/${stageId}/rules`, "PUT", { points: { win: { regulation: 5 }, draw: 2, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] } });
  expect(first.status, `seed a stage rule: ${JSON.stringify(first.error)}`).toBe(200);
  expect(await storedPoints(request, divisionId, stageId), "premise: the stage holds its own points").not.toBeNull();
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = sectionOf(page, stageId);
  await expect(section.getByTestId("stage-points-use-division")).not.toBeChecked({ timeout: STEP_MS });
  await expect(section.getByTestId("stage-points-win")).toHaveValue("5");
  await section.getByTestId("stage-points-use-division").check();
  await expect(section.getByTestId("stage-points-win"), "inheriting: the inputs go").toHaveCount(0);
  const put = nextPointsPut(page, stageId);
  await section.getByTestId("stage-points-save").click();
  const sent = (await put).postDataJSON() as Record<string, unknown>;
  expect(sent, "the removal is {points: null}, nothing else").toEqual({ points: null });
  await expect.poll(() => storedPoints(request, divisionId, stageId), { timeout: STEP_MS }).toBeNull();
  await page.reload({ waitUntil: "load" });
  const again = sectionOf(page, stageId);
  await expect(again.getByTestId("stage-points-use-division"), "a reload inherits").toBeChecked({ timeout: STEP_MS });
  await expect(again.getByTestId("stage-points-save"), "nothing stored, nothing to save").toHaveCount(0);
});

test("generic bonus editor: the margin bonuses are offered where the sport feeds them, a threshold bonus saves with its param, and a half-filled bonus blocks Save", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { divisionId, stageId } = await seedStage(request, "generic", { kind: "league", label: "points-bonus", variant: "score" });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = sectionOf(page, stageId);
  await expect(section).toBeVisible({ timeout: STEP_MS });
  await section.getByTestId("stage-points-use-division").uncheck();
  await openMore(section);
  const add = section.getByTestId("stage-points-bonus-add");
  const offered = await add.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
  expect(offered, "generic emits for/against/diff, so the margin bonuses are on offer").toContain("loss_margin_lte");
  await add.selectOption("loss_margin_lte");
  await expect(section.getByTestId("stage-points-bonus-0")).toBeVisible();
  await expect(section.getByTestId("stage-points-problem"), "a bonus with no points is not a rule").toBeVisible();
  await expect(section.getByTestId("stage-points-problem")).toHaveText(L["stagePoints.invalid.bonus"]!);
  await expect(section.getByTestId("stage-points-save")).toBeDisabled();
  await section.getByTestId("stage-points-bonus-param-0").fill("7");
  await section.getByTestId("stage-points-bonus-points-0").fill("1");
  await expect(section.getByTestId("stage-points-problem")).toHaveCount(0);
  const put = nextPointsPut(page, stageId);
  await section.getByTestId("stage-points-save").click();
  const sent = (await put).postDataJSON() as { points: { bonuses: unknown[] } };
  expect(sent.points.bonuses).toEqual([{ when: "loss_margin_lte", param: 7, points: 1 }]);
  await expect.poll(async () => ((await storedPoints(request, divisionId, stageId)) as { bonuses: unknown[] } | null)?.bonuses, { timeout: STEP_MS }).toEqual([{ when: "loss_margin_lte", param: 7, points: 1 }]);
  // The walkover pair is both-or-neither: one filled alone blocks Save with the reason, and clearing it frees Save.
  await section.getByTestId("stage-points-walkover-w").fill("3");
  await expect(section.getByTestId("stage-points-problem")).toHaveText(L["stagePoints.invalid.walkover"]!);
  await expect(section.getByTestId("stage-points-save")).toBeDisabled();
  await section.getByTestId("stage-points-walkover-w").fill("");
  await expect(section.getByTestId("stage-points-problem")).toHaveCount(0);
  // Removing the bonus and saving stores the base sentence alone (no bonuses left behind).
  await section.getByTestId("stage-points-bonus-remove-0").click();
  await section.getByTestId("stage-points-save").click();
  await expect.poll(async () => ((await storedPoints(request, divisionId, stageId)) as { bonuses: unknown[] } | null)?.bonuses, { timeout: STEP_MS }).toEqual([]);
});

// W2d Task 16 retired fix round 1 I2's "can't be set per stage yet" state: the widened section states every split the sport
// pays apart (spec §9 "Points section, widened"), so IIHF's overtime is two boxes, a save sends the split, and the server's
// flat-over-split guard (POINTS_SPLIT_FLATTENED) is said INLINE when a draft would still drop one. The numbers are the
// rulebook's (IIHF 3-2-1-0: a regulation win 3, an overtime or shoot-out win 2 and its loss 1, a regulation loss 0).
test("ice hockey (IIHF): the editor states the overtime split - its boxes open at the rulebook's 3/2/1/0, a save sends the split and the server stores it; half a split is kept and both overtime boxes left empty are refused inline before Save; the server still refuses a flat rule; a stored flat rule is said inline and clears; the plain variant keeps the editor", async ({ page, request }) => {
  test.setTimeout(180_000);
  const m = builtinModules.find((x) => x.key === "icehockey")!;
  const variants = Object.keys(m.variants);
  // The splitting variant is the rulebooks' (IIHF's 3-2-1-0), named in the shared table; the plain one is any other.
  const split = variants.find((v) => RULEBOOK_SPLITS[`icehockey/${v}`] !== undefined);
  const plain = variants.find((v) => RULEBOOK_SPLITS[`icehockey/${v}`] === undefined);
  expect(split, "premise: the rulebooks split an ice-hockey variant (iihf)").toBeDefined();
  expect(plain, "premise: and one they do not").toBeDefined();
  const reasons = RULEBOOK_SPLITS[`icehockey/${split}`]!;
  const IIHF = { win: 3, winOt: 2, lossOt: 1, loss: 0 };
  // The refusal the product renders, read off the en dictionary.
  const sentence = L["rules.err.pointsRuleInexpressible"]!.replace(
    "{reason}",
    L["rules.err.pointsSplit"]!.replace("{fields}", reasons.map((r) => L[`rules.err.pointsSplit.${r}`]!).join(", ")),
  );
  const a = await seedStage(request, "icehockey", { kind: "league", label: "points-split", variant: split });
  await page.goto(await divisionPath(request, a.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = sectionOf(page, a.stageId);
  await expect(section).toHaveAttribute("data-stage-points-state", "editor", { timeout: STEP_MS });
  await expect(section.getByTestId("stage-points-inexpressible"), "the not-yet state is gone").toHaveCount(0);
  // Inheriting: what the stage plays, row by row - the overtime rows are there.
  await expect(section.getByTestId("stage-points-row-win-ot")).toContainText(L["stagePoints.row.winOt"]!);
  await expect(section.getByTestId("stage-points-row-loss-ot")).toContainText(L["stagePoints.row.lossOt"]!);
  await section.getByTestId("stage-points-use-division").uncheck();
  await expect(section.getByTestId("stage-points-win")).toHaveValue(String(IIHF.win));
  await expect(section.getByTestId("stage-points-win-ot")).toHaveValue(String(IIHF.winOt));
  await expect(section.getByTestId("stage-points-loss-ot")).toHaveValue(String(IIHF.lossOt));
  await expect(section.getByTestId("stage-points-loss")).toHaveValue(String(IIHF.loss));
  await expect(section.getByTestId("stage-points-refusal"), "the sport's own split: nothing to refuse").toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shootSection(page, section, "split-editor");

  // ONE overtime box left empty is still a split (spec D9: a blank row pays its fallback, here a win's; the loss in
  // overtime keeps its 1), so nothing is refused and Save stays on.
  await section.getByTestId("stage-points-win-ot").fill("");
  await expect(section.getByTestId("stage-points-loss-ot"), "the other overtime box keeps its split").toHaveValue(String(IIHF.lossOt));
  await expect(section.getByTestId("stage-points-refusal"), "half a split is a rule the organiser can state").toHaveCount(0);
  await expect(section.getByTestId("stage-points-save")).toBeEnabled();
  // BOTH left empty is the flat rule over IIHF's split (no shoot-out box holds one either: the sport's rule has none): the
  // server's refusal (POINTS_SPLIT_FLATTENED), said before Save, and Save is off.
  await expect(section.getByTestId("stage-points-win-so"), "premise: the shoot-out boxes hold no split").toHaveValue("");
  await expect(section.getByTestId("stage-points-loss-so")).toHaveValue("");
  await section.getByTestId("stage-points-loss-ot").fill("");
  await expect(section.getByTestId("stage-points-refusal")).toHaveText(sentence);
  await expect(section.getByTestId("stage-points-save")).toBeDisabled();
  // Filled again, moved off the sport's numbers: the save sends the split and the server stores it.
  await section.getByTestId("stage-points-win-ot").fill(String(IIHF.winOt));
  await section.getByTestId("stage-points-loss-ot").fill(String(IIHF.lossOt));
  await section.getByTestId("stage-points-win").fill("4");
  await expect(section.getByTestId("stage-points-refusal")).toHaveCount(0);
  const put = nextPointsPut(page, a.stageId);
  await section.getByTestId("stage-points-save").click();
  const sent = (await put).postDataJSON() as { points: { win: Record<string, number>; loss: Record<string, number> } };
  expect([sent.points.win.regulation, sent.points.win.ot, sent.points.loss.ot, sent.points.loss.regulation], "the split is in the body").toEqual([4, IIHF.winOt, IIHF.lossOt, IIHF.loss]);
  await expect.poll(async () => ((await storedPoints(request, a.divisionId, a.stageId)) as { win?: { ot?: number } } | null)?.win?.ot, { timeout: STEP_MS }).toBe(IIHF.winOt);

  // Defence in depth: the server refuses a flat rule from any other caller, typed, and keeps what is stored.
  const flat = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, tie: 0, noResult: 0, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] };
  const refused = await apiJson<unknown>(request, `/api/v1/stages/${a.stageId}/rules`, "PUT", { points: flat });
  expect(refused.status, "a flat rule over IIHF's split").toBe(422);
  expect(refused.error, "typed, naming the splits").toMatchObject({ code: "POINTS_SPLIT_FLATTENED", splits: [...reasons] });
  expect(((await storedPoints(request, a.divisionId, a.stageId)) as { win?: { ot?: number } } | null)?.win?.ot, "the split rule kept").toBe(IIHF.winOt);

  // A stage that STORES a flat rule anyway (a row from before the guard): its boxes open at it, the refusal says why it
  // cannot be saved as it is, and ticking back to the division's points clears it.
  const own = { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } };
  await withDb(async (sql) => {
    await sql`update stages set config = config || ${sql.json({ points: own })} where id = ${a.stageId}`;
  });
  await page.reload({ waitUntil: "load" });
  const stored = sectionOf(page, a.stageId);
  await expect(stored).toHaveAttribute("data-stage-points-state", "editor", { timeout: STEP_MS });
  await expect(stored).toHaveAttribute("data-stage-points-basis", "own");
  await expect(stored.getByTestId("stage-points-use-division")).not.toBeChecked();
  await expect(stored.getByTestId("stage-points-win")).toHaveValue(String(own.win.regulation));
  await expect(stored.getByTestId("stage-points-refusal")).toHaveText(sentence);
  await expectNoHorizontalScroll(page);
  await shootSection(page, stored, "stored-flat");
  await stored.getByTestId("stage-points-use-division").check();
  const clearPut = nextPointsPut(page, a.stageId);
  await stored.getByTestId("stage-points-save").click();
  expect((await clearPut).postDataJSON(), "the clear sends the strict body, points null").toEqual({ points: null });
  await expect.poll(() => storedPoints(request, a.divisionId, a.stageId), { timeout: STEP_MS }).toBeNull();
  const b = await seedStage(request, "icehockey", { kind: "league", label: "points-plain", variant: plain });
  await page.goto(await divisionPath(request, b.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await expect(sectionOf(page, b.stageId), "the plain variant: the editor").toHaveAttribute("data-stage-points-state", "editor", { timeout: STEP_MS });
  await expect(sectionOf(page, b.stageId).getByTestId("stage-points-row-win-ot"), "and no overtime row of its own").toHaveCount(0);
});

test("a knockout stage has no points section (no table to rank), a league of the same division does", async ({ page, request }) => {
  test.setTimeout(120_000);
  const a = await seedStage(request, "football", { kind: "knockout", label: "points-ko" });
  await page.goto(await divisionPath(request, a.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId(`stage-format-row-${a.stageId}`), "premise: the stage row is there").toBeVisible({ timeout: STEP_MS });
  await expect(page.locator('[data-testid^="stage-points-"]'), "and carries no points section").toHaveCount(0);
  const b = await seedStage(request, "football", { kind: "league", label: "points-league" });
  await page.goto(await divisionPath(request, b.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await expect(sectionOf(page, b.stageId)).toBeVisible({ timeout: STEP_MS });
});
