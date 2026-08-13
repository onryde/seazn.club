import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, divisionPath, expectNoHorizontalScroll, setDateTime } from "./helpers";

// C1 task 2 item 2 — owner-demanded browser e2e. The owner explicitly
// rejected task 1's real-solver integration runs (schedule-reflow-*.test.ts,
// z3-auto-schedule engine coverage) as a substitute: those prove the ENGINE
// enforces round order, never that an organiser clicking Auto-schedule in a
// real browser against a real build actually SEES a board in round order.
//
// Flow: a round-robin board -> Auto-schedule -> the resulting board is in
// round order. Every assertion below reads the RENDERED PAGE — never
// `getFixture`/`/api/v1/fixtures/:id`, which every other scheduling spec in
// this directory (z3-auto-schedule.spec.ts included) uses freely, and which
// this file deliberately does not, since an API read would prove the
// database is in round order and say nothing about the screen.
//
// WHY THE AGENDA VIEW. `BoardAgenda` (board-agenda.tsx) is "the mobile
// default and the >=8-division fallback" — it is also the one board layout
// whose OWN sort (`a.scheduled_at - b.scheduled_at`) makes DOM order a
// direct, no-geometry proxy for chronological order: read every
// `[data-fixture-id]` card top to bottom and its rendered "R<n>" label is
// the round order the organiser is looking at. The grid/lanes views convey
// the same board through column position and CSS geometry instead, which
// would make this file assert on layout math rather than on content.
//
// ANCHORED ON `="` throughout (#465 house rule): every id/label read below
// is compared against a real, non-empty expected shape — never a bare
// existence probe, which a card whose `fixture` prop went missing would
// still pass (React serialises an omitted prop as the string
// `"$undefined"`, so `data-fixture-id` would still be PRESENT, just wrong).

const SOLVED = ["ok", "already_optimal"];
/** See z3-auto-schedule.spec.ts's own comment on this constant: solver_busy
 *  is a live, transient status under this project's parallel workers, and
 *  retrying rather than accepting it is what keeps this file honest about
 *  proving a real solve. */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

/** A private competition + a 4-entrant round-robin division (6 fixtures,
 *  3 rounds of 2) on a two-court grid — the same shape
 *  z3-auto-schedule.spec.ts's own seedBoard uses, trimmed to just what this
 *  file needs. `createStageAndGenerate`'s default `kind: "league"` is what
 *  makes this board's rounds ROUND-ROBIN ones at all — `roundRobinStageIds`
 *  (schedule.ts) is `kind in ('league', 'group')` only. */
async function seedRoundRobinBoard(
  request: Parameters<typeof apiJson>[0],
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Round Order ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Round Order",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Brook", "Clay", "Dune"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length).toBe(6);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court A", "Court B"],
        // 0, not a rest floor: a rest shortfall is a warn-only conflict, and
        // this file's ONE claim is round order — a board carrying an
        // unrelated warning is not a cleaner proof of it.
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);
  return { divisionId, fixtureIds };
}

test("Auto-schedule produces a board the organiser SEES in round order", async ({ page }) => {
  const { divisionId } = await seedRoundRobinBoard(page.request);

  // Mobile viewport BEFORE navigating: BoardAgenda is what mounts at this
  // width, and its chronological sort is the mechanism this whole file
  // relies on — see the file header.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

  const button = page.getByTestId("schedule-auto");
  await expect(button).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("schedule-result-strip");
  let status: string | null = null;
  for (let attempt = 1; attempt <= BUSY_RETRIES; attempt++) {
    await button.click();
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    status = await strip.getAttribute("data-status");
    if (status !== "solver_busy") break;
    if (attempt < BUSY_RETRIES) await page.waitForTimeout(BUSY_BACKOFF_MS);
  }
  expect(SOLVED, `solver reported data-status="${status}" — not a real solve`).toContain(status);

  // THE CLAIM. Every fixture card, read in the order the organiser's own
  // screen shows them (DOM order == chronological order, by BoardAgenda's
  // own sort — see the file header), and the round label rendered ON that
  // card (fixture-block.tsx: `<span>R{fixture.round_no}</span>`, always
  // rendered, no conditional).
  const cards = page.locator("[data-fixture-id]");
  const count = await cards.count();
  expect(count, "no fixture cards rendered after Auto-schedule").toBe(6);
  const rounds: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = await cards.nth(i).getAttribute("data-fixture-id");
    expect(id, `card ${i} has no real data-fixture-id (got "${id}")`).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const text = (await cards.nth(i).textContent()) ?? "";
    const m = /R(\d+)/.exec(text);
    expect(m, `card ${i} (fixture ${id}) carries no "R<n>" round label in its own rendered text`).not.toBeNull();
    rounds.push(Number(m![1]));
  }
  // Round order, exactly as an organiser scanning the agenda top to bottom
  // would read it: the round label never DECREASES from one card to the
  // next. Ties are legal by design (H6 admits round_i <= round_j; two
  // rounds sharing a court/instant is the ruling, not a defect), so this is
  // `>=`, not `>`.
  for (let i = 1; i < rounds.length; i++) {
    expect(
      rounds[i]!,
      `round order broken ON SCREEN: card ${i - 1} shows R${rounds[i - 1]}, card ${i} shows R${rounds[i]} — ` +
        `the organiser would see a later round scheduled before an earlier one`,
    ).toBeGreaterThanOrEqual(rounds[i - 1]!);
  }
  // At least two distinct rounds actually appear on screen — otherwise the
  // loop above is vacuously true on what could be a single-round board.
  expect(new Set(rounds).size, "only one distinct round appeared — the claim above proved nothing").toBeGreaterThan(1);

  // The standing UI bar (AGENTS.md): desktop + 320 + 768, no horizontal
  // page scroll at any of them. The round-order claim is proved once,
  // above, on the view where it is most directly legible (agenda) — these
  // three are the layout regression check every surface owes regardless,
  // not a re-run of the round-order assertion under different geometry.
  // Screenshots are evidence for the task report, not an assertion.
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/round-order-375.png", fullPage: true });
  for (const viewport of [
    { width: 1280, height: 800, shot: "1280" },
    { width: 320, height: 700, shot: "320" },
    { width: 768, height: 1024, shot: "768" },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("schedule-auto")).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `test-results/round-order-${viewport.shot}.png`, fullPage: true });
  }
});

