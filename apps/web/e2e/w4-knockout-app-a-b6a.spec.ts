import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, withDb } from "./helpers";
import { showAllFixtures, stageFixtures, type Fx } from "./support/swiss-app-a-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { swissDrawSeed } from "../src/lib/swiss-draw";

// W4 knockout app-A, lane B6a (Tasks 19 + 20; spec 2026-11-04-format-matrix-w4-knockout-design.md; R24 owner picks 1A/2B/3A):
// the DESK half of late entry and the stage's draw seed. One describe per rule, driven through the real product: the public
// register door (an automatic arrival), the stage card's own controls, and the Entrants tab's add form; read back from the v1
// routes and the run sheet. The English below is typed out here (the approved copy), never read off the dictionary.

type Seated = Fx & { home_entrant_id: string | null; away_entrant_id: string | null; status: string };

/** A badminton knockout of `names`, seeded in order, generated and Started. `visibility: "public"` so a registration can come in. */
async function startedKnockout(request: APIRequestContext, label: string, names: string[]) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
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
    names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
  const seedOf = new Map(added.data!.map((e, i) => [e.id, i + 1]));
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
    config: {},
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const stageId = stage.data!.id;
  const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, JSON.stringify(gen.error)).toBe(200);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  const rows = async () => (await stageFixtures(request, divisionId, stageId)) as Seated[];
  return { competitionId: comp.data!.id, divisionId, stageId, nameOf, seedOf, rows };
}

/** One free registration through the PUBLIC register door, auto-approved: confirmed at once, so the entrant is made and — the
 *  bracket having started — WAITS (ruling 271), never placed. The division opens registration through its own settings route. */
async function registerLate(request: APIRequestContext, competitionId: string, divisionId: string, who: string): Promise<string> {
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    payment_method: "offline",
    form_fields: [],
    approval: "auto",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  const path = await competitionPath(request, competitionId);
  const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(path)!;
  const sent = await apiJson<{ entries: { status: string }[] }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: who, email: `delivered+${TAG.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@resend.dev` },
    privacy_consent: true,
    entries: [{ division_id: divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} }],
  });
  expect(sent.status, JSON.stringify(sent.error)).toBe(201);
  expect(sent.data!.entries[0]!.status, "premise: confirmed at once").toBe("confirmed");
  const list = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
  const entrant = list.data!.find((e) => e.display_name === who);
  expect(entrant, "premise: the confirmation made an entrant").toBeTruthy();
  return entrant!.id;
}

/** The registration was paid by card (the webhook writes this; a test has no Stripe): the strip then says "Paid online". */
async function markPaidOnline(entrantId: string): Promise<void> {
  await withDb(async (sql) => {
    const rows = await sql<{ id: string; group_id: string }[]>`select id, group_id from registrations where entrant_id = ${entrantId}`;
    expect(rows.length, "premise: the entrant came from a registration").toBe(1);
    await sql`update registration_groups set payment_intent_id = ${`pi_e2e_${rows[0]!.id.slice(0, 8)}`} where id = ${rows[0]!.group_id}`;
    await sql`update registrations set amount_cents = 1500 where id = ${rows[0]!.id}`;
  });
}

const strip = (page: Page) => page.getByTestId("knockout-waiting");

