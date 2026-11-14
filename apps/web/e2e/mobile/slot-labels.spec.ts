// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): TBD / feeder slot labels: the P6 fresh-org TBD knockout (org + public surface, in the org's locale) and the draw-list sibling-fed final.
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  expectNoHorizontalScroll,
  addEntrantsViaApi,
  divisionPath,
  loginUi,
  setOrgLocaleSql,
  openBracket,
} from "../helpers";
import { projectTag, dlDict } from "./_shared";

// Serial, kept from the original file: P6 setup and draw-list setup fill `p6*` / `dl*` module state their follow-on tests read, in order.
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// P6 (D4b task A) fix round 1 — a TBD fixture's slot label, rendered in a
// real browser, on an org surface AND a public one (the two gaps the review
// found: finding #2, public surfaces stuck on hardcoded English regardless
// of the org's own locale; the unit/regression suites already prove the
// resolver + dictionaries are correct in isolation, but P5's own
// stage-progression.spec.ts is request-only (no `page`) and never asserted
// on rendered text at all). Lives in mobile.spec.ts — not a new spec file —
// specifically so it inherits the seven-width viewport matrix; a new file
// would run desktop-only and silently skip 320/360/375/390/430/768/834.
// A brand-new logged-in user (own auto-provisioned org), never the file's
// shared `orgSlug`/`divisionId` above — this scenario needs to flip the
// ORG's own default_locale, which would otherwise leak into every other
// scenario in this file that reuses the same account.
// ---------------------------------------------------------------------------

let p6OrgSlug = "";
let p6CompSlug = "";
let p6DivSlug = "";
let p6DivisionId = "";

// Per-project identity (see `projectTag` above). The setup test below MUTATES
// (creates the org/comp/division/stages) and the public-surface test MUTATES
// too (setOrgLocaleSql flips the org's default_locale) — both need their own
// account per width project. The org-surface test is read-only but must log
// back into the SAME account as setup to see the division it created, so it
// reuses this identity rather than computing a distinct one.
const P6_FIX1_EMAIL = () => `delivered+p6-fix1-${TAG}-${projectTag()}@resend.dev`;

test("P6 setup: a fresh org with an up-front TBD knockout fixture (seeded, group stage never generated)", async ({
  page,
}) => {
  await loginUi(page, P6_FIX1_EMAIL());
  const org = await activeOrg(page);
  p6OrgSlug = org.slug;

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `P6 Fix1 ${TAG}`,
    visibility: "unlisted", // reachable on /live/... — default is private
  });
  expect(comp.status).toBeLessThan(300);
  p6CompSlug = comp.data!.slug;

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status).toBeLessThan(300);
  p6DivisionId = div.data!.id;
  p6DivSlug = div.data!.slug;

  await addEntrantsViaApi(page.request, p6DivisionId, ["Seed 1", "Seed 2", "Seed 3", "Seed 4"]);

  // Groups (2 pools of 2) feeding a knockout final via progression
  // (timing: "setup") — same shape as scripts/smoke.ts's
  // stageProgressionSuite() and P5's own stage-progression.spec.ts. The KO
  // fixture is generated BEFORE the group stage even has fixtures (the
  // owner's "placeholders at setup time" ruling) — both slots stay TBD,
  // carrying real slot.winner_group labels.
  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${p6DivisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2, kind: "knockout", name: "KO", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const koGen = await apiJson<{ created: number; fixtures: { home_entrant_id: string | null }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(koGen.status).toBeLessThan(300);
  expect(koGen.data!.created).toBe(1);
  expect(koGen.data!.fixtures[0]!.home_entrant_id).toBeNull();
});

test("P6 org surface: the TBD fixture renders its resolved slot label, in the switcher's locale (finding #2/#5)", async ({
  page,
}) => {
  test.skip(p6DivisionId === "", "P6 setup test did not run/complete");
  await loginUi(page, P6_FIX1_EMAIL()); // same user/org as setup — a fresh page has no session of its own
  // Default locale first — proves the whole pipeline (usecase -> V360/V362
  // columns -> API -> stages-panel.tsx) is actually live, not merely
  // unit-tested in isolation.
  await page.goto(await divisionPath(page.request, p6DivisionId, "?tab=fixtures"));
  await expect(page.getByText("Winner of Group A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Winner of Group B", { exact: false }).first()).toBeVisible();
  // No raw "TBD" (the pre-P6 behaviour on the surfaces this task touched)
  // and no leaked slot.* key or unfilled {placeholder}.
  await expect(page.getByText(/^TBD$/)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("slot.winner_group");
  await expectNoHorizontalScroll(page);

  // The explicit switcher cookie (resolveLocale()'s #1 priority, ahead of
  // even a signed-in user's own users.locale) — proves this is really a
  // LOOKUP, not a coincidentally-English hardcoded string.
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "seazn_locale", value: "es", url: origin }]);
  await page.reload({ waitUntil: "load" });
  await expect(page.getByText("Ganador del Grupo A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Ganador del Grupo B", { exact: false }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Winner of Group");
  await expectNoHorizontalScroll(page);
});

