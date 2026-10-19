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
import { BRACKET_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { TAG, apiJson, divisionPath, seedScoredDivision } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPORT_RULES, type RuleField } from "../src/lib/match-rules";
import { stageFieldsFor } from "../src/lib/rule-scope";
import { rulesChipText } from "../src/lib/rules-line";

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
  config: { rules?: Record<string, unknown> | null };
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
test("a stage whose first match is scored: the lock line, a read-only view, a link to the fixtures; the API still refuses with STAGE_FORMAT_LOCKED", async ({ page, request }) => {
  test.setTimeout(150_000);
  const { divisionId, stageId } = await seedScoredDivision(request);
  const row = await openRow(page, request, divisionId, stageId);
  const line = row.getByTestId("stage-format-locked");
  await expect(line).toBeVisible();
  await expect(line).toContainText(L["stageRules.locked"]!);
  await expect(row.getByTestId("stage-format-edit"), "no way to start an edit").toHaveCount(0);
  await expect(row.getByTestId("stage-format-clear")).toHaveCount(0);
  // The read-only view: the fields show the stage's rules and none of them can be changed; there is no Save.
  await row.getByTestId("stage-format-view").click();
  const editor = row.getByTestId("stage-format-editor");
  await expect(editor).toBeVisible();
  const controls = editor.locator("input, select");
  const n = await controls.count();
  expect(n, "the read-only view shows controls to be read").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await expect(controls.nth(i), `control ${i} is disabled`).toBeDisabled();
  await expect(editor.getByTestId("stage-format-save")).toHaveCount(0);
  // The link takes the organiser to this stage's fixtures.
  await line.getByRole("button", { name: L["stageRules.lockedLink"]! }).click();
  await expect(page.getByTestId("run-sheet")).toBeVisible();
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
  const sentence = L["stageRules.locked"]!;
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

  await page.goto(await divisionPath(request, div.data!.id, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await page.getByRole("button", { name: /Format/ }).click();
  const list = page.getByTestId(`stage-rule-sequence-${seq.key}`);
  await expect(list, "the division door shows the ordered list").toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId(`stage-rule-sequence-${seq.key}-item-0`)).toContainText(seq.options!.find((o) => o.value === stored[0])!.label);
  await page.getByTestId(`stage-rule-sequence-${seq.key}-reset`).click();
  await page.getByRole("button", { name: L["divset.saveRules"]!, exact: true }).click();
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