// X-LE-10 (W4 T19, K7; R24 pick 1A; ruling 271): an AUTOMATIC arrival is never placed by the app. A registration confirmed
// after the draw WAITS; the stage's card lists them under "Waiting to join the bracket" with ONE tap, "Add to bracket", and
// the answer is said in the panel's own notice line. Six seeded in a bracket of eight: seeds 1 and 2 hold byes, and the first
// newcomer plays the LOWEST-seeded holder's bye (RB4-L4: seed 2's, then seed 1's), read back from the answer on the wire and the run sheet.
test.describe("X-LE-10 the card lists a late registrant and one tap places them", () => {
  test("a confirmed registration waits on the card; Add to bracket seats them against a bye holder; the strip and the desk row go", async ({ page, request }) => {
    test.setTimeout(150_000);
    const names = ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay"].map((n) => `Tap ${n} ${TAG}`);
    const ko = await startedKnockout(request, "Tap cup", names);
    const late = `Tap Late Gil ${TAG}`;
    const lateId = await registerLate(request, ko.competitionId, ko.divisionId, late);
    const before = await ko.rows();
    expect(
      before.some((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId),
      "the app does not seat an automatic arrival",
    ).toBe(false);
    const holder = [...ko.seedOf].find(([, s]) => s === 2)![0];

    // The desk flags them, and its row points at this card.
    await page.goto(await competitionPath(request, ko.competitionId));
    await dismissCookieBanner(page);
    await expect(page.locator('[data-attention="late_players_waiting"]').first()).toContainText("1 late player waiting — add to bracket", { timeout: 20_000 });

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    await expect(strip(page), "the card lists the waiting player").toBeVisible({ timeout: 20_000 });
    await expect(strip(page)).toContainText("Waiting to join the bracket");
    const row = strip(page).getByTestId("knockout-waiting-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(late);
    await expect(row).toContainText("Joined after the draw. Not in the bracket yet.");
    const tap = row.getByTestId("knockout-waiting-place");
    await expect(tap).toHaveText("Add to bracket");
    // A real tap target: nothing sits over it (hit-test, not box size — and only an element in view can be hit).
    await tap.scrollIntoViewIfNeeded();
    expect(
      await tap.evaluate((el) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return hit !== null && el.contains(hit);
      }),
    ).toBe(true);

    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${ko.stageId}/late-entrants/${lateId}/place`) && r.request().method() === "POST");
    await tap.click();
    const res = await answered;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ case: "bye", opponent_id: holder });

    // Said in the panel's own notice line, with both names; the strip is gone once the page re-reads.
    await expect(page.getByText(`${late} plays ${ko.nameOf.get(holder)}, who had a bye.`)).toBeVisible({ timeout: 20_000 });
    await expect(strip(page), "nobody waits any more").toHaveCount(0, { timeout: 20_000 });
    const placed = (await ko.rows()).find((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId);
    expect(placed, "the bracket seats them now").toBeTruthy();
    expect([placed!.home_entrant_id, placed!.away_entrant_id].sort()).toEqual([lateId, holder].sort());

    await showAllFixtures(page);
    const sheetRow = page.locator(`li[data-fixture-no="${placed!.fixture_no}"]`);
    await expect(sheetRow, "the run sheet names both").toContainText(late);
    await expect(sheetRow).toContainText(ko.nameOf.get(holder)!);

    await page.goto(await competitionPath(request, ko.competitionId));
    await expect(page.locator('[data-attention="late_players_waiting"]'), "the desk row goes").toHaveCount(0, { timeout: 20_000 });
  });

  // B3 review #5: a tap that cannot place is never a stuck amber row. A full bracket of four has no free place. Nothing has
  // started, so the answer is `rebuild_offered`: the player still waits, the sentence says why, and the row gains the exits —
  // Rebuild fixtures (draw the field again with them in it), Withdraw (they are not in the bracket, so no match is touched)
  // and, for an entry paid by card, a pointer to the refund. The Rebuild is the panel's own, confirmed, and it sweeps them in.
  test("a full bracket, nothing started: the tap offers Rebuild by name and keeps the player; Rebuild draws the field again with them in it", async ({ page, request }) => {
    test.setTimeout(150_000);
    const ko = await startedKnockout(request, "Rebuild cup", ["Ana", "Ben", "Cas", "Dee"].map((n) => `Reb ${n} ${TAG}`));
    const late = `Reb Late Hal ${TAG}`;
    const lateId = await registerLate(request, ko.competitionId, ko.divisionId, late);
    await markPaidOnline(lateId);
    const seats = async () =>
      (await ko.rows())
        .map((f) => `${f.round_no}:${f.seq_in_round}:${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}:${f.status}`)
        .sort();
    const bracketBefore = await seats();

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    const row = strip(page).getByTestId("knockout-waiting-row");
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(row, "paid by card: the sub-line says so").toContainText("Paid online after the draw. Not in the bracket yet.");
    await expect(row.getByTestId("knockout-waiting-outcome"), "no answer before a tap").toHaveCount(0);

    const answered = page.waitForResponse((r) => r.url().endsWith(`/late-entrants/${lateId}/place`) && r.request().method() === "POST");
    await row.getByTestId("knockout-waiting-place").click();
    expect(((await (await answered).json()) as { data: { case: string } }).data.case).toBe("rebuild_offered");

    const outcome = row.getByTestId("knockout-waiting-outcome");
    await expect(outcome).toContainText(`No slot is left, but nothing has started: Rebuild the bracket to add ${late}.`, { timeout: 20_000 });
    await expect(row.getByTestId("knockout-waiting-place"), "the row keeps its tap").toBeEnabled();
    await expect(row.getByTestId("knockout-waiting-rebuild")).toHaveText("Rebuild fixtures");
    await expect(row.getByTestId("knockout-waiting-withdraw")).toHaveText("Withdraw");
    const refund = row.getByTestId("knockout-waiting-refund");
    await expect(refund).toHaveText("Refund in Registrations");
    expect(await refund.getAttribute("href"), "the pointer lands on this competition's Registrations").toMatch(/\/registration\b/);
    expect(await seats(), "an offer writes nothing to the bracket").toEqual(bracketBefore);

    // Rebuild: the panel's own confirm, then the field is drawn again with the newcomer in it — five players, a bracket of eight.
    await row.getByTestId("knockout-waiting-rebuild").click();
    const dialog = page.getByRole("alertdialog", { name: "Rebuild this stage's fixtures?" });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Rebuild" }).click();
    await expect(strip(page), "swept in: nobody waits any more").toHaveCount(0, { timeout: 30_000 });
    const after = await ko.rows();
    expect(after.some((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId), "the rebuilt bracket seats them").toBe(true);
    expect(after.length, "five players: a bracket of eight, seven lines").toBe(7);
  });

  // The same full bracket once a match has started: Rebuild is no longer on offer, so the answer is `refused` BY NAME and the
  // exits are Withdraw (and the refund pointer). Withdrawing a player who is not in the bracket touches no match.
  test("a full bracket, a match started: the tap is refused by name (no Rebuild); Withdraw takes the player off the card and touches no match", async ({ page, request }) => {
    test.setTimeout(150_000);
    const ko = await startedKnockout(request, "Refuse cup", ["Ana", "Ben", "Cas", "Dee"].map((n) => `Ref ${n} ${TAG}`));
    const first = (await ko.rows()).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    const started = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${first.id}/state`);
    const start = await apiJson(request, `/api/v1/fixtures/${first.id}/events`, "POST", { expected_seq: started.data!.last_seq, type: "core.start", payload: {} });
    expect(start.status, JSON.stringify(start.error)).toBeLessThan(300);
    const late = `Ref Late Ivy ${TAG}`;
    const lateId = await registerLate(request, ko.competitionId, ko.divisionId, late);
    await markPaidOnline(lateId);
    const seats = async () =>
      (await ko.rows())
        .map((f) => `${f.round_no}:${f.seq_in_round}:${f.home_entrant_id ?? "-"}|${f.away_entrant_id ?? "-"}:${f.status}`)
        .sort();
    const bracketBefore = await seats();

    await page.goto(await divisionPath(request, ko.divisionId, "?tab=fixtures"));
    const row = strip(page).getByTestId("knockout-waiting-row");
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    const answered = page.waitForResponse((r) => r.url().endsWith(`/late-entrants/${lateId}/place`) && r.request().method() === "POST");
    await row.getByTestId("knockout-waiting-place").click();
    expect(((await (await answered).json()) as { data: { case: string } }).data.case).toBe("refused");
    await expect(row.getByTestId("knockout-waiting-outcome")).toContainText("Round 1 complete; no slot left.", { timeout: 20_000 });
    await expect(row.getByTestId("knockout-waiting-rebuild"), "a match has started: no Rebuild offer").toHaveCount(0);
    await expect(row.getByTestId("knockout-waiting-refund")).toHaveText("Refund in Registrations");
    await expect(row.getByTestId("knockout-waiting-place"), "the row keeps its tap").toBeEnabled();
    expect(await seats(), "a refused tap writes nothing to the bracket").toEqual(bracketBefore);

    await row.getByTestId("knockout-waiting-withdraw").click();
    const dialog = page.getByRole("alertdialog", { name: `Withdraw ${late}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${late} isn't in the bracket yet, so no match is affected.`);
    await dialog.getByRole("button", { name: "Withdraw entrant" }).click();
    await expect(strip(page), "off the card").toHaveCount(0, { timeout: 20_000 });
    const list = await apiJson<{ id: string; status: string }[]>(request, `/api/v1/divisions/${ko.divisionId}/entrants`);
    expect(list.data!.find((e) => e.id === lateId)?.status).toBe("withdrawn");
    expect(await seats(), "the withdrawal touched no match").toEqual(bracketBefore);
  });
});

/** The rail's More → "Add to bracket" → the Entrants tab's add form (the organiser's own door: placed now or refused by name). */
async function addToBracketFromRail(page: Page, request: APIRequestContext, divisionId: string, name: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const more = page.getByTestId("stage-more");
  await expect(more, "a started knockout offers More").toBeVisible({ timeout: 20_000 });
  await more.click();
  const item = page.getByTestId("stage-add-late-player");
  await expect(item).toBeVisible();
  await expect(item, "named for the bracket, never 'Add late player'").toContainText("Add to bracket");
  await expect(item).not.toContainText("Add late player");
  await item.click();
  await expect(page).toHaveURL(/[?&]tab=entrants/, { timeout: 20_000 });
  const form = page.locator("#add-entrant");
  await expect(form.getByTestId("entrants-knockout-late-note")).toHaveText(
    "This knockout has started. A player you add here takes a free place in round 1: a bye, or a withdrawn player's place.",
  );
  await form.getByLabel("Name", { exact: true }).fill(name);
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/divisions/${divisionId}/entrants`) && r.request().method() === "POST");
  await form.getByRole("button", { name: "Add entrant" }).click();
  const res = await answered;
  return { status: res.status(), body: (await res.json()) as { data?: { id: string }; error?: { code?: string } } };
}

// X-LE-3 (W4 T19, K7, ruling 263): "Add late player" on a Started knockout is "Add to bracket" — the SAME name on the rail, the
// card's strip and the Generate refusal's sentence. One notice per case (R24 pick 2B), in the Swiss late-entry block's lines:
// a bye is taken (green sentence with both names), and a full round 1 is refused by name, in the form, writing nothing.
test.describe("X-LE-3 Add to bracket from the stage rail", () => {
  test("six in a bracket of eight: two adds take the two byes, each said once with both names; the third is refused by name and writes nothing", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const ko = await startedKnockout(request, "Rail cup", ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay"].map((n) => `Rail ${n} ${TAG}`));
    const holderOf = (seed: number) => [...ko.seedOf].find(([, s]) => s === seed)![0];

    const first = await addToBracketFromRail(page, request, ko.divisionId, `Rail Late Gil ${TAG}`);
    expect(first.status, JSON.stringify(first.body.error)).toBe(201);
    // Two lines, in order: what happened (green), then what is still owed (amber) — no court or time exists in this org yet.
    const lines = page.getByTestId("entrants-late-entry-line");
    await expect(lines).toHaveCount(2, { timeout: 20_000 });
    await expect(lines.nth(0)).toHaveText(`Rail Late Gil ${TAG} plays ${ko.nameOf.get(holderOf(2))}, who had a bye.`);
    await expect(lines.nth(0)).toHaveAttribute("data-tone", "done");
    await expect(lines.nth(1)).toHaveText("1 new match is unscheduled.");
    await expect(lines.nth(1)).toHaveAttribute("data-tone", "todo");

    // The second newcomer takes the OTHER bye (seed 1's); the first one's sentence is not carried over.
    const second = await addToBracketFromRail(page, request, ko.divisionId, `Rail Late Hal ${TAG}`);
    expect(second.status, JSON.stringify(second.body.error)).toBe(201);
    await expect(lines).toHaveCount(2, { timeout: 20_000 });
    await expect(lines.nth(0)).toHaveText(`Rail Late Hal ${TAG} plays ${ko.nameOf.get(holderOf(1))}, who had a bye.`);

    const count = async () => (await apiJson<unknown[]>(request, `/api/v1/divisions/${ko.divisionId}/entrants`)).data!.length;
    const n = await count();
    const third = await addToBracketFromRail(page, request, ko.divisionId, `Rail Late Ivy ${TAG}`);
    expect([third.status, third.body.error?.code]).toEqual([409, "KO_LATE_ENTRY_NO_SLOT"]);
    await expect(page.getByTestId("entrants-error")).toHaveText("Round 1 complete; no slot left.");
    await expect(lines, "no sentence for a refused add").toHaveCount(0);
    expect(await count(), "nothing written").toBe(n);
  });
});

/** The scorer's events for a home win, two games to love. */
async function homeWins(request: APIRequestContext, fixtureId: string): Promise<void> {
  for (const [type, payload] of [
    ["core.start", {}],
    ["badminton.game.summary", { home: 21, away: 10 }],
    ["badminton.game.summary", { home: 21, away: 12 }],
  ] as const) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: state.data!.last_seq, type, payload });
    expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }
}

// X-LL-1 (W4 T13 + T19, K9; RB4-V2): a qualifier who withdraws before their first main-draw match is replaced by a LUCKY LOSER,
// and the ORGANISER is told — on the Entrants tab, where they pressed Withdraw — who took the seat. The server's answer carries
// `lucky_loser` (T13); the panel's departure notice says it in a sentence naming both players (T19). Eight qualify for a main
// draw of four; every qualifying line is won by its home side, so the quarter-final losers are the four away seats and the
// lucky loser is the best-seeded of them (one round, so seed decides) — read off the bracket, never off the code under test.
test.describe("X-LL-1 the desk names the lucky loser who took the seat", () => {
  test("Withdraw a qualifier on the Entrants tab: the notice says who takes their place in round 1, and the run sheet agrees", async ({ page, request }) => {
    test.setTimeout(240_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `LL desk ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "badminton", variant_key: "bwf", config: {} });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string; display_name: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `LD${i + 1} ${TAG}`, seed: i + 1 })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const nameOf = new Map(added.data!.map((e) => [e.id, e.display_name]));
    const seedOf = new Map(added.data!.map((e, i) => [e.id, i + 1]));
    const qual = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Qualifying", config: {} });
    expect(qual.status, JSON.stringify(qual.error)).toBe(201);
    const main = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Main draw",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    expect(main.status, JSON.stringify(main.error)).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${qual.data!.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${main.data!.id}/generate`, "POST")).status, "the main draw's day-one lines").toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);

    const qualRows = async () => (await stageFixtures(request, divisionId, qual.data!.id)) as Seated[];
    for (let guard = 0; guard < 6; guard++) {
      const open = (await qualRows()).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && !["decided", "finalized", "forfeited", "void"].includes(f.status));
      if (open.length === 0) break;
      for (const f of open) await homeWins(request, f.id);
    }
    const quarterLosers = (await qualRows()).filter((f) => f.round_no === 1).map((f) => f.away_entrant_id!);
    expect(quarterLosers.length, "premise: four quarter-final losers, below the cut").toBe(4);
    const lucky = [...quarterLosers].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!)[0]!;
    const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${qual.data!.id}/complete`, "POST");
    expect([done.status, done.data?.completed], JSON.stringify(done.error)).toEqual([200, true]);
    const proposal = await apiJson<{ id: string; computed: { ties: { slots: string[]; entrantIds: string[] }[] } }>(request, `/api/v1/stages/${main.data!.id}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const ties = proposal.data!.computed.ties;
    const confirmed = await apiJson(request, `/api/v1/stages/${main.data!.id}/seed-proposal/confirm`, "POST", {
      proposalId: proposal.data!.id,
      ...(ties.length > 0 ? { tiePicks: ties.map((t) => ({ slots: t.slots, order: t.entrantIds })) } : {}),
    });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    const mainRows = async () => (await stageFixtures(request, divisionId, main.data!.id)) as Seated[];
    const line = (await mainRows()).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    expect(line, "premise: the confirm seated a first-round line").toBeTruthy();
    const leaving = line.away_entrant_id!;
    const staying = line.home_entrant_id!;

    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await dismissCookieBanner(page);
    const leavingRow = page.locator("tr", { has: page.getByRole("button", { name: nameOf.get(leaving)!, exact: false }) }).first();
    await leavingRow.getByTestId("entrant-row-withdraw").click();
    const dialog = page.getByRole("alertdialog", { name: `Withdraw ${nameOf.get(leaving)}?` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/entrants/${leaving}/withdraw`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Withdraw entrant" }).click();
    expect(((await (await answered).json()) as { data: { lucky_loser: { entrant_id: string } | null } }).data.lucky_loser?.entrant_id, "the server's answer").toBe(lucky);

    const note = page.getByTestId("entrants-departure-line");
    await expect(note).toHaveCount(1, { timeout: 20_000 });
    await expect(note).toHaveText(`${nameOf.get(lucky)} takes ${nameOf.get(leaving)}'s place in round 1, as the best loser.`);
    await expect(note).toHaveAttribute("data-tone", "done");

    const after = (await mainRows()).find((f) => f.id === line.id)!;
    expect([after.home_entrant_id, after.away_entrant_id, after.status], "the seat is the lucky loser's, the opponent not walked over").toEqual([staying, lucky, "scheduled"]);

    // Withdrawing someone no lucky loser replaces says nothing about one: the notice region renders no line.
    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await expect(page.getByTestId("entrants-departure-line"), "a fresh page carries no stale sentence").toHaveCount(0);
  });
});

