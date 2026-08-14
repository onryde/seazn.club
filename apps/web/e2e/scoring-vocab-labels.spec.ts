import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// S7 (#427) shipped ~166 engine-vocabulary label keys in four locales, but two
// of them could not reach a screen — the cricket pad's hard-coded WICKET_KINDS
// was missing Law 34's `hitballtwice`, and `describeEvent` had no `.sanction`
// branch, so a sanction's level fell through to the raw-payload dump and the
// activity feed read `level: default`. Fixed in e55e10b7 (tennis) and
// e55e10b7 + 366ef5a7 (cricket — the first pass made the option selectable
// but `wicketLabel` still rendered it unlocalized; caught in review). These
// two tests are the browser-level proof, which no unit test can give: they
// drive the real API, the real fold and the real fixture console.

type Gen = { fixtures: { id: string; fixture_no: number }[] };

/** Append an event, failing loudly with the engine's own refusal message. */
function sender(request: APIRequestContext, fixtureId: string) {
  return async (seq: number, type: string, payload: unknown): Promise<void> => {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type,
      payload,
    });
    expect(
      res.status,
      `${type}: ${res.error?.code ?? ""} ${res.error?.message ?? ""}`,
    ).toBe(201);
  };
}

test("cricket: the tenth dismissal is offered as words, not snake_case", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Vocab cricket ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {}, eligibility: [] },
  );
  const divId = div.data!.id;

  // Real persons: `CricketBall` names the striker, non-striker and bowler by
  // PersonId, and the dismissal names who is out.
  const person = async (name: string) =>
    (
      await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
        full_name: `${name} ${TAG}`,
        consent: { public_name: true },
      })
    ).data!.id;
  // Three batters, not two: a side is all out one wicket short of its batting
  // order, so a two-man order would close the innings on this very dismissal
  // and the pad would render "No open innings" instead of the ball form.
  const [striker, nonStriker, incoming, bowler] = await Promise.all([
    person("Striker"),
    person("Non-striker"),
    person("Number three"),
    person("Bowler"),
  ]);

  const ent = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divId}/entrants`, "POST", [
    {
      kind: "team",
      display_name: `Kings ${TAG}`,
      seed: 1,
      members: [{ person_id: striker }, { person_id: nonStriker }, { person_id: incoming }],
    },
    { kind: "team", display_name: `Queens ${TAG}`, seed: 2, members: [{ person_id: bowler }] },
  ]);
  const [batting, fielding] = (ent.data ?? []).map((e) => e.id);

  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await apiJson<Gen>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  const fx = gen.data!.fixtures[0]!;

  // The fold resolves the batting order from the fixture lineup, and refuses a
  // delivery with "batting order for … needs at least 2 players" without it.
  const lineup = async (entrantId: string, slots: unknown[]) => {
    const res = await apiJson(request, `/api/v1/fixtures/${fx.id}/lineups/${entrantId}`, "PUT", {
      slots,
    });
    expect(res.status, `lineup: ${res.error?.message ?? ""}`).toBe(200);
  };
  await lineup(batting, [
    { person_id: striker, slot: "starting", position_key: "BAT", order_no: 1, roles: [] },
    { person_id: nonStriker, slot: "starting", position_key: "BAT", order_no: 2, roles: [] },
    { person_id: incoming, slot: "starting", position_key: "BAT", order_no: 3, roles: [] },
  ]);
  await lineup(fielding, [
    { person_id: bowler, slot: "starting", position_key: "BOWL", order_no: 1, roles: [] },
  ]);

  const send = sender(request, fx.id);
  await send(0, "cricket.toss", { wonBy: batting, elected: "bat" });
  await send(1, "core.start", {});
  // Law 34 — hit the ball twice. Credited to no bowler, which is exactly why
  // the mode exists and why `bowlerCredited` is false.
  await send(2, "cricket.ball", {
    over: 0,
    ballInOver: 1,
    striker,
    nonStriker,
    bowler,
    runs: { bat: 0 },
    wicket: { kind: "hitballtwice", out: striker, bowlerCredited: false },
  });

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${fx.fixture_no}`);
  const pad = page.getByTestId("score-pad");
  await expect(pad).toBeVisible({ timeout: 30_000 });

  // S13/#422 W11 cutover — v1's per-ball "Wicket" <select> (aria-labelled
  // "Wicket") and its "Ball-by-ball"/"Over-by-over" mode switch are both
  // gone: the v2 cricket skin (cricket-skin.tsx's ThisOverGroup) scores
  // ball-by-ball unconditionally, with no mode to switch into, and offers
  // the ten WICKET_KINDS as a button LIST inside a collapsible "Wicket"
  // drawer rather than a <select>.
  //
  // The striker/non-striker pickers are NOT set explicitly here (measured,
  // not assumed): the server enforces that a ball's striker/non-striker
  // must match the ledger's own idea of who is at the crease
  // (INVALID_EVENT "striker/non-striker do not match the ledger") — after
  // the seeded dismissal above, that is the fold's OWN resolved pair
  // (Number three promoted in for the dismissed Striker, Non-striker
  // unchanged), which is exactly what these pickers already default to.
  // Forcing an arbitrary non-dismissed pair (e.g. nonStriker/incoming) is a
  // VALID pool member each, but not the ledger's actual pair, and 422s.
  const over = pad.locator('[data-role="cricket-this-over"]');
  const selects = over.locator("select");
  await expect(selects).toHaveCount(3);
  await expect(selects.nth(0)).not.toHaveValue("", { timeout: 20_000 });
  await expect(selects.nth(1)).not.toHaveValue("", { timeout: 20_000 });
  await expect(selects.nth(2)).not.toHaveValue("", { timeout: 20_000 });
  const dismissTarget = await selects.nth(0).inputValue();

  await over.getByRole("button", { name: "Wicket", exact: true }).click();

  // The dismissal picker is the one place `wicketLabel` renders. Before
  // e55e10b7 this button list offered nine of the engine's ten
  // CricketWicket.kind members and `hitballtwice` was unreachable from any UI.
  const hitTwice = over.getByRole("button", { name: "Hit the ball twice", exact: true });
  await expect(hitTwice).toBeVisible({ timeout: 10_000 });
  // The raw enum member never reaches the scorer.
  await expect(over).not.toContainText("hitballtwice");

  // Selectable, not just present — tapping it fires a real second
  // `cricket.ball` dismissal, and the LEDGER (never merely the screen) is
  // what must carry the engine's actual "hitballtwice" wire value. The
  // pre-seeded dismissal above is ALSO a "hitballtwice" ball, so polling on
  // kind alone would trivially match it before this tap even lands — poll
  // on COUNT (only true once the new one actually arrives) instead, then
  // read the newly-added second entry specifically.
  await hitTwice.click();
  const cricketBalls = async () => {
    const res = await apiJson<{ type: string; payload: { wicket?: { kind?: string; out?: string } } }[]>(
      request,
      `/api/v1/fixtures/${fx.id}/events?since_seq=0`,
    );
    return (res.data ?? []).filter((e) => e.type === "cricket.ball");
  };
  await expect.poll(async () => (await cricketBalls()).length, { timeout: 20_000 }).toBe(2);
  const balls = await cricketBalls();
  expect(balls[1]?.payload.wicket?.kind).toBe("hitballtwice");
  expect(balls[1]?.payload.wicket?.out).toBe(dismissTarget);
});

