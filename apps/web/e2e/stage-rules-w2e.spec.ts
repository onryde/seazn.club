// W2e Task 28 (B1-1; owner D5, ruling 157) - the five stage keys the engine reads and no editor offered, driven the way an
// organiser drives them: the division page's Fixtures tab, a stage card, "Edit rules", a change, Save, a reload, and what the
// API then stores. Carrom `pointsPerCoin`, cricket `minOversForResult` and `superOverStillTied`, football `rollingSubs` and
// `concussionSubs`.
//
// What a node-env vitest cannot see (AGENTS.md class 2) is what this file is for: that each control is on the screen of a real
// stage, that a click lands the value the field says and the API stores exactly that, that a reload hydrates it back, that
// the still-tied policy is held while the super over is off and the result floor while DLS is off, and that a started stage
// holds all five read-only while the API still refuses a write.
//
// WHERE THE EXPECTED VALUES COME FROM (class 19: pin what a control OPENS AT, not only that it is there). The value each
// control opens at is the engine's own: the variant preset the division is created from (`module.variants`, then
// `configSchema.parse` for the schema's default), read back through the API for the placeholder the page prints. Every value
// the test then saves DIFFERS from that, so a control that wrote the default (or nothing) cannot pass. Every sentence is read
// from the dictionary the product renders; none is typed here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, apiJson, divisionPath, enclosingStageCard, openStagePanel, seedRosteredFixture } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPORT_RULES, type RuleField } from "../src/lib/match-rules";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

const STEP_MS = 20_000;

/** One ruling-157 field, the stage it is driven on, and the value it is set to. */
interface Case {
  sport: string;
  variant: string;
  /** A stage kind that offers the field AND leaves it free: a knockout carries the super over on, so the still-tied policy opens enabled. */
  kind: "league" | "knockout";
  key: string;
  /** The raw value typed or picked in the control. */
  set: string;
  /** What the stage then stores for the key. */
  stored: unknown;
  /** The key's HOST: the stage switch the engine holds it behind (`detailOf`). The field is held while the switch is off and free while it is on. */
  gate?: {
    /** The switch's own cfg key, and the key of its field (the same string). */
    top: string;
    /** Whether a new stage of this kind opens with the switch off (the field held): DLS is off in every variant; a knockout plays the super over. */
    heldAtOpen: boolean;
    /** The stage rules that switch it on, laid through the API where a test needs the field free from the start. */
    frees: Record<string, unknown>;
  };
}

const CASES: readonly Case[] = [
  { sport: "carrom", variant: "icf", kind: "league", key: "pointsPerCoin", set: "2", stored: 2 },
  // Held by DLS (fix round 1: only a DLS par reads the floor): every variant opens with DLS off, so the control opens held.
  {
    sport: "cricket", variant: "odi", kind: "knockout", key: "minOversForResult", set: "8", stored: 8,
    gate: { top: "dls", heldAtOpen: true, frees: { dls: { enabled: true, edition: "standard" } } },
  },
  {
    sport: "cricket", variant: "t20", kind: "knockout", key: "superOverStillTied", set: "shared", stored: "shared",
    gate: { top: "superOver", heldAtOpen: false, frees: { superOver: true } },
  },
  // The youth variant plays rolling substitutions, so Off is a change the preset would not make on its own.
  { sport: "football", variant: "youth", kind: "knockout", key: "rollingSubs", set: "off", stored: false },
  { sport: "football", variant: "11-a-side", kind: "knockout", key: "concussionSubs", set: "2", stored: 2 },
];

const moduleOf = (sport: string) => builtinModules.find((m) => m.key === sport)!;
const fieldOf = (c: Case): RuleField => SPORT_RULES[c.sport]!.find((f) => f.key === c.key)!;
/** The engine's own value for the key under the variant: the schema's parse of the preset (its default where the preset names none). */
const engineValue = (c: Case): unknown => (moduleOf(c.sport).configSchema.parse(moduleOf(c.sport).variants[c.variant]) as Record<string, unknown>)[c.key];

interface StageRead {
  config: { rules?: Record<string, unknown> | null };
}

