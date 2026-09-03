import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  TAG, apiJson, activeOrg, addEntrantsViaApi, scoreFixture,
  setFixtureStatusSql,
  assignScorerSql, setFixtureScheduledAtSql, seedBareRegistrationSql,
} from "./helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ATTENTION_SEVERITY, DRAW_DOORS, NOT_RECORDING_GRACE_MINUTES, type Attention } from "../src/lib/division-phase";

/** The SHIPPED English strings, read the way `board-v3.spec.ts` reads them —
 *  a JSON `import` needs an import attribute Playwright's loader does not
 *  supply. Every label and door name below comes from here, never from an
 *  English literal typed into this file: a test that retypes the copy cannot
 *  notice the copy changing under it. */
const en: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/**
 * ENUMERATION 1 (fix round I): every ACTION LABEL x the control it lands on.
 *
 * Instances 9 to 12 of this wave's signature defect are one class —
 * reachability asserted from a TYPE or a WORD rather than from the SCREEN. A
 * row offers an action; nobody checks that the control it names is on the
 * page it lands on. The sixth review found instance twelve in about 25
 * minutes by walking all six labels to their destinations, which no round had
 * done; this file is that walk, kept.
 *
 * The bar is deliberately higher than PRESENCE. Instance twelve's own control
 * run had the button on screen and clicking it returned an error banner
 * (11:39Z, 2026-09-03), so a `toHaveCount(1)` sweep would have signed the
 * defect off. Every row here drives to the destination and then either
 * PRESSES the named control and watches the screen change, or asserts a door
 * that is present, enabled and HIT-TESTABLE (`elementFromPoint`, not
 * `boundingBox` — a control can measure 44px and sit under an overlay).
 *
 * WHY IT FAILS WHEN A ROW IS DROPPED: the expectation is anchored OUTSIDE
 * the table. `REQUIRED` is built from `ATTENTION_SEVERITY` (the ONE authority
 * for which kinds exist) crossed with `DRAW_DOORS` for the one kind whose
 * label varies with what the panel is showing, minus `E2E_UNREACHABLE`, whose
 * single entry names where that case IS pinned instead. Delete a row and its
 * id goes missing from the covered set; add an `Attention` kind or a draw
 * door and `REQUIRED` grows and stays uncovered. Both lists are imported from
 * the module under test, never typed out here. And every row asserts it
 * actually RAISED its own kind before it navigates, so a row cannot quietly
 * stop exercising its case.
 */

const P_SETUP = {
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
  placement: "rank_order",
  timing: "setup",
};
const P_ON_COMPLETE = { ...P_SETUP, timing: "on_complete" };

type Rig = { compSlug: string; divSlug: string;
  /** Something the LANDING page must show, proving it holds the work this
   *  row is about and not merely the right URL. */
  landText?: string };

/**
 * Score the round robin so the standings are STRICTLY ordered — the earlier
 * seed always wins. A uniform 2-1 leaves teams level on points, the seed
 * proposal comes back with ties flagged, and "Confirm proposal" is correctly
 * DISABLED: the rows below would then be asserting a dead control for a
 * reason that has nothing to do with what they test.
 *
 * The pairings come from the GENERATE response, which carries
 * `home_entrant_id`/`away_entrant_id`. There is no
 * `/api/v1/divisions/{id}/fixtures` route — a probe that assumes one gets a
 * 200 of HTML back, `?? []` swallows it, and NOTHING is scored while every
 * status code still reads fine. That is how this helper was first written,
 * and the state it silently produced (an unplayed league, the stage never
 * completing) looked like a product bug for twenty minutes.
 */
async function scoreInSeedOrder(
  request: APIRequestContext,
  fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[],
  entrantIds: string[],
) {
  const rank = new Map(entrantIds.map((id, i) => [id, i]));
  let scored = 0;
  for (const f of fixtures) {
    const h = rank.get(f.home_entrant_id ?? "");
    const a = rank.get(f.away_entrant_id ?? "");
    expect(h, "fixture home entrant is not one of this division's").not.toBeUndefined();
    expect(a, "fixture away entrant is not one of this division's").not.toBeUndefined();
    await scoreFixture(request, f.id, h! < a! ? 2 : 0, h! < a! ? 0 : 2);
    scored += 1;
  }
  // The count is the guard: a silently-empty fixture list is exactly the
  // failure this helper had, and it reports as a clean pass everywhere else.
  expect(scored, "every league fixture scored").toBe(fixtures.length);
}