test("tennis: a sanction's level renders as words in the activity feed", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Vocab tennis ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Tour", sport_key: "tennis", variant_key: "tour", config: {}, eligibility: [] },
  );
  const divId = div.data!.id;
  const ent = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divId}/entrants`, "POST", [
    { kind: "individual", display_name: `Ana ${TAG}`, seed: 1 },
    { kind: "individual", display_name: `Bo ${TAG}`, seed: 2 },
  ]);
  const [ana] = (ent.data ?? []).map((e) => e.id);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await apiJson<Gen>(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divId}/start`, "POST");
  const fx = gen.data!.fixtures[0]!;

  const send = sender(request, fx.id);
  await send(0, "core.start", {});
  // The most severe ladder rung short of expulsion: the chair defaults the match.
  await send(1, "tennis.sanction", { by: ana, level: "default" });

  await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${fx.fixture_no}`);
  await expect(page.getByTestId("score-pad")).toBeVisible({ timeout: 30_000 });

  // Scope to the sanction's own ledger row — "Default" is a common word, and a
  // page-wide search would pass on unrelated chrome. Every row carries
  // `title="<type> <payload json>"`, which is the only stable per-event hook.
  const row = page.getByTitle(/^tennis\.sanction /);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("Default", { exact: true })).toBeVisible();
  await expect(row).toContainText(`Ana ${TAG}`);
  // Before e55e10b7 this row read "level: default" — the raw payload dump from
  // `scalars()`, which is what a missing describeEvent branch degrades to.
  await expect(row).not.toContainText("level: default");
});
