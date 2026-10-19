// W2c Task 19 (S2 + S4, X-SR-2, X-SR-3, X-SR-5) - the match rules block on the fixture console, and the run sheet's "Format
// changed" tag, driven the way an organiser drives them: the fixture page, a change, Save, a reload, and what the API and the
// run sheet then say.
//
// What a node-env vitest cannot see (AGENTS.md class 2) is what this file is for: that the block is on the real page, that a
// click lands the value the field says, that a reload still shows it, that "Use stage rules" really clears it (and the tag
// with it), that a live correction keeps the ledger, that a misfit correction is refused in words and changes nothing, and
// that a finished match is locked.
//
// WHERE THE EXPECTED VALUES COME FROM. The stage's own format is the engine's (`configSchema.parse(variants[v])` with the
// stage preset), the options a decider offers are the stage's value down to 1 (the engine's `off_or_shorter` bound), the
// refusal sentence is the dictionary's frame around the SERVER's own reason (read off the same refusal over the API), and
// every label is read from the en dictionary - none is typed here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, fixturePath } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { matchFieldsFor } from "../src/lib/rule-scope";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const say = (key: string, vars: Record<string, string | number> = {}): string =>
  L[key]!.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));

const STEP_MS = 20_000;
const mod = (key: string) => builtinModules.find((m) => m.key === key)!;

interface Seed {
  divisionId: string;
  stageId: string;
  fixtureIds: string[];
  /** The fixture page of `fixtureIds[0]`. */
  console: string;
  /** The division's Fixtures tab (the run sheet). */
  fixtures: string;
  variant: string;
  entrantIds: string[];
}

/** A competition + division of `sport` + `entrants` entrants + one stage of `kind` (its rules PUT before the draw) +
 *  the draw + the division started, through the API. */