/** A competition + one division of `sport`/`variant` + one stage of `kind`, through the API, NOT started. */
async function seedStage(request: APIRequestContext, c: Case, label: string): Promise<{ divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2e T28 ${label} ${c.key} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `${c.sport} ${label}`,
    sport_key: c.sport,
    variant_key: c.variant,
  });
  expect(div.status, `division ${c.sport}/${c.variant}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
    seq: 1,
    kind: c.kind,
    name: c.kind === "league" ? "League" : "Knockout",
  });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: stage.data!.id };
}

/** `GET /stages/{id}`: the stage as the API serves it. The stored rules are what the page must have saved. */
async function storedRules(request: APIRequestContext, stageId: string): Promise<Record<string, unknown> | null> {
  const res = await apiJson<StageRead>(request, `/api/v1/stages/${stageId}`);
  expect(res.status, "GET /stages/{id}").toBe(200);
  return res.data!.config.rules ?? null;
}

async function divisionConfig(request: APIRequestContext, divisionId: string): Promise<Record<string, unknown>> {
  const res = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  expect(res.status, "GET /divisions/{id}").toBe(200);
  return res.data!.config;
}

async function openRow(page: Page, request: APIRequestContext, divisionId: string, stageId: string): Promise<Locator> {
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const row = page.getByTestId(`stage-format-row-${stageId}`);
  await expect(row, "the stage rules row is on the Fixtures tab").toBeVisible({ timeout: STEP_MS });
  return row;
}

async function openEditor(row: Locator): Promise<void> {
  // Match Day C3: the editor opens from the "Match format" button in the card's header (a phone: from the Stage settings menu).
  await openStagePanel(enclosingStageCard(row), "format");
  await expect(row.getByTestId("stage-format-editor")).toBeVisible({ timeout: STEP_MS });
}

/** The block a field is drawn in, and its control (a number input, or a select for a toggle or a choice). */
const blockOf = (row: Locator, c: Case): Locator => row.getByTestId(`stage-rule-field-${c.key}`);
const controlOf = (row: Locator, c: Case): Locator => blockOf(row, c).locator(fieldOf(c).kind === "number" ? "input" : "select").first();

test("the five ruling-157 fields exist in the tables, each with its dictionary label (the cases below are all of them)", () => {
  expect(CASES.length).toBe(5);
  for (const c of CASES) {
    const field = fieldOf(c);
    expect(field, `${c.sport}.${c.key} has a field`).toBeDefined();
    expect(field.labelKey, `${c.key} labelKey`).toBeDefined();
    expect(L[field.labelKey!], `${c.key} has English copy`).toBe(field.label);
    // Premise of the "opens at" check: the saved value is not what the control opens at.
    expect(c.stored, `${c.key}: the saved value must differ from the engine's own`).not.toEqual(engineValue(c));
  }
});

