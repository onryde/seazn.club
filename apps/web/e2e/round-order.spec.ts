import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, divisionPath, expectNoHorizontalScroll, setDateTime } from "./helpers";

// C1 task 2 item 2 — owner-demanded browser e2e. The owner explicitly
// rejected task 1's real-solver integration runs (schedule-reflow-*.test.ts,
// auto-schedule engine coverage) as a substitute: those prove the ENGINE
// enforces round order, never that an organiser clicking Auto-schedule in a
// real browser against a real build actually SEES a board in round order.
//
// Flow: a round-robin board -> Auto-schedule -> the resulting board is in
// round order. Every assertion below reads the RENDERED PAGE — never
// `getFixture`/`/api/v1/fixtures/:id`, which every other scheduling spec in
// this directory (auto-schedule.spec.ts included) uses freely, and which
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
/** See auto-schedule.spec.ts's own comment on this constant: solver_busy
 *  is a live, transient status under this project's parallel workers, and
 *  retrying rather than accepting it is what keeps this file honest about
 *  proving a real solve. */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

/** A private competition + a 4-entrant round-robin division (6 fixtures,
 *  3 rounds of 2) on a two-court grid — the same shape
 *  auto-schedule.spec.ts's own seedBoard uses, trimmed to just what this
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

// ---------------------------------------------------------------------------
// C1 gap A — the JOINT multi-division apply's own round-order wiring.
//
// The two tests above prove round order through a single-division board
// (Auto-schedule's preview, and moveFixture's drag gate). Neither exercises
// `/competitions/{id}/schedule/apply` (competition-schedule-apply.ts) at
// all — a structurally separate builder/verify seam from the single-division
// one (see this branch's own `reference_ai_plan_propose_vs_apply_verification
// _split` note), and the one Gap A found completely unable to see round
// order: `verifyConfigFor` there never received a `tz`.
//
// NO UI PATH constructs a round-order-VIOLATING joint apply to click through:
// the competition board's only route to this endpoint is the AI joint
// console's Apply button (ai-competition-console.tsx), which submits
// whatever the AI proposed — and the AI's own proposal is verified clean by
// this same branch's Gap B fix before the organiser ever sees a review step.
// So both tests below post directly to the endpoint via the `request`
// context, exactly the way a real API client (or a future manual-edit UI)
// would, and then read the RENDERED BOARD — never just the HTTP response —
// for the on-screen proof `round-order.spec.ts`'s own header commits this
// file to.
// ---------------------------------------------------------------------------

/** One competition, two independent 4-entrant round-robin divisions (6
 *  fixtures each), each on its own dedicated court so a cross-division time
 *  coincidence can never read as a court clash and confound a round-order
 *  assertion — the joint twin of `seedRoundRobinBoard` above. */
