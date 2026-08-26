// R3.5 / Task L — DRIVE both deciders BY HAND, and make the ledger agree.
//
// Every other test in this wave proves the code behaves. This proves the
// PRODUCT works, which is a different claim and the one this wave exists to
// answer: R2 and R3 BOTH signed off with a broken decider underneath them.
// A cricket super over could not be scored on the pad at all, and nothing —
// unit, e2e, gallery or smoke — noticed, because nothing ever tapped it.
//
// The rule, and the reason this file is separate from the two skin specs:
//   setup may use the API to REACH a decider, but every event that IS the
//   decider is TAPPED through the pad, and after every tap the ledger must
//   agree with what was tapped.
//
// The existing coverage each of these replaces:
//   - football: `scorepad-v3-football.spec.ts` DOES tap kick tiles, but stops
//     after two kicks. It never drives one to a DECIDED result, so nothing
//     proves the taps can actually finish a match.
//   - cricket: `scorepad-v3-cricket.spec.ts` drives its super over entirely
//     through `postEvent`. Not one super-over delivery in the suite has ever
//     been tapped, which is precisely how the original defect survived.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  fixturePath,
  seedRosteredFixture,
  setDivisionConfigSql,
  TAG,
  type RosteredFixture,
} from "./helpers";

// Each test seeds its own fixture — no shared state, so no reason to serialise.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}
function tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}
function sheet(page: Page) {
  return pad(page).locator('[data-role="v3-sheet"]');
}

type LedgerEvent = { id: string; seq: number; type: string; payload: Record<string, unknown> };

