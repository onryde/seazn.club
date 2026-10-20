// W2c Task 20 (S4, X-SR-4 UI half) - the division settings tab says what a STARTED stage locks, before the organiser
// types, and says what a save kept, instead of reading "saved" over a value that snapped back.
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
import { TAG, apiJson, divisionPath } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPORT_RULES } from "../src/lib/match-rules";

const L = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
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

async function openFormat(page: Page, request: APIRequestContext, divisionId: string): Promise<void> {
  await page.goto(await divisionPath(request, divisionId, "?tab=settings"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
  await page.getByRole("button", { name: /^Format/ }).click();
}

/** The variant picker. By role and a leading name: `getByLabel("Variant")` also matches a rule field whose help text says "variant". */
const variantPicker = (page: Page) => page.getByRole("combobox", { name: new RegExp(`^${L["divset.variant"]!}`) });

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
test("badminton: a started stage's fields and variant are read-only with their line before typing; the same division unstarted shows none", async ({ page, request }) => {
  test.setTimeout(150_000);
  const rig = await seedLeague(request, "badminton", "short", "badminton-lines");
  const lockLines = page.locator('[data-testid^="division-locked-"]');

  // Fixtures exist, nothing has started: the structure note is up, every rule is open.
  await openFormat(page, request, rig.divisionId);
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(lockLines, "generated but not started: nothing is locked").toHaveCount(0);
  for (const f of SPORT_RULES.badminton!) await expect(fieldControl(page, "badminton", f.key), `${f.key} is editable`).toBeEnabled();
  await expect(variantPicker(page), "the variant is editable").toBeEnabled();

  // The division starts and a match starts.
  await startDivision(request, rig.divisionId);
  await openFormat(page, request, rig.divisionId);
  await expect(page.getByTestId("format-locked")).toBeVisible();
  await expect(lockLines, "starting the DIVISION locks no rule: only a started stage does").toHaveCount(0);
  await startMatch(request, rig.fixtureIds[0]!);
  await openFormat(page, request, rig.divisionId);

  // Every field the form shows says which stage holds it, and is inert.
  const sentence = say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" });
  for (const f of SPORT_RULES.badminton!) {
    const line = page.getByTestId(`division-locked-${f.key}`);
    await expect(line, `${f.key} carries its lock line`).toBeVisible({ timeout: STEP_MS });
    await expect(line).toContainText(sentence);
    await expect(fieldControl(page, "badminton", f.key), `${f.key} is read-only`).toBeDisabled();
  }
  const variantLine = page.getByTestId("division-locked-variant_key");
  await expect(variantLine).toContainText(sentence);
  await expect(variantPicker(page)).toBeDisabled();
  // The lock is a per-field one: the rest of the tab stays editable (the name, the Save button).
  await expect(page.getByRole("button", { name: L["divset.saveRules"]! })).toBeEnabled();
  expect(await lockLines.count(), "one line per field plus the variant, no more").toBe(SPORT_RULES.badminton!.length + 1);

  // The server agrees, field by field: the page's lock list is the writer's refusal list.
  const stored = await storedConfig(request, rig.divisionId);
  const patch = await page.request.patch(`/api/v1/divisions/${rig.divisionId}`, { data: { config: { ...stored, setTo: Number(stored.setTo) + 2 } } });
  expect(patch.status(), "a changed locked key is refused outright").toBe(409);
  const body = (await patch.json()) as { error?: { code?: string; refused?: { field: string; stageName: string }[] } };
  expect(body.error?.code).toBe("DIVISION_FORMAT_LOCKED");
  expect(body.error?.refused?.map((r) => [r.field, r.stageName])).toEqual([["setTo", "Pool A"]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Another sport family: generic keeps points in the TABLE, so its boxes lock with the table sentence.
// ---------------------------------------------------------------------------------------------------------------------
test("generic: the standings points boxes and the rule fields lock with their own sentences once a match has started", async ({ page, request }) => {
  test.setTimeout(150_000);
  const rig = await seedLeague(request, "generic", "score", "generic-lines");
  await startDivision(request, rig.divisionId);
  await startMatch(request, rig.fixtureIds[0]!);
  await openFormat(page, request, rig.divisionId);

  const points = page.getByTestId("division-locked-points");
  await expect(points).toBeVisible({ timeout: STEP_MS });
  await expect(points).toContainText(say("ruleLock.DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" }));
  for (const box of [L["divset.win"]!, L["divset.draw"]!, L["divset.loss"]!]) {
    await expect(page.getByRole("spinbutton", { name: box }), `${box} is read-only`).toBeDisabled();
  }
  for (const f of SPORT_RULES.generic!) {
    await expect(page.getByTestId(`division-locked-${f.key}`), `${f.key} carries its lock line`).toBeVisible();
    await expect(page.getByTestId(`division-locked-${f.key}`)).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  }
  await expect(page.getByTestId("division-locked-variant_key")).toBeVisible();
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
  await page.getByRole("button", { name: L["divset.saveRules"]! }).click();

  // The notice: some landed, which were kept and why - and it does NOT say the rules were saved.
  const partial = page.getByTestId("division-partial-save");
  await expect(partial).toBeVisible({ timeout: STEP_MS });
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

  // The page then locks what it was told: setTo read-only with its line (no reload needed), cap still open.
  const line = page.getByTestId("division-locked-setTo");
  await expect(line).toBeVisible({ timeout: STEP_MS });
  await expect(line).toContainText(say("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  await expect(fieldControl(page, "badminton", "setTo")).toBeDisabled();
  await expect(fieldControl(page, "badminton", "cap")).toBeEnabled();
  await expect(page.getByTestId("division-locked-cap")).toHaveCount(0);

  // A reload reads the lock from the server: the same lines, with the stored values the notice promised.
  await openFormat(page, request, rig.divisionId);
  await expect(page.getByTestId("division-locked-setTo")).toBeVisible({ timeout: STEP_MS });
  await expect(page.getByTestId("division-locked-cap")).toHaveCount(0);
  await expect(fieldControl(page, "badminton", "setTo")).toHaveValue(String(before.setTo));
  await expect(fieldControl(page, "badminton", "cap")).toHaveValue(String(newCap));

  // The sequence: a save AFTER the partial one is clean - the notice is gone, "saved" is said, the cap lands again.
  await fieldControl(page, "badminton", "cap").fill(String(newCap + 1));
  await page.getByRole("button", { name: L["divset.saveRules"]! }).click();
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
  await page.getByRole("button", { name: L["divset.saveRules"]! }).click();

  // The refusal is said in the reader's words, naming the stage; BOTH refused fields are listed.
  await expect(page.getByText(say("rules.err.divisionFormatLocked", { stage: "Pool A" }))).toBeVisible({ timeout: STEP_MS });
  for (const key of ["setTo", "finalSetTo"]) {
    const item = page.getByTestId(`division-refused-${key}`);
    await expect(item, `${key} is listed`).toBeVisible();
    await expect(item).toContainText(labelOf("badminton", key));
  }
  await expect(page.getByTestId("division-partial-save"), "nothing was saved").toHaveCount(0);
  await expect(page.getByText(L["divset.notice.rulesSaved"]!)).toHaveCount(0);
  const after = await storedConfig(request, rig.divisionId);
  expect([after.setTo, after.finalSetTo], "nothing landed").toEqual([before.setTo, before.finalSetTo]);

  // And the form locks them from then on.
  await expect(page.getByTestId("division-locked-setTo")).toBeVisible();
  await expect(page.getByTestId("division-locked-finalSetTo")).toBeVisible();
  await expect(fieldControl(page, "badminton", "setTo")).toBeDisabled();
});