for (const c of CASES) {
  test(`${c.sport}.${c.key}: opens at the engine's default, saves ${JSON.stringify(c.stored)}, is read back from GET /stages/{id} and again after a reload`, async ({ page, request }) => {
    test.setTimeout(150_000);
    const field = fieldOf(c);
    const { divisionId, stageId } = await seedStage(request, c, "edit");
    const before = await storedRules(request, stageId);
    expect(Object.hasOwn(before ?? {}, c.key), `${c.key}: a new stage stores nothing for it - it inherits`).toBe(false);

    const row = await openRow(page, request, divisionId, stageId);
    await openEditor(row);
    const block = blockOf(row, c);
    const control = controlOf(row, c);
    await expect(block, `${c.key} is on the stage's editor`).toBeVisible();
    // The label is the dictionary's, in the language of the page.
    await expect(block).toContainText(L[field.labelKey!]!);

    // OPENS AT: blank (inherit), saying "Division"; a number's placeholder names the value the division holds, which is the
    // engine's own where the variant names one (the ODI result floor, 20).
    await expect(control).toHaveValue("");
    await expect(block).toHaveAttribute("data-source", "division");
    if (field.kind === "number") {
      // The placeholder names the ENGINE's value for the variant (class 19: never the stored config the page might merely echo);
      // a key the engine gives no value (football's concussion allowance: absent = not in force) says plain "Default".
      const engine = engineValue(c);
      const named = typeof engine === "number" ? `${L["rules.default"]!} (${engine})` : L["rules.default"]!;
      await expect(control).toHaveAttribute("placeholder", named);
      // And the division really holds that value, so the page and the engine are one fact (the premise, kept apart from the check above).
      const cfg = await divisionConfig(request, divisionId);
      if (typeof engine === "number") expect(cfg[c.key], `${c.key}: the division holds the engine's value`).toEqual(engine);
    } else if (field.kind === "bool") {
      await expect(control.locator("option")).toHaveText([L["rules.default"]!, L["rules.on"]!, L["rules.off"]!]);
    } else {
      await expect(control.locator("option")).toHaveText([L["rules.default"]!, ...field.options!.map((o) => L[o.labelKey!]!)]);
    }

    // A field the engine holds behind a stage switch (`detailOf`): held while the switch is off, with the reason beside it naming the
    // switch, and free while it is on. The still-tied policy answers to the super over (a knockout opens with it on); the result
    // floor to DLS (every variant opens with it off, so the floor opens held and the test turns DLS on to set it).
    if (c.gate !== undefined) {
      const switchField = SPORT_RULES[c.sport]!.find((f) => f.key === c.gate!.top)!;
      const gateSelect = row.getByTestId(`stage-rule-field-${c.gate.top}`).locator("select");
      const held = row.getByTestId(`stage-rule-detail-off-${c.key}`);
      const caption = L["stageRules.detail.off"]!.replace("{decider}", switchField.label);
      if (c.gate.heldAtOpen) {
        await expect(control, `no ${c.gate.top}, no ${c.key}: it opens held`).toBeDisabled();
        await expect(held).toHaveText(caption);
        await gateSelect.selectOption("on");
        await expect(control, `${c.gate.top} on frees ${c.key}`).toBeEnabled();
        await expect(held).toHaveCount(0);
      } else {
        await expect(control, `the knockout preset plays ${c.gate.top}, so ${c.key} opens free`).toBeEnabled();
        await expect(held).toHaveCount(0);
        await gateSelect.selectOption("off");
        await expect(control, `no ${c.gate.top}, no ${c.key}`).toBeDisabled();
        await expect(held).toHaveText(caption);
        await gateSelect.selectOption("on");
        await expect(control).toBeEnabled();
        await expect(held).toHaveCount(0);
      }
    }

    // SET and SAVE.
    if (field.kind === "number") await control.fill(c.set);
    else await control.selectOption(c.set);
    await expect(block).toHaveAttribute("data-source", "stage");
    await row.getByTestId("stage-format-save").click();
    await expect(row.getByTestId("stage-format-editor")).toHaveCount(0, { timeout: STEP_MS });

    // The API stores exactly the key the field builds, and nothing else moved (the edit touched one field).
    const after = await storedRules(request, stageId);
    expect(after, `${c.key}: the save stored rules`).not.toBeNull();
    expect(after![c.key], `${c.key} stored`).toEqual(c.stored);
    // (and the switch the test turned on to free it, where the field is held behind one the new stage did not already carry)
    const switched = c.gate !== undefined && !Object.hasOwn(before ?? {}, c.gate.top) ? [c.gate.top] : [];
    expect(Object.keys(after!).sort(), "only the edited key (and its freed switch) was added to what the stage held").toEqual([...Object.keys(before ?? {}), c.key, ...switched].sort());

    // A reload hydrates the control from the stored rules.
    await page.reload({ waitUntil: "load" });
    const row2 = page.getByTestId(`stage-format-row-${stageId}`);
    await expect(row2).toBeVisible({ timeout: STEP_MS });
    await openEditor(row2);
    await expect(controlOf(row2, c), `${c.key} reopens as saved`).toHaveValue(c.set);
    await expect(blockOf(row2, c)).toHaveAttribute("data-source", "stage");

    // Use division rules: the stage inherits again and the key is gone. (The button sits beside Save in the open panel, and closing it is part of the reset.)
    const clear = row2.getByTestId("stage-format-clear");
    await expect(clear).toBeVisible({ timeout: STEP_MS });
    await clear.click();
    await expect(row2.getByTestId("stage-format-clear")).toHaveCount(0, { timeout: STEP_MS });
    expect(Object.hasOwn((await storedRules(request, stageId)) ?? {}, c.key), `${c.key}: cleared`).toBe(false);
  });
}

