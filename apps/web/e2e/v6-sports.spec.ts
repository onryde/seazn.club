import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
// `with { type: "json" }` is REQUIRED, not decoration: `apps/web` is
// "type": "module", so Playwright loads this through Node's ESM loader, which
// refuses a bare JSON import with `needs an import attribute of "type: json"`.
// The spec then collects NO TESTS AT ALL and the run reports "No tests found",
// which reads like a bad path filter rather than a broken import — see
// `e2e/price-kit.ts`'s own note, and `marketing-ai-demo.spec.ts`, which reads
// its dictionary with readFileSync for the same reason. Vitest bundles instead
// of using the loader, which is why the unit suites and tsc were both happy.
import enPublic from "../src/dictionaries/en/public.json" with { type: "json" };
import {
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  seedRosteredFixture,
  TAG,
  fixturePath,
} from "./helpers";

// design/v6 (PROMPT-48..50): tennis on the nested kernel, ice/field hockey on
// the period kernel — pads, phase machine, suspensions/strength, shootouts,
// and the public surfaces (scorebug chip, goals-by-period, discipline).
//
// S13/#422 W11 cutover — every test below used to drive a deleted v1 pad:
// tennis's per-player button carrying that player's own running score
// inline, and the period pad's (hockey/icehockey) per-team `div.rounded-xl`
// cards with a "Penalty / card" button and a dedicated shootout recorder.
// v2's skins (skins/tennis-skin.tsx, skins/period-skin.tsx) render neither —
// tennis's plain `tennis.point` action is a one-tap Home/Away pair scored in
// the pad's own header fields, and the period skin is ONE pad whose actions
// (goal/card/release/shootout attempt/advance) are all the SAME generic
// ActionForm every sport uses. Re-anchored onto the same
// `[data-testid="score-pad"]`/header-field/`data-role="confirm"` idioms
// scorepad-skins.spec.ts's own tennis and period-skin tests already
// established (see `pad()`/`ledger()` below, mirrored from that file).
//
// Two v1 affordances turned out to have no v2 equivalent ANYWHERE in the
// product, not merely a relocated one — confirmed live and reported inline
// at each site: the organiser console never renders the "5v4"/"11v10"
// team-short strength chip (only the public/slideshow scorebug does), and
// the hockey "this may escalate" discipline hint has no render path left at
// all (the engine still computes `summary.detail.escalate`; nothing reads
// it). Both are proved instead against the engine's own computed value —
// the same field the surfaces that DO render them would read.

/** The pad's own scoring surface (fixture-console.tsx), scoped so a
 *  page-wide text match can never satisfy an assertion the skin was
 *  supposed to. Mirrors scorepad-skins.spec.ts's own `pad()` exactly. */
function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

/**
 * R4/tennis cutover — v3 tapModel S: the scoreboard halves ARE the point
 * buttons (v3/skins/tennis.tsx); there is no separate "Home"/"Away" action
 * button the way v2's plain `tennis.point` action rendered one. Indexes the
 * halves grid positionally, home first (scorebug.tsx's own render order),
 * duplicated locally rather than imported since this file keeps every
 * locator helper self-contained (its own `pad()` above is the same choice).
 *
 * Scoped to `<button>` specifically, not a wildcard — load-bearing (found by
 * running this file): a half renders a `<button>` only once LIVE at band>=3;
 * before that it is a plain, click-inert `<div>` at the same grid position.
 * `sendEvent(..., "core.start", {})` above confirms the SERVER folded it;
 * the CLIENT's own re-render is a separate, later event a wildcard locator
 * cannot see coming — it would happily click the still-present `<div>` and
 * dispatch nothing. Scoping to `button` makes this locator match NOTHING
 * until the client's re-render actually swaps the `<div>` for a `<button>`,
 * so Playwright's ordinary actionability wait closes the race — the same
 * "does not exist until ready" property a tile gets for free and a
 * wildcard half-locator does not.
 */
function tennisHalf(page: Page, side: "home" | "away") {
  return pad(page).locator('[data-role="v3-scorebug"] .grid > button').nth(side === "home" ? 0 : 1);
}

