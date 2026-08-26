import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  fixturePath,
  setBoolEntitlementOverrideSql,
} from "./helpers";

// P11 (D6) batch score-event import — design doc §9 E2E paragraph
// (docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md).
// One call, two streams: a full core.start -> generic.result -> core.finalize
// stream against a real fixture (imported), and a stream naming an ext_key no
// fixture in this division carries (rejected, import.fixture_unknown). The
// report table renders both rows plus the totals line — that is the ONLY
// thing this spec proves; every per-code rejection, the dry-run/idempotency
// guarantees and the twin/careers/replay regressions are unit- and
// regression-tested already (Tasks 1-7), not re-proven here.
//
// `import.events` has no plan_entitlements row on any plan during rollout
// (design doc §2.4/R6) — without the per-org override below the page 404s
// (page.tsx's own notFound() gate) and the API 402s regardless of plan.
//
// Own competition/division, own entitlement grant (idempotent upsert) —
// parallel-safe (design doc §9 names this "parallel project, CI-live").

test("division import: paste two streams, get one imported row and one rejected row", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  await setBoolEntitlementOverrideSql(org.id, "import.events", true);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Event Import ${TAG}`,
    visibility: "private",
  });
  expect(comp.error, JSON.stringify(comp.error ?? {})).toBeUndefined();
  const compId = comp.data!.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Import",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.error, JSON.stringify(div.error ?? {})).toBeUndefined();
  const divisionId = div.data!.id;

  // Three entrants -> a 3-fixture round robin (carrom-pad.spec.ts:44 pins the
  // 2-entrant/1-fixture case; C(3,2) = 3 here). Only fixtureIds[0] is ever
  // named by the accepted stream, so the other two stay "scheduled" straight
  // through the import call — the "two unstarted fixtures" the brief calls
  // for holds both before AND after, proving the import touches only the
  // fixture it is told to.
  await addEntrantsViaApi(request, divisionId, ["Ana", "Ben", "Cara"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  expect(fixtureIds.length).toBeGreaterThanOrEqual(2);

  // Starts the DIVISION only. division-archive.spec.ts's own comment on this
  // exact call: "it appends no core.start to any fixture" — every fixture
  // here stays "scheduled", which is what the import route's unstarted-
  // fixture guard (event-import.ts step 3) requires.
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status).toBeLessThan(300);

  const fixtureId = fixtureIds[0]!;
  const importPath = await divisionPath(request, divisionId, "/import");
  const expectedLink = await fixturePath(request, fixtureId);
  const fixtureNoMatch = /\/f\/(\d+)$/.exec(expectedLink);
  if (!fixtureNoMatch) throw new Error(`fixturePath returned an unexpected shape: ${expectedLink}`);
  const fixtureNo = fixtureNoMatch[1];

  // Never set on any fixture here, so this can only resolve to zero matches
  // (event-import.ts's resolveFixture: `where division_id = ... and ext_key =
  // ...`) — TAG-suffixed only for log correlation, not for uniqueness.
  const unknownExtKey = `missing-${TAG}`;
  const payload = {
    import_id: `e2e-${TAG}`,
    streams: [
      {
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } },
          { type: "core.finalize", payload: {} },
        ],
      },
      {
        fixture: { ext_key: unknownExtKey },
        events: [{ type: "core.start", payload: {} }],
      },
    ],
  };

  await page.goto(importPath, { waitUntil: "load" });
  await page.locator("#event-import-paste").fill(JSON.stringify(payload));
  await page.getByRole("button", { name: "Import" }).click();

  // Totals row (eventImport.totals.summary) — asserted as its own line, not
  // folded into the row checks below, so a totals/row-count drift is caught
  // even if a future row-content change happened to keep the two row checks
  // green. Exact string, "·" = U+00B7 (confirmed via `xxd` against the en
  // dictionary, not a lookalike character).
  await expect(page.getByText("1 imported · 0 skipped · 1 rejected")).toBeVisible({
    timeout: 20_000,
  });

  // Imported row — located by the linked fixture's `href`, an `="`-anchored
  // attribute assertion rather than a bare presence probe: a Next RSC payload
  // can serialise an omitted prop as the literal string "$undefined", so a
  // plain `[href]` existence check would pass whether or not the link ever
  // got a real href. `fixturePath` builds the exact route `routes.fixture`
  // (lib/routes.ts) resolves to, so a match here also proves page.tsx's
  // `fixtureNoById` really carried this fixture's ordinal through to the
  // client island.
  const importedRow = page.locator("tbody tr").filter({
    has: page.locator(`a[href="${expectedLink}"]`),
  });
  await expect(importedRow).toHaveCount(1);
  await expect(importedRow.getByText("imported", { exact: true })).toBeVisible();
  await expect(importedRow.getByText(`Match ${fixtureNo}`, { exact: true })).toBeVisible();
  // Events-appended column (3rd <td>: fixture, status, eventsAppended, outcome,
  // error) — 3 events (start/result/finalize), proving the row reports a real
  // write and not just a label that happens to read "imported".
  await expect(importedRow.locator("td").nth(2)).toHaveText("3");

  // Rejected row — an unresolved ext_key has no fixture ordinal to link to
  // (page.tsx's fixtureNoById has no entry for a string that was never a
  // fixture id), so ImportClient falls back to plain text (row.fixture as
  // given); this is a text anchor, not an attribute one, and is exactly what
  // proves the fallback path itself renders correctly.
  const rejectedRow = page.locator("tbody tr").filter({ hasText: unknownExtKey });
  await expect(rejectedRow).toHaveCount(1);
  await expect(rejectedRow.getByText("rejected", { exact: true })).toBeVisible();
  await expect(
    rejectedRow.getByText(
      "This fixture reference matched 0 fixtures in this division (expected exactly 1).",
    ),
  ).toBeVisible();
});