for (const c of CASES) {
  test(`${c.sport}.${c.key}: the W2c lock holds it read-only on a started stage and the API refuses a write with STAGE_FORMAT_LOCKED`, async ({ page, request }) => {
    test.setTimeout(150_000);
    // A field held behind a stage switch (the still-tied policy behind the super over, the result floor behind DLS) is also disabled
    // by the switch being off; switch it on first so that, in the started stage, the LOCK is the only thing that can disable it
    // (and the unstarted twin below is free).
    const rules = c.gate === undefined ? null : c.gate.frees;

    // A started stage of this sport: a rostered fixture, the stage rules laid before the first event, then core.start.
    const seeded = await seedRosteredFixture(request, {
      label: `W2e T28 lock ${c.key} ${TAG}`,
      sportKey: c.sport,
      variantKey: c.variant,
      home: [{ fullName: `W2e Lock Home ${c.key} ${TAG}` }],
      away: [{ fullName: `W2e Lock Away ${c.key} ${TAG}` }],
      entrantKind: c.sport === "carrom" ? "individual" : "team",
      skipLineups: true,
    });
    const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${seeded.divisionId}/stages`);
    expect(stages.status, "GET stages").toBe(200);
    const stageId = stages.data![0]!.id;
    if (rules !== null) {
      const put = await apiJson(request, `/api/v1/stages/${stageId}/rules`, "PUT", { rules });
      expect(put.status, `stage rules before the start: ${JSON.stringify(put.error)}`).toBeLessThan(300);
    }
    const started = await apiJson(request, `/api/v1/fixtures/${seeded.fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.status, `core.start: ${JSON.stringify(started.error)}`).toBe(201);

    // Match Day C2: a started stage's Match format is the shared editor's locked mode - the lock line and the format as chips,
    // with no form at all (the old "View" form of disabled inputs is gone), so nothing can reach the field.
    const row = await openRow(page, request, seeded.divisionId, stageId);
    await expect(row.getByTestId("stage-locked"), "closed, the summary says the stage has started").toBeVisible();
    await openStagePanel(enclosingStageCard(row), "format");
    await expect(row.getByTestId("stage-format-locked"), "the panel says the stage has started").toBeVisible();
    await expect(row.getByTestId("stage-format-locked")).toContainText(L["stageCard.locked"]!);
    await expect(row.getByTestId("stage-format-chips"), "the format is still read, as chips").toBeVisible();
    await expect(row.getByTestId("stage-format-save"), "no way to change it: no Save").toHaveCount(0);
    await expect(blockOf(row, c), `${c.key} has no control on a started stage`).toHaveCount(0);
    await expect(row.locator("input, select, textarea"), "the locked row holds no control").toHaveCount(0);

    // The server says no regardless of what the page showed.
    const put = await apiJson(request, `/api/v1/stages/${stageId}/rules`, "PUT", { rules: { [c.key]: c.stored } });
    expect(put.status, "a started stage's rules are refused").toBe(409);
    expect(put.error?.code).toBe("STAGE_FORMAT_LOCKED");
    expect(Object.hasOwn((await storedRules(request, stageId)) ?? {}, c.key), `${c.key}: nothing was stored`).toBe(false);

    // The positive pair: an UNSTARTED stage of the same sport, variant and rules has the same field free.
    const fresh = await seedStage(request, { ...c, kind: "league" }, "unlocked");
    if (rules !== null) {
      const put2 = await apiJson(request, `/api/v1/stages/${fresh.stageId}/rules`, "PUT", { rules });
      expect(put2.status, `stage rules: ${JSON.stringify(put2.error)}`).toBeLessThan(300);
    }
    const row2 = await openRow(page, request, fresh.divisionId, fresh.stageId);
    await openEditor(row2);
    await expect(controlOf(row2, c), `${c.key} is free on a stage that has not started`).toBeEnabled();
  });
}