async function makeDivision(
  request: APIRequestContext,
  opts: { comp: string; sport: string; variant: string; entrants: string[]; kind?: "individual" | "team"; visibility?: string },
): Promise<{ divisionId: string; fixtureId: string; stageId: string; entrantIds: string[]; compId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: opts.comp,
    visibility: opts.visibility ?? "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: opts.sport, sport_key: opts.sport, variant_key: opts.variant, config: {} },
  );
  const divisionId = div.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, opts.entrants, opts.kind ?? "individual");
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  return { divisionId, fixtureId: fixtureIds[0]!, stageId, entrantIds: ids, compId: comp.data!.id };
}

async function sendEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  // A pad click in the open page can land between our seq read and the
  // append — retry the optimistic-concurrency 409 with a fresh seq.
  for (let attempt = 0; ; attempt++) {
    const state = await apiJson<{ last_seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/state`,
    );
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type,
      payload,
    });
    if (res.status === 201) return;
    if (res.status === 409 && attempt < 3) continue;
    throw new Error(`event ${type} → ${res.status}`);
  }
}

/** The fixture's REAL, server-persisted ledger from seq 0. Mirrors
 *  scorepad-skins.spec.ts's own `ledger()` exactly. */
async function ledger(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

// R6 cutover — hockey/icehockey moved onto the v3 chassis (period-shared.ts).
// Same four chassis-generic helpers scorepad-skins.spec.ts's own R3/football
// conversion already established: a tile/sheet/dock is addressed by
// `data-tile-id`/`data-role`, never by accessible name (a tile's name
// concatenates two localised strings), and a strip item by its skin-declared
// id — the v3 equivalent of the v2 period skin's own `header-score`/
// `header-period` fields, which render for no sport on this chassis anymore.
// Duplicated here rather than imported, matching this file's own "every
// locator helper self-contained" rule (see `pad()`'s own header above).
function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function v3Sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}
function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}
function stripItem(page: Page, id: string) {
  return pad(page).locator(`[data-role="v3-scorebug"] [data-strip-item-id="${id}"]`);
}
async function sendHeldNow(page: Page): Promise<void> {
  await v3Dock(page).getByRole("button", { name: "Send now", exact: true }).click();
}

test("tennis: device-width pad speaks the score, banks a tie-break set, undo restores the point", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Tennis rally ${TAG}`,
    sport: "tennis",
    variant: "tour",
    entrants: ["Rune", "Sasha"],
  });
  // A 2-entrant knockout's first-seeded entrant is always the fixture's
  // HOME side (verified against the real API) — Rune is entrants[0], so
  // tapping the pad's home half scores for Rune throughout this test.
  const [rune, sasha] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  // R4/tennis cutover — v3 tapModel S: the scoreboard halves ARE the point
  // buttons (v3/skins/tennis.tsx), and each half renders its OWN running
  // score via `ScorebugHalf.big` — the v2-era one-tap "Home"/"Away" pair and
  // the header's combined "Points" field this test used to read are both
  // gone (scorepad-skins.spec.ts's own tennis test is the worked example
  // this mirrors). This fixture has no real lineup (`makeDivision`'s
  // `addEntrantsViaApi` mints display-name-only entrants), so each half's
  // WhoLine falls back to the literal side label rather than "Rune"/"Sasha"
  // — that only affects the who-line text, not the tap target or the score.
  // One tap per point; each half speaks 15 then 30.
  const homeHalf = tennisHalf(page, "home");
  const awayHalf = tennisHalf(page, "away");
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  await homeHalf.click();
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "tennis.point").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(homeHalf).toContainText("15");
  await expect(awayHalf).toContainText("0");
  // R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`): `DOUBLE_SUBMIT_WINDOW_MS`
  // is now 250ms (was 600ms), and a refused repeat is VISIBLE rather than
  // silent — no clearance is taken here any more; this is one of the
  // acceptance-test call sites for that fix.
  await homeHalf.click();
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "tennis.point").length,
      { timeout: 20_000 },
    )
    .toBe(2);
  await expect(homeHalf).toContainText("30");
  await expect(awayHalf).toContainText("0");

  // Drive to 6–6 via the ledger (games alternate), then the TB to 7–0.
  const game = async (by: string) => {
    for (let i = 0; i < 4; i++) await sendEvent(request, fixtureId, "tennis.point", { by });
  };
  // Rune sits at 30-0: two more points close game 1.
  await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  for (let i = 0; i < 5; i++) await game(sasha);
  for (let i = 0; i < 5; i++) await game(rune);
  await game(sasha); // 6–6 → tie-break
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // R4/tennis: v3's copy is "Tie-break" — WITH the hyphen (the v2 comment
  // this replaces noted the opposite for v1's own wording, which is no
  // longer true of v3's `pad.tennis.context.tiebreak`), rendered on the
  // scorebug's own context line (`buildContext`, v3/skins/tennis.tsx).
  await expect(pad(page).locator('[data-role="v3-scorebug"]')).toContainText(/tie-break/i, { timeout: 20_000 });
  for (let i = 0; i < 7; i++) await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // Set strip shows the 7–6(0) form — this headline text is the engine's own
  // (summary().headline), rendered by the HOST rather than the skin
  // (`data-role="v3-headline"`, pad-host.tsx), unchanged from v1/v2.
  await expect(pad(page).locator('[data-role="v3-headline"]')).toContainText("7–6(0)", { timeout: 20_000 });

  // Undo restores the live point: score one, undo, the tally is unchanged.
  // fixture-console.tsx's "Void last entry" reads its OWN `events` state, which
  // only refreshes via that component's own writes/resync — never via the
  // pad's separate `usePadPipeline` — so (the same "API-side events don't
  // stream into the console — reload to pick them up" rule this file's own
  // icehockey test already relies on) it needs a reload before it will
  // target the point just scored rather than a stale earlier one.
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  await homeHalf.click();
  await expect(homeHalf).toContainText("15", { timeout: 20_000 });
  await expect(awayHalf).toContainText("0", { timeout: 20_000 });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  await expect(homeHalf).toContainText("15", { timeout: 20_000 });
  // A click straight after reload can land pre-hydration — retry until the
  // undo actually takes (same pattern as this file's own icehockey Release
  // flow, and the repo's re-fill loops generally). Checked against the real
  // ledger, never the DOM, so a retry can only ever fire the click again
  // when NO void has landed yet — never a second, unintended void of
  // whatever event comes next once the first one actually took.
  await expect(async () => {
    const alreadyVoided = (await ledger(request, fixtureId)).some((e) => e.type === "core.void");
    if (!alreadyVoided) await page.getByRole("button", { name: /Void last entry/ }).click();
    await expect
      .poll(async () => (await ledger(request, fixtureId)).some((e) => e.type === "core.void"), { timeout: 3_000 })
      .toBe(true);
  }).toPass({ timeout: 20_000 });
  await expect(homeHalf).toContainText("0", { timeout: 20_000 });
  await expect(awayHalf).toContainText("0", { timeout: 20_000 });
});

