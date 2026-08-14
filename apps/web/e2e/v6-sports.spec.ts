import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  TAG,
  fixturePath,
} from "./helpers";

// design/v6 (PROMPT-48..50): tennis on the nested kernel, ice/field hockey on
// the period kernel — pads, phase machine, suspensions/strength, shootouts,
// and the public surfaces (scorebug chip, goals-by-period, discipline).
//
// S13/#422 W11 cutover — the two tennis tests below used to drive the
// deleted v1 pad, which rendered a per-player button carrying that player's
// own running score inline. v2's tennis skin (skins/tennis-skin.tsx) has no
// such button: the plain `tennis.point` action is a one-tap Home/Away pair,
// and the score lives in the pad's own header fields. Re-anchored onto the
// same `[data-testid="score-pad"]`/Home-Away/header-field idioms
// scorepad-skins.spec.ts's own tennis test already established (see `pad()`/
// `ledger()` below, mirrored from that file).

/** The pad's own scoring surface (fixture-console.tsx), scoped so a
 *  page-wide text match can never satisfy an assertion the skin was
 *  supposed to. Mirrors scorepad-skins.spec.ts's own `pad()` exactly. */
function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
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
    { name: opts.sport, sport_key: opts.sport, variant_key: opts.variant, config: {}, eligibility: [] },
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
  // tapping the pad's Home button scores for Rune throughout this test.
  const [rune, sasha] = entrantIds as [string, string];
  await sendEvent(request, fixtureId, "core.start", {});

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  // v2's tennis skin has no per-player button — the plain `tennis.point`
  // action is a one-tap Home/Away pair, and the running score lives in the
  // header's "Points" field (scorepad-skins.spec.ts's own tennis test is the
  // worked example this mirrors). One tap per point; the header speaks 15
  // then 30.
  const homeBtn = scorePad.getByRole("button", { name: "Home", exact: true });
  const pointsField = scorePad.getByText("Points", { exact: true }).locator("..");
  await expect(homeBtn).toBeVisible({ timeout: 20_000 });
  await homeBtn.click();
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "tennis.point").length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(pointsField).toContainText("15–0");
  // usePadPipeline's double-submit guard swallows an identical payload
  // within DOUBLE_SUBMIT_WINDOW_MS (600ms) of the last ACCEPTED one, and the
  // ledger-count poll above can resolve well inside that window on a fast
  // local server — so the second identical tap needs its own clearance
  // rather than racing straight in behind the first.
  await page.waitForTimeout(700);
  await homeBtn.click();
  await expect
    .poll(
      async () => (await ledger(request, fixtureId)).filter((e) => e.type === "tennis.point").length,
      { timeout: 20_000 },
    )
    .toBe(2);
  await expect(pointsField).toContainText("30–0");

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
  // The header's amber "TIEBREAK" badge only exists while genuinely in one
  // (tennis-skin.tsx's own header comment) — no hyphen in the dictionary
  // copy ("Tiebreak"), unlike the v1 pad's own wording.
  await expect(page.getByText(/tiebreak/i).first()).toBeVisible({ timeout: 20_000 });
  for (let i = 0; i < 7; i++) await sendEvent(request, fixtureId, "tennis.point", { by: rune });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  // Set strip shows the 7–6(0) form — this headline text is the engine's own
  // (summary().headline), rendered both by the console's own header and
  // inside the pad, unchanged from v1.
  await expect(page.getByText("7–6(0)").first()).toBeVisible({ timeout: 20_000 });

  // Undo restores the live point: score one, undo, the tally is unchanged.
  // fixture-console.tsx's "Undo last" reads its OWN `events` state, which
  // only refreshes via that component's own writes/resync — never via the
  // pad's separate `usePadPipeline` — so (the same "API-side events don't
  // stream into the console — reload to pick them up" rule this file's own
  // icehockey test already relies on) it needs a reload before it will
  // target the point just scored rather than a stale earlier one.
  await expect(homeBtn).toBeVisible({ timeout: 20_000 });
  await homeBtn.click();
  await expect(pointsField).toContainText("15–0", { timeout: 20_000 });
  await page.reload();
  await expect(scorePad).toBeVisible({ timeout: 20_000 });
  await expect(pointsField).toContainText("15–0", { timeout: 20_000 });
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(pointsField).toContainText("0–0", { timeout: 20_000 });
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
  await page.goto(await fixturePath(page.request, fixtureId));
  const scorePad = pad(page);
  await expect(scorePad).toBeVisible({ timeout: 20_000 });

  // v2's tennis skin exposes exactly one "Set score" tile for a totals
  // entry — the closest analogue to v1's "Set totals". The engine
  // (packages/engine/src/sports/nested/kernel.ts's `nestedPadSpec`) also
  // declares a SEPARATE "Set score (tie-break)" action carrying
  // `tb.home`/`tb.away`, but it shares the same event type
  // (`tennis.set_summary`) as the plain one, and tennis-skin.tsx's
  // type-deduped rendering (`dedupeTypes`/`actionByType`) only ever draws
  // the FIRST of two same-typed actions — so the tie-break fields are not
  // reachable from any tile today (confirmed live: the pad renders exactly
  // one "Set score" button, with only Home/Away game fields, in every
  // state). Entering games alone for a 7–6 set through this — the only
  // reachable totals-entry surface — is exactly what this test proves the
  // engine refuses.
  await scorePad.getByRole("button", { name: "Set score", exact: true }).click();
  await scorePad.getByLabel("Home", { exact: true }).fill("7");
  await scorePad.getByLabel("Away", { exact: true }).fill("6");
  await scorePad.locator('[data-role="confirm"]').click();
  await expect(scorePad.getByText(/isn't valid for this match/i)).toBeVisible({ timeout: 20_000 });
  const afterRefusal = await ledger(request, fixtureId);
  expect(afterRefusal.some((e) => e.type === "tennis.set_summary")).toBe(false);

  // With tie-break points supplied, the SAME 7–6 totals entry succeeds —
  // proving the requirement is real rather than merely unenforced by a form
  // that never asks for it. Sent directly (the "Set score (tie-break)" tile
  // that would carry `tb` is unreachable in the UI today, per the comment
  // above) with exactly the fields that action declares, then read back off
  // the real console — this headline text is the engine's own
  // (summary().headline), unchanged from v1.
  await sendEvent(request, fixtureId, "tennis.set_summary", { home: 7, away: 6, tb: { home: 7, away: 5 } });
  await page.reload();
  await expect(page.getByText("1 — 0 · 7–6(5)").first()).toBeVisible({ timeout: 20_000 });
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

  // Penalty flow on the pad: Kings minor → 5v4.
  const kingsPad = page.locator("div.rounded-xl", { hasText: "Kings" }).last();
  await kingsPad.getByRole("button", { name: /Penalty \/ card/ }).click({ timeout: 20_000 });
  await kingsPad.getByLabel("Class").selectOption("minor");
  await kingsPad.getByRole("button", { name: /^Record$/ }).click();
  await expect(page.getByText("5v4").first()).toBeVisible({ timeout: 20_000 });

  // Second minor → 5v3; releasing one → back to 5v4. API-side events don't
  // stream into the console — reload to pick them up.
  await sendEvent(request, fixtureId, "icehockey.suspension.start", { by: kings, class: "minor" });
  await page.reload();
  await expect(page.getByText("5v3").first()).toBeVisible({ timeout: 20_000 });
  // A click straight after reload can land pre-hydration — retry until the
  // release actually takes (same pattern as the repo's re-fill loops).
  await expect(async () => {
    await page.getByRole("button", { name: /Release/ }).first().click();
    await expect(page.getByText("5v4").first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // Quick goal + period advances into sudden-death OT; the OT goal ends it.
  const bearsPad = page.locator("div.rounded-xl", { hasText: "Bears" }).first();
  await bearsPad.getByRole("button", { name: "Goal", exact: true }).click();
  await sendEvent(request, fixtureId, "icehockey.goal", { by: kings });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P2" });
  await sendEvent(request, fixtureId, "icehockey.period.advance", { to: "P3" });
  await page.reload();
  await expect(page.getByRole("button", { name: /End P3/ })).toBeVisible({ timeout: 20_000 });

  // axe on the pad region (PROMPT-50): goal / penalty / release controls are
  // labelled and operable. Scoped to the pad — the wider console carries
  // pre-existing contrast debt outside this wave.
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
  await expect(page.getByText(/Shootout — record each attempt/)).toBeVisible({ timeout: 20_000 });

  // First attempt by Aces; the recorder then expects Blades (Aces disabled).
  const scored = (team: string) =>
    page
      .locator("span", { hasText: `${team}:` })
      .getByRole("button", { name: /scored/i });
  await scored("Aces").click();
  await expect(scored("Aces")).toBeDisabled({ timeout: 20_000 });
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
  // Team entrants with real persons so the pad's person picker can select
  // the carded player (escalation hint keys off the person).
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `FIH ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "hockey", sport_key: "hockey", variant_key: "fih-outdoor", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const p1 = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: `Card Magnet ${TAG}`,
    consent: {},
  });
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Falcons", seed: 1 },
      {
        kind: "team",
        display_name: "Herons",
        seed: 2,
        members: [{ person_id: p1.data!.id, is_captain: false, roles: [] }],
      },
    ],
  );
  const [falcons, herons] = entrants.data!.map((e) => e.id) as [string, string];
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await sendEvent(request, fixtureId, "core.start", {});

  // Green card on the named Heron: the team plays short — 11v10.
  await sendEvent(request, fixtureId, "hockey.suspension.start", {
    by: herons,
    person: p1.data!.id,
    class: "green",
  });
  await page.goto(await fixturePath(page.request, fixtureId));
  await expect(page.getByText("11v10").first()).toBeVisible({ timeout: 20_000 });

  // Picking the same player for the next card surfaces the escalation hint.
  const heronsPad = page.locator("div.rounded-xl", { hasText: "Herons" }).last();
  await heronsPad.getByRole("button", { name: /Penalty \/ card/ }).click();
  await heronsPad.getByLabel(/Player/).selectOption(p1.data!.id);
  await expect(page.getByText(/this may escalate/)).toBeVisible({ timeout: 20_000 });

  // Quarters advance Q1→Q4; a level game at FT is a draw worth 1/1.
  await sendEvent(request, fixtureId, "hockey.suspension.end", { by: herons, class: "green" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: falcons, kind: "pc" });
  await sendEvent(request, fixtureId, "hockey.goal", { by: herons });
  await sendEvent(request, fixtureId, "hockey.period.advance", { to: "Q2" });
  await page.reload();
  await expect(page.getByRole("button", { name: /End Q2/ })).toBeVisible({ timeout: 20_000 });
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
  await expect(page.getByText("1 — 0 · P1")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("5v4")).toBeVisible();

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