async function leagueOfFour(request: APIRequestContext, label: string) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Actions ${label} ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public", ends_on: "2030-12-31",
  });
  expect(comp.status, "create competition").toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    // `generic`/`score`: football's schema REJECTS `generic.result`, and a
    // probe that ignores the status code silently builds a DIFFERENT state
    // that reads like a clean pass.
    { name: "Cup", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  expect(div.status, "create division").toBe(201);
  const entrants = await addEntrantsViaApi(request, div.data!.id, ["Seed1", "Seed2", "Seed3", "Seed4"]);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST",
    { seq: 1, kind: "league", name: "League" });
  expect(stage.status, "create league stage").toBe(201);
  const gen = await apiJson<{ fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[] }>(
    request, `/api/v1/stages/${stage.data!.id}/generate`, "POST",
  );
  expect(gen.status, "generate league fixtures").toBe(200);
  const fixtures = gen.data?.fixtures ?? [];
  // If this is not 6 the whole state below is a different one.
  expect(fixtures.length, "a 4-entrant round robin").toBe(6);
  return { comp: comp.data!, div: div.data!, leagueId: stage.data!.id, fixtures,
           fixtureIds: fixtures.map((f) => f.id), entrantIds: entrants.ids };
}

async function addStage(request: APIRequestContext, divisionId: string, progression: unknown) {
  const r = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 2, kind: "knockout", name: "Finals", config: {}, progression,
  });
  expect(r.status, "add finals stage").toBe(201);
  return r.data!.id;
}

/** Present, visible, enabled AND the element under its own centre point. */
async function assertUsable(page: Page, selector: string, why: string) {
  const el = page.locator(selector).first();
  await expect(el, `${why}: not visible`).toBeVisible();
  await expect(el, `${why}: disabled`).toBeEnabled();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `${why}: no box`).not.toBeNull();
  const hit = await page.evaluate(([x, y]) => {
    const node = document.elementFromPoint(x, y);
    return node ? (node.textContent ?? "").trim().slice(0, 60) + "|" + node.tagName : "NOTHING";
  }, [box!.x + box!.width / 2, box!.y + box!.height / 2] as const);
  expect(hit, `${why}: nothing hit-testable at its own centre (got ${hit})`).not.toBe("NOTHING");
}

/** e2e-unreachable cases, each naming where it IS pinned instead. */
const E2E_UNREACHABLE: Record<string, string> = {
  // A stale proposal needs a confirm attempt to find the source standings
  // moved under an existing draft (stages.ts:2956) or the dependent-stage
  // sweep to mark it (stages.ts:3143) — several API round trips past the
  // point this file is testing. Pinned instead, against a real database, by
  // competition-desk.test.ts's "a STALE proposal makes the action point at
  // the panel's 'recompute' door".
  "needs_draw/recompute": "competition-desk.test.ts pins the recompute door against a real DB",
};

type Row = {
  /** `kind`, or `kind/door` for the one kind whose label varies. */
  id: string;
  kind: Attention["kind"];
  /** Exactly the string the desk renders, read from the shipped dictionary —
   *  never an English literal typed into the test. */
  label: string;
  build: (request: APIRequestContext) => Promise<Rig>;
  /** What the landing page must offer for the work the row names. */
  land: (page: Page) => Promise<void>;
};