test("tennis: console set-totals entry needs tie-break points for a 7–6 set", async ({
  page,
  request,
}) => {
  const { fixtureId } = await makeDivision(request, {
    comp: `Tennis totals ${TAG}`,
    sport: "tennis",
    variant: "tour",
    entrants: ["Mira", "Tess"],
  });
  await sendEvent(request, fixtureId, "core.start", {});

  // R4/tennis cutover — v3's "Set score" tile opens ONE guided-sheet wizard
  // (`setScoreSheet`, v3/skins/tennis.tsx), one step at a time, never the v2
  // ActionForm this test used to fill (several labeled fields at once, then
  // a single `[data-role="confirm"]`) and never the v2-era SECOND "Set score
  // (tie-break)" tile — v3 has exactly one Set-score tile, and its `tbHome`/
  // `tbAway` steps are `when`-gated on whether the ENTERED games are the
  // tie-break shape (`isTbShape`, tennis.tsx — mirrors the engine's own
  // strict-mode requirement, `kernel.ts:1081-1087`). So a bare `{home:7,
  // away:6}` is no longer constructible through the sheet at all: reaching
  // 7–6 as the games makes the wizard ASK for the tie-break score rather
  // than letting the scorer skip past it — the client-side half of what this
  // test used to prove with a server error message. The engine's own
  // refusal (the other half — a 7–6 with no tie-break score is still
  // genuinely invalid) is still real and is still proved here, directly
  // against the API, since the sheet can no longer construct that payload
  // to submit it through the UI.
  const state0 = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const bareRefusal = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state0.data!.last_seq,
    type: "tennis.set_summary",
    payload: { home: 7, away: 6 },
  });
  expect(
    bareRefusal.status,
    "a bare 7–6 with no tie-break score must still be refused by the engine",
  ).toBeGreaterThanOrEqual(400);
  const afterRefusal = await ledger(request, fixtureId);
  expect(afterRefusal.some((e) => e.type === "tennis.set_summary")).toBe(false);

  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  await scorePad.locator('[data-tile-id="setScore"]').click();
  const sheet = scorePad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "the Set score tile must open the skin's guided sheet").toBeVisible({ timeout: 10_000 });
  await sheet.getByLabel("Games — Home", { exact: true }).fill("7");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  await sheet.getByLabel("Games — Away", { exact: true }).fill("6");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

  // The tie-break steps are offered ONLY because 7–6 IS the tie-break shape
  // — proves the `when` gate actually fired rather than the wizard always
  // asking regardless of the games entered.
  await expect(
    sheet.getByLabel("Tie-break points — Home", { exact: true }),
    "a 7–6 games total must ask for the tie-break score before the sheet can complete",
  ).toBeVisible({ timeout: 10_000 });
  await sheet.getByLabel("Tie-break points — Home", { exact: true }).fill("7");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  await sheet.getByLabel("Tie-break points — Away", { exact: true }).fill("5");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

  // With tie-break points supplied, the SAME 7–6 totals entry succeeds —
  // proving the requirement is real rather than merely unenforced by a
  // wizard that never asks for it. This headline text is the engine's own
  // (summary().headline), unchanged from v1/v2.
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "tennis.set_summary").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.reload();
  await expect(pad(page).locator('[data-role="v3-headline"]')).toContainText("1 — 0 · 7–6(5)", { timeout: 20_000 });
});