async function seed(
  request: APIRequestContext,
  sport: string,
  opts: { label: string; kind: "league" | "knockout"; entrants: number; entrantKind?: "individual" | "team"; variant?: string; stageRules?: Record<string, unknown> },
): Promise<Seed> {
  const m = mod(sport);
  const variant = opts.variant ?? Object.keys(m.variants)[0]!;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2c T19 ${opts.label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `${sport} ${opts.label}`,
    sport_key: sport,
    variant_key: variant,
  });
  expect(div.status, `division ${sport}/${variant}: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const names = Array.from({ length: opts.entrants }, (_, i) => `T19 ${opts.label} ${i + 1} ${TAG}`);
  const added = await addEntrantsViaApi(request, div.data!.id, names, opts.entrantKind ?? "individual");
  expect(added.ids, "the entrants were added").toHaveLength(opts.entrants);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: opts.kind, name: opts.kind === "league" ? "League" : "Knockout" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  if (opts.stageRules !== undefined) {
    const put = await apiJson(request, `/api/v1/stages/${stage.data!.id}/rules`, "PUT", { rules: opts.stageRules });
    expect(put.status, `stage rules: ${JSON.stringify(put.error)}`).toBe(200);
  }
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  expect(gen.data!.fixtures.length, "the draw has matches").toBeGreaterThan(0);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtureIds = gen.data!.fixtures.map((f) => f.id);
  return {
    divisionId: div.data!.id,
    stageId: stage.data!.id,
    fixtureIds,
    console: await fixturePath(request, fixtureIds[0]!),
    fixtures: await divisionPath(request, div.data!.id, "?tab=fixtures"),
    variant,
    entrantIds: added.ids,
  };
}

interface RulesRead {
  cfg: Record<string, unknown>;
  rules_version: number;
  format_line: string;
}
async function rulesOf(request: APIRequestContext, fixtureId: string): Promise<RulesRead> {
  const r = await apiJson<RulesRead>(request, `/api/v1/fixtures/${fixtureId}/rules`);
  expect(r.status, `GET rules: ${JSON.stringify(r.error)}`).toBe(200);
  return r.data!;
}
interface EventRow {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
}
async function eventsOf(request: APIRequestContext, fixtureId: string): Promise<EventRow[]> {
  const r = await apiJson<EventRow[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(r.status, `GET events: ${JSON.stringify(r.error)}`).toBe(200);
  return r.data!;
}
async function post(request: APIRequestContext, fixtureId: string, seq: number, type: string, payload: unknown): Promise<void> {
  const r = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: seq, type, payload });
  expect(r.status, `${type}: ${JSON.stringify(r.error)}`).toBe(201);
}

async function openConsole(page: Page, path: string): Promise<Locator> {
  await page.goto(path, { waitUntil: "load" });
  await dismissCookieBanner(page);
  const block = page.getByTestId("match-rules-block");
  await expect(block, "the match rules block is on the fixture page").toBeVisible({ timeout: STEP_MS });
  return block;
}
/** The control of one field block: its select, or its number input. */
const selectOf = (block: Locator, top: string): Locator => block.getByTestId(`stage-rule-field-${top}`).getByRole("combobox");
const inputOf = (block: Locator, top: string): Locator => block.getByTestId(`stage-rule-field-${top}`).locator("input");
/** Click Save and wait for the write; a SUCCESSFUL save also waits for the page's own refresh to land. The block re-seeds
 *  from the refreshed page (a fresh `useId`, hence a new `aria-labelledby`), and a value typed into the old DOM before that
 *  is lost - exactly what a test that fills straight after a save would race. A refused save has no refresh to wait for. */
async function save(page: Page, block: Locator, opts: { refused?: boolean } = {}): Promise<void> {
  const before = await block.getAttribute("aria-labelledby");
  const put = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/v1\/fixtures\/[^/]+\/rules$/.test(new URL(r.url()).pathname), { timeout: STEP_MS });
  await block.getByTestId("match-rules-save").click();
  await put;
  if (opts.refused !== true) await expect(block, "the page refreshed and the block re-seeded").not.toHaveAttribute("aria-labelledby", before!, { timeout: STEP_MS });
}
const optionValues = (select: Locator): Promise<string[]> => select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
const chipsOnSheet = (page: Page): Locator => page.getByTestId("run-sheet-format-changed");

// ---------------------------------------------------------------------------------------------------------------------
// X-SR-2: change one match's format before it starts; reset it; change it again.
// ---------------------------------------------------------------------------------------------------------------------
test("X-SR-2 change one match's format before it starts: it reads best of 1, survives a reload, the run sheet tags THAT match only", async ({ page, request }) => {
  test.setTimeout(150_000);
  const s = await seed(request, "badminton", { label: "change", kind: "league", entrants: 3 });
  expect(s.fixtureIds.length, "premise: a sibling that stays untouched exists").toBeGreaterThan(1);
  const stageBestOf = (mod("badminton").configSchema.parse(mod("badminton").variants[s.variant]) as { bestOf: number }).bestOf;
  expect(stageBestOf, "premise: the stage plays more than one set, so best of 1 is a change").toBeGreaterThan(1);

  const block = await openConsole(page, s.console);
  await expect(block.getByTestId("match-rules-overridden"), "no override yet").toHaveCount(0);
  await expect(block.getByTestId("match-rules-reset"), "nothing to reset yet").toHaveCount(0);
  await expect(block.getByTestId("match-rules-stage-line"), "the stage's format is said").toBeVisible();
  await expect(selectOf(block, "bestOf"), "opens at the stage's value").toHaveValue(String(stageBestOf));
  await expect(block.getByTestId("match-rules-save"), "Save waits for a change").toBeDisabled();

  await expect(block.getByTestId("stage-rule-field-setTo"), "best of 3 shows both points fields").toHaveCount(1);
  await selectOf(block, "bestOf").selectOption("1");
  await expect(block.getByTestId("stage-rule-field-bestOf")).toHaveAttribute("data-source", "match");
  await expect(block.getByTestId("stage-rule-field-setTo"), "best of 1 folds them into one 'Points to win'").toHaveCount(0);
  await inputOf(block, "finalSetTo").fill("15");
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  const changed = (await rulesOf(request, s.fixtureIds[0]!)).cfg;
  expect(changed.bestOf, "the effective rules read best of 1").toBe(1);
  expect({ finalSetTo: changed.finalSetTo, setTo: changed.setTo }, "the one points field wrote BOTH keys").toEqual({ finalSetTo: 15, setTo: 15 });
  expect((await rulesOf(request, s.fixtureIds[1]!)).cfg.bestOf, "a sibling still plays the stage's format").toBe(stageBestOf);

  // A reload still shows it, on the value.
  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  await expect(selectOf(page.getByTestId("match-rules-block"), "bestOf")).toHaveValue("1");

  // The run sheet tags the changed match - and only that one.
  await page.goto(s.fixtures, { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(chipsOnSheet(page), "exactly the changed match is tagged").toHaveCount(1, { timeout: STEP_MS });
  const no = Number(new URL(s.console, "http://x").pathname.split("/").pop());
  await expect(page.locator(`li[data-fixture-no="${no}"]`).getByTestId("run-sheet-format-changed")).toBeVisible();
  await expect(chipsOnSheet(page).first()).toHaveText(L["runSheet.formatChanged"]!);
});

test("X-SR-2 'Use stage rules' clears the override and the tag - override, reload, reset, reload, override again", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await seed(request, "badminton", { label: "reset", kind: "league", entrants: 3 });
  const stageBestOf = (mod("badminton").configSchema.parse(mod("badminton").variants[s.variant]) as { bestOf: number }).bestOf;
  const longer = String(Math.max(...matchFieldsFor({ module: mod("badminton"), stageKind: "league", variant: s.variant }).find((f) => f.key === "bestOf")!.options!.map((o) => Number(o.value))));
  expect(Number(longer), "premise: the sport offers a longer best-of than the stage's").toBeGreaterThan(stageBestOf);

  // 1. override through the UI, 2. reload
  let block = await openConsole(page, s.console);
  await selectOf(block, "bestOf").selectOption("1");
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  await page.reload({ waitUntil: "load" });
  block = page.getByTestId("match-rules-block");
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });

  // 3. reset
  const reset = page.waitForResponse((r) => r.request().method() === "PUT" && /\/rules$/.test(new URL(r.url()).pathname));
  await block.getByTestId("match-rules-reset").click();
  expect((await reset).status(), "the reset is accepted").toBe(200);
  await expect(block.getByTestId("match-rules-overridden")).toHaveCount(0, { timeout: STEP_MS });
  await expect(block.getByTestId("match-rules-reset")).toHaveCount(0);
  await expect(selectOf(block, "bestOf"), "back on the stage's value").toHaveValue(String(stageBestOf));
  expect((await rulesOf(request, s.fixtureIds[0]!)).cfg.bestOf, "the stage's format again").toBe(stageBestOf);

  // 4. reload: still clear, and the run sheet carries no tag
  await page.reload({ waitUntil: "load" });
  await expect(page.getByTestId("match-rules-block")).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId("match-rules-overridden")).toHaveCount(0);
  await page.goto(s.fixtures, { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.locator("li[data-fixture-no]").first(), "the run sheet rendered, so 'no chip' is not a blank page").toBeVisible({ timeout: STEP_MS });
  await expect(chipsOnSheet(page), "no tag after a reset").toHaveCount(0);

  // 5. override again (a LONGER format - a non-decider key is not bounded to shorter), tag is back
  block = await openConsole(page, s.console);
  await selectOf(block, "bestOf").selectOption(longer);
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  expect((await rulesOf(request, s.fixtureIds[0]!)).cfg.bestOf).toBe(Number(longer));
  await page.goto(s.fixtures, { waitUntil: "load" });
  await expect(chipsOnSheet(page)).toHaveCount(1, { timeout: STEP_MS });

  // 6. choosing the stage's own value back is no override at all (Save sends {}), and the tag goes
  block = await openConsole(page, s.console);
  await selectOf(block, "bestOf").selectOption(String(stageBestOf));
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toHaveCount(0, { timeout: STEP_MS });
  await page.goto(s.fixtures, { waitUntil: "load" });
  await expect(page.locator("li[data-fixture-no]").first()).toBeVisible({ timeout: STEP_MS });
  await expect(chipsOnSheet(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// X-SR-5: correct a started match's format.
// ---------------------------------------------------------------------------------------------------------------------
test("X-SR-5 correct a live match's format: a fitting change saves, bumps the rules version, and the ledger is untouched", async ({ page, request }) => {
  test.setTimeout(150_000);
  const s = await seed(request, "badminton", { label: "live", kind: "league", entrants: 2 });
  const id = s.fixtureIds[0]!;
  await post(request, id, 0, "core.start", {});
  const before = { events: await eventsOf(request, id), rules: await rulesOf(request, id) };
  expect(before.events, "premise: one event, the start").toHaveLength(1);

  const block = await openConsole(page, s.console);
  await expect(block).toHaveAttribute("data-state", "live");
  await expect(block.getByTestId("match-rules-save"), "a live match keeps its form closed").toHaveCount(0);
  await expect(block.getByTestId("stage-rule-field-bestOf")).toHaveCount(0);
  await block.getByTestId("match-rules-correct").click();
  await expect(block.getByTestId("match-rules-warning"), "the form says the match so far is kept").toHaveText(L["matchRules.correctWarning"]!);
  // Cancel walks the correction back: the form closes, nothing is written, and reopening shows the format as it was.
  await selectOf(block, "bestOf").selectOption("5");
  await block.getByTestId("match-rules-cancel").click();
  await expect(block.getByTestId("match-rules-save"), "Cancel closes the form").toHaveCount(0);
  expect((await rulesOf(request, id)).cfg.bestOf, "Cancel wrote nothing").toBe(before.rules.cfg.bestOf);
  await block.getByTestId("match-rules-correct").click();
  await expect(selectOf(block, "bestOf"), "reopened at the format the match plays").toHaveValue(String(before.rules.cfg.bestOf));
  await selectOf(block, "bestOf").selectOption("5");
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  await expect(block.getByTestId("match-rules-error")).toHaveCount(0);
  await expect(block.getByTestId("match-rules-save"), "the form closes after the correction").toHaveCount(0);

  const after = { events: await eventsOf(request, id), rules: await rulesOf(request, id) };
  expect(after.rules.cfg.bestOf, "the corrected format").toBe(5);
  expect(after.rules.rules_version, "a correction bumps the version an open pad compares").toBe(before.rules.rules_version + 1);
  expect(after.events, "a correction writes no score event and touches none").toEqual(before.events);
});

test("X-SR-5 a correction the play does not fit is refused in words, and nothing changes (football in extra time)", async ({ page, request }) => {
  test.setTimeout(180_000);
  const m = mod("football");
  const stageEt = { enabled: true, halfMinutes: 15 };
  const s = await seed(request, "football", { label: "misfit", kind: "knockout", entrants: 2, entrantKind: "team", variant: "11-a-side", stageRules: { extraTime: stageEt, shootout: true } });
  const id = s.fixtureIds[0]!;
  let seq = 0;
  for (const [type, payload] of [["core.start", {}], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }]] as const)
    await post(request, id, seq++, type, payload);
  const before = { events: await eventsOf(request, id), rules: await rulesOf(request, id) };
  expect(before.rules.cfg.extraTime, "premise: the match plays extra time").toMatchObject({ enabled: true });
  expect(before.events, "four events recorded").toHaveLength(4);

  const block = await openConsole(page, s.console);
  await block.getByTestId("match-rules-correct").click();
  // The Task 5 carry: extra time opens AT the stage's length and offers Off or SHORTER, never longer and never a blind "On".
  const et = selectOf(block, "extraTime");
  await expect(et, "opens at the stage's value").toHaveValue(String(stageEt.halfMinutes));
  const offered = (await optionValues(et)).filter((v) => v !== "");
  expect(offered, "off is offered").toContain("off");
  const lengths = offered.filter((v) => v !== "off").map(Number);
  expect(Math.max(...lengths), "nothing longer than the stage's").toBe(stageEt.halfMinutes);
  expect(lengths.length, "every shorter length down to one minute").toBe(stageEt.halfMinutes);
  expect(m.key, "the sport under test").toBe("football");

  // What the server says to the very same correction, over the API (a refusal changes nothing, so asking is free).
  const asked = await apiJson(request, `/api/v1/fixtures/${id}/rules`, "PUT", { rules: { extraTime: { enabled: false, halfMinutes: stageEt.halfMinutes } } });
  expect(asked.status, "premise: the server refuses it").toBe(409);
  expect(asked.error?.code).toBe("FORMAT_DOES_NOT_FIT_PLAY");
  const reason = asked.error!.message!;
  expect(reason.length, "the server gives a reason").toBeGreaterThan(0);
  // A reason the app owns a sentence for (a `fit_reason`: the en dictionary IS the server's text) reads as that sentence; the
  // engine's own reason is framed in the reader's language (`rules.err.formatDoesNotFitPlayBecause`).
  const appOwns = Object.entries(L).some(([key, value]) => key.startsWith("rules.err.") && value === reason);
  const expected = appOwns ? reason : say("rules.err.formatDoesNotFitPlayBecause", { reason });

  await et.selectOption("off");
  await save(page, block, { refused: true });
  const error = block.getByTestId("match-rules-error");
  await expect(error).toBeVisible({ timeout: STEP_MS });
  await expect(error, "the refusal in the dictionary's words around the server's reason").toHaveText(expected);
  expect((await error.textContent()) ?? "", "the reason is filled").toContain(reason);

  const after = { events: await eventsOf(request, id), rules: await rulesOf(request, id) };
  expect(after.rules, "cfg and version unchanged").toEqual(before.rules);
  expect(after.events, "no event written or touched").toEqual(before.events);
  await expect(block.getByTestId("match-rules-overridden")).toHaveCount(0);

  // Positive pair: a SHORTER extra time fits and is taken, still with the four events.
  await et.selectOption("10");
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  await expect(block.getByTestId("match-rules-error"), "a successful save clears the refusal").toHaveCount(0);
  const done = { events: await eventsOf(request, id), rules: await rulesOf(request, id) };
  expect(done.rules.cfg.extraTime).toMatchObject({ enabled: true, halfMinutes: 10 });
  expect(done.events).toEqual(before.events);
});

// ---------------------------------------------------------------------------------------------------------------------
// X-SR-3: a finished match.
// ---------------------------------------------------------------------------------------------------------------------
test("X-SR-3 a finished match shows the lock and no form - and the server refuses the same write", async ({ page, request }) => {
  test.setTimeout(150_000);
  const s = await seed(request, "badminton", { label: "locked", kind: "league", entrants: 2 });
  const id = s.fixtureIds[0]!;
  // Changed before it started, then finished by a walkover through the console's own door.
  const put = await apiJson(request, `/api/v1/fixtures/${id}/rules`, "PUT", { rules: { bestOf: 1 } });
  expect(put.status, JSON.stringify(put.error)).toBe(200);
  let seq = 0;
  await post(request, id, seq++, "core.forfeit", { by: s.entrantIds[0], reason: "walkover" });
  await post(request, id, seq++, "core.finalize", {});

  const block = await openConsole(page, s.console);
  await expect(block).toHaveAttribute("data-state", "locked");
  await expect(block.getByTestId("match-rules-locked")).toHaveText(L["matchRules.locked"]!);
  await expect(block.getByTestId("match-rules-save")).toHaveCount(0);
  await expect(block.getByTestId("match-rules-reset")).toHaveCount(0);
  await expect(block.getByTestId("match-rules-correct")).toHaveCount(0);
  await expect(block.locator("select, input"), "nothing left to change").toHaveCount(0);
  await expect(block.getByTestId("match-rules-overridden"), "the format it was played under stays readable").toBeVisible();

  const refused = await apiJson(request, `/api/v1/fixtures/${id}/rules`, "PUT", { rules: null });
  expect(refused.status, "the server refuses on the same predicate").toBe(409);
  expect(refused.error?.code).toBe("FIXTURE_FORMAT_LOCKED");
});

// ---------------------------------------------------------------------------------------------------------------------
// Another family: a period sport whose decider is a NESTED key bounded to shorter (ice hockey overtime), and a sport with
// nothing to change for one match (generic).
// ---------------------------------------------------------------------------------------------------------------------
test("X-SR-3 a bye (decided without play) is locked in its own words - not 'finished' - and the server refuses the same change", async ({ page, request }) => {
  test.setTimeout(150_000);
  // Three entrants in a knockout: one seed has no opponent, so its tie is a bye (decided without play, no score credited).
  const s = await seed(request, "badminton", { label: "bye", kind: "knockout", entrants: 3 });
  let byeId: string | null = null;
  let real = 0;
  for (const id of s.fixtureIds) {
    const f = await apiJson<{ outcome: { reason?: string } | null }>(request, `/api/v1/fixtures/${id}`);
    expect(f.status, `GET fixture: ${JSON.stringify(f.error)}`).toBe(200);
    if (f.data!.outcome?.reason === "bye") byeId = id;
    else real++;
  }
  expect(byeId, "the premise: an odd draw has a bye").not.toBeNull();
  expect(real, "the premise: and a match that is not one").toBeGreaterThan(0);

  const block = await openConsole(page, await fixturePath(request, byeId!));
  await expect(block).toHaveAttribute("data-state", "decided");
  await expect(block.getByTestId("match-rules-locked")).toHaveAttribute("data-reason", "decided");
  await expect(block.getByTestId("match-rules-locked")).toHaveText(L["rules.err.fixtureDecidedWithoutPlay"]!);
  await expect(block.locator("select, input, button"), "nothing to change on a bye").toHaveCount(0);

  const refused = await apiJson<unknown>(request, `/api/v1/fixtures/${byeId!}/rules`, "PUT", { rules: { bestOf: 1 } });
  expect(refused.status, "the server refuses the same change").toBe(409);
  expect(refused.error?.code).toBe("FIXTURE_FORMAT_LOCKED");
});

test("another sport (ice hockey knockout): overtime minutes open at the stage's, accept shorter, refuse longer; the rest of the overtime object is kept", async ({ page, request }) => {
  test.setTimeout(180_000);
  const m = mod("icehockey");
  const s = await seed(request, "icehockey", { label: "overtime", kind: "knockout", entrants: 2, entrantKind: "team" });
  const id = s.fixtureIds[0]!;
  const stage = m.configSchema.parse({ ...(m.variants[s.variant] as object), ...((m.stageDefaults?.("knockout", s.variant) ?? {}) as object) }) as { overtime: { minutes: number; kind: string; skaters: number } };
  expect(stage.overtime.minutes, "premise: the knockout stage plays an overtime").toBeGreaterThan(1);
  const field = matchFieldsFor({ module: m, stageKind: "knockout", variant: s.variant }).find((f) => f.key === "overtimeMinutes")!;
  const top = field.edits[0]!.split(".")[0]!;

  const block = await openConsole(page, s.console);
  const minutes = inputOf(block, top);
  await expect(minutes, "opens at the stage's overtime").toHaveValue(String(stage.overtime.minutes));
  await expect(minutes, "capped at the stage's: a match may only shorten it").toHaveAttribute("max", String(stage.overtime.minutes));

  const shorter = Math.max(1, stage.overtime.minutes - 4);
  await minutes.fill(String(shorter));
  await save(page, block);
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible({ timeout: STEP_MS });
  const read = await rulesOf(request, id);
  expect(read.cfg.overtime, "one number changed, the rest of the stage's overtime kept").toEqual({ ...stage.overtime, minutes: shorter });

  // Longer than the stage's: the server refuses it, the form says so, and the stored value stays.
  const longer = stage.overtime.minutes + 5;
  await minutes.fill(String(longer));
  await save(page, block, { refused: true });
  await expect(block.getByTestId("match-rules-error")).toBeVisible({ timeout: STEP_MS });
  expect((await rulesOf(request, id)).cfg.overtime, "unchanged by the refused save").toEqual({ ...stage.overtime, minutes: shorter });
});

test("a sport with nothing to change for one match (generic) has no match rules block, and the page is still the console", async ({ page, request }) => {
  test.setTimeout(120_000);
  const s = await seed(request, "generic", { label: "none", kind: "league", entrants: 2 });
  await page.goto(s.console, { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByRole("main").getByText(`T19 none 1 ${TAG}`).first(), "the fixture page rendered (the positive pair)").toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId("match-rules-block")).toHaveCount(0);
});