async function seedJointRoundRobinBoard(request: Parameters<typeof apiJson>[0]): Promise<{
  competitionId: string;
  alpha: { divisionId: string; fixtureIds: string[] };
  bravo: { divisionId: string; fixtureIds: string[] };
}> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Joint Round Order ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;

  async function seedDivision(name: string, court: string) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${competitionId}/divisions`,
      "POST",
      {
        name,
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
          courts: [court],
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
      },
    );
    expect(settings.status).toBe(200);
    return { divisionId, fixtureIds };
  }

  const alpha = await seedDivision("Alpha", "Court A");
  const bravo = await seedDivision("Bravo", "Court B");
  return { competitionId, alpha, bravo };
}

const JOINT_T0 = Date.UTC(2026, 8, 21, 9, 0);
const jointAt = (minutes: number): string => new Date(JOINT_T0 + minutes * 60_000).toISOString();

/** Every fixture, round-ascending (`generate`'s own order), a court, and a
 *  starting offset — the joint twin of the single-division tests' `lineUp`
 *  idiom (schedule/apply request shape, not a UI action). */
const lineUp = (fixtureIds: string[], court: string) =>
  fixtureIds.map((fixture_id, i) => ({ fixture_id, scheduled_at: jointAt(i * 30), court_label: court }));

/** #350's `expected_seq` has no GET endpoint, and a freshly-seeded division is
 *  NOT reliably seq 0 — `divisions.seq` is a general-purpose event counter
 *  (stages.ts bumps it on stage creation too, ahead of any scheduling),
 *  confirmed directly rather than assumed (a `0` guess here 409s
 *  SEQ_CONFLICT with `current_seq: 1` on this exact seed flow). Every real
 *  client either tracks its own last write or learns the token from a
 *  refused one — this probes with a guess certain to be wrong and reads the
 *  true value back off the SEQ_CONFLICT body it provokes. Single-division
 *  (the endpoint's `.min(1)`), so the probe's own verdict is unambiguous. */
async function currentDivisionSeq(
  request: Parameters<typeof apiJson>[0],
  competitionId: string,
  divisionId: string,
  probeFixtureId: string,
): Promise<number> {
  const probe = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      {
        division_id: divisionId,
        expected_seq: 999_999_999,
        assignments: [{ fixture_id: probeFixtureId, scheduled_at: jointAt(0), court_label: "Probe" }],
      },
    ],
    source: "ai",
  });
  const err = probe.error as { code?: string; current_seq?: number } | undefined;
  if (probe.status !== 409 || err?.code !== "SEQ_CONFLICT" || typeof err.current_seq !== "number") {
    throw new Error(`currentDivisionSeq: expected a SEQ_CONFLICT probe, got ${JSON.stringify(probe)}`);
  }
  return err.current_seq;
}

test("a joint apply lands both divisions in round order the organiser SEES, through the joint endpoint", async ({
  page,
  request,
}) => {
  const { competitionId, alpha, bravo } = await seedJointRoundRobinBoard(request);

  const alphaSeq = await currentDivisionSeq(request, competitionId, alpha.divisionId, alpha.fixtureIds[0]!);
  const bravoSeq = await currentDivisionSeq(request, competitionId, bravo.divisionId, bravo.fixtureIds[0]!);
  const res = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.divisionId, expected_seq: alphaSeq, assignments: lineUp(alpha.fixtureIds, "Court A") },
      { division_id: bravo.divisionId, expected_seq: bravoSeq, assignments: lineUp(bravo.fixtureIds, "Court B") },
    ],
    source: "ai",
  });
  expect(res.status, JSON.stringify(res)).toBe(200);

  // THE CLAIM, on screen, for BOTH divisions — each has its own board route;
  // a competition has no single combined board view. Same read as the
  // Auto-schedule test above: DOM order == chronological order on Agenda
  // (BoardAgenda's own sort), the round label is on every card verbatim.
  for (const [label, div] of [
    ["Alpha", alpha],
    ["Bravo", bravo],
  ] as const) {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(await divisionPath(page.request, div.divisionId, "/schedule?tab=board"));
    const cards = page.locator("[data-fixture-id]");
    const count = await cards.count();
    expect(count, `${label}: no fixture cards rendered after the joint apply`).toBe(6);
    const rounds: number[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await cards.nth(i).textContent()) ?? "";
      const m = /R(\d+)/.exec(text);
      expect(m, `${label}: card ${i} carries no R<n> label`).not.toBeNull();
      rounds.push(Number(m![1]));
    }
    for (let i = 1; i < rounds.length; i++) {
      expect(
        rounds[i]!,
        `${label}: round order broken ON SCREEN after the JOINT apply: card ${i - 1} shows ` +
          `R${rounds[i - 1]}, card ${i} shows R${rounds[i]}`,
      ).toBeGreaterThanOrEqual(rounds[i - 1]!);
    }
    expect(new Set(rounds).size, `${label}: only one distinct round appeared`).toBeGreaterThan(1);
    await expectNoHorizontalScroll(page);
  }
  await page.screenshot({ path: "test-results/joint-round-order-375.png", fullPage: true });
});

test("a joint apply that INTRODUCES a round-order violation is refused, and NOTHING renders on either board", async ({
  page,
  request,
}) => {
  const { competitionId, alpha, bravo } = await seedJointRoundRobinBoard(request);
  // Discovered ONCE: the violating attempt below is refused before it ever
  // reaches the seq check (applyCompetitionSchedule throws SCHEDULE_CONFLICT
  // ahead of the write loop `assertFreshSeq` lives in — see the module
  // header), and nothing else writes to either division in this test, so the
  // SAME tokens are still correct for the recovery retry further down.
  const alphaSeq = await currentDivisionSeq(request, competitionId, alpha.divisionId, alpha.fixtureIds[0]!);
  const bravoSeq = await currentDivisionSeq(request, competitionId, bravo.divisionId, bravo.fixtureIds[0]!);

  // Alpha's round-1 (first id) and round-3 (last id) slots swapped — a
  // straight swap of two already-occupied times, so no court/rest conflict
  // rides along to confound the assertion (perEntrantMinRest is 0 above).
  // Bravo stays entirely clean and correctly ordered.
  const last = alpha.fixtureIds.length - 1;
  const alphaViolating = alpha.fixtureIds.map((fixture_id, i) => ({
    fixture_id,
    scheduled_at: i === 0 ? jointAt(last * 30) : i === last ? jointAt(0) : jointAt(i * 30),
    court_label: "Court A",
  }));
  const bravoClean = lineUp(bravo.fixtureIds, "Court B");

  const refused = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.divisionId, expected_seq: alphaSeq, assignments: alphaViolating },
      { division_id: bravo.divisionId, expected_seq: bravoSeq, assignments: bravoClean },
    ],
    source: "ai",
  });
  // `error.conflicts` is the RAW engine `Conflict` shape on this route —
  // camelCase `fixtureId`/`reason`/`direct`, NOT the snake_case
  // `ScheduleConflict`/`code`/`blocking` the single-fixture PATCH route
  // above uses (confirmed against server/api-v1/http.ts's errorResponse and
  // ApplyCompetitionScheduleResult's own doc comment, not assumed).
  const conflicts =
    (refused.error as { conflicts?: { fixtureId?: string; reason?: string; direct?: boolean }[] } | undefined)
      ?.conflicts ?? [];
  expect(refused.status, JSON.stringify(refused)).toBe(409);
  expect(conflicts.some((c) => c.reason === "order" && c.direct === true)).toBe(true);

  // THE on-screen atomicity proof: `board-tray-mobile`'s OWN `data-count`
  // (board-tray.tsx — built for exactly this: "'the board repainted after an
  // apply' is exactly 'every card left this tray'"). Both divisions are
  // brand new, so a write that genuinely did nothing leaves all 6 fixtures
  // of EACH sitting in the tray, never a partially- or wrongly-scheduled one.
  for (const [label, div] of [
    ["Alpha", alpha],
    ["Bravo", bravo],
  ] as const) {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(await divisionPath(page.request, div.divisionId, "/schedule?tab=board"));
    await expect(
      page.getByTestId("board-tray-mobile"),
      `${label}: unscheduled tray missing/miscounted after a REFUSED joint apply — the write was not atomic`,
    ).toHaveAttribute("data-count", "6");
    await expectNoHorizontalScroll(page);
  }
  await page.screenshot({ path: "test-results/joint-round-order-refused-375.png", fullPage: true });

  // THE RECOVERY, same shape as the single-division test's "control": the
  // block is about THIS write, not a permanent lockout. Nothing was written
  // by the refused attempt, so the SAME expected_seq tokens are still
  // correct, and a correctly-ordered retry with them must succeed and render.
  const retried = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.divisionId, expected_seq: alphaSeq, assignments: lineUp(alpha.fixtureIds, "Court A") },
      { division_id: bravo.divisionId, expected_seq: bravoSeq, assignments: bravoClean },
    ],
    source: "ai",
  });
  expect(retried.status, JSON.stringify(retried)).toBe(200);
  await page.goto(await divisionPath(page.request, alpha.divisionId, "/schedule?tab=board"));
  await expect(page.locator("[data-fixture-id]")).toHaveCount(6);
});

// C1 final-review — the same endpoint, but with a PARTIAL per-division
// listing: only the moved fixture is named, and the round-robin sibling its
// new position collides with is left OUT of `assignments` entirely, sitting
// wherever the clean apply below already placed it. The delta gate used to
// compare `assignments` against itself only (calendar.ts's round-order pair
// scan, by design) — an unlisted sibling could never be paired against
// anything, so this exact shape was invisible before the fix this test is
// pinned to. The two tests above prove the FULL-listing case; this is the
// gap `competition-schedule-apply.test.ts`'s own "C1 gap A" tests never
// covered either.
test("a joint apply that introduces a round-order violation via a PARTIAL listing is refused, and the untouched sibling's card stays put on screen", async ({
  page,
  request,
}) => {
  const { competitionId, alpha, bravo } = await seedJointRoundRobinBoard(request);
  const alphaSeq = await currentDivisionSeq(request, competitionId, alpha.divisionId, alpha.fixtureIds[0]!);
  const bravoSeq = await currentDivisionSeq(request, competitionId, bravo.divisionId, bravo.fixtureIds[0]!);

  // A real, round-order-correct board first, through the same joint
  // endpoint the "lands both divisions" test above proves renders clean.
  const clean = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      { division_id: alpha.divisionId, expected_seq: alphaSeq, assignments: lineUp(alpha.fixtureIds, "Court A") },
      { division_id: bravo.divisionId, expected_seq: bravoSeq, assignments: lineUp(bravo.fixtureIds, "Court B") },
    ],
    source: "ai",
  });
  expect(clean.status, JSON.stringify(clean)).toBe(200);

  // PARTIAL: Alpha's round-1 fixture ALONE, pushed a full day past
  // round 3 — round 3's fixture (the LAST id) stays untouched at the clean
  // position above and is never named in this request's `assignments`.
  const partialSeq = await currentDivisionSeq(request, competitionId, alpha.divisionId, alpha.fixtureIds[0]!);
  const refused = await apiJson(request, `/api/v1/competitions/${competitionId}/schedule/apply`, "POST", {
    divisions: [
      {
        division_id: alpha.divisionId,
        expected_seq: partialSeq,
        assignments: [
          { fixture_id: alpha.fixtureIds[0]!, scheduled_at: jointAt(24 * 60), court_label: "Court A" },
        ],
      },
    ],
    source: "ai",
  });
  // Same wire-shape note as the full-listing refusal test above: the RAW
  // engine `Conflict` shape, camelCase, on `error.conflicts` directly.
  const conflicts =
    (refused.error as { conflicts?: { fixtureId?: string; reason?: string; direct?: boolean }[] } | undefined)
      ?.conflicts ?? [];
  expect(refused.status, JSON.stringify(refused)).toBe(409);
  expect(conflicts.some((c) => c.reason === "order")).toBe(true);

  // THE on-screen proof: the board is unchanged from the clean baseline —
  // still 6 cards, still non-decreasing round labels top to bottom. If the
  // partial move had silently gone through (the bug this test is pinned
  // to), round 1's card would now render after round 3's.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(await divisionPath(page.request, alpha.divisionId, "/schedule?tab=board"));
  const cards = page.locator("[data-fixture-id]");
  const count = await cards.count();
  expect(count, "a card vanished from Alpha's board after a REFUSED partial apply").toBe(6);
  const rounds: number[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await cards.nth(i).textContent()) ?? "";
    const m = /R(\d+)/.exec(text);
    expect(m, `card ${i} carries no R<n> label`).not.toBeNull();
    rounds.push(Number(m![1]));
  }
  for (let i = 1; i < rounds.length; i++) {
    expect(
      rounds[i]!,
      `round order broke ON SCREEN after a PARTIAL move that should have been REFUSED: card ${i - 1} shows ` +
        `R${rounds[i - 1]}, card ${i} shows R${rounds[i]}`,
    ).toBeGreaterThanOrEqual(rounds[i - 1]!);
  }
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/joint-round-order-partial-refused-375.png", fullPage: true });
});
