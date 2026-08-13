import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  setOrgPlanBySql,
  expectNoHorizontalScroll,
  setDateTime,
} from "./helpers";

// PROMPT-33 acceptance (v3/04 §2 + v3/11 gaps 10/11/15): five-division board
// — legend filter with URL state, injected rest violation → badge → panel →
// jump, pick-then-place on mobile emulation AND keyboard, no page-level
// horizontal scroll, two-client stale write → 409 + refreshed board, and the
// initial payload budget. Drag-and-drop itself is HTML5 dataTransfer (not
// reliably scriptable) — pick/place and the PATCH route cover the move path.

const DIVISIONS = ["U16 Boys", "U16 Girls", "U18 Boys", "U18 Girls", "Open Singles"];

/** Per-division court pair — divisions must not share courts or every slot
 *  would be a cross-division court clash (siblingAssignments checks the whole
 *  competition) and the seeding PATCHes would 409. */
const courtsOf = (di: number): [string, string] => [`P${di}A`, `P${di}B`];

interface Rig {
  compSlug: string;
  orgSlug: string;
  divisions: { id: string; slug: string; name: string }[];
  /** per division: generated fixture ids in creation order */
  fixtures: Record<string, string[]>;
  /** two fixtures in division[0] sharing an entrant (rest-violation bait) */
  sharedEntrantFixtures: [string, string];
}

async function buildRig(request: APIRequestContext, page: Page): Promise<Rig> {
  const org = await activeOrg(page);
  await setOrgPlanBySql({ orgId: org.id }, "pro");

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Board v3 ${TAG}`,
    visibility: "private",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });

  const divisions: Rig["divisions"] = [];
  const fixtures: Rig["fixtures"] = {};
  let sharedEntrantFixtures: [string, string] | null = null;

  for (const [di, name] of DIVISIONS.entries()) {
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const d = { id: div.data!.id, slug: div.data!.slug, name };
    divisions.push(d);

    await apiJson(
      request,
      `/api/v1/divisions/${d.id}/entrants`,
      "POST",
      Array.from({ length: 12 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `${name} P${i + 1}`,
        seed: i + 1,
      })),
    );
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${d.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    await apiJson(request, `/api/v1/divisions/${d.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(di),
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const gen = await apiJson<{
      fixtures: { id: string; round_no: number; home_entrant_id: string; away_entrant_id: string }[];
    }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    const ids = gen.data!.fixtures.map((f) => f.id);
    fixtures[d.id] = ids;

    // Timetable: spread every fixture over the three days, two courts, no
    // shared-entrant adjacency (league rounds already alternate players).
    const base = Date.UTC(2026, 8, 15, 9, 0, 0);
    // C1: this division runs 6 fixtures/round over only 2 courts, so a round
    // spans THREE waves, not one simultaneous slot — round N's own fixtures
    // are not all at the same time the way a smaller (courts >= per-round
    // matches) board's would be. Recorded here (id → computed time) so the
    // bait below can be derived from what was ACTUALLY assigned, not assumed
    // from a wave-per-round shape that does not hold at this size.
    // C1 fix-loop: the board is a DAY-TABBED view (schedule-board.tsx),
    // defaulting to its earliest day — `days` itself extends to cover
    // "the scheduled fixtures' range", so a fixture landing beyond the
    // competition's own `ends_on` still gets a tab, just not the DEFAULT
    // one. The rest-violation bait below navigates to it explicitly
    // ("Next day", bounded) rather than needing every fixture on-screen
    // by default — so the ORIGINAL spread stays untouched here (a tighter
    // one inflated this division's pre-existing rest-floor violations
    // from ~2 to ~34 once the bait test raises `perEntrantMinRest`, which
    // then visually clutters an unrelated later mobile test).
    const atMs = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) {
      const day = i % 3;
      const slot = Math.floor(i / 3);
      const at = base + day * 24 * 60 * 60_000 + slot * 60 * 60_000;
      atMs.set(ids[i]!, at);
      await apiJson(request, `/api/v1/fixtures/${ids[i]!}`, "PATCH", {
        scheduled_at: new Date(at).toISOString(),
        court_label: courtsOf(di)[i % 2],
      });
    }

    // Rest bait in the first division: two fixtures sharing an entrant, one
    // from the LAST round and one from an EARLIER round — picked so moving
    // the pair is provably safe under H6 regardless of the multi-wave shape
    // above (see this function's own comment on the seeding loop).
    if (!sharedEntrantFixtures) {
      const maxRound = Math.max(...gen.data!.fixtures.map((f) => f.round_no));
      // The temporally LATEST fixture among every round BELOW the max. Round
      // order only requires it to precede every round-max fixture, and by
      // construction nothing scheduled below the max round sits any later —
      // moving ITS entrant's round-max fixture to right after it can never
      // leapfrog a third, untouched fixture, at any round.
      const latestBelowMax = gen.data!.fixtures
        .filter((f) => f.round_no < maxRound)
        .reduce((best, f) => (atMs.get(f.id)! > atMs.get(best.id)! ? f : best));
      const partnerRoundMax = gen.data!.fixtures.find(
        (f) =>
          f.round_no === maxRound &&
          (f.home_entrant_id === latestBelowMax.home_entrant_id ||
            f.home_entrant_id === latestBelowMax.away_entrant_id ||
            f.away_entrant_id === latestBelowMax.home_entrant_id ||
            f.away_entrant_id === latestBelowMax.away_entrant_id),
      );
      if (partnerRoundMax) sharedEntrantFixtures = [latestBelowMax.id, partnerRoundMax.id];
    }
  }

  return {
    compSlug: comp.data!.slug,
    orgSlug: org.slug,
    divisions,
    fixtures,
    sharedEntrantFixtures: sharedEntrantFixtures!,
  };
}