test("icehockey: penalties drive the strength chip (5v4 → 5v3 → release), OT goal decides", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Ice pad ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Bears", "Kings"],
    kind: "team",
  });
  const [bears, kings] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  // R6 cutover — v2's per-team `div.rounded-xl` cards, and its later
  // ambiguous "Card" button (colliding with the fidelity band strip's own
  // band-1 button), are both gone: v3's band picker is the Recording chip's
  // sheet (W1 / Task 4), whose rows are `[data-band]` inside a dialog and are
  // never labelled "Card", and the suspension action is a per-side TILE
  // (`suspension-away`, Kings) addressed by `data-tile-id`, never by
  // accessible name.
  //
  // `makeDivision`'s entrants carry NO roster/lineup at all
  // (`addEntrantsViaApi` posts only `{kind, display_name, seed}`) — unlike
  // scorepad-skins.spec.ts's own icehockey suspension test
  // (`seedRosteredFixture`, a real named roster). v3's guided sheet turned
  // the v2 form's OPTIONAL servedBy field into a MANDATORY wizard step once
  // band >= 2 (`suspensionSheet`, period-shared.ts), with no roster to
  // answer it from and no way to skip past it — its only controls once
  // stuck there are Back/Cancel, and Cancel abandons the whole suspension.
  // That is a genuine v3 gap for a roster-less fixture, reported rather
  // than patched here (apps/web/src is off limits for this task). Both
  // suspensions below go through the API instead — the SAME mechanism this
  // test already used for its second one — and the pad UI is exercised for
  // Release and Goal instead, neither of which needs a roster
  // (`releaseSheet`'s one step is a CHOICE over the box's own entries, and a
  // goal tile commits with no attribution required).
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: kings, class: "minor" });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // The "5v4"/"5v3" strength chip itself is NOT rendered anywhere on the
  // organiser console in v2 OR v3 (confirmed live: absent from the pad at
  // every fidelity band, and absent from the console's own chrome outside
  // the pad) — only the public/slideshow scorebug (components/public-site/
  // live-score.tsx) renders it, which the file's own "public fixture page"
  // test already covers. This test proves the SAME underlying fact the chip
  // would show — the engine's own computed `summary.detail.strength`
  // (server/public-site/discovery.ts reads this exact field for the public
  // chip).
  const strengthOf = async () =>
    (await apiJson<{ summary: { detail?: { strength?: string | null } } }>(request, `/api/v1/fixtures/${fixtureId}/state`))
      .data!.summary.detail!.strength;
  expect(await strengthOf()).toBe("5v4");
  // v2's organiser-visible proxy for the box, the "Running penalties" list
  // (`data-role="suspension-row"`, one row per active suspension), has no
  // v3 equivalent: `buildScorebug` (period-shared.ts) collapses the box
  // into ONE strip item showing only the SOONEST countdown (or a class
  // word, or "permanent") — there is no surface left that COUNTS concurrent
  // suspensions. Reported rather than papered over; `strengthOf()` above
  // and below is the authoritative proof this test already leaned on for
  // the underlying fact, unchanged by the conversion.
  await expect(stripItem(page, "box"), "the box must show the fresh suspension").toContainText("Minor", {
    timeout: 20_000,
  });

  // Second minor → 5v3; releasing one → back to 5v4. API-side events don't
  // stream into the console — reload to pick them up.
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: kings, class: "minor" });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  expect(await strengthOf()).toBe("5v3");
  await expect(stripItem(page, "box")).toContainText("Minor", { timeout: 20_000 });

  // Release one Kings minor via the pad. `releaseSheet`'s one (and only)
  // step lists the box's own entries as CHOICES — side/class/person, never
  // a roster picker — so it needs no lineup at all. Either releasable entry
  // is equivalent here: both are Kings minors with nobody attributed.
  await v3Tile(page, "release").click();
  const releaseSheet = v3Sheet(page);
  await expect(releaseSheet, "the Release tile must open the guided sheet").toBeVisible({ timeout: 10_000 });
  await releaseSheet.locator("[data-choice-option-id]").first().click();
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === "icehockey.suspension.end").length, {
      timeout: 20_000,
    })
    .toBe(1);
  expect(await strengthOf()).toBe("5v4");

  // Quick goal for Bears via the pad + period advances into sudden-death OT
  // (advancing straight from P3 to "FT" while tied is what enters it — there
  // is no separate "advance to OT" event; verified live, an explicit
  // `{to:"OT"}` from P3 is refused); the OT goal ends it.
  //
  // R6 — v3: the goal COMMITS ON THE TAP (period-shared.ts's own
  // `buildTiles`); this test never asserted a specific `kind` value (only
  // the ledger COUNT below), so a side-only tap is the faithful port — the
  // same shape scorepad-skins.spec.ts's own football "side-only goal" test
  // uses.
  await v3Tile(page, "goal-home").click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === "icehockey.goal").length, {
      timeout: 20_000,
    })
    .toBe(1);
  await sendEvent(request, fixtureId, "icehockey.goal", { by: kings });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P2" });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P3" });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // Readiness check that period-advance progress genuinely reached P3 — the
  // v1 "End P3" shortcut button is gone; v3's own period strip item is the
  // faithful equivalent of "ready to end P3".
  await expect(stripItem(page, "period")).toContainText("P3");

  // axe on the pad region (PROMPT-50): goal / release controls are labelled
  // and operable. Scoped to the pad — the wider console carries
  // pre-existing contrast debt outside this wave.
  //
  // R6 cutover — this scan now runs against the v3 chassis's own Scorebug/
  // TileGrid/DetailDock, not period-skin.tsx's v2 dark header (the DOM this
  // scan previously found red no longer renders for this sport at all: that
  // header, and the "period-skin-header" role it lived under, is gone).
  // Left exactly as strict as before (`serious`/`critical`, `wcag2a`/
  // `wcag2aa`) rather than re-scoped or weakened — RUN CLEAN against the v3
  // pad (confirmed by executing this test, not assumed): zero serious/
  // critical violations, unlike the v2 debt this comment used to record.
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="score-pad"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious).toEqual([]);

  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "FT" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: bears });
  const state = await apiJson<{ status: string; summary: { headline: string } }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(state.data!.status).toBe("decided");
  expect(state.data!.summary.headline).toContain("(OT)");
});

