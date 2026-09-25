import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, seedVenueWithCourts } from "./helpers";

// Review 4 of #857 (Major), end to end over the real rail: the board read
// (`listDivisionFixturesForBoard`) flags a match that holds a result while its
// status still reads `scheduled` — a start taken back is the one way to get
// there — and the board card, the drag and the bulk tools all read that flag.
//
// A unit suite cannot see this seam: the flag is produced by SQL over the
// scoring ledger and consumed by a client card, so both ends are driven here —
// a real `core.start` then `core.void` through the events route, then the
// division board, then the "+15m" bulk tool.
//
// Before the fix the card still showed its pick handle and pin (both refused
// on click), and "+15m" stopped at that card: the cards before it moved, the
// ones after it did not, and the board was never re-read.

const EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const KEPT_ONE = EN["history.danger.keptPlayed.one"]!.replace("{count}", "1");
const PIN = EN["board.block.pin"]!;

const DAY = "2030-06-01";
const at = (hour: number, minute = 0) =>
  `${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

interface HeldBoard {
  divisionId: string;
  /** Round 2, first court: started, then the start taken back. */
  held: string;
  /** Round 1, first court: never touched. */
  free: string;
  fixtureCount: number;
}

/**
 * One league division, 4 entrants → 3 rounds × 2 matches. Round r plays at
 * 09:00 / 11:00 / 13:00 on two courts, so every ±15m move is legal on its own
 * (no court clash, no round-order leapfrog, no rest floor) and the ONLY
 * refusal a bulk shift can meet is the held card.
 */
async function seedHeldBoard(request: APIRequestContext): Promise<HeldBoard> {
  const rand = Math.random().toString(36).slice(2, 6);
  const { courts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Held card ${TAG}-${rand}`,
    visibility: "private",
    starts_on: DAY,
    ends_on: DAY,
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Ada", "Bay", "Cy", "Dot"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const stageId = stage.data!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: at(9),
      matchMinutes: 45,
      gapMinutes: 0,
      courts: courts.map((c) => c.id),
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  const gen = await apiJson<{ fixtures: { id: string; round_no: number }[] }>(
    request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  const fixtures = gen.data!.fixtures;
  expect(fixtures).toHaveLength(6);

  const seat = new Map<string, { round: number; court: number }>();
  const perRound = new Map<number, number>();
  const assignments = fixtures.map((f) => {
    const court = perRound.get(f.round_no) ?? 0;
    perRound.set(f.round_no, court + 1);
    seat.set(f.id, { round: f.round_no, court });
    return { fixture_id: f.id, scheduled_at: at(7 + 2 * f.round_no), court_id: courts[court]!.id };
  });
  const applied = await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
    assignments,
    source: "auto",
  });
  expect(applied.status, `${applied.error?.code ?? ""} ${applied.error?.message ?? ""}`).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

  const pick = (round: number) =>
    fixtures.find((f) => seat.get(f.id)!.round === round && seat.get(f.id)!.court === 0)!.id;
  const held = pick(2);

  // A scorer starts the match, then takes the start back: the status returns
  // to `scheduled`, the ledger keeps both events.
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${held}/state`);
  const start = await apiJson<{ seq: number; event_id: string }>(request, `/api/v1/fixtures/${held}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "core.start",
    payload: {},
  });
  expect(start.status, JSON.stringify(start.error)).toBe(201);
  const voided = await apiJson<{ status: string }>(request, `/api/v1/fixtures/${held}/events`, "POST", {
    expected_seq: start.data!.seq,
    type: "core.void",
    payload: { event_id: start.data!.event_id },
  });
  expect(voided.status, JSON.stringify(voided.error)).toBe(201);
  expect(voided.data!.status).toBe("scheduled");

  return { divisionId, held, free: pick(1), fixtureCount: fixtures.length };
}

async function scheduledAt(request: APIRequestContext, fixtureId: string): Promise<string> {
  const res = await apiJson<{ scheduled_at: string }>(request, `/api/v1/fixtures/${fixtureId}`);
  return new Date(res.data!.scheduled_at).toISOString();
}

for (const width of [1280, 320]) {
  test(`a voided start holds its board card in place, and +15m passes over it (${width}px)`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 720 });
    const seed = await seedHeldBoard(request);

    await page.goto(await divisionPath(page.request, seed.divisionId, "/schedule?tab=board"));
    // Phones open on Agenda; the bulk tools live on the Board density.
    const boardDensity = page
      .getByRole("group", { name: EN["board.densityAria"]! })
      .getByRole("button", { name: EN["board.density.board"]!, exact: true });
    await boardDensity.click();
    await expect(boardDensity).toHaveAttribute("aria-pressed", "true");

    const held = page.locator(`[data-fixture-id="${seed.held}"]`).first();
    const free = page.locator(`[data-fixture-id="${seed.free}"]`).first();
    await expect(held).toBeVisible({ timeout: 20_000 });
    // The positive pair first: a plain card carries both controls, so their
    // absence on the held one below is the flag, not a missing render.
    await expect(free).toHaveAttribute("draggable", "true");
    await expect(free.locator("button[aria-pressed]")).toHaveCount(1);
    await expect(free.getByRole("button", { name: PIN })).toHaveCount(1);
    await expect(held).toHaveAttribute("draggable", "false");
    await expect(held.locator("button[aria-pressed]")).toHaveCount(0);
    await expect(held.getByRole("button", { name: PIN })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await held.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`) });

    const patched: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && /\/api\/v1\/fixtures\/[^/]+$/.test(r.url())) {
        patched.push(r.url().split("/").pop()!);
      }
    });
    await page.getByRole("button", { name: "+15m", exact: true }).click();

    await expect(page.getByText(KEPT_ONE, { exact: true })).toBeVisible({ timeout: 20_000 });
    // Every other card was sent, the held one never was.
    expect(patched).toHaveLength(seed.fixtureCount - 1);
    expect(patched).not.toContain(seed.held);
    // Polled, not awaited once: the `request` context sat idle through the UI
    // steps above, and its first fetch can land on a keep-alive socket the
    // server has already closed (ECONNRESET). A poll retries a thrown read.
    await expect.poll(() => scheduledAt(request, seed.held)).toBe(at(11));
    await expect.poll(() => scheduledAt(request, seed.free)).toBe(at(9, 15));
    await expectNoHorizontalScroll(page);
    // A phone viewport cannot hold the notice and the card at once, so it takes
    // the whole page — from the top, or the sticky header is painted mid-page.
    if (width < 768) await page.evaluate(() => window.scrollTo(0, 0));
    else await held.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`board-${width}-kept.png`), fullPage: width < 768 });
  });
}
