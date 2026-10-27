// W2d Tasks 15 + 16 (spec §9 "Tie-breaks" and "Points section, widened", X-TB-1..3, OC2, B2, X-PT-3) — the stage editor's
// Tie-breaks section driven through its REAL producer and consumer: the page's loader (`listStagesWithTableRules`) on the
// way in, `PUT /stages/{id}/rules` and the API's `GET /stages/{id}` on the way out (AGENTS.md class 1). What a node-env
// vitest cannot see (class 2): the clicks, the save, the re-read, the pin at generate and the lock after a first score.
//
// WHERE THE EXPECTED VALUES COME FROM. The orders are the engine's (`defaultTiebreakers`, `tablePresets`, `offerableKeys`,
// `validateCascade`), the outcomes a stage reaches are the engine's (`reachableOutcomes`), every sentence is read from the en
// dictionary the product renders, and the stored state is read back through the API — none is typed here. The one fold
// typed here is the spec's own (§10 B2: a shoot-out booked as a draw is ONE row, "counts as a draw; the winner gets +1", so
// its loss is not a row of its own).
//
// The sequence (TEST-STRATEGY: test the sequence, not the feature): inherit → override (move a step, add a step, save) →
// an invalid step's reason inline → reset to a named order → clear back to inheriting → generate (Pinned at start, still
// editable) → first score (locked: no arrows, the lock line) → a division save that cannot reach the pinned stage says so.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { offerableKeys, reachableOutcomes, validateCascade, type CascadeContext } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const say = (key: string, vars: Record<string, string | number> = {}): string =>
  L[key]!.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));
const stepWord = (key: string): string => L[`div.detail.tiebreak.rule.${key}`]!;

const STEP_MS = 20_000;
const FOOTBALL = builtinModules.find((m) => m.key === "football")!;
const VARIANT = "11-a-side";

interface StageRead {
  tableRules: {
    tiebreakers: { keys: TiebreakerKey[]; source: string; pinnedAt: string | null; sportDefault: TiebreakerKey[] };
  } | null;
}

async function seedFootball(request: APIRequestContext, label: string, stage: Record<string, unknown>): Promise<{ divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2d T15 ${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `football ${label}`,
    sport_key: "football",
    variant_key: VARIANT,
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.data!.id, ["Asha", "Bala", "Chen", "Dara"].map((n) => `${n} FC ${TAG}`), "team");
  expect(added.status, "entrants").toBeLessThan(300);
  const st = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, ...stage });
  expect(st.status, `stage: ${JSON.stringify(st.error)}`).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: st.data!.id };
}