// C1 fix-loop (G2/3rd instance) — the drag/keyboard move path's own blind
// spot: `moveFixture`'s delta gate used to be structurally unable to see a
// round-order violation against an untouched sibling (a one-fixture checked
// set can never contain a same-sequence PAIR). This is the browser proof
// that a real drag into that violation is REFUSED end to end — not merely
// that `moveFixture` throws in a unit test, but that the organiser's own
// screen shows the refusal and the card stays put. `auth.setup.ts`'s stored
// state never touches the board, so 375px genuinely drives Agenda mode here
// too (see the file header on why Agenda is the view this file reads).
//
// MovePanel, not native HTML5 drag: `schedule-board.spec.ts`'s own header —
// "Drag-and-drop itself is HTML5 dataTransfer (not reliably scriptable) —
// the keyboard MovePanel and the PATCH route cover the same code path" — is
// why every move in this directory goes through the pick -> MovePanel ->
// Move button sequence (`board-v3.spec.ts`'s own `move` helper), never a
// synthesized dragstart/drop.
test("dragging a card into a round-order violation against an untouched sibling is refused, on screen", async ({
  page,
}) => {
  const { divisionId, fixtureIds } = await seedRoundRobinBoard(page.request);
  // Round-ordered by construction (`generateStageFixtures`'s own `order by
  // round_no, seq_in_round`, the same convention the unit-level delta-gate
  // suite relies on) — the LAST id is round 3, never round 1, so moving it
  // is never the one direction (round 1 moving later) that could leapfrog
  // a sibling of ITS OWN making rather than proving the gate.
  const laterRoundFixtureId = fixtureIds[fixtureIds.length - 1]!;

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

  // A real, round-order-correct board first — the same Auto-schedule flow
  // the file's other test proves lands on screen, so the illegal drag below
  // is judged against an actually-rendered board, not a synthetic one typed
  // straight into the database.
  const button = page.getByTestId("schedule-auto");
  await expect(button).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("schedule-result-strip");
  let status: string | null = null;
  for (let attempt = 1; attempt <= BUSY_RETRIES; attempt++) {
    await button.click();
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    status = await strip.getAttribute("data-status");
    if (status !== "solver_busy") break;
    if (attempt < BUSY_RETRIES) await page.waitForTimeout(BUSY_BACKOFF_MS);
  }
  expect(SOLVED, `solver reported data-status="${status}" — not a real solve`).toContain(status);

  const cardBefore = page.locator(`[data-fixture-id="${laterRoundFixtureId}"]`);
  await expect(cardBefore).toBeVisible({ timeout: 15_000 });
  const textBefore = (await cardBefore.textContent()) ?? "";
  expect(textBefore, `fixture ${laterRoundFixtureId} carries no R<n> label before the drag`).toMatch(/R\d+/);

  // Pick the later-round card, then move it to the day BEFORE the board's
  // own `startAt` (2026-09-21) — `2026-09-20T09:00` — which trips the
  // day-level half of H6 (`dayA > dayB`) against round 1's untouched
  // sibling regardless of exact time-of-day, so the destination time itself
  // only has to be a real, selectable slot (the board's own anchor,
  // `09:00`, always is).
  await cardBefore.locator("button[aria-pressed]").click();
  const dialog = page.getByRole("dialog", { name: /^Move / });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await setDateTime(dialog, "2026-09-20T09:00");
  await dialog.getByRole("button", { name: "Move", exact: true }).click();

  // THE REFUSAL, on screen: the board's own error banner
  // (schedule-board.tsx, `actions.error`), not an API status code.
  await expect(page.getByText("Can't schedule here", { exact: false })).toBeVisible({
    timeout: 15_000,
  });

  // THE CARD STAYED, on screen: the exact same "every card, R<n>, top to
  // bottom" read the main test in this file uses, re-run after the refused
  // drag. If the move had silently gone through (the bug this task fixes),
  // the later round's card would now render ahead of round 1's, and this
  // loop would fail exactly the way the main test's own would.
  const cards = page.locator("[data-fixture-id]");
  const count = await cards.count();
  expect(count, "a card vanished from the board after a REFUSED move").toBe(6);
  const rounds: number[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await cards.nth(i).textContent()) ?? "";
    const m = /R(\d+)/.exec(text);
    expect(m, `card ${i} carries no R<n> label after the refused drag`).not.toBeNull();
    rounds.push(Number(m![1]));
  }
  for (let i = 1; i < rounds.length; i++) {
    expect(
      rounds[i]!,
      `round order broke ON SCREEN after a move that should have been REFUSED: card ${i - 1} shows ` +
        `R${rounds[i - 1]}, card ${i} shows R${rounds[i]}`,
    ).toBeGreaterThanOrEqual(rounds[i - 1]!);
  }

  await expectNoHorizontalScroll(page);
});