test("icehockey: GWS recorder alternates attempts and decides", async ({ page, request }) => {
  const { fixtureId, entrantIds } = await makeDivision(request, {
    comp: `Ice GWS ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Aces", "Blades"],
    kind: "team",
  });
  const [aces] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  for (const to of ["P2", "P3", "FT", "FT"]) {
    await sendEvent(request, fixtureId, "icehockey.period.advance", { to });
  }
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // R6 cutover — v1's dedicated per-team "scored" recorder and v2's generic
  // "GWS attempt" ActionForm are both gone: v3 gives the shoot-out attempt
  // its own per-side TILE and a one-step outcome sheet (`attemptSheet`,
  // period-shared.ts). `attempt-home`'s presence IS the readiness signal
  // that the fixture reached the shootout phase — the tile only renders
  // once `e.attempt` is offerable, and the engine's default opener for a
  // fresh shoot-out is the home side (Aces), which this test's own hardcoded
  // "Aces goes first" sequence below already assumed even under v2.
  const attemptHome = v3Tile(page, "attempt-home");
  await expect(attemptHome).toBeVisible({ timeout: 20_000 });

  // First attempt by Aces, scored, via the pad.
  await attemptHome.click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the attempt tile must open the outcome sheet").toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="scored"]').click();
  await sendHeldNow(page);
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "icehockey.shootout.attempt").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const first = (await ledger(request, fixtureId)).find((e) => e.type === "icehockey.shootout.attempt")!;
  expect(first.payload).toMatchObject({ by: aces, scored: true });

  // v1's UI disabled Aces's own button once it was Blades' turn; v2 has no
  // such per-team control to disable, so this proves the SAME underlying
  // claim ("the recorder alternates attempts") the way it actually is
  // enforced now — server-side, not by graying out a button: a second
  // consecutive Aces attempt is refused outright.
  const outOfTurn = await apiJson<unknown>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: (await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`)).data!.last_seq,
    type: "icehockey.shootout.attempt",
    payload: { by: aces, scored: true },
  });
  expect(outOfTurn.status).toBe(422);
  expect(outOfTurn.error?.message).toMatch(/alternate/i);

  // Drive the rest through the ledger: Blades miss ×3, Aces score ×2 more.
  const [, blades] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: aces, scored: true });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: aces, scored: true });
  await sendEvent(request, fixtureId, "icehockey.shootout.attempt", { by: blades, scored: false });
  const state = await apiJson<{ status: string; summary: { headline: string } }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(state.data!.status).toBe("decided");
  expect(state.data!.summary.headline).toContain("GWS 3–0");
});

