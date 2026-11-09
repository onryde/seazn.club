// ONE organiser late-enters two players into brackets that are already drawn and Started — a doubles PAIR through the Entrants
// tab's form, then a single who registered online and is MARKED PAID (the payment is faked in SQL: a test has no Stripe, so the
// walkthrough proves the card's "paid" wording and refund pointer, never a real charge) — driven on the organiser's own screens.
//
// THE RULES (W4 T19; spec 2026-11-04-format-matrix-w4-knockout-design.md; R24 owner picks 1A/2B/3A; rulings 263 and 271):
//   - "Add late player" on a Started knockout is named "Add to bracket" — the rail's More item, the Needs-you row's target,
//     the stage card's strip and the Generate refusal's sentence all say the SAME words;
//   - the ORGANISER's add (the form) is placed now: six in a bracket of eight leave two byes, and the newcomer plays a bye
//     holder; the answer is one green sentence naming both players;
//   - an AUTOMATIC arrival (a confirmed or paid registration) is never placed by the app: it WAITS on the stage's card, under
//     "Waiting to join the bracket", with ONE tap, "Add to bracket", whose answer is said in the panel's own notice line.
//
// WHY A WALKTHROUGH. `knockout-late-entry-wiring.test.tsx` and the strip's island test prove each control against props; the
// e2e spec `w4-knockout-app-a-b6a.spec.ts` proves each rule on one screen. What none of them can see is the organiser's whole
// round trip: that the rail's item lands on a form that already explains itself, that a pair assembled from one existing
// player and one created in the form is ONE entrant in the bracket, and that the strip is usable with a thumb at a phone width.
//
// WHAT IS A REACH AND WHAT IS THE TEST (this folder's README): the competition, the two divisions, their six entrants each, the
// draw and Start, the registration and the person the pair is built from are REACHES over the API; every control the organiser
// presses, and every claim about what it did, is the test. The product's own words come from the dictionaries it renders.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, expectNoHorizontalScroll, withDb } from "../helpers";
import { showAllFixtures, stageFixtures, type Fx } from "../support/swiss-app-a-kit";
import { dismissCookieBanner } from "../scorepad-a11y-kit";

const EN = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
const say = (key: string, vars: Record<string, string | number> = {}): string => {
  const template = EN[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};

type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null };

/** A badminton knockout of six seeded entrants (`kind`), generated and Started: seeds 1 and 2 hold the byes of a bracket of eight. */
async function startedBracket(request: APIRequestContext, competitionId: string, name: string, kind: "individual" | "pair") {
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name,
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const added = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 6 }, (_, i) => ({ kind, display_name: `${name} S${i + 1} ${TAG}`, seed: i + 1, ...(kind === "pair" ? { members: [] } : {}) })),
  );
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
  const holder = added.data![1]!.id; // seed 2: a newcomer plays the LOWEST-seeded holder's bye first (RB4-L4)
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  const rows = async () => (await stageFixtures(request, divisionId, stage.data!.id)) as Seated[];
  return { divisionId, stageId: stage.data!.id, nameOf, holder, rows };
}