test.describe.serial("board v3 (PROMPT-33)", () => {
  let rig: Rig;
  let boardUrl: string;

  test("seed: five divisions × ~66 fixtures land under the payload budget (gap 15)", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000); // 5 divisions × 66 sequential PATCHes
    rig = await buildRig(request, page);
    boardUrl = `/o/${rig.orgSlug}/c/${rig.compSlug}/schedule`;

    const resp = await page.goto(boardUrl);
    expect(resp?.ok()).toBe(true);
    await expect(page.getByRole("group", { name: "Board density" })).toBeVisible();
    // Gap 15 budgets the board's JSON payload — the RSC flight segments in
    // the document (the dev-mode HTML around them carries HMR/dev overhead
    // that never ships). Parse the response body: hydration may have drained
    // the runtime __next_f array by the time we could evaluate.
    const html = (await resp!.body()).toString("utf8");
    const flightBytes = [...html.matchAll(/__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)].reduce(
      (n, m) => n + m[1]!.length,
      0,
    );
    expect(flightBytes).toBeGreaterThan(0);

    // The dictionary is subtracted, not budgeted. Every /o console page
    // serialises the WHOLE ui dictionary into its flight via DictProvider
    // (o/[orgSlug]/layout.tsx) — one copy per document, ~190KB escaped, and it
    // grows with every locale key added anywhere in the app. Budgeting the raw
    // total made this guard an i18n tripwire: it was raised 250K→420K in the
    // v5 i18n merge (c7a0527), then reds again the moment six `board.ai.joint.
    // undo*` keys landed in #479 (+639B, at 420098 against a 420000 ceiling) —
    // a board test failing for a commit that touched no board payload.
    //
    // What gap 15 actually budgets is the per-fixture cost of a 5×66 board, so
    // that is what is asserted: the flight MINUS the dictionary it carries.
    // A genuine per-fixture regression is tens of KB and still trips this;
    // adding locale strings no longer does.
    const uiDict = readFileSync(
      fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)),
      "utf8",
    );
    // As the flight carries it: minified, then JSON-string-escaped (the outer
    // quotes are not part of the payload).
    const dictBytes = JSON.stringify(JSON.stringify(JSON.parse(uiDict))).length - 2;
    expect(flightBytes).toBeGreaterThan(dictBytes); // the dict IS in there
    expect(flightBytes - dictBytes).toBeLessThan(250_000);
  });

  test("legend filters to two divisions in two taps; the URL is shareable", async ({ page }) => {
    await page.goto(boardUrl);
    // Legend now renders twice — once above the grid, once below it — both
    // sharing one filter state (board redesign, 2026-08-10).
    await expect(page.getByRole("group", { name: "Filter by division" })).toHaveCount(2);
    await page.getByRole("button", { name: "U16 Boys", exact: true }).first().click();
    await page.getByRole("button", { name: "U16 Girls", exact: true }).first().click();
    await expect(page).toHaveURL(/d=u16-boys(%2C|,)u16-girls/);

    // Only the two selected divisions' chips render on blocks.
    await expect(page.locator("[data-fixture-id]").first()).toBeVisible();
    const chips = await page
      .locator("[data-fixture-id] [data-division-chip]")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-division-chip")))]);
    expect(chips.sort()).toEqual(["U16B", "U16G"]);

    // Fresh navigation to the same URL keeps the filter (shareable view).
    await page.goto(page.url());
    const chipsAfter = await page
      .locator("[data-fixture-id] [data-division-chip]")
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-division-chip")))]);
    expect(chipsAfter.sort()).toEqual(["U16B", "U16G"]);
  });

  test("Move panel's When field renders at a real width, not collapsed (regression)", async ({
    page,
  }) => {
    await page.goto(boardUrl);
    await page.locator("[data-fixture-id] button[aria-pressed]").first().click();
    const dialog = page.getByRole("dialog", { name: /^Move / });
    const dateInput = dialog.locator('input[type="date"]');
    await expect(dateInput).toBeVisible();
    const box = await dateInput.boundingBox();
    // The bug (00631754, fixed by this redesign) collapsed this to a
    // near-zero box — a real native date input is never this narrow.
    expect(box?.width ?? 0).toBeGreaterThan(80);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("injected rest violation → badge count → panel → jump-to-fixture", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    // Tighten rest, then butt the shared-entrant fixtures against each other
    // on different courts (same time + court would 409 as a court clash).
    await apiJson(request, `/api/v1/divisions/${d0.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(0),
        perEntrantMinRest: 60,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const [fa, fb] = rig.sharedEntrantFixtures;
    // C1: `fa` (the lower round) is left EXACTLY where the seeding loop put
    // it — that whole 66-fixture sequence applied one PATCH at a time without
    // ever hitting an H6 block (the "seed" test above), so it is provably
    // round-order-consistent already, and relocating `fa` to a fixed absolute
    // time (the original "2026-09-15T09:00") risks landing it after some
    // untouched round-1 sibling the naive day/court spread put on day two or
    // three. Only `fb` (the higher round) moves, to immediately after `fa`
    // ends — safe both ways: comparable against `fa`'s round only helps
    // (moving later), and `fb`'s own round is exempt from the scan against
    // its OWN untouched same-round siblings.
    const faRow = await apiJson<{ scheduled_at: string; court_label: string }>(
      request,
      `/api/v1/fixtures/${fa}`,
    );
    const faStart = Date.parse(faRow.data!.scheduled_at);
    const fbStart = faStart + 30 * 60_000; // matchMinutes is 30 under the
    // tightened settings just above; 0 gap between fa ending and fb starting
    // is 0' rest against a 60' floor.
    //
    // C1 fix-loop: "whichever court isn't fa's" is NOT provably free at
    // fb's NEW time — confirmed flaky in schedule-board.spec.ts's identical
    // pattern: the naive per-index seeding can legitimately have put a
    // THIRD, untouched fixture on that other court at this exact hour, and
    // guessing landed a real (correctly blocked) `conflict.court` there
    // instead of the rest warning this test means to exercise. Check both
    // courts against every OTHER division-0 fixture's actual current slot
    // and pick one that is genuinely free.
    const allFixtureRows = await Promise.all(
      rig.fixtures[d0.id]!.filter((id) => id !== fa && id !== fb).map((id) =>
        apiJson<{ scheduled_at: string | null; court_label: string | null }>(
          request,
          `/api/v1/fixtures/${id}`,
        ),
      ),
    );
    const fbEnd = fbStart + 30 * 60_000;
    const [courtA, courtB] = courtsOf(0);
    const courtFree = (court: string) =>
      !allFixtureRows.some((r) => {
        if (r.data!.court_label !== court || r.data!.scheduled_at === null) return false;
        const otherStart = Date.parse(r.data!.scheduled_at);
        const otherEnd = otherStart + 30 * 60_000;
        return fbStart < otherEnd && otherStart < fbEnd;
      });
    const fbCourt = courtFree(courtA) ? courtA : courtB;
    await apiJson(request, `/api/v1/fixtures/${fb}`, "PATCH", {
      scheduled_at: new Date(fbStart).toISOString(),
      court_label: fbCourt,
    });

    await page.goto(boardUrl);
    const badge = page.getByRole("button", { name: /conflicts? — open the list/ });
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();

    const panel = page.getByRole("region", { name: "Schedule conflicts" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("rest", { exact: true }).first()).toBeVisible();
    // The board is a DAY-TABBED view (schedule-board.tsx's `day`/`days`
    // state) defaulting to `days[0]` — the earliest day with fixtures, not
    // every fixture at once. `fa`'s card is provably safe under H6 (see this
    // block's own comments above) precisely because it sits late in the
    // board, which means it is very likely on a LATER day tab than the
    // default. Step forward with the "Next day" control until its card
    // exists, rather than assume which day it landed on.
    const card = page.locator(`[data-fixture-id="${fa}"]`);
    const nextDay = page.getByRole("button", { name: "Next day" });
    for (let hop = 0; hop < 7 && (await card.count()) === 0; hop++) {
      await nextDay.click();
    }
    await expect(card).toHaveCount(1);
    // The card itself must show ONE merged "rest" badge, not two (the
    // original bug: two warn.rest entries — one per entrant — rendered as
    // two identical, indistinguishable badges).
    await expect(card.getByText("rest", { exact: true })).toHaveCount(1);
    // No raw pin/lock emoji anywhere on the board — real icons only. Absence
    // of the emoji alone doesn't prove an icon replaced it (a silently empty
    // button would pass that check too), so also assert the real icon is on
    // screen — every unlocked, movable card carries one.
    await expect(page.getByText("📌")).toHaveCount(0);
    await expect(page.getByText("🔒")).toHaveCount(0);
    await expect(page.locator("[data-fixture-id] svg.lucide-pin").first()).toBeVisible();

    await panel.getByRole("button", { name: "Jump to fixture →" }).first().click();
    await expect(panel).toBeHidden();
    // The offending block is highlighted and scrolled into view.
    await expect(page.locator(".animate-pulse [data-fixture-id]").first()).toBeInViewport();
  });

  test("pick-then-place schedules a fixture on 390px emulation (agenda default)", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    const target = rig.fixtures[d0.id]![4]!;
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${boardUrl}?d=${d0.slug}`);
    await expectNoHorizontalScroll(page);

    // Bottom sheet → pick the unscheduled fixture → place on a time group.
    await page.getByRole("button", { name: /^Unscheduled/ }).click();
    const sheet = page.getByRole("region", { name: "Unscheduled fixtures" });
    await sheet.locator("[data-fixture-id] button[aria-pressed]").first().click();
    await page.getByRole("button", { name: "Place picked match here" }).first().click();

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test("pick-then-place is keyboard-operable (fixture and slot, Enter to pick/place)", async ({
    page,
    request,
  }) => {
    const d0 = rig.divisions[0]!;
    const target = rig.fixtures[d0.id]![5]!;
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.goto(`${boardUrl}?d=${d0.slug}`);
    // Board density on desktop: grid slots become tabbable once picked.
    await page.getByRole("button", { name: "Board", exact: true }).click();

    const trayFixture = page
      .locator("aside[aria-label='Unscheduled fixtures'] [data-fixture-id] button[aria-pressed]")
      .first();
    await trayFixture.focus();
    await page.keyboard.press("Enter"); // pick
    await expect(trayFixture).toHaveAttribute("aria-pressed", "true");

    const slot = page.getByRole("button", { name: /^Place picked match at/ }).first();
    await slot.focus();
    await page.keyboard.press("Enter"); // place

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
    await expectNoHorizontalScroll(page);
  });

  test("blackout window: hatched, always visible, and still placeable (soft, not blocked)", async ({
    page,
    request,
  }) => {
    // d0, not d2: the multi-division board's grid config (courts aside) is
    // ALWAYS divisions[0]'s schedule-settings (page.tsx, "Grid config: first
    // division's settings") — the `?d=` filter only narrows what's DISPLAYED,
    // never which division's blackouts/sessionWindows drive the grid. A
    // blackout PUT on any other division is invisible here, however isolated
    // it looks. Safe to mutate d0 from this point on: the only earlier test
    // that touches its settings ("injected rest violation") has already made
    // and checked its own assertions. The one test still after this one
    // ("two clients...") re-PUTs its own settings verbatim before using it,
    // so this test's mutation doesn't leak forward.
    const d0 = rig.divisions[0]!;
    // Index 24 is untouched by every earlier test in this file (they use
    // index 4, index 5, and the shared-entrant pair — all comfortably below
    // 24) — but rather than trust that by construction, read its CURRENT
    // scheduled_at/court_label live and build the window around exactly
    // that, so this test can't drift out of sync with what earlier tests in
    // this serial chain actually left on the board.
    const target = rig.fixtures[d0.id]![24]!;
    const before = await apiJson<{ scheduled_at: string; court_label: string }>(
      request,
      `/api/v1/fixtures/${target}`,
    );
    const court = before.data!.court_label!;
    const from = before.data!.scheduled_at!;
    const to = new Date(new Date(from).getTime() + 30 * 60_000).toISOString();

    await apiJson(request, `/api/v1/divisions/${d0.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-15T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtsOf(0),
        perEntrantMinRest: 0,
        blackouts: [{ court, from, to }],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    // Unscheduling `target` is what makes ITS cell empty — the empty-cell
    // hatch and an occupied FixtureBlock are mutually exclusive on the same
    // cell, so a window over a still-occupied slot would never render
    // `data-blackout` at all.
    await apiJson(request, `/api/v1/fixtures/${target}`, "PATCH", {
      scheduled_at: null,
      court_label: null,
    });

    await page.goto(`${boardUrl}?d=${d0.slug}`);
    const blackoutCell = page.locator('[data-blackout="true"]').first();
    await expect(blackoutCell).toBeVisible();

    // Soft: pick the unscheduled fixture, place it INTO the hatched cell —
    // it must succeed, matching the server's own warn.blackout-is-a-warning
    // (not a rejection) behavior. Desktop dock, not the mobile sheet (no
    // viewport override above, same as "pick-then-place is keyboard-operable"):
    // the tray's aside is always visible at `lg` widths and up, no toggle tap.
    const trayFixture = page
      .locator("aside[aria-label='Unscheduled fixtures'] [data-fixture-id] button[aria-pressed]")
      .first();
    await trayFixture.click();
    await blackoutCell.click();

    await expect
      .poll(
        async () =>
          (await apiJson<{ scheduled_at: string | null }>(request, `/api/v1/fixtures/${target}`))
            .data!.scheduled_at,
        { timeout: 15_000 },
      )
      .not.toBeNull();
  });

  test("two clients: the stale one 409s, toasts, and refreshes (gap 10)", async ({
    page,
    context,
  }) => {
    const d0 = rig.divisions[0]!;
    const filtered = `${boardUrl}?d=${d0.slug}`;
    const pageB = await context.newPage();
    // The premise is that B writes with a STALE seq. Where Supabase realtime
    // is live (staging), A's move broadcasts schedule_changed and B silently
    // router.refresh()es to the new seq — its write then fails on a court
    // clash instead of SEQ_CONFLICT. Deafen B's websocket so it provably
    // keeps the pre-move seq; a no-op where realtime isn't configured.
    await pageB.routeWebSocket(/realtime/, () => {});
    await page.goto(filtered);
    await pageB.goto(filtered);

    // Client A moves a fixture through the pick → MovePanel path. Each move is
    // gated on its own PATCH landing: on a slow runner an ungated A could still
    // be in flight when B writes — B's seq would then be VALID, no 409, no
    // toast, and the test times out (the CI-only failure this replaces).
    const move = async (p: Page, when: string) => {
      await p.locator("[data-fixture-id] button[aria-pressed]").first().click();
      const dialog = p.getByRole("dialog", { name: /^Move / });
      // MovePanel's "When" is a native date input + time <select> now, not
      // `input[type=datetime-local]` — Chrome's clock popup ignored `step`
      // (quarter-hour-time-select design doc). The dialog holds exactly one
      // such pair, so setDateTime's scoping is unambiguous.
      await setDateTime(dialog, when);
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
    };
    // Wait for the move's PATCH — whatever its status — then assert on it, so
    // a CI failure names the actual HTTP status + body instead of timing out
    // inside a status-filtered waitForResponse that silently ignores the real
    // answer (the previous shape of this fix hid a non-2xx from client A).
    const moveAndAwait = async (p: Page, when: string, want: "committed" | "seq-conflict") => {
      const [res] = await Promise.all([
        p.waitForResponse(
          (r) =>
            /\/api\/v1\/fixtures\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === "PATCH",
          { timeout: 20_000 },
        ),
        move(p, when),
      ]);
      const status = res.status();
      const ok = want === "committed" ? status >= 200 && status < 300 : status === 409;
      if (!ok) {
        const body = await res.text().catch(() => "<unreadable>");
        throw new Error(`move expected ${want}, got HTTP ${status}: ${body.slice(0, 300)}`);
      }
    };

    // A's move must COMMIT (2xx) before B writes, so B is provably stale.
    //
    // The time typed here is the VENUE's, not the runner's. That changed with
    // the quarter-hour-time-select work: MovePanel now seeds and emits on
    // `settings.orgTz` (#448) instead of the browser zone, so a BST laptop and
    // a UTC runner resolve this identically. The history is worth keeping,
    // because it is what made the date safe rather than the zone rule: 16th
    // 18:00 was free on a BST laptop (17:00Z) but collided with the seeded
    // 18:00Z/P0A fixture on the UTC runner — the chronic "CI-only" red was a
    // court clash, not a race. The 18th sits outside the seeded 15th-17th grid
    // in any timezone, so it survives both the old behaviour and the new.
    await moveAndAwait(page, "2026-09-18T09:00", "committed");
    // A's own board refreshes without complaint.
    await expect(page.getByText("Schedule changed by someone else")).toHaveCount(0);

    // Client B still holds the pre-move seq: its write must 409 → toast.
    await moveAndAwait(pageB, "2026-09-18T10:00", "seq-conflict");
    await expect(pageB.getByText("Schedule changed by someone else — board refreshed.")).toBeVisible(
      { timeout: 15_000 },
    );
    await pageB.close();
  });
});