test("hockey (FIH): quarters, team-short chip, escalation hint, draw stands in standings", async ({
  page,
  request,
}) => {
  // A REAL fixture-level lineup (not just a division-roster `members` entry)
  // so the discipline card's person picker resolves a real named chip rather
  // than degrading to a text field — period-skin.tsx's own header explains
  // the split (readSquads/live-folded state, falling back to ctx.lineups —
  // the kickoff sheet — via resolveSquads); confirmed live that entrant
  // `members` alone (no fixture lineup PUT) still degrades to text.
  const fx = await seedRosteredFixture(request, {
    label: `FIH ${TAG}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: [],
    away: [{ fullName: `Card Magnet ${TAG}` }],
  });
  const { fixtureId, homeEntrantId: falcons, awayEntrantId: herons } = fx;
  const offender = fx.personIds[`Card Magnet ${TAG}`]!;
  const stageId = (
    await apiJson<{ stage_id: string }>(request, `/api/v1/fixtures/${fixtureId}`)
  ).data!.stage_id;
  await sendEvent(request, fixtureId, "core.start", {});

  // Green card on the named Heron: the team plays short — 11v10.
  await sendEvent(request, fixtureId, "hockey.suspension.start", {
    by: herons,
    person: offender,
    class: "green",
  });
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  // The "11v10" team-short chip is NOT rendered anywhere on the organiser
  // console in v2 (confirmed live, same finding as the icehockey test above)
  // — only the public/slideshow scorebug renders it. Proved instead against
  // the engine's own computed value the chip would show
  // (`summary.detail.strength`, the same field server/public-site/
  // discovery.ts reads for the public one).
  const strengthOf = async () =>
    (await apiJson<{ summary: { detail?: { strength?: string | null } } }>(request, `/api/v1/fixtures/${fixtureId}/state`))
      .data!.summary.detail!.strength;
  expect(await strengthOf()).toBe("11v10");

  // R6 cutover — v2's ambiguous "Card" button and its generic form are
  // gone: v3's suspension is a per-side TILE (`suspension-away`, herons)
  // and a guided sheet (`suspensionSheet`, period-shared.ts). `servedBy` is
  // now a mandatory sheet step (band >= 2), separate from `person`, which
  // stays a Detail Dock chip — exactly the field the v2 form's own
  // duplicated "person"/"servedBy" attribution pair used to carry (this
  // test's own prior version explained why the offender's name rendered
  // twice there). This fixture has a real away-side roster
  // (`seedRosteredFixture`, one player), unlike the icehockey tests above
  // (`makeDivision`), so both steps resolve to the same real candidate
  // rather than hitting the roster-less dead end reported in this file's
  // icehockey strength-chip test.
  await v3Tile(page, "suspension-away").click();
  const sheet = v3Sheet(page);
  await expect(sheet, "the suspension tile must open the guided sheet").toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="green"]').click();
  await expect(
    sheet.locator('[data-choice-option-id="tripping"]'),
    "the reason step must follow the class step",
  ).toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="tripping"]').click();
  const minutesField = sheet.getByLabel("Minutes", { exact: true });
  await expect(minutesField, "the minutes step must follow the reason step").toBeVisible({ timeout: 10_000 });
  await minutesField.fill("2");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  const servedByCandidate = sheet.locator(`[data-candidate-id="${offender}"]`);
  await expect(servedByCandidate, "the servedBy step must offer the away side's own on-field roster").toBeVisible({
    timeout: 10_000,
  });
  await servedByCandidate.click();
  await expect(sheet, "the sheet must close once servedBy is answered").toHaveCount(0, { timeout: 20_000 });

  // Picking the SAME player for the Dock's own "person" chip:
  // `summary.detail.escalate` (period/kernel.ts's `escalationHints`,
  // hockey-only) already names them as at risk, from the FIRST card sent
  // above. Proved at the engine level, the same place this test proved it
  // before the cutover — the API check below is unaffected by whether this
  // in-progress tap has flushed yet, since it reads state committed by the
  // FIRST card alone.
  const dock = v3Dock(page);
  await expect(dock, "a suspension always opens the Detail Dock (buildDock's e.suspStart case)").toBeVisible({
    timeout: 10_000,
  });
  const offenderChip = dock.getByRole("button", { name: `Card Magnet ${TAG}`, exact: true });
  await expect(offenderChip, "the dock must offer the away side's own on-field roster as a person chip").toBeVisible();
  await offenderChip.click();
  const escalateBefore = (
    await apiJson<{ summary: { detail?: { escalate?: string[] } } }>(request, `/api/v1/fixtures/${fixtureId}/state`)
  ).data!.summary.detail!.escalate;
  expect(escalateBefore).toContain(offender);
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(request, fixtureId)).filter((e) => e.type === "hockey.suspension.start").length, {
      timeout: 20_000,
    })
    .toBe(2);
  const suspensions = (await ledger(request, fixtureId)).filter((e) => e.type === "hockey.suspension.start");
  expect(suspensions[1]!.payload).toMatchObject({ by: herons, class: "green", person: offender, servedBy: offender });
  const escalateAfter = (
    await apiJson<{ summary: { detail?: { escalate?: string[] } } }>(request, `/api/v1/fixtures/${fixtureId}/state`)
  ).data!.summary.detail!.escalate;
  expect(escalateAfter).toContain(offender);

  // Quarters advance Q1→Q4; a level game at FT is a draw worth 1/1.
  await sendEvent(request, fixtureId, "hockey.suspension.end", { by: herons, class: "green" });
  await sendEvent(request, fixtureId, "hockey.suspension.end", { by: herons, class: "green" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: falcons, kind: "pc" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: herons });
  await sendEvent(request, fixtureId, "hockey.period.advance", { to: "Q2" });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // Readiness check that period-advance progress genuinely reached Q2 — the
  // v1 "End Q2" shortcut button is gone; v3's own period strip item is the
  // faithful equivalent.
  await expect(stripItem(page, "period")).toContainText("Q2");
  for (const to of ["Q3", "Q4", "FT"]) {
    await sendEvent(request, fixtureId, "hockey.period.advance", { to });
  }
  const standings = await apiJson<{ rows: { entrantId: string; points: number; drawn: number }[] }>(
    request,
    `/api/v1/stages/${stageId}/standings`,
  );
  const rows = standings.data!.rows;
  expect(rows.find((r) => r.entrantId === falcons)?.points).toBe(1);
  expect(rows.find((r) => r.entrantId === herons)?.drawn).toBe(1);
});

test("public fixture page: phase + strength chip live, goals-by-period + discipline when decided", async ({
  page,
  request,
}) => {
  const { fixtureId, entrantIds, compId } = await makeDivision(request, {
    comp: `Ice public ${TAG}`,
    sport: "icehockey",
    variant: "iihf",
    entrants: ["Orcas", "Wolves"],
    kind: "team",
    visibility: "public",
  });
  const [orcas, wolves] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});
  await sendEvent(request, fixtureId, "icehockey.goal", { by: orcas });
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: wolves, class: "minor" });

  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string; divisions: { slug: string }[] }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const compSlug = comp.data!.slug;
  const divList = await apiJson<{ items?: { slug: string }[] } | { slug: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  const divisions = Array.isArray(divList.data)
    ? divList.data
    : (divList.data as { items?: { slug: string }[] }).items ?? [];
  const divSlug = divisions[0]!.slug;
  const publicPath = `/shared/${org.slug}/${compSlug}/${divSlug}/fixtures/${fixtureId}`;

  await page.goto(publicPath);
  // W1 replaced this page's bare scorebug with the match centre, so the
  // engine's own headline string ("1 — 0 · P1") is no longer painted anywhere:
  // the court card renders each side's score on its own row. The two FACTS
  // that headline carried are what matter, and both are asserted below —
  // they were briefly LOST in the swap (`suppressScorebug` hid their only
  // renderer and the new header carried neither), which is the regression
  // this test now guards on its own terms rather than by matching a format.
  await expect(page.getByTestId("mc-court-card")).toBeVisible({ timeout: 20_000 });
  // Both scores, on the card, as the card renders them.
  await expect(page.getByTestId("mc-score-0")).toHaveText("1");
  await expect(page.getByTestId("mc-score-1")).toHaveText("0");
  // The live PHASE — resolved to its term ("1st period"), not the raw "P1"
  // token the old headline showed. Read from the dictionary rather than typed
  // here, so re-wording `term.P1` moves this with it.
  await expect(page.getByTestId("mc-phase")).toHaveText(enPublic["term.P1"] as string);
  // The power-play STRENGTH chip — a number pair, verbatim.
  await expect(page.getByTestId("mc-strength")).toHaveText("5v4");

  // Decide it and check the period table + discipline list render.
  await sendEvent(request, fixtureId, "icehockey.suspension.end", { by: wolves, class: "minor" });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P2" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: wolves });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P3" });
  await sendEvent(request, fixtureId, "icehockey.goal", { by: orcas });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "FT" });
  await page.goto(publicPath);
  await expect(page.getByText("Goals by period")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Discipline")).toBeVisible();
  await expect(page.getByText("Minor")).toBeVisible();
});