async function ledger(request: APIRequestContext, fixtureId: string): Promise<LedgerEvent[]> {
  const res = await apiJson<LedgerEvent[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

async function fixtureState(request: APIRequestContext, fixtureId: string) {
  const res = await apiJson<{
    last_seq: number;
    status: string;
    outcome: { kind?: string; winner?: string; method?: string } | null;
    state: Record<string, unknown>;
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(res.status, `state read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data!;
}

async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await fixtureState(request, fixtureId);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** The v3 pad soft-commits: a tap sits in the dock for HOLD_MS (6s) before it
 *  reaches the ledger (spec §2.3). Every hand-driven tap here flushes through
 *  the dock's own "Send now" rather than sleeping — waiting out the hold would
 *  add a minute per test and would still be a race. */
async function sendHeldNow(page: Page): Promise<void> {
  await pad(page).locator('[data-role="v3-dock"]').getByRole("button", { name: "Send now", exact: true }).click();
}

/** Tap a tile, pick an option in the sheet it opens, flush the hold, and
 *  return the ONE event that reached the ledger. Fails loudly if a tap
 *  produced no event or more than one — a tap that silently no-ops is exactly
 *  the defect class this file is here to catch. */
async function tapThroughSheet(
  page: Page,
  fx: RosteredFixture,
  tileId: string,
  optionId: string,
): Promise<LedgerEvent> {
  const before = await ledger(page.request, fx.fixtureId);
  await tile(page, tileId).click();
  await expect(sheet(page), `tapping ${tileId} opened no sheet`).toBeVisible({ timeout: 10_000 });
  await sheet(page).locator(`[data-choice-option-id="${optionId}"]`).click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before.length + 1);
  const after = await ledger(page.request, fx.fixtureId);
  return after[after.length - 1]!;
}

/** Tap a plain (non-sheet) tile and return the single event it produced. */
async function tapTile(page: Page, fx: RosteredFixture, tileId: string): Promise<LedgerEvent> {
  const before = await ledger(page.request, fx.fixtureId);
  await tile(page, tileId).click();
  await sendHeldNow(page);
  await expect
    .poll(async () => (await ledger(page.request, fx.fixtureId)).length, { timeout: 20_000 })
    .toBe(before.length + 1);
  const after = await ledger(page.request, fx.fixtureId);
  return after[after.length - 1]!;
}

/** Screenshot at the three widths the owner's standing UI bar names, and
 *  assert no horizontal page scroll at any of them. 320 is the one that
 *  actually catches things. */
async function shotAllWidths(
  page: Page,
  name: string,
  anchor?: (p: Page) => ReturnType<Page["locator"]>,
): Promise<void> {
  // A DECIDED fixture UNMOUNTS the pad (this wave's own F15/F16), so what to
  // wait on differs by state — defaulting to the pad would fail the decided
  // captures for a reason that is correct behaviour.
  const waitFor = anchor ?? pad;
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 900 : 1000 });
    await expect(waitFor(page).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `e2e-artifacts/taskl/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

test(
  "R3.5/Task L — a football shoot-out is TAPPED to a decided result, and every tap lands in the ledger",
  async ({ page }) => {
    // Up to a dozen held dispatches, each flushed rather than waited out.
    test.setTimeout(180_000);

    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Task L FB ${TAG}`,
      sportKey: "football",
      variantKey: "11-a-side",
      home: [{ fullName: `V3 TLFB Home ${TAG}`, positionKey: "FW" }],
      away: [{ fullName: `V3 TLFB Away ${TAG}`, positionKey: "GK" }],
    });

    // `extraTime` is a plain z.object whose two fields are BOTH required —
    // the default applies to the whole object, so `{ enabled: false }` alone
    // fails the cfg parse, and because the config is written by SQL nothing
    // validates it on the way in. The failure then surfaces as the console
    // rendering NO PAD AT ALL, which reads as a pad defect rather than a
    // config one. Spelled out in full for that reason.
    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, {
      ...div.data!.config,
      shootout: true,
      extraTime: { enabled: false, halfMinutes: 15 },
    });

    // SETUP ONLY — reach full time level 1-1. With extra time off,
    // `resolveFullTime` sends a level score straight to the kicks.
    await postEvent(page.request, fx.fixtureId, "core.start", {});
    await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
    await postEvent(page.request, fx.fixtureId, "football.goal", { by: fx.awayEntrantId });
    await postEvent(page.request, fx.fixtureId, "football.period", { phase: "HT" });
    await postEvent(page.request, fx.fixtureId, "football.period", { phase: "FT" });

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });
    await expect(pad(page).locator('[data-strip-tone="led"]').first()).toContainText("Shoot-out");
    await shotAllWidths(page, "football-shootout-open");

    // FROM HERE ON, EVERY EVENT IS A TAP.
    //
    // Home converts, away misses. Which tile is live is not assumed — it is
    // READ from the board each round, because the cue and the disabled state
    // ARE the behaviour under test (R3.5/Task F): tapping a tile the pad has
    // disabled would be a dead-end tap, and asserting against a side we chose
    // ourselves would hide a wrong cue entirely.
    const taps: { side: "home" | "away"; option: string }[] = [];
    for (let round = 0; round < 12; round += 1) {
      const state = await fixtureState(page.request, fx.fixtureId);
      if (state.outcome !== null) break;

      const homeDisabled = await tile(page, "kick-home").getAttribute("data-tile-disabled");
      const awayDisabled = await tile(page, "kick-away").getAttribute("data-tile-disabled");
      expect(
        [homeDisabled, awayDisabled],
        "both kick tiles disabled with the shoot-out still live — the board is a dead end",
      ).not.toEqual(["true", "true"]);
      const side: "home" | "away" = homeDisabled === "true" ? "away" : "home";
      const option = side === "home" ? "scored" : "missed";

      const event = await tapThroughSheet(page, fx, `kick-${side}`, option);
      taps.push({ side, option });

      // THE LEDGER AGREES WITH THE TAP — type, side and outcome, per tap.
      expect(event.type, `tap ${round + 1} wrote the wrong event type`).toBe("football.shootout.kick");
      expect(event.payload.by, `tap ${round + 1} was attributed to the wrong side`).toBe(
        side === "home" ? fx.homeEntrantId : fx.awayEntrantId,
      );
      // The payload is `{ by, scored: boolean }` — FootballShootoutKick is a
      // strictObject (football.ts:283-293) with no `outcome` field at all.
      expect(event.payload.scored, `tap ${round + 1} recorded the wrong outcome`).toBe(option === "scored");
    }

    // The shoot-out actually ENDED, by taps alone.
    const finalState = await fixtureState(page.request, fx.fixtureId);
    expect(finalState.outcome, "12 tapped kicks and the match never decided").not.toBeNull();
    expect(finalState.outcome!.method).toBe("shootout");
    expect(finalState.outcome!.winner).toBe(fx.homeEntrantId);
    expect(finalState.status).toBe("decided");

    // Every kick in the ledger came from a tap — no phantom events, and the
    // count matches what we actually pressed.
    const kicks = (await ledger(page.request, fx.fixtureId)).filter((e) => e.type === "football.shootout.kick");
    expect(kicks.length, "the ledger holds a different number of kicks than were tapped").toBe(taps.length);
    expect(kicks.map((k) => k.payload.scored)).toEqual(taps.map((t) => t.option === "scored"));

    // The pad is gone by design once the match is decided; anchor the capture
    // on the decided sentence Task G added instead.
    await page.reload();
    await shotAllWidths(page, "football-shootout-decided", (p) => p.getByText(/won .* on penalties/));
  },
);

test(
  "R3.5/Task L — a cricket super over is TAPPED, lands in state.superOver, and the tiles the fold refuses stay disabled",
  async ({ page }) => {
    test.setTimeout(180_000);

    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Task L CR ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [{ fullName: `V3 TLCR Home1 ${TAG}` }, { fullName: `V3 TLCR Home2 ${TAG}` }],
      away: [{ fullName: `V3 TLCR Away1 ${TAG}` }, { fullName: `V3 TLCR Away2 ${TAG}` }],
    });
    const home1 = fx.personIds[`V3 TLCR Home1 ${TAG}`]!;
    const home2 = fx.personIds[`V3 TLCR Home2 ${TAG}`]!;
    const away1 = fx.personIds[`V3 TLCR Away1 ${TAG}`]!;
    const away2 = fx.personIds[`V3 TLCR Away2 ${TAG}`]!;

    const div = await apiJson<{ config: Record<string, unknown> }>(
      page.request,
      `/api/v1/divisions/${fx.divisionId}`,
    );
    expect(div.status, `GET division -> ${div.status}`).toBe(200);
    await setDivisionConfigSql(fx.divisionId, { ...div.data!.config, superOver: true });

    // SETUP ONLY — tie the match 1-1 so `superOver: true` sends the fold to
    // phase "super_over". NOT ONE super-over delivery is posted here; that is
    // the whole point of this test.
    await postEvent(page.request, fx.fixtureId, "core.start", {});
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0, ballInOver: 1, striker: home1, nonStriker: home2, bowler: away1, runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });
    await postEvent(page.request, fx.fixtureId, "cricket.ball", {
      over: 0, ballInOver: 1, striker: away1, nonStriker: away2, bowler: home1, runs: { bat: 1 },
    });
    await postEvent(page.request, fx.fixtureId, "cricket.innings.close", { reason: "other" });

    const tied = await fixtureState(page.request, fx.fixtureId);
    expect(tied.status, "a tie WITH a super over stays live, not decided").toBe("in_play");
    expect((tied.state as { phase?: string }).phase).toBe("super_over");

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    // The defect this wave opened with: the pad printed "This innings is
    // closed." over a live decider and disabled every delivery tile, because
    // `currentInnings` read the two CLOSED main innings.
    await expect(pad(page).getByText("This innings is closed.")).toHaveCount(0);
    for (const tileId of ["run0", "run1", "wicket"]) {
      await expect(tile(page, tileId), `${tileId} is disabled in a LIVE super over`).toHaveAttribute(
        "data-tile-disabled",
        "false",
      );
    }

    // R3.5/Task R, the mirror image and the reason that fix needed its own
    // task: `requireOpenInnings` (cricket.ts:1746) and the innings-close
    // handler (:3134) BOTH require phase === "live", so these three 422 in a
    // super over. Repointing `currentInnings` at the super over made them
    // look enabled. A real browser is the only place this is visible.
    for (const tileId of ["review", "retire", "inningsClose"]) {
      const t = tile(page, tileId);
      if ((await t.count()) === 0) continue; // absent is also "not a dead end"
      await expect(t, `${tileId} is tappable in a super over, and the fold refuses it`).toHaveAttribute(
        "data-tile-disabled",
        "true",
      );
    }
    await shotAllWidths(page, "cricket-superover-open");

    // FROM HERE ON, EVERY EVENT IS A TAP. Away batted second in the match, so
    // per ICC — and per the engine's own `soBattingSideAt` — away bats FIRST
    // in the super over.
    const beforeSo = (tied.state as { superOver?: { innings?: unknown[] } | null }).superOver;
    expect(beforeSo?.innings ?? [], "the super over already has deliveries before any tap").toHaveLength(0);

    const first = await tapTile(page, fx, "run1");
    expect(first.type, "a tap in a super over must write the SUPER OVER's event type").toBe(
      "cricket.superover.ball",
    );

    const second = await tapTile(page, fx, "run0");
    expect(second.type).toBe("cricket.superover.ball");

    // The taps landed in `state.superOver.innings`, NOT in the main innings —
    // the distinction the pad got wrong, and the one a runs-only assertion
    // cannot see.
    const after = await fixtureState(page.request, fx.fixtureId);
    const so = (after.state as { superOver?: { innings?: { runs?: number }[] } | null }).superOver;
    expect(so, "the taps did not reach state.superOver at all").not.toBeNull();
    expect(so!.innings!.length, "the super over holds no innings after two tapped deliveries").toBeGreaterThan(0);
    expect(so!.innings![0]!.runs, "the tapped run did not reach the super over's own score").toBe(1);
    expect(
      (after.state as { innings?: unknown[] }).innings ?? [],
      "a tapped super-over delivery leaked into the MAIN innings",
    ).toHaveLength(2);

    // The scorebug follows the super over, not the frozen main innings.
    await expect(pad(page).locator('[data-role="v3-scorebug"]').first()).toBeVisible();
    await shotAllWidths(page, "cricket-superover-scored");
  },
);
