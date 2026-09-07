import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";
import { TAG, apiJson, activeOrg, seedVenueWithCourts, addEntrantsViaApi } from "./helpers";
// The AUTHORITY for what a day label looks like, imported rather than
// hand-typed: the assertions below must move when the format moves, and must
// witness only the thing under test (WHICH locale formatted it). A typed
// "mardi 15 septembre" would freeze one ICU version's output as the spec.
import { dayLabel, dayLabelLong } from "../src/lib/day-label";

// Competition Desk W2 — the browser proof for three items that shipped with
// `tsc` + a node-environment vitest as their only gates. Each one is invisible
// to those gates by construction:
//
//   F13  the day header's LOCALE. A node unit test renders the component with
//        whatever locale it passes in; only a browser has a competing default
//        of its own to leak in. This file pins the browser to ja-JP precisely
//        so the two can disagree — with an en-US browser the defect and the
//        fix render the same bytes and the test witnesses nothing.
//   R34  the bracket round-section date. Reachable only through a real
//        knockout whose rounds `buildRunSheet` has actually bucketed.
//   R35  the inline editor's court picker. It lives behind `useState(editing)`
//        in a jsdom-less suite, so nothing had ever opened it, changed it, or
//        sent its PATCH.
//
// Every locale/date expectation is derived (from `day-label.ts`, or from the
// seed's own instants), never typed.

const LOCALES = ["en", "es", "fr", "nl"] as const;