test("P6 public surface: a visitor sees the resolved slot label in the ORG's own default_locale, not English (finding #2 — the review's core defect)", async ({
  page,
}) => {
  test.skip(p6DivisionId === "", "P6 setup test did not run/complete");
  await loginUi(page, P6_FIX1_EMAIL()); // same user/org as setup — activeOrg() below needs THIS org, not the default shared session's
  const org = await activeOrg(page);
  // The org's OWN locale — a public/embed page has no per-viewer request
  // scope to read a switcher cookie from (ISR), so THIS is the only lever a
  // visitor's browser has no control over and the review's finding #2 was
  // about: bracket.tsx/schedule.tsx/og-model.ts/slideshow-data.ts (+ the
  // fixture detail page, same pattern) previously ignored it completely.
  await setOrgLocaleSql(org.id, "es");

  await page.goto(`/live/${p6OrgSlug}/${p6CompSlug}/${p6DivSlug}`, { waitUntil: "load" });
  // Default tab is Schedule (Tabs labels=["Schedule","Standings","Entrants"]).
  await expect(page.getByText("Ganador del Grupo A", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Ganador del Grupo B", { exact: false }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Winner of Group");
  await expect(page.locator("body")).not.toContainText("slot.winner_group");
  await expectNoHorizontalScroll(page);
});

// ---------------------------------------------------------------------------
// The DRAW LIST names an unfilled knockout seat by its FEEDER (2026-09-21).
//
// The owner's report, off the live product: a division page's `?tab=fixtures`
// draw list showed a knockout whose quarter-finals read "Rank 1 vs Rank 8"
// but whose semi-final and final rows all read "TBD vs TBD — Awaiting draw",
// while the SCHEDULE showed the very same fixtures as "Winner of R1·1 vs
// Winner of R1·2". A defect in the gap between two individually-correct
// screens, which is exactly the class no single-surface test can see.
//
// The shape that reproduces it is a SETUP-timed progression bracket, and only
// that: `generateStageFixtures` (the plain path) stamps
// `slot.winner_match` into `*_slot_label`, so a plain knockout was never
// affected. `generateProgressionSetupFixtures` labels a synthetic seed ref
// and `bracket.slot.bye` and nothing else — deliberately, because
// `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed" for
// `timing: "setup"` stages — so a sibling-fed seat's stored label is NULL and
// the FEED EDGES are the only thing that knows. A league of 4 feeding a
// 4-qualifier knockout is the smallest bracket with a sibling-fed seat: two
// semis seeded from the league, then a final fed by both.
//
// Lives here rather than in a new spec file for the same reason the P6 block
// above does: a new file would run desktop-only and never see
// 320/360/375/390/430/768/834.
// ---------------------------------------------------------------------------

let dlDivisionId = "";
const DL_EMAIL = () => `delivered+drawfeed-${TAG}-${projectTag()}@resend.dev`;

const dlFeeder = (locale: "en" | "es", round: number, seq: number): string => {
  const d = dlDict(locale);
  return d["slot.winner_match"]!.replace(
    "{ext}",
    d["slot.match_ref"]!.replace("{round}", String(round)).replace("{seq}", String(seq)),
  );
};

test("draw list setup: a league feeding a 2-round knockout at timing:setup (sibling-fed final, no stored label)", async ({
  page,
}) => {
  await loginUi(page, DL_EMAIL());

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Draw List ${TAG}`,
    visibility: "unlisted",
  });
  expect(comp.status).toBeLessThan(300);

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status).toBeLessThan(300);
  const divisionId = div.data!.id;

  await addEntrantsViaApi(page.request, divisionId, ["Seed A", "Seed B", "Seed C", "Seed D"]);

  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2, kind: "knockout", name: "Cup", config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status).toBeLessThan(300);
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const gen = await apiJson<{ created: number; fixtures: { round_no: number; home_entrant_id: string | null }[] }>(
    page.request,
    `/api/v1/stages/${koId}/generate`,
    "POST",
  );
  expect(gen.status).toBeLessThan(300);
  // Two semis + a final, every seat empty: the bracket is drawn but unplayed.
  expect(gen.data!.created).toBe(3);
  expect(gen.data!.fixtures.filter((f) => f.round_no === 2).length).toBe(1);
  expect(gen.data!.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);

  dlDivisionId = divisionId;
});

test("draw list: the sibling-fed final reads 'Winner of R1·1 vs Winner of R1·2', not TBD", async ({ page }) => {
  test.skip(dlDivisionId === "", "draw list setup test did not run/complete");
  await loginUi(page, DL_EMAIL());
  await page.goto(await divisionPath(page.request, dlDivisionId, "?tab=fixtures"));

  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // The POSITIVE pair for every negative below: the seeded semis DID render
  // their own (stored) labels, so the sheet is populated and any absent
  // "Winner of" is a real absence rather than a blank page.
  await expect(sheet.getByText("Rank 1", { exact: false }).first()).toBeVisible();
  await expect(sheet.getByText("Rank 4", { exact: false }).first()).toBeVisible();

  // The fix: BOTH of the final's seats named by their feeder. Copy from the
  // dictionary, never typed here — see `dlFeeder`.
  const EN_R1_1 = dlFeeder("en", 1, 1);
  const EN_R1_2 = dlFeeder("en", 1, 2);
  const ES_R1_1 = dlFeeder("es", 1, 1);
  // The derivations are only worth asserting if they differ: an es leg that
  // silently equalled the en one would make the locale switch below vacuous.
  expect(ES_R1_1, "the es feeder sentence is identical to the en one").not.toBe(EN_R1_1);
  expect(EN_R1_2).not.toBe(EN_R1_1);
  await expect(sheet.getByText(EN_R1_1, { exact: false }).first()).toBeVisible();
  await expect(sheet.getByText(EN_R1_2, { exact: false }).first()).toBeVisible();
  // …and no seat left saying TBD, which is what four of these rows said.
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);
  await expect(sheet).not.toContainText("slot.winner_match");
  await expectNoHorizontalScroll(page);

  // THE PAIR, on ONE tab. The bracket TREE sits directly above this list and
  // is fed by the same `listDivisionFixtures` rows. Round 1 of this fix
  // taught only the list, which left the tree printing "TBD" immediately
  // above a row reading "Winner of R1·1" — adjacent panels contradicting each
  // other, which reads as broken rather than merely uninformative. Asserting
  // each surface on its own is what let them drift, so this asserts they
  // agree about the SAME match.
  // Match Day E1 item 3: the tree is no longer "directly above this list" - it opens INSIDE the knockout stage's card from its Bracket
  // button (header, or the phone sheet's row), closed on every load. The pair is the same one: both surfaces on one tab.
  const tree = await openBracket(page);
  await expect(tree).toBeVisible({ timeout: 20_000 });
  await expect(tree.getByText(EN_R1_1, { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(EN_R1_2, { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(/^TBD$/)).toHaveCount(0);
  // The tree's own positive pair: the seeded semis still read their stored
  // labels, so an absent "Winner of" above would be a real absence.
  await expect(tree.getByText("Rank 1", { exact: false }).first()).toBeVisible();

  // A LOOKUP, not a coincidentally-English literal — and the ORGANISER
  // vocabulary ("Ganador de R1·1"), never the public `knockout.feederWinner`
  // form. `slot.match_ref` is identical in every locale by design, so the
  // ref survives the switch while the sentence around it does not.
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "seazn_locale", value: "es", url: origin }]);
  await page.reload({ waitUntil: "load" });
  await openBracket(page); // a reload closes the card's tree again
  await expect(sheet.getByText(ES_R1_1, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(sheet).not.toContainText(EN_R1_1);
  // The tree localizes with it — both surfaces read the dictionary, neither
  // carries its own copy of the sentence.
  await expect(tree.getByText(ES_R1_1, { exact: false }).first()).toBeVisible();
  await expect(tree).not.toContainText(EN_R1_1);
  await expectNoHorizontalScroll(page);
});