const divisionCfg = async (request: APIRequestContext, divisionId: string): Promise<Record<string, unknown>> => {
  const res = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  expect(res.status).toBe(200);
  return res.data!.config;
};
const servedOrder = async (request: APIRequestContext, stageId: string) => {
  const res = await apiJson<StageRead>(request, `/api/v1/stages/${stageId}`);
  expect(res.status, "GET /stages/{id}").toBe(200);
  expect(res.data!.tableRules, "the stage's rules read").not.toBeNull();
  return res.data!.tableRules!.tiebreakers;
};
const listed = async (section: Locator): Promise<string[]> =>
  section.locator('[data-testid^="stage-tiebreaks-row-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-key") ?? ""));
/** The list folds behind a phone disclosure below md (class 22): open it only where its toggle is the visible kind. */
async function openFold(section: Locator): Promise<void> {
  const toggle = section.locator('[data-role="phone-disclosure-toggle"]');
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
const nextRulesPut = (page: Page, stageId: string) =>
  page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === `/api/v1/stages/${stageId}/rules`, { timeout: STEP_MS });
async function axeClean(page: Page, selector: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe on ${selector}`).toEqual([]);
}

test("football league: the order is inherited, overridden (a move, an added step, saved and re-read), refused inline, reset to a named order, cleared, pinned at generate and still editable, locked by the first score; a division save says which stage it cannot reach", async ({ page, request }) => {
  test.setTimeout(300_000);
  const rig = await seedFootball(request, "tiebreaks", { kind: "league", name: "Pool A" });
  const cfg = FOOTBALL.configSchema.parse(await divisionCfg(request, rig.divisionId));
  const ctx: CascadeContext = { module: FOOTBALL, cfg, stageKind: "league", crossGroup: false };
  const sportDefault = FOOTBALL.defaultTiebreakers("league", cfg);
  expect(sportDefault.length, "premise: football's league order has middle steps").toBeGreaterThan(3);

  // --- inherit -----------------------------------------------------------------------------------------------------------
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = page.getByTestId(`stage-tiebreaks-${rig.stageId}`);
  await expect(section).toBeAttached({ timeout: STEP_MS });
  await expect(section).toHaveAttribute("data-state", "editor");
  await openFold(section);
  const badge = section.getByTestId("stage-tiebreaks-badge");
  await expect(badge).toHaveAttribute("data-badge", "inherited");
  await expect(badge).toHaveAttribute("data-source", "sport");
  await expect(section).toContainText(L["stageTiebreaks.source.sport"]!);
  expect(await listed(section), "the sport's order, as the engine declares it").toEqual([...sportDefault]);
  expect((await servedOrder(request, rig.stageId)).keys, "and as the API serves it").toEqual([...sportDefault]);
  await expect(section.getByTestId("stage-tiebreaks-pinned-0")).toHaveText(L["stageTiebreaks.alwaysFirst"]!);
  await expect(section.getByTestId(`stage-tiebreaks-pinned-${sportDefault.length - 1}`)).toHaveText(L["stageTiebreaks.alwaysLast"]!);
  await expect(section.getByTestId("stage-tiebreaks-up-0"), "the primary measure is pinned").toHaveCount(0);
  await expect(section.getByTestId("stage-tiebreaks-save"), "nothing changed: nothing to save").toHaveCount(0);
  await axeClean(page, `[data-testid="stage-tiebreaks-${rig.stageId}"]`);
  await axeClean(page, `[data-testid="stage-points-${rig.stageId}"]`);
  await expectNoHorizontalScroll(page);

  // --- override: move a step, remove one, add it back from "+ Add step" (the engine's offer), save --------------------------
  await section.getByTestId("stage-tiebreaks-down-1").click();
  const moved = [...sportDefault];
  [moved[1], moved[2]] = [moved[2]!, moved[1]!];
  expect(await listed(section), "a move swaps the step with the next").toEqual(moved);
  const removedKey = moved[3]!;
  await section.getByTestId("stage-tiebreaks-remove-3").click();
  const afterRemove = moved.filter((_, i) => i !== 3);
  expect(await listed(section)).toEqual(afterRemove);
  const at = afterRemove.length - 1; // just before lots: lots stays last
  const offered = offerableKeys(afterRemove, at, ctx);
  expect(offered, "premise: the removed step is offered back").toContain(removedKey);
  const add = section.getByTestId("stage-tiebreaks-add");
  const options = await add.locator("option").evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter((v) => v !== ""));
  expect(options, "+ Add step offers exactly the engine's offerable keys").toEqual([...offered]);
  await add.selectOption(removedKey);
  const own = [...afterRemove.slice(0, at), removedKey, ...afterRemove.slice(at)];
  expect(await listed(section), "added just before lots").toEqual(own);
  expect(validateCascade(own, ctx), "premise: the order is valid").toEqual([]);
  const put = nextRulesPut(page, rig.stageId);
  await section.getByTestId("stage-tiebreaks-save").click();
  expect((await put).postDataJSON(), "the strict body: the order alone").toEqual({ tiebreakers: own });
  await expect.poll(async () => (await servedOrder(request, rig.stageId)).keys, { timeout: STEP_MS }).toEqual(own);
  expect((await servedOrder(request, rig.stageId)).source).toBe("stage");
  await page.reload({ waitUntil: "load" });
  await openFold(section);
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-badge", "overridden", { timeout: STEP_MS });
  expect(await listed(section), "a reload reads the stored order").toEqual(own);
  await expect(section.getByTestId("stage-tiebreaks-clear")).toHaveText(L["stageTiebreaks.useDivision"]!);

  // --- an invalid step: its reason inline, Save off. A named order with a modifier (UEFA's re-apply), the modifier moved off
  // the head-to-head block it must follow -----------------------------------------------------------------------------------
  const presets = FOOTBALL.tablePresets!("league").tiebreakers;
  const withModifier = presets.find((p) => p.keys.includes("h2h_reapply"));
  expect(withModifier, "premise: a football named order carries the h2h re-apply modifier").toBeDefined();
  const reset = section.getByTestId("stage-tiebreaks-reset");
  expect(await reset.locator("option").evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter((v) => v !== ""))).toEqual(presets.map((p) => p.id));
  await reset.selectOption(withModifier!.id);
  expect(await listed(section)).toEqual([...withModifier!.keys]);
  const mi = withModifier!.keys.indexOf("h2h_reapply");
  await section.getByTestId(`stage-tiebreaks-down-${mi}`).click();
  const broken = [...withModifier!.keys];
  [broken[mi], broken[mi + 1]] = [broken[mi + 1]!, broken[mi]!];
  const refusals = validateCascade(broken, ctx);
  expect(refusals.map((r) => [r.index, r.key, r.reason]), "premise: the engine refuses the moved modifier's position").toEqual([[mi + 1, "h2h_reapply", "position"]]);
  await expect(section.getByTestId(`stage-tiebreaks-refusal-${mi + 1}`)).toHaveText(
    say("rules.err.tiebreakKeyInvalid", { step: stepWord("h2h_reapply"), reason: L["rules.err.tiebreak.reason.position"]! }),
  );
  await expect(section.getByTestId("stage-tiebreaks-save"), "a refused order is not sent").toBeDisabled();

  // --- reset to the sport's own named order: the refusal goes; then clear back to inheriting ------------------------------
  const sportNamed = presets.find((p) => p.keys.join() === sportDefault.join());
  expect(sportNamed, "premise: one of football's named orders is its default").toBeDefined();
  await reset.selectOption(sportNamed!.id);
  expect(await listed(section)).toEqual([...sportDefault]);
  await expect(section.locator('[data-testid^="stage-tiebreaks-refusal-"]')).toHaveCount(0);
  const clearPut = nextRulesPut(page, rig.stageId);
  await section.getByTestId("stage-tiebreaks-clear").click();
  expect((await clearPut).postDataJSON(), "clear sends the strict body, the order null").toEqual({ tiebreakers: null });
  await expect.poll(async () => (await servedOrder(request, rig.stageId)).source, { timeout: STEP_MS }).toBe("sport");
  await page.reload({ waitUntil: "load" });
  await openFold(section);
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-badge", "inherited", { timeout: STEP_MS });
  await expect(section.getByTestId("stage-tiebreaks-clear"), "nothing of its own to clear").toHaveCount(0);

  // --- the division save's negative: no stage is pinned yet, so nothing is said about one ----------------------------------
  await openFormat(page, request, rig.divisionId);
  const win = page.getByRole("spinbutton", { name: L["divset.win"]! });
  const before = Number(await win.inputValue());
  await win.fill(String(before + 1));
  await page.getByRole("button", { name: L["divset.saveRules"]! }).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId("division-kept-pinned"), "nothing pinned: no kept-pinned line").toHaveCount(0);

  // --- generate: Pinned at start, and still editable (OC2: the lock is the first score, not the pin) ------------------------
  const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${rig.stageId}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  expect((await servedOrder(request, rig.stageId)).pinnedAt, "generating pins the stage").not.toBeNull();
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await expect(section).toHaveAttribute("data-state", "editor", { timeout: STEP_MS });
  await openFold(section);
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveAttribute("data-badge", "pinned");
  await expect(section.getByTestId("stage-tiebreaks-badge")).toHaveText(L["stageTiebreaks.badge.pinned"]!);
  await expect(section.getByTestId("stage-tiebreaks-down-1"), "pinned, not scored: the arrows are still there").toBeEnabled();
  await expect(section.getByTestId("stage-tiebreaks-locked")).toHaveCount(0);

  // --- a first score: locked. The order is still listed; no arrow, no remove, no add, no reset; the lock line names it -------
  const started = await apiJson(request, `/api/v1/divisions/${rig.divisionId}/start`, "POST");
  expect(started.status, `start division: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const first = await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(first.status, `start match: ${JSON.stringify(first.error)}`).toBe(201);
  await page.reload({ waitUntil: "load" });
  await expect(section).toHaveAttribute("data-state", "locked", { timeout: STEP_MS });
  await expect(section.getByTestId("stage-tiebreaks-locked")).toContainText(say("stageTiebreaks.locked", { stage: "Pool A" }));
  await openFold(section);
  expect(await listed(section), "the pinned order is still listed").toEqual([...sportDefault]);
  await expect(section.locator("button:not([data-role='phone-disclosure-toggle']), select"), "locked: no control").toHaveCount(0);
  await axeClean(page, `[data-testid="stage-tiebreaks-${rig.stageId}"]`);
  await expectNoHorizontalScroll(page);

  // --- a division points save after the pin lands, and says the pinned stage keeps what it started with (PR B carry I3) -----
  await openFormat(page, request, rig.divisionId);
  const win2 = page.getByRole("spinbutton", { name: L["divset.win"]! });
  await win2.fill(String(Number(await win2.inputValue()) + 1));
  await page.getByRole("button", { name: L["divset.saveRules"]! }).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId(`division-kept-pinned-${rig.stageId}`)).toHaveText(say("divset.keptPinned", { stage: "Pool A" }));
  await expectNoHorizontalScroll(page);
});