// The copy catalogs themselves, so the refusal test below asserts the SHIPPED
// sentence rather than a hand-typed twin that would keep passing after a copy
// edit moved the real one.
const UI = Object.fromEntries(
  LOCALES.map((l) => [
    l,
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../src/dictionaries/${l}/ui.json`, import.meta.url)), "utf8"),
    ) as Record<string, string>,
  ]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

/**
 * W3 Task 9 fix round 1, Major finding. The run-sheet row now carries the
 * meta/round text (and, when set, the court name embedded in it) in TWO
 * paragraphs below `md` — one `hidden md:block` (desktop), one `md:hidden`
 * (phone, combined with the result sub-line) — "one DOM, branched", the
 * repo-wide phone-composition idiom `run-sheet-row.tsx` uses.
 *
 * `expect(row).toContainText(x)` reads `Element.textContent`, which does
 * NOT respect `display:none` — it finds `x` whichever copy holds it, hidden
 * or not, so it silently stopped proving "the entrant/court/status is on
 * screen" the moment that duplication landed, without this file's own
 * assertions or line count ever changing. This is the exact mirror of the
 * `mobile.spec.ts` P6-task-B bug fixed alongside this: there the hidden
 * copy made `toBeVisible()` FAIL (a loud false red); here it makes
 * `toContainText` PASS (a silent false green that never announces itself).
 *
 * This spec's tests all run at the `parallel` project's fixed 1280px
 * viewport (Desktop Chrome default, no per-test `setViewportSize` override
 * in this file) — `md:` and up, where exactly ONE copy of any given piece
 * of text is ever visible by construction (the `hidden`/`md:hidden` pair is
 * mutually exclusive at every width), so scoping to the visible copy here
 * is strictly correct, never a weaker assertion than the one it replaces.
 *
 * Scoped to `p`/`a`/`button` specifically, not a bare `:visible` — the row
 * `<li>` itself and its wrapper `<div>`s are also `:visible` and also
 * "contain" the text somewhere in their subtree (via `hasText`'s substring
 * match), so an untyped selector would resolve right back to an ancestor
 * that says nothing about which LEAF actually shows it — the same
 * disambiguation `mobile.spec.ts:3180`'s `p:visible` fix already needed.
 */
async function expectVisibleText(row: Locator, text: string): Promise<void> {
  await expect(
    row.locator("p:visible, a:visible, button:visible", { hasText: text }).first(),
    `"${text}" is not visible on screen in this row (a hidden copy may carry it, which textContent cannot tell apart)`,
  ).toBeVisible();
}

/** A league division whose fixtures all land on ONE venue-zone day, so the run
 *  sheet renders exactly one `kind: "day"` block to read the header off. */
async function seedTimedLeague(
  request: APIRequestContext,
  courtNames: string[] = ["Court 1"],
) {
  const suffix = Math.random().toString(36).slice(2, 6);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `RunSheetDates ${TAG}-${suffix}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
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
  await addEntrantsViaApi(request, div.data!.id, ["A", "B", "C", "D"]);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const { courts } = await seedVenueWithCourts(
    request,
    courtNames.map((n) => `${n} ${suffix}`),
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-09-15T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: courts.map((c) => c.id),
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = await apiJson<{ fixtures: { id: string; fixture_no: number }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  return { comp: comp.data!, div: div.data!, courts, fixtures: gen.data!.fixtures };
}

// ---------------------------------------------------------------------------
// F13 — the day header speaks the APP's language, not the viewer's browser.
//
// The browser is pinned to ja-JP for the whole describe. That is the entire
// design of this test: the retired implementation formatted with
// `toLocaleDateString([], …)` inside a `useEffect`, i.e. the CLIENT's default
// locale, so on this browser it produced "9月15日火曜日" underneath four
// otherwise-localized consoles. `notToContain(ja)` is the assertion that
// actually fails against that code; the per-locale `toContain` pins the value.
// ---------------------------------------------------------------------------
test.describe("the run sheet's day header is in the app's locale, not the browser's", () => {
  test.use({ locale: "ja-JP" });

  test("all four locales render their own long date, and never the browser's", async ({
    page,
    context,
    request,
  }) => {
    const { comp, div, courts, fixtures } = await seedTimedLeague(request);
    // One day, one court, one fixture per half-hour — derived from the same
    // instant the assertions read back, never a typed day string.
    const base = Date.UTC(2026, 8, 15, 9, 0, 0);
    for (let i = 0; i < fixtures.length; i++) {
      await apiJson(request, `/api/v1/fixtures/${fixtures[i]!.id}`, "PATCH", {
        scheduled_at: new Date(base + i * 30 * 60_000).toISOString(),
        court_id: courts[0]!.id,
      });
    }
    const dayKey = new Date(base).toISOString().slice(0, 10);

    const org = await activeOrg(page);
    const url = `/o/${org.slug}/c/${comp.slug}/d/${div.slug}?tab=fixtures`;
    await page.goto(url);
    const origin = new URL(page.url()).origin;

    // What the DEFECT renders on this browser. Derived from the same helper the
    // component uses, so it is the real competing string and not an approximation.
    const browserForm = dayLabelLong(dayKey, "ja-JP");

    const seen = new Map<string, string>();
    for (const locale of LOCALES) {
      await context.addCookies([{ name: "seazn_locale", value: locale, url: origin }]);
      await page.goto(url);
      const heading = page.locator(`[data-run-sheet-day="${dayKey}"]`);
      // POSITIVE PAIR FIRST: the surface exists. Every assertion after this one
      // would pass on a blank page or a boundary.
      await expect(heading).toBeVisible();
      const text = (await heading.textContent()) ?? "";
      expect(text, `${locale}: day header must carry the app-locale long date`).toContain(
        dayLabelLong(dayKey, locale),
      );
      expect(text, `${locale}: day header must NOT use the ja-JP browser locale`).not.toContain(
        browserForm,
      );
      seen.set(locale, dayLabelLong(dayKey, locale));
    }
    // A locale-blind implementation renders one string four times. This is the
    // ordering-differential case: es/fr/nl each differ from en AND from each
    // other, so no single hardcoded locale satisfies the set.
    expect(new Set(seen.values()).size, `four locales rendered ${[...seen.values()].join(" | ")}`).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// R34 — a bracket round section states its date, and says nothing when it has
// nothing to say.
//
// Both halves are driven through a real knockout, because `buildRunSheet` is
// what decides which pile a bracket fixture lands in and the suppression case
// is only reachable on one specific shape: a SETTLED, never-timed round. An
// OPEN untimed bracket fixture is filed in the division-wide "Not yet
// scheduled" block instead (max-effort review finding 9), so it never reaches
// a round section at all and cannot exercise this.
// ---------------------------------------------------------------------------
test.describe("bracket round sections carry the round's calendar date", () => {
  test("a timed round states its date (and its range); a settled untimed round states none", async ({
    page,
    request,
  }) => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `RunSheetKO ${TAG}-${suffix}`, visibility: "private" },
    );
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Cup",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divisionId = div.data!.id;
    await addEntrantsViaApi(request, divisionId, ["S1", "S2", "S3", "S4"]);
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "knockout", name: "Cup" },
    );
    const { courts } = await seedVenueWithCourts(request, [`KO Court ${suffix}`]);
    await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-20T10:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [courts[0]!.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const gen = await apiJson<{
      fixtures: { id: string; round_no: number; fixture_no: number }[];
    }>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

    const semis = gen.data!.fixtures.filter((f) => f.round_no === 1);
    const final = gen.data!.fixtures.find((f) => f.round_no === 2)!;
    expect(semis.length, "a 4-entrant knockout is 2 semis + 1 final").toBe(2);

    // Both semis on ONE day first — the headline shape the ruling describes.
    const dayOne = Date.UTC(2026, 8, 20, 10, 0, 0);
    await apiJson(request, `/api/v1/fixtures/${semis[0]!.id}`, "PATCH", {
      scheduled_at: new Date(dayOne).toISOString(),
      court_id: courts[0]!.id,
    });
    await apiJson(request, `/api/v1/fixtures/${semis[1]!.id}`, "PATCH", {
      scheduled_at: new Date(dayOne + 60 * 60_000).toISOString(),
      court_id: courts[0]!.id,
    });
    const keyOne = new Date(dayOne).toISOString().slice(0, 10);

    const org = await activeOrg(page);
    const url = `/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`;
    await page.goto(url);

    const bracket = page.locator('[data-run-sheet-block="bracket"]');
    await expect(bracket).toBeVisible();
    const rounds = bracket.locator("> div");
    // F2 fix (W2 walkthrough gate 1): the final is OPEN and untimed here —
    // an entirely ordinary shape, nothing requires slotting a knockout round
    // onto a court before it can be played — and now stays in its OWN round
    // section rather than leaking into "Not yet scheduled" (the exact defect
    // F2 fixed: bracket membership is decided before the untimed-OPEN
    // routing, so `bracketRoundLabel`'s round count is never computed from a
    // truncated lane). Two rounds: the timed semis, and the untimed final.
    await expect(rounds).toHaveCount(2);
    await expect(rounds.nth(0).locator("[data-run-sheet-round-dates]")).toHaveText(
      new RegExp(escapeRe(dayLabel(keyOne, "en"))),
    );
    // The untimed final states no date — same "an empty cell is not
    // information" rule the settled-untimed case below already covers.
    await expect(rounds.nth(1).locator("[data-run-sheet-round-dates]")).toHaveCount(0);

    // ...and a round that SPANS days prints both ends, not just the first.
    await apiJson(request, `/api/v1/fixtures/${semis[1]!.id}`, "PATCH", {
      scheduled_at: new Date(dayOne + 24 * 60 * 60_000).toISOString(),
      court_id: courts[0]!.id,
    });
    const keyTwo = new Date(dayOne + 24 * 60 * 60_000).toISOString().slice(0, 10);
    await page.goto(url);
    const spanned = page
      .locator('[data-run-sheet-block="bracket"]')
      .locator("> div")
      .nth(0)
      .locator("[data-run-sheet-round-dates]");
    await expect(spanned).toContainText(dayLabel(keyOne, "en"));
    await expect(spanned).toContainText(dayLabel(keyTwo, "en"));

    // Now settle the whole bracket WITHOUT ever timing the final — an ordinary
    // knockout; nothing in this product requires scheduling a round to play it.
    for (const s of semis) await resultFixture(request, s.id, 2, 0);
    await expect
      .poll(
        async () => {
          const f = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(
            request,
            `/api/v1/fixtures/${final.id}`,
          );
          return [f.data!.home_entrant_id, f.data!.away_entrant_id].filter(Boolean).length;
        },
        { timeout: 20_000 },
      )
      .toBe(2);
    await resultFixture(request, final.id, 2, 1);

    await page.goto(url);
    const rounds2 = page.locator('[data-run-sheet-block="bracket"]').locator("> div");
    await expect(rounds2).toHaveCount(2);
    // POSITIVE PAIR: the final's round section is really on the page, with the
    // final's own row inside it. Without this, "no date span" passes on a page
    // that never rendered the round at all.
    const finalRound = rounds2.nth(1);
    await expect(finalRound.locator(`[data-fixture-no="${final.fixture_no}"]`)).toBeVisible();
    // ...and the timed round still states its dates, so the absence below is a
    // property of THIS round and not of a page that stopped rendering them.
    await expect(rounds2.nth(0).locator("[data-run-sheet-round-dates]")).toBeVisible();
    await expect(finalRound.locator("[data-run-sheet-round-dates]")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// F5 (W2 walkthrough gate 1): a TIMED bracket fixture whose entrants are
// still undrawn ("Winner of R1·N" vs "Winner of R1·N") read "Awaiting draw"
// as its sub-line and offered "Score" as its action at the same time — a
// promise the fixture cannot keep, since neither side is named yet.
// ---------------------------------------------------------------------------
test.describe("a timed, undrawn bracket fixture never offers Score (F5)", () => {
  test("the final, scheduled ahead of the semis being played, reads View — not Score", async ({
    page,
    request,
  }) => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const comp = await apiJson<{ id: string; slug: string }>(
      request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `RunSheetF5 ${TAG}-${suffix}`, visibility: "private" },
    );
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Cup",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divisionId = div.data!.id;
    await addEntrantsViaApi(request, divisionId, ["S1", "S2", "S3", "S4"]);
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${divisionId}/stages`,
      "POST",
      { seq: 1, kind: "knockout", name: "Cup" },
    );
    const { courts } = await seedVenueWithCourts(request, [`F5 Court ${suffix}`]);
    await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-09-20T10:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [courts[0]!.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const gen = await apiJson<{ fixtures: { id: string; round_no: number; fixture_no: number }[] }>(
      request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

    // Schedule the FINAL ahead of time — an ordinary organiser action, and
    // exactly the shape F2's own test proves stays in its round section —
    // WITHOUT playing either semi, so its entrants are still "Winner of
    // R1·N" placeholders.
    const final = gen.data!.fixtures.find((f) => f.round_no === 2)!;
    await apiJson(request, `/api/v1/fixtures/${final.id}`, "PATCH", {
      scheduled_at: "2026-09-21T09:00:00.000Z",
      court_id: courts[0]!.id,
    });

    const org = await activeOrg(page);
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}?tab=fixtures`);
    const finalRow = page.locator(`[data-fixture-no="${final.fixture_no}"]`);
    await expect(finalRow).toBeVisible();
    // POSITIVE PAIR: the row really is the undrawn final, not an empty locator.
    await expectVisibleText(finalRow, UI.en["runsheet.sub.awaitingDraw"]!);
    await expect(finalRow.locator("[data-row-action]")).toHaveAttribute("data-row-action", "view");
    await expect(finalRow.locator('[data-row-action="score"]')).toHaveCount(0);
    await expect(finalRow.locator('[data-row-action="assign_scorer"]')).toHaveCount(0);
    await expectVisibleText(finalRow, UI.en["runsheet.action.view"]!);
  });
});

// ---------------------------------------------------------------------------
// R35 — the court picker inside the inline editor.
//
// The whole point of this test is the round trip. A `useState` that never
// reaches the server looks EXACTLY like one that did until the page is
// reloaded, so every assertion here is made after a reload or against the API.
// ---------------------------------------------------------------------------
test.describe("the inline editor's per-fixture court picker", () => {
  test("opens at the STORED court, saves it to the server, and survives a reload", async ({
    page,
    request,
  }) => {
    const { comp, div, courts, fixtures } = await seedTimedLeague(request, ["C1", "C2"]);
    const [c1, c2] = courts;
    const target = fixtures[0]!;
    const at = new Date(Date.UTC(2026, 8, 15, 9, 0, 0)).toISOString();
    await apiJson(request, `/api/v1/fixtures/${target.id}`, "PATCH", {
      scheduled_at: at,
      court_id: c1!.id,
    });

    const org = await activeOrg(page);
    const url = `/o/${org.slug}/c/${comp.slug}/d/${div.slug}?tab=fixtures`;
    await page.goto(url);

    const row = page.locator(`[data-fixture-no="${target.fixture_no}"]`);
    await expectVisibleText(row, c1!.name);
    await row.getByTestId("run-sheet-edit-time").click();

    const select = row.getByTestId("fixture-court-select");
    // WHAT IT OPENS AT, not merely that it is reachable — a picker that renders
    // "Unassigned" over a fixture sitting on C1 is the contradicting-facts
    // defect, and every reachability assertion passes on it.
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(c1!.id);

    await select.selectOption(c2!.id);
    await row.getByRole("button", { name: "Save", exact: true }).click();

    // The row reflects it...
    await expectVisibleText(row, c2!.name);
    // ...and so does the SERVER, which is the half a local `useState` fakes.
    await expect
      .poll(async () => {
        const f = await apiJson<{ court_id: string | null }>(
          request,
          `/api/v1/fixtures/${target.id}`,
        );
        return f.data!.court_id;
      })
      .toBe(c2!.id);

    // A full reload, because `router.refresh()` could repaint from a client
    // cache that agrees with a write that never landed.
    await page.reload();
    const row2 = page.locator(`[data-fixture-no="${target.fixture_no}"]`);
    await expectVisibleText(row2, c2!.name);
    await row2.getByTestId("run-sheet-edit-time").click();
    await expect(row2.getByTestId("fixture-court-select")).toHaveValue(c2!.id);

    // Reseed-on-open, the court's half of the adjudicated `when` rule: pick C1,
    // Cancel, reopen — the editor must show the STORED C2, never the abandoned
    // pick. A `useState` initializer (once per MOUNT) fails exactly here.
    await row2.getByTestId("fixture-court-select").selectOption(c1!.id);
    await row2.getByRole("button", { name: "Cancel", exact: true }).click();
    await row2.getByTestId("run-sheet-edit-time").click();
    await expect(row2.getByTestId("fixture-court-select")).toHaveValue(c2!.id);
  });

  test("a court that would double-book is REFUSED, and the organiser is told IN THEIR OWN LANGUAGE", async ({
    page,
    context,
    request,
  }) => {
    const { comp, div, courts, fixtures } = await seedTimedLeague(request, ["C1", "C2"]);
    const [c1, c2] = courts;
    const at = new Date(Date.UTC(2026, 8, 15, 9, 0, 0)).toISOString();
    // Two disjoint-entrant round-1 fixtures at the SAME instant on DIFFERENT
    // courts — legal. Moving the first onto the second's court is not.
    const mover = fixtures[0]!;
    const blocker = fixtures.find((f) => f.id !== mover.id)!;
    await apiJson(request, `/api/v1/fixtures/${mover.id}`, "PATCH", {
      scheduled_at: at,
      court_id: c1!.id,
    });
    const blockerRes = await apiJson(request, `/api/v1/fixtures/${blocker.id}`, "PATCH", {
      scheduled_at: at,
      court_id: c2!.id,
    });
    // The precondition is a FACT to assert, not to assume: if this PATCH were
    // itself refused there would be nothing to clash with and the test below
    // would pass for the wrong reason.
    expect(blockerRes.status, JSON.stringify(blockerRes.error)).toBe(200);

    const org = await activeOrg(page);
    const url = `/o/${org.slug}/c/${comp.slug}/d/${div.slug}?tab=fixtures`;
    // FRENCH, deliberately. The retired code rendered `err.message` — the
    // EngineError's own English sentence, thrown by `assertNoNewBlocking` in
    // src/server/usecases/schedule.ts — so on an `en` console the defect and
    // the fix are indistinguishable and this test would witness nothing. Every
    // expected string below is READ from the dictionaries rather than typed, so
    // a copy edit moves the assertion with it instead of leaving it pinned to
    // yesterday's sentence.
    await page.goto(url);
    await context.addCookies([
      { name: "seazn_locale", value: "fr", url: new URL(page.url()).origin },
    ]);
    await page.goto(url);

    const row = page.locator(`[data-fixture-no="${mover.fixture_no}"]`);
    await row.getByTestId("run-sheet-edit-time").click();
    await row.getByTestId("fixture-court-select").selectOption(c2!.id);
    await row.getByRole("button", { name: UI.fr["schedule.save"]!, exact: true }).click();

    // The editor stays OPEN carrying an error — a refusal the organiser cannot
    // see is a silent data loss wearing a success's clothes. POSITIVE PAIR
    // FIRST: everything after this passes on a blank page otherwise.
    await expect(row.getByTestId("run-sheet-set-time-editor")).toBeVisible();
    const err = row.getByTestId("run-sheet-editor-error");
    await expect(err).toBeVisible();
    // WHAT it says, not merely that it is there. Reachability proves nothing.
    await expect(err).toHaveText(UI.fr["schedule.error.conflict"]!);
    // The three things it must NOT be, each one a live defect at some point:
    // the server's raw sentence, the English copy on a French console, and the
    // bare "Échec" the unmapped fallback would give.
    await expect(err).not.toHaveText(/blocking conflict/i);
    await expect(err).not.toHaveText(UI.en["schedule.error.conflict"]!);
    await expect(err).not.toHaveText(UI.fr["schedule.error.failed"]!);
    // And the write did not land.
    const after = await apiJson<{ court_id: string | null }>(
      request,
      `/api/v1/fixtures/${mover.id}`,
    );
    expect(after.data!.court_id).toBe(c1!.id);
  });
});

/** Record a plain result on a fixture via the events ledger. */
async function resultFixture(
  request: APIRequestContext,
  fixtureId: string,
  p1Score: number,
  p2Score: number,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score, p2Score },
  });
  if (res.status >= 400) {
    throw new Error(`resultFixture(${fixtureId}) → ${res.status} ${res.error?.message}`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