// X-SD-7 (W4 T20, K5 "shown"; R24 pick 3A): the stage's draw seed is said on its card — "Draw #<seed>", a muted line under the
// header — so an organiser can tell which draw they are looking at (RB4-D4: the same field and seed draw the same bracket). The
// seed is the stage's own (`swissDrawSeed(stage id)`, the draw's declared function — `lib/swiss-draw.ts`), recorded on the
// Generate's ledger row; a Rebuild reuses it, so the line does not move. A wholly SEEDED bracket draws nothing, so shows none.
test.describe("X-SD-7 the stage shows its draw seed", () => {
  test("six unseeded players: the card says Draw #<the stage's seed>, and a Rebuild keeps it; a seeded bracket says nothing", async ({ page, request }) => {
    test.setTimeout(150_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Seed cup ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "badminton", variant_key: "bwf", config: {} });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    const added = await apiJson<{ id: string }[]>(
      request,
      `/api/v1/divisions/${divisionId}/entrants`,
      "POST",
      ["Ana", "Ben", "Cas", "Dee", "Eli", "Fay"].map((n) => ({ kind: "individual", display_name: `Seed ${n} ${TAG}` })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    const seedLine = page.getByTestId("stage-draw-seed");

    // Nothing drawn yet: no line.
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await expect(page.getByTestId("stage-more").or(page.locator(`[data-stage-id="${stageId}"]`)).first()).toBeVisible({ timeout: 30_000 });
    await expect(seedLine, "nothing generated yet").toHaveCount(0);

    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    const want = swissDrawSeed(stageId);
    await page.reload();
    await expect(seedLine).toHaveCount(1, { timeout: 30_000 });
    await expect(seedLine).toHaveText(`Draw #${want}`);
    await expect(seedLine, "the attribute carries the bare number").toHaveAttribute("data-draw-seed", String(want));

    // A Rebuild reuses the stage's seed (RB4-D5): the same line.
    const rebuilt = await apiJson(request, `/api/v1/stages/${stageId}/rebuild`, "POST");
    expect(rebuilt.status, JSON.stringify(rebuilt.error)).toBe(200);
    await page.reload();
    await expect(seedLine).toHaveText(`Draw #${want}`, { timeout: 30_000 });

    // A wholly seeded bracket draws nothing: its card has no line (the positive pair above proves the line renders at all).
    const seeded = await startedKnockout(request, "Seeded cup", ["Ana", "Ben", "Cas", "Dee"].map((n) => `Seeded ${n} ${TAG}`));
    await page.goto(await divisionPath(request, seeded.divisionId, "?tab=fixtures"));
    await expect(page.locator(`[data-stage-id="${seeded.stageId}"]`).first()).toBeVisible({ timeout: 30_000 });
    await expect(seedLine, "a seeded field is not drawn").toHaveCount(0);
  });
});