test("football group stage with a shoot-out: the points rows are exactly the outcomes the stage can reach (B2: the shoot-out is one 'counts as a draw' row)", async ({ page, request }) => {
  test.setTimeout(150_000);
  const rig = await seedFootball(request, "so-rows", { kind: "group", name: "Groups", config: { pools: { count: 2 }, rules: { shootout: true } } });
  const merged = FOOTBALL.configSchema.parse({ ...(await divisionCfg(request, rig.divisionId)), shootout: true });
  const reach = [...reachableOutcomes(FOOTBALL, merged, "group")];
  expect(reach, "premise: a group stage with a shoot-out reaches it").toEqual(expect.arrayContaining(["win.so", "loss.so", "draw"]));
  // §10 B2: football books a shoot-out as a draw plus the winner's bonus — the win.so row says it; loss.so is not its own row.
  const expected = reach.filter((k) => k !== "loss.so").map((k) => `stage-points-row-${k.replace(/[.:]/g, "-")}`);
  await page.goto(await divisionPath(request, rig.divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const section = page.getByTestId(`stage-points-${rig.stageId}`);
  await expect(section).toHaveAttribute("data-stage-points-state", "editor", { timeout: STEP_MS });
  const rows = await section
    .getByTestId("stage-points-rows")
    .locator('[data-testid^="stage-points-row-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
  expect([...rows].sort(), "one row per outcome the stage reaches, no other").toEqual([...expected].sort());
  const soWords = L["stagePoints.row.soDraw"]!.split("{bonus}")[0]!;
  await expect(section.getByTestId("stage-points-row-win-so")).toContainText(soWords);
  await axeClean(page, `[data-testid="stage-points-${rig.stageId}"]`);
  await expectNoHorizontalScroll(page);
});

async function openFormat(page: Page, request: APIRequestContext, divisionId: string): Promise<void> {
  await page.goto(await divisionPath(request, divisionId, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
  await page.getByRole("button", { name: /^Format/ }).click();
}