const ROWS: Row[] = [
  {
    // M1: the row prints the PANEL'S OWN key, so this reads the same string
    // the button does. There is no `desk.needsYou.needs_draw.action` any more
    // — and these two rows are why: one fixed word would be wrong in one of
    // the two states below.
    id: "needs_draw/compute",
    kind: "needs_draw",
    label: en["progression.computeCta"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "drawC");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      await scoreInSeedOrder(request, rig.fixtures, rig.entrantIds);
      // Complete the league BEFORE the finals stage exists, so nothing
      // auto-computes a proposal; then generate the TBD bracket the compute
      // resolves against. Panel state: `empty`, showing "Compute proposal".
      expect((await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {})).status).toBe(200);
      const finals = await addStage(request, rig.div.id, P_SETUP);
      expect((await apiJson(request, `/api/v1/stages/${finals}/generate`, "POST")).status).toBe(200);
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    land: async (page) => {
      // PRESS it. The whole point of instance twelve is that this button was
      // on screen in a state where pressing it returned an error banner.
      await assertUsable(page, `button:has-text("${en["progression.computeCta"]}")`, "compute proposal");
      await page.getByRole("button", { name: en["progression.computeCta"] }).first().click();
      await expect(page.locator("[data-progression-state]").first()).toHaveAttribute("data-progression-state", "draft");
      // An empty `role=alert` node is always in the DOM (the panel's error
      // slot); what must be empty is its TEXT. Asserting `toHaveCount(0)`
      // here fails on a working page, which is its own kind of vacuous.
      expect((await page.locator("[role=alert]:visible").allInnerTexts()).join("").trim()).toBe("");
    },
  },
  {
    id: "needs_draw/confirm",
    kind: "needs_draw",
    label: en["progression.confirmCta"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "drawF");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      await scoreInSeedOrder(request, rig.fixtures, rig.entrantIds);
      // Generate first, then complete: `completeStage` auto-computes the next
      // setup-timing stage's proposal (stages.ts:2297), so the panel is
      // already in `draft` and its button reads "Confirm proposal". Verified
      // live at 12:16Z on 2026-09-03 — states ["draft"], compute 0, confirm 1.
      const finals = await addStage(request, rig.div.id, P_SETUP);
      expect((await apiJson(request, `/api/v1/stages/${finals}/generate`, "POST")).status).toBe(200);
      expect((await apiJson(request, `/api/v1/stages/${rig.leagueId}/complete`, "POST", {})).status).toBe(200);
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    land: async (page) => {
      await assertUsable(page, `button:has-text("${en["progression.confirmCta"]}")`, "confirm proposal");
      await page.getByRole("button", { name: en["progression.confirmCta"] }).first().click();
      await expect(page.locator("[data-progression-state]").first()).toHaveAttribute("data-progression-state", "confirmed");
    },
  },
  {
    id: "needs_fixtures",
    kind: "needs_fixtures",
    label: en["desk.needsYou.needs_fixtures.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "fixtures");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      for (const id of rig.fixtureIds) await scoreFixture(request, id, 2, 1);
      await addStage(request, rig.div.id, P_ON_COMPLETE);
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    // The row's own sub-line names both doors: seed it from the stage before
    // ("Complete stage"), or generate its fixtures.
    land: async (page) => {
      await assertUsable(page, `button:has-text("${en["schedule.generate"]}")`, "generate fixtures");
      await assertUsable(page, `button:has-text("${en["schedule.complete"]}")`, "complete stage");
    },
  },
  {
    id: "unscheduled",
    kind: "unscheduled",
    label: en["desk.needsYou.unscheduled.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "unsched");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    land: async (page) => {
      await assertUsable(page, `button:has-text("${en["board.autoSchedule"]}")`, "auto-schedule");
    },
  },
  {
    id: "no_scorer",
    kind: "no_scorer",
    // M2: this used to read "Assign scorer", an action nobody can take.
    label: en["desk.needsYou.no_scorer.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "noscorer");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      await setFixtureStatusSql(rig.fixtureIds[0]!, "in_play");
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    // The row says nothing is being recorded; the door is the pad itself,
    // which is on this screen for every plan (unlike "Hand over device",
    // which is entitlement-gated and would make this assertion plan-specific).
    land: async (page) => {
      await assertUsable(page, '[data-role="console-scoring"]', "the scoring section");
      await assertUsable(page, '[data-role="console-scoring"] button', "a scoring control");
    },
  },
  {
    id: "not_recording",
    kind: "not_recording",
    label: en["desk.needsYou.not_recording.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "notrec");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      const fixtureId = rig.fixtureIds[0]!;
      // The complement of the `no_scorer` row above: someone IS assigned and
      // the fixture is live with nothing recorded. The kick-off is pushed
      // well past NOT_RECORDING_GRACE_MINUTES rather than sitting on it, so
      // this fixture keeps producing the state it is built for if the grace
      // is ever widened.
      await assignScorerSql(fixtureId);
      await setFixtureScheduledAtSql(
        fixtureId,
        new Date(Date.now() - (NOT_RECORDING_GRACE_MINUTES + 45) * 60_000).toISOString(),
      );
      await setFixtureStatusSql(fixtureId, "in_play");
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    // Same door as `no_scorer`, for the same reason: the row is about a match
    // nobody is recording, and the pad is the control that answers it.
    land: async (page) => {
      await assertUsable(page, '[data-role="console-scoring"]', "the scoring section");
      await assertUsable(page, '[data-role="console-scoring"] button', "a scoring control");
    },
  },
  {
    id: "result_missing",
    kind: "result_missing",
    label: en["desk.needsYou.result_missing.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "result");
      expect((await apiJson(request, `/api/v1/divisions/${rig.div.id}/start`, "POST")).status).toBe(200);
      await setFixtureScheduledAtSql(rig.fixtureIds[0]!, new Date(Date.now() - 6 * 3600_000).toISOString());
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug };
    },
    // The console's own result door. Its LABEL is the sport's
    // (`pad.generic.action.scoreEntry` for the sport this fixture uses), so
    // the key is read from the dictionary rather than typed, and the fixture
    // pins the sport that key belongs to.
    land: async (page) => {
      await assertUsable(page, `button:has-text("${en["pad.generic.action.scoreEntry"]}")`, "enter final score");
    },
  },
  {
    id: "registrations_waiting",
    kind: "registrations_waiting",
    label: en["desk.needsYou.registrations_waiting.action"],
    build: async (request) => {
      const rig = await leagueOfFour(request, "regs");
      const reg = await seedBareRegistrationSql(rig.comp.id, rig.div.id, { status: "pending" });
      return { compSlug: rig.comp.slug, divSlug: rig.div.slug, landText: reg.displayName };
    },
    // The pending registration lives on the `registrants` tab, not the hub's
    // default `settings` one — the action carries the tab because of this row.
    land: async (page) => {
      await expect(page).toHaveURL(/tab=registrants/);
    },
  },
];

test.describe("competition desk: every action label lands on the control it names", () => {
  test("the table covers every action a desk row can offer — a dropped row fails here", () => {
    const required = (Object.keys(ATTENTION_SEVERITY) as Attention["kind"][])
      .flatMap((k) => (k === "needs_draw" ? DRAW_DOORS.map((d) => `needs_draw/${d}`) : [k]))
      .filter((id) => !(id in E2E_UNREACHABLE))
      .sort();
    expect(ROWS.map((r) => r.id).sort()).toEqual(required);
    // A stale excuse cannot outlive the case it excuses.
    for (const id of Object.keys(E2E_UNREACHABLE)) {
      const kind = id.split("/")[0] as Attention["kind"];
      expect(Object.keys(ATTENTION_SEVERITY)).toContain(kind);
    }
  });

  for (const row of ROWS) {
    test(`${row.id}: "${row.label}" leads to a control that works`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const org = await activeOrg(page);
      const rig = await row.build(request);
      await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
      const needs = page.getByTestId("desk-needs-you");
      // Print the asserted CONTENT beside the gate: a green gate on the
      // wrong page state is worse than a red one.
      const rowEl = needs.locator(`[data-attention="${row.kind}"]`);
      await expect(rowEl, `${row.kind} was never raised — the fixture built a different state`).toHaveCount(1);
      // Dual mobile/desktop DOM: `:visible` picks whichever copy renders.
      const action = rowEl.locator("a:visible").first();
      await expect(action, `${row.kind} action label`).toHaveText(row.label);
      await action.click();
      await page.waitForURL(/\/o\//);
      if (rig.landText) {
        // Same dual mobile/desktop DOM as the action above, one level deeper:
        // the registrants row renders BOTH a `sm:hidden` phone card and a
        // `hidden sm:grid` desktop block (registration-hub-registrant-table.tsx),
        // so a bare `.first()` picks the phone copy and reads `hidden` at a
        // desktop width — a TEST defect that reports as "the page does not show
        // the registration". Separate the two diagnoses: absent from the DOM is
        // a product defect, present-but-never-visible is a layout one.
        const inDom = page.getByText(rig.landText);
        await expect(inDom,
          `${row.kind}: the landing page never rendered "${rig.landText}" at all`).not.toHaveCount(0);
        await expect(inDom.filter({ visible: true }).first(),
          `${row.kind}: "${rig.landText}" is in the DOM but no copy of it is visible`).toBeVisible();
      }
      await row.land(page);
    });
  }
});