test.describe("W4 late entry: an organiser adds a pair, then taps in a single marked paid", () => {
  test("rail → Add to bracket → a doubles pair built in the form takes a bye; a registrant marked paid (SQL-faked) waits on the card and one tap seats them", async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Late entry ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const doubles = await startedBracket(request, comp.data!.id, "Doubles", "pair");
    const singles = await startedBracket(request, comp.data!.id, "Singles", "individual");
    const personA = `Walk Ann ${TAG}-${testInfo.workerIndex}`;
    const personB = `Walk Bea ${TAG}-${testInfo.workerIndex}`;
    const ann = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: personA });
    expect(ann.status, JSON.stringify(ann.error)).toBe(201);

    // ── 1. The pair, on a desktop ──────────────────────────────────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(request, doubles.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const more = page.getByTestId("stage-more");
    await expect(more, "a started knockout offers More").toBeVisible({ timeout: 30_000 });
    await more.click();
    const item = page.getByTestId("stage-add-late-player");
    await expect(item).toContainText(say("knockout.addToBracket"));
    await item.click();
    await expect(page).toHaveURL(/[?&]tab=entrants/, { timeout: 30_000 });

    const form = page.locator("#add-entrant");
    await expect(form.getByTestId("entrants-knockout-late-note"), "the form explains what an add here does").toHaveText(say("entrants.knockoutLate.note"));
    const pairChip = form.getByRole("group", { name: say("entrants.add.kind") }).locator('[data-kind="pair"]');
    await pairChip.click();
    await expect(pairChip).toHaveAttribute("aria-pressed", "true");
    await form.getByPlaceholder(say("entrants.add.searchPlayers")).fill(personA);
    const picked = form.getByRole("button", { name: personA, exact: true });
    await picked.click();
    await expect(picked).toHaveAttribute("aria-pressed", "true");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/persons") && r.request().method() === "POST");
    await form.getByTestId("new-player-name").fill(personB);
    await form.getByTestId("new-player-add").click();
    expect((await created).status(), "New player creates the partner").toBe(201);
    await expect(form.getByTestId("new-player-note")).toHaveText(say("entrants.add.newPlayer.created", { name: personB }));
    const nameField = form.getByLabel(say("entrants.add.name"), { exact: true });
    await expect.poll(async () => {
      const v = await nameField.inputValue();
      return v.includes(personA) && v.includes(personB);
    }, "the pair's name follows its two players").toBe(true);
    const pairName = await nameField.inputValue();
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/divisions/${doubles.divisionId}/entrants`) && r.request().method() === "POST");
    await form.getByRole("button", { name: say("entrants.add.submit") }).click();
    const added = (await (await answered).json()) as { data?: { id: string; kind: string; late_entry?: { case: string; opponent_id: string } } };
    expect(added.data?.kind, "one pair entrant").toBe("pair");
    expect(added.data?.late_entry, "it took a bye").toMatchObject({ case: "bye", opponent_id: doubles.holder });
    const line = page.getByTestId("entrants-late-entry-line").first();
    await expect(line).toHaveText(say("knockout.lateEntry.tookBye", { name: pairName, holder: doubles.nameOf.get(doubles.holder)! }), { timeout: 30_000 });
    await expect(line).toHaveAttribute("data-tone", "done");
    const seatedPair = (await doubles.rows()).find((f) => f.home_entrant_id === added.data!.id || f.away_entrant_id === added.data!.id);
    expect(seatedPair, "the bracket seats the pair once").toBeDefined();
    expect([seatedPair!.home_entrant_id, seatedPair!.away_entrant_id].sort()).toEqual([added.data!.id, doubles.holder].sort());

    // ── 2. A single marked paid arrives; the card lists them; one tap, on a phone ─────────────────────────────────────────────────
    const settings = await apiJson(request, `/api/v1/divisions/${singles.divisionId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
      approval: "auto",
    });
    expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
    const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(await competitionPath(request, comp.data!.id))!;
    const late = `Walk Late Cy ${TAG}`;
    const sent = await apiJson<{ entries: { status: string }[] }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
      contact: { name: late, email: `delivered+walk-${Math.random().toString(36).slice(2, 8)}@resend.dev` },
      privacy_consent: true,
      entries: [{ division_id: singles.divisionId, entrant_kind: "individual", players: [{ full_name: late }], answers: {} }],
    });
    expect(sent.status, JSON.stringify(sent.error)).toBe(201);
    const lateId = (await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${singles.divisionId}/entrants`)).data!.find((e) => e.display_name === late)!.id;
    // Marked paid: the card's "paid" wording reads the webhook's rows, and a test has no Stripe, so they are written here.
    await withDb(async (sql) => {
      const [reg] = await sql<{ id: string; group_id: string }[]>`select id, group_id from registrations where entrant_id = ${lateId}`;
      await sql`update registration_groups set payment_intent_id = ${`pi_walk_${reg!.id.slice(0, 8)}`} where id = ${reg!.group_id}`;
      await sql`update registrations set amount_cents = 1500 where id = ${reg!.id}`;
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(await competitionPath(request, comp.data!.id));
    const flag = page.locator('[data-attention="late_players_waiting"]').first();
    await expect(flag, "the desk flags the waiting player").toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalScroll(page);
    await page.goto(await divisionPath(request, singles.divisionId, "?tab=fixtures"));
    const strip = page.getByTestId("knockout-waiting");
    await expect(strip.getByTestId("knockout-waiting-row")).toContainText(late, { timeout: 30_000 });
    await expect(strip).toContainText(say("knockout.waiting.title"));
    await expect(strip).toContainText(say("knockout.waiting.subPaid"));
    await expectNoHorizontalScroll(page);
    const tap = strip.getByTestId("knockout-waiting-place");
    await expect(tap).toHaveText(say("knockout.addToBracket"));
    await tap.scrollIntoViewIfNeeded();
    const box = await tap.boundingBox();
    expect(box!.width, "the tap is full width on a phone").toBeGreaterThan(280);
    expect(box!.height, "and a thumb-sized target").toBeGreaterThanOrEqual(44);
    await tap.click();
    await expect(page.getByText(say("knockout.lateEntry.tookBye", { name: late, holder: singles.nameOf.get(singles.holder)! }))).toBeVisible({ timeout: 30_000 });
    await expect(strip, "nobody waits any more").toHaveCount(0, { timeout: 30_000 });
    await expectNoHorizontalScroll(page);

    const seated = (await singles.rows()).find((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId);
    expect(seated, "the bracket seats the single").toBeDefined();
    await showAllFixtures(page);
    await expect(page.locator(`li[data-fixture-no="${seated!.fixture_no}"]`)).toContainText(late, { timeout: 30_000 });
    await page.goto(await competitionPath(request, comp.data!.id));
    await expect(page.locator('[data-attention="late_players_waiting"]'), "the desk row goes").toHaveCount(0, { timeout: 30_000 });
  });
});
